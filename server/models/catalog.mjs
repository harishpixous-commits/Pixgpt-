/* ============================================================
   Catalogue normalisation
   -----------------------
   Turns the flat list of ids that `GET /models` returns into
   structured records the rest of PixGPT can reason about.

   The governing rule is section 32 of the specification and it is
   easy to get wrong: **a model id is not evidence**. `auto/best-coding`
   is a routing hint the operator of the gateway chose; it says nothing
   about whether that route answers, how fast, or how well.

   So every field here carries where it came from:

     gateway   — the gateway told us (adapter capabilities, catalogue)
     id        — parsed out of the model id itself, a *hint* only
     config    — the operator set it in .env
     probe     — a real request proved it
     doc       — published provider documentation (supporting evidence)

   Nothing is asserted without a source, and `probe` outranks everything
   else. A capability whose only source is `id` is never treated as
   verified — it is a candidate for verification.
   ============================================================ */

/** Where a piece of metadata came from, weakest first. */
export const EVIDENCE = Object.freeze({
  ID: 'id',
  DOC: 'doc',
  GATEWAY: 'gateway',
  CONFIG: 'config',
  PROBE: 'probe',
})

const EVIDENCE_RANK = { id: 1, doc: 2, gateway: 3, config: 4, probe: 5 }

/** True when `next` is at least as trustworthy as `current`. */
export function outranks(next, current) {
  return (EVIDENCE_RANK[next] ?? 0) >= (EVIDENCE_RANK[current] ?? 0)
}

/* ---------- categories ---------- */

export const CATEGORY = Object.freeze({
  GENERAL_CHAT: 'GENERAL_CHAT',
  FAST: 'FAST',
  CODING: 'CODING',
  REASONING: 'REASONING',
  VISION: 'VISION',
  MULTIMODAL: 'MULTIMODAL',
  LONG_CONTEXT: 'LONG_CONTEXT',
  TOOL_AGENT: 'TOOL_AGENT',
  RESEARCH: 'RESEARCH',
  CHEAP: 'CHEAP',
  FREE: 'FREE',
  IMAGE_GENERATION: 'IMAGE_GENERATION',
  VIDEO_GENERATION: 'VIDEO_GENERATION',
  SPECIALIZED: 'SPECIALIZED',
})

export const CATEGORY_IDS = Object.values(CATEGORY)

export const CATEGORY_LABELS = Object.freeze({
  GENERAL_CHAT: 'General chat',
  FAST: 'Fast',
  CODING: 'Coding',
  REASONING: 'Reasoning',
  VISION: 'Vision',
  MULTIMODAL: 'Multimodal',
  LONG_CONTEXT: 'Long context',
  TOOL_AGENT: 'Tool agent',
  RESEARCH: 'Research',
  CHEAP: 'Cheap',
  FREE: 'Free',
  IMAGE_GENERATION: 'Image generation',
  VIDEO_GENERATION: 'Video generation',
  SPECIALIZED: 'Specialised',
})

/* ---------- verification state (section 2) ---------- */

export const VERIFICATION = Object.freeze({
  /** In the catalogue and nothing more. The default for all 121. */
  CATALOGUED: 'CATALOGUED',
  /** Verified only against a stub — used by tests, never by the live server. */
  MOCK_VERIFIED: 'MOCK_VERIFIED',
  /** A real request returned usable content. */
  LIVE_VERIFIED: 'LIVE_VERIFIED',
  /** Verified once, failing now. */
  UNHEALTHY: 'UNHEALTHY',
  RATE_LIMITED: 'RATE_LIMITED',
  /** The gateway says it does not exist, or it has failed every attempt. */
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
})

/* ---------- providers ---------- */

/**
 * Prefix → provider pool. These are the pools this gateway actually exposes;
 * an unknown prefix is preserved verbatim rather than guessed at.
 */
const POOLS = {
  auto: { label: 'OmniRoute auto-routing', routing: true },
  aug: { label: 'Augment' },
  tllm: { label: 'TypingMind pool' },
  ddgw: { label: 'DuckDuckGo gateway' },
  oc: { label: 'OpenClaude free tier' },
  felo: { label: 'Felo' },
  pepper: { label: 'Pepper' },
  mcode: { label: 'MCode' },
  'veo-free': { label: 'Veo (free)' },
  'veoaifree-web': { label: 'Veo (web)' },
}

/**
 * Model families, matched against the *remainder* of the id.
 *
 * Family is used for two things only: grouping in the UI, and looking up the
 * published documentation in `doc-evidence.mjs`. It never by itself grants a
 * capability.
 */
