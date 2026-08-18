import { log } from '../config.mjs'
import { createClient } from './openai-compatible.mjs'
import { GatewayError, gatewayError } from './errors.mjs'

import omniroute from './adapters/omniroute.mjs'
import openrouter from './adapters/openrouter.mjs'
import freebuff from './adapters/freebuff.mjs'
import litellm from './adapters/litellm.mjs'
import bifrost from './adapters/bifrost.mjs'
import oneapi from './adapters/oneapi.mjs'
import newapi from './adapters/newapi.mjs'
import higress from './adapters/higress.mjs'
import portkey from './adapters/portkey.mjs'

/* ============================================================
   Gateway registry
   ----------------
   One selected gateway per process, chosen by AI_GATEWAY_PROVIDER
   and defaulting to `omniroute`. The rest of the server talks to
   the returned client and never learns which backend it is.
   ============================================================ */

export const ADAPTERS = Object.freeze({
  omniroute,
  openrouter,
  freebuff,
  litellm,
  bifrost,
  oneapi,
  newapi,
  higress,
  portkey,
})

export const GATEWAY_IDS = Object.keys(ADAPTERS)
export const DEFAULT_GATEWAY = 'omniroute'

/* ---------- env helpers ---------- */

/**
 * Config precedence, highest first:
 *   1. <PROVIDER>_<KEY>   e.g. OMNIROUTE_BASE_URL, LITELLM_BASE_URL
 *   2. AI_GATEWAY_<KEY>   the generic knob
 *   3. the adapter's documented default
 *
 * Putting the provider-specific name first is what keeps existing installs
 * working untouched: OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY / OMNIROUTE_TIMEOUT_MS /
 * OMNIROUTE_HEALTH_PATH / OMNIROUTE_FALLBACK_MODELS are simply instances of
 * pattern 1, so an .env written before multi-gateway support behaves identically.
 */
/**
 * Generic aliases where the documented variable name differs from the
 * `AI_GATEWAY_<KEY>` pattern. `AI_GATEWAY_URL` is the documented spelling; the
 * longer form is accepted too so neither surprises anyone.
 */
const GENERIC_ALIASES = {
  BASE_URL: ['AI_GATEWAY_URL', 'AI_GATEWAY_BASE_URL'],
}

function envFor(providerId, key, fallback) {
  const specific = process.env[`${providerId.toUpperCase()}_${key}`]
  if (specific !== undefined && specific !== '') return specific

  for (const name of GENERIC_ALIASES[key] ?? [`AI_GATEWAY_${key}`]) {
    const generic = process.env[name]
    if (generic !== undefined && generic !== '') return generic
  }
  return fallback
}

