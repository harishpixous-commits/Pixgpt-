/* ============================================================
   Search vocabulary
   -----------------
   One normalised result shape and one set of type/recency names, so
   every provider adapter converts into the same thing and nothing
   downstream has to know which backend answered.
   ============================================================ */

/** What is being searched for. A provider only advertises what it really does. */
export const SEARCH_TYPE = Object.freeze({
  WEB: 'web',
  NEWS: 'news',
  CODE: 'code',
  GITHUB: 'github',
  DOCUMENTATION: 'documentation',
  REFERENCE: 'reference',
  IMAGES: 'images',
  VIDEOS: 'videos',
})

export const SEARCH_TYPES = Object.values(SEARCH_TYPE)

/** How fresh a result has to be. */
export const RECENCY = Object.freeze({
  ANY: 'any',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
})

/** How much effort a search is worth. */
export const SEARCH_MODE = Object.freeze({
  FAST: 'fast',
  BALANCED: 'balanced',
  DEEP: 'deep',
  FREE_ONLY: 'free_only',
})

export const SEARCH_MODES = Object.values(SEARCH_MODE)

/** How a provider is paid for — drives free-first routing. */
export const COST = Object.freeze({
  /** Self-hosted or otherwise unmetered. */
  SELF_HOSTED: 'self_hosted',
  /** Public endpoint with no key and no billing. */
  FREE: 'free',
  /** A metered allowance that recurs; spending it costs the user something. */
  FREE_CREDIT: 'free_credit',
  /** Billed per request. */
  PAID: 'paid',
})

/** Ordering used by free-first routing: lower is preferred. */
export const COST_RANK = Object.freeze({
  [COST.SELF_HOSTED]: 0,
  [COST.FREE]: 1,
  [COST.FREE_CREDIT]: 2,
  [COST.PAID]: 3,
})

/**
 * @typedef {{
 *   title: string,
 *   url: string,
 *   snippet: string,
 *   domain: string,
 *   provider: string,
 *   publishedAt: string | null,
 *   retrievedAt: string,
 *   score: number,
 *   type: string,
 *   raw?: object
 * }} SearchResult
 */

/** The domain of a URL, without `www.`, lowercased. Empty string if unparseable. */
export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Normalises a date from any of the shapes providers return.
 * @returns {string | null} ISO 8601, or null when there is no usable date
 */
export function normaliseDate(value) {
  if (!value) return null

  // Relative ages, as Brave and Serper report them ("3 days ago", "2 hours ago")
  const relative = /^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago$/i.exec(String(value).trim())
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const ms = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_629_800_000,
      year: 31_557_600_000,
    }[unit]
    return new Date(Date.now() - amount * ms).toISOString()
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  // Anything absurd is a parse artefact, not a date
  const year = parsed.getUTCFullYear()
  if (year < 1990 || year > 2100) return null
  return parsed.toISOString()
}

/** Builds a normalised result, filling in what the adapter did not supply. */
export function makeResult({
  title,
  url,
  snippet = '',
  provider,
  publishedAt = null,
  score = 0,
  type = SEARCH_TYPE.WEB,
  raw,
}) {
  return {
    title: String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || domainOf(url),
    url: String(url ?? ''),
    snippet: String(snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 800),
    domain: domainOf(url),
    provider,
    publishedAt: normaliseDate(publishedAt),
    retrievedAt: new Date().toISOString(),
    score: Number.isFinite(score) ? score : 0,
    type,
    ...(raw ? { raw } : {}),
  }
}

/**
 * A stable key for deduplicating results across providers.
 *
 * Tracking parameters and trailing slashes make the same page look like several
 * different ones, so they are stripped before comparing.
 */
export function dedupeKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.protocol = 'https:'
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    for (const param of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|fbclid|gclid|mc_cid|mc_eid|igshid|si$)/i.test(param)) {
        u.searchParams.delete(param)
      }
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'
    return u.toString()
  } catch {
    return String(url)
  }
}
