import { ensureWorkspace, removeWorkspace, workspaceExists } from './workspace.mjs'
import { GatewayError } from '../gateway/errors.mjs'

/* ============================================================
   Task registry
   -------------
   In-memory state for running agent tasks: the plan, the changed
   files, pending command approvals, and the resolver each waiting
   command is parked on.

   In-memory on purpose. A task is tied to a live SSE connection and
   a workspace on local disk; persisting it to a database would add a
   dependency PixGPT does not have, for state that does not outlive
   the process. The *workspace* survives a restart — the in-flight
   run does not, and is resumed by starting a new run against the
   same task id.
   ============================================================ */

const TASKS = new Map()
const MAX_TASKS = 50
const APPROVAL_TIMEOUT_MS = Number.parseInt(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? '', 10) || 120_000

export function createTask({ objective, taskId } = {}) {
  if (TASKS.size >= MAX_TASKS) {
    // Drop the oldest finished task rather than refusing outright
    const stale = [...TASKS.entries()].find(([, t]) => t.status !== 'running')
    if (stale) TASKS.delete(stale[0])
  }
  const ws = ensureWorkspace(taskId)
  const task = {
    taskId: ws.taskId,
    projectDir: ws.projectDir,
    objective: String(objective ?? '').slice(0, 8000),
    status: 'created',
    plan: [],
    changedFiles: [],
    commands: [],
    /** command key -> { resolve, timer } for a command awaiting approval */
    waiting: new Map(),
    /** command key (or "prog *") -> true */
    approved: new Set(),
    denied: new Set(),
    createdAt: Date.now(),
    finished: null,
    error: null,
  }
  TASKS.set(task.taskId, task)
  return task
}

export function getTask(taskId) {
  const task = TASKS.get(taskId)
  if (!task) throw new GatewayError('bad_request', 'Unknown task.', { status: 404 })
  return task
}

export function findTask(taskId) {
  return TASKS.get(taskId) ?? null
}

export function listTasks() {
  return [...TASKS.values()].map((t) => ({
    taskId: t.taskId,
    objective: t.objective.slice(0, 160),
    status: t.status,
    plan: t.plan,
    files: t.changedFiles.length,
    createdAt: t.createdAt,
  }))
}

export function deleteTask(taskId, { removeFiles = false } = {}) {
  const task = TASKS.get(taskId)
  if (task) {
    for (const { timer } of task.waiting.values()) clearTimeout(timer)
    TASKS.delete(taskId)
  }
  if (removeFiles && workspaceExists(taskId)) removeWorkspace(taskId)
  return { taskId, removed: true }
}

/* ---------- approval ---------- */

export const APPROVAL = { ONCE: 'once', TASK: 'task', DENY: 'deny' }

/**
 * Parks a command until the user decides, or the timeout expires.
 * @returns {Promise<{ approved: boolean, reason?: string }>}
 */
export function awaitApproval(task, key) {
  if (task.denied.has(key)) return Promise.resolve({ approved: false, reason: 'The user denied this command.' })
  if (task.approved.has(key)) return Promise.resolve({ approved: true })

  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      task.waiting.delete(key)
      resolvePromise({ approved: false, reason: 'No approval was given in time.' })
    }, APPROVAL_TIMEOUT_MS)

    task.waiting.set(key, {
      resolve: (outcome) => {
        clearTimeout(timer)
        task.waiting.delete(key)
        resolvePromise(outcome)
      },
      timer,
    })
  })
}

/** Applies a user decision to a parked command. */
export function resolveApproval(taskId, { command, program, decision }) {
  const task = getTask(taskId)
  const key = String(command ?? '').trim()
  if (!key) throw new GatewayError('bad_request', 'A command is required.', { status: 400 })

  if (decision === APPROVAL.DENY) {
    task.denied.add(key)
    task.waiting.get(key)?.resolve({ approved: false, reason: 'The user denied this command.' })
    return { command: key, decision }
  }
  if (decision === APPROVAL.TASK) {
    // Whole-program approval for the rest of this task
    task.approved.add(`${program ?? key.split(' ')[0]} *`)
  }
  task.approved.add(key)
  task.waiting.get(key)?.resolve({ approved: true })
  return { command: key, decision }
}

export function isApprovedKey(task, key, program) {
  return task.approved.has(key) || task.approved.has(`${program} *`)
}
