import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config, log } from './config.mjs'
import { GatewayError } from './gateway/errors.mjs'
import { aliasCapabilities, describeGateway, getGateway, modelSupportsVision } from './gateway/index.mjs'
import { imageLimits } from './multimodal.mjs'
import { renderSearchContext, runSearch, searchAvailable, searchStatus } from './websearch.mjs'
import { chatSystemPrompt } from './chat-prompt.mjs'
import { runAgent } from './agent/loop.mjs'
import { APPROVAL, awaitApproval, createTask, deleteTask, getTask, listTasks, resolveApproval } from './agent/tasks.mjs'
import { zipProject } from './agent/zip.mjs'
import { projectTree } from './agent/files.mjs'
import { artifactsDir } from './agent/workspace.mjs'
import { IMPORT_LIMITS, extractZip } from './agent/unzip.mjs'
import { analyseProject } from './agent/analyze.mjs'
import { SCREENSHOT_DIR, closeAllBrowsers, closeBrowser } from './agent/browser.mjs'
import { previewCount, stopAllPreviews, stopPreview } from './agent/preview.mjs'
import { getArtifact } from './artifacts.mjs'
import { FORMATS } from './docgen/index.mjs'
import {
  MAX_PDF_UPLOAD_BYTES,
  handleDocumentCompose,
  handleDocumentGenerate,
  handlePdfEdit,
  handlePdfInspect,
  handlePdfModify,
} from './docroutes.mjs'
import {
  handleReadPage,
  handleResearch,
  handleResearchReport,
  handleSearch,
  handleSearchProviders,
  handleSearchReset,
  handleSearchStatus,
} from './searchroutes.mjs'
import { visionStatus } from './vision-router.mjs'
import {
  handleContext,
  handleCustomCreate,
  handleCustomDelete,
  handleCustomList,
  handleCustomRollback,
  handleCustomUpdate,
  handleDetect,
  handleFavourite,
  handleInspect,
  handleMatrix,
  handleResource,
  handleSettings,
  handleSkill,
  handleSkillsList,
  handleToggle,
} from './skillroutes.mjs'
import {
  handleBest,
  handleModelDetail,
  handleProviders,
  handleProviderProbe,
  handleModelHealth,
  handleProbe,
  handleRecommended,
  handleRefresh,
  handleRegistry,
  handleSelect,
} from './modelroutes.mjs'
import { ensureDiscovered, getModel as getModelRecord, installModelRouting, persist as persistModels, registryState } from './models/index.mjs'
import { generateImageJob, generateVideoJob, generationStatus, listBackends } from './generation/index.mjs'
import { cancelAllJobs, cancelJob, getJob, jobEvents, listJobs, queueStats, retryJob } from './generation/jobs.mjs'
import { check as checkRateLimit, clientKey, rateLimitConfig } from './rate-limit.mjs'
import {
  LIMITS,
  clampMaxTokens,
  clampTemperature,
  toWireMessages,
  validateModel,
  validateStream,
  validateTools,
} from './validate.mjs'

const DIST = resolve(process.cwd(), 'dist')
const MAX_BODY_BYTES = LIMITS.bodyBytes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

/* ---------- helpers ---------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, res) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    let rejected = false
    const chunks = []
    req.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejected = true
        // Stop reading, but do NOT destroy the socket yet — the client needs to
        // receive the 413 rather than a bare connection reset. The rest of the
        // upload is discarded once the response has flushed.
        req.pause()
        res?.once('finish', () => req.destroy())
        reject(new GatewayError('bad_request', 'Request body is too large.', { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new GatewayError('bad_request', 'Request body is not valid JSON.', { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Reads a binary body (an uploaded archive). Separate from readBody because that
 * one parses JSON and enforces the much smaller JSON body limit.
 */
