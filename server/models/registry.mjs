import { log } from '../config.mjs'
import { configuredGateways, getGateway, getGatewayById } from '../gateway/index.mjs'
import { normaliseCatalogue, normaliseModel, VERIFICATION, EVIDENCE, outranks, CATEGORY } from './catalog.mjs'
import { docEvidenceTable, docEvidenceFor } from './doc-evidence.mjs'
import { healthOf, allHealth, recordSuccess, isTerminalFailure, HEALTH } from './health.mjs'
import { loadSnapshot, scheduleSave, flushSnapshot } from './store.mjs'
import { applyProviderMetadata, collectProviderMetadata } from './provider-metadata.mjs'

/* ============================================================
   The model registry
   ------------------
   Sections 1, 2 and 29. Holds one record per catalogue entry,
   its verification state, and its measured capabilities.

   The registry is the only place that answers "what do we know
   about this model", and it distinguishes three things that are
   easy to blur together:

     the catalogue said it exists   → CATALOGUED
     a request reached it           → LIVE_VERIFIED / UNHEALTHY / …
     we have never asked            → UNKNOWN

   Discovery is cheap and happens on demand. Verification costs a
   real request and never happens implicitly (section 40).
   ============================================================ */

/** How long a discovered catalogue is reused before re-fetching. */
const CATALOGUE_TTL_MS = Number.parseInt(process.env.PIXGPT_MODEL_CATALOGUE_TTL_MS ?? '', 10) || 300_000

/** @type {Map<string, object>} */
const MODELS = new Map()

let state = {
  discoveredAt: 0,
  gateway: null,
  error: null,
  duplicates: [],
  /** Ids the operator named in .env; these are never dropped on refresh. */
  configured: [],
}

/* ---------- discovery (section 1) ---------- */

/**
 * Fetches the catalogue and rebuilds the registry.
 *
 * Existing verification and capability evidence survives a refresh: a model
 * that answered ten minutes ago is still verified when the catalogue is
 * re-read. Only the catalogue-derived fields are replaced.
 *
 * @returns {Promise<{ total: number, added: string[], removed: string[], error: object|null }>}
 */
