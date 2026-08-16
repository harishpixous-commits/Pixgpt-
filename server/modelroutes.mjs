import { GatewayError } from './gateway/errors.mjs'
import { log } from './config.mjs'
import { clientKey } from './rate-limit.mjs'
import { describeGateways, getGatewayById } from './gateway/index.mjs'
import {
  ensureDiscovered,
  discover,
  registryState,
  allModels,
  describeModel,
  summary,
  bestModels,
  recommendations,
  allGrouped,
  allHealth,
  selectModels,
  classifyTask,
  probe,
  ranking,
  CATEGORY_LABELS,
} from './models/index.mjs'

/* ============================================================
   Model discovery, ranking and probing endpoints
   ----------------------------------------------
     GET  /api/models              the catalogue (unchanged shape) + registry
     GET  /api/models/recommended  grouped picks for the picker
     GET  /api/models/health       per-route health and verification
     GET  /api/models/best         the eleven task winners
     GET  /api/models/:id          one model in full
     POST /api/models/refresh      re-read the catalogue, no restart
     POST /api/models/probe        spend real requests to verify (admin)
     POST /api/models/select       explain what would be chosen (dry run)

   Nothing here returns a key, a base URL, or a configuration value.
   The probe endpoint costs money, so it is gated (section 42).
   ============================================================ */

const bad = (message) => new GatewayError('bad_request', message, { status: 400 })

/* ---------- admin gate (section 42) ---------- */

/**
 * Probing spends real quota against a live gateway, so it is not a public
 * endpoint.
 *
 * With PIXGPT_ADMIN_TOKEN set, the token is required. Without it, the endpoint
 * is loopback-only — a default that keeps a developer's own machine usable
 * without silently exposing a spend button on a deployed server.
 */
export function requireAdmin(req) {
  const expected = process.env.PIXGPT_ADMIN_TOKEN
  if (expected) {
    const header = req.headers['x-admin-token']
    const supplied = Array.isArray(header) ? header[0] : header
    if (!supplied || !timingSafeEqual(String(supplied), expected)) {
      throw new GatewayError('bad_request', 'This endpoint requires an administrator token.', { status: 403 })
    }
    return
  }

  const key = clientKey(req)
  const loopback = key === '127.0.0.1' || key === '::1' || key === '::ffff:127.0.0.1' || key === 'localhost'
  if (!loopback) {
    throw new GatewayError(
      'bad_request',
      'This endpoint is restricted to the local machine. Set PIXGPT_ADMIN_TOKEN to enable remote access.',
      { status: 403 },
    )
  }
}

/** Constant-time compare, so a token cannot be recovered a character at a time. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/* ---------- providers ---------- */

/**
 * `GET /api/models/providers` — which gateways exist, which are usable.
 *
 * Reports configuration *state* only: whether a key is set, never its value,
 * never the value's length or shape.
 */
export async function handleProviders(signal) {
  await ensureDiscovered({ signal }).catch(() => null)
  const state = registryState()
  const models = allModels()

  const counts = {}
  for (const m of models) counts[m.gateway ?? 'unknown'] = (counts[m.gateway ?? 'unknown'] ?? 0) + 1

  const verified = {}
  for (const m of models.filter((x) => x.verified)) {
    verified[m.gateway ?? 'unknown'] = (verified[m.gateway ?? 'unknown'] ?? 0) + 1
  }

  return {
    providers: describeGateways().map((g) => ({
      ...g,
      models: counts[g.id] ?? 0,
      verified: verified[g.id] ?? 0,
      participating: (state.gateways ?? []).includes(g.id),
      listed: state.perGateway?.[g.id]?.listed ?? 0,
    })),
    metadata: state.metadata?.sources ?? [],
    note: 'A provider is only listed as configured when its credentials are present in this server’s environment.',
  }
}

/** `POST /api/models/providers/:id/probe` — admin; spends a real request. */
export async function handleProviderProbe(id, body = {}, signal, req) {
  requireAdmin(req)
  const entry = getGatewayById(id)
  if (!entry) throw new GatewayError('bad_request', 'No such provider.', { status: 404 })

  const health = await entry.client.checkHealth()
  await ensureDiscovered({ signal }).catch(() => null)

  const candidates = allModels()
    .filter((m) => m.gateway === id)
    .slice(0, Number.isFinite(body.limit) ? body.limit : 3)
    .map((m) => m.id)

  const outcome = candidates.length > 0 ? await probe.probeModels(candidates, { probes: ['chat'], signal }) : { results: [] }

  return {
    provider: id,
    health: { ok: health.ok, reachable: health.reachable, authenticated: health.authenticated, code: health.code },
    probed: outcome.results.length,
    passed: outcome.results.filter((r) => r.ok).length,
    results: outcome.results.map((r) => ({ model: r.model, ok: r.ok, ms: r.ms, reason: r.reason })),
  }
}

/* ---------- read endpoints ---------- */