const FAMILIES = [
  /*
   * Anthropic models are named after the tier as often as after the family:
   * `aug/opus4.8`, `aug/sonnet4.6` and `aug/haiku4.5` contain no "claude" at
   * all. Matching only on "claude" filed the entire Augment line as `other`,
   * which cost them their documentation evidence and made the ensemble's
   * different-family check treat them as independent from real Claude routes.
   */
  [/(^|[/_-])claude|^CLAUDE/i, 'claude'],
  // No trailing \b: the version follows immediately in `opus4.8`, and `\b`
  // does not fire between "s" and "4". The leading separator is enough to keep
  // this from matching inside an unrelated word.
  [/(?:^|[-_/.\s])(opus|sonnet|haiku|fable)/i, 'claude'],
  [/(^|[/_-])(gpt|openrouter_gpt)/i, 'gpt'],
  [/(^|[/_-])o[34](_|-)?mini/i, 'gpt'],
  [/gemini/i, 'gemini'],
  [/gemma/i, 'gemma'],
  [/llama/i, 'llama'],
  [/deepseek/i, 'deepseek'],
  [/kimi/i, 'kimi'],
  [/\bglm\b|glm-/i, 'glm'],
  [/minimax/i, 'minimax'],
  [/mimo/i, 'mimo'],
  [/mistral/i, 'mistral'],
  [/grok/i, 'grok'],
  [/nemotron/i, 'nemotron'],
  [/qwen/i, 'qwen'],
  [/sonar|perplexity/i, 'perplexity'],
  [/\bveo\b|seedance/i, 'video'],
  [/felo/i, 'felo'],
  [/prism/i, 'prism'],
  [/fable/i, 'claude'],
  [/tinfoil/i, 'tinfoil'],
]

function familyOf(rest) {
  for (const [pattern, name] of FAMILIES) if (pattern.test(rest)) return name
  return 'other'
}

/* ---------- display names ---------- */

const ACRONYMS = new Set(['gpt', 'glm', 'ai', 'oss', 'api', 'hy', 'k2', 'v2', 'v3', 'v4'])

/**
 * `tllm/CLAUDE_4_6_OPUS` → `Claude 4.6 Opus`, `aug/gpt5.6-luna` → `GPT 5.6 Luna`.
 *
 * Purely cosmetic. A parse failure produces a slightly ugly label, never a wrong
 * capability, which is why this is allowed to be heuristic at all.
 */
export function displayNameFor(rest) {
  const cleaned = rest
    .replace(/^openrouter_/i, '')
    .replace(/^together_/i, '')
    // 4_6 → 4.6, 5_4 → 5.4 (version separators), but GPT_5 → GPT 5
    .replace(/(\d)_(\d)/g, '$1.$2')
    .replace(/[_]+/g, ' ')
    .replace(/-free$/i, ' (free)')
    .replace(/-/g, ' ')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned
    .split(' ')
    .map((word) => {
      const bare = word.replace(/[^a-z0-9.]/gi, '').toLowerCase()
      if (ACRONYMS.has(bare)) return word.toUpperCase()
      if (/^\d/.test(word)) return word
      // Preserve intentional inner capitals; only fix all-caps and all-lower
      if (/^[A-Z]+$/.test(word)) return word[0] + word.slice(1).toLowerCase()
      return word[0].toUpperCase() + word.slice(1)
    })
    .join(' ')
}

/* ---------- id hints ---------- */

/**
 * Category hints read out of the id.
 *
 * Every one of these is a *hint*: it goes into the record tagged `id`, and the
 * ranking system gives it a fraction of the weight a probe result carries.
 */
/**
 * `SMALL` matches the size suffixes that mark a fast/cheap variant.
 *
 * The leading separator class is load-bearing. `mini\b` alone matches the
 * "mini" inside *gemini*, which filed `auto/gemini` and `aug/gemini-3.1-pro`
 * as fast and cheap — the opposite of what those routes are. Underscore is in
 * the class explicitly because `\b` does not fire on it, and `tllm/GPT_o4_mini`
 * is genuinely a mini.
 */
const SMALL = /(?:^|[-_/.\s])(mini|nano|lite|small|tiny)\b/i

const ID_HINTS = [
  [/\bcoding\b|\bcode\b|coder/i, CATEGORY.CODING],
  [/reasoning|\bthink/i, CATEGORY.REASONING],
  [/vision|multimodal/i, CATEGORY.VISION],
  [/\bfast\b|flash|haiku/i, CATEGORY.FAST],
  [SMALL, CATEGORY.FAST],
  [/\bchat\b/i, CATEGORY.GENERAL_CHAT],
  [/\bcheap\b/i, CATEGORY.CHEAP],
  [/\bfree\b/i, CATEGORY.FREE],
  [/search|scholar|research|sonar/i, CATEGORY.RESEARCH],
  [/\bveo\b|seedance|video/i, CATEGORY.VIDEO_GENERATION],
  [/\b(\d+)k\b/i, CATEGORY.LONG_CONTEXT],
]

/** Context windows the id states outright, e.g. `aug/opus4.7-500k`. */
function statedContext(id) {
  const match = /[-/](\d{2,4})k\b/i.exec(id)
  if (!match) return null
  const n = Number.parseInt(match[1], 10)
  return Number.isFinite(n) ? n * 1000 : null
}

/* ---------- cost ---------- */

export const COST = Object.freeze({ FREE: 'free', CHEAP: 'cheap', STANDARD: 'standard', PREMIUM: 'premium' })

/**
 * Cost tier from the id, which is all this gateway gives us — it publishes no
 * pricing. `free` is asserted only where the id says so outright, and even then
 * section 14 requires a probe before a free model is *selected*.
 */
