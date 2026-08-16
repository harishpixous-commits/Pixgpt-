import { GatewayError } from './gateway/errors.mjs'
import { log } from './config.mjs'
import { search } from './search/orchestrator.mjs'
import { research } from './search/research.mjs'
import { readPage } from './search/extract.mjs'
import { listProviders, availableTypes } from './search/registry.mjs'
import { allHealth, resetHealth } from './search/health.mjs'
import { stats as cacheStats, clear as clearCache } from './search/cache.mjs'
import { SEARCH_MODE, SEARCH_MODES, SEARCH_TYPES } from './search/types.mjs'
import { visionStatus } from './vision-router.mjs'
import { putArtifact } from './artifacts.mjs'
import { generateDocument } from './docgen/index.mjs'

/* ============================================================
   Search and research endpoints
   -----------------------------
     GET  /api/search/status      what is usable, for the UI
     GET  /api/search/providers   the full registry, for an admin panel
     POST /api/search            one search, ranked and deduplicated
     POST /api/research          a cited answer, streamed as it progresses
     POST /api/search/page       read one page from a result
     POST /api/search/reset      clear a stuck circuit breaker

   No endpoint here returns an API key, and none accepts a URL from the
   browser that is not screened exactly like every other fetch.
   ============================================================ */

const MAX_QUERY_CHARS = 400
const MAX_QUESTION_CHARS = 1000

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

/** `GET /api/search/status` — safe for any client. */
export function handleSearchStatus() {
  const providers = listProviders()
  const usable = providers.filter((p) => p.available)

  return {
    available: usable.length > 0,
    /** Only what a user needs: names and whether it works. No keys, no URLs. */
    providers: usable.map((p) => ({ id: p.id, name: p.name, cost: p.cost, health: p.health.state })),
    configuredCount: providers.filter((p) => p.configured).length,
    types: availableTypes(),
    modes: SEARCH_MODES,
    cache: { entries: cacheStats().entries, hitRate: cacheStats().hitRate },
  }
}

/**
 * `GET /api/search/providers` — the admin view.
 *
 * Reports whether each provider is configured, never the value that configures
 * it. `requires` names the environment variable so an operator knows what to
 * set without the response ever carrying a secret.
 */
export async function handleSearchProviders({ probeVision = false } = {}) {
  return {
    providers: listProviders(),
    health: allHealth(),
    cache: cacheStats(),
    types: SEARCH_TYPES,
    availableTypes: availableTypes(),
    modes: SEARCH_MODES,
    vision: await visionStatus({ probe: probeVision }),
  }
}

/** `POST /api/search` — body: { query, type?, mode?, recency?, maxResults? } */
export async function handleSearch(body, signal, requestId) {
  const query = String(body.query ?? '').trim()
  if (!query) throw bad('A search query is required.')
  if (query.length > MAX_QUERY_CHARS) throw bad(`A query may be at most ${MAX_QUERY_CHARS} characters.`)

  const mode = SEARCH_MODES.includes(body.mode) ? body.mode : SEARCH_MODE.BALANCED
  const type = SEARCH_TYPES.includes(body.type) ? body.type : undefined

  const found = await search(query, {
    type,
    mode,
    recency: body.recency,
    maxResults: Math.min(Number(body.maxResults) || 8, 20),
    signal,
    noCache: body.noCache === true,
  })

  log.info('search api', {
    requestId,
    type: found.type,
    mode,
    results: found.results?.length ?? 0,
    providers: found.providers?.join(',') ?? '',
    cached: Boolean(found.cached),
  })

  if (!found.ok) {
    return {
      ok: false,
      query: found.query,
      reason: found.reason,
      results: [],
      // Which providers were tried and why each declined; no keys involved
      attempts: found.attempts ?? [],
    }
  }

  return {
    ok: true,
    query: found.query,
    type: found.type,
    mode,
    intent: {
      type: found.intent.type,
      timeSensitive: found.intent.timeSensitive,
      technical: found.intent.technical,
    },
    results: found.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      domain: r.domain,
      publishedAt: r.publishedAt,
      retrievedAt: r.retrievedAt,
      provider: r.providers?.join(', ') ?? r.provider,
      rank: r.rank,
      agreement: r.agreementCount,
    })),
    providers: found.providers,
    cached: Boolean(found.cached),
    cacheAgeMs: found.cacheAgeMs,
    answerBox: found.answerBox ?? null,
  }
}

/**
 * `POST /api/research` — a cited answer.
 *
 * Streams as Server-Sent Events when `stream` is set, because a deep research
 * pass takes long enough that silence looks like a hang. The event sequence is
 * progress* → source* → answer → done, keeping citation objects separate from
 * the prose exactly as the protocol requires.
 */
