import { SEARCH_TYPE, RECENCY } from './types.mjs'
import { isTimeSensitive } from './cache.mjs'

/* ============================================================
   Query intent
   ------------
   Decides what kind of search a question needs, so the orchestrator
   can pick providers that are actually good at it. A GitHub code
   question should not go to a news index, and "what happened today"
   should not be answered from a reference encyclopedia.

   Deliberately rule-based rather than a model call: it runs on every
   query, it has to be fast and free, and the signals are strong enough
   that a classifier would be overkill. The model still decides *whether*
   to search — this only shapes the search once that decision is made.
   ============================================================ */

/** Signals for each search type, weighted by how decisive they are. */
const SIGNALS = [
  {
    type: SEARCH_TYPE.GITHUB,
    weight: 3,
    patterns: [
      /\bgithub\b/i,
      /\brepo(sitory)?\b/i,
      /\bpull request\b|\bPR\b/,
      /\bissue #?\d+/i,
      /\bsource code\b/i,
      /\bopen[- ]source\b/i,
      /\bimplementation of\b/i,
      /\bgithub\.com\//i,
    ],
  },
  {
    type: SEARCH_TYPE.CODE,
    weight: 2,
    patterns: [
      /\bcode (example|sample|snippet)\b/i,
      /\bhow (do|to) I? ?(implement|write|code)\b/i,
      /\bfunction\b.*\bexample\b/i,
      /\bexample (of |code )?usage\b/i,
    ],
  },
  {
    type: SEARCH_TYPE.NEWS,
    weight: 3,
    patterns: [
      /\bnews\b/i,
      /\bbreaking\b/i,
      /\bwhat happened\b/i,
      /\btoday\b/i,
      /\byesterday\b/i,
      /\bthis (week|morning|evening)\b/i,
      /\bannounce(d|ment)\b/i,
      /\belection\b|\bwon\b|\bwinner\b/i,
      /\bwho is the (current|new)\b/i,
    ],
  },
  {
    type: SEARCH_TYPE.DOCUMENTATION,
    weight: 3,
    patterns: [
      /\bdocs?\b|\bdocumentation\b/i,
      /\bAPI reference\b/i,
      /\bhow (do|to) I? ?use\b/i,
      /\bmigration guide\b/i,
      /\bchangelog\b|\brelease notes\b/i,
      /\bconfigure|\bconfiguration\b/i,
      /\bgetting started\b/i,
      /\berror\b.*\bfix\b|\bfix\b.*\berror\b/i,
      /\bdeprecated\b/i,
    ],
  },
  {
    type: SEARCH_TYPE.REFERENCE,
    weight: 2,
    patterns: [
      /^what (is|are|was|were)\b/i,
      /^who (is|was)\b/i,
      /^where (is|was)\b/i,
      /\bdefinition of\b/i,
      /\bhistory of\b/i,
      /\bexplain\b/i,
      /\bmeaning of\b/i,
    ],
  },
  {
    type: SEARCH_TYPE.IMAGES,
    weight: 3,
    patterns: [/\bimages?\b of\b/i, /\bphotos?\b/i, /\bpictures?\b/i, /\bscreenshots?\b of\b/i],
  },
  {
    type: SEARCH_TYPE.VIDEOS,
    weight: 3,
    patterns: [/\bvideos?\b/i, /\byoutube\b/i, /\bwatch\b.*\btutorial\b/i],
  },
]

/** Package and framework names worth version-scoping a technical search to. */
const TECH_HINTS = [
  'react', 'next.js', 'nextjs', 'vue', 'nuxt', 'svelte', 'angular', 'astro',
  'vite', 'webpack', 'rollup', 'esbuild', 'typescript', 'javascript', 'node',
  'deno', 'bun', 'express', 'fastify', 'nestjs', 'django', 'flask', 'fastapi',
  'rails', 'laravel', 'spring', 'tailwind', 'prisma', 'drizzle', 'postgres',
  'mysql', 'mongodb', 'redis', 'graphql', 'trpc', 'zod', 'jest', 'vitest',
  'playwright', 'puppeteer', 'cypress', 'eslint', 'prettier', 'docker',
  'kubernetes', 'terraform', 'pytorch', 'tensorflow', 'numpy', 'pandas',
]

/** Question words and filler that add nothing to a search query. */
const STOP_WORDS = new Set([
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'can', 'could', 'should', 'would', 'will',
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'at', 'by', 'with',
  'i', 'me', 'my', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'about', 'from', 'into',
  'please', 'tell', 'show', 'find', 'get', 'give', 'help',
])

/**
 * Reduces a question to its searchable core.
 *
 * "What is the latest stable version of React?" -> "latest stable version React"
 *
 * Used to build query variants: appending or prefixing terms onto a full
 * sentence makes a worse query than the sentence alone.
 */
