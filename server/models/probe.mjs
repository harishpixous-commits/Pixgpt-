import { log } from '../config.mjs'
import { getGateway, hasOutcomeReporter } from '../gateway/index.mjs'
import { isContentFree } from '../gateway/openai-compatible.mjs'
import { recordSuccess, recordFailure, classifyFailure, FAILURE } from './health.mjs'
import { noteSuccess, noteFailure, storeProbe, storeBenchmark, applyCapabilities, getModel } from './registry.mjs'
import { EVIDENCE } from './catalog.mjs'

/* ============================================================
   Model probing
   -------------
   Sections 3, 4, 25 and 40. Turns CATALOGUED into LIVE_VERIFIED
   by spending the smallest real request that can prove something.

   Three constraints shape every probe here:

     · It must cost almost nothing. 121 models × a paragraph each
       is a bill for no information. Probes ask for ≤16 tokens.
     · It must prove one specific thing. "Did it answer" and "can it
       call a tool" are separate questions with separate answers.
     · A 200 is not a pass. `felo/felo-chat` returns HTTP 200 with a
       body of "." — the same guard the chat path uses applies here,
       and a content-free reply is a probe failure (section 23).
   ============================================================ */

const LIMITS = {
  maxTokens: Number.parseInt(process.env.PIXGPT_PROBE_MAX_TOKENS ?? '', 10) || 16,
  timeoutMs: Number.parseInt(process.env.PIXGPT_PROBE_TIMEOUT_MS ?? '', 10) || 30_000,
  /** Ceiling on how many models one probe run may touch. */
  maxModels: Number.parseInt(process.env.PIXGPT_PROBE_MAX_MODELS ?? '', 10) || 24,
  /** How many probes run at once. Small: this is someone's rate limit. */
  concurrency: Number.parseInt(process.env.PIXGPT_PROBE_CONCURRENCY ?? '', 10) || 3,
}

/* ---------- probe definitions (section 25) ---------- */

/**
 * A 1×1 transparent PNG. The smallest thing that is still a real image, so a
 * vision probe proves the route accepts image parts without sending a payload.
 */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/*
 * With routing installed the gateway client already reports every attempt to
 * the health tracker, so recording here as well counts one probe as two — it
 * showed up immediately as `2/0` after a single run. These wrappers record only
 * when nothing else is (an offline test, or the CLI before installModelRouting).
 */
const trackSuccess = (id, meta) => {
  if (!hasOutcomeReporter()) recordSuccess(id, meta)
}
const trackFailure = (id, error) => {
  if (!hasOutcomeReporter()) recordFailure(id, error)
}

export const PROBES = {
  /** Does anything come back, and is it content? */
  chat: {
    label: 'chat',
    maxTokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    verify: (reply) => ({
      ok: !isContentFree(reply.content),
      capability: 'chat',
      detail: reply.content?.slice(0, 40),
    }),
  },

  /**
   * Tool calling. Asks for a tool the model cannot answer without — a text
   * reply here means the route dropped the tools array, which is exactly the
   * failure mode that breaks Build mode silently.
   */
  tools: {
    label: 'tool calling',
    maxTokens: 64,
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name' } },
            required: ['city'],
          },
        },
      },
    ],
    verify: (reply) => ({
      ok: Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0,
      capability: 'tools',
      detail: reply.toolCalls?.[0]?.function?.name ?? 'no tool call returned',
    }),
  },

  /** Vision. The only thing that may set `vision: true` (section 13). */
  vision: {
    label: 'vision',
    maxTokens: 16,
    requiresVision: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the single word: ok' },
          { type: 'image_url', image_url: { url: PIXEL } },
        ],
      },
    ],
    verify: (reply) => ({ ok: !isContentFree(reply.content), capability: 'vision', detail: reply.content?.slice(0, 40) }),
  },

  /** Structured output: does it return parseable JSON when asked plainly? */
  structured: {
    label: 'structured output',
    maxTokens: 48,
    messages: [
      {
        role: 'user',
        content: 'Reply with only this JSON and nothing else: {"ok":true,"n":7}',
      },
    ],
    verify: (reply) => {
      const text = String(reply.content ?? '')
      const match = /\{[\s\S]*\}/.exec(text)
      if (!match) return { ok: false, capability: 'structured', detail: 'no JSON in the reply' }
      try {
        const parsed = JSON.parse(match[0])
        return { ok: parsed?.ok === true && parsed?.n === 7, capability: 'structured', detail: match[0].slice(0, 40) }
      } catch {
        return { ok: false, capability: 'structured', detail: 'unparseable JSON' }
      }
    },
  },

  /**
   * A small reasoning task with one correct answer.
   *
   * Not a benchmark of intelligence — it is a check that the route reaches a
   * model at all rather than a canned responder, and it is cheap enough to run
   * across a candidate set.
   */
  reasoning: {
    label: 'reasoning',
    maxTokens: 24,
    benchmark: true,
    messages: [
      {
        role: 'user',
        content: 'A shelf holds 3 boxes. Each box holds 4 jars. Two jars are removed. How many jars remain? Reply with only the number.',
      },
    ],
    verify: (reply) => ({ ok: /\b10\b/.test(String(reply.content ?? '')), capability: null, detail: String(reply.content ?? '').slice(0, 24) }),
  },

  /** A tiny coding task with a checkable answer. */
  coding: {
    label: 'coding',
    maxTokens: 96,
    benchmark: true,
    messages: [
      {
        role: 'user',
        content: 'Write a JavaScript one-liner that returns the sum of an array `a`. Reply with only the code.',
      },
    ],
    verify: (reply) => {
      const text = String(reply.content ?? '')
      return {
        ok: /reduce|for\s*\(|forEach/.test(text) && /a\b/.test(text),
        capability: null,
        detail: text.replace(/```\w*|```/g, '').trim().slice(0, 48),
      }
    },
  },
}

