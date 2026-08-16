import { log } from '../config.mjs'

/* ============================================================
   Per-route health and circuit breaking
   -------------------------------------
   Sections 20–24. One record per model id, holding rolling
   statistics rather than lifetime counters.

   The rolling window is what stops a single lucky call from
   pinning a model at the top of the rankings forever (section 24),
   and what lets a route that was broken an hour ago come back
   without special handling.

   A route is never deleted. It goes healthy → degraded → cooldown,
   is probed again when the cooldown lapses, and rejoins ranking on
   success (section 21).
   ============================================================ */

export const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  RATE_LIMITED: 'rate_limited',
  UNREACHABLE: 'unreachable',
  INVALID: 'invalid',
  COOLDOWN: 'cooldown',
  UNKNOWN: 'unknown',
})

/* ---------- failure classification (section 22) ---------- */

export const FAILURE = Object.freeze({
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  SERVER_ERROR: 'server_error',
  INVALID_KEY: 'invalid_key',
  INVALID_MODEL: 'invalid_model',
  UNSUPPORTED_CAPABILITY: 'unsupported_capability',
  EMPTY_RESPONSE: 'empty_response',
  MALFORMED_RESPONSE: 'malformed_response',
  CONTENT_FREE: 'content_free',
  PROVIDER_BLOCKED: 'provider_blocked',
  QUOTA: 'quota',
  UNKNOWN: 'unknown',
})

/**
 * How each failure is treated. Getting this table right is the whole point of
 * section 22 — these failures mean genuinely different things:
 *
 *   `cooldownMs`  how long the route sits out
 *   `fatal`       true when retrying cannot possibly help, so the route is
 *                 excluded from ranking rather than merely cooled
 *   `capability`  a capability this failure disproves, if any
 */
const POLICY = {
  [FAILURE.NETWORK]: { cooldownMs: 60_000, health: HEALTH.UNREACHABLE },
  [FAILURE.TIMEOUT]: { cooldownMs: 45_000, health: HEALTH.DEGRADED },
  [FAILURE.RATE_LIMITED]: { cooldownMs: 120_000, health: HEALTH.RATE_LIMITED },
  [FAILURE.SERVER_ERROR]: { cooldownMs: 90_000, health: HEALTH.DEGRADED },
  // A bad key is a configuration problem: cooling the route down hides it and
  // fixes nothing, so it is marked invalid and reported loudly instead.
  [FAILURE.INVALID_KEY]: { cooldownMs: 300_000, health: HEALTH.INVALID, fatal: true },
  [FAILURE.INVALID_MODEL]: { cooldownMs: 3_600_000, health: HEALTH.INVALID, fatal: true },
  [FAILURE.UNSUPPORTED_CAPABILITY]: { cooldownMs: 0, health: HEALTH.HEALTHY },
  [FAILURE.EMPTY_RESPONSE]: { cooldownMs: 90_000, health: HEALTH.DEGRADED },
  [FAILURE.MALFORMED_RESPONSE]: { cooldownMs: 90_000, health: HEALTH.DEGRADED },
  /*
   * A 200 carrying "." is a provider quality problem, not an outage. It is
   * retryable — the chain should move on immediately — but the route is cooled
   * for a good while, because a route that answers with nothing is worse than
   * one that errors: it looks like an answer.
   */
  [FAILURE.CONTENT_FREE]: { cooldownMs: 600_000, health: HEALTH.DEGRADED },
  [FAILURE.PROVIDER_BLOCKED]: { cooldownMs: 900_000, health: HEALTH.UNREACHABLE },
  [FAILURE.QUOTA]: { cooldownMs: 1_800_000, health: HEALTH.INVALID, fatal: true },
  [FAILURE.UNKNOWN]: { cooldownMs: 60_000, health: HEALTH.DEGRADED },
}

/**
 * Gateway error → failure kind.
 *
 * Reads the stable `code` first and only falls back to text matching, so this
 * stays correct as upstream wording changes.
 */
