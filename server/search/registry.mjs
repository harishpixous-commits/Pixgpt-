import { ADAPTERS } from './providers.mjs'
import { COST, COST_RANK, SEARCH_TYPE } from './types.mjs'
import { healthOf, isOpen } from './health.mjs'

/* ============================================================
   Provider registry
   -----------------
   Each backend declares what it is, what it costs, and what it is
   actually good at. Routing then picks providers by capability rather
   than treating them as interchangeable — a GitHub question goes to
   GitHub, a news question does not go to Wikipedia.

   Free-first is the default policy: a self-hosted instance is preferred
   over a free public endpoint, which is preferred over a metered
   allowance, which is preferred over a billed API. Spending someone's
   search credits when a self-hosted SearXNG could have answered is a
   real cost, so it takes explicit configuration.
   ============================================================ */

function env(name, fallback = '') {
  const value = process.env[name]
  return value === undefined || value === null ? fallback : String(value).trim()
}

function intFrom(name, fallback) {
  const raw = Number.parseInt(env(name), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const DEFAULT_TIMEOUT_MS = intFrom('SEARCH_TIMEOUT_MS', 15_000)

/**
 * Provider descriptors.
 *
 * `strengths` lists the search types a provider is genuinely good at, and is
 * what makes routing better than round-robin. `types` is the wider set it can
 * technically serve. A provider is never offered for a type it cannot do.
 */
const DESCRIPTORS = [
  {
    id: 'searxng',
    name: 'SearXNG',
    description: 'Self-hosted meta-search across many engines.',
    cost: COST.SELF_HOSTED,
    basePriority: 10,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.IMAGES, SEARCH_TYPE.VIDEOS, SEARCH_TYPE.CODE, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [SEARCH_TYPE.WEB, SEARCH_TYPE.DOCUMENTATION],
    supportsDomainFilter: false,
    supportsRecency: true,
    rateLimit: null, // self-hosted: whatever the operator allows
    configure: () => ({
      url: env('SEARXNG_URL') || env('WEB_SEARCH_URL'),
      allowPrivate: env('SEARXNG_ALLOW_PRIVATE', 'true') !== 'false',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
    isConfigured: (c) => Boolean(c.url),
    missing: 'SEARXNG_URL',
  },
  {
    id: 'whoogle',
    name: 'Whoogle',
    description: 'Self-hosted, privacy-preserving Google front-end.',
    cost: COST.SELF_HOSTED,
    basePriority: 20,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [SEARCH_TYPE.WEB],
    supportsDomainFilter: false,
    supportsRecency: false,
    rateLimit: null,
    configure: () => ({
      url: env('WHOOGLE_URL'),
      allowPrivate: env('WHOOGLE_ALLOW_PRIVATE', 'true') !== 'false',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
    isConfigured: (c) => Boolean(c.url),
    missing: 'WHOOGLE_URL',
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    description: 'Encyclopedic background. Keyless and stable.',
    cost: COST.FREE,
    basePriority: 30,
    types: [SEARCH_TYPE.REFERENCE, SEARCH_TYPE.WEB],
    strengths: [SEARCH_TYPE.REFERENCE],
    /*
     * A specialist is excellent at its strengths and mediocre elsewhere.
     * Wikipedia is the best answer for "what is photosynthesis" and the wrong
     * answer for a general web query, so it must not lead on cost alone.
     */
    specialist: true,
    supportsDomainFilter: false,
    supportsRecency: false,
    rateLimit: 'courtesy limits; no key required',
    configure: () => ({ timeoutMs: DEFAULT_TIMEOUT_MS }),
    isConfigured: () => env('WIKIPEDIA_ENABLED', 'true') !== 'false',
    missing: 'WIKIPEDIA_ENABLED=true',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, code, issues and releases from the official API.',
    cost: COST.FREE,
    basePriority: 30,
    types: [SEARCH_TYPE.GITHUB, SEARCH_TYPE.CODE],
    strengths: [SEARCH_TYPE.GITHUB, SEARCH_TYPE.CODE],
    specialist: true,
    supportsDomainFilter: false,
    supportsRecency: true,
    rateLimit: '10/min unauthenticated, 30/min with a token; code search needs a token',
    configure: () => ({ apiKey: env('GITHUB_TOKEN') || env('GITHUB_API_TOKEN'), timeoutMs: DEFAULT_TIMEOUT_MS }),
    // Usable without a token for repository and issue search
    isConfigured: () => env('GITHUB_ENABLED', 'true') !== 'false',
    missing: 'GITHUB_TOKEN (optional; required for code search)',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    description: 'Keyless web search. Works with no setup, but it is an HTML scrape.',
    cost: COST.FREE,
    basePriority: 40,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [],
    supportsDomainFilter: false,
    supportsRecency: false,
    rateLimit: 'undocumented; throttles under load',
    configure: () => ({ timeoutMs: DEFAULT_TIMEOUT_MS }),
    isConfigured: () => env('DUCKDUCKGO_ENABLED', 'true') !== 'false',
    missing: 'DUCKDUCKGO_ENABLED=true',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'Search built for grounding language models; returns clean extracts.',
    cost: COST.FREE_CREDIT,
    basePriority: 50,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS],
    supportsDomainFilter: true,
    supportsRecency: true,
    rateLimit: 'monthly credit allowance',
    configure: () => ({ apiKey: env('TAVILY_API_KEY'), timeoutMs: DEFAULT_TIMEOUT_MS }),
    isConfigured: (c) => Boolean(c.apiKey),
    missing: 'TAVILY_API_KEY',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Independent web index with a real news endpoint.',
    cost: COST.FREE_CREDIT,
    basePriority: 55,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [SEARCH_TYPE.NEWS, SEARCH_TYPE.WEB],
    supportsDomainFilter: false,
    supportsRecency: true,
    rateLimit: 'monthly credit allowance',
    configure: () => ({
      apiKey: env('BRAVE_SEARCH_API_KEY') || env('BRAVE_API_KEY'),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
    isConfigured: (c) => Boolean(c.apiKey),
    missing: 'BRAVE_SEARCH_API_KEY',
  },
  {
    id: 'serper',
    name: 'Serper',
    description: 'Google results as JSON, including news, images and videos.',
    cost: COST.FREE_CREDIT,
    basePriority: 60,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.IMAGES, SEARCH_TYPE.VIDEOS, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [SEARCH_TYPE.WEB, SEARCH_TYPE.IMAGES, SEARCH_TYPE.VIDEOS],
    supportsDomainFilter: false,
    supportsRecency: true,
    rateLimit: 'one-off free query allowance, then paid',
    configure: () => ({ apiKey: env('SERPER_API_KEY'), timeoutMs: DEFAULT_TIMEOUT_MS }),
    isConfigured: (c) => Boolean(c.apiKey),
    missing: 'SERPER_API_KEY',
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'Embeddings-based search; strong on similarity and returns page text.',
    cost: COST.FREE_CREDIT,
    basePriority: 65,
    types: [SEARCH_TYPE.WEB, SEARCH_TYPE.NEWS, SEARCH_TYPE.CODE, SEARCH_TYPE.GITHUB, SEARCH_TYPE.DOCUMENTATION, SEARCH_TYPE.REFERENCE],
    strengths: [SEARCH_TYPE.DOCUMENTATION],
    supportsDomainFilter: true,
    supportsRecency: true,
    rateLimit: 'monthly credit allowance',
    configure: () => ({ apiKey: env('EXA_API_KEY'), timeoutMs: DEFAULT_TIMEOUT_MS }),
    isConfigured: (c) => Boolean(c.apiKey),
    missing: 'EXA_API_KEY',
  },
]

/** Explicit priority overrides, highest preference first. */
function configuredOrder() {
  const explicit = [
    env('SEARCH_PROVIDER_PRIMARY'),
    env('SEARCH_PROVIDER_FALLBACK_1'),
    env('SEARCH_PROVIDER_FALLBACK_2'),
    env('SEARCH_PROVIDER_FALLBACK_3'),
    ...env('SEARCH_PROVIDER_ORDER').split(',').map((s) => s.trim()),
  ]
    .map((id) => id.toLowerCase())
    .filter((id) => id && ADAPTERS[id])

  return [...new Set(explicit)]
}

/**
 * The whole registry, with live configuration and health.
 * Never includes an API key, so this is safe to hand to an admin UI.
 */
export function listProviders() {
  const order = configuredOrder()

  return DESCRIPTORS.map((descriptor) => {
    const config = descriptor.configure()
    const configured = descriptor.isConfigured(config)
    const explicitIndex = order.indexOf(descriptor.id)
    const health = healthOf(descriptor.id)

    return {
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description,
      cost: descriptor.cost,
      type: descriptor.cost === COST.SELF_HOSTED ? 'self-hosted' : descriptor.cost === COST.FREE ? 'free' : 'api',
      configured,
      /** Why it is not usable, when it is not. Never the key itself. */
      requires: configured ? null : descriptor.missing,
      /** Explicit ordering wins over the cost-based default. */
      priority: explicitIndex >= 0 ? explicitIndex : descriptor.basePriority,
      explicitlyOrdered: explicitIndex >= 0,
      capabilities: {
        types: descriptor.types,
        strengths: descriptor.strengths,
        supportsWeb: descriptor.types.includes(SEARCH_TYPE.WEB),
        supportsNews: descriptor.types.includes(SEARCH_TYPE.NEWS),
        supportsImages: descriptor.types.includes(SEARCH_TYPE.IMAGES),
        supportsVideos: descriptor.types.includes(SEARCH_TYPE.VIDEOS),
        supportsCode: descriptor.types.includes(SEARCH_TYPE.CODE),
        supportsGithub: descriptor.types.includes(SEARCH_TYPE.GITHUB),
        supportsDomainFilter: descriptor.supportsDomainFilter,
        supportsRecency: descriptor.supportsRecency,
      },
      rateLimit: descriptor.rateLimit,
      health,
      /** True when it is configured, enabled and its breaker is closed. */
      available: configured && !isOpen(descriptor.id),
    }
  })
}

/** Internal lookup: descriptor plus resolved config, including the key. */
export function resolveProvider(id) {
  const descriptor = DESCRIPTORS.find((d) => d.id === id)
  if (!descriptor) return null
  const config = descriptor.configure()
  return {
    descriptor,
    config,
    adapter: ADAPTERS[id],
    configured: descriptor.isConfigured(config),
  }
}

/**
 * Chooses providers for a request, best first.
 *
 * Ordering, in decreasing significance:
 *   1. explicit configuration (SEARCH_PROVIDER_PRIMARY and friends)
 *   2. a declared strength in this search type
 *   3. cost — self-hosted, then free, then metered, then paid
 *   4. the descriptor's own base priority
 *
 * `freeOnly` drops metered and paid providers entirely, which is what the
 * FREE_ONLY search mode means.
 */
export function selectProviders({ type = SEARCH_TYPE.WEB, freeOnly = false, includeUnhealthy = false, limit = 4 } = {}) {
  const order = configuredOrder()

  const candidates = DESCRIPTORS.map((descriptor) => {
    const config = descriptor.configure()
    return { descriptor, config, configured: descriptor.isConfigured(config) }
  })
    .filter(({ descriptor, configured }) => {
      if (!configured) return false
      if (!descriptor.types.includes(type)) return false
      if (freeOnly && (descriptor.cost === COST.FREE_CREDIT || descriptor.cost === COST.PAID)) return false
      if (!includeUnhealthy && isOpen(descriptor.id)) return false
      return true
    })
    .sort((a, b) => {
      const explicitA = order.indexOf(a.descriptor.id)
      const explicitB = order.indexOf(b.descriptor.id)
      if (explicitA >= 0 || explicitB >= 0) {
        // An explicitly ordered provider always precedes an unordered one
        if (explicitA < 0) return 1
        if (explicitB < 0) return -1
        if (explicitA !== explicitB) return explicitA - explicitB
      }

      const strengthA = a.descriptor.strengths.includes(type) ? 0 : 1
      const strengthB = b.descriptor.strengths.includes(type) ? 0 : 1
      if (strengthA !== strengthB) return strengthA - strengthB

      /*
       * Neither plays to its strength: prefer a generalist. Otherwise Wikipedia,
       * being free, would lead a general web search purely on cost — cheap and
       * wrong beats expensive and right only until someone reads the answer.
       */
      const specialistA = strengthA === 1 && a.descriptor.specialist ? 1 : 0
      const specialistB = strengthB === 1 && b.descriptor.specialist ? 1 : 0
      if (specialistA !== specialistB) return specialistA - specialistB

      const costA = COST_RANK[a.descriptor.cost] ?? 9
      const costB = COST_RANK[b.descriptor.cost] ?? 9
      if (costA !== costB) return costA - costB

      return a.descriptor.basePriority - b.descriptor.basePriority
    })

  return candidates.slice(0, limit).map(({ descriptor, config }) => ({
    id: descriptor.id,
    descriptor,
    config,
    adapter: ADAPTERS[descriptor.id],
  }))
}

/** Whether any provider at all can serve a type. */
export function searchAvailableFor(type = SEARCH_TYPE.WEB) {
  return selectProviders({ type, includeUnhealthy: true, limit: 1 }).length > 0
}

/** Search types that at least one configured provider supports. */
export function availableTypes() {
  const types = new Set()
  for (const provider of listProviders()) {
    if (!provider.configured) continue
    for (const type of provider.capabilities.types) types.add(type)
  }
  return [...types]
}

export { DESCRIPTORS, configuredOrder }
