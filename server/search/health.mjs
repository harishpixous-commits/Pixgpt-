import { log } from '../config.mjs'

/* ============================================================
   Provider health and circuit breaking
   ------------------------------------
   A search provider that is rate limited, misconfigured or down should
   be skipped, not retried into the ground. Every provider carries a
   record of how it has been behaving, and a breaker that opens after
   repeated failures and closes again after a cooldown.

   Failures are classified, because they mean different things:

     rate_limited  → back off for the interval the provider asked for
     auth          → the key is wrong; a long cooldown, since retrying
                     the same bad key cannot succeed
     server        → upstream trouble; short cooldown, likely transient
     timeout       → short cooldown
     empty         → not a failure; the provider worked and found nothing
   ============================================================ */

const FAILURE_THRESHOLD = Number.parseInt(process.env.SEARCH_BREAKER_THRESHOLD ?? '', 10) || 3

/** How long a breaker stays open, by failure class. */
const COOLDOWN_MS = {
  rate_limited: 60_000,
  auth: 900_000,
  server: 30_000,
  timeout: 20_000,
  blocked: 120_000,
  unknown: 30_000,
}

/** @type {Map<string, object>} providerId → record */
const RECORDS = new Map()

function record(providerId) {
  let r = RECORDS.get(providerId)
  if (!r) {
    r = {
      providerId,
      requests: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      rateLimitHits: 0,
      emptyResults: 0,
      totalLatencyMs: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      openUntil: 0,
    }
    RECORDS.set(providerId, r)
  }
  return r
}

/** Classifies a failure so the cooldown fits the cause. */
export function classifyFailure(reason, status) {
  const text = String(reason ?? '').toLowerCase()
  if (status === 429 || text.includes('429') || text.includes('rate')) return 'rate_limited'
  if (status === 401 || status === 403 || text.includes('401') || text.includes('403') || text.includes('auth')) return 'auth'
  if (typeof status === 'number' && status >= 500) return 'server'
  if (text.startsWith('http_5')) return 'server'
  if (text.includes('timeout')) return 'timeout'
  if (text.startsWith('blocked_') || text.startsWith('private_') || text.includes('resolves_to_private')) return 'blocked'
  return 'unknown'
}

export function noteSuccess(providerId, { latencyMs = 0, results = 0 } = {}) {
  const r = record(providerId)
  r.requests++
  r.successes++
  r.consecutiveFailures = 0
  r.openUntil = 0
  r.totalLatencyMs += latencyMs
  r.lastSuccessAt = new Date().toISOString()
  if (results === 0) r.emptyResults++
  return r
}

/**
 * Records a failure and opens the breaker once the threshold is reached.
 *
 * An auth failure opens immediately: a wrong key will not become right on the
 * next attempt, and hammering it can get the account throttled.
 */
export function noteFailure(providerId, reason, status) {
  const r = record(providerId)
  const kind = classifyFailure(reason, status)

  r.requests++
  r.failures++
  r.consecutiveFailures++
  r.lastFailureAt = new Date().toISOString()
  r.lastFailureReason = kind
  if (kind === 'rate_limited') r.rateLimitHits++

  const immediate = kind === 'auth' || kind === 'rate_limited'
  if (immediate || r.consecutiveFailures >= FAILURE_THRESHOLD) {
    const cooldown = COOLDOWN_MS[kind] ?? COOLDOWN_MS.unknown
    r.openUntil = Date.now() + cooldown
    log.warn('search provider circuit opened', {
      provider: providerId,
      reason: kind,
      consecutiveFailures: r.consecutiveFailures,
      cooldownSec: Math.round(cooldown / 1000),
    })
  }
  return r
}

/**
 * Honours a provider's own `Retry-After`, which is more accurate than a guess.
 * @param {string|number} value seconds, or an HTTP date
 */
export function noteRetryAfter(providerId, value) {
  const r = record(providerId)
  const seconds = Number(value)
  let waitMs

  if (Number.isFinite(seconds) && seconds > 0) {
    waitMs = seconds * 1000
  } else {
    const when = new Date(String(value)).getTime()
    waitMs = Number.isFinite(when) ? when - Date.now() : 0
  }
  // Cap it: a provider asking for an hour should not disable itself all session
  if (waitMs > 0) r.openUntil = Date.now() + Math.min(waitMs, 600_000)
  return r
}

/** True when the breaker is open and the provider must be skipped. */
export function isOpen(providerId) {
  const r = RECORDS.get(providerId)
  return Boolean(r && r.openUntil > Date.now())
}

export function cooldownRemainingMs(providerId) {
  const r = RECORDS.get(providerId)
  if (!r || r.openUntil <= Date.now()) return 0
  return r.openUntil - Date.now()
}

/**
 * A provider's health, for routing and for the admin panel.
 * @returns {{ state: 'healthy'|'degraded'|'unhealthy'|'unknown', … }}
 */
export function healthOf(providerId) {
  const r = RECORDS.get(providerId)
  if (!r || r.requests === 0) {
    /*
     * No requests yet does not mean no cooldown: a Retry-After can arrive
     * before any request of ours completes. Reporting zero here would show a
     * rate-limited provider as ready and send the next search straight back
     * into the limit.
     */
    const cooldownMs = r && r.openUntil > Date.now() ? r.openUntil - Date.now() : 0
    return {
      state: cooldownMs > 0 ? 'unhealthy' : 'unknown',
      requests: 0,
      successRate: null,
      averageLatencyMs: null,
      consecutiveFailures: r?.consecutiveFailures ?? 0,
      rateLimitHits: r?.rateLimitHits ?? 0,
      emptyResults: r?.emptyResults ?? 0,
      lastSuccessAt: null,
      lastFailureAt: r?.lastFailureAt ?? null,
      lastFailureReason: r?.lastFailureReason ?? null,
      cooldownMs,
    }
  }

  const successRate = r.successes / r.requests
  const open = r.openUntil > Date.now()
  const state = open || r.consecutiveFailures >= FAILURE_THRESHOLD
    ? 'unhealthy'
    : r.consecutiveFailures > 0 || successRate < 0.6
      ? 'degraded'
      : 'healthy'

  return {
    state,
    requests: r.requests,
    successRate: Math.round(successRate * 100) / 100,
    averageLatencyMs: r.successes > 0 ? Math.round(r.totalLatencyMs / r.successes) : null,
    consecutiveFailures: r.consecutiveFailures,
    rateLimitHits: r.rateLimitHits,
    emptyResults: r.emptyResults,
    lastSuccessAt: r.lastSuccessAt,
    lastFailureAt: r.lastFailureAt,
    lastFailureReason: r.lastFailureReason,
    cooldownMs: open ? r.openUntil - Date.now() : 0,
  }
}

export function allHealth() {
  return Object.fromEntries([...RECORDS.keys()].map((id) => [id, healthOf(id)]))
}

/** Test seam, and a way for an admin to clear a stuck breaker. */
export function resetHealth(providerId) {
  if (providerId) RECORDS.delete(providerId)
  else RECORDS.clear()
}

export { FAILURE_THRESHOLD, COOLDOWN_MS }
