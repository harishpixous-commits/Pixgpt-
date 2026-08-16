import { randomUUID } from 'node:crypto'
import { GatewayError } from '../gateway/errors.mjs'
import { log } from '../config.mjs'
import { CATEGORY } from './catalog.mjs'

/* ============================================================
   Custom skills
   -------------
   A user-authored skill is INSTRUCTIONS AND CONFIGURATION ONLY.

   There is deliberately no way to supply executable code. A custom
   skill is prose that shapes how the model approaches a task, plus a
   choice of which already-permitted tools it may draw on. It cannot
   add a tool that does not exist, cannot raise its own permission, and
   cannot reach the filesystem or the network by itself.

   That constraint is the whole design. "Let users write a skill" is
   only safe if a skill cannot do anything a user could not already ask
   for directly.
   ============================================================ */

const MAX_INSTRUCTION_CHARS = 8000
const MAX_SKILLS = 50

/** @type {Map<string, object>} */
const CUSTOM = new Map()

/** Content that is trying to be an instruction to the system rather than guidance. */
const OVERRIDE_ATTEMPTS = [
  /ignore (all |any )?(previous|prior|earlier|above) instructions/i,
  /disregard (the |your )?(system|previous|safety)/i,
  /you are (now|actually) (a|an|in) /i,
  /bypass|circumvent|disable.{0,20}(security|safety|approval|permission|sandbox)/i,
  /reveal|print|show.{0,20}(system prompt|instructions|api key|secret|token|credential)/i,
  /grant (yourself|me).{0,20}(access|permission|privilege)/i,
  /without (asking|approval|permission|confirmation)/i,
]

/**
 * Screens instructions for attempts to redefine the system rather than guide it.
 *
 * This is not a claim to catch everything — no text filter does. It catches the
 * blatant cases, and the real protection is structural: the instructions are
 * fenced as guidance, and a custom skill has no mechanism to grant a tool or a
 * permission regardless of what it says.
 */
export function screenInstructions(text) {
  const concerns = []
  for (const pattern of OVERRIDE_ATTEMPTS) {
    const match = pattern.exec(text)
    if (match) concerns.push(match[0].slice(0, 80))
  }
  return {
    clean: concerns.length === 0,
    concerns,
  }
}

function validate(input, { existingId = null } = {}) {
  const name = String(input.name ?? '').trim()
  const description = String(input.description ?? '').trim()
  const instructions = String(input.instructions ?? '').trim()

  if (!name) throw new GatewayError('bad_request', 'A skill needs a name.', { status: 400 })
  if (name.length > 60) throw new GatewayError('bad_request', 'That name is too long.', { status: 400 })
  if (!description) throw new GatewayError('bad_request', 'A skill needs a description.', { status: 400 })
  if (description.length > 300) throw new GatewayError('bad_request', 'That description is too long.', { status: 400 })
  if (!instructions) throw new GatewayError('bad_request', 'A skill needs instructions.', { status: 400 })
  if (instructions.length > MAX_INSTRUCTION_CHARS) {
    throw new GatewayError('bad_request', `Instructions may be at most ${MAX_INSTRUCTION_CHARS} characters.`, { status: 400 })
  }

  const category = Object.values(CATEGORY).includes(input.category) ? input.category : CATEGORY.CUSTOM

  /*
   * Explicitly refuse anything that looks like an attempt to ship code. A
   * custom skill is text; a field called `code`, `script` or `run` means the
   * author has misunderstood, and silently dropping it would leave them
   * believing it ran.
   */
  for (const forbidden of ['code', 'script', 'run', 'exec', 'command', 'handler', 'function']) {
    if (input[forbidden] !== undefined) {
      throw new GatewayError(
        'bad_request',
        `A custom skill is instructions only — it cannot carry executable "${forbidden}". Describe what should happen and which tools to use.`,
        { status: 400 },
      )
    }
  }

  const screen = screenInstructions(instructions)

  const id = existingId ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${randomUUID().slice(0, 6)}`

  return {
    id,
    name,
    description,
    instructions,
    category,
    /** Advisory only. The registry intersects this with the real tool registry. */
    preferredTools: Array.isArray(input.preferredTools)
      ? input.preferredTools.map((t) => String(t).slice(0, 40)).slice(0, 12)
      : [],
    modelPreference: ['pixgpt-fast', 'pixgpt-pro', 'pixgpt-vision'].includes(input.modelPreference)
      ? input.modelPreference
      : null,
    enabled: input.enabled !== false,
    screen,
  }
}

export function listCustomSkills() {
  return [...CUSTOM.values()].map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    category: skill.category,
    preferredTools: skill.preferredTools,
    modelPreference: skill.modelPreference,
    enabled: skill.enabled,
    version: skill.version,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    warnings: skill.screen.clean ? [] : skill.screen.concerns,
  }))
}

export function createCustomSkill(input) {
  if (CUSTOM.size >= MAX_SKILLS) {
    throw new GatewayError('bad_request', `You can have at most ${MAX_SKILLS} custom skills.`, { status: 400 })
  }

  const validated = validate(input)
  const skill = {
    ...validated,
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  CUSTOM.set(skill.id, skill)

  log.info('custom skill created', {
    id: skill.id,
    category: skill.category,
    instructionChars: skill.instructions.length,
    concerns: skill.screen.concerns.length,
  })

  if (!skill.screen.clean) {
    log.warn('custom skill instructions contain override-style language', {
      id: skill.id,
      concerns: skill.screen.concerns.join(' | ').slice(0, 200),
    })
  }

  return listCustomSkills().find((s) => s.id === skill.id)
}

export function updateCustomSkill(id, input) {
  const existing = CUSTOM.get(id)
  if (!existing) throw new GatewayError('not_found', 'No such custom skill.', { status: 404 })

  const validated = validate({ ...existing, ...input }, { existingId: id })
  const [major, minor] = String(existing.version).split('.').map(Number)

  const skill = {
    ...validated,
    version: `${major}.${(minor ?? 0) + 1}.0`,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    previousVersion: { version: existing.version, instructions: existing.instructions, at: existing.updatedAt },
  }
  CUSTOM.set(id, skill)
  return listCustomSkills().find((s) => s.id === id)
}

/** Rolls back to the previous version. One step: this is not a history system. */
export function rollbackCustomSkill(id) {
  const existing = CUSTOM.get(id)
  if (!existing) throw new GatewayError('not_found', 'No such custom skill.', { status: 404 })
  if (!existing.previousVersion) {
    throw new GatewayError('bad_request', 'That skill has no previous version to roll back to.', { status: 400 })
  }

  CUSTOM.set(id, {
    ...existing,
    instructions: existing.previousVersion.instructions,
    version: existing.previousVersion.version,
    updatedAt: new Date().toISOString(),
    previousVersion: null,
  })
  log.info('custom skill rolled back', { id, to: existing.previousVersion.version })
  return listCustomSkills().find((s) => s.id === id)
}

export function deleteCustomSkill(id) {
  if (!CUSTOM.has(id)) throw new GatewayError('not_found', 'No such custom skill.', { status: 404 })
  CUSTOM.delete(id)
  return { ok: true, id }
}

/** Test seam. */
export function resetCustomSkills() {
  CUSTOM.clear()
}

export { MAX_INSTRUCTION_CHARS, MAX_SKILLS, OVERRIDE_ATTEMPTS }