/** `GET /api/models/registry` — normalised catalogue with live state. */
export async function handleRegistry(query = {}, signal) {
  await ensureDiscovered({ signal })

  const category = query.category ? String(query.category).toUpperCase() : null
  const provider = query.provider ? String(query.provider) : null
  const verifiedOnly = query.verified === 'true'

  let models = allModels()
  if (category) models = models.filter((m) => m.categories.includes(category))
  if (provider) models = models.filter((m) => m.provider === provider)
  if (verifiedOnly) models = models.filter((m) => m.verified)

  const tiers = ranking.qualityTiers()

  return {
    summary: summary(),
    models: models
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        provider: m.provider,
        providerLabel: m.providerLabel,
        family: m.family,
        categories: m.categories,
        verification: m.verification,
        verified: m.verified,
        lastVerified: m.lastVerified,
        health: m.health.state,
        latency: m.latency,
        errorRate: m.errorRate,
        context: m.context,
        cost: m.cost,
        free: m.free,
        qualityTier: tiers.get(m.id) ?? null,
        routing: m.routing,
        configured: m.configured,
        inCatalogue: m.inCatalogue,
        /*
         * Why this route failed, from either this session or a remembered one.
         *
         * Without it the UI could only distinguish "verified" from "not
         * verified", so 62 models known to be broken — a missing CLI, a
         * rejected credential — showed as merely unverified alongside models
         * nobody had tried. Those are different facts and the picker says so.
         */
        failureKind: m.health.lastFailureKind ?? m.priorFailure ?? null,
        failureRemembered: Boolean(!m.health.lastFailureKind && m.priorFailure),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    groups: allGrouped().map((g) => ({ provider: g.provider, label: g.label, count: g.count })),
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
  }
}

/** `GET /api/models/recommended` — what the picker shows (section 26). */
export async function handleRecommended(query = {}, signal) {
  await ensureDiscovered({ signal })
  const text = String(query.q ?? query.text ?? '')
  const context = {
    text,
    mode: query.mode ? String(query.mode) : undefined,
    hasImages: query.images === 'true',
    hasTools: query.tools === 'true',
  }
  return { ...recommendations(context), best: bestModels(context) }
}

/** `GET /api/models/best` — the eleven bests (section 8). */
export async function handleBest(signal) {
  await ensureDiscovered({ signal })
  return { best: bestModels(), note: 'There is no single best model. Each entry is the best for that task class.' }
}

/** `GET /api/models/health` — per-route state (section 20). */
export async function handleModelHealth(signal) {
  await ensureDiscovered({ signal })
  const models = allModels()
  const health = allHealth()

  return {
    registry: registryState(),
    counts: {
      total: models.length,
      tried: Object.keys(health).length,
      verified: models.filter((m) => m.verified).length,
      cooling: models.filter((m) => m.health.cooldownMs > 0).length,
      unusable: models.filter((m) => m.health.fatal).length,
    },
    /** Only routes with recorded history; the untried are not "healthy". */
    routes: Object.entries(health)
      .map(([id, h]) => ({
        id,
        displayName: describeModel(id)?.displayName ?? id,
        ...h,
      }))
      .sort((a, b) => (b.successCount + b.failureCount) - (a.successCount + a.failureCount)),
  }
}

/** `GET /api/models/:id` — the detail panel (section 28). */
export async function handleModelDetail(id, signal) {
  await ensureDiscovered({ signal })
  const model = describeModel(id)
  if (!model) throw new GatewayError('bad_request', 'No such model in the catalogue.', { status: 404 })
  return { model }
}

/* ---------- write endpoints ---------- */

/** `POST /api/models/refresh` — re-read without a restart (section 29). */
export async function handleRefresh(signal) {
  const result = await discover({ signal, force: true })
  log.info('model catalogue refreshed', { total: result.total, added: result.added.length, removed: result.removed.length })
  return {
    total: result.total,
    added: result.added,
    removed: result.removed,
    duplicates: result.duplicates ?? [],
    error: result.error,
    summary: summary(),
  }
}

/**
 * `POST /api/models/probe` — verification against the live gateway.
 *
 * Admin-gated and capped. `models` may be omitted, in which case the default
 * candidate set is used: the configured aliases plus the top of each ranking,
 * never the whole catalogue (section 40).
 */
export async function handleProbe(body = {}, signal, req) {
  requireAdmin(req)
  await ensureDiscovered({ signal })

  const requested = Array.isArray(body.models) ? body.models.filter((m) => typeof m === 'string') : null
  const probes = Array.isArray(body.probes) && body.probes.length > 0 ? body.probes : ['chat']

  for (const p of probes) {
    if (!probe.PROBE_IDS.includes(p)) throw bad(`Unknown probe "${p}". Available: ${probe.PROBE_IDS.join(', ')}.`)
  }

  const candidates = requested ?? probe.probeCandidates().map((c) => c.id)
  if (candidates.length === 0) throw bad('No candidate models to probe.')

  const started = Date.now()
  const outcome = await probe.probeModels(candidates, { probes, signal })

  return {
    ...outcome,
    ms: Date.now() - started,
    passed: outcome.results.filter((r) => r.ok).length,
    failed: outcome.results.filter((r) => !r.ok && !r.skipped).length,
    skipped: outcome.results.filter((r) => r.skipped).length,
    summary: summary(),
  }
}

/**
 * `POST /api/models/select` — a dry run of routing.
 *
 * Answers "which model would you use for this, and why" without sending
 * anything to a model. This is what makes the routing auditable rather than
 * something the user has to take on trust.
 */
export async function handleSelect(body = {}, signal) {
  await ensureDiscovered({ signal })

  const text = String(body.text ?? '')
  if (text.length > 8000) throw bad('That text is too long to classify.')

  const context = {
    text,
    mode: body.mode ? String(body.mode) : undefined,
    hasImages: body.images === true,
    hasTools: body.tools === true,
    requiresVision: body.images === true,
    estimatedTokens: Number.isFinite(body.estimatedTokens) ? body.estimatedTokens : 0,
  }

  const classified = classifyTask(text, context)
  const selection = selectModels(body.model ?? undefined, context)

  return {
    classification: classified,
    task: selection.task,
    taskLabel: selection.taskLabel,
    primary: selection.primary,
    chain: selection.chain,
    why: selection.why,
    degraded: selection.degraded,
    /** The full scoring for the winner, so a ranking can be argued with. */
    reasons: selection.entries?.[0]?.reasons ?? [],
  }
}
