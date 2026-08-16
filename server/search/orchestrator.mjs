import { log } from '../config.mjs'
import { SEARCH_MODE, SEARCH_TYPE, RECENCY, dedupeKey } from './types.mjs'
import { selectProviders, searchAvailableFor } from './registry.mjs'
import { noteFailure, noteRetryAfter, noteSuccess } from './health.mjs'
import { classify, planQueries } from './intent.mjs'
import * as cache from './cache.mjs'

/* ============================================================
   Search orchestrator
   -------------------
   One entry point for every search PixGPT performs.

       query
         ↓  classify        what kind of question is this
         ↓  select          which providers are good at that, cheapest first
         ↓  search          with fallback on failure
         ↓  deduplicate     the same page found twice is one source
         ↓  rerank          authority, freshness, agreement, query match
       results

   Raw provider output is never returned to a model. This produces a
   ranked, deduplicated, normalised set that the research layer turns
   into bounded context with citations.
   ============================================================ */

const MAX_RESULTS_CAP = 25

/** Domains whose word carries more weight, by what they are authoritative about. */
const AUTHORITY = [
  // Standards and specifications
  { pattern: /(^|\.)(w3\.org|whatwg\.org|ietf\.org|rfc-editor\.org|unicode\.org|ecma-international\.org)$/i, boost: 0.45 },
  // Primary developer references
  { pattern: /(^|\.)(developer\.mozilla\.org|docs\.python\.org|nodejs\.org|typescriptlang\.org)$/i, boost: 0.4 },
  // Package registries — the source of truth for "what version is current"
  { pattern: /(^|\.)(npmjs\.com|pypi\.org|crates\.io|packagist\.org|rubygems\.org|nuget\.org)$/i, boost: 0.4 },
  // Project repositories and release pages
  { pattern: /(^|\.)github\.com$/i, boost: 0.3 },
  { pattern: /(^|\.)(gitlab\.com|codeberg\.org|sourceforge\.net)$/i, boost: 0.2 },
  // Encyclopedic
  { pattern: /(^|\.)wikipedia\.org$/i, boost: 0.2 },
  // Academic and government
  { pattern: /\.(edu|ac\.uk|gov)$/i, boost: 0.25 },
  { pattern: /(^|\.)(arxiv\.org|doi\.org|ncbi\.nlm\.nih\.gov|nature\.com|science\.org)$/i, boost: 0.3 },
]

/** Content farms and aggregators that mostly restate other sources. */
const LOW_QUALITY = [
  { pattern: /(^|\.)(w3schools\.com|geeksforgeeks\.org|tutorialspoint\.com|javatpoint\.com|educba\.com|codegrepper\.com)$/i, penalty: 0.25 },
  { pattern: /(^|\.)(medium\.com|dev\.to|hashnode\.dev|substack\.com)$/i, penalty: 0.12 },
  { pattern: /(^|\.)(pinterest\.|quora\.com|answers\.|coursehero\.com|scribd\.com)/i, penalty: 0.3 },
]

/** A documentation host for a package, e.g. react.dev or docs.astro.build. */
function looksLikeOfficialDocs(domain, packages) {
  if (/^docs?\./i.test(domain) || /\.(dev|io)$/i.test(domain)) {
    if (packages.length === 0) return /^docs?\./i.test(domain)
    return packages.some((name) => domain.includes(name.replace(/[^a-z0-9]/g, '')))
  }
  return false
}

/**
 * Scores a result for final ordering.
 *
 * The provider's own ranking is a starting point, not the answer: a search
 * engine ranks for clicks, and PixGPT needs the source that is most likely to
 * be correct and current.
 */
function rankScore(result, { intent, agreementCount, query }) {
  let score = Math.max(0, Math.min(result.score ?? 0, 1)) * 0.5

  for (const { pattern, boost } of AUTHORITY) {
    if (pattern.test(result.domain)) {
      score += boost
      break
    }
  }
  for (const { pattern, penalty } of LOW_QUALITY) {
    if (pattern.test(result.domain)) {
      score -= penalty
      break
    }
  }

  if (looksLikeOfficialDocs(result.domain, intent.packages)) score += 0.3

  /*
   * Freshness. Only rewarded when the question is actually about the present —
   * for "what is a monad" a 2015 article may be the best one written.
   */
  if (result.publishedAt) {
    const ageDays = (Date.now() - new Date(result.publishedAt).getTime()) / 86_400_000
    if (intent.timeSensitive) {
      if (ageDays <= 2) score += 0.5
      else if (ageDays <= 14) score += 0.3
      else if (ageDays <= 90) score += 0.1
      else if (ageDays > 365) score -= 0.35 // an old article presented as current
    } else if (ageDays <= 365) {
      score += 0.1
    }
  } else if (intent.timeSensitive) {
    // No date on a question about right now is a real weakness
    score -= 0.15
  }

  // Independent providers finding the same page is corroboration
  if (agreementCount > 1) score += Math.min((agreementCount - 1) * 0.15, 0.4)

  // Query terms in the title
  const titleLower = result.title.toLowerCase()
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  if (terms.length > 0) {
    const matched = terms.filter((t) => titleLower.includes(t)).length
    score += (matched / terms.length) * 0.2
  }

  // A bare homepage rarely answers a specific question
  try {
    if (new URL(result.url).pathname.replace(/\/+$/, '') === '') score -= 0.1
  } catch {
    /* unparseable URLs were already filtered */
  }

  return Math.round(score * 1000) / 1000
}