export const PROBE_IDS = Object.keys(PROBES)

/* ---------- running one probe ---------- */

/**
 * Runs one probe against one model.
 *
 * Every outcome updates health and the registry, so probing and ordinary
 * traffic teach the same state — there is no separate "probe world".
 */
export async function probeModel(modelId, probeId = 'chat', { signal, timeoutMs } = {}) {
  const probe = PROBES[probeId]
  if (!probe) throw new Error(`unknown probe: ${probeId}`)

  const { client, adapter } = getGateway()
  const started = Date.now()

  if (probe.tools && !adapter.capabilities.tools) {
    return { model: modelId, probe: probeId, ok: false, skipped: true, reason: 'gateway does not support tools', ms: 0 }
  }
  if (probe.requiresVision && !adapter.capabilities.vision) {
    return { model: modelId, probe: probeId, ok: false, skipped: true, reason: 'gateway does not support vision', ms: 0 }
  }

  try {
    const reply = await client.completion(
      {
        model: modelId,
        messages: probe.messages,
        temperature: 0,
        maxTokens: Math.min(probe.maxTokens ?? LIMITS.maxTokens, LIMITS.maxTokens * 8),
        tools: probe.tools,
        requiresVision: Boolean(probe.requiresVision),
        timeoutMs: timeoutMs ?? LIMITS.timeoutMs,
        /*
         * A probe must reach the model it names. Falling back would record the
         * fallback's success against the probed model — the registry would
         * learn a fact about the wrong route.
         */
        noFallback: true,
      },
      signal,
    )

    const ms = Date.now() - started
    const verdict = probe.verify(reply)

    if (verdict.ok) {
      trackSuccess(modelId, { latencyMs: ms })
      noteSuccess(modelId, { latencyMs: ms, via: `probe:${probeId}` })
      if (verdict.capability) applyCapabilities(modelId, { [verdict.capability]: true }, EVIDENCE.PROBE)
      log.info('probe passed', { model: modelId, probe: probeId, ms })
    } else {
      /*
       * A probe that runs and produces the wrong answer is not a route failure.
       * The route worked — it answered — so health is credited, and only the
       * capability is marked absent.
       */
      trackSuccess(modelId, { latencyMs: ms })
      noteSuccess(modelId, { latencyMs: ms, via: `probe:${probeId}` })
      if (verdict.capability) applyCapabilities(modelId, { [verdict.capability]: false }, EVIDENCE.PROBE)
      log.info('probe answered but did not satisfy the check', { model: modelId, probe: probeId, ms })
    }

    const result = {
      model: modelId,
      probe: probeId,
      ok: verdict.ok,
      ms,
      detail: verdict.detail,
      reportedModel: reply.model ?? null,
      at: new Date().toISOString(),
    }
    if (probe.benchmark) storeBenchmark(modelId, probeId, { ok: verdict.ok, ms, at: result.at })
    else storeProbe(modelId, result)
    return result
  } catch (error) {
    const ms = Date.now() - started
    const kind = classifyFailure(error)
    trackFailure(modelId, error)
    noteFailure(modelId, kind)

    /*
     * A capability probe failing on a capability error is information, not a
     * fault: it proves the model cannot do that thing.
     */
    if (kind === FAILURE.UNSUPPORTED_CAPABILITY && probe.requiresVision) {
      applyCapabilities(modelId, { vision: false }, EVIDENCE.PROBE)
    }

    const result = { model: modelId, probe: probeId, ok: false, ms, reason: kind, at: new Date().toISOString() }
    if (!probe.benchmark) storeProbe(modelId, result)
    log.info('probe failed', { model: modelId, probe: probeId, reason: kind, ms })
    return result
  }
}

