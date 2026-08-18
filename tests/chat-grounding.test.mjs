import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ============================================================
   Capability grounding, end to end.

   The system turn is composed inside `handleChat`, so asserting on
   `buildChatSystemPrompt` alone would not catch the wiring being wrong — which
   is exactly what shipped before: no system turn reached the model at all, and
   a vision model asked to edit an image answered with a lead-in for a picture
   PixGPT never requested. These tests boot the real server against a stub
   gateway and inspect what the model was actually sent.
   ============================================================ */

// `import.meta.dirname` is Node 20.11+, and this repo's test runner is Node 18.
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

let stub
let stubPort
let child
let appPort
/** Bodies the stub gateway received, newest last. */
let seen = []

const freePort = async () => {
  const s = createServer()
  s.listen(0)
  await once(s, 'listening')
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

before(async () => {
  stubPort = await freePort()
  appPort = await freePort()

  stub = createServer(async (req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'auto' }, { id: 'auto/fast' }] }))
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      seen.push(JSON.parse(body))
    } catch {
      seen.push({ unparsed: body })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'auto/fast',
        choices: [{ message: { role: 'assistant', content: 'stub reply' }, finish_reason: 'stop' }],
      }),
    )
  })
  stub.listen(stubPort)
  await once(stub, 'listening')

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      OMNIROUTE_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OMNIROUTE_API_KEY: 'test-key',
      OMNIROUTE_FALLBACK_MODELS: '',
      LOG_LEVEL: 'error',
      // Keep the run hermetic: no snapshot restore, no outbound search
      PIXGPT_MODEL_STORE: path.join(ROOT, 'tests', '.tmp-grounding-store.json'),
      WEB_SEARCH_PROVIDER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.resume()

  // Poll until the server answers, rather than sleeping a guessed interval
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${appPort}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start')
    await new Promise((r) => setTimeout(r, 250))
  }
})

after(async () => {
  child?.kill()
  await new Promise((r) => stub.close(r))
})

const chat = async (body) => {
  seen = []
  const r = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...body }),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

describe('capability grounding reaches the model', () => {
  test('a plain chat turn is sent with a system turn describing the product', async () => {
    const { status } = await chat({ model: 'auto/fast', messages: [{ role: 'user', content: 'hello' }] })
    assert.equal(status, 200)
    assert.ok(seen.length > 0, 'the gateway should have been called')

    const sent = seen.at(-1)
    assert.equal(sent.messages[0].role, 'system', 'first turn should be the capability prompt')
    assert.match(sent.messages[0].content, /You are PixGPT/)
    assert.equal(sent.messages[1].role, 'user')
    assert.equal(sent.messages[1].content, 'hello')
  })

  test('the prompt forbids claiming an image was produced', async () => {
    await chat({ model: 'auto/fast', messages: [{ role: 'user', content: 'make this into a new logo' }] })
    const system = seen.at(-1).messages[0].content
    // The exact defect reported: a lead-in for an image that never arrives
    assert.match(system, /Never say or imply that you have produced/i)
    assert.match(system, /cannot generate, edit, redraw or restyle images/i)
  })

  test('a caller-supplied system turn is respected, not duplicated', async () => {
    await chat({
      model: 'auto/fast',
      messages: [
        { role: 'system', content: 'You are a terse assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })
    const sent = seen.at(-1)
    const systems = sent.messages.filter((m) => m.role === 'system')
    assert.equal(systems.length, 1, 'should not stack a second system turn')
    assert.equal(systems[0].content, 'You are a terse assistant.')
  })

  test('grounding survives a multi turn transcript', async () => {
    await chat({
      model: 'auto/fast',
      messages: [
        { role: 'user', content: 'about this image ?' },
        { role: 'assistant', content: 'It is a logo.' },
        { role: 'user', content: 'make this image into harish gpt' },
      ],
    })
    const sent = seen.at(-1)
    assert.equal(sent.messages[0].role, 'system')
    assert.equal(sent.messages.length, 4, 'system turn plus the three transcript turns')
    assert.equal(sent.messages.at(-1).content, 'make this image into harish gpt')
  })
})
