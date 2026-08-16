import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactTranscript,
  simplifyToolResult,
  dropOrphanToolMessages,
  transcriptTokens,
} from '../server/agent/transcript.mjs'

/* ============================================================
   Transcript compaction
   --------------------
   What a long build forgets decides whether it repeats itself.
   These assert the property that matters: the *verdict* of an old
   tool call survives even when its output does not.
   ============================================================ */

const bigOutput = 'x'.repeat(9000)

function transcript(n) {
  const messages = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `call_${i}`, function: { name: 'run_command' } }] })
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: JSON.stringify({ ok: i % 3 !== 0, command: `npm test ${i}`, exitCode: i % 3 === 0 ? 1 : 0, stdout: bigOutput }),
    })
  }
  return messages
}

describe('simplifyToolResult', () => {
  test('keeps the verdict and drops the bulk', () => {
    const raw = JSON.stringify({ ok: false, command: 'npm test', exitCode: 1, stdout: bigOutput })
    const out = simplifyToolResult(raw)
    assert.ok(out.length < raw.length / 10, `only shrank to ${out.length}`)
    const parsed = JSON.parse(out)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.command, 'npm test')
    assert.equal(parsed.exitCode, 1)
    assert.equal(parsed.outputOmitted, true)
    assert.ok(!('stdout' in parsed))
  })

  test('a short result is left exactly as it was', () => {
    const raw = JSON.stringify({ ok: true })
    assert.equal(simplifyToolResult(raw), raw)
  })

  test('non-JSON keeps its head, where the error is', () => {
    const raw = 'Error: ENOENT no such file' + ' trailing'.repeat(200)
    const out = simplifyToolResult(raw)
    assert.ok(out.startsWith('Error: ENOENT'))
    assert.ok(out.length < raw.length)
  })

  test('an oversized kept field is itself bounded', () => {
    const out = simplifyToolResult(JSON.stringify({ ok: true, error: 'e'.repeat(5000), stdout: bigOutput }))
    assert.ok(out.length < 600, `error field was not bounded: ${out.length}`)
  })
})

describe('compactTranscript', () => {
  test('a small transcript is untouched', () => {
    const messages = [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }]
    const r = compactTranscript(messages, { tokenBudget: 10_000 })
    assert.equal(r.level, 'none')
    assert.equal(r.messages, messages)
  })

  test('simplifying old results is tried before dropping anything', () => {
    // Budget chosen to be reachable by simplification alone: the recent
    // exchanges are left at full size by stage 1, so it must clear them too.
    const r = compactTranscript(transcript(20), { tokenBudget: 30_000 })
    assert.equal(r.level, 'simplified-results')
    assert.ok(r.simplified > 0)
    assert.equal(r.dropped, 0, 'nothing should have been dropped yet')
    assert.ok(r.after < r.before)
  })

  /* The failure this exists to prevent: forgetting that a command already failed. */
  test('the verdict of an old failed command survives compaction', () => {
    const r = compactTranscript(transcript(20), { tokenBudget: 30_000 })
    const text = r.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ')
    assert.ok(text.includes('npm test 0'), 'the oldest command name was lost')
    assert.ok(text.includes('"exitCode":1'), 'the failure was lost')
    // The *old* result must have shed its output; recent ones legitimately keep theirs
    const oldest = r.messages.find((m) => m.role === 'tool')
    assert.ok(oldest.content.includes('outputOmitted'), 'the oldest output was not shed')
    assert.ok(oldest.content.length < 200, `oldest result still ${oldest.content.length} chars`)
  })

  test('the system prompt is never dropped', () => {
    const r = compactTranscript(transcript(120), { tokenBudget: 500 })
    assert.equal(r.messages[0].role, 'system')
    assert.equal(r.messages[0].content, 'system prompt')
  })

  test('recent output is kept in full while stage 1 is enough', () => {
    const r = compactTranscript(transcript(40), { tokenBudget: 60_000, keepRecent: 6 })
    assert.equal(r.level, 'simplified-results')
    const tail = r.messages.slice(-6).map((m) => m.content).join(' ')
    assert.ok(tail.includes('x'.repeat(100)), 'recent output should still be full')
  })

  test('recent messages survive as messages even when their output is shed', () => {
    const r = compactTranscript(transcript(40), { tokenBudget: 2000, keepRecent: 6 })
    const tail = r.messages.slice(-4)
    assert.ok(tail.some((m) => m.role === 'tool'), 'the newest exchanges must still be present')
    assert.equal(r.dropped, 0, 'simplifying should have sufficed')
  })

  test('dropping happens only when simplifying everything is not enough', () => {
    // 200 exchanges simplified to ~10 tokens each still exceed a 300 budget
    const r = compactTranscript(transcript(200), { tokenBudget: 300 })
    assert.ok(['dropped-oldest', 'at-floor'].includes(r.level), r.level)
    assert.ok(r.dropped > 0, 'expected messages to be dropped at this budget')
  })

  test('simplifying is always preferred over dropping', () => {
    const r = compactTranscript(transcript(20), { tokenBudget: 2000 })
    assert.equal(r.level, 'simplified-all')
    assert.equal(r.dropped, 0, 'nothing should be dropped while simplifying still fits')
  })

  /* Recent results are large enough on their own to exceed the budget. */
  test('a budget the recent messages alone exceed is still met', () => {
    const r = compactTranscript(transcript(20), { tokenBudget: 2000 })
    assert.ok(['simplified-all', 'dropped-oldest'].includes(r.level), r.level)
    assert.ok(r.after <= 2000, `still ${r.after} tokens after compaction`)
  })

  test('it always converges rather than looping', () => {
    for (const budget of [5000, 1000, 200, 20]) {
      const r = compactTranscript(transcript(60), { tokenBudget: budget })
      assert.ok(Array.isArray(r.messages) && r.messages.length > 0, `budget ${budget} emptied the transcript`)
    }
  })

  test('reported sizes are real', () => {
    const r = compactTranscript(transcript(30), { tokenBudget: 4000 })
    assert.equal(r.after, transcriptTokens(r.messages))
  })
})

describe('orphan tool messages', () => {
  /* An orphaned tool message makes the provider reject the entire request. */
  test('a tool message whose call was dropped is removed', () => {
    const messages = [
      { role: 'system', content: 's' },
      { role: 'tool', tool_call_id: 'gone', content: 'orphan' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'kept' }] },
      { role: 'tool', tool_call_id: 'kept', content: 'fine' },
    ]
    const out = dropOrphanToolMessages(messages)
    assert.equal(out.length, 3)
    assert.ok(!out.some((m) => m.content === 'orphan'))
    assert.ok(out.some((m) => m.content === 'fine'))
  })

  test('compaction never leaves an orphan behind', () => {
    const r = compactTranscript(transcript(100), { tokenBudget: 600 })
    const known = new Set()
    for (const m of r.messages) {
      if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) known.add(c.id)
    }
    for (const m of r.messages) {
      if (m.role === 'tool') assert.ok(known.has(m.tool_call_id), `orphan ${m.tool_call_id} survived`)
    }
  })
})
