import { createHash } from 'node:crypto'
import { log } from '../config.mjs'
import { GatewayError } from '../gateway/errors.mjs'
import { putArtifact } from '../artifacts.mjs'
import { detectResources, describeLocalCapability } from './resources.mjs'
import { createJob, JOB_STATE } from './jobs.mjs'
import { detectKind, validateImage, validateVideo } from './validate.mjs'
import * as renderer from './backends/renderer.mjs'
import * as comfyui from './backends/comfyui.mjs'
import * as remote from './backends/remote.mjs'

/* ============================================================
   Generation orchestrator
   -----------------------
   Chooses a backend that can actually satisfy the request, runs it as
   an asynchronous job, validates whatever comes back, and stores it as
   an artifact.

   Two rules govern routing.

   First, capability before preference: a backend is only offered for
   work it declares it can do. Falling back from a video request to an
   image backend would "succeed" while delivering the wrong thing, so
   the fallback chain is filtered by capability first and ordered by
   cost second.

   Second, nothing is claimed until it has produced output. A backend
   that is configured but has never returned a valid file is reported
   as configured, not as working.
   ============================================================ */

export const CAPABILITY = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  IMG2IMG: 'img2img',
  EDIT: 'edit',
  UPSCALE: 'upscale',
  IMG2VIDEO: 'img2video',
})

/**
 * Backend descriptors.
 *
 * `verified` is never set here — it is earned at runtime by producing a valid
 * artifact, and reported separately.
 */
const BACKENDS = [
  {
    id: 'renderer',
    name: 'Deterministic renderer',
    module: renderer,
    cost: 'free',
    /*
     * Not a diffusion model. It composes gradients, patterns, typographic cards
     * and charts, which is what most generated sites actually need, and it runs
     * with no GPU. It refuses photographic subjects rather than faking them.
     */
    generative: false,
    capabilities: [CAPABILITY.IMAGE],
    requiresGpu: false,
    priority: 10,
    isConfigured: () => true,
    requires: null,
  },
  {
    id: 'comfyui',
    name: 'ComfyUI',
    module: comfyui,
    cost: 'self_hosted',
    generative: true,
    capabilities: [CAPABILITY.IMAGE, CAPABILITY.IMG2IMG, CAPABILITY.EDIT, CAPABILITY.UPSCALE, CAPABILITY.VIDEO, CAPABILITY.IMG2VIDEO],
    requiresGpu: true,
    priority: 5,
    isConfigured: () => Boolean(process.env.COMFYUI_URL),
    requires: 'COMFYUI_URL',
  },
  {
    id: 'remote',
    name: 'Remote generation API',
    module: remote,
    cost: 'paid',
    generative: true,
    capabilities: [CAPABILITY.IMAGE, CAPABILITY.IMG2IMG, CAPABILITY.VIDEO, CAPABILITY.IMG2VIDEO],
    requiresGpu: false,
    priority: 50,
    isConfigured: () => Boolean(process.env.GENERATION_REMOTE_URL && process.env.GENERATION_REMOTE_API_KEY),
    requires: 'GENERATION_REMOTE_URL and GENERATION_REMOTE_API_KEY',
  },
]

/** Runtime record of what each backend has actually done. */
const VERIFIED = new Map()

function noteVerified(backendId, kind) {
  const record = VERIFIED.get(backendId) ?? { image: false, video: false, at: null }
  record[kind] = true
  record.at = new Date().toISOString()
  VERIFIED.set(backendId, record)
}

/** Explicit ordering from configuration, highest preference first. */
function configuredOrder(kind) {
  const primary = (kind === 'video' ? process.env.VIDEO_GENERATION_PROVIDER : process.env.IMAGE_GENERATION_PROVIDER) ?? ''
  const fallback = (kind === 'video' ? process.env.VIDEO_GENERATION_FALLBACK : process.env.IMAGE_GENERATION_FALLBACK) ?? ''
  return [primary, ...fallback.split(',')]
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id && BACKENDS.some((b) => b.id === id))
}

/**
 * Backends that can serve a capability, best first.
 *
 * Filtering by capability is what stops a video request quietly falling back to
 * an image backend and reporting success.
 */
export function selectBackends(capability, { kind = 'image' } = {}) {
  const order = configuredOrder(kind)

  return BACKENDS.filter((backend) => backend.capabilities.includes(capability) && backend.isConfigured()).sort((a, b) => {
    const explicitA = order.indexOf(a.id)
    const explicitB = order.indexOf(b.id)
    if (explicitA >= 0 || explicitB >= 0) {
      if (explicitA < 0) return 1
      if (explicitB < 0) return -1
      if (explicitA !== explicitB) return explicitA - explicitB
    }
    return a.priority - b.priority
  })
}