function readRawBody(req, limitBytes) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    let rejected = false
    const chunks = []
    req.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > limitBytes) {
        rejected = true
        req.pause()
        reject(
          new GatewayError('bad_request', `The upload exceeds ${Math.round(limitBytes / 1048576)} MB.`, { status: 413 }),
        )
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolvePromise(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/**
 * Reads a JSON body with a larger ceiling than readBody's.
 * A PDF arrives base64-encoded inside JSON, which is far bigger than any chat
 * payload, so it gets its own limit rather than raising the limit for everything.
 */
async function readJsonBody(req, limitBytes) {
  const raw = await readRawBody(req, limitBytes)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new GatewayError('bad_request', 'Request body is not valid JSON.', { status: 400 })
  }
}

/** Serves a generated document. */
function handleArtifactDownload(req, res, id) {
  const artifact = getArtifact(id)
  res.writeHead(200, {
    'Content-Type': artifact.mime,
    'Content-Length': artifact.buffer.length,
    // RFC 5987 form as well, so non-ASCII titles survive
    'Content-Disposition': `attachment; filename="${artifact.filename.replace(/[^\w. -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (req.method === 'HEAD') return res.end()
  res.end(artifact.buffer)
}

/* ---------- API routes ---------- */

async function handleHealth(req, res) {
  const { id, adapter, client } = getGateway()
  const health = await client.checkHealth()
  // 200 either way: this endpoint reports status, its own success is not the news.
  // Shape is unchanged from the single-gateway version so the existing frontend
  // keeps working; `name`/`label`/`capabilities` are additive.
  sendJson(res, 200, {
    ok: health.ok,
    gateway: {
      name: id,
      label: adapter.label,
      reachable: health.reachable,
      authenticated: health.authenticated,
      code: health.code,
      baseUrl: health.baseUrl,
      capabilities: adapter.capabilities,
    },
  })
}

/** Unified gateway status endpoint. Never returns keys or credentials. */
async function handleAiHealth(req, res) {
  const { id, adapter, client, configProblems } = getGateway()
  const health = await client.checkHealth()
  sendJson(res, 200, {
    gateway: id,
    label: adapter.label,
    // Incomplete configuration is never "online", even if the host answers
    status: configProblems.length > 0 ? 'degraded' : health.ok ? 'online' : health.reachable ? 'degraded' : 'offline',
    reachable: health.reachable,
    authenticated: health.authenticated,
    code: health.code,
    capabilities: adapter.capabilities,
    webSearch: searchStatus(),
    ...(configProblems.length > 0 ? { configProblems } : {}),
  })
}

async function handleModels(req, res, signal) {
  const { id, adapter, client, config: gwConfig } = getGateway()
  const base = {
    gateway: id,
    aliases: gwConfig.modelAliases,
    capabilities: adapter.capabilities,
    // Per-alias capability so the UI can gate image attachment on the actual
    // selected model rather than on the gateway's broadest claim.
    modelCapabilities: aliasCapabilities(),
    webSearch: searchStatus(),
    imageLimits: {
      maxImageBytes: imageLimits.maxImageBytes,
      maxImagesPerMessage: imageLimits.maxImagesPerMessage,
      allowedTypes: imageLimits.mimeAllowlist,
    },
  }

  // Some gateways (Higress, Portkey) expose no OpenAI model catalogue at all
  if (!adapter.capabilities.models) {
    sendJson(res, 200, { ...base, models: [], catalogue: 'unsupported' })
    return
  }
  try {
    const models = await client.listModels(signal)
    /*
     * The flat `models` array is kept exactly as it was — existing clients read
     * it — and the registry summary is added alongside. Populating the registry
     * here means the first page load discovers the catalogue without a separate
     * round trip, and costs nothing extra: the fetch already happened.
     */
    await ensureDiscovered({ signal }).catch(() => null)
    sendJson(res, 200, { ...base, models, registry: registryState() })
  } catch (error) {
    const e = error instanceof GatewayError ? error : new GatewayError('provider_error', 'Could not list models.')
    log.warn('model list failed', { gateway: id, code: e.code, detail: e.detail })
    // Aliases still work even when the catalogue cannot be read
    sendJson(res, 200, { ...base, models: [], error: { code: e.code, message: e.message } })
  }
}

/**
 * Routing metadata safe to send to a browser (sections 43, 44).
 *
 * The task class, the family, and whether a fallback happened. Not the chain,
 * not the scores, not the base URL — a user does not need this server's routing
 * table to understand their answer, and publishing it would leak the shape of
 * the deployment.
 */
function safeRouting(result) {
  if (!result?.routing && !result?.fellBack) return undefined
  // `routedTo` is the catalogue id; `result.model` is the provider's own name
  const model = registryState().total > 0 ? describeModelSafely(result.routedTo ?? result.model) : null
  return {
    task: result.routing?.task ?? null,
    taskLabel: result.routing?.task ? String(result.routing.task).replace(/^BEST_/, '').replace(/_/g, ' ').toLowerCase() : null,
    why: result.routing?.why ?? null,
    fallbackUsed: Boolean(result.fellBack),
    family: model?.family ?? null,
    verification: model?.verification ?? null,
  }
}

function describeModelSafely(id) {
  try {
    return getModelRecord(id)
  } catch {
    return null
  }
}

async function handleChat(req, res, signal, requestId) {
  const { id: gateway, adapter, client } = getGateway()

  // Rate limit before doing any upstream work
  const limit = checkRateLimit(clientKey(req))
  if (!limit.allowed) {
    log.warn('rate limited', { requestId, gateway, retryAfterSec: limit.retryAfterSec })
    res.setHeader('Retry-After', String(limit.retryAfterSec))
    throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
  }

  const body = await readBody(req, res)
  const model = validateModel(body.model)
  const { messages, images, files } = await toWireMessages(body.messages, {
    visionAllowed: modelSupportsVision(model),
    gatewaySupportsVision: adapter.capabilities.vision,
    modelLabel: model && !model.startsWith('pixgpt-') ? model : 'The selected model',
  })
  const temperature = clampTemperature(body.temperature)
  const maxTokens = clampMaxTokens(body.max_tokens ?? body.maxTokens)
  const tools = validateTools(body.tools)
  const wantsStream = validateStream(body.stream)
  const started = Date.now()

  if (wantsStream && !adapter.capabilities.streaming) {
    throw new GatewayError('unsupported', `${adapter.label} does not support streaming.`, { status: 501 })
  }

  /*
   * Routing context. The registry uses it to classify the task and rank
   * candidates; it never leaves the server and never reaches a model.
   *
   * `routingText` is the last user turn only. Passing the whole transcript
   * would let a long conversation's early wording decide the model for a
   * request that has since moved on to something else.
   */
  const lastUserTurn = [...messages].reverse().find((m) => m.role === 'user')
  const routingText =
    typeof lastUserTurn?.content === 'string'
      ? lastUserTurn.content
      : (lastUserTurn?.content ?? []).find((p) => p.type === 'text')?.text ?? ''

  // The internal request shape every adapter receives
  const request = {
    model,
    messages,
    temperature,
    maxTokens,
    tools,
    requiresVision: images > 0,
    routingText,
    routingMode: typeof body.mode === 'string' ? body.mode : undefined,
    // Four characters per token is rough, but it only has to separate "fits
    // anywhere" from "needs a long-context route", and for that it is enough.
    estimatedTokens: Math.ceil(
      messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4,
    ),
  }

  /*
   * Capability grounding. Without it the model is told nothing about the product
   * it is answering as, and a vision model asked to edit an attached image
   * assumes it can emit one — replying with a lead-in ("Please", "Here is the
   * updated logo:") for a picture PixGPT never requested and cannot return. The
   * text is derived from live capability flags, so it stays true if a generative
   * backend is added later. Callers that supply their own system turn keep it.
   */
  const hasOwnSystemTurn = messages.some((m) => m.role === 'system')
  if (!hasOwnSystemTurn) {
    request.messages = [
      { role: 'system', content: await chatSystemPrompt({ webSearch: searchAvailable() }) },
      ...messages,
    ]
  }

  /**
   * Web grounding. Opt-in per request: the user enables it in the composer.
   * The server chooses the query (the last user turn) and performs every fetch —
   * the model never receives network access.
   */
  let sources = []
  if (body.web === true) {
    if (!searchAvailable()) {
      throw new GatewayError('unsupported', 'Web search is not configured on this server.', { status: 501 })
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const query = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content ?? []).find((p) => p.type === 'text')?.text ?? ''

    const found = await runSearch(query, { signal })
    sources = found.sources
    if (found.context) {
      /*
       * Appended after the capability prompt rather than replacing the message
       * list, so grounding context and the capability rules coexist — building
       * from `messages` here would drop the system turn added just above.
       */
      request.messages = [
        ...request.messages.filter((m) => m.role === 'system'),
        { role: 'system', content: renderSearchContext(query, found.context) },
        ...messages.filter((m) => m.role !== 'system'),
      ]
    }
    log.info('web grounding applied', { requestId, sources: sources.length })
  }

  log.info('chat request', {
    requestId,
    gateway,
    model,
    resolved: client.modelChain(model)[0],
    messages: messages.length,
    chars: messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
    images: images || undefined,
    files: files || undefined,
    stream: wantsStream,
  })

  if (!wantsStream) {
    const result = await client.completion(request, signal)
    log.info('chat complete', {
      sources: sources.length || undefined,
      requestId,
      gateway,
      model: result.model,
      ms: Date.now() - started,
      fellBack: result.fellBack,
      outcome: 'success',
    })
    sendJson(res, 200, {
      content: result.content,
      model: result.model,
      gateway,
      fellBack: result.fellBack,
      /* The model stopped at its output ceiling; the answer is incomplete. */
      truncated: Boolean(result.truncated),
      routing: safeRouting(result),
      ...(sources.length > 0 ? { sources } : {}),
    })
    return
  }

  // --- streaming ---
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stops reverse proxies from buffering the stream into one blob
    'X-Accel-Buffering': 'no',
  })
  // Flush headers immediately so the browser opens the stream
  res.flushHeaders?.()

  const send = (event) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // Citations first, so the UI can show them while the answer streams. Only
  // emitted when real results were actually retrieved.
  for (const s of sources) {
    send({ type: 'source', title: s.title, url: s.url })
  }

  try {
    const result = await client.streamCompletion(
      request,
      signal,
      (token) => send({ type: 'token', value: token }),
      (actual) => send({ type: 'model', value: actual }),
    )
    send({
      type: 'done',
      model: result.model,
      gateway,
      fellBack: result.fellBack,
      truncated: Boolean(result.truncated),
      routing: safeRouting(result),
    })
    log.info('stream complete', {
      requestId,
      gateway,
      model: result.model,
      chars: result.streamed,
      ms: Date.now() - started,
      fellBack: result.fellBack,
      outcome: 'success',
    })
  } catch (error) {
    if (error?.code === 'client_closed') {
      log.debug('client disconnected mid-stream', { requestId, ms: Date.now() - started })
      return
    }
    const e = error instanceof GatewayError ? error : new GatewayError('provider_error', 'The request failed.')
    log.warn('stream error', {
      requestId,
      gateway,
      code: e.code,
      detail: e.detail,
      ms: Date.now() - started,
      outcome: 'error',
    })
    // Headers are already sent, so the failure travels as an SSE event
    send({ type: 'error', code: e.code, message: e.message, requestId })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

/* ---------- agent (Build mode) ---------- */

/**
 * Runs one coding task, streaming progress as SSE.
 *
 * The agent works only inside its own workspace; see agent/workspace.mjs for the
 * containment rules and agent/terminal.mjs for the command policy.
 */
async function handleAgentRun(req, res, signal, requestId) {
  const body = await readBody(req, res)
  const objective = String(body.objective ?? '').trim()
  if (!objective) throw new GatewayError('bad_request', 'An objective is required.', { status: 400 })
  if (objective.length > 8000) throw new GatewayError('bad_request', 'That objective is too long.', { status: 400 })

  const model = validateModel(body.model) ?? 'pixgpt-pro'
  const task = createTask({ objective, taskId: body.taskId })
  task.status = 'running'

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const send = (event) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}

`)
  }

  send({ type: 'task', taskId: task.taskId, requestId })
  log.info('agent run start', { requestId, taskId: task.taskId, model })

  try {
    const result = await runAgent({
      objective,
      projectDir: task.projectDir,
      taskId: task.taskId,
      model,
      signal,
      emit: (event) => {
        if (event.type === 'plan') task.plan = event.steps
        if (event.type === 'file_change') task.changedFiles.push({ path: event.path, action: event.action })
        send(event)
      },
      onApproval: (entry) => awaitApproval(task, entry.command),
    })

    task.status = result.error ? 'error' : 'done'
    task.finished = result.finished
    task.commands = result.commands

    send({
      type: 'done',
      taskId: task.taskId,
      plan: result.plan,
      changedFiles: result.changedFiles,
      commands: result.commands,
      finished: result.finished,
      iterations: result.iterations,
      durationMs: result.durationMs,
      // Only offer a download when files actually exist
      downloadable: result.changedFiles.length > 0,
    })
  } catch (error) {
    task.status = 'error'
    const e = error instanceof GatewayError ? error : new GatewayError('internal_error', 'The task failed.')
    task.error = e.code
    log.warn('agent run failed', { requestId, taskId: task.taskId, code: e.code, detail: e.detail })
    send({ type: 'error', code: e.code, message: e.message, requestId })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

/** Approve or deny a command the agent is parked on. */
async function handleAgentApprove(req, res) {
  const body = await readBody(req, res)
  const taskId = String(body.taskId ?? '')
  const decision = String(body.decision ?? '')
  if (![APPROVAL.ONCE, APPROVAL.TASK, APPROVAL.DENY].includes(decision)) {
    throw new GatewayError('bad_request', 'decision must be "once", "task" or "deny".', { status: 400 })
  }
  const outcome = resolveApproval(taskId, { command: body.command, program: body.program, decision })
  log.info('agent approval', { taskId, decision, command: String(body.command ?? '').slice(0, 120) })
  sendJson(res, 200, { ok: true, ...outcome })
}

/** Task state, so a reconnecting client can show where things stand. */
function handleAgentTask(req, res, taskId) {
  const task = getTask(taskId)
  sendJson(res, 200, {
    taskId: task.taskId,
    status: task.status,
    objective: task.objective.slice(0, 400),
    plan: task.plan,
    changedFiles: task.changedFiles,
    commands: task.commands,
    finished: task.finished,
    error: task.error,
    tree: projectTree(task.projectDir).tree,
    pendingApprovals: [...task.waiting.keys()],
  })
}

/** Streams the finished project as a ZIP. */
function handleAgentZip(req, res, taskId) {
  const task = getTask(taskId)
  const { buffer, entries, skipped } = zipProject(task.projectDir, {
    rootName: (task.objective.match(/[a-z0-9][a-z0-9 -]{2,40}/i)?.[0] ?? 'project')
      .trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'project',
  })
  log.info('agent zip', { taskId, entries, bytes: buffer.length, skipped: skipped.length })
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${taskId}.zip"`,
    'Cache-Control': 'no-store',
  })
  res.end(buffer)
}

/**
 * Serves a screenshot the agent captured, so the user sees exactly what the
 * vision model saw. The name is matched against a strict pattern and resolved
 * inside the task's screenshot directory — a task id cannot be used to read
 * arbitrary files.
 */
function handleAgentScreenshot(req, res, taskId, name) {
  const task = getTask(taskId)
  if (!/^[\w.-]{1,80}\.png$/.test(name) || name.includes('..')) {
    return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid screenshot name.' } })
  }
  const dir = resolve(artifactsDir(task.projectDir), SCREENSHOT_DIR)
  const file = resolve(dir, name)
  if (file !== join(dir, name) || !existsSync(file)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'That screenshot does not exist.' } })
  }
  const { size } = statSync(file)
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': size,
    // Screenshot names are unique per capture, so they can be cached hard
    'Cache-Control': 'private, max-age=3600',
  })
  createReadStream(file).pipe(res)
}

