import { log } from '../config.mjs'
import { getGatewayById, gatewayConfigured } from '../gateway/index.mjs'
import { EVIDENCE } from './catalog.mjs'

/* ============================================================
   Provider-supplied model metadata
   --------------------------------
   PixGPT infers what it can from a model id — `-500k` means a
   500k window, `mini` means fast — because OmniRoute's catalogue
   is a bare list of strings and inference is all there is.

   Some providers publish the real thing. OpenRouter's `/models`
   returns `context_length`, `supported_parameters` and
   `input_modalities` for every model, needs no credentials, and is
   authoritative. Where that exists, guessing stops.

   This matters more than it sounds. `input_modalities: ["text",
   "image"]` is a *provider statement* that a model accepts images —
   still not a probe, but evidence from the party that would know,
   and vastly better than matching `/vision/` against a name.

   Two other fields come from Freebuff's model cards and have no
   equivalent anywhere else PixGPT talks to:

     dataUse       whether prompts train the provider's models
     supersededBy  a newer model the provider recommends instead

   Both are recorded only where a provider actually states them.
   Neither is inferred.
   ============================================================ */

/** Normalised data-use values. Anything a provider does not state is `unknown`. */
export const DATA_USE = Object.freeze({
  TRAINING: 'training',
  SERVICE_ONLY: 'service-only',
  UNKNOWN: 'unknown',
})

/** Reasoning-effort ladder, as published by the providers that support it. */
export const EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/* ---------- OpenRouter ---------- */

/**
 * Fetches OpenRouter's catalogue.
 *
 * Public — no key. So this runs even when nothing is configured, which is why
 * the metadata is useful before the gateway itself is usable.
 */
