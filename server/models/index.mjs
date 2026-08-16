import { log } from '../config.mjs'
import { setChainResolver, setModelGatewayResolver, setOutcomeReporter, setTimeoutResolver } from '../gateway/index.mjs'
import * as ranking from './ranking.mjs'
import * as probe from './probe.mjs'
import { discover, registryState, allModels, getModel, noteSuccess, noteFailure, persist } from './registry.mjs'
import { recordSuccess, recordFailure, classifyFailure, healthOf, allHealth, timeoutFor } from './health.mjs'
import { selectModels, classifyTask, isAlias, recommendations, allGrouped, sessionModel, sessionState } from './select.mjs'
import { CATEGORY, CATEGORY_LABELS, VERIFICATION, TIER } from './catalog.mjs'

/* ============================================================
   Model intelligence — public surface
   -----------------------------------
   One import point for the rest of the server, and the place the
   gateway client is wired to the registry.

   The wiring is deliberately a *hook*, not a rewrite. The gateway
   keeps its own chain logic and falls back to it whenever the
   registry has nothing to say — an empty registry, a discovery
   failure or a gateway with no catalogue all behave exactly as
   they did before this system existed.
   ============================================================ */

/**
 * Budget for a route we have strong evidence is broken.
 *
 * Long enough for a recovered route to answer, short enough that confirming a
 * dead one costs a moment rather than a quarter of a minute.
 */
const KNOWN_BAD_TIMEOUT_MS = Number.parseInt(process.env.PIXGPT_KNOWN_BAD_TIMEOUT_MS ?? '', 10) || 4_000

probe.wireRanking(ranking)

let installed = false

/**
 * Connects the registry to the gateway client.
 *
 * After this, `client.streamCompletion` and `client.completion` ask the
 * registry for their model chain and report every outcome back to it. Ordinary
 * traffic is therefore what verifies models — no background probing needed
 * (section 40's "lazy verification").
 */
export function installModelRouting() {
  if (installed) return
  installed = true

  setChainResolver((requested, context) => {
    if (registryState().total === 0) return null // nothing discovered yet: leave the old path alone
    const selection = selectModels(requested, context)
    if (selection.chain.length === 0) return null
    return { chain: selection.chain, meta: { task: selection.task, why: selection.why, degraded: selection.degraded } }
  })

  setOutcomeReporter((model, outcome) => {
    if (outcome.ok) {
      recordSuccess(model, { latencyMs: outcome.ms })
      noteSuccess(model, { latencyMs: outcome.ms, via: outcome.via ?? 'request' })
    } else {
      const kind = classifyFailure(outcome.error)
      recordFailure(model, outcome.error)
      noteFailure(model, kind)
    }
  })

  /*
   * Which gateway serves which model. Answered from the registry so a chain
   * that crosses gateways is executed against the right endpoint rather than
   * 404ing an OpenRouter id against OmniRoute.
   */
  setModelGatewayResolver((model) => getModel(model)?.gateway ?? null)

  /*
   * How long each route gets before the chain moves on.
   *
   * Two inputs. Measured latency sets the normal budget (health.timeoutFor).
   * On top of that, a route carrying a *terminal* remembered failure — a
   * missing binary, a rejected credential — gets a much shorter one: we have
   * strong evidence it will fail, and spending fifteen seconds confirming that
   * delays the fallback that was always going to serve.
   *
   * Still tried, not skipped. A deployment that was fixed this morning has to
   * be able to prove it, and one quick attempt is how it does.
   */
  setTimeoutResolver((model, ceiling) => {
    const budget = timeoutFor(model, ceiling)
    const record = getModel(model)
    const doomed = record?.priorFailureFatal && record.health.successCount === 0
    return doomed ? Math.min(budget, KNOWN_BAD_TIMEOUT_MS) : budget
  })

  log.info('model routing installed')
}

/**
 * Discovers the catalogue if it has not been read yet.
 *
 * Called from the routes rather than at boot, so a gateway that is down at
 * startup does not leave the registry permanently empty.
 */
export async function ensureDiscovered(options) {
  const state = registryState()
  if (state.total > 0 && !state.stale) return state
  await discover(options)
  return registryState()
}

/* ---------- summary, for status endpoints and the UI ---------- */

/**
 * The five numbers that actually describe a catalogue.
 *
 * "116 models" is true and useless. These separate what the gateway *lists*
 * from what could be called, what answered, and what is answering now — which
 * on a real deployment are wildly different numbers, and the gap between them
 * is the only interesting thing about a model list.
 */
