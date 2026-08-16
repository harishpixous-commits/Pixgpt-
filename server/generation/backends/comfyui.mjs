import { randomUUID } from 'node:crypto'
import { log } from '../../config.mjs'
import { GatewayError } from '../../gateway/errors.mjs'

/* ============================================================
   ComfyUI backend
   ---------------
   ComfyUI is treated as an external worker, never run inside the
   PixGPT process. The contract is its documented HTTP API:

     POST /prompt            queue a workflow      -> { prompt_id }
     GET  /history/{id}      outputs once finished
     GET  /queue             what is running and pending
     GET  /view?filename=…   download an output
     POST /interrupt         stop the running job
     GET  /system_stats      device and VRAM

   Progress comes from the websocket when one can be opened, and from
   queue position otherwise. It is never invented: a job that reports
   nothing shows a stage name rather than a number that creeps upward
   while the backend is wedged.

   Workflows are data, not code. A graph is a JSON template with named
   slots, so a different checkpoint or sampler is a configuration
   change rather than an edit here.
   ============================================================ */

const POLL_INTERVAL_MS = 1200
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.COMFYUI_TIMEOUT_MS ?? '', 10) || 600_000

function baseUrl(config) {
  const url = String(config?.url ?? process.env.COMFYUI_URL ?? '').replace(/\/+$/, '')
  if (!url) throw new GatewayError('unsupported', 'ComfyUI is not configured. Set COMFYUI_URL.', { status: 501 })
  return url
}

