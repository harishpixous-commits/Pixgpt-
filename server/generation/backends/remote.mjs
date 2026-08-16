import { log } from '../../config.mjs'
import { GatewayError } from '../../gateway/errors.mjs'
import { validateUrl } from '../../search/net.mjs'

/* ============================================================
   Generic remote generation backend
   ---------------------------------
   One adapter for any HTTP generation service, configured rather than
   hardcoded. PixGPT is not tied to a particular vendor, and adding a
   new one should be configuration, not a code change.

   The service contract is deliberately small:

     POST <url>            { prompt, width, height, … }
       -> a binary body, or
       -> { url: "https://…" }, or
       -> { image | video | output | data: "<base64 or data URL>" }, or
       -> { id } plus a status endpoint to poll

   Every URL the service hands back is screened by the same SSRF policy
   as the rest of PixGPT before anything is fetched from it. A
   generation provider is not more trusted than a web page just because
   an API key was involved.
   ============================================================ */

const POLL_INTERVAL_MS = 2000
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.GENERATION_REMOTE_TIMEOUT_MS ?? '', 10) || 300_000

function config() {
  const url = String(process.env.GENERATION_REMOTE_URL ?? '').trim()
  const apiKey = String(process.env.GENERATION_REMOTE_API_KEY ?? '').trim()
  if (!url || !apiKey) {
    throw new GatewayError('unsupported', 'No remote generation provider is configured.', { status: 501 })
  }
  return {
    url: url.replace(/\/+$/, ''),
    apiKey,
    /** Header name varies by vendor; Authorization is the common default. */
    authHeader: process.env.GENERATION_REMOTE_AUTH_HEADER ?? 'Authorization',
    authPrefix: process.env.GENERATION_REMOTE_AUTH_PREFIX ?? 'Bearer ',
    statusPath: process.env.GENERATION_REMOTE_STATUS_PATH ?? '',
    videoUrl: process.env.GENERATION_REMOTE_VIDEO_URL ?? '',
  }
}

export function capabilities() {
  const configured = Boolean(process.env.GENERATION_REMOTE_URL && process.env.GENERATION_REMOTE_API_KEY)
  return {
    id: 'remote',
    generative: true,
    configured,
    supportsImage: configured,
    supportsVideo: configured && Boolean(process.env.GENERATION_REMOTE_VIDEO_URL),
    requiresGpu: false,
    /*
     * A remote service's real capabilities cannot be discovered generically, so
     * nothing beyond "it is configured" is claimed. What it can do is proven by
     * it producing a valid artifact.
     */
    discovered: false,
  }
}

export async function health() {
  try {
    const { url } = config()
    const screened = await validateUrl(url)
    return screened.ok
      ? { ok: true, endpoint: new URL(url).origin }
      : { ok: false, reason: `endpoint refused by URL policy: ${screened.reason}` }
  } catch (error) {
    return { ok: false, reason: error?.message ?? 'not configured' }
  }
}

/** Decodes whatever shape the service replied with into bytes. */
async function extractBinary(response, { signal }) {
  const contentType = response.headers.get('content-type') ?? ''

  // The straightforward case: the service streamed the file back
  if (/^(image|video)\//.test(contentType)) {
    return Buffer.from(await response.arrayBuffer())
  }

  const payload = await response.json().catch(() => null)
  if (!payload) {
    throw new GatewayError('provider_error', 'The remote provider returned neither a file nor JSON.', { status: 502 })
  }

  // A URL to fetch — screened before anything is requested from it
  const url = payload.url ?? payload.output_url ?? payload.image_url ?? payload.video_url ?? (Array.isArray(payload.output) ? payload.output[0] : null)
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    const screened = await validateUrl(url)
    if (!screened.ok) {
      throw new GatewayError('provider_error', `The provider returned a URL that policy refuses (${screened.reason}).`, {
        status: 502,
        retryable: false,
      })
    }
    const download = await fetch(screened.url, { signal })
    if (!download.ok) {
      throw new GatewayError('provider_error', `Could not download the result (${download.status}).`, { status: 502, retryable: true })
    }
    return Buffer.from(await download.arrayBuffer())
  }

  // Inline base64, with or without a data-URL prefix
  const inline = payload.image ?? payload.video ?? payload.output ?? payload.data ?? payload.b64_json
  if (typeof inline === 'string' && inline.length > 64) {
    const base64 = inline.replace(/^data:[^;]+;base64,/, '')
    return Buffer.from(base64, 'base64')
  }

  return { pending: payload.id ?? payload.job_id ?? payload.request_id ?? null, payload }
}