/** The full registry, for the UI and an admin panel. Never carries a key. */
export async function listBackends({ probe = false } = {}) {
  const resources = await detectResources()

  return Promise.all(
    BACKENDS.map(async (backend) => {
      const configured = backend.isConfigured()
      let health = null

      if (configured && probe && backend.module.health) {
        health = await backend.module.health({ url: process.env.COMFYUI_URL }).catch((error) => ({
          ok: false,
          reason: String(error?.message ?? 'unreachable').slice(0, 160),
        }))
      }

      return {
        id: backend.id,
        name: backend.name,
        cost: backend.cost,
        /** False for the renderer — it composes graphics, it does not sample them. */
        generative: backend.generative,
        capabilities: backend.capabilities,
        requiresGpu: backend.requiresGpu,
        configured,
        requires: configured ? null : backend.requires,
        /*
         * A GPU-backed backend on a machine with no accelerator is reported as
         * unusable rather than merely unconfigured, because that is the actual
         * blocker and it is not fixed by setting a variable.
         */
        usable: configured && (!backend.requiresGpu || resources.localGeneration || backend.id === 'comfyui'),
        health,
        verified: VERIFIED.get(backend.id) ?? { image: false, video: false, at: null },
      }
    }),
  )
}

/** Everything the UI needs to decide what to offer. */
export async function generationStatus({ probe = false } = {}) {
  const resources = await detectResources()
  const backends = await listBackends({ probe })
  const imageBackends = backends.filter((b) => b.usable && b.capabilities.includes(CAPABILITY.IMAGE))
  const videoBackends = backends.filter((b) => b.usable && b.capabilities.includes(CAPABILITY.VIDEO))

  return {
    image: {
      available: imageBackends.length > 0,
      backends: imageBackends.map((b) => b.id),
      /** True only when something that actually samples imagery is available. */
      generative: imageBackends.some((b) => b.generative),
      styles: renderer.STYLES,
    },
    video: {
      available: videoBackends.length > 0,
      backends: videoBackends.map((b) => b.id),
      reason: videoBackends.length === 0 ? 'no_video_backend' : null,
    },
    local: {
      available: resources.localGeneration,
      summary: describeLocalCapability(resources),
      accelerator: resources.accelerator,
      vramGb: resources.vramGb,
      gpu: resources.gpu?.name ?? null,
      reasons: resources.reasons,
    },
    comfyui: resources.comfyui,
    backends,
  }
}

/* ---------- artifact handling ---------- */

/** Validates output, stores it, and returns a descriptor with no filesystem path. */
function storeArtifact({ buffer, kind, request, backendId, model, extra = {} }) {
  const detected = detectKind(buffer)
  const validation =
    kind === 'video'
      ? validateVideo(buffer, { expectDurationSec: request.duration, expectWidth: request.width })
      : validateImage(buffer, { expectWidth: request.width, expectHeight: request.height })

  if (!validation.ok) {
    throw new GatewayError('provider_error', `${backendId} returned an unusable ${kind}: ${validation.detail}`, {
      status: 502,
      // A corrupt or truncated transfer is worth one more attempt; a wrong type is not
      retryable: ['truncated', 'empty'].includes(validation.reason),
    })
  }
  if (detected !== kind && !(kind === 'video' && detected === 'image')) {
    throw new GatewayError('provider_error', `Asked ${backendId} for a ${kind} and got a ${detected}.`, {
      status: 502,
      retryable: false,
    })
  }

  const checksum = createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  const safeTitle = String(request.title || request.prompt || kind)
    .replace(/[^\w -]/g, '')
    .trim()
    .slice(0, 50)
    .replace(/\s+/g, '-') || kind

  const stored = putArtifact({
    filename: `${safeTitle}.${validation.format}`,
    mime: validation.mime,
    buffer,
    meta: {
      kind,
      format: validation.format,
      width: validation.width,
      height: validation.height,
      durationSec: validation.durationSec,
      backend: backendId,
      model,
      checksum,
      ...extra,
    },
  })

  noteVerified(backendId, kind)

  return {
    ...stored,
    kind,
    format: validation.format,
    width: validation.width,
    height: validation.height,
    durationSec: validation.durationSec ?? null,
    checksum,
    backend: backendId,
    model,
    warnings: validation.warnings,
    ...extra,
  }
}

/* ---------- image generation ---------- */

/**
 * Queues an image generation job.
 *
 * @param {{ prompt, style?, width?, height?, seed?, title?, subtitle?, variant?,
 *           data?, format?, count?, model?, backend?, taskId? }} request
 */
