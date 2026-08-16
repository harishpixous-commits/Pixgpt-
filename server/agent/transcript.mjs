/* ============================================================
   Transcript compaction
   ---------------------
   A long build overflows the context window. What you throw away
   when that happens decides whether the agent still knows what it
   has already done.

   The old approach here was to keep the system prompt and the last
   forty messages. That is cheap and it loses the wrong thing: the
   record that `npm test` was run at iteration 3 and failed, which
   is precisely what stops the agent running it again at iteration
   30 and being equally surprised.

   So compaction happens in stages, each discarding less useful
   material than the last:

     1. simplify old tool *results* in place — keep what was run and
        whether it worked, drop the output nobody will re-read
     2. simplify the recent ones too
     3. drop the oldest exchanges entirely
     4. hard cap

   Simplifying always comes before dropping. Losing an old command's
   output costs detail; losing the message costs the knowledge that
   the command was ever run.

   Stage 1 is the one that matters. A terminal result compacted to
   `{command, exitCode, ok, outputOmitted: true}` costs about thirty
   tokens instead of two thousand and still answers "has this been
   tried, and did it work".
   ============================================================ */

/** Four characters per token — rough, and consistent, which is what budgeting needs. */
const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4)

const messageTokens = (message) =>
  estimateTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')) +
  estimateTokens(JSON.stringify(message.tool_calls ?? ''))

export function transcriptTokens(messages) {
  return messages.reduce((n, m) => n + messageTokens(m), 0)
}

/* ---------- stage 1: simplify old tool results ---------- */

/**
 * Fields worth keeping from a tool result once it is no longer recent.
 *
 * The rule behind the list: keep anything that answers "what happened", drop
 * anything that is only useful while acting on it. A file's contents are
 * re-readable; the fact that reading it succeeded is not recoverable once gone.
 */
const KEEP = [
  'ok',
  'error',
  'command',
  'exitCode',
  'path',
  'file',
  'files',
  'name',
  'url',
  'status',
  'count',
  'reason',
  'summary',
  'applied',
  'definedIn',
  'symbol',
]

/**
 * Compacts one tool result, preserving its verdict.
 *
 * Returns the original string when it is already small — churning a short
 * result costs more than it saves and makes the transcript harder to read
 * when debugging.
 */
export function simplifyToolResult(raw, { keepChars = 220 } = {}) {
  const text = String(raw ?? '')
  if (text.length <= keepChars) return text

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON: keep the head, which is where an error message lives
    return `${text.slice(0, keepChars)}… [${text.length - keepChars} chars omitted]`
  }

  if (parsed === null || typeof parsed !== 'object') return text

  const kept = {}
  for (const key of KEEP) {
    if (parsed[key] === undefined) continue
    const value = parsed[key]
    // A kept field can itself be huge — a `files` array, an `error` blob
    kept[key] =
      typeof value === 'string' && value.length > 160
        ? `${value.slice(0, 160)}…`
        : Array.isArray(value)
          ? value.slice(0, 8)
          : value
  }
  kept.outputOmitted = true

  const compacted = JSON.stringify(kept)
  // If simplification did not actually help, keep the original truncation
  return compacted.length < text.length ? compacted : `${text.slice(0, keepChars)}… [truncated]`
}

/* ---------- the ladder ---------- */

/**
 * Brings a transcript within budget, losing as little meaning as possible.
 *
 * @param {object[]} messages    OpenAI-shape messages; index 0 is the system prompt
 * @param {object} [options]
 * @param {number} [options.tokenBudget]  target size
 * @param {number} [options.keepRecent]   exchanges left untouched at the tail
 * @returns {{ messages: object[], level: string, before: number, after: number, simplified: number, dropped: number }}
 */
export function compactTranscript(messages, { tokenBudget = 60_000, keepRecent = 12 } = {}) {
  const before = transcriptTokens(messages)
  if (before <= tokenBudget) {
    return { messages, level: 'none', before, after: before, simplified: 0, dropped: 0 }
  }

  /* --- stage 1 --- */

  const system = messages[0]
  const rest = messages.slice(1)
  const cutoff = Math.max(0, rest.length - keepRecent)

  let simplified = 0
  const staged = rest.map((message, index) => {
    if (index >= cutoff) return message
    if (message.role !== 'tool') return message
    const next = simplifyToolResult(message.content)
    if (next !== message.content) simplified++
    return { ...message, content: next }
  })

  let working = [system, ...staged]
  let after = transcriptTokens(working)
  if (after <= tokenBudget) {
    return { messages: working, level: 'simplified-results', before, after, simplified, dropped: 0 }
  }

  /* --- stage 2 --- */

  /*
   * Simplify the recent results too, before dropping anything.
   *
   * Stage 1 leaves the newest exchanges untouched, so a handful of large recent
   * results can exceed the budget on their own. Simplifying them costs recent
   * detail; dropping messages costs the record that a step happened at all.
   * The first is always the smaller loss, so it is always tried first.
   */
  working = working.map((message, index) => {
    if (index === 0 || message.role !== 'tool') return message
    const next = simplifyToolResult(message.content)
    if (next !== message.content) simplified++
    return { ...message, content: next }
  })
  after = transcriptTokens(working)

  if (after <= tokenBudget) {
    return { messages: working, level: 'simplified-all', before, after, simplified, dropped: 0 }
  }

  /* --- stage 3 --- */

  /*
   * Drop from the front, never from the end, and never the system prompt.
   *
   * A tool result is dropped with the assistant message that requested it:
   * an orphaned `tool` message whose `tool_call_id` has no matching call is
   * rejected outright by the API, which would turn a context problem into a
   * failed request.
   */
  let dropped = 0
  while (after > tokenBudget && working.length > keepRecent + 2) {
    const candidate = working[1]
    working = [working[0], ...working.slice(2)]
    dropped++
    if (candidate?.role === 'assistant' && candidate.tool_calls?.length) {
      const ids = new Set(candidate.tool_calls.map((c) => c.id))
      const filtered = working.filter((m) => !(m.role === 'tool' && ids.has(m.tool_call_id)))
      dropped += working.length - filtered.length
      working = filtered
    }
    after = transcriptTokens(working)
  }

  if (after <= tokenBudget) {
    return { messages: working, level: 'dropped-oldest', before, after, simplified, dropped }
  }

  /* --- stage 4 --- */

  return { messages: working, level: 'at-floor', before, after, simplified, dropped }
}

/**
 * Removes any `tool` message with no matching tool call.
 *
 * A safety net for stage 2 and for any future editing of the transcript: the
 * provider rejects the whole request over one orphan, and the resulting error
 * says nothing about which message caused it.
 */
export function dropOrphanToolMessages(messages) {
  const known = new Set()
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) known.add(call.id)
    }
  }
  return messages.filter((m) => m.role !== 'tool' || !m.tool_call_id || known.has(m.tool_call_id))
}