export function coreTerms(query) {
  const words = String(query ?? '')
    .replace(/[?!.,;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const kept = words.filter((word) => {
    // Keep anything that looks like a name, a version or an identifier
    if (/[A-Z]/.test(word.slice(1)) || /[.@/\d]/.test(word)) return true
    return !STOP_WORDS.has(word.toLowerCase())
  })

  const core = (kept.length > 0 ? kept : words).join(' ').trim()
  // A very long core is just the sentence again; cap it to the leading terms
  return core.split(/\s+/).slice(0, 10).join(' ')
}

/**
 * Classifies a query.
 *
 * @param {string} query
 * @returns {{
 *   type: string,
 *   recency: string,
 *   timeSensitive: boolean,
 *   technical: boolean,
 *   packages: string[],
 *   scores: Record<string, number>,
 *   needsMultipleSources: boolean
 * }}
 */
export function classify(query) {
  const text = String(query ?? '')
  const scores = {}

  for (const signal of SIGNALS) {
    let score = 0
    for (const pattern of signal.patterns) {
      if (pattern.test(text)) score += signal.weight
    }
    if (score > 0) scores[signal.type] = (scores[signal.type] ?? 0) + score
  }

  const timeSensitive = isTimeSensitive(text)
  if (timeSensitive) scores[SEARCH_TYPE.NEWS] = (scores[SEARCH_TYPE.NEWS] ?? 0) + 1

  const lower = text.toLowerCase()
  const packages = TECH_HINTS.filter((name) => lower.includes(name))
  const technical = packages.length > 0 || /\b(npm|pip|cargo|yarn|pnpm|api|sdk|cli|library|framework|package|version)\b/i.test(text)

  if (technical) {
    /*
     * A named package outweighs the phrasing. "What is the latest React
     * version" opens like an encyclopedia question but is answered by the
     * project's own release notes, not by a reference article — so a named
     * package pushes it firmly to documentation.
     */
    scores[SEARCH_TYPE.DOCUMENTATION] = (scores[SEARCH_TYPE.DOCUMENTATION] ?? 0) + (packages.length > 0 ? 4 : 2)
    if (scores[SEARCH_TYPE.REFERENCE]) scores[SEARCH_TYPE.REFERENCE] = Math.max(0, scores[SEARCH_TYPE.REFERENCE] - 2)
  }

  /*
   * A question asking to compare, verify or research needs several independent
   * sources, not one good answer — one source cannot be cross-checked.
   */
  const needsMultipleSources = /\b(compare|versus|vs\b|difference between|pros and cons|research|verify|fact.?check|is it true|conflicting|which is better)\b/i.test(text)

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const type = ranked.length > 0 ? ranked[0][0] : SEARCH_TYPE.WEB

  return {
    type,
    recency: timeSensitive
      ? /\btoday\b|\bbreaking\b|\bright now\b|\bcurrently\b/i.test(text)
        ? RECENCY.DAY
        : RECENCY.WEEK
      : RECENCY.ANY,
    timeSensitive,
    technical,
    packages,
    scores,
    needsMultipleSources,
  }
}

/**
 * Expands one question into several independent queries for deep research.
 *
 * Different phrasings surface different sources — a single query returns one
 * slice of the index, which is exactly what makes a single-source answer
 * unverifiable.
 */
export function planQueries(query, intent, { max = 4 } = {}) {
  const base = String(query ?? '').trim()
  const core = coreTerms(base)
  const queries = [base]
  const year = new Date().getUTCFullYear()

  /*
   * Variants are built from the keyword core, not the whole sentence. Prefixing
   * a full question produces "latest What is the latest stable version of
   * React?", which is a worse query than the original.
   */
  if (intent.timeSensitive) {
    queries.push(`${core} ${year}`)
  }

  if (intent.technical && intent.packages.length > 0) {
    const name = intent.packages[0]
    queries.push(`${name} official documentation`)
    queries.push(`${name} changelog release notes`)
  } else if (intent.type === SEARCH_TYPE.DOCUMENTATION) {
    queries.push(`${core} official documentation`)
  }

  if (intent.type === SEARCH_TYPE.GITHUB) {
    queries.push(`${core} github repository`)
  }

  if (intent.needsMultipleSources) {
    queries.push(`${core} comparison`)
    queries.push(`${core} limitations drawbacks`)
  }

  // De-duplicate while preserving the original query first
  const seen = new Set()
  return queries
    .map((q) => q.replace(/\s+/g, ' ').trim())
    .filter((q) => q.length > 2 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
    .slice(0, max)
}

export { SIGNALS, TECH_HINTS }