export async function discover({ signal, force = false } = {}) {
  const now = Date.now()
  if (!force && state.discoveredAt && now - state.discoveredAt < CATALOGUE_TTL_MS) {
    return { total: MODELS.size, added: [], removed: [], cached: true, error: state.error }
  }

  const docs = docEvidenceTable()

  /*
   * Discover from every configured gateway, not just the selected one.
   *
   * The selected gateway still supplies defaults and answers /api/ai/health;
   * this is about which models may *serve*. With OmniRoute and OpenRouter both
   * configured, one ranking spans both and the user never picks a gateway — the
   * alternative was a second model system per gateway, which is exactly what
   * the registry exists to avoid.
   */
  const gateways = configuredGateways()
  const ids = []
  const owner = new Map()
  const configured = []
  let error = null
  const perGateway = {}

  for (const gatewayId of gateways) {
    const entry = getGatewayById(gatewayId)
    if (!entry) continue
    const { adapter, client, config } = entry

    let listed = []
    try {
      listed = adapter.capabilities.models ? await client.listModels(signal) : []
    } catch (e) {
      const failure = { code: e?.code ?? 'provider_error', message: e?.message ?? 'Could not read the model catalogue.' }
      log.warn('model discovery failed', { gateway: gatewayId, code: failure.code })
      // The first failure is reported; one dead gateway must not blank the rest
      error ??= failure
    }

    /*
     * Aliases resolve to concrete ids that a gateway does not always list — a
     * configured fallback can be absent from /models and still work. Adding them
     * keeps a route the operator deliberately chose from being invisible.
     */
    const named = [
      ...Object.values(config.modelAliases ?? {}),
      ...(config.fallbackModels ?? []),
      ...(config.visionFallbackModels ?? []),
    ].filter(Boolean)

    perGateway[gatewayId] = { listed: listed.length, capabilities: adapter.capabilities }

    for (const id of [...listed, ...named]) {
      /*
       * First gateway to claim an id owns it. Order follows configuredGateways(),
       * which puts the selected gateway first — so a model both gateways serve
       * stays on the one the operator chose, and the duplicate is dropped rather
       * than ranked twice under two owners.
       */
      if (!owner.has(id)) owner.set(id, gatewayId)
      ids.push(id)
    }
    configured.push(...named)
  }

  const { models, duplicates } = normaliseCatalogue(ids, {
    gatewayCapabilities: getGatewayById(gateways[0])?.adapter?.capabilities ?? {},
    docEvidence: docs,
  })

  /*
   * Provider-published metadata, before the records are stored.
   *
   * This is where guessing stops: OpenRouter states context windows, tool
   * support and image input for 400+ models, and its ids are the ones Freebuff
   * and similar proxies use. Best-effort — if it cannot be fetched, the
   * id-derived values stand exactly as they did before.
   */
  let metadataReport = null
  try {
    const { metadata, sources } = await collectProviderMetadata({ signal })
    if (metadata.size > 0) {
      metadataReport = { ...applyProviderMetadata(models, metadata), sources }
      log.info('provider metadata applied', metadataReport)
    }
  } catch (e) {
    log.warn('provider metadata step skipped', { detail: e?.message })
  }

  // Each model carries the capabilities of the gateway that will actually serve it
  for (const model of models) {
    const gatewayId = owner.get(model.id)
    model.gateway = gatewayId ?? null
    const caps = getGatewayById(gatewayId)?.adapter?.capabilities
    if (caps) {
      model.capabilities.streaming = { value: caps.streaming === true, source: EVIDENCE.GATEWAY }
      /*
       * A gateway that cannot do tools or vision at all overrides any
       * per-model claim: the request would fail at the transport regardless of
       * what the model supports. The reverse is not true — a gateway
       * supporting vision does not make every model behind it multimodal.
       */
      if (caps.tools !== true) model.capabilities.tools = { value: false, source: EVIDENCE.GATEWAY }
      if (caps.vision !== true) model.capabilities.vision = { value: false, source: EVIDENCE.GATEWAY }
    }
  }

  /*
   * `inCatalogue` tracks the *gateway's* list, not this set. A configured
   * fallback the gateway does not advertise still gets a record — it may well
   * work — but it must not claim the catalogue vouches for it, or the ranking
   * penalty for a vanished model could never fire.
   */
  const catalogued = new Set(ids)
  const seen = new Set(models.map((m) => m.id))
  const previous = new Set(MODELS.keys())
  const added = models.filter((m) => !previous.has(m.id)).map((m) => m.id)
  const removed = [...previous].filter((id) => !seen.has(id))

  for (const fresh of models) {
    const existing = MODELS.get(fresh.id)
    const record = existing ? mergeRecord(existing, fresh) : initRecord(fresh, configured.includes(fresh.id))
    record.inCatalogue = catalogued.has(fresh.id)
    MODELS.set(fresh.id, record)
  }

  /*
   * A model that vanished from the catalogue is marked UNAVAILABLE rather than
   * deleted. Gateways drop and restore upstreams constantly, and forgetting
   * everything we measured each time is how the registry would never learn.
   */
  for (const id of removed) {
    const record = MODELS.get(id)
    if (record) {
      record.inCatalogue = false
      if (record.verification !== VERIFICATION.LIVE_VERIFIED) record.verification = VERIFICATION.UNAVAILABLE
    }
  }

  restoreMemory()

  state = { discoveredAt: now, gateway: getGateway().id, gateways, perGateway, metadata: metadataReport, error, duplicates, configured }
  log.info('model catalogue discovered', {
    gateways: gateways.join(','),
    total: MODELS.size,
    added: added.length || undefined,
    removed: removed.length || undefined,
    duplicates: duplicates.length || undefined,
  })

  return { total: MODELS.size, added, removed, duplicates, error, cached: false }
}

/*
 * Re-applies what previous sessions learned. Runs once per process: after the
 * first discovery the live state is more current than anything on disk.
 */
let memoryRestored = false

function restoreMemory() {
  if (memoryRestored) return
  memoryRestored = true

  const snapshot = loadSnapshot()
  let restored = 0

  for (const [id, entry] of Object.entries(snapshot)) {
    const record = MODELS.get(id)
    if (!record) continue

    if (entry.capabilities) applyCapabilities(record, entry.capabilities, EVIDENCE.PROBE)

    if (entry.verified) {
      record.verification = VERIFICATION.LIVE_VERIFIED
      record.lastVerified = entry.lastVerified
      record.verifiedBy = entry.verifiedBy
      /*
       * The latency is seeded as one observation so ranking has something to
       * work with, but no cooldown and no failure history are restored: the
       * route gets a completely clean chance to prove itself this session.
       */
      if (Number.isFinite(entry.latencyMs)) recordSuccess(id, { latencyMs: entry.latencyMs })
      restored++
    }

    /*
     * A remembered failure is a penalty, not an exclusion. The route stays in
     * every chain and can clear the flag by answering once — a gateway whose
     * missing binary was installed this morning must be able to come back.
     */
    if (entry.priorFailure) {
      record.priorFailure = entry.priorFailure
      record.priorFailureAt = entry.lastFailure
      /*
       * A remembered *fatal* failure is a configuration fact — missing
       * credentials, a missing binary, an exhausted quota — and those do not
       * fix themselves between one request and the next. Weighted the same as a
       * transient blip, whole dead pools kept winning chain slots in a fresh
       * process on the strength of their names.
       */
      record.priorFailureFatal = isTerminalFailure(entry.priorFailure)
      restored++
    }
  }

  if (restored > 0) log.info('model memory restored', { entries: restored })
}