function intFrom(value, fallback) {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function listFrom(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const trimSlash = (url) => String(url).replace(/\/+$/, '')

/**
 * Defaults to `pixgpt-vision` only — the alias whose whole purpose is images.
 * Set PIXGPT_VISION_ALIASES (or <PROVIDER>_VISION_ALIASES) to widen it, e.g.
 * "pixgpt-vision,pixgpt-pro" once PIXGPT_MODEL_PRO points at a vision model.
 */
function visionAliasSet(providerId) {
  const raw =
    process.env[`${providerId.toUpperCase()}_VISION_ALIASES`] ??
    process.env.PIXGPT_VISION_ALIASES ??
    'pixgpt-vision'
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function modelAlias(providerId, slot, fallback) {
  return (
    process.env[`${providerId.toUpperCase()}_MODEL_${slot}`] ||
    process.env[`PIXGPT_MODEL_${slot}`] ||
    fallback
  )
}

/* ---------- selection ---------- */

export function selectedGatewayId() {
  const raw = (process.env.AI_GATEWAY_PROVIDER ?? DEFAULT_GATEWAY).trim().toLowerCase()
  if (!raw) return DEFAULT_GATEWAY
  if (!(raw in ADAPTERS)) {
    log.error('unknown AI_GATEWAY_PROVIDER — falling back to the default', {
      requested: raw,
      supported: GATEWAY_IDS.join(','),
      using: DEFAULT_GATEWAY,
    })
    return DEFAULT_GATEWAY
  }
  return raw
}

/**
 * Resolves the full configuration for a gateway. Model aliases keep PixGPT's
 * branded ids (`pixgpt-fast|pro|vision`) working across every backend: each
 * alias maps to whatever model that gateway understands.
 */
export function resolveConfig(providerId) {
  const adapter = ADAPTERS[providerId]
  const defaultModel = envFor(providerId, 'DEFAULT_MODEL', adapter.defaultModel)

  const healthRaw = envFor(providerId, 'HEALTH_PATH', adapter.defaultHealthPath)
  // An explicit empty string means "no health route"
  const healthPath = healthRaw === '' || healthRaw === 'none' ? null : (healthRaw ?? null)

  return {
    provider: providerId,
    baseUrl: trimSlash(envFor(providerId, 'BASE_URL', adapter.defaultBaseUrl)),
    apiKey: envFor(providerId, 'API_KEY', '') ?? '',
    /**
     * Three distinct timeouts, all configurable:
     *  - connectTimeoutMs: time allowed to get response headers back. Catches a
     *    dead host or a gateway that accepts the socket and then goes silent.
     *  - timeoutMs: idle timeout. Resets on every streamed chunk, so a slow but
     *    live stream survives while a stalled one fails fast.
     *  - maxStreamMs: absolute ceiling for one response, so a trickling
     *    provider cannot hold a connection open indefinitely.
     */
    connectTimeoutMs: intFrom(envFor(providerId, 'CONNECT_TIMEOUT_MS', undefined), 15_000),
    timeoutMs: intFrom(envFor(providerId, 'TIMEOUT_MS', undefined), 60_000),
    maxStreamMs: intFrom(envFor(providerId, 'MAX_STREAM_MS', undefined), 300_000),
    /*
     * Output ceiling applied when the client sends no max_tokens. Providers
     * that get no ceiling apply their own default, which is often small enough
     * to cut a long answer mid-sentence (finish_reason "length"). Naming a
     * generous default lets a model finish what it started; a provider with a
     * lower cap of its own clamps silently.
     */
    defaultMaxTokens: intFrom(envFor(providerId, 'DEFAULT_MAX_TOKENS', undefined), 8192),
    healthPath,
    defaultModel,
    defaultAlias: 'pixgpt-pro',
    /**
     * `<PROVIDER>_MODEL_PRO` beats the gateway-agnostic `PIXGPT_MODEL_PRO`,
     * which beats the gateway's default model. Per-gateway overrides matter
     * because a model name is rarely portable — `auto` means something to
     * OmniRoute and nothing to LiteLLM or Higress.
     */
    modelAliases: {
      'pixgpt-fast': modelAlias(providerId, 'FAST', defaultModel),
      'pixgpt-pro': modelAlias(providerId, 'PRO', defaultModel),
      'pixgpt-vision': modelAlias(providerId, 'VISION', defaultModel),
    },
    /**
     * Which aliases may carry images. A gateway declaring `vision: true` says
     * only that *some* model behind it can see — it does not make every model
     * multimodal. This is the model-level answer, and it is configuration
     * rather than a guess, because only the operator knows what
     * PIXGPT_MODEL_FAST actually points at.
     */
    visionAliases: visionAliasSet(providerId),
    fallbackModels: listFrom(envFor(providerId, 'FALLBACK_MODELS', '')),
    /**
     * Fallbacks used only when the request carries images.
     *
     * The ordinary chain is unsafe here: falling back from a vision model to a
     * text-only one turns "describe this image" into a request the route cannot
     * satisfy. Observed live — `auto/best-vision` hit a provider 429 and the
     * generic `auto` fallback then rejected the image. Defaults to empty, so
     * with nothing configured a vision request simply fails rather than being
     * silently downgraded.
     */
    visionFallbackModels: listFrom(envFor(providerId, 'VISION_FALLBACK_MODELS', '')),
  }
}

/* ---------- routing hooks ---------- */

/*
 * The model registry plugs in here rather than replacing the client's own
 * logic. Both hooks are optional and both default to null, so a gateway with no
 * catalogue, a failed discovery, or a process where `server/models` was never
 * imported behaves exactly as it did before intelligent routing existed.
 */

/** @type {((requested: string|undefined, context: object) => {chain: string[], meta?: object}|null)|null} */
let chainResolver = null
/** @type {((model: string, outcome: {ok: boolean, ms?: number, error?: Error, via?: string}) => void)|null} */
let outcomeReporter = null

export function setChainResolver(fn) {
  chainResolver = typeof fn === 'function' ? fn : null
}

export function setOutcomeReporter(fn) {
  outcomeReporter = typeof fn === 'function' ? fn : null
}

/**
 * Tells the transport which gateway owns a model.
 *
 * Installed by the model registry. Without it every client assumes it serves
 * every model in its chain, which is true only while one gateway is configured.
 */
/** @type {((model: string) => string|null)|null} */
let modelGatewayResolver = null

export function setModelGatewayResolver(fn) {
  modelGatewayResolver = typeof fn === 'function' ? fn : null
}

/**
 * Per-model connect budget, answered from measured latency.
 *
 * Optional: with no resolver installed every route gets the configured
 * timeout, exactly as before.
 */
/** @type {((model: string, ceiling: number) => number)|null} */
let timeoutResolver = null

export function setTimeoutResolver(fn) {
  timeoutResolver = typeof fn === 'function' ? fn : null
}

/** The client that should serve `model`, or null when the caller's own will do. */
function clientForModel(model) {
  const owner = modelGatewayResolver?.(model)
  if (!owner) return null
  const entry = getGatewayById(owner)
  return entry?.client ?? null
}

/**
 * Whether transport-level outcomes are already being recorded.
 *
 * Callers that also want to record health need this: with the hook installed
 * the client reports every attempt itself, and a second record from the caller
 * counts one request as two.
 */
export function hasOutcomeReporter() {
  return outcomeReporter !== null
}

export function clearRoutingHooks() {
  chainResolver = null
  outcomeReporter = null
  modelGatewayResolver = null
  timeoutResolver = null
}

/* ---------- the active gateway ---------- */

let active = null

export function getGateway() {
  if (active) return active

  const id = selectedGatewayId()
  const adapter = ADAPTERS[id]
  const config = resolveConfig(id)

  const problems = adapter.validate?.(config) ?? []
  if (problems.length > 0) {
    // Not fatal: the server still starts and reports the problem through
    // /api/ai/health, rather than refusing to boot.
    log.error('gateway configuration incomplete', { gateway: id, problems: problems.join('; ') })
  }

  const client = createClient(adapter, config, log, {
    // Read through a closure so a hook installed after the client was built
    // still applies — the registry is wired up well after the first getGateway()
    resolveChain: (requested, context) => chainResolver?.(requested, context) ?? null,
    reportOutcome: (model, outcome) => outcomeReporter?.(model, outcome),
    clientFor: clientForModel,
    timeoutFor: (model, ceiling) => timeoutResolver?.(model, ceiling) ?? ceiling,
  })
  active = { id, adapter, config, client, configProblems: problems }
  return active
}

/* ---------- several gateways at once ---------- */

/*
 * One gateway is *selected* — it supplies the defaults and answers
 * /api/ai/health — but every gateway that is configured can serve a request.
 *
 * That distinction is what lets a single ranking span OmniRoute and OpenRouter:
 * the registry discovers from all of them, tags each model with the gateway
 * that owns it, and the chain executes each candidate against its own client.
 * Without it, adding OpenRouter would have meant either a second model system
 * or making the user pick a gateway before asking a question.
 */

/** @type {Map<string, object>} */
const CLIENTS = new Map()

/**
 * Whether a gateway is one the operator actually intends to use.
 *
 * Deliberately stricter than "has a default base URL". Every adapter ships a
 * default — `litellm` points at localhost:4000 whether or not anything is
 * listening there — so accepting defaults alone put five dead local gateways
 * into the registry, each contributing routes that could only ever fail.
 *
 * Opting in means one of three things:
 *   · it is the selected gateway (AI_GATEWAY_PROVIDER, default omniroute)
 *   · a key is set for it
 *   · a base URL is set for it explicitly
 *
 * and, on top of that, its own validate() must pass — a keyed gateway with no
 * key is unusable, not merely unhealthy.
 */
export function gatewayConfigured(id) {
  const adapter = ADAPTERS[id]
  if (!adapter) return false

  const prefix = id.toUpperCase()
  const optedIn =
    id === selectedGatewayId() ||
    Boolean(process.env[`${prefix}_API_KEY`]) ||
    Boolean(process.env[`${prefix}_BASE_URL`])
  if (!optedIn) return false

  const config = resolveConfig(id)
  if (!config.baseUrl) return false
  return (adapter.validate?.(config) ?? []).length === 0
}

/** Every gateway that could serve a request right now. */
export function configuredGateways() {
  return GATEWAY_IDS.filter(gatewayConfigured)
}

/**
 * A ready client for one gateway, built on demand and cached.
 *
 * Shares the routing hooks with the selected gateway, so a request served by
 * OpenRouter reports its outcome to the same registry as one served by
 * OmniRoute.
 */
export function getGatewayById(id) {
  if (!(id in ADAPTERS)) return null
  const cached = CLIENTS.get(id)
  if (cached) return cached

  const adapter = ADAPTERS[id]
  const config = resolveConfig(id)
  const client = createClient(adapter, config, log, {
    resolveChain: (requested, context) => chainResolver?.(requested, context) ?? null,
    reportOutcome: (model, outcome) => outcomeReporter?.(model, outcome),
    clientFor: clientForModel,
    timeoutFor: (model, ceiling) => timeoutResolver?.(model, ceiling) ?? ceiling,
  })
  const entry = { id, adapter, config, client, configProblems: adapter.validate?.(config) ?? [] }
  CLIENTS.set(id, entry)
  return entry
}

/** Safe to return over HTTP: configuration state, never a key. */
export function describeGateways() {
  return GATEWAY_IDS.map((id) => {
    const adapter = ADAPTERS[id]
    const config = resolveConfig(id)
    return {
      id,
      label: adapter.label,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ? 'set' : 'not set',
      configured: gatewayConfigured(id),
      selected: id === selectedGatewayId(),
      capabilities: adapter.capabilities,
      problems: adapter.validate?.(config) ?? [],
      notes: adapter.notes ?? null,
    }
  })
}

/** Test seam — lets a test switch gateways without spawning a new process. */
export function resetGateway() {
  active = null
  CLIENTS.clear()
}

/**
 * Whether images may be attached for `requestedModel`.
 *
 * Aliases are governed by `visionAliases`. A concrete model id typed by the
 * operator is trusted — they chose it deliberately, and the gateway will reject
 * it if it cannot see. The gateway itself must declare vision either way.
 */
export function modelSupportsVision(requestedModel) {
  const { adapter, config } = getGateway()
  if (!adapter.capabilities.vision) return false
  const model = requestedModel || config.defaultAlias
  if (model in config.modelAliases) return config.visionAliases.includes(model)
  return true
}

/** Per-alias capabilities, for the model selector. */
export function aliasCapabilities() {
  const { adapter, config } = getGateway()
  const out = {}
  for (const alias of Object.keys(config.modelAliases)) {
    out[alias] = { vision: adapter.capabilities.vision && config.visionAliases.includes(alias) }
  }
  return out
}

/** Safe to log and to return over HTTP: never includes the key. */
export function describeGateway() {
  const { id, adapter, config, configProblems } = getGateway()
  return {
    gateway: id,
    label: adapter.label,
    license: adapter.license,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ? 'set' : 'not set',
    defaultModel: config.defaultModel,
    timeoutMs: config.timeoutMs,
    capabilities: adapter.capabilities,
    fallbackModels: config.fallbackModels,
    aliases: config.modelAliases,
    visionAliases: config.visionAliases,
    configProblems,
  }
}

export { GatewayError, gatewayError }