/* ---------- running many ---------- */

/** Small worker pool. Sequential would take minutes; unbounded would rate-limit. */
async function pool(items, worker, concurrency) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Probes a candidate set.
 *
 * `models` is capped at LIMITS.maxModels and the cap is *reported*, not applied
 * silently — a truncated run that looks complete is how "we probed everything"
 * becomes untrue.
 */
export async function probeModels(models, { probes = ['chat'], signal, concurrency, onResult, limit } = {}) {
  /*
   * `limit` lets a deliberate full-catalogue run exceed the default cap. The
   * cap exists to stop an accidental 400-request probe, not to stop a
   * diagnostic someone asked for explicitly.
   */
  const capped = models.slice(0, limit ?? LIMITS.maxModels)
  const dropped = models.length - capped.length

  const jobs = []
  for (const model of capped) for (const probe of probes) jobs.push({ model, probe })

  const results = await pool(
    jobs,
    async ({ model, probe }) => {
      const result = await probeModel(model, probe, { signal })
      onResult?.(result)
      return result
    },
    concurrency ?? LIMITS.concurrency,
  )

  return {
    results,
    probed: capped.length,
    requested: models.length,
    dropped,
    ...(dropped > 0 ? { note: `${dropped} model(s) were not probed: the per-run cap is ${LIMITS.maxModels}.` } : {}),
  }
}

/**
 * The default candidate set: the models actually worth spending a probe on.
 *
 * Section 40 forbids probing all 121 at startup, so this picks the routes that
 * decide real requests — the configured aliases, the routing aliases, and the
 * top of each task ranking — rather than a sample of the catalogue.
 */
export function probeCandidates({ perTask = 2, includeFree = true } = {}) {
  // Imported lazily to keep ranking's dependency on the registry one-directional
  const { TASK_IDS, rank } = requireRanking()
  const chosen = new Map()

  const { config } = getGateway()
  for (const id of Object.values(config.modelAliases ?? {})) if (id) chosen.set(id, 'configured alias')
  for (const id of config.visionFallbackModels ?? []) chosen.set(id, 'vision fallback')
  for (const id of config.fallbackModels ?? []) chosen.set(id, 'configured fallback')

  for (const task of TASK_IDS) {
    if (!includeFree && task === 'BEST_FREE') continue
    for (const entry of rank(task).slice(0, perTask)) {
      if (!chosen.has(entry.id)) chosen.set(entry.id, `top ${perTask} for ${task}`)
    }
  }

  return [...chosen.entries()].map(([id, why]) => ({ id, why }))
}

let rankingModule = null
function requireRanking() {
  // Set by index.mjs at load; avoids a circular import at module-evaluation time
  if (!rankingModule) throw new Error('ranking module not wired — import server/models/index.mjs first')
  return rankingModule
}

export function wireRanking(module) {
  rankingModule = module
}

/**
 * Which probes make sense for a model.
 *
 * Running the vision probe against every route would burn the quota of 121
 * models to learn something only a handful could possibly be true of.
 */
export function probesFor(modelId) {
  const model = getModel(modelId)
  const probes = ['chat']
  if (!model) return probes
  if (model.capabilities.vision?.value !== false && (model.capabilities.vision?.hinted || model.categories.includes('VISION'))) {
    probes.push('vision')
  }
  if (model.capabilities.tools?.value !== false) probes.push('tools')
  return probes
}

export { LIMITS as PROBE_LIMITS }