function costFromId(id, pool) {
  if (/\bfree\b/i.test(id)) return COST.FREE
  if (pool === 'oc') return COST.FREE
  if (/\bcheap\b/i.test(id)) return COST.CHEAP
  if (SMALL.test(id) || /flash|haiku/i.test(id)) return COST.CHEAP
  if (/\bpro\b|opus|ultra|premium|-500k/i.test(id)) return COST.PREMIUM
  return COST.STANDARD
}

/* ---------- quality ---------- */

export const TIER = Object.freeze({ S: 'TIER_S', A: 'TIER_A', B: 'TIER_B', C: 'TIER_C', FREE: 'TIER_FREE' })

/* ---------- normalisation ---------- */

/**
 * One catalogue id → one registry record.
 *
 * @param {string} id                raw id from the gateway catalogue
 * @param {object} context
 * @param {object} context.gatewayCapabilities  what the adapter declares
 * @param {object} [context.docEvidence]        published-documentation lookup
 * @returns {object} a registry record, entirely unverified
 */
export function normaliseModel(id, { gatewayCapabilities = {}, docEvidence = null } = {}) {
  const slash = id.indexOf('/')
  const pool = slash === -1 ? '' : id.slice(0, slash)
  const rest = slash === -1 ? id : id.slice(slash + 1)
  const known = POOLS[pool]

  const provider = known ? pool : pool || 'direct'
  const family = familyOf(rest)
  const routing = Boolean(known?.routing)

  const categories = new Set()
  for (const [pattern, category] of ID_HINTS) if (pattern.test(id)) categories.add(category)

  const doc = docEvidence?.[family] ?? null

  /*
   * Capabilities start as *unknown*, not as false. "We have not checked" and
   * "it cannot" are different claims, and conflating them is how a working
   * model gets excluded from ranking forever.
   */
  const capabilities = {
    chat: { value: true, source: EVIDENCE.GATEWAY },
    streaming: { value: gatewayCapabilities.streaming === true, source: EVIDENCE.GATEWAY },
    tools: { value: gatewayCapabilities.tools === true ? null : false, source: EVIDENCE.GATEWAY },
    vision: { value: null, source: null },
    structured: { value: null, source: null },
    longContext: { value: null, source: null },
    imageGeneration: { value: false, source: EVIDENCE.GATEWAY },
    videoGeneration: { value: null, source: null },
  }

  // A vision *hint* is a hint. It makes the model a vision candidate; it does
  // not make it usable for images. Section 13 is explicit about this.
  if (categories.has(CATEGORY.VISION)) capabilities.vision = { value: null, source: EVIDENCE.ID, hinted: true }
  if (categories.has(CATEGORY.VIDEO_GENERATION)) {
    capabilities.videoGeneration = { value: null, source: EVIDENCE.ID, hinted: true }
    capabilities.chat = { value: null, source: EVIDENCE.ID }
  }

  const context = statedContext(id)
  if (context && context >= 200_000) categories.add(CATEGORY.LONG_CONTEXT)
  if (doc?.longContext && !context) categories.add(CATEGORY.LONG_CONTEXT)

  // Documentation is supporting evidence for a family, never proof for a route
  if (doc?.categories) for (const c of doc.categories) categories.add(c)

  if (categories.size === 0) categories.add(CATEGORY.GENERAL_CHAT)
  // Anything that can chat can hold a conversation; routing aliases included
  if (!categories.has(CATEGORY.VIDEO_GENERATION) && !categories.has(CATEGORY.IMAGE_GENERATION)) {
    categories.add(CATEGORY.GENERAL_CHAT)
  }

  const cost = costFromId(id, pool)
  if (cost === COST.FREE) categories.add(CATEGORY.FREE)
  if (cost === COST.FREE || cost === COST.CHEAP) categories.add(CATEGORY.CHEAP)

  return {
    id,
    provider,
    providerLabel: known?.label ?? (pool ? pool : 'Direct'),
    family,
    displayName: displayNameFor(rest),
    routing,
    categories: [...categories],
    capabilities,
    /** Context window in tokens, or null when nothing states it. */
    context: context ?? doc?.context ?? null,
    contextSource: context ? EVIDENCE.ID : doc?.context ? EVIDENCE.DOC : null,
    cost,
    costSource: EVIDENCE.ID,
    free: cost === COST.FREE,
    /**
     * Quality is deliberately null here. It is computed by the ranking module
     * from verification and health, not asserted at parse time (section 7).
     */
    qualityTier: null,
    docNote: doc?.note ?? null,
  }
}

/**
 * Normalises a whole catalogue, dropping duplicates.
 *
 * Duplicate ids are a real possibility — the gateway aggregates several
 * upstreams — and a duplicate would otherwise be ranked twice and could occupy
 * two slots of one fallback chain.
 */
export function normaliseCatalogue(ids, context = {}) {
  const seen = new Set()
  const models = []
  const duplicates = []

  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id) continue
    if (seen.has(id)) {
      duplicates.push(id)
      continue
    }
    seen.add(id)
    models.push(normaliseModel(id, context))
  }

  return { models, duplicates }
}
