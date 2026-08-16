import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { log } from '../config.mjs'
import { GatewayError } from '../gateway/errors.mjs'

/* ============================================================
   Generation jobs
   ---------------
   Image and video generation takes anywhere from seconds to many
   minutes, so it cannot happen inside a chat request. A job is created,
   queued, and worked through by a bounded pool; the caller subscribes
   to its progress and the chat server stays responsive throughout.

   The queue matters more than it looks. Two large models running at
   once on one GPU do not run at half speed — they exhaust VRAM and
   both die. So concurrency is deliberately small and configurable.

   Progress is only ever reported from something the backend actually
   said. A synthetic percentage that creeps upward while nothing
   happens is worse than no percentage at all: it tells the user the
   job is fine when it may already be wedged.
   ============================================================ */

export const JOB_STATE = Object.freeze({
  QUEUED: 'queued',
  STARTING: 'starting',
  RUNNING: 'running',
  POST_PROCESSING: 'post_processing',
  QA: 'qa',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

/** States from which no further transition happens. */
const TERMINAL = new Set([JOB_STATE.COMPLETED, JOB_STATE.FAILED, JOB_STATE.CANCELLED])

const MAX_JOBS = Number.parseInt(process.env.MAX_GENERATION_JOBS ?? '', 10) || 200
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.GENERATION_WORKER_CONCURRENCY ?? '', 10) || 1)
const JOB_TTL_MS = Number.parseInt(process.env.GENERATION_JOB_TTL_MS ?? '', 10) || 2 * 3_600_000
const MAX_QUEUE = Number.parseInt(process.env.GENERATION_MAX_QUEUE ?? '', 10) || 24

/** @type {Map<string, object>} */
const JOBS = new Map()
/** @type {string[]} job ids waiting for a worker */
const QUEUE = []
let running = 0

export const jobEvents = new EventEmitter()
// Many clients may watch one job; the default cap of 10 is too low
jobEvents.setMaxListeners(100)

function prune() {
  const now = Date.now()
  for (const [id, job] of JOBS) {
    if (TERMINAL.has(job.state) && now - new Date(job.updatedAt).getTime() > JOB_TTL_MS) JOBS.delete(id)
  }
  while (JOBS.size > MAX_JOBS) {
    const oldestTerminal = [...JOBS.values()]
      .filter((j) => TERMINAL.has(j.state))
      .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))[0]
    if (!oldestTerminal) break
    JOBS.delete(oldestTerminal.id)
  }
}

/** The public shape of a job — never carries the raw output buffer. */
function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    stage: job.stage,
    provider: job.provider,
    model: job.model,
    request: job.publicRequest,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    queuePosition: job.state === JOB_STATE.QUEUED ? QUEUE.indexOf(job.id) + 1 : null,
    error: job.error,
    retries: job.retries,
    artifacts: job.artifacts,
    qa: job.qa,
    warnings: job.warnings,
    taskId: job.taskId,
    durationMs: job.completedAt ? new Date(job.completedAt) - new Date(job.startedAt ?? job.createdAt) : null,
  }
}

function emit(job) {
  job.updatedAt = new Date().toISOString()
  jobEvents.emit('update', publicJob(job))
  jobEvents.emit(`update:${job.id}`, publicJob(job))
}

/**
 * Creates a job and queues it.
 *
 * @param {{ kind: 'image'|'video', provider: string, model: string,
 *           publicRequest: object, run: Function, taskId?: string }} input
 */
