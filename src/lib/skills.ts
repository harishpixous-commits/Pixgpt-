/* ============================================================
   Skills client
   -------------
   The browser receives metadata only — what exists, whether it works,
   and what is stopping it. No skill implementation is shipped here, and
   no response carries a configuration value.
   ============================================================ */

export type SkillStatus =
  | 'available'
  | 'enabled'
  | 'disabled'
  | 'requires_config'
  | 'unsupported'
  | 'coming_soon'
  | 'error'

export type SkillPermission = 'safe' | 'approval_required' | 'restricted'

export interface SkillRequirement {
  id: string
  met: boolean
  detail: string
  fix: string | null
  partial: boolean
  unverified: boolean
}

export interface SkillSetting {
  label: string
  type: 'select' | 'number' | 'boolean'
  options?: string[]
  min?: number
  max?: number
  default: string | number | boolean
  value: string | number | boolean
}

export interface Skill {
  id: string
  name: string
  description: string
  category: string
  categoryLabel: string
  icon: string
  status: SkillStatus
  enabled: boolean
  mandatory: boolean
  permission: SkillPermission
  version: string
  license: string | null
  source: string
  tools: string[]
  mode: string | null
  favourite: boolean
  settings: Record<string, SkillSetting> | null
  requirements: SkillRequirement[]
  blockedBy: string[]
  fixes: string[]
  /** Met, but never actually proven to work — e.g. a vision route that has not answered. */
  unverified: boolean
  partial: string[]
  external: boolean
  custom: boolean
  resources: { files: number; totalBytes: number; data: string[] } | null
  telemetry: { uses: number; failures: number; averageMs: number | null; lastUsedAt: string } | null
}

export interface SkillSummary {
  total: number
  usable: number
  requiresConfig: number
  unsupported: number
  comingSoon: number
  external: number
  custom: number
  byStatus: Record<string, number>
  categories: Array<{ id: string; label: string; count: number }>
}

export interface DetectedSkills {
  activated: Array<{ id: string; name: string; category: string; icon: string; score: number; reasons: string[] }>
  unavailable: Array<{ id: string; name: string; status: SkillStatus; blockedBy: string[]; fixes: string[] }>
  tools: string[]
  mode: string
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json', ...options?.headers } : options?.headers,
  })
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    /* fall through to the status-based message */
  }
  if (!response.ok) {
    const error = (payload as { error?: { message?: string } } | null)?.error
    throw new Error(error?.message ?? `That request failed (${response.status}).`)
  }
  return payload as T
}

export function fetchSkills(filter: { category?: string; query?: string } = {}): Promise<{
  skills: Skill[]
  summary: SkillSummary
}> {
  const params = new URLSearchParams()
  if (filter.category) params.set('category', filter.category)
  if (filter.query) params.set('q', filter.query)
  const query = params.toString()
  return request(`/api/skills${query ? `?${query}` : ''}`)
}

export function toggleSkill(id: string, enabled: boolean): Promise<Skill> {
  return request(`/api/skills/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export function favouriteSkill(id: string, favourite: boolean): Promise<Skill> {
  return request(`/api/skills/${encodeURIComponent(id)}/favourite`, {
    method: 'POST',
    body: JSON.stringify({ favourite }),
  })
}

export function updateSkillSettings(id: string, settings: Record<string, unknown>): Promise<Skill> {
  return request(`/api/skills/${encodeURIComponent(id)}/settings`, {
    method: 'POST',
    body: JSON.stringify({ settings }),
  })
}

export function detectSkills(input: {
  text: string
  mode?: string
  hasImages?: boolean
  hasDocuments?: boolean
}): Promise<DetectedSkills> {
  return request('/api/skills/detect', { method: 'POST', body: JSON.stringify(input) })
}

export interface CustomSkill {
  id: string
  name: string
  description: string
  instructions: string
  category: string
  enabled: boolean
  version: string
  warnings: string[]
}

export function listCustomSkills(): Promise<{ skills: CustomSkill[] }> {
  return request('/api/skills/custom')
}

export function createCustomSkill(input: {
  name: string
  description: string
  instructions: string
  category?: string
}): Promise<CustomSkill> {
  return request('/api/skills/custom', { method: 'POST', body: JSON.stringify(input) })
}

export function deleteCustomSkill(id: string): Promise<{ ok: boolean }> {
  return request(`/api/skills/custom/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** How each status is presented. Kept here so the panel and chips agree. */
export const STATUS_LABEL: Record<SkillStatus, string> = {
  available: 'Available',
  enabled: 'On',
  disabled: 'Off',
  requires_config: 'Needs setup',
  unsupported: 'Not supported here',
  coming_soon: 'Coming soon',
  error: 'Error',
}

export const STATUS_TONE: Record<SkillStatus, 'ok' | 'warn' | 'muted' | 'error'> = {
  available: 'ok',
  enabled: 'ok',
  disabled: 'muted',
  requires_config: 'warn',
  unsupported: 'muted',
  coming_soon: 'muted',
  error: 'error',
}

/** True when a skill can be switched on right now. */
export function isUsable(skill: Skill): boolean {
  return skill.status === 'available' || skill.status === 'enabled'
}