async function call(config, path, { method = 'GET', body, signal, timeoutMs = 20_000, raw = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(`${baseUrl(config)}${path}`, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GatewayError('provider_error', `ComfyUI returned ${response.status}: ${text.slice(0, 200)}`, {
        status: response.status >= 500 ? 502 : 400,
        retryable: response.status >= 500 || response.status === 429,
      })
    }
    return raw ? Buffer.from(await response.arrayBuffer()) : await response.json()
  } catch (error) {
    if (error instanceof GatewayError) throw error
    const aborted = controller.signal.aborted
    throw new GatewayError('provider_error', aborted ? 'ComfyUI did not respond in time.' : `ComfyUI is unreachable: ${error?.message}`, {
      status: 502,
      retryable: true,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/* ---------- capability discovery ---------- */

/**
 * What this instance can actually do, read from its own object registry.
 *
 * Nothing is assumed: the available checkpoints, LoRAs and samplers come from
 * the running instance, so PixGPT never offers a model that is not installed.
 */
export async function capabilities(config, { signal } = {}) {
  const [stats, objectInfo] = await Promise.all([
    call(config, '/system_stats', { signal }),
    call(config, '/object_info', { signal, timeoutMs: 30_000 }),
  ])

  const enumOf = (node, input) =>
    objectInfo?.[node]?.input?.required?.[input]?.[0] ?? objectInfo?.[node]?.input?.optional?.[input]?.[0] ?? []

  const checkpoints = enumOf('CheckpointLoaderSimple', 'ckpt_name')
  const loras = enumOf('LoraLoader', 'lora_name')
  const samplers = enumOf('KSampler', 'sampler_name')
  const schedulers = enumOf('KSampler', 'scheduler')
  const vaes = enumOf('VAELoader', 'vae_name')
  const unets = enumOf('UNETLoader', 'unet_name')

  const nodes = Object.keys(objectInfo ?? {})
  const device = stats?.devices?.[0] ?? null

  return {
    reachable: true,
    version: stats?.system?.comfyui_version ?? null,
    device: device
      ? {
          name: device.name,
          type: device.type,
          vramGb: device.vram_total ? Math.round((device.vram_total / 1024 ** 3) * 10) / 10 : null,
          vramFreeGb: device.vram_free ? Math.round((device.vram_free / 1024 ** 3) * 10) / 10 : null,
        }
      : null,
    models: {
      checkpoints: Array.isArray(checkpoints) ? checkpoints : [],
      loras: Array.isArray(loras) ? loras : [],
      vaes: Array.isArray(vaes) ? vaes : [],
      unets: Array.isArray(unets) ? unets : [],
    },
    samplers: Array.isArray(samplers) ? samplers : [],
    schedulers: Array.isArray(schedulers) ? schedulers : [],
    /*
     * Video support is inferred from the nodes actually installed, not from a
     * version number: a stock ComfyUI has no video nodes until an extension
     * adds them.
     */
    supportsVideo: nodes.some((n) => /VideoLinearCFGGuidance|SVD_img2vid|VHS_VideoCombine|WanVideo|LTXV|HunyuanVideo/i.test(n)),
    supportsInpaint: nodes.includes('VAEEncodeForInpaint'),
    supportsUpscale: nodes.some((n) => /UpscaleModelLoader|ImageUpscaleWithModel|LatentUpscale/i.test(n)),
    supportsImageToImage: nodes.includes('VAEEncode'),
    nodeCount: nodes.length,
  }
}

export async function health(config, { signal } = {}) {
  try {
    const stats = await call(config, '/system_stats', { signal, timeoutMs: 6000 })
    const queue = await call(config, '/queue', { signal, timeoutMs: 6000 }).catch(() => null)
    return {
      ok: true,
      version: stats?.system?.comfyui_version ?? null,
      running: queue?.queue_running?.length ?? 0,
      pending: queue?.queue_pending?.length ?? 0,
    }
  } catch (error) {
    return { ok: false, reason: error?.message ?? 'unreachable' }
  }
}

/* ---------- workflow submission ---------- */

/** Queues a graph and returns its prompt id. */
async function queuePrompt(config, workflow, clientId, signal) {
  const result = await call(config, '/prompt', {
    method: 'POST',
    body: { prompt: workflow, client_id: clientId },
    signal,
  })
  if (!result?.prompt_id) {
    // ComfyUI reports a malformed graph here rather than at execution time
    const detail = result?.error?.message ?? JSON.stringify(result?.node_errors ?? result ?? {}).slice(0, 300)
    throw new GatewayError('bad_request', `ComfyUI rejected the workflow: ${detail}`, { status: 400, retryable: false })
  }
  return result.prompt_id
}

/**
 * Waits for a prompt to finish, reporting progress as it goes.
 *
 * Polls rather than holding a websocket: the HTTP API is stable across
 * versions and one poll every 1.2 seconds is not a burden on a machine that is
 * busy running a diffusion model.
 */
async function waitForPrompt(config, promptId, { report, signal, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  let lastPosition = null

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new GatewayError('client_closed', 'The job was cancelled.', { status: 499 })

    const history = await call(config, `/history/${promptId}`, { signal, timeoutMs: 15_000 }).catch(() => null)
    const entry = history?.[promptId]

    if (entry) {
      const status = entry.status ?? {}
      if (status.status_str === 'error' || status.completed === false) {
        const message = (entry.status?.messages ?? [])
          .filter(([kind]) => kind === 'execution_error')
          .map(([, payload]) => payload?.exception_message ?? '')
          .join('; ')
        throw new GatewayError('provider_error', `ComfyUI failed to execute the workflow: ${message || 'unknown error'}`, {
          status: 502,
          retryable: false,
        })
      }
      if (entry.outputs && Object.keys(entry.outputs).length > 0) return entry
    }

    /*
     * Position in the queue is real information, so it is reported. Progress
     * within a running job is not available from the HTTP API, so a stage name
     * is shown instead of a fabricated percentage.
     */
    const queue = await call(config, '/queue', { signal, timeoutMs: 10_000 }).catch(() => null)
    if (queue) {
      const pending = queue.queue_pending ?? []
      const active = queue.queue_running ?? []
      const isRunning = active.some((item) => item?.[1] === promptId)
      const position = pending.findIndex((item) => item?.[1] === promptId)

      if (isRunning) {
        report?.progress(null, 'Generating')
      } else if (position >= 0 && position !== lastPosition) {
        lastPosition = position
        report?.progress(null, `Queued on the worker — position ${position + 1}`)
      } else if (position < 0 && !isRunning && !entry) {
        report?.progress(null, 'Waiting for the worker')
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new GatewayError('timeout', `ComfyUI did not finish within ${Math.round(timeoutMs / 1000)}s.`, {
    status: 504,
    retryable: true,
  })
}

/** Pulls every output file out of a finished history entry. */
async function collectOutputs(config, entry, signal) {
  const files = []
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'gifs', 'videos', 'files']) {
      for (const file of nodeOutput?.[key] ?? []) {
        if (!file?.filename) continue
        files.push(file)
      }
    }
  }

  const downloaded = []
  for (const file of files) {
    const params = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    })
    const buffer = await call(config, `/view?${params}`, { signal, raw: true, timeoutMs: 120_000 })
    downloaded.push({ filename: file.filename, buffer })
  }
  return downloaded
}

/**
 * Runs a workflow end to end.
 *
 * @param {object} config      { url }
 * @param {object} workflow    a ComfyUI API-format graph
 * @param {{ report?: object, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ files: {filename, buffer}[], promptId: string }>}
 */
export async function runWorkflow(config, workflow, { report, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const clientId = randomUUID()
  report?.stage('Submitting the workflow')

  const promptId = await queuePrompt(config, workflow, clientId, signal)
  log.info('comfyui prompt queued', { promptId })

  try {
    const entry = await waitForPrompt(config, promptId, { report, signal, timeoutMs })
    report?.stage('Downloading the output')

    const files = await collectOutputs(config, entry, signal)
    if (files.length === 0) {
      throw new GatewayError('provider_error', 'ComfyUI finished but produced no output file.', {
        status: 502,
        retryable: false,
      })
    }
    log.info('comfyui workflow complete', { promptId, files: files.length })
    return { files, promptId }
  } catch (error) {
    // A cancelled job must stop the remote work too, not just our polling
    if (signal?.aborted) {
      await call(config, '/interrupt', { method: 'POST', timeoutMs: 5000 }).catch(() => {})
      log.info('comfyui prompt interrupted', { promptId })
    }
    throw error
  }
}

/** Uploads an input image so a graph can reference it by name. */
export async function uploadImage(config, { buffer, filename = 'input.png', signal }) {
  const form = new FormData()
  form.append('image', new Blob([buffer], { type: 'image/png' }), filename)
  form.append('overwrite', 'true')

  const response = await fetch(`${baseUrl(config)}/upload/image`, { method: 'POST', body: form, signal })
  if (!response.ok) {
    throw new GatewayError('provider_error', `ComfyUI rejected the uploaded image (${response.status}).`, { status: 502 })
  }
  const result = await response.json()
  return result?.name ?? filename
}

export async function interrupt(config) {
  return call(config, '/interrupt', { method: 'POST', timeoutMs: 5000 }).catch(() => null)
}

export { baseUrl, call }
