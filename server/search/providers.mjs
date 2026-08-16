import { safeFetch, safeFetchJson } from './net.mjs'
import { SEARCH_TYPE, RECENCY, makeResult } from './types.mjs'
import { decodeEntities, htmlToText } from './extract.mjs'

/* ============================================================
   Provider adapters
   -----------------
   One function per backend, each returning normalised results.

   Every adapter reads defensively: `x.url ?? x.link ?? x.href`. Search
   APIs rename fields between versions, and an adapter that insists on
   one spelling breaks silently when they do — returning zero results,
   which looks like "nothing found" rather than "we stopped working".

   Adapters never throw for an expected failure. They return
   { ok: false, reason, status } so the orchestrator can classify it,
   open a circuit breaker, and fall through to the next provider.
   ============================================================ */

const ok = (results, extra = {}) => ({ ok: true, results, ...extra })
const fail = (reason, status) => ({ ok: false, reason, status })

/** Pulls a rate-limit hint out of the response headers. */
function retryAfterOf(headers) {
  if (!headers) return null
  return headers.get?.('retry-after') ?? headers.get?.('x-ratelimit-reset') ?? null
}

/** Translates a normalised recency into a provider's own vocabulary. */
function freshness(recency, dialect) {
  if (!recency || recency === RECENCY.ANY) return null
  if (dialect === 'brave') {
    return { [RECENCY.DAY]: 'pd', [RECENCY.WEEK]: 'pw', [RECENCY.MONTH]: 'pm', [RECENCY.YEAR]: 'py' }[recency] ?? null
  }
  if (dialect === 'searxng') {
    /*
     * SearXNG accepts only day, month and year — there is no "week". Passing an
     * unsupported value gets it ignored, silently widening the search, so a
     * week request is mapped to the next valid window up. Over-including is
     * recoverable: the reranker rewards freshness. Under-including is not.
     */
    return { [RECENCY.DAY]: 'day', [RECENCY.WEEK]: 'month', [RECENCY.MONTH]: 'month', [RECENCY.YEAR]: 'year' }[recency] ?? null
  }
  if (dialect === 'serper') {
    // Google's tbs "qdr" (query date range) parameter
    return { [RECENCY.DAY]: 'qdr:d', [RECENCY.WEEK]: 'qdr:w', [RECENCY.MONTH]: 'qdr:m', [RECENCY.YEAR]: 'qdr:y' }[recency] ?? null
  }
  if (dialect === 'range') {
    // Tavily's current vocabulary; it replaced the older numeric `days` field
    return { [RECENCY.DAY]: 'day', [RECENCY.WEEK]: 'week', [RECENCY.MONTH]: 'month', [RECENCY.YEAR]: 'year' }[recency] ?? null
  }
  if (dialect === 'iso') {
    const days = { [RECENCY.DAY]: 1, [RECENCY.WEEK]: 7, [RECENCY.MONTH]: 30, [RECENCY.YEAR]: 365 }[recency]
    return days ? new Date(Date.now() - days * 86_400_000).toISOString() : null
  }
  return null
}

/* ============================================================
   SearXNG — self-hosted, the free-first primary
   ============================================================ */

/**
 * SearXNG aggregates other engines and returns JSON when the instance enables
 * `search.formats: [html, json]`. A 403 on the JSON endpoint almost always
 * means that format is not enabled, which is worth saying plainly because it is
 * a one-line configuration fix.
 */
