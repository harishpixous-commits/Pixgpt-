import { visionCompletion } from '../vision-router.mjs'
import { log } from '../config.mjs'

/* ============================================================
   Visual analysis
   ---------------
   Sends a screenshot to a vision model and turns the reply into a
   machine-readable defect list, so the agent's fix loop can act on it
   instead of reading prose.

   Source code cannot tell you that a heading is clipped or that a card
   overflows its container. A picture can.
   ============================================================ */

const VISION_TIMEOUT_MS = Number.parseInt(process.env.AGENT_VISION_TIMEOUT_MS ?? '', 10) || 120_000

const SYSTEM = `You are a senior UI reviewer looking at a screenshot of a web page.

Report only defects that are VISIBLE in this image. Do not speculate about code.

Look for:
- Layout breakage: overlapping elements, content escaping its container, collapsed or stretched sections
- Clipped or truncated text, cut-off images, content hidden behind other content
- Horizontal overflow, unintended scrollbars, elements pushed off-screen
- Unreadable contrast: text that does not stand out from its background
- Spacing defects: elements touching, wildly inconsistent gaps, cramped padding
- Missing content: blank regions, unstyled fallback text, broken image placeholders, visible raw markup
- Obvious alignment problems

Do NOT report subjective taste ("could be prettier", "try another font"), and do NOT
invent problems. A clean page must come back with an empty issues list.

Reply with JSON only, no prose and no code fence:
{"verdict":"pass"|"fail","summary":"one sentence","issues":[{"severity":"high"|"medium"|"low","area":"where on the page","problem":"what is wrong","fix":"the concrete change that would fix it"}]}`

function extractJson(text) {
  if (!text) return null
  // Models sometimes wrap JSON in a fence despite being told not to
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Analyses one screenshot.
 *
 * @param {{ dataUrl: string, expectation?: string, viewport?: string, signal?: AbortSignal }} input
 * @returns {Promise<{ ok, verdict, summary, issues: string[], details: object[], raw?: string }>}
 */
export async function analyseScreenshot({ dataUrl, expectation = '', viewport = 'desktop', signal }) {
  if (!dataUrl?.startsWith('data:image/')) {
    return { ok: false, verdict: 'unknown', summary: 'No image to analyse.', issues: [], details: [] }
  }

  const context = [
    `Viewport: ${viewport}.`,
    expectation ? `The page is supposed to show: ${expectation}` : 'Judge it as a general-purpose web page.',
  ].join(' ')

  /*
   * Routed through the vision router rather than straight at the gateway, so a
   * rate-limited or text-only route falls through to the next vision-capable
   * one instead of failing the whole check.
   */
  const outcome = await visionCompletion({
    temperature: 0,
    timeoutMs: VISION_TIMEOUT_MS,
    signal,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: context },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  })

  if (!outcome.available) {
    log.warn('visual analysis unavailable', { reason: outcome.reason, tried: outcome.attempts.length })
    /*
     * A failed analysis is NOT a clean page. Reporting it as "no issues" would
     * tell the agent an unverified screen looks fine, which is the single worst
     * thing this function can do. The failure is returned explicitly so the
     * caller has to deal with it.
     */
    return {
      ok: false,
      failed: true,
      verdict: 'unknown',
      code: outcome.reason,
      summary: `Vision review is unavailable (${outcome.reason}). The page has NOT been visually reviewed by a model.`,
      detail: outcome.detail,
      attempts: outcome.attempts,
      issues: [],
      details: [],
    }
  }

  const reply = { content: outcome.content, model: outcome.model }
  const parsed = extractJson(reply.content)
  if (!parsed) {
    // Still useful to the agent as prose rather than throwing it away
    const text = (reply.content ?? '').trim()
    return {
      ok: true,
      verdict: /no (visual )?(issues|defects|problems)|looks (good|correct|fine)/i.test(text) ? 'pass' : 'unknown',
      summary: text.slice(0, 400) || 'The vision model returned nothing.',
      issues: [],
      details: [],
      raw: text.slice(0, 1500),
    }
  }

  const details = Array.isArray(parsed.issues) ? parsed.issues.filter((i) => i && typeof i === 'object') : []
  const issues = details.map((i) =>
    `[${i.severity ?? 'medium'}] ${i.area ? `${i.area}: ` : ''}${i.problem ?? ''}${i.fix ? ` → ${i.fix}` : ''}`.trim(),
  )

  return {
    ok: true,
    verdict: parsed.verdict === 'fail' || details.length > 0 ? 'fail' : 'pass',
    summary: String(parsed.summary ?? '').slice(0, 400),
    issues,
    details,
    model: reply.model,
  }
}