/**
 * Merges results from several providers into one ranked list.
 * Duplicates become a single result carrying the providers that found it.
 */
export function mergeResults(batches, { intent, query, maxResults }) {
  /** @type {Map<string, object>} */
  const byKey = new Map()

  for (const batch of batches) {
    for (const result of batch.results ?? []) {
      if (!result.url) continue
      const key = dedupeKey(result.url)
      const existing = byKey.get(key)

      if (!existing) {
        byKey.set(key, { ...result, providers: [result.provider], agreementCount: 1 })
        continue
      }

      existing.agreementCount++
      if (!existing.providers.includes(result.provider)) existing.providers.push(result.provider)
      // Keep the richest version of each field
      if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet
      if (!existing.publishedAt && result.publishedAt) existing.publishedAt = result.publishedAt
      if (result.title.length > existing.title.length && result.title.length < 200) existing.title = result.title
      existing.score = Math.max(existing.score, result.score)
    }
  }

  return [...byKey.values()]
    .map((result) => ({
      ...result,
      rank: rankScore(result, { intent, agreementCount: result.agreementCount, query }),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, maxResults)
}

/** Runs one provider, recording health and normalising the outcome. */
async function runProvider(provider, request) {
  const started = Date.now()
  try {
    const outcome = await provider.adapter(request, provider.config)
    const latencyMs = Date.now() - started

    if (!outcome.ok) {
      if (outcome.retryAfter) noteRetryAfter(provider.id, outcome.retryAfter)
      else noteFailure(provider.id, outcome.reason, outcome.status)
      log.warn('search provider failed', {
        provider: provider.id,
        reason: outcome.reason,
        status: outcome.status,
        ms: latencyMs,
      })
      return { ...outcome, provider: provider.id, latencyMs }
    }

    noteSuccess(provider.id, { latencyMs, results: outcome.results.length })
    log.info('search provider ok', { provider: provider.id, results: outcome.results.length, ms: latencyMs })
    return { ...outcome, provider: provider.id, latencyMs }
  } catch (error) {
    const latencyMs = Date.now() - started
    noteFailure(provider.id, String(error?.message ?? 'error'))
    log.warn('search provider threw', { provider: provider.id, message: String(error?.message).slice(0, 150) })
    return { ok: false, reason: 'adapter_error', provider: provider.id, latencyMs }
  }
}

/**
 * Runs one query across providers, with fallback.
 *
 * `parallel` queries the top providers at once and merges, which is what deep
 * research wants — several independent indexes give a set that can be
 * cross-checked. Sequential stops at the first provider that returns anything,
 * which is what a normal search wants: it is cheaper and usually enough.
 */
async function searchOne(query, options) {
  const {
    type = SEARCH_TYPE.WEB,
    recency = RECENCY.ANY,
    maxResults = 8,
    freeOnly = false,
    parallel = false,
    providerLimit = 4,
    signal,
    language,
    region,
    safeSearch,
    domains,
    excludeDomains,
    githubKind,
    deep = false,
  } = options

  const providers = selectProviders({ type, freeOnly, limit: providerLimit })
  if (providers.length === 0) {
    return { ok: false, reason: 'no_provider_available', batches: [], attempts: [] }
  }

  const request = {
    query,
    type,
    recency,
    maxResults: Math.min(maxResults, MAX_RESULTS_CAP),
    signal,
    language,
    region,
    safeSearch,
    domains,
    excludeDomains,
    githubKind,
    deep,
  }

  const attempts = []
  const batches = []

  if (parallel) {
    const outcomes = await Promise.all(providers.map((p) => runProvider(p, request)))
    for (const outcome of outcomes) {
      attempts.push({ provider: outcome.provider, ok: outcome.ok, reason: outcome.reason, latencyMs: outcome.latencyMs })
      if (outcome.ok && outcome.results.length > 0) batches.push(outcome)
    }
  } else {
    for (const provider of providers) {
      const outcome = await runProvider(provider, request)
      attempts.push({ provider: outcome.provider, ok: outcome.ok, reason: outcome.reason, latencyMs: outcome.latencyMs })

      if (outcome.ok && outcome.results.length > 0) {
        batches.push(outcome)
        break
      }
      /*
       * An empty-but-successful result is not a provider failure, but it is also
       * not an answer — so the next provider is tried. A genuinely obscure query
       * will simply come back empty from all of them.
       */
    }
  }

  if (batches.length === 0) {
    return {
      ok: false,
      reason: attempts.every((a) => a.ok) ? 'no_results' : 'all_providers_failed',
      batches: [],
      attempts,
    }
  }
  return { ok: true, batches, attempts }
}

/**
 * The public search entry point.
 *
 * @param {string} query
 * @param {{
 *   type?: string, recency?: string, mode?: string, maxResults?: number,
 *   signal?: AbortSignal, language?: string, region?: string, safeSearch?: number,
 *   domains?: string[], excludeDomains?: string[], githubKind?: string,
 *   noCache?: boolean
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean, query: string, results: object[], intent: object,
 *   providers: string[], attempts: object[], cached: boolean,
 *   cacheAgeMs?: number, reason?: string
 * }>}
 */
export async function search(query, options = {}) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!clean) return { ok: false, reason: 'empty_query', query: '', results: [], intent: null, providers: [], attempts: [] }

  const intent = classify(clean)
  const type = options.type ?? intent.type
  const recency = options.recency ?? intent.recency
  const mode = options.mode ?? SEARCH_MODE.BALANCED
  const maxResults = Math.min(options.maxResults ?? (mode === SEARCH_MODE.FAST ? 5 : 8), MAX_RESULTS_CAP)
  const freeOnly = mode === SEARCH_MODE.FREE_ONLY || options.freeOnly === true

  if (!searchAvailableFor(type)) {
    return {
      ok: false,
      reason: 'no_provider_for_type',
      query: clean,
      results: [],
      intent,
      providers: [],
      attempts: [],
    }
  }

  const cacheKey = [clean, type, recency, maxResults, freeOnly, options.domains ?? null, options.githubKind ?? null]
  const ttl = cache.ttlFor(clean, type)

  const produce = async () => {
    const outcome = await searchOne(clean, {
      ...options,
      type,
      recency,
      maxResults,
      freeOnly,
      // FAST asks one provider; anything else may query several at once
      parallel: mode === SEARCH_MODE.DEEP,
      providerLimit: mode === SEARCH_MODE.FAST ? 1 : mode === SEARCH_MODE.DEEP ? 4 : 3,
      deep: mode === SEARCH_MODE.DEEP,
    })

    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, results: [], attempts: outcome.attempts, providers: [] }
    }

    const results = mergeResults(outcome.batches, { intent, query: clean, maxResults })
    return {
      ok: true,
      results,
      attempts: outcome.attempts,
      providers: [...new Set(outcome.batches.map((b) => b.provider))],
      answerBox: outcome.batches.find((b) => b.answerBox)?.answerBox ?? null,
    }
  }

  const outcome = options.noCache
    ? { ...(await produce()), cached: false }
    : await cache.through(cacheKey, { ttl, isWorthCaching: (v) => v.ok && v.results.length > 0 }, produce)

  return { ...outcome, query: clean, intent, type, recency, mode }
}