export async function handleResearch(req, res, body, signal, requestId) {
  const question = String(body.question ?? body.query ?? '').trim()
  if (!question) throw bad('A question is required.')
  if (question.length > MAX_QUESTION_CHARS) throw bad('That question is too long.')

  const mode = SEARCH_MODES.includes(body.mode) ? body.mode : SEARCH_MODE.BALANCED
  const streaming = body.stream !== false

  if (!streaming) {
    const result = await research({ question, mode, signal, model: body.model })
    return { json: shapeResearch(result) }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  send({ type: 'start', question, mode, requestId })

  try {
    const result = await research({
      question,
      mode,
      signal,
      model: body.model,
      onProgress: (stage) => send({ type: 'progress', ...stage }),
    })

    // Sources first, as their own events, so the UI can render citations
    // independently of the prose.
    for (const source of result.sources ?? []) {
      send({
        type: 'source',
        id: source.id,
        title: source.title,
        url: source.url,
        domain: source.domain,
        publishedAt: source.publishedAt,
        retrievedAt: source.retrievedAt,
        provider: source.provider,
        cited: source.cited,
        excerpt: source.excerpt?.slice(0, 400) ?? '',
      })
    }

    if (result.answer) send({ type: 'answer', content: result.answer })
    for (const note of result.comparison?.notes ?? []) send({ type: 'note', message: note })

    send({
      type: 'done',
      ok: result.ok,
      reason: result.reason,
      sources: result.sources?.length ?? 0,
      cited: (result.sources ?? []).filter((s) => s.cited).length,
      pagesRead: result.pagesRead,
      providers: result.providers,
      durationMs: result.durationMs,
      invalidCitations: result.invalidCitations,
      model: result.model,
    })
  } catch (error) {
    const e = error instanceof GatewayError ? error : null
    log.error('research failed', { requestId, code: e?.code, message: String(error?.message).slice(0, 200) })
    send({ type: 'error', code: e?.code ?? 'provider_error', message: e?.message ?? 'The research failed.' })
  } finally {
    if (!res.writableEnded) res.end()
  }
  return { handled: true }
}

function shapeResearch(result) {
  return {
    ok: result.ok,
    question: result.question,
    answer: result.answer,
    reason: result.reason,
    sources: result.sources ?? [],
    notes: result.comparison?.notes ?? [],
    providers: result.providers ?? [],
    pagesRead: result.pagesRead ?? 0,
    invalidCitations: result.invalidCitations ?? [],
    durationMs: result.durationMs,
    model: result.model,
  }
}

/**
 * `POST /api/search/page` — read one page.
 *
 * The URL is screened by the same SSRF policy as every other fetch, so a
 * browser cannot use this endpoint to reach the server's own network.
 */
export async function handleReadPage(body, signal) {
  const url = String(body.url ?? '').trim()
  if (!url) throw bad('A URL is required.')

  const page = await readPage(url, { query: String(body.query ?? ''), signal })
  if (!page.ok) {
    // A refusal is the caller's URL being disallowed, not a server fault
    throw new GatewayError('bad_request', `That page could not be read (${page.reason}).`, { status: 400 })
  }
  return {
    ok: true,
    url: page.url,
    title: page.title,
    description: page.description,
    domain: page.domain,
    publishedAt: page.publishedAt,
    text: page.text,
    passages: page.passages,
    bytes: page.bytes,
    truncated: page.truncated,
  }
}

/** `POST /api/research/report` — a downloadable research report. */
export async function handleResearchReport(body, signal, requestId) {
  const question = String(body.question ?? '').trim()
  if (!question) throw bad('A question is required.')

  const mode = SEARCH_MODES.includes(body.mode) ? body.mode : SEARCH_MODE.DEEP
  const result = await research({ question, mode, signal, model: body.model })

  if (!result.ok) {
    throw new GatewayError('provider_error', `The research produced nothing to report (${result.reason}).`, { status: 502 })
  }

  const markdown = [
    `# ${question}`,
    '',
    `Researched ${new Date().toISOString().slice(0, 10)} · ${result.sources.length} sources · ` +
      `${result.pagesRead} read in full · via ${result.providers.join(', ') || 'search'}`,
    '',
    '## Answer',
    '',
    result.answer ?? '_No answer could be synthesised._',
    '',
    ...(result.comparison?.notes?.length
      ? ['## Points to treat with care', '', ...result.comparison.notes.map((n) => `- ${n}`), '']
      : []),
    '## Sources',
    '',
    '| # | Source | Domain | Published | Cited |',
    '| --- | --- | --- | --- | --- |',
    ...result.sources.map(
      (s) =>
        `| ${s.id} | [${s.title.replace(/\|/g, '\\|').slice(0, 80)}](${s.url}) | ${s.domain} | ` +
        `${s.publishedAt?.slice(0, 10) ?? 'not stated'} | ${s.cited ? 'yes' : 'no'} |`,
    ),
    '',
    '## Method',
    '',
    `Queries run: ${result.queries.map((q) => `\`${q}\``).join(', ')}`,
    '',
    `Every source above was retrieved by PixGPT on ${new Date().toISOString().slice(0, 10)}. ` +
      'Sources marked "cited" are the ones the answer draws on directly.',
  ].join('\n')

  const format = ['pdf', 'docx', 'md', 'html'].includes(body.format) ? body.format : 'pdf'
  const document = generateDocument({
    content: markdown,
    format,
    title: question.slice(0, 90),
    subtitle: `Research report · ${result.sources.length} sources`,
  })

  log.info('research report generated', { requestId, format, sources: result.sources.length })

  return {
    ...putArtifact({
      filename: document.filename,
      mime: document.mime,
      buffer: document.buffer,
      meta: { format: document.format, title: document.title, pages: document.pages },
    }),
    question,
    answer: result.answer,
    sources: result.sources.length,
    markdown,
  }
}

/** `POST /api/search/reset` — clears breakers and cache. Admin only. */
export function handleSearchReset(body) {
  const provider = body.provider ? String(body.provider) : null
  resetHealth(provider)
  if (body.cache === true) clearCache()
  log.info('search state reset', { provider: provider ?? 'all', cache: body.cache === true })
  return { ok: true, provider: provider ?? 'all', cacheCleared: body.cache === true }
}