export function classifyFailure(error) {
  const code = String(error?.code ?? '').toLowerCase()
  const text = `${error?.message ?? ''} ${error?.detail ?? ''}`.toLowerCase()

  switch (code) {
    case 'rate_limited':
      return FAILURE.RATE_LIMITED
    case 'quota_exceeded':
      return FAILURE.QUOTA
    case 'invalid_api_key':
      return FAILURE.INVALID_KEY
    case 'model_unavailable':
      return FAILURE.INVALID_MODEL
    case 'timeout':
      return FAILURE.TIMEOUT
    case 'gateway_unavailable':
      return FAILURE.NETWORK
    case 'provider_unavailable':
      /*
       * Falls through to the text rules rather than returning here. A 502 is
       * already classified as `provider_unavailable` by the transport, so
       * returning SERVER_ERROR on the code alone meant the missing-binary check
       * below could never run — `aug/*` kept being retried every 90s against a
       * gateway whose Auggie CLI is not installed.
       */
      break
    case 'malformed_response':
      // The content-free guard raises malformed_response with this wording;
      // it is a different problem from an unparseable body and is scored so.
      return /no usable content/.test(text) ? FAILURE.CONTENT_FREE : FAILURE.MALFORMED_RESPONSE
    case 'bad_request':
      return /vision|image|modality|multimodal/.test(text) ? FAILURE.UNSUPPORTED_CAPABILITY : FAILURE.MALFORMED_RESPONSE
    default:
      break
  }

  /*
   * An anti-abuse challenge. Observed live from `ddgw/*`, which answers 418
   * with "anti-abuse challenge failed … DuckDuckGo is rejecting this anonymous
   * session". None of the numeric rules below match 418, so this landed in
   * UNKNOWN and got a 60s cooldown — far too short for a session-level block
   * that will keep failing until the upstream lets the IP back in.
   */
  if (/challenge|anti-?abuse|captcha|\b418\b/.test(text)) return FAILURE.PROVIDER_BLOCKED
  if (/\b429\b|rate limit/.test(text)) return FAILURE.RATE_LIMITED
  if (/\b40[13]\b|forbidden|unauthorized/.test(text)) return FAILURE.INVALID_KEY
  if (/blocked by|egress|region|geo-?block/.test(text)) return FAILURE.PROVIDER_BLOCKED
  if (/\b5\d\d\b/.test(text)) {
    /*
     * A 5xx whose body names a missing executable is the gateway's own
     * deployment being incomplete, not the model being busy. Observed live:
     * `aug/*` returns 502 "Auggie CLI exited with code 1: 'auggie' is not
     * recognized as an internal or external command". Retrying cannot install a
     * binary, so the route is excluded rather than retried every 90 seconds.
     *
     * Kept inside the 5xx branch deliberately: these words appear in ordinary
     * tool output too, and outside a server error they mean nothing about the
     * route's health.
     */
    return /is not recognized|command not found|no such file|enoent/.test(text)
      ? FAILURE.INVALID_MODEL
      : FAILURE.SERVER_ERROR
  }
  if (/timeout|timed out/.test(text)) return FAILURE.TIMEOUT
  // A provider_unavailable that said nothing recognisable is still a 5xx
  return code === 'provider_unavailable' ? FAILURE.SERVER_ERROR : FAILURE.UNKNOWN
}

/**
 * Failures that will not clear on their own.
 *
 * A missing binary, a rejected credential, an exhausted quota or a model the
 * gateway does not have. A rate limit or a timeout is deliberately absent —
 * those routes may well work in a minute.
 *
 * Exported because four places need this judgement — ranking, persistence,
 * timeout budgeting and the picker — and they had drifted into three different
 * lists, with `provider_blocked` missing from one of them.
 */
export const TERMINAL_FAILURES = Object.freeze(['invalid_key', 'invalid_model', 'quota', 'provider_blocked'])