export function catalogueCounts() {
  const models = allModels()
  const health = allHealth()

  /*
   * "Tried" spans this process *and* what earlier ones recorded.
   *
   * Live health only holds routes touched since start-up, and cooldowns are
   * deliberately not restored — so counting from it alone reported 88 models
   * as untried immediately after a run that probed all 116. The persisted
   * failure kind is the durable record that a route was attempted.
   */
  const tried = new Set(Object.keys(health))
  for (const m of models) if (m.priorFailure) tried.add(m.id)

  const isAuthFailure = (kind) => kind === 'invalid_key' || kind === 'quota'
  const authFailed = new Set(
    Object.entries(health)
      .filter(([, h]) => isAuthFailure(h.lastFailureKind))
      .map(([id]) => id),
  )
  for (const m of models) if (isAuthFailure(m.priorFailure)) authFailed.add(m.id)

  return {
    /** Listed by some gateway. */
    catalogued: models.length,
    /** Belongs to a gateway this server is configured to use. */
    configured: models.filter((m) => m.gateway).length,
    /**
     * Reached the provider without a credential rejection. Not "worked" —
     * a model can authenticate and then be rate limited or return nothing.
     */
    authenticated: models.filter((m) => tried.has(m.id) && !authFailed.has(m.id)).length,
    /** Returned usable content at least once. */
    liveVerified: models.filter((m) => m.verified).length,
    /** Verified and not currently failing or cooling down. */
    healthy: models.filter((m) => m.verified && m.health.state === 'healthy').length,
    /** Never tried, so nothing at all is known about them. */
    untried: models.filter((m) => !tried.has(m.id)).length,
  }
}

export function summary() {
  const models = allModels()
  const byVerification = {}
  const byProvider = {}
  const byCategory = {}

  for (const m of models) {
    byVerification[m.verification] = (byVerification[m.verification] ?? 0) + 1
    byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1
    for (const c of m.categories) byCategory[c] = (byCategory[c] ?? 0) + 1
  }

  const tiers = ranking.qualityTiers()
  const byTier = {}
  for (const tier of tiers.values()) byTier[tier] = (byTier[tier] ?? 0) + 1

  return {
    total: models.length,
    verified: models.filter((m) => m.verified).length,
    probed: models.filter((m) => m.probe).length,
    byVerification,
    byProvider,
    byCategory,
    byTier,
    counts: catalogueCounts(),
    categories: Object.entries(byCategory)
      .map(([id, count]) => ({ id, label: CATEGORY_LABELS[id] ?? id, count }))
      .sort((a, b) => b.count - a.count),
    registry: registryState(),
  }
}

/** The eleven bests, with their explanations (section 8). */
export function bestModels(options = {}) {
  const out = {}
  for (const [task, entry] of Object.entries(ranking.bests(options))) {
    out[task] = entry
      ? {
          id: entry.id,
          displayName: entry.displayName,
          score: entry.score,
          verification: entry.verification,
          health: entry.health,
          why: ranking.explain(entry, (ranking.TASK[task]?.label ?? task).toLowerCase()),
        }
      : null
  }
  return out
}

/** One model, with its tier and full reasoning. Safe to return over HTTP. */
export function describeModel(id) {
  const model = getModel(id)
  if (!model) return null
  const tiers = ranking.qualityTiers()

  return {
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    providerLabel: model.providerLabel,
    family: model.family,
    categories: model.categories,
    categoryLabels: model.categories.map((c) => CATEGORY_LABELS[c] ?? c),
    capabilities: Object.fromEntries(
      Object.entries(model.capabilities).map(([k, v]) => [k, { value: v.value, source: v.source }]),
    ),
    verification: model.verification,
    verified: model.verified,
    lastVerified: model.lastVerified,
    verifiedBy: model.verifiedBy,
    health: model.health,
    latency: model.latency,
    errorRate: model.errorRate,
    context: model.context,
    contextSource: model.contextSource,
    cost: model.cost,
    free: model.free,
    qualityTier: tiers.get(model.id) ?? null,
    routing: model.routing,
    configured: model.configured,
    inCatalogue: model.inCatalogue,
    docNote: model.docNote,
    probe: model.probe,
    benchmarks: model.benchmarks,
    /** Where this model sits in each task's chain, for the detail panel. */
    fallbackPositions: fallbackPositions(model.id),
  }
}

function fallbackPositions(id) {
  const out = {}
  for (const task of ranking.TASK_IDS) {
    const index = ranking.rank(task).findIndex((m) => m.id === id)
    if (index >= 0 && index < 6) out[task] = index + 1
  }
  return out
}

export {
  persist,
  discover,
  registryState,
  allModels,
  getModel,
  healthOf,
  allHealth,
  selectModels,
  classifyTask,
  isAlias,
  recommendations,
  allGrouped,
  sessionModel,
  sessionState,
  probe,
  ranking,
  CATEGORY,
  CATEGORY_LABELS,
  VERIFICATION,
  TIER,
}