/**
 * Imports an uploaded ZIP into a fresh task workspace, so the agent can work on
 * an existing codebase. The body is the raw archive.
 */
async function handleAgentImport(req, res, requestId) {
  const archive = await readRawBody(req, IMPORT_LIMITS.archiveBytes)
  const task = createTask({ objective: 'Imported project', model: null })
  let result
  try {
    result = extractZip(archive, task.projectDir)
  } catch (error) {
    // A rejected archive leaves no workspace behind
    deleteTask(task.taskId, { removeFiles: true })
    throw error
  }
  const analysis = await analyseProject(task.projectDir)
  log.info('agent import', { requestId, taskId: task.taskId, files: result.files, skipped: result.skippedTotal })
  sendJson(res, 200, {
    taskId: task.taskId,
    files: result.files,
    bytes: result.bytes,
    skipped: result.skipped,
    skippedTotal: result.skippedTotal,
    stripped: result.stripped,
    tree: projectTree(task.projectDir).tree,
    analysis,
  })
}

/**
 * Streams a generation job's progress as Server-Sent Events.
 *
 * A generation takes long enough that polling is wasteful and silence looks
 * like a hang, so the client subscribes and gets each state change as it
 * happens.
 */
function watchJob(req, res, jobId) {
  const initial = getJob(jobId)
  if (!initial) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'That job does not exist.' } })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const send = (job) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(job)}