export function createJob({ kind, provider, model, publicRequest, run, taskId = null }) {
  prune()
  if (QUEUE.length >= MAX_QUEUE) {
    throw new GatewayError('rate_limited', `The generation queue is full (${MAX_QUEUE} waiting). Try again shortly.`, {
      status: 429,
    })
  }

  const id = `gen_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const controller = new AbortController()

  const job = {
    id,
    kind,
    provider,
    model,
    publicRequest,
    run,
    taskId,
    state: JOB_STATE.QUEUED,
    progress: 0,
    stage: 'Queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
    retries: 0,
    artifacts: [],
    qa: null,
    warnings: [],
    controller,
  }

  JOBS.set(id, job)
  QUEUE.push(id)
  log.info('generation job queued', { id, kind, provider, model, queued: QUEUE.length, running })
  emit(job)

  // Kick the pump without blocking the caller
  setImmediate(pump)
  return publicJob(job)
}

/** The handle a provider uses to report what it is doing. */
function makeReporter(job) {
  return {
    signal: job.controller.signal,

    /**
     * @param {number|null} progress 0..1, or null when the backend does not say.
     *        Never invented: a made-up percentage hides a wedged job.
     */
    progress(progress, stage) {
      if (TERMINAL.has(job.state)) return
      if (job.state === JOB_STATE.STARTING) job.state = JOB_STATE.RUNNING
      if (typeof progress === 'number' && Number.isFinite(progress)) {
        job.progress = Math.max(0, Math.min(1, progress))
      }
      if (stage) job.stage = stage
      emit(job)
    },

    stage(stage, state) {
      if (TERMINAL.has(job.state)) return
      job.stage = stage
      if (state) job.state = state
      emit(job)
    },

    warn(message) {
      job.warnings.push(String(message).slice(0, 300))
    },
  }
}

async function execute(job) {
  job.state = JOB_STATE.STARTING
  job.startedAt = new Date().toISOString()
  job.stage = 'Starting'
  emit(job)

  try {
    const outcome = await job.run(makeReporter(job))

    if (job.controller.signal.aborted) {
      job.state = JOB_STATE.CANCELLED
      job.stage = 'Cancelled'
      job.completedAt = new Date().toISOString()
      emit(job)
      return
    }

    job.artifacts = outcome?.artifacts ?? []
    job.qa = outcome?.qa ?? null
    if (outcome?.warnings?.length) job.warnings.push(...outcome.warnings)

    job.state = JOB_STATE.COMPLETED
    job.progress = 1
    job.stage = 'Completed'
    job.completedAt = new Date().toISOString()

    log.info('generation job completed', {
      id: job.id,
      kind: job.kind,
      provider: job.provider,
      artifacts: job.artifacts.length,
      ms: new Date(job.completedAt) - new Date(job.startedAt),
    })
  } catch (error) {
    if (job.controller.signal.aborted) {
      job.state = JOB_STATE.CANCELLED
      job.stage = 'Cancelled'
    } else {
      job.state = JOB_STATE.FAILED
      job.stage = 'Failed'
      job.error = {
        code: error?.code ?? 'generation_failed',
        message: String(error?.message ?? 'Generation failed.').slice(0, 400),
        retryable: error?.retryable ?? false,
      }
      log.warn('generation job failed', { id: job.id, provider: job.provider, code: job.error.code, message: job.error.message })
    }
    job.completedAt = new Date().toISOString()
  } finally {
    emit(job)
  }
}

/** Starts as many queued jobs as the concurrency limit allows. */
function pump() {
  while (running < CONCURRENCY && QUEUE.length > 0) {
    const id = QUEUE.shift()
    const job = JOBS.get(id)
    if (!job || TERMINAL.has(job.state)) continue

    running++
    void execute(job).finally(() => {
      running--
      setImmediate(pump)
    })
  }

  // Queue positions shift when a job starts, so waiting clients are told
  for (const id of QUEUE) {
    const job = JOBS.get(id)
    if (job) jobEvents.emit(`update:${id}`, publicJob(job))
  }
}

export function getJob(id) {
  const job = JOBS.get(id)
  return job ? publicJob(job) : null
}

/** The raw artifacts, for the download route. Not part of the public shape. */
export function getJobInternal(id) {
  return JOBS.get(id) ?? null
}

export function listJobs({ taskId = null, limit = 50 } = {}) {
  return [...JOBS.values()]
    .filter((job) => !taskId || job.taskId === taskId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit)
    .map(publicJob)
}

/**
 * Cancels a job.
 *
 * A queued job is simply removed. A running one has its abort signal raised,
 * which the provider is expected to honour — and, for a backend with its own
 * queue, to propagate upstream so the remote work stops too.
 */
export function cancelJob(id) {
  const job = JOBS.get(id)
  if (!job) return { ok: false, reason: 'not_found' }
  if (TERMINAL.has(job.state)) return { ok: false, reason: `already_${job.state}` }

  const queuedAt = QUEUE.indexOf(id)
  if (queuedAt >= 0) QUEUE.splice(queuedAt, 1)

  job.controller.abort()
  job.state = JOB_STATE.CANCELLED
  job.stage = 'Cancelled'
  job.completedAt = new Date().toISOString()
  emit(job)

  log.info('generation job cancelled', { id, wasQueued: queuedAt >= 0 })
  return { ok: true, id, state: job.state }
}

/**
 * Retries a failed job.
 *
 * Only a failure the provider marked retryable is retried: a bad prompt, an
 * unsupported capability or a rejected key will fail identically next time, and
 * retrying them just burns the queue.
 */
export function retryJob(id) {
  const job = JOBS.get(id)
  if (!job) throw new GatewayError('not_found', 'That job does not exist.', { status: 404 })
  if (job.state !== JOB_STATE.FAILED) {
    throw new GatewayError('bad_request', `Only a failed job can be retried; this one is ${job.state}.`, { status: 400 })
  }
  if (!job.error?.retryable) {
    throw new GatewayError('bad_request', `That failure is not retryable (${job.error?.code}).`, { status: 400 })
  }
  if (job.retries >= 2) {
    throw new GatewayError('bad_request', 'That job has already been retried twice.', { status: 400 })
  }

  job.retries++
  job.state = JOB_STATE.QUEUED
  job.stage = 'Queued for retry'
  job.progress = 0
  job.error = null
  job.completedAt = null
  job.controller = new AbortController()

  QUEUE.push(id)
  emit(job)
  setImmediate(pump)

  log.info('generation job retried', { id, attempt: job.retries + 1 })
  return publicJob(job)
}

export function queueStats() {
  return {
    queued: QUEUE.length,
    running,
    concurrency: CONCURRENCY,
    total: JOBS.size,
    maxQueue: MAX_QUEUE,
    byState: [...JOBS.values()].reduce((acc, job) => {
      acc[job.state] = (acc[job.state] ?? 0) + 1
      return acc
    }, {}),
  }
}

/** Cancels everything, for shutdown. */
export function cancelAllJobs() {
  for (const [id, job] of JOBS) {
    if (!TERMINAL.has(job.state)) cancelJob(id)
  }
  QUEUE.length = 0
}

/** Test seam. */
export function resetJobs() {
  cancelAllJobs()
  JOBS.clear()
  running = 0
}

export { CONCURRENCY, MAX_QUEUE, TERMINAL, publicJob }