export async function searxng(request, config) {
  const base = String(config.url ?? '').replace(/\/+$/, '')
  if (!base) return fail('not_configured')

  const params = new URLSearchParams({ q: request.query, format: 'json' })
  if (request.language) params.set('language', request.language)
  if (request.safeSearch != null) params.set('safesearch', String(request.safeSearch))

  const timeRange = freshness(request.recency, 'searxng')
  if (timeRange) params.set('time_range', timeRange)

  const categories = {
    [SEARCH_TYPE.NEWS]: 'news',
    [SEARCH_TYPE.IMAGES]: 'images',
    [SEARCH_TYPE.VIDEOS]: 'videos',
    [SEARCH_TYPE.CODE]: 'it',
    [SEARCH_TYPE.DOCUMENTATION]: 'it',
  }[request.type]
  if (categories) params.set('categories', categories)

  const response = await safeFetchJson(`${base}/search?${params}`, {
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    // A self-hosted instance is usually plain http on a private network, which
    // is exactly what the SSRF screen refuses — so it must be opted into.
    allowHttp: config.allowPrivate === true,
  })

  if (!response.ok) {
    if (response.status === 403) return fail('json_format_not_enabled', 403)
    return fail(response.reason, response.status)
  }

  const raw = Array.isArray(response.json?.results) ? response.json.results : []
  return ok(
    raw.slice(0, request.maxResults).map((x, i) =>
      makeResult({
        title: x.title,
        url: x.url ?? x.link,
        snippet: x.content ?? x.snippet ?? '',
        publishedAt: x.publishedDate ?? x.published_date ?? null,
        provider: 'searxng',
        type: request.type,
        score: typeof x.score === 'number' ? x.score : 1 - i * 0.02,
      }),
    ),
    { engines: [...new Set(raw.flatMap((x) => x.engines ?? []))].slice(0, 8) },
  )
}

/* ============================================================
   Whoogle — self-hosted Google front-end
   ============================================================ */

/**
 * Whoogle proxies Google and renders HTML. It has no documented JSON API, so
 * this parses the result anchors out of its markup — which is acceptable here
 * because Whoogle is a self-hosted instance the operator controls, not a third
 * party being scraped.
 */