`)
  }
  send(initial)

  if (['completed', 'failed', 'cancelled'].includes(initial.state)) {
    return res.end()
  }

  const onUpdate = (job) => {
    send(job)
    if (['completed', 'failed', 'cancelled'].includes(job.state)) {
      jobEvents.off(`update:${jobId}`, onUpdate)
      if (!res.writableEnded) res.end()
    }
  }
  jobEvents.on(`update:${jobId}`, onUpdate)

  // A client that walks away must not leak a listener
  req.on('close', () => jobEvents.off(`update:${jobId}`, onUpdate))
}

/* ---------- static (production) ---------- */

function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    sendJson(res, 404, {
      error: {
        code: 'not_built',
        message: 'No production build found. Run `npm run build`, or use `npm run dev` for development.',
      },
    })
    return
  }

  // Contain the path inside dist/ — normalize first, then verify
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(DIST, safePath)
  if (!filePath.startsWith(DIST)) {
    sendJson(res, 403, { error: { code: 'forbidden', message: 'Forbidden.' } })
    return
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST, 'index.html') // SPA fallback
  }
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } })
    return
  }

  const ext = extname(filePath)
  const isHashed = /-[A-Za-z0-9_-]{8,}\./.test(filePath)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(filePath).pipe(res)
}

/* ---------- server ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const { pathname } = url

  // Bridge the socket lifetime to an AbortSignal so an upstream request is
  // cancelled the moment the browser goes away (user pressed Stop, tab closed).
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })

  // One id per request, echoed in logs and error payloads so a user-reported
  // failure can be traced to its log lines without guessing.
  const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  if (pathname.startsWith('/api/')) res.setHeader('X-Request-Id', requestId)

  try {
    if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(req, res)
    if (pathname === '/api/ai/health' && req.method === 'GET') return await handleAiHealth(req, res)
    if (pathname === '/api/models' && req.method === 'GET') return await handleModels(req, res, abort.signal)

    /* ---- model discovery, ranking and probing ---- */
    if (pathname === '/api/models/registry' && req.method === 'GET') {
      return sendJson(res, 200, await handleRegistry(Object.fromEntries(url.searchParams), abort.signal))
    }
    if (pathname === '/api/models/recommended' && req.method === 'GET') {
      return sendJson(res, 200, await handleRecommended(Object.fromEntries(url.searchParams), abort.signal))
    }
    if (pathname === '/api/models/best' && req.method === 'GET') {
      return sendJson(res, 200, await handleBest(abort.signal))
    }
    if (pathname === '/api/models/health' && req.method === 'GET') {
      return sendJson(res, 200, await handleModelHealth(abort.signal))
    }
    if (pathname === '/api/models/refresh' && req.method === 'POST') {
      return sendJson(res, 200, await handleRefresh(abort.signal))
    }
    if (pathname === '/api/models/probe' && req.method === 'POST') {
      const body = await readJsonBody(req, MAX_BODY_BYTES)
      return sendJson(res, 200, await handleProbe(body, abort.signal, req))
    }
    if (pathname === '/api/models/providers' && req.method === 'GET') {
      return sendJson(res, 200, await handleProviders(abort.signal))
    }
    {
      const m = pathname.match(/^\/api\/models\/providers\/([a-z0-9-]{2,24})\/probe$/)
      if (m && req.method === 'POST') {
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        return sendJson(res, 200, await handleProviderProbe(m[1], body, abort.signal, req))
      }
    }
    if (pathname === '/api/models/select' && req.method === 'POST') {
      const body = await readJsonBody(req, MAX_BODY_BYTES)
      return sendJson(res, 200, await handleSelect(body, abort.signal))
    }
    /*
     * Last of the /api/models routes: the id may itself contain a slash
     * (`aug/opus4.8`), so this has to come after the fixed sub-paths or it
     * would swallow them.
     */
    if (pathname.startsWith('/api/models/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/models/'.length))
      return sendJson(res, 200, await handleModelDetail(id, abort.signal))
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res, abort.signal, requestId)
    }

    if (pathname === '/api/agent/run' && req.method === 'POST') {
      return await handleAgentRun(req, res, abort.signal, requestId)
    }
    if (pathname === '/api/agent/approve' && req.method === 'POST') {
      return await handleAgentApprove(req, res)
    }
    if (pathname === '/api/agent/tasks' && req.method === 'GET') {
      return sendJson(res, 200, { tasks: listTasks() })
    }
    if (pathname === '/api/agent/import' && req.method === 'POST') {
      return await handleAgentImport(req, res, requestId)
    }

    /* ---- search and research ---- */
    if (pathname === '/api/search/status' && req.method === 'GET') {
      return sendJson(res, 200, handleSearchStatus())
    }
    if (pathname === '/api/search/providers' && req.method === 'GET') {
      const probe = new URL(req.url, 'http://localhost').searchParams.get('probeVision') === '1'
      return sendJson(res, 200, await handleSearchProviders({ probeVision: probe }))
    }
    if (pathname === '/api/search' && req.method === 'POST') {
      const limit = checkRateLimit(clientKey(req))
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec))
        throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
      }
      return sendJson(res, 200, await handleSearch(await readBody(req, res), abort.signal, requestId))
    }
    if (pathname === '/api/search/page' && req.method === 'POST') {
      return sendJson(res, 200, await handleReadPage(await readBody(req, res), abort.signal))
    }
    if (pathname === '/api/search/reset' && req.method === 'POST') {
      return sendJson(res, 200, handleSearchReset(await readBody(req, res)))
    }
    if (pathname === '/api/research' && req.method === 'POST') {
      const limit = checkRateLimit(clientKey(req))
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec))
        throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
      }
      const body = await readBody(req, res)
      const outcome = await handleResearch(req, res, body, abort.signal, requestId)
      // Streaming responses write themselves; a non-streaming one comes back as JSON
      if (outcome?.json) return sendJson(res, 200, outcome.json)
      return
    }
    if (pathname === '/api/research/report' && req.method === 'POST') {
      return sendJson(res, 200, await handleResearchReport(await readBody(req, res), abort.signal, requestId))
    }
    if (pathname === '/api/vision/status' && req.method === 'GET') {
      const probe = new URL(req.url, 'http://localhost').searchParams.get('probe') === '1'
      return sendJson(res, 200, await visionStatus({ probe, signal: abort.signal }))
    }

    /* ---- skills ---- */
    if (pathname === '/api/skills' && req.method === 'GET') {
      return sendJson(res, 200, await handleSkillsList(new URL(req.url, 'http://localhost').searchParams))
    }
    if (pathname === '/api/skills/detect' && req.method === 'POST') {
      return sendJson(res, 200, await handleDetect(await readBody(req, res)))
    }
    if (pathname === '/api/skills/matrix' && req.method === 'GET') {
      return sendJson(res, 200, await handleMatrix())
    }
    if (pathname === '/api/skills/context' && req.method === 'POST') {
      return sendJson(res, 200, await handleContext(await readBody(req, res)))
    }
    if (pathname === '/api/skills/inspect' && req.method === 'POST') {
      return sendJson(res, 200, handleInspect(await readBody(req, res)))
    }
    if (pathname === '/api/skills/custom' && req.method === 'GET') {
      return sendJson(res, 200, handleCustomList())
    }
    if (pathname === '/api/skills/custom' && req.method === 'POST') {
      return sendJson(res, 201, handleCustomCreate(await readBody(req, res)))
    }
    {
      const customMatch = pathname.match(/^\/api\/skills\/custom\/([\w-]{1,60})$/)
      if (customMatch && req.method === 'PATCH') {
        return sendJson(res, 200, handleCustomUpdate(customMatch[1], await readBody(req, res)))
      }
      if (customMatch && req.method === 'DELETE') {
        return sendJson(res, 200, handleCustomDelete(customMatch[1]))
      }
      const rollbackMatch = pathname.match(/^\/api\/skills\/custom\/([\w-]{1,60})\/rollback$/)
      if (rollbackMatch && req.method === 'POST') {
        return sendJson(res, 200, handleCustomRollback(rollbackMatch[1]))
      }

      const skillMatch = pathname.match(/^\/api\/skills\/([\w:.-]{1,80})$/)
      if (skillMatch && req.method === 'GET') {
        return sendJson(res, 200, await handleSkill(skillMatch[1]))
      }
      const toggleMatch = pathname.match(/^\/api\/skills\/([\w:.-]{1,80})\/toggle$/)
      if (toggleMatch && req.method === 'POST') {
        return sendJson(res, 200, await handleToggle(toggleMatch[1], await readBody(req, res)))
      }
      const favouriteMatch = pathname.match(/^\/api\/skills\/([\w:.-]{1,80})\/favourite$/)
      if (favouriteMatch && req.method === 'POST') {
        return sendJson(res, 200, await handleFavourite(favouriteMatch[1], await readBody(req, res)))
      }
      const settingsMatch = pathname.match(/^\/api\/skills\/([\w:.-]{1,80})\/settings$/)
      if (settingsMatch && req.method === 'POST') {
        return sendJson(res, 200, await handleSettings(settingsMatch[1], await readBody(req, res)))
      }
      const resourceMatch = pathname.match(/^\/api\/skills\/([\w:.-]{1,80})\/resource$/)
      if (resourceMatch && req.method === 'GET') {
        return sendJson(res, 200, handleResource(resourceMatch[1], new URL(req.url, 'http://localhost').searchParams))
      }
    }

    /* ---- generation ---- */
    if (pathname === '/api/generate/status' && req.method === 'GET') {
      const probe = new URL(req.url, 'http://localhost').searchParams.get('probe') === '1'
      return sendJson(res, 200, await generationStatus({ probe }))
    }
    if (pathname === '/api/generate/backends' && req.method === 'GET') {
      const probe = new URL(req.url, 'http://localhost').searchParams.get('probe') === '1'
      return sendJson(res, 200, { backends: await listBackends({ probe }), queue: queueStats() })
    }
    if (pathname === '/api/generate/image' && req.method === 'POST') {
      const limit = checkRateLimit(clientKey(req))
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec))
        throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
      }
      return sendJson(res, 202, await generateImageJob(await readBody(req, res)))
    }
    if (pathname === '/api/generate/video' && req.method === 'POST') {
      const limit = checkRateLimit(clientKey(req))
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec))
        throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
      }
      return sendJson(res, 202, await generateVideoJob(await readBody(req, res)))
    }
    if (pathname === '/api/generate/jobs' && req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams
      return sendJson(res, 200, { jobs: listJobs({ taskId: params.get('taskId') }), queue: queueStats() })
    }
    {
      const jobMatch = pathname.match(/^\/api\/generate\/jobs\/(gen_[a-z0-9]{8,32})$/)
      if (jobMatch && req.method === 'GET') {
        const job = getJob(jobMatch[1])
        if (!job) throw new GatewayError('not_found', 'That job does not exist.', { status: 404 })
        return sendJson(res, 200, job)
      }
      if (jobMatch && req.method === 'DELETE') {
        return sendJson(res, 200, cancelJob(jobMatch[1]))
      }
      const retryMatch = pathname.match(/^\/api\/generate\/jobs\/(gen_[a-z0-9]{8,32})\/retry$/)
      if (retryMatch && req.method === 'POST') {
        return sendJson(res, 200, retryJob(retryMatch[1]))
      }
      const watchMatch = pathname.match(/^\/api\/generate\/jobs\/(gen_[a-z0-9]{8,32})\/watch$/)
      if (watchMatch && req.method === 'GET') {
        return watchJob(req, res, watchMatch[1])
      }
    }

    /* ---- documents ---- */
    if (pathname === '/api/documents/formats' && req.method === 'GET') {
      return sendJson(res, 200, {
        formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, extension: f.extension })),
      })
    }
    if (pathname === '/api/documents/compose' && req.method === 'POST') {
      const limit = checkRateLimit(clientKey(req))
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec))
        throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
      }
      return sendJson(res, 200, await handleDocumentCompose(await readBody(req, res), abort.signal, requestId))
    }
    if (pathname === '/api/documents/generate' && req.method === 'POST') {
      return sendJson(res, 200, handleDocumentGenerate(await readBody(req, res), requestId))
    }
    if (pathname === '/api/documents/pdf/inspect' && req.method === 'POST') {
      return sendJson(res, 200, handlePdfInspect(await readJsonBody(req, MAX_PDF_UPLOAD_BYTES * 2)))
    }
    if (pathname === '/api/documents/pdf/edit' && req.method === 'POST') {
      return sendJson(res, 200, handlePdfEdit(await readJsonBody(req, MAX_PDF_UPLOAD_BYTES * 2), requestId))
    }
    if (pathname === '/api/documents/pdf/modify' && req.method === 'POST') {
      const limit = checkRateLimit(clientKey(req))
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec))
        throw new GatewayError('rate_limited', 'Too many requests. Please slow down.', { status: 429 })
      }
      return sendJson(
        res,
        200,
        await handlePdfModify(await readJsonBody(req, MAX_PDF_UPLOAD_BYTES * 2), abort.signal, requestId),
      )
    }
    {
      const fileMatch = pathname.match(/^\/api\/documents\/(doc_[a-z0-9]{8,32})$/)
      if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        return handleArtifactDownload(req, res, fileMatch[1])
      }
    }
    {
      const zipMatch = pathname.match(/^\/api\/agent\/(task_[a-z0-9]{6,32})\/zip$/)
      if (zipMatch && req.method === 'GET') return handleAgentZip(req, res, zipMatch[1])
      const shotMatch = pathname.match(/^\/api\/agent\/(task_[a-z0-9]{6,32})\/screenshot\/([\w.-]{1,80})$/)
      if (shotMatch && req.method === 'GET') return handleAgentScreenshot(req, res, shotMatch[1], shotMatch[2])
      const taskMatch = pathname.match(/^\/api\/agent\/(task_[a-z0-9]{6,32})$/)
      if (taskMatch && req.method === 'GET') return handleAgentTask(req, res, taskMatch[1])
      if (taskMatch && req.method === 'DELETE') {
        // Kill the preview first: removing the files under a running dev server
        // leaves it serving from a directory that no longer exists.
        await stopPreview(taskMatch[1])
        await closeBrowser(taskMatch[1]).catch(() => {})
        return sendJson(res, 200, deleteTask(taskMatch[1], { removeFiles: true }))
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Unknown API route.' } })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } })
    }
    return serveStatic(req, res, pathname)
  } catch (error) {
    const e = error instanceof GatewayError ? error : null
    // Never surface a stack trace: log it, return the safe vocabulary instead
    if (!e) log.error('unhandled request error', { requestId, message: error?.message })
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    sendJson(res, e?.status ?? 500, {
      error: {
        code: e?.code ?? 'internal_error',
        message: e?.message ?? 'Something went wrong.',
        requestId,
      },
    })
  }
})

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(config.port, () => {
  const gw = describeGateway()
  log.info('PixGPT server listening', { url: `http://localhost:${config.port}` })
  log.info('rate limit', {
    enabled: rateLimitConfig.enabled,
    max: rateLimitConfig.enabled ? rateLimitConfig.max : undefined,
    windowMs: rateLimitConfig.enabled ? rateLimitConfig.windowMs : undefined,
    scope: 'in-memory, per process',
  })
  log.info('ai gateway', {
    provider: gw.gateway,
    baseUrl: gw.baseUrl,
    apiKey: gw.apiKey, // 'set' | 'not set' — never the value
    defaultModel: gw.defaultModel,
    timeoutMs: gw.timeoutMs,
    fallbacks: gw.fallbackModels.join(',') || 'none',
  })
  /*
   * Routing is installed before the first request but the catalogue is only
   * *discovered*, never probed (section 40). Discovery is one GET; probing 121
   * models at boot would spend real quota on every restart.
   */
  installModelRouting()

  void getGateway()
    .client.checkHealth()
    .then(async (h) => {
      if (h.ok) log.info('gateway reachable', { provider: gw.gateway, baseUrl: h.baseUrl })
      else log.warn('gateway not ready', { provider: gw.gateway, baseUrl: h.baseUrl, code: h.code, reachable: h.reachable })
      // A gateway that is down at boot leaves the registry empty; the first
      // request that needs it retries, so this is best-effort by design.
      if (h.ok) await ensureDiscovered().catch((e) => log.warn('model discovery deferred', { detail: e?.message }))
    })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('shutting down', { previews: previewCount() })
    /*
     * Preview servers and browsers are child processes. Without this they
     * outlive PixGPT, keep holding their ports, and the next start cannot bind.
     */
    cancelAllJobs()
    // Keep what this session learned about which routes work
    persistModels({ immediate: true })
    void Promise.allSettled([stopAllPreviews(), closeAllBrowsers()]).then(() => {
      server.close(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}