async function submit(endpoint, body, { signal, timeoutMs }) {
  const cfg = config()
  const screened = await validateUrl(endpoint)
  if (!screened.ok) {
    throw new GatewayError('unsupported', `The configured endpoint is refused by URL policy (${screened.reason}).`, {
      status: 501,
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(screened.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        [cfg.authHeader]: `${cfg.authPrefix}${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GatewayError('provider_error', `The remote provider returned ${response.status}: ${text.slice(0, 200)}`, {
        status: response.status === 401 || response.status === 403 ? 502 : 502,
        // A bad key or a rejected prompt will fail the same way next time
        retryable: response.status >= 500 || response.status === 429,
      })
    }
    return await extractBinary(response, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Polls an async job until it produces a file. */
async function pollUntilReady(id, { report, signal, timeoutMs }) {
  const cfg = config()
  if (!cfg.statusPath) {
    throw new GatewayError('provider_error', 'The provider queued a job but no status endpoint is configured.', {
      status: 501,
    })
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new GatewayError('client_closed', 'The job was cancelled.', { status: 499 })

    const statusUrl = cfg.statusPath.includes('{id}') ? cfg.statusPath.replace('{id}', id) : `${cfg.statusPath}/${id}`
    const screened = await validateUrl(statusUrl)
    if (!screened.ok) throw new GatewayError('provider_error', 'The status endpoint is refused by URL policy.', { status: 502 })

    const response = await fetch(screened.url, {
      signal,
      headers: { [cfg.authHeader]: `${cfg.authPrefix}${cfg.apiKey}` },
    })
    if (response.ok) {
      const result = await extractBinary(response, { signal })
      if (Buffer.isBuffer(result)) return result

      // Report the provider's own progress; never invent one
      const progress = Number(result.payload?.progress ?? result.payload?.percent)
      report?.progress(Number.isFinite(progress) ? (progress > 1 ? progress / 100 : progress) : null, 'Generating remotely')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new GatewayError('timeout', 'The remote provider did not finish in time.', { status: 504, retryable: true })
}

export async function generateImage(request, { report, signal } = {}) {
  const cfg = config()
  report?.stage('Submitting to the remote provider')

  const result = await submit(
    cfg.url,
    {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      width: request.width,
      height: request.height,
      seed: request.seed,
      steps: request.steps,
      guidance_scale: request.guidance,
      model: request.model,
      ...(request.initImage ? { image: request.initImage, strength: request.strength } : {}),
    },
    { signal, timeoutMs: DEFAULT_TIMEOUT_MS },
  )

  const buffer = Buffer.isBuffer(result) ? result : await pollUntilReady(result.pending, { report, signal, timeoutMs: DEFAULT_TIMEOUT_MS })
  log.info('remote image generated', { bytes: buffer.length })
  return { buffer, model: request.model ?? 'remote', seed: request.seed }
}

export async function generateVideo(request, { report, signal } = {}) {
  const cfg = config()
  if (!cfg.videoUrl) {
    throw new GatewayError('unsupported', 'No remote video endpoint is configured (GENERATION_REMOTE_VIDEO_URL).', {
      status: 501,
    })
  }
  report?.stage('Submitting to the remote provider')

  const result = await submit(
    cfg.videoUrl,
    {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      duration: request.duration,
      width: request.width,
      height: request.height,
      fps: request.fps,
      seed: request.seed,
      model: request.model,
      ...(request.initImage ? { image: request.initImage } : {}),
    },
    { signal, timeoutMs: DEFAULT_TIMEOUT_MS },
  )

  const buffer = Buffer.isBuffer(result) ? result : await pollUntilReady(result.pending, { report, signal, timeoutMs: DEFAULT_TIMEOUT_MS })
  log.info('remote video generated', { bytes: buffer.length })
  return { buffer, model: request.model ?? 'remote', fps: request.fps }
}