export const isTerminalFailure = (kind) => TERMINAL_FAILURES.includes(kind)

/* ---------- rolling statistics (section 24) ---------- */

/** Outcomes kept per route. Enough to see a trend, small enough to stay cheap. */
const WINDOW = 20

function emptyRecord() {
  return {
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccess: null,
    lastFailure: null,
    lastFailureKind: null,
    cooldownUntil: 0,
    /** Rolling window of `true`/`false`, newest last. */
    window: [],
    /** Rolling latencies in ms for successful calls, newest last. */
    latencies: [],
    fatal: false,
    health: HEALTH.UNKNOWN,
  }
}

/** @type {Map<string, ReturnType<typeof emptyRecord>>} */
const ROUTES = new Map()

function record(id) {
  let r = ROUTES.get(id)
  if (!r) {
    r = emptyRecord()
    ROUTES.set(id, r)
  }
  return r
}

function push(list, value, limit = WINDOW) {
  list.push(value)
  if (list.length > limit) list.shift()
}

export function recordSuccess(id, { latencyMs } = {}) {
  const r = record(id)
  r.successCount++
  r.consecutiveFailures = 0
  r.consecutiveSuccesses++
  r.lastSuccess = new Date().toISOString()
  r.cooldownUntil = 0
  r.fatal = false
  r.health = HEALTH.HEALTHY
  push(r.window, true)
  if (Number.isFinite(latencyMs)) push(r.latencies, latencyMs)
  return r
}

export function recordFailure(id, error) {
  const kind = typeof error === 'string' ? error : classifyFailure(error)
  const policy = POLICY[kind] ?? POLICY[FAILURE.UNKNOWN]
  const r = record(id)

  /*
   * A capability failure is not a health failure. `unsupported_capability`
   * means "this route cannot see images" — the route is fine for text, and
   * penalising its health would remove a working chat model from ranking
   * because someone once sent it a picture.
   */
  if (kind === FAILURE.UNSUPPORTED_CAPABILITY) {
    r.lastFailureKind = kind
    return { kind, cooldownMs: 0, capabilityOnly: true }
  }

  r.failureCount++
  r.consecutiveFailures++
  r.consecutiveSuccesses = 0
  r.lastFailure = new Date().toISOString()
  r.lastFailureKind = kind
  push(r.window, false)

  /*
   * The breaker only opens after two consecutive failures. One failure on a
   * live gateway is usually noise, and opening on it would take a working
   * route out of rotation for a minute at a time all day.
   */
  const shouldOpen = policy.fatal || r.consecutiveFailures >= 2
  if (shouldOpen && policy.cooldownMs > 0) {
    // Consecutive failures lengthen the cooldown, capped so a route always
    // gets retried eventually — nothing is removed permanently (section 21).
    const backoff = Math.min(r.consecutiveFailures, 4)
    r.cooldownUntil = Date.now() + policy.cooldownMs * backoff
    r.health = HEALTH.COOLDOWN
  } else {
    r.health = policy.health
  }
  if (policy.fatal) r.fatal = true

  log.debug('model route failure', { model: id, kind, consecutive: r.consecutiveFailures, health: r.health })
  return { kind, cooldownMs: Math.max(0, r.cooldownUntil - Date.now()), fatal: Boolean(policy.fatal) }
}

/* ---------- reading state ---------- */

