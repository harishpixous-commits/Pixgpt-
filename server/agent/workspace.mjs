import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GatewayError } from '../gateway/errors.mjs'

/* ============================================================
   Agent workspace — the security boundary
   ---------------------------------------
   Every coding task gets its own directory under WORKSPACE_ROOT.
   Nothing the agent does may reach outside it: not file reads, not
   writes, not the working directory of a command.

       .pixgpt-workspaces/
         <taskId>/
           project/     <- the agent's world

   The containment check resolves symlinks with realpath before
   comparing, because `resolve()` alone is fooled by a symlink
   pointing at C:\ or /etc. Anything that escapes is refused, not
   clamped — silently rewriting a path would hide an attack.
   ============================================================ */

const ROOT = resolve(process.env.WORKSPACE_ROOT ?? join(process.cwd(), '.pixgpt-workspaces'))

/** Directories an agent must never be able to touch, even via a symlink. */
const FORBIDDEN_ROOTS = [
  process.cwd(), // PixGPT's own source — the workspace lives *under* it but is allowed explicitly
]

function forbidden(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

export function workspaceRoot() {
  return ROOT
}

function ensureRoot() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true })
  return realpathSync(ROOT)
}

/* ---------- task lifecycle ---------- */

export function newTaskId() {
  return `task_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * Creates (or returns) the isolated project directory for a task.
 * @returns {{ taskId: string, dir: string, projectDir: string }}
 */
export function ensureWorkspace(taskId = newTaskId()) {
  if (!/^task_[a-z0-9]{6,32}$/.test(taskId)) throw forbidden('Invalid task id.')
  const realRoot = ensureRoot()
  const dir = join(realRoot, taskId)
  const projectDir = join(dir, 'project')
  mkdirSync(projectDir, { recursive: true })
  return { taskId, dir, projectDir }
}

/**
 * Where the agent keeps its own working artefacts — screenshots, throwaway
 * browser profiles.
 *
 * Deliberately a sibling of `project`, not a directory inside it. A Chrome
 * profile is tens of megabytes: kept under the project it would count against
 * the workspace size limit, be listed as project files, and end up inside the
 * ZIP the user downloads. None of it is their code.
 *
 * @param {string} projectDir  the task's project directory
 */
export function artifactsDir(projectDir) {
  const dir = join(projectDir, '..', 'artifacts')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function workspaceExists(taskId) {
  if (!/^task_[a-z0-9]{6,32}$/.test(taskId)) return false
  return existsSync(join(ROOT, taskId, 'project'))
}

export function listWorkspaces() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT).filter((n) => /^task_[a-z0-9]{6,32}$/.test(n))
}

/** Deletes a task workspace. Only ever a directory directly under ROOT. */
export function removeWorkspace(taskId) {
  if (!/^task_[a-z0-9]{6,32}$/.test(taskId)) throw forbidden('Invalid task id.')
  const target = join(ensureRoot(), taskId)
  // Belt and braces: refuse anything that is not exactly one level under ROOT
  if (relative(ensureRoot(), target).includes(sep)) throw forbidden('Refusing to delete outside the workspace root.')
  rmSync(target, { recursive: true, force: true })
}

/* ---------- path containment ---------- */

/**
 * Resolves a caller-supplied relative path inside `projectDir`.
 *
 * Refuses: absolute paths, `..` escapes, and symlinks whose real target lands
 * outside the project. `mustExist: false` still validates the *parent*, so a
 * write cannot create a file outside the sandbox.
 *
 * @returns {string} an absolute, verified-contained path
 */
export function resolveInside(projectDir, relPath, { mustExist = false } = {}) {
  if (typeof relPath !== 'string' || relPath.length === 0) throw forbidden('A file path is required.')
  if (relPath.length > 400) throw forbidden('That path is too long.')
  if (relPath.includes('\u0000')) throw forbidden('That path is not valid.')
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw forbidden('Absolute paths are not allowed — use a path relative to the project.')
  }

  const base = realpathSync(projectDir)
  const target = resolve(base, normalize(relPath))

  // Verify against the real path of whichever ancestor exists, so a symlinked
  // directory cannot smuggle the target outside the sandbox.
  let probe = target
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..')
    if (parent === probe) break
    probe = parent
  }
  const realProbe = existsSync(probe) ? realpathSync(probe) : probe
  const rel = relative(base, realProbe)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw forbidden('That path is outside the task workspace.')
  }

  for (const root of FORBIDDEN_ROOTS) {
    // The workspace itself lives under cwd, so only refuse paths that are under
    // a forbidden root *and* not under the workspace.
    const insideForbidden = !relative(root, realProbe).startsWith('..')
    const insideWorkspace = !relative(ensureRoot(), realProbe).startsWith('..')
    if (insideForbidden && !insideWorkspace) {
      throw forbidden('That path is outside the task workspace.')
    }
  }

  if (mustExist && !existsSync(target)) throw forbidden(`Not found: ${relPath}`)
  return target
}

/** Relative, forward-slashed path for display and for the model. */
export function displayPath(projectDir, absPath) {
  return relative(projectDir, absPath).split(sep).join('/')
}

/** Total bytes used by a workspace, so a runaway task can be capped. */
export function workspaceSize(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          total += statSync(p).size
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  walk(dir)
  return total
}
