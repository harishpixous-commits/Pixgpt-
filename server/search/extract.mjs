import { safeFetch } from './net.mjs'
import { domainOf, normaliseDate } from './types.mjs'
import { log } from '../config.mjs'

/* ============================================================
   Page reading
   ------------
   Turns a search result into bounded, readable passages.

   A whole page is the wrong thing to give a model: most of it is
   navigation, cookie banners, related-article rails and footers, and
   the useful part is a few paragraphs. So the pipeline is

       fetch (guarded)  →  strip noise  →  find the main content
                        →  score passages against the query
                        →  return the best few, bounded

   Everything returned is DATA. The caller fences it as such; nothing
   here interprets page text as an instruction.
   ============================================================ */

const MAX_PAGE_BYTES = Number.parseInt(process.env.SEARCH_MAX_PAGE_BYTES ?? '', 10) || 600_000
const MAX_PASSAGE_CHARS = Number.parseInt(process.env.SEARCH_MAX_PASSAGE_CHARS ?? '', 10) || 6_000
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.SEARCH_PAGE_TIMEOUT_MS ?? '', 10) || 12_000

/* ---------- entities ---------- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', shy: '', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', sup2: '²', sup3: '³', micro: 'µ', middot: '·',
  bull: '•', dagger: '†', permil: '‰', euro: '€', pound: '£', yen: '¥', cent: '¢',
}

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,10});/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' '
      // Surrogates are not valid on their own and throw
      if (code >= 0xd800 && code <= 0xdfff) return ' '
      try {
        return String.fromCodePoint(code)
      } catch {
        return ' '
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

/* ---------- metadata ---------- */

/** Reads the title from `<title>`, Open Graph, or the first heading. */
function extractTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{2,300})["']/i.exec(html)
  if (og) return decodeEntities(og[1]).trim()
  const title = /<title[^>]*>([\s\S]{2,300}?)<\/title>/i.exec(html)
  if (title) return decodeEntities(title[1]).replace(/\s+/g, ' ').trim()
  const h1 = /<h1[^>]*>([\s\S]{2,300}?)<\/h1>/i.exec(html)
  return h1 ? decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''
}

/**
 * Reads a publication date from the several places pages put one.
 *
 * This matters for news: an article's *publication* date is the only way to
 * tell a report from last year apart from one from this morning, and both look
 * identical in a search snippet.
 */
function extractPublishedAt(html) {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:publish|publication|pubdate|date|DC\.date)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    const date = match ? normaliseDate(match[1]) : null
    if (date) return date
  }

  // JSON-LD is the most reliable source when present
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]{0,20000}?)<\/script>/gi)) {
    const found = /"datePublished"\s*:\s*"([^"]+)"/.exec(block[1])
    const date = found ? normaliseDate(found[1]) : null
    if (date) return date
  }
  return null
}

function extractDescription(html) {
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,600})["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,600})["']/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match) return decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
  }
  return ''
}

/* ---------- content ---------- */

/** Elements whose contents are never article text. */
const NOISE_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'menu',
]

/**
 * Class and id fragments that mark a container as chrome rather than content.
 *
 * The boundary character class has to include quotes and `=`, because the text
 * being matched is a raw attribute string: in `class="cookie-consent"` the word
 * is preceded by a double quote, and requiring a dash or space there let every
 * first-position class name through.
 */
