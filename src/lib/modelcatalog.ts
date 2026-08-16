/* ============================================================
   Model catalogue client
   ----------------------
   The browser receives what a model *is* and how it has *behaved* —
   never a base URL, a key, or the routing table.

   The distinction this file exists to carry into the UI is the one
   the whole system is built on: a model appearing in the catalogue
   has not been shown to work. `verification` says which, and the
   picker shows it, so "available" never quietly means "listed".
   ============================================================ */

export type Verification =
  | 'CATALOGUED'
  | 'MOCK_VERIFIED'
  | 'LIVE_VERIFIED'
  | 'UNHEALTHY'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'UNKNOWN'

export type HealthState = 'healthy' | 'degraded' | 'rate_limited' | 'unreachable' | 'invalid' | 'cooldown' | 'unknown'

export type QualityTier = 'TIER_S' | 'TIER_A' | 'TIER_B' | 'TIER_C' | 'TIER_FREE'

export interface CatalogueModel {
  id: string
  displayName: string
  provider: string
  providerLabel: string
  family: string
  categories: string[]
  verification: Verification
  verified: boolean
  lastVerified: string | null
  health: HealthState
  latency: number | null
  errorRate: number | null
  context: number | null
  cost: string
  free: boolean
  qualityTier: QualityTier | null
  routing: boolean
  configured: boolean
  inCatalogue: boolean
  /** Why the route failed, from this session or a remembered one. */
  failureKind?: string | null
  failureRemembered?: boolean
}

export interface ScoreReason {
  label: string
  points: number
}

export interface RankedModel {
  id: string
  displayName: string
  provider: string
  family: string
  score: number
  reasons: ScoreReason[]
  verification: Verification
  health: HealthState
  free: boolean
  cost: string
  context: number | null
  routing: boolean
  star?: boolean
  why?: string | null
}

export interface RecommendationGroup {
  key: string
  label: string
  note: string | null
  models: RankedModel[]
}

export interface Recommendations {
  task: string
  taskLabel: string
  reason: string
  groups: RecommendationGroup[]
}

export interface CatalogueCounts {
  catalogued: number
  configured: number
  authenticated: number
  liveVerified: number
  healthy: number
  untried: number
}

export interface RegistrySummary {
  total: number
  verified: number
  probed: number
  /** The five numbers that describe the catalogue honestly. */
  counts?: CatalogueCounts
  byVerification: Record<string, number>
  byProvider: Record<string, number>
  categories: { id: string; label: string; count: number }[]
  byTier: Record<string, number>
  registry: { total: number; discoveredAt: string | null; gateway: string | null; stale: boolean; error: unknown }
}

export interface ModelRegistry {
  summary: RegistrySummary
  models: CatalogueModel[]
  groups: { provider: string; label: string; count: number }[]
  categories: { id: string; label: string }[]
}

export interface ModelDetail extends CatalogueModel {
  categoryLabels: string[]
  capabilities: Record<string, { value: boolean | null; source: string | null }>
  verifiedBy: string | null
  contextSource: string | null
  docNote: string | null
  probe: { probe: string; ok: boolean; ms: number; detail?: string; reason?: string; at: string } | null
  benchmarks: Record<string, { ok: boolean; ms: number; at: string }>
  fallbackPositions: Record<string, number>
  health: HealthState
  healthDetail?: unknown
}

/**
 * Thrown when the server does not have a route the page expects.
 *
 * Written without a parameter property: the build runs with
 * `erasableSyntaxOnly`, which forbids the `constructor(public x)` shorthand
 * because it emits real code rather than erasing to nothing.
 */
export class MissingRouteError extends Error {
  path: string

  constructor(path: string) {
    super(`This server has no ${path} route.`)
    this.name = 'MissingRouteError'
    this.path = path
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store' })
  const body = await response.json().catch(() => null)

  /*
   * A 404 on a route the page knows about means one thing in practice: the
   * server is older than the bundle it is serving. Detected on the *status*
   * and the stable error code rather than the message text — matching on the
   * wording missed it, because the server says "Unknown API route." and the
   * check was looking for "not found".
   */
  if (response.status === 404 || body?.error?.code === 'not_found') {
    throw new MissingRouteError(path)
  }
  if (!response.ok) throw new Error(body?.error?.message ?? 'Request failed.')
  return body as T
}

export const fetchRegistry = (signal?: AbortSignal) => get<ModelRegistry>('/api/models/registry', signal)

export function fetchRecommended(
  query: { text?: string; mode?: string; images?: boolean },
  signal?: AbortSignal,
): Promise<Recommendations & { best: Record<string, RankedModel | null> }> {
  const params = new URLSearchParams()
  if (query.text) params.set('q', query.text.slice(0, 400))
  if (query.mode) params.set('mode', query.mode)
  if (query.images) params.set('images', 'true')
  return get(`/api/models/recommended${params.size ? `?${params}` : ''}`, signal)
}

export function fetchModelDetail(id: string, signal?: AbortSignal): Promise<{ model: ModelDetail }> {
  return get(`/api/models/${encodeURIComponent(id)}`, signal)
}

export async function refreshModels(signal?: AbortSignal): Promise<{ total: number; added: string[]; removed: string[] }> {
  const response = await fetch('/api/models/refresh', { method: 'POST', signal })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? 'Could not refresh the catalogue.')
  return body
}

/* ---------- presentation ---------- */

/**
 * How each verification state reads to a user.
 *
 * `CATALOGUED` deliberately does not say "available". The gateway listing a
 * model is not a promise, and a label that implied otherwise would undo the
 * distinction the whole registry exists to keep.
 */
export const VERIFICATION_LABEL: Record<Verification, string> = {
  LIVE_VERIFIED: 'Verified',
  MOCK_VERIFIED: 'Test only',
  CATALOGUED: 'Not yet verified',
  UNHEALTHY: 'Failing',
  RATE_LIMITED: 'Rate limited',
  UNAVAILABLE: 'Unavailable',
  UNKNOWN: 'Unknown',
}

export const VERIFICATION_TONE: Record<Verification, 'ok' | 'warn' | 'muted' | 'error'> = {
  LIVE_VERIFIED: 'ok',
  MOCK_VERIFIED: 'muted',
  CATALOGUED: 'muted',
  UNHEALTHY: 'warn',
  RATE_LIMITED: 'warn',
  UNAVAILABLE: 'error',
  UNKNOWN: 'muted',
}

export const TIER_LABEL: Record<QualityTier, string> = {
  TIER_S: 'S',
  TIER_A: 'A',
  TIER_B: 'B',
  TIER_C: 'C',
  TIER_FREE: 'Free',
}

export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  rate_limited: 'Rate limited',
  unreachable: 'Unreachable',
  invalid: 'Not usable',
  cooldown: 'Cooling down',
  unknown: 'Never tried',
}

export function formatContext(tokens: number | null): string {
  if (!tokens) return '—'
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

export function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