export async function generateImageJob(request) {
  const capability = request.initImage ? CAPABILITY.IMG2IMG : CAPABILITY.IMAGE
  const candidates = request.backend
    ? selectBackends(capability).filter((b) => b.id === request.backend)
    : selectBackends(capability)

  if (candidates.length === 0) {
    const resources = await detectResources()
    throw new GatewayError(
      'unsupported',
      request.backend
        ? `The "${request.backend}" backend is not configured or cannot generate images.`
        : `No image backend is available. ${describeLocalCapability(resources)}`,
      { status: 501 },
    )
  }

  const count = Math.min(Math.max(Number(request.count) || 1, 1), Number(process.env.MAX_BATCH_SIZE ?? '4') || 4)

  return createJob({
    kind: 'image',
    provider: candidates[0].id,
    model: request.model ?? candidates[0].id,
    taskId: request.taskId ?? null,
    publicRequest: {
      prompt: request.prompt,
      style: request.style,
      width: request.width ?? 1200,
      height: request.height ?? 630,
      count,
      seed: request.seed ?? null,
    },
    run: async (report) => {
      const artifacts = []
      const warnings = []
      let lastError = null

      for (let index = 0; index < count; index++) {
        report.progress(index / count, count > 1 ? `Generating image ${index + 1} of ${count}` : 'Generating')
        let produced = false

        for (const backend of candidates) {
          try {
            const seed = request.seed != null ? Number(request.seed) + index : undefined
            const output = await backend.module.generateImage(
              { ...request, seed, width: request.width ?? 1200, height: request.height ?? 630 },
              { report, signal: report.signal },
            )

            report.stage('Validating', JOB_STATE.POST_PROCESSING)
            artifacts.push(
              storeArtifact({
                buffer: output.buffer,
                kind: 'image',
                request,
                backendId: backend.id,
                model: output.model ?? request.model ?? backend.id,
                extra: {
                  seed: output.seed,
                  style: output.style,
                  generative: backend.generative,
                  inferredStyle: output.inferredStyle ?? false,
                },
              }),
            )
            produced = true
            break
          } catch (error) {
            lastError = error
            // A capability refusal is final for that backend; try the next one
            log.warn('image backend failed', {
              backend: backend.id,
              code: error?.code,
              message: String(error?.message).slice(0, 140),
            })
            if (candidates.indexOf(backend) < candidates.length - 1) {
              warnings.push(`${backend.id} could not produce this image (${error?.code ?? 'error'}); trying the next backend.`)
            }
          }
        }

        if (!produced) throw lastError ?? new GatewayError('provider_error', 'No backend produced an image.')
      }

      return { artifacts, warnings }
    },
  })
}

/* ---------- video generation ---------- */

/**
 * Queues a video generation job.
 *
 * Never falls back to an image backend: a still delivered as a video is a wrong
 * answer wearing a right answer's shape.
 */
export async function generateVideoJob(request) {
  const capability = request.initImage ? CAPABILITY.IMG2VIDEO : CAPABILITY.VIDEO
  const candidates = selectBackends(capability, { kind: 'video' })

  if (candidates.length === 0) {
    const resources = await detectResources()
    throw new GatewayError(
      'unsupported',
      [
        'No video generation backend is available.',
        describeLocalCapability(resources),
        resources.comfyui.configured
          ? resources.comfyui.reachable
            ? 'ComfyUI is reachable but has no video nodes installed.'
            : 'ComfyUI is configured but unreachable.'
          : 'Configure COMFYUI_URL with a video-capable instance, or a remote provider.',
      ].join(' '),
      { status: 501 },
    )
  }

  return createJob({
    kind: 'video',
    provider: candidates[0].id,
    model: request.model ?? candidates[0].id,
    taskId: request.taskId ?? null,
    publicRequest: {
      prompt: request.prompt,
      duration: request.duration ?? 5,
      width: request.width ?? 1280,
      height: request.height ?? 720,
      fps: request.fps ?? 24,
    },
    run: async (report) => {
      let lastError = null

      for (const backend of candidates) {
        try {
          report.stage(`Generating with ${backend.name}`)
          const output = await backend.module.generateVideo(request, { report, signal: report.signal })

          report.stage('Validating', JOB_STATE.POST_PROCESSING)
          return {
            artifacts: [
              storeArtifact({
                buffer: output.buffer,
                kind: 'video',
                request,
                backendId: backend.id,
                model: output.model ?? request.model ?? backend.id,
                extra: { seed: output.seed, fps: output.fps },
              }),
            ],
          }
        } catch (error) {
          lastError = error
          log.warn('video backend failed', { backend: backend.id, code: error?.code })
        }
      }
      throw lastError ?? new GatewayError('provider_error', 'No backend produced a video.')
    },
  })
}

export { BACKENDS, VERIFIED, storeArtifact }