export function healthOf(id) {
  const r = ROUTES.get(id)
  if (!r) {
    return {
      state: HEALTH.UNKNOWN,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      successRate: null,
      latencyMs: null,
      errorRate: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureKind: null,
      cooldownMs: 0,
      available: true,
      fatal: false,
    }
  }

  const cooldownMs = Math.max(0, r.cooldownUntil - Date.now())
  /*
   * A lapsed cooldown reports `degraded`, not `healthy`: the timer expiring is
   * permission to try again, not proof the route recovered. Only a real success
   * restores `healthy`.
   */
  const state = cooldownMs > 0 ? HEALTH.COOLDOWN : r.health === HEALTH.COOLDOWN ? HEALTH.DEGRADED : r.health

  const attempts = r.window.length
  const wins = r.window.filter(Boolean).length
  const successRate = attempts > 0 ? wins / attempts : null

  return {
    state,
    successCount: r.successCount,
    failureCount: r.failureCount,
    consecutiveFailures: r.consecutiveFailures,
    successRate,
    errorRate: successRate === null ? null : 1 - successRate,
    latencyMs: r.latencies.length > 0 ? Math.round(r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length) : null,
    lastSuccess: r.lastSuccess,
    lastFailure: r.lastFailure,
    lastFailureKind: r.lastFailureKind,
    cooldownMs,
    /** Whether the route may be attempted right now. */
    available: cooldownMs === 0 && !r.fatal,
    fatal: r.fatal,
  }
}

/** Every route with recorded history. Routes never tried are simply absent. */
export function allHealth() {
  const out = {}
  for (const id of ROUTES.keys()) out[id] = healthOf(id)
  return out
}

export function isAvailable(id) {
  return healthOf(id).available
}

/* ---------- adaptive timeouts ---------- */

/**
 * How long to wait for a route before giving up on it.
 *
 * A fixed 15-second connect timeout is wrong in both directions at once. A
 * route measured at 200ms holds a failing request for fifteen seconds before
 * the chain moves on; a genuinely slow route that answers in nine gets killed
 * if you simply lower the number. Measured here: a dead `veo-free/veo` cost a
 * full 15s while a healthy `auto/best-coding` answered in 8s — no single
 * constant serves both.
 *
 * So the budget is derived from what the route has actually done:
 *
 *   allowed = max(slowest recent success × SLACK, FLOOR)   capped at `ceiling`
 *
 * `SLACK` is generous on purpose. This is a circuit-breaker for hung routes,
 * not a latency SLA — cutting off a route that was about to answer costs a
 * whole extra attempt and is far worse than waiting another second.
 *
 * A route with no history gets the full ceiling: nothing is known, so nothing
 * is assumed.
 *
 * @param {string} id
 * @param {number} ceiling  the configured connect timeout
 * @returns {number} milliseconds
 */
export function timeoutFor(id, ceiling) {
  const r = ROUTES.get(id)
  if (!r || r.latencies.length === 0) return ceiling

  /*
   * Slack scales with confidence. One measurement — which is all a restored
   * route has, since the snapshot stores a single average — is real evidence
   * but thin, so it earns a wider margin than a settled average does.
   *
   * Requiring three samples instead made the whole mechanism dormant after
   * every restart: the registry restores one latency, the threshold rejected
   * it, and every route sat on the full ceiling until three fresh successes
   * accumulated. The common case is a freshly started server.
   */
  const slack = r.latencies.length >= SETTLED_SAMPLES ? LATENCY_SLACK : LATENCY_SLACK_UNSETTLED
  const slowest = Math.max(...r.latencies)
  const allowed = Math.max(slowest * slack, ADAPTIVE_FLOOR_MS)
  return Math.min(Math.round(allowed), ceiling)
}

/** Samples after which a route's latency is treated as settled. */
const SETTLED_SAMPLES = 3
/** Multiplier over the slowest recent success, once settled. */
const LATENCY_SLACK = 3
/** Wider margin while the measurement is still thin. */
const LATENCY_SLACK_UNSETTLED = 6
/** Never go below this, however fast a route has been. */
const ADAPTIVE_FLOOR_MS = 5_000

/** Test seam, and the way an operator clears a stuck breaker. */
export function resetHealth(id) {
  if (id) ROUTES.delete(id)
  else ROUTES.clear()
}

export { POLICY as FAILURE_POLICY, WINDOW as HEALTH_WINDOW }
