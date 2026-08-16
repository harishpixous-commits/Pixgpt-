import { log } from './config.mjs'
import { getGateway } from './gateway/index.mjs'
import { GatewayError } from './gateway/errors.mjs'

/* ============================================================
   Vision routing
   --------------
   Sending an image to a model that cannot see it is the failure this
   module exists to prevent. It has happened here twice, in two
   different ways:

     1. a text-only model sat first in the vision fallback list and
        answered every image request with bad_request
     2. every configured vision route was rate limited at once, and the
        failure was reported as "no visual defects found"

   The second is the dangerous one. A vision check that could not run
   is not a passing vision check, and this module never reports one as
   the other. When nothing can see, callers get an explicit
   `available: false` with the reason.

   Candidates are tried in order, each failure marks that route
   unhealthy for a cooldown, and a route that returns a hard capability
   error is remembered for much longer — a model that cannot accept an
   image will not learn to.
   ============================================================ */

const PROBE_TIMEOUT_MS = Number.parseInt(process.env.VISION_PROBE_TIMEOUT_MS ?? '', 10) || 45_000
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.VISION_TIMEOUT_MS ?? '', 10) || 120_000

/** Cooldowns by failure kind. A capability failure is effectively permanent. */
const COOLDOWN_MS = {
  no_vision_capability: 6 * 3_600_000,
  auth: 900_000,
  rate_limited: 180_000,
  unavailable: 120_000,
  /** An ambiguous image rejection: short, because it may well be transient. */
  rejected_image: 300_000,
  timeout: 60_000,
  unknown: 60_000,
}

/** @type {Map<string, { failures: number, openUntil: number, lastReason: string|null, lastOkAt: string|null, checks: number, successes: number }>} */
const ROUTES = new Map()

function routeRecord(model) {
  let record = ROUTES.get(model)
  if (!record) {
    record = { failures: 0, rejections: 0, openUntil: 0, lastReason: null, lastOkAt: null, checks: 0, successes: 0 }
    ROUTES.set(model, record)
  }
  return record
}

/**
 * Works out what a failure means for this route.
 *
 * The distinction that matters: "you are going too fast" is temporary, and
 * "I cannot look at pictures" is not.
 */
export function classifyVisionFailure(error) {
  const code = String(error?.code ?? '').toLowerCase()
  const message = String(error?.message ?? '').toLowerCase()
  const detail = String(error?.detail ?? '').toLowerCase()
  const all = `${code} ${message} ${detail}`

  // A provider saying the model has no vision support, however it phrases it
  if (
    /no target .* has confirmed vision support|does not support image|vision (is )?not supported|unsupported (content|modality|image)|image_url is not supported|only supports text/.test(all)
  ) {
    return 'no_vision_capability'
  }
  if (code === 'rate_limited' || /\b429\b|rate limit/.test(all)) return 'rate_limited'
  if (code === 'auth_failed' || /\b401\b|\b403\b|unauthorized|forbidden|invalid api key/.test(all)) return 'auth'
  if (code === 'model_unavailable' || /\b50[0-9]\b|unavailable|blocked by vercel|egress/.test(all)) return 'unavailable'
  if (code === 'timeout' || /timeout|timed out/.test(all)) return 'timeout'

  /*
   * A bare `bad_request` is ambiguous. It is often a model refusing an image,
   * but the gateway sanitises upstream messages, so the same code also covers
   * transient provider faults. Treating it as a permanent capability failure
   * cooled a genuinely vision-capable route for six hours after one bad minute,
   * so it is only ambiguous here and escalates on repetition.
   */
  if (code === 'bad_request') return 'rejected_image'
  return 'unknown'
}

/** How many consecutive ambiguous rejections before a route is presumed blind. */
const REJECTION_ESCALATION = 3

function markFailure(model, error) {
  let kind = classifyVisionFailure(error)
  const record = routeRecord(model)
  record.checks++
  record.failures++

  /*
   * Escalate a repeated ambiguous rejection into a capability failure. One
   * rejection could be anything; three in a row from the same route is a model
   * that will not take an image, and there is no point asking a fourth time.
   */
  if (kind === 'rejected_image') {
    record.rejections = (record.rejections ?? 0) + 1
    if (record.rejections >= REJECTION_ESCALATION) kind = 'no_vision_capability'
  } else {
    record.rejections = 0
  }

  record.lastReason = kind
  record.openUntil = Date.now() + (COOLDOWN_MS[kind] ?? COOLDOWN_MS.unknown)

  log.warn('vision route unhealthy', {
    model,
    kind,
    rejections: record.rejections ?? 0,
    cooldownSec: Math.round((COOLDOWN_MS[kind] ?? COOLDOWN_MS.unknown) / 1000),
  })
  return kind
}

function markSuccess(model) {
  const record = routeRecord(model)
  record.checks++
  record.successes++
  record.failures = 0
  record.rejections = 0
  record.openUntil = 0
  record.lastReason = null
  record.lastOkAt = new Date().toISOString()
}

const isRouteOpen = (model) => (ROUTES.get(model)?.openUntil ?? 0) > Date.now()

/**
 * The candidate routes, best first.
 *
 * The gateway's own alias comes first because it is what the operator
 * configured; the explicit vision fallbacks follow. Nothing here is assumed to
 * work — a route is only trusted after it has actually returned an answer.
 */