/**
 * Runs several related queries and merges everything into one ranked set.
 *
 * This is what makes an answer verifiable: independent queries surface
 * independent sources, and a claim that appears in several of them is
 * corroborated rather than merely retrieved once.
 */
export async function multiSearch(query, options = {}) {
  const clean = String(query ?? '').trim()
  const intent = classify(clean)
  const queries = options.queries ?? planQueries(clean, intent, { max: options.maxQueries ?? 3 })

  const outcomes = await Promise.all(
    queries.map((q) =>
      search(q, { ...options, mode: options.mode ?? SEARCH_MODE.BALANCED }).catch(() => ({ ok: false, results: [] })),
    ),
  )

  const batches = outcomes
    .filter((o) => o.ok)
    .map((o) => ({ provider: (o.providers ?? []).join('+') || 'merged', results: o.results }))

  const results = mergeResults(batches, {
    intent,
    query: clean,
    maxResults: options.maxResults ?? 12,
  })

  return {
    ok: results.length > 0,
    query: clean,
    queries,
    intent,
    results,
    providers: [...new Set(outcomes.flatMap((o) => o.providers ?? []))],
    attempts: outcomes.flatMap((o) => o.attempts ?? []),
    reason: results.length === 0 ? (outcomes.find((o) => o.reason)?.reason ?? 'no_results') : undefined,
  }
}

export { AUTHORITY, LOW_QUALITY, rankScore, MAX_RESULTS_CAP }