export async function whoogle(request, config) {
  const base = String(config.url ?? '').replace(/\/+$/, '')
  if (!base) return fail('not_configured')

  const response = await safeFetch(`${base}/search?q=${encodeURIComponent(request.query)}`, {
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    allowHttp: config.allowPrivate === true,
    maxBytes: 800_000,
  })
  if (!response.ok) return fail(response.reason, response.status)

  const html = response.body
  const results = []
  const seen = new Set()

  /*
   * Whoogle rewrites outbound links through its own host. Both the direct form
   * and the proxied form are handled so a configuration change does not silently
   * produce zero results.
   */
  for (const match of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    let href = decodeEntities(match[1])
    const proxied = /[?&](?:u|url)=([^&"]+)/.exec(href)
    if (proxied) href = decodeURIComponent(proxied[1])
    if (!/^https?:\/\//i.test(href)) continue
    if (href.includes(base)) continue

    const title = htmlToText(match[2]).trim()
    if (title.length < 3) continue
    if (seen.has(href)) continue
    seen.add(href)

    results.push(
      makeResult({
        title,
        url: href,
        snippet: '',
        provider: 'whoogle',
        type: request.type,
        score: 1 - results.length * 0.02,
      }),
    )
    if (results.length >= request.maxResults) break
  }

  if (results.length === 0) return fail('no_parsable_results')
  return ok(results)
}

/* ============================================================
   Brave Search API
   ============================================================ */

export async function brave(request, config) {
  if (!config.apiKey) return fail('not_configured')

  const isNews = request.type === SEARCH_TYPE.NEWS
  const endpoint = isNews
    ? 'https://api.search.brave.com/res/v1/news/search'
    : 'https://api.search.brave.com/res/v1/web/search'

  const params = new URLSearchParams({
    q: request.query,
    // Web caps count at 20; the news endpoint allows up to 50
    count: String(Math.min(request.maxResults, isNews ? 50 : 20)),
  })
  const fresh = freshness(request.recency, 'brave')
  if (fresh) params.set('freshness', fresh)
  if (request.language) params.set('search_lang', request.language)
  if (request.region) params.set('country', request.region)
  if (request.safeSearch === 0) params.set('safesearch', 'off')

  const response = await safeFetchJson(`${endpoint}?${params}`, {
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': config.apiKey,
    },
  })
  if (!response.ok) {
    return { ...fail(response.reason, response.status), retryAfter: retryAfterOf(response.headers) }
  }

  const body = response.json ?? {}
  const raw = isNews ? (body.results ?? []) : (body.web?.results ?? body.results ?? [])

  return ok(
    raw.slice(0, request.maxResults).map((x, i) =>
      makeResult({
        title: x.title,
        url: x.url,
        snippet: htmlToText(x.description ?? x.snippet ?? ''),
        // Brave reports both an absolute page_age and a relative age
        publishedAt: x.page_age ?? x.age ?? null,
        provider: 'brave',
        type: request.type,
        score: 1 - i * 0.02,
      }),
    ),
  )
}

/* ============================================================
   Tavily — built for LLM grounding
   ============================================================ */

/**
 * Tavily moved from an `api_key` body field to an `Authorization: Bearer`
 * header. Both are sent: the header is what current versions want, and the body
 * field is ignored by them rather than rejected, so one adapter covers both.
 */
export async function tavily(request, config) {
  if (!config.apiKey) return fail('not_configured')

  const body = {
    api_key: config.apiKey,
    query: request.query,
    max_results: Math.min(request.maxResults, 20),
    search_depth: request.deep ? 'advanced' : 'basic',
    include_answer: false,
    include_raw_content: false,
  }
  if (request.type === SEARCH_TYPE.NEWS) body.topic = 'news'
  const timeRange = freshness(request.recency, 'range')
  if (timeRange) body.time_range = timeRange
  if (request.domains?.length) body.include_domains = request.domains
  if (request.excludeDomains?.length) body.exclude_domains = request.excludeDomains

  const response = await safeFetchJson('https://api.tavily.com/search', {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return { ...fail(response.reason, response.status), retryAfter: retryAfterOf(response.headers) }
  }

  const raw = Array.isArray(response.json?.results) ? response.json.results : []
  return ok(
    raw.slice(0, request.maxResults).map((x, i) =>
      makeResult({
        title: x.title,
        url: x.url,
        snippet: x.content ?? x.raw_content ?? '',
        publishedAt: x.published_date ?? x.publishedDate ?? null,
        provider: 'tavily',
        type: request.type,
        // Tavily returns a real relevance score; keep it
        score: typeof x.score === 'number' ? x.score : 1 - i * 0.02,
      }),
    ),
  )
}

/* ============================================================
   Serper — Google results as JSON
   ============================================================ */

export async function serper(request, config) {
  if (!config.apiKey) return fail('not_configured')

  const path = {
    [SEARCH_TYPE.NEWS]: 'news',
    [SEARCH_TYPE.IMAGES]: 'images',
    [SEARCH_TYPE.VIDEOS]: 'videos',
  }[request.type] ?? 'search'

  const body = { q: request.query, num: Math.min(request.maxResults, 20) }
  const tbs = freshness(request.recency, 'serper')
  if (tbs) body.tbs = tbs
  if (request.region) body.gl = request.region.toLowerCase()
  if (request.language) body.hl = request.language

  const response = await safeFetchJson(`https://google.serper.dev/${path}`, {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': config.apiKey },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return { ...fail(response.reason, response.status), retryAfter: retryAfterOf(response.headers) }
  }

  const json = response.json ?? {}
  // Serper names the array after the search type
  const raw = json.organic ?? json.news ?? json.images ?? json.videos ?? []

  return ok(
    raw.slice(0, request.maxResults).map((x, i) =>
      makeResult({
        title: x.title,
        url: x.link ?? x.url ?? x.imageUrl,
        snippet: x.snippet ?? x.description ?? '',
        publishedAt: x.date ?? null,
        provider: 'serper',
        type: request.type,
        score: 1 - (typeof x.position === 'number' ? x.position : i) * 0.02,
      }),
    ),
    { answerBox: json.answerBox?.answer ?? json.answerBox?.snippet ?? null },
  )
}

/* ============================================================
   Exa — embeddings-based search
   ============================================================ */

export async function exa(request, config) {
  if (!config.apiKey) return fail('not_configured')

  const body = {
    query: request.query,
    numResults: Math.min(request.maxResults, 20),
    // Exa can return page contents with the results, which saves a fetch
    contents: { text: { maxCharacters: 2000 } },
  }
  /*
   * `type` is deliberately not sent. Exa replaced neural/keyword/hybrid with a
   * different set of modes, and letting the service choose is both current and
   * stable across further changes. Exa also returns no per-result score, so the
   * adapter falls back to result order.
   */
  if (request.type === SEARCH_TYPE.NEWS) body.category = 'news'
  else if (request.type === SEARCH_TYPE.GITHUB || request.type === SEARCH_TYPE.CODE) body.category = 'github'
  else if (request.type === SEARCH_TYPE.DOCUMENTATION) body.category = 'company'

  const startDate = freshness(request.recency, 'iso')
  if (startDate) body.startPublishedDate = startDate
  if (request.domains?.length) body.includeDomains = request.domains
  if (request.excludeDomains?.length) body.excludeDomains = request.excludeDomains

  const response = await safeFetchJson('https://api.exa.ai/search', {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return { ...fail(response.reason, response.status), retryAfter: retryAfterOf(response.headers) }
  }

  const raw = Array.isArray(response.json?.results) ? response.json.results : []
  return ok(
    raw.slice(0, request.maxResults).map((x, i) =>
      makeResult({
        title: x.title,
        url: x.url,
        snippet: String(x.text ?? x.summary ?? x.highlights?.join(' ') ?? '').slice(0, 800),
        publishedAt: x.publishedDate ?? null,
        provider: 'exa',
        type: request.type,
        score: typeof x.score === 'number' ? x.score : 1 - i * 0.02,
      }),
    ),
  )
}

/* ============================================================
   GitHub — repositories, code, issues, releases
   ============================================================ */

/**
 * GitHub's own search, used instead of a web search when the question is about
 * a repository, an implementation, or an issue.
 *
 * Code search requires authentication; without a token this reports that
 * plainly rather than returning an unexplained 403.
 */
export async function github(request, config) {
  const kind = request.githubKind ?? (request.type === SEARCH_TYPE.CODE ? 'code' : 'repositories')

  if (kind === 'code' && !config.apiKey) return fail('code_search_needs_token', 401)

  const endpoint = {
    repositories: 'repositories',
    code: 'code',
    issues: 'issues',
    users: 'users',
    topics: 'topics',
  }[kind] ?? 'repositories'

  const params = new URLSearchParams({
    q: request.query,
    per_page: String(Math.min(request.maxResults, 100)),
  })
  /*
   * Sort is omitted for best-match: GitHub has no "best-match" value, and
   * sending one makes the parameter invalid rather than defaulting. Only a
   * recency-sensitive query asks for `updated`.
   */
  if (kind === 'repositories' && request.recency && request.recency !== RECENCY.ANY) {
    params.set('sort', 'updated')
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  if (kind === 'code') headers.Accept = 'application/vnd.github.text-match+json'

  const response = await safeFetchJson(`https://api.github.com/search/${endpoint}?${params}`, {
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    headers,
  })
  if (!response.ok) {
    return { ...fail(response.reason, response.status), retryAfter: retryAfterOf(response.headers) }
  }

  const raw = Array.isArray(response.json?.items) ? response.json.items : []

  return ok(
    raw.slice(0, request.maxResults).map((x, i) => {
      if (kind === 'code') {
        return makeResult({
          title: `${x.repository?.full_name ?? ''} — ${x.path ?? ''}`,
          url: x.html_url,
          snippet: (x.text_matches ?? []).map((m) => m.fragment).join(' … ').slice(0, 800),
          provider: 'github',
          type: SEARCH_TYPE.CODE,
          score: 1 - i * 0.02,
          raw: { repository: x.repository?.full_name, path: x.path },
        })
      }
      if (kind === 'issues') {
        return makeResult({
          title: `${x.title ?? ''} (#${x.number ?? '?'}${x.state ? `, ${x.state}` : ''})`,
          url: x.html_url,
          snippet: String(x.body ?? '').slice(0, 800),
          publishedAt: x.created_at ?? null,
          provider: 'github',
          type: SEARCH_TYPE.GITHUB,
          score: 1 - i * 0.02,
          raw: { state: x.state, comments: x.comments, isPullRequest: Boolean(x.pull_request) },
        })
      }
      return makeResult({
        title: x.full_name ?? x.name,
        url: x.html_url,
        snippet: [x.description, x.language && `Language: ${x.language}`, `${x.stargazers_count ?? 0} stars`]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 800),
        publishedAt: x.pushed_at ?? x.updated_at ?? null,
        provider: 'github',
        type: SEARCH_TYPE.GITHUB,
        // Stars are a real quality signal for a repository search
        score: 1 - i * 0.02 + Math.min(Math.log10((x.stargazers_count ?? 0) + 1) / 20, 0.25),
        raw: { stars: x.stargazers_count, language: x.language, archived: x.archived },
      })
    }),
    { totalCount: response.json?.total_count ?? null, authenticated: Boolean(config.apiKey) },
  )
}

/* ============================================================
   Wikipedia — encyclopedic background
   ============================================================ */

export async function wikipedia(request, config) {
  const lang = (request.language ?? 'en').slice(0, 8).replace(/[^a-z-]/gi, '') || 'en'
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: request.query,
    format: 'json',
    // formatversion=2 returns real booleans and no legacy `*` wrappers
    formatversion: '2',
    srlimit: String(Math.min(request.maxResults, 50)),
    srprop: 'snippet|timestamp|wordcount',
  })

  const response = await safeFetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, {
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    maxBytes: 400_000,
    // Wikimedia's user-agent policy asks for an identifiable agent
    headers: { 'User-Agent': 'PixGPT/1.0 (self-hosted assistant; +https://pixgpt.local)' },
  })
  if (!response.ok) return fail(response.reason, response.status)

  const raw = response.json?.query?.search ?? []
  return ok(
    raw.slice(0, request.maxResults).map((x, i) =>
      makeResult({
        title: x.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(x.title).replace(/ /g, '_'))}`,
        snippet: htmlToText(x.snippet ?? ''),
        publishedAt: x.timestamp ?? null,
        provider: 'wikipedia',
        type: SEARCH_TYPE.REFERENCE,
        score: 1 - i * 0.03,
      }),
    ),
  )
}

/* ============================================================
   DuckDuckGo — keyless last resort
   ============================================================ */

/**
 * DuckDuckGo's HTML endpoint. Kept because it needs no key and no self-hosting,
 * which makes it the only provider that works out of the box — but it is a
 * scrape of a page that can change, so it sits at the bottom of the order.
 */
export async function duckduckgo(request, config) {
  const response = await safeFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`,
    { timeoutMs: config.timeoutMs, signal: request.signal, maxBytes: 800_000 },
  )
  if (!response.ok) return fail(response.reason, response.status)

  const html = response.body
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => htmlToText(m[1]))
  const results = []

  for (const match of html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let href = decodeEntities(match[1])
    // Outbound links are wrapped: //duckduckgo.com/l/?uddg=<encoded>
    const wrapped = /[?&]uddg=([^&]+)/.exec(href)
    if (wrapped) href = decodeURIComponent(wrapped[1])
    if (href.startsWith('//')) href = `https:${href}`
    if (!/^https:\/\//i.test(href)) continue

    results.push(
      makeResult({
        title: htmlToText(match[2]),
        url: href,
        snippet: snippets[results.length] ?? '',
        provider: 'duckduckgo',
        type: request.type,
        score: 1 - results.length * 0.02,
      }),
    )
    if (results.length >= request.maxResults) break
  }

  if (results.length === 0) return fail('no_parsable_results')
  return ok(results)
}

export const ADAPTERS = Object.freeze({
  searxng,
  whoogle,
  brave,
  tavily,
  serper,
  exa,
  github,
  wikipedia,
  duckduckgo,
})
