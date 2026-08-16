import { createHash } from 'node:crypto'
import { log } from '../config.mjs'

/* ============================================================
   Search cache
   ------------
   Repeating the same search inside a session is wasteful, especially
   against a metered provider. But the whole reason PixGPT searches at
   all is to get *current* information, so caching a question about
   today's news would defeat the feature.

   So the TTL depends on what was asked:

     time-sensitive ("latest", "today", a live price)  →  60s
     news                                             →  5 min
     ordinary web                                     →  15 min
     reference / documentation                        →  6 hours

   A cached answer always reports how old it is, so a caller can decide
   the entry is too stale for its purpose.
   ============================================================ */

const MAX_ENTRIES = Number.parseInt(process.env.SEARCH_CACHE_MAX_ENTRIES ?? '', 10) || 300

/** TTL by search type, in milliseconds. */
const TTL = {
  timeSensitive: Number.parseInt(process.env.SEARCH_CACHE_TTL_LIVE_MS ?? '', 10) || 60_000,
  news: Number.parseInt(process.env.SEARCH_CACHE_TTL_NEWS_MS ?? '', 10) || 300_000,
  web: Number.parseInt(process.env.SEARCH_CACHE_TTL_WEB_MS ?? '', 10) || 900_000,
  reference: Number.parseInt(process.env.SEARCH_CACHE_TTL_REFERENCE_MS ?? '', 10) || 21_600_000,
}

/**
 * Words that mean "as of right now". A query containing any of these must not
 * be answered from a cache more than a minute old — this is the difference
 * between reporting the current version of a package and last week's.
 */
const TIME_SENSITIVE = [
  'latest', 'newest', 'current', 'currently', 'today', "today's", 'tonight',
  'now', 'right now', 'this week', 'this month', 'this year', 'recent',
  'recently', 'breaking', 'live', 'price', 'stock', 'score', 'weather',
  'status', 'outage', 'release', 'released', 'update', 'updated', 'just',
  'announced', 'new version', 'up to date', 'as of',
]

/** True when a query is asking about the present moment. */
export function isTimeSensitive(query) {
  const q = ` ${String(query ?? '').toLowerCase()} `
  if (TIME_SENSITIVE.some((word) => q.includes(` ${word} `) || q.includes(` ${word},`) || q.includes(` ${word}?`))) {
    return true
  }
  // A recent year in the query is a freshness signal
  const year = new Date().getUTCFullYear()
  return new RegExp(`\\b(${year}|${year + 1})\\b`).test(q)
}

/** How long a result for this query and type may be reused. */
export function ttlFor(query, type = 'web') {
  if (isTimeSensitive(query)) return TTL.timeSensitive
  if (type === 'news') return TTL.news
  if (type === 'reference' || type === 'documentation') return TTL.reference
  return TTL.web
}

/** @type {Map<string, { value: unknown, storedAt: number, ttl: number, hits: number }>} */
const ENTRIES = new Map()

let hits = 0
let misses = 0

function keyOf(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

/** Drops expired entries, then the least recently used, to stay within bounds. */
function evict() {
  const now = Date.now()
  for (const [key, entry] of ENTRIES) {
    if (now - entry.storedAt > entry.ttl) ENTRIES.delete(key)
  }
  while (ENTRIES.size >= MAX_ENTRIES) {
    // Map preserves insertion order, and `get` re-inserts, so the first key is LRU
    const oldest = ENTRIES.keys().next()
    if (oldest.done) break
    ENTRIES.delete(oldest.value)
  }
}

/**
 * Reads a cached value.
 * @returns {{ hit: true, value: unknown, ageMs: number } | { hit: false }}
 */
export function get(parts) {
  const key = keyOf(parts)
  const entry = ENTRIES.get(key)
  if (!entry) {
    misses++
    return { hit: false }
  }

  const age = Date.now() - entry.storedAt
  if (age > entry.ttl) {
    ENTRIES.delete(key)
    misses++
    return { hit: false }
  }

  // Re-insert to mark it recently used
  ENTRIES.delete(key)
  ENTRIES.set(key, { ...entry, hits: entry.hits + 1 })
  hits++
  return { hit: true, value: entry.value, ageMs: age }
}

export function set(parts, value, ttl) {
  evict()
  ENTRIES.set(keyOf(parts), { value, storedAt: Date.now(), ttl, hits: 0 })
}

/**
 * Wraps a lookup in the cache. Only successful, non-empty results are stored —
 * caching a failure would make one bad minute last for fifteen.
 */
export async function through(parts, { ttl, isWorthCaching = (v) => Boolean(v) }, produce) {
  const cached = get(parts)
  if (cached.hit) {
    log.debug('search cache hit', { ageMs: cached.ageMs })
    return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs }
  }

  const value = await produce()
  if (isWorthCaching(value)) set(parts, value, ttl)
  return { ...value, cached: false }
}

export function stats() {
  const total = hits + misses
  return {
    entries: ENTRIES.size,
    maxEntries: MAX_ENTRIES,
    hits,
    misses,
    hitRate: total > 0 ? Math.round((hits / total) * 100) / 100 : null,
    ttlMs: { ...TTL },
  }
}

export function clear() {
  ENTRIES.clear()
  hits = 0
  misses = 0
}

export { TTL, TIME_SENSITIVE, MAX_ENTRIES }