const NOISE_HINTS =
  /(^|[-_\s"'=])(nav|navbar|menu|sidebar|side-bar|footer|header|banner|cookie|consent|gdpr|newsletter|subscribe|signup|sign-up|promo|advert|advertisement|ads?|sponsor|social|share|related|recommend|comment|disqus|popup|modal|overlay|breadcrumb|pagination|skip-link|screen-reader|sr-only|toolbar|widget)([-_\s"']|$)/i

/**
 * Strips a page down to its readable text.
 *
 * A real DOM would be better, but this runs on the server for arbitrary pages
 * and a full parser is a large dependency plus an attack surface. Removing
 * known-noise elements and then the remaining tags gets the article body for
 * the overwhelming majority of pages, and the passage scoring below tolerates
 * whatever slips through.
 */
export function htmlToText(html) {
  // The head holds the title and meta tags, which are read separately from the
  // raw HTML. Left in, the document title reappears as a stray line of body text.
  let text = String(html).replace(/<head\b[\s\S]*?<\/head>/i, ' ')

  for (const tag of NOISE_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
    // Unclosed noise tags are common; drop the opening tag at least
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), ' ')
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')

  /*
   * Drop divs and sections whose class or id says they are chrome. Bounded to
   * one pass over reasonably sized blocks, because a global nested-tag match on
   * a large page is where a regex approach gets slow.
   */
  text = text.replace(
    /<(div|section|ul|ol|span|p)\b([^>]*)>([\s\S]{0,4000}?)<\/\1>/gi,
    (match, tag, attrs, inner) => (NOISE_HINTS.test(attrs) ? ' ' : `<${tag}>${inner}</${tag}>`),
  )

  return decodeEntities(
    text
      // Preserve block structure as newlines before dropping tags
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|dd|dt)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)>/gi, '\t')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Splits text into paragraph-sized passages worth scoring. */
function toPassages(text) {
  return text
    .split(/\n{2,}|\n(?=[A-Z#])/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => {
      if (block.length < 60) return false
      // Navigation debris: many short segments separated by pipes or bullets
      const separators = (block.match(/[|•·]/g) ?? []).length
      if (separators > 4 && block.length / (separators + 1) < 25) return false
      // Needs some actual sentence structure
      return /[a-z]{3}/.test(block) && (block.match(/[.!?]/g) ?? []).length >= 1
    })
}

/**
 * Scores a passage for how well it answers the query.
 *
 * Term overlap, with a bonus for passages near the top of the page (where the
 * lead paragraph usually is) and for those containing numbers or version-like
 * tokens, which is what a factual question is usually after.
 */
function scorePassage(passage, terms, position, total) {
  const lower = passage.toLowerCase()
  let score = 0

  for (const term of terms) {
    if (!lower.includes(term)) continue
    // Diminishing returns per term, so one repeated word cannot dominate
    const count = lower.split(term).length - 1
    score += 1 + Math.min(count - 1, 3) * 0.25
  }

  if (terms.length > 0) score /= terms.length // normalise to 0..~1.75
  score += (1 - position / Math.max(total, 1)) * 0.3
  if (/\b\d+\.\d+(\.\d+)?\b/.test(passage)) score += 0.2 // a version number
  if (/\b(19|20)\d{2}\b/.test(passage)) score += 0.1 // a year
  return score
}

/** Query terms worth matching on. */
function queryTerms(query) {
  return [
    ...new Set(
      String(query ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9.@/\s-]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2),
    ),
  ].slice(0, 14)
}

/**
 * Fetches a page and returns the passages most relevant to the query.
 *
 * @param {string} url
 * @param {{ query?: string, maxChars?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, url, title, description, publishedAt, domain,
 *                     text, passages: string[], bytes, truncated }
 *                  | { ok: false, reason: string, url: string }>}
 */
export async function readPage(url, { query = '', maxChars = MAX_PASSAGE_CHARS, signal } = {}) {
  const fetched = await safeFetch(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_PAGE_BYTES,
    signal,
  })
  if (!fetched.ok) {
    log.debug('page read failed', { url: String(url).slice(0, 120), reason: fetched.reason })
    return { ok: false, reason: fetched.reason, url: String(url) }
  }

  const html = fetched.body
  const isJson = /json/i.test(fetched.contentType)

  // JSON endpoints are already structured; pretty-print rather than de-tagging
  const text = isJson
    ? (() => {
        try {
          return JSON.stringify(JSON.parse(html), null, 1).slice(0, maxChars * 2)
        } catch {
          return html.slice(0, maxChars * 2)
        }
      })()
    : htmlToText(html)

  const passages = isJson ? [text.slice(0, maxChars)] : toPassages(text)
  const terms = queryTerms(query)

  /*
   * Ranked by relevance, then re-ordered back into document order. Reading
   * order matters for comprehension: passages shuffled by score read as
   * disconnected fragments.
   */
  const ranked = passages
    .map((passage, index) => ({ passage, index, score: scorePassage(passage, terms, index, passages.length) }))
    .sort((a, b) => b.score - a.score)

  const chosen = []
  let used = 0
  for (const candidate of ranked) {
    if (used + candidate.passage.length > maxChars) {
      if (chosen.length > 0) continue
      // Nothing chosen yet and the first passage is oversized: take a slice
      chosen.push({ ...candidate, passage: candidate.passage.slice(0, maxChars) })
      used = maxChars
      continue
    }
    chosen.push(candidate)
    used += candidate.passage.length
    if (used >= maxChars) break
  }
  chosen.sort((a, b) => a.index - b.index)

  return {
    ok: true,
    url: fetched.url,
    title: extractTitle(html),
    description: extractDescription(html),
    publishedAt: extractPublishedAt(html),
    domain: domainOf(fetched.url),
    text: chosen.map((c) => c.passage).join('\n\n'),
    passages: chosen.map((c) => c.passage),
    bytes: fetched.bytes,
    truncated: fetched.truncated,
    relevance: chosen.length > 0 ? Math.round(Math.max(...chosen.map((c) => c.score)) * 100) / 100 : 0,
  }
}

/** Reads several pages at once, keeping only the ones that worked. */
export async function readPages(urls, options = {}) {
  const results = await Promise.all(urls.map((url) => readPage(url, options).catch(() => ({ ok: false, reason: 'error', url }))))
  return {
    pages: results.filter((r) => r.ok),
    failures: results.filter((r) => !r.ok).map((r) => ({ url: r.url, reason: r.reason })),
  }
}

export { MAX_PASSAGE_CHARS, MAX_PAGE_BYTES, extractTitle, extractPublishedAt, toPassages }
