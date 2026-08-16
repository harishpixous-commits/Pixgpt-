/* ============================================================
   Lightweight in-memory rate limiter for /api/chat
   ------------------------------------------------
   A fixed window per client, held in a Map. No database and no new
   dependency — PixGPT has neither, and adding one just for this
   would be the wrong trade.

   SCOPE: this is per-process. It protects a single server against a
   runaway client or a stuck retry loop. It is NOT a distributed
   limiter: run more than one instance and each gets its own budget.
   For production behind a load balancer, put the limit in the
   reverse proxy or move this to Redis. See docs/production.md.
   ============================================================ */

const WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10) || 60_000
/** 0 disables the limiter entirely. */
const MAX = Number.isFinite(Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10))
  ? Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10)
  : 60

const hits = new Map() // key -> { count, resetAt }
const MAX_TRACKED_KEYS = 10_000

export const rateLimitConfig = { windowMs: WINDOW_MS, max: MAX, enabled: MAX > 0 }

/**
 * Trusts `x-forwarded-for` only for its left-most entry, and only as a bucket
 * key — it is never used for authorisation, so a spoofed value can at worst
 * give the spoofer their own bucket.
 */
export function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0].trim()
    if (first) return first
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

/**
 * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number }}
 */
export function check(key, now = Date.now()) {
  if (!rateLimitConfig.enabled) return { allowed: true, remaining: Infinity, retryAfterSec: 0 }

  let entry = hits.get(key)
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS }
    hits.set(key, entry)
  }

  entry.count += 1

  // Opportunistic cleanup so the Map cannot grow without bound
  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [k, v] of hits) {
      if (now >= v.resetAt) hits.delete(k)
      if (hits.size <= MAX_TRACKED_KEYS) break
    }
  }

  const remaining = Math.max(0, MAX - entry.count)
  return {
    allowed: entry.count <= MAX,
    remaining,
    retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  }
}

/** Test seam. */
export function reset() {
  hits.clear()
}
