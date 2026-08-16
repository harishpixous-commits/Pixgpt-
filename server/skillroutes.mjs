import { GatewayError } from './gateway/errors.mjs'
import { log } from './config.mjs'
import {
  capabilityMatrix,
  contextForSkills,
  detectSkills,
  getSkill,
  listSkills,
  setEnabled,
  setFavourite,
  setSettings,
  skillSummary,
  telemetry,
  toolsForSkills,
} from './skills/index.mjs'
import {
  createCustomSkill,
  deleteCustomSkill,
  listCustomSkills,
  rollbackCustomSkill,
  updateCustomSkill,
} from './skills/custom.mjs'
import { inspectSkillDirectory, readSkillResource } from './skills/external.mjs'

/* ============================================================
   Skills endpoints
   ----------------
   The frontend gets metadata only: what exists, whether it works, and
   what is stopping it. No skill implementation is ever shipped to the
   browser, and no requirement value — a URL, a key, a path — is
   included in any response.
   ============================================================ */

export async function handleSkillsList(params) {
  const [skills, summary] = await Promise.all([
    listSkills({
      category: params.get('category') ?? undefined,
      query: params.get('q') ?? undefined,
      includeUnavailable: params.get('usable') === '1' ? false : undefined,
    }),
    skillSummary(),
  ])
  return { skills, summary }
}

export async function handleSkill(id) {
  const skill = await getSkill(id)
  if (!skill) throw new GatewayError('not_found', `No skill called "${id}".`, { status: 404 })
  return skill
}

/** `POST /api/skills/detect` — which skills a request needs. */
export async function handleDetect(body) {
  const text = String(body.text ?? '').slice(0, 4000)
  const result = await detectSkills({
    text,
    mode: String(body.mode ?? 'chat'),
    hasImages: body.hasImages === true,
    hasDocuments: body.hasDocuments === true,
  })

  // What those skills entitle the model to, so the caller can show it
  const { tools, missing } = await toolsForSkills(result.activated.map((s) => s.id))
  return { ...result, tools, missingTools: missing }
}

/** `POST /api/skills/:id/toggle` */
export async function handleToggle(id, body) {
  return setEnabled(id, body.enabled !== false)
}

export async function handleFavourite(id, body) {
  return setFavourite(id, body.favourite !== false)
}

export async function handleSettings(id, body) {
  return setSettings(id, body.settings ?? {})
}

/** `GET /api/skills/matrix` — the capability matrix, for the admin view. */
export async function handleMatrix() {
  return { matrix: await capabilityMatrix(), telemetry: telemetry() }
}

/** `POST /api/skills/context` — the prompt context a skill set contributes. */
export async function handleContext(body) {
  const ids = Array.isArray(body.skills) ? body.skills.slice(0, 20).map(String) : []
  return contextForSkills(ids, { maxChars: Math.min(Number(body.maxChars) || 8000, 20_000) })
}

/* ---------- custom skills ---------- */

export function handleCustomList() {
  return { skills: listCustomSkills() }
}

export function handleCustomCreate(body) {
  const skill = createCustomSkill(body)
  log.info('custom skill created via api', { id: skill.id })
  return skill
}

export function handleCustomUpdate(id, body) {
  return updateCustomSkill(id, body)
}

export function handleCustomRollback(id) {
  return rollbackCustomSkill(id)
}

export function handleCustomDelete(id) {
  return deleteCustomSkill(id)
}

/* ---------- external skills ---------- */

/**
 * `POST /api/skills/inspect` — examine a candidate skill directory.
 *
 * Reports what it contains and anything worth a look before it is trusted.
 * Nothing is executed, and the path is confined to the project.
 */
export function handleInspect(body) {
  const path = String(body.path ?? '').trim()
  if (!path) throw new GatewayError('bad_request', 'A path is required.', { status: 400 })

  // Confined to the project: this must not become a directory reader
  if (/^[a-zA-Z]:|^[/\\]|\.\./.test(path)) {
    throw new GatewayError('bad_request', 'Only a path inside the project may be inspected.', { status: 400 })
  }
  const result = inspectSkillDirectory(path)
  if (!result.ok) throw new GatewayError('bad_request', `That is not a skill directory (${result.reason}).`, { status: 400 })
  return result
}

/** `GET /api/skills/:id/resource?path=…` — read a data file a skill ships. */
export function handleResource(id, params) {
  const skillId = id.startsWith('ext:') ? id.slice(4) : id
  const path = params.get('path')
  if (!path) throw new GatewayError('bad_request', 'A resource path is required.', { status: 400 })

  const result = readSkillResource(skillId, path)
  if (!result.ok) {
    throw new GatewayError('bad_request', `That resource could not be read (${result.reason}).`, { status: 400 })
  }
  return result
}