/** Persist what has been learned. Debounced; see store.mjs. */
export function persist({ immediate = false } = {}) {
  return immediate ? flushSnapshot(allModels) : scheduleSave(allModels)
}

function initRecord(model, isConfigured) {
  return {
    ...model,
    inCatalogue: true,
    configured: isConfigured,
    /** Nothing is verified until a request proves it (section 2). */
    verification: VERIFICATION.CATALOGUED,
    lastVerified: null,
    verifiedBy: null,
    /** Capabilities a probe actually confirmed, keyed the same as `capabilities`. */
    probe: null,
    benchmarks: {},
  }
}

/** Refresh keeps everything learned; only catalogue-derived fields are replaced. */
function mergeRecord(existing, fresh) {
  const capabilities = { ...fresh.capabilities }
  // Probe evidence outranks anything the catalogue can say
  for (const [key, current] of Object.entries(existing.capabilities ?? {})) {
    if (current?.source && !outranks(capabilities[key]?.source, current.source)) {
      capabilities[key] = current
    }
  }
  return {
    ...existing,
    ...fresh,
    capabilities,
    inCatalogue: true,
    configured: existing.configured,
    verification: existing.verification,
    lastVerified: existing.lastVerified,
    verifiedBy: existing.verifiedBy,
    probe: existing.probe,
    benchmarks: existing.benchmarks,
  }
}

/* ---------- reading ---------- */

export function has(id) {
  return MODELS.has(id)
}

export function getModel(id) {
  const record = MODELS.get(id)
  return record ? decorate(record) : null
}

export function allModels() {
  return [...MODELS.values()].map(decorate)
}

/** Registry size and freshness, for status endpoints. */
export function registryState() {
  return {
    total: MODELS.size,
    discoveredAt: state.discoveredAt ? new Date(state.discoveredAt).toISOString() : null,
    ageMs: state.discoveredAt ? Date.now() - state.discoveredAt : null,
    gateway: state.gateway,
    gateways: state.gateways ?? [],
    perGateway: state.perGateway ?? {},
    metadata: state.metadata ?? null,
    duplicates: state.duplicates,
    error: state.error,
    stale: !state.discoveredAt || Date.now() - state.discoveredAt > CATALOGUE_TTL_MS,
  }
}

/**
 * Live verification state, derived rather than stored.
 *
 * Storing it would let it drift from health: a model marked LIVE_VERIFIED an
 * hour ago that has failed five times since is not currently verified, and the
 * ranking must see that immediately.
 */
function liveVerification(record, health) {
  if (record.verification === VERIFICATION.MOCK_VERIFIED) return VERIFICATION.MOCK_VERIFIED
  if (!record.inCatalogue && !record.configured) return VERIFICATION.UNAVAILABLE
  if (health.fatal) return VERIFICATION.UNAVAILABLE
  if (health.state === HEALTH.RATE_LIMITED || health.cooldownMs > 0) {
    return health.lastFailureKind === 'rate_limited' ? VERIFICATION.RATE_LIMITED : VERIFICATION.UNHEALTHY
  }
  if (record.verification === VERIFICATION.LIVE_VERIFIED) {
    return health.consecutiveFailures >= 2 ? VERIFICATION.UNHEALTHY : VERIFICATION.LIVE_VERIFIED
  }
  if (health.failureCount > 0 && health.successCount === 0) return VERIFICATION.UNHEALTHY
  return VERIFICATION.CATALOGUED
}

function decorate(record) {
  const health = healthOf(record.id)
  return {
    ...record,
    health,
    verification: liveVerification(record, health),
    /** True only when a real request returned usable content and it still works. */
    verified: liveVerification(record, health) === VERIFICATION.LIVE_VERIFIED,
    latency: health.latencyMs,
    errorRate: health.errorRate,
  }
}

/* ---------- writing ---------- */

/**
 * Records the outcome of a real request against a model.
 *
 * This is the *only* way a model becomes LIVE_VERIFIED. It is called from the
 * chat path, the agent, the vision router and the probe runner, so ordinary
 * traffic teaches the registry for free (section 40's "lazy verification").
 */
export function noteSuccess(id, { latencyMs, via = 'request', capabilities } = {}) {
  const record = MODELS.get(id) ?? adopt(id)
  if (!record) return
  record.verification = VERIFICATION.LIVE_VERIFIED
  record.lastVerified = new Date().toISOString()
  record.verifiedBy = via
  if (capabilities) applyCapabilities(record, capabilities, EVIDENCE.PROBE)
  if (latencyMs !== undefined) record.lastLatencyMs = latencyMs
  // A success clears a remembered failure: the route just disproved it
  record.priorFailure = null
  record.priorFailureFatal = false
  scheduleSave(allModels)
}