export async function fetchOpenRouterMetadata({ signal, baseUrl = 'https://openrouter.ai/api/v1' } = {}) {
  const response = await fetch(`${baseUrl}/models`, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`OpenRouter models responded ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body?.data) ? body.data : []

  const out = new Map()
  for (const row of rows) {
    if (typeof row?.id !== 'string') continue
    const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : []
    const inputs = Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities : []

    /*
     * Pricing is a string of dollars-per-token. Zero across the board is how
     * OpenRouter marks a free model, and it is more reliable than the `:free`
     * suffix, which not every free model carries.
     */
    const prompt = Number.parseFloat(row.pricing?.prompt ?? 'NaN')
    const completion = Number.parseFloat(row.pricing?.completion ?? 'NaN')
    const priced = Number.isFinite(prompt) && Number.isFinite(completion)
    const free = priced && prompt === 0 && completion === 0

    out.set(row.id, {
      displayName: typeof row.name === 'string' ? row.name : null,
      context: Number.isFinite(row.context_length) ? row.context_length : null,
      tools: params.includes('tools'),
      vision: inputs.includes('image'),
      /** Only where the provider says so — `reasoning` in supported_parameters. */
      reasoning: params.includes('reasoning') || params.includes('reasoning_effort'),
      structured: params.includes('response_format') || params.includes('structured_outputs'),
      free,
      pricePerMillionInput: priced ? Math.round(prompt * 1_000_000 * 1000) / 1000 : null,
      pricePerMillionOutput: priced ? Math.round(completion * 1_000_000 * 1000) / 1000 : null,
      source: 'openrouter',
    })
  }
  return out
}

/* ---------- Freebuff's model cards ---------- */

/**
 * The metadata Freebuff publishes that no OpenAI-compatible catalogue carries.
 *
 * Transcribed from the shipped application's own model cards
 * (`common/src/constants/freebuff-models.ts`). Keyed by the OpenRouter id the
 * card points at, because that is the id PixGPT will actually route to.
 *
 * Only fields the cards state. Nothing here is inferred, and a model absent
 * from this table simply has no data-use statement — which is reported as
 * `unknown`, never as safe.
 */
export const FREEBUFF_MODEL_CARDS = Object.freeze({
  'deepseek/deepseek-v4-pro': {
    displayName: 'DeepSeek V4 Pro',
    tagline: 'Smartest',
    dataUse: DATA_USE.TRAINING,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    context: 1_048_576,
  },
  'deepseek/deepseek-v4-flash': {
    displayName: 'DeepSeek V4 Flash',
    tagline: 'Fast',
    dataUse: DATA_USE.TRAINING,
    efforts: ['low', 'high', 'max'],
    context: 1_048_576,
  },
  'openai/gpt-5.6-luna': {
    displayName: 'GPT-5.6 Luna',
    dataUse: DATA_USE.SERVICE_ONLY,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    context: 1_000_000,
  },
  'minimax/minimax-m3': { displayName: 'MiniMax M3', dataUse: DATA_USE.SERVICE_ONLY, context: 524_288 },
  'z-ai/glm-5.2': { displayName: 'GLM 5.2', dataUse: DATA_USE.SERVICE_ONLY },
  'anthropic/claude-fable-5': { displayName: 'Claude Fable 5', dataUse: DATA_USE.SERVICE_ONLY },
  'moonshotai/kimi-k2.6': { displayName: 'Kimi K2.6', dataUse: DATA_USE.SERVICE_ONLY },
  /*
   * A superseding pointer. Freebuff shows it as "DeepSeek V4 Flash 07/31
   * performs better for most tasks" with a switch action; PixGPT uses it as a
   * ranking penalty so an obsolete model stops being *recommended* while
   * staying available for anyone who asks for it by name.
   */
  'xiaomi/mimo-v2.5': {
    displayName: 'MiMo 2.5',
    dataUse: DATA_USE.SERVICE_ONLY,
    supersededBy: { modelId: 'deepseek/deepseek-v4-flash', notice: 'DeepSeek V4 Flash performs better for most tasks.' },
  },
})

/* ---------- application ---------- */

/**
 * Merges provider metadata onto registry records.
 *
 * Provider statements are recorded at `GATEWAY` strength — above an id guess,
 * below a probe. A provider saying a model takes images makes it a strong
 * vision *candidate*; only a probe makes it a verified vision route, and
 * section 13's rule that vision must be probe-verified is unaffected.
 *
 * @returns {{ enriched: number, contextFixed: number, visionFound: number, toolsFound: number }}
 */
export function applyProviderMetadata(models, metadata) {
  let enriched = 0
  let contextFixed = 0
  let visionFound = 0
  let toolsFound = 0

  for (const model of models) {
    const meta = metadata.get(model.id)
    const card = FREEBUFF_MODEL_CARDS[model.id]
    if (!meta && !card) continue
    enriched++

    if (meta) {
      if (meta.context && meta.context !== model.context) {
        model.context = meta.context
        model.contextSource = EVIDENCE.GATEWAY
        contextFixed++
      }
      // Never downgrade a probe result
      if (model.capabilities.vision?.source !== EVIDENCE.PROBE) {
        model.capabilities.vision = { value: meta.vision, source: EVIDENCE.GATEWAY }
        if (meta.vision) visionFound++
      }
      if (model.capabilities.tools?.source !== EVIDENCE.PROBE) {
        model.capabilities.tools = { value: meta.tools, source: EVIDENCE.GATEWAY }
        if (meta.tools) toolsFound++
      }
      if (model.capabilities.structured?.source !== EVIDENCE.PROBE) {
        model.capabilities.structured = { value: meta.structured, source: EVIDENCE.GATEWAY }
      }
      if (meta.displayName) model.displayName = meta.displayName
      if (meta.free !== undefined) model.free = meta.free
      if (meta.pricePerMillionInput !== null) {
        model.price = { input: meta.pricePerMillionInput, output: meta.pricePerMillionOutput }
      }
      if (meta.reasoning) model.reasoning = { supported: true, source: EVIDENCE.GATEWAY }
    }

    if (card) {
      if (card.context && !meta?.context) {
        model.context = card.context
        model.contextSource = EVIDENCE.DOC
        contextFixed++
      }
      if (card.displayName) model.displayName = card.displayName
      if (card.tagline) model.tagline = card.tagline
      if (card.dataUse) model.dataUse = card.dataUse
      if (card.efforts) {
        model.reasoning = {
          supported: true,
          efforts: card.efforts.filter((e) => EFFORTS.includes(e)),
          defaultEffort: card.defaultEffort ?? null,
          source: EVIDENCE.DOC,
        }
      }
      if (card.supersededBy) model.supersededBy = card.supersededBy
    }

    if (!model.dataUse) model.dataUse = DATA_USE.UNKNOWN
  }

  return { enriched, contextFixed, visionFound, toolsFound }
}

/**
 * Collects metadata from every configured provider that publishes it.
 *
 * Best-effort throughout: a provider that will not answer costs its own
 * metadata and nothing else. Discovery must never fail because an optional
 * enrichment step did.
 */
export async function collectProviderMetadata({ signal } = {}) {
  const metadata = new Map()
  const sources = []

  /*
   * OpenRouter's catalogue is fetched whether or not the gateway is configured:
   * it is public, and its context windows and modality flags are correct for
   * the same model ids served through Freebuff or any other proxy in front of
   * it. Being unable to *call* a model is no reason to know less about it.
   */
  try {
    const entry = getGatewayById('openrouter')
    const rows = await fetchOpenRouterMetadata({ signal, baseUrl: entry?.config?.baseUrl })
    for (const [id, meta] of rows) metadata.set(id, meta)
    sources.push({ provider: 'openrouter', models: rows.size, configured: gatewayConfigured('openrouter') })
    log.info('provider metadata collected', { provider: 'openrouter', models: rows.size })
  } catch (error) {
    log.warn('openrouter metadata unavailable', { detail: error?.message })
    sources.push({ provider: 'openrouter', models: 0, error: error?.message ?? 'unavailable' })
  }

  return { metadata, sources }
}