export function visionCandidates() {
  const { config } = getGateway()
  const alias = config.modelAliases?.['pixgpt-vision']
  const fallbacks = config.visionFallbackModels ?? []

  const seen = new Set()
  const candidates = []

  for (const model of [alias, ...fallbacks].filter(Boolean)) {
    if (seen.has(model)) continue
    seen.add(model)
    const record = ROUTES.get(model)
    candidates.push({
      model,
      healthy: !isRouteOpen(model),
      lastReason: record?.lastReason ?? null,
      cooldownMs: record ? Math.max(0, record.openUntil - Date.now()) : 0,
      checks: record?.checks ?? 0,
      successes: record?.successes ?? 0,
      lastOkAt: record?.lastOkAt ?? null,
    })
  }
  return candidates
}

/**
 * Sends an image request to the first route that can actually serve it.
 *
 * @param {{ messages: object[], temperature?: number, timeoutMs?: number,
 *           signal?: AbortSignal, maxTokens?: number }} request
 * @returns {Promise<{ available: true, content: string, model: string, attempts: object[] }
 *                  | { available: false, reason: string, detail: string, attempts: object[] }>}
 */
export async function visionCompletion(request) {
  const { client } = getGateway()
  const candidates = visionCandidates()

  if (candidates.length === 0) {
    return {
      available: false,
      reason: 'not_configured',
      detail: 'No vision-capable model is configured. Set PIXGPT_MODEL_VISION, and <GATEWAY>_VISION_FALLBACK_MODELS for fallbacks.',
      attempts: [],
    }
  }

  const attempts = []
  // Healthy routes first, but a fully cooled-down set is still worth trying:
  // refusing to try at all would make one bad minute last for the whole session.
  const ordered = [...candidates].sort((a, b) => Number(b.healthy) - Number(a.healthy))

  for (const candidate of ordered) {
    const started = Date.now()
    try {
      const reply = await client.completion(
        {
          model: candidate.model,
          // Keeps the gateway from substituting a text-only route underneath us
          requiresVision: true,
          temperature: request.temperature ?? 0,
          maxTokens: request.maxTokens,
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          messages: request.messages,
        },
        request.signal,
      )

      const content = String(reply.content ?? '').trim()
      if (!content) {
        markFailure(candidate.model, { code: 'malformed_response', message: 'empty content' })
        attempts.push({ model: candidate.model, ok: false, reason: 'empty_response', ms: Date.now() - started })
        continue
      }

      markSuccess(candidate.model)
      attempts.push({ model: candidate.model, ok: true, ms: Date.now() - started })
      log.info('vision route succeeded', { model: reply.model ?? candidate.model, attempt: attempts.length })

      return { available: true, content, model: reply.model ?? candidate.model, attempts }
    } catch (error) {
      const kind = markFailure(candidate.model, error)
      attempts.push({ model: candidate.model, ok: false, reason: kind, ms: Date.now() - started })
      // A cancelled request is the caller's decision, not a route problem
      if (error?.code === 'client_closed') {
        return { available: false, reason: 'cancelled', detail: 'The request was cancelled.', attempts }
      }
    }
  }

  const reasons = [...new Set(attempts.map((a) => a.reason).filter(Boolean))]
  log.warn('no vision route available', { tried: attempts.length, reasons: reasons.join(',') })

  return {
    available: false,
    reason: reasons.includes('no_vision_capability') && reasons.length === 1 ? 'no_vision_capability' : 'all_routes_failed',
    detail: `Tried ${attempts.length} vision route(s); all failed (${reasons.join(', ')}).`,
    attempts,
  }
}

/**
 * Whether vision is usable right now, for status reporting.
 *
 * `probe: true` spends a real request on a 1x1 image to find out for certain.
 * Without it this reports what the routes have been doing, which is enough for
 * a status badge and costs nothing.
 */
export async function visionStatus({ probe = false, signal } = {}) {
  const candidates = visionCandidates()
  const configured = candidates.length > 0
  const healthy = candidates.filter((c) => c.healthy)

  const base = {
    configured,
    routes: candidates.map((c) => ({
      model: c.model,
      healthy: c.healthy,
      lastReason: c.lastReason,
      cooldownMs: c.cooldownMs,
      checks: c.checks,
      successes: c.successes,
      lastOkAt: c.lastOkAt,
    })),
    healthyCount: healthy.length,
  }

  if (!configured) {
    return { ...base, available: false, reason: 'not_configured', verified: false }
  }
  if (!probe) {
    /*
     * Unverified. A route that has never been tried is reported as "unknown"
     * rather than "available" — claiming vision works before it has ever
     * answered is the mistake this module exists to avoid.
     */
    const anySuccess = candidates.some((c) => c.successes > 0)
    return {
      ...base,
      available: healthy.length > 0,
      verified: anySuccess,
      reason: healthy.length > 0 ? (anySuccess ? null : 'never_verified') : 'all_routes_cooling_down',
    }
  }

  // A 1x1 transparent PNG: the smallest thing that is still a real image
  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  const outcome = await visionCompletion({
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
    maxTokens: 16,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the single word: ok' },
          { type: 'image_url', image_url: { url: pixel } },
        ],
      },
    ],
  })

  return {
    ...base,
    // Re-read the routes: the probe just updated their health
    routes: visionCandidates().map((c) => ({
      model: c.model,
      healthy: c.healthy,
      lastReason: c.lastReason,
      cooldownMs: c.cooldownMs,
      checks: c.checks,
      successes: c.successes,
      lastOkAt: c.lastOkAt,
    })),
    available: outcome.available,
    verified: outcome.available,
    reason: outcome.available ? null : outcome.reason,
    detail: outcome.available ? undefined : outcome.detail,
    probedModel: outcome.available ? outcome.model : null,
    attempts: outcome.attempts,
  }
}

/** Test seam, and a way for an admin to clear a stuck cooldown. */
export function resetVisionRoutes(model) {
  if (model) ROUTES.delete(model)
  else ROUTES.clear()
}

export { COOLDOWN_MS, DEFAULT_TIMEOUT_MS }