export function noteFailure(id, kind) {
  const record = MODELS.get(id) ?? adopt(id)
  if (!record) return
  record.lastFailureKind = kind
  scheduleSave(allModels)
  /*
   * A capability failure disproves exactly one capability and nothing else.
   * The model stays as verified as it was for everything else it can do.
   */
  if (kind === 'unsupported_capability') applyCapabilities(record, { vision: false }, EVIDENCE.PROBE)
}

/**
 * A model the gateway never listed but that a request reached anyway.
 *
 * Happens with pinned fallbacks and with operator-typed ids. Adopting it is
 * more honest than discarding the evidence: something answered, and pretending
 * otherwise would lose a working route.
 */
function adopt(id) {
  if (typeof id !== 'string' || !id) return null
  const { adapter } = getGateway()
  const record = initRecord(
    normaliseModel(id, { gatewayCapabilities: adapter.capabilities, docEvidence: docEvidenceTable() }),
    false,
  )
  record.inCatalogue = false
  MODELS.set(id, record)
  return record
}

/** Applies measured capabilities, respecting the evidence hierarchy. */
export function applyCapabilities(recordOrId, capabilities, source = EVIDENCE.PROBE) {
  const record = typeof recordOrId === 'string' ? MODELS.get(recordOrId) : recordOrId
  if (!record) return
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === undefined || value === null) continue
    const current = record.capabilities[key]
    if (current?.source && !outranks(source, current.source)) continue
    record.capabilities[key] = { value, source }
  }
  // Measured capabilities can add categories the id never hinted at
  if (capabilities.vision === true && !record.categories.includes(CATEGORY.VISION)) {
    record.categories.push(CATEGORY.VISION, CATEGORY.MULTIMODAL)
  }
  if (capabilities.tools === true && !record.categories.includes(CATEGORY.TOOL_AGENT)) {
    record.categories.push(CATEGORY.TOOL_AGENT)
  }
}

/** Stores a probe result verbatim alongside the record. */
export function storeProbe(id, probe) {
  const record = MODELS.get(id) ?? adopt(id)
  if (!record) return
  record.probe = probe
  record.lastVerified = probe.at
  if (probe.ok) {
    record.verification = probe.mock ? VERIFICATION.MOCK_VERIFIED : VERIFICATION.LIVE_VERIFIED
    record.verifiedBy = 'probe'
  }
}

export function storeBenchmark(id, name, result) {
  const record = MODELS.get(id) ?? adopt(id)
  if (!record) return
  record.benchmarks = { ...record.benchmarks, [name]: result }
}

/* ---------- documentation evidence ---------- */

/** The published-documentation weight for a model, for ranking and for "why". */
export function docWeight(id) {
  const record = MODELS.get(id)
  if (!record) return null
  return docEvidenceFor(id, record.family)
}

/* ---------- capability queries ---------- */

/**
 * Whether a model can be relied on for `capability`.
 *
 * `strict` is what vision uses: only a probe counts. Section 13 does not allow
 * a vision request to be sent somewhere on the strength of its name.
 */
export function capable(id, capability, { strict = false } = {}) {
  const record = MODELS.get(id)
  if (!record) return false
  const entry = record.capabilities?.[capability]
  if (!entry) return false
  if (entry.value === false) return false
  if (strict) return entry.value === true && entry.source === EVIDENCE.PROBE
  // null means unknown — a candidate, not a promise
  return entry.value === true || entry.value === null
}

/** Models whose id or documentation makes them worth *checking* for a capability. */
export function candidatesFor(capability) {
  return allModels().filter((m) => {
    const entry = m.capabilities?.[capability]
    return entry && entry.value !== false
  })
}

/* ---------- test seam ---------- */

export function resetRegistry() {
  MODELS.clear()
  memoryRestored = true // tests seed their own state; never read the disk cache
  state = { discoveredAt: 0, gateway: null, error: null, duplicates: [], configured: [] }
}

/** Seeds the registry directly. Used by tests and by the offline CLI path. */
export function seedRegistry(ids, { gatewayCapabilities = { streaming: true, tools: true, vision: true, models: true } } = {}) {
  const { models, duplicates } = normaliseCatalogue(ids, { gatewayCapabilities, docEvidence: docEvidenceTable() })
  for (const m of models) MODELS.set(m.id, initRecord(m, false))
  state = { discoveredAt: Date.now(), gateway: 'test', error: null, duplicates, configured: [] }
  return { total: MODELS.size, duplicates }
}

export { allHealth, CATALOGUE_TTL_MS }
