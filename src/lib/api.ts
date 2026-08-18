import type { ChatMessage, ModelId } from './types'

/* ============================================================
   Integration boundary
   --------------------
   PixGPT talks to its own server (`server/`), which is the only
   thing that talks to OmniRoute. The browser never sees the
   gateway URL or its API key.

       browser -> /api/chat -> OmniRoute -> provider

   Everything below implements the same `ChatAPI` interface the UI
   already used, so the store and components are unchanged.
   ============================================================ */

export interface StreamCompletionRequest {
  messages: ChatMessage[]
  model: ModelId
  temperature?: number
  /** Ground the answer in live web results. The server does all fetching. */
  web?: boolean
}

export interface SourceRef {
  title: string
  url: string
}

export interface ChatAPI {
  streamCompletion(
    request: StreamCompletionRequest,
    signal: AbortSignal,
    onToken: (token: string) => void,
    onSource?: (source: SourceRef) => void,
    /**
     * Fires once the answer completes, with the model that actually served it.
     * `truncated` is true when the model stopped at its output ceiling, so the
     * UI can offer to continue instead of presenting a cut-off answer as done.
     */
    onDone?: (info: { model?: string; fellBack?: boolean; truncated?: boolean }) => void,
  ): Promise<void>
  uploadAttachment(
    file: File,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<{ id: string; name: string; size: number }>
  transcribeAudio(blob: Blob, signal: AbortSignal): Promise<string>
}

/** Set VITE_PIXGPT_DEMO=1 to run the UI without a server or gateway. */
export const isDemoMode = import.meta.env.VITE_PIXGPT_DEMO === '1'

/* ============================================================
   Errors
   ============================================================ */

/** Stable codes mirrored from the server so the UI can branch on them. */
export type GatewayErrorCode =
  | 'gateway_unavailable'
  | 'invalid_api_key'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'provider_error'
  | 'timeout'
  | 'malformed_response'
  | 'stream_failed'
  | 'bad_request'
  | 'unsupported'
  | 'internal_error'

export class ChatRequestError extends Error {
  readonly code: GatewayErrorCode
  constructor(code: GatewayErrorCode, message: string) {
    super(message)
    this.name = 'ChatRequestError'
    this.code = code
  }
}

/** Copy shown to the user. The server never sends provider internals. */
const FALLBACK_MESSAGES: Record<GatewayErrorCode, string> = {
  gateway_unavailable: 'AI gateway unreachable. Please try again shortly.',
  invalid_api_key: 'AI gateway authentication failed. Please contact your administrator.',
  provider_unavailable: 'AI provider temporarily unavailable. Please try again.',
  model_unavailable: 'The selected model is unavailable. Try another model.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  quota_exceeded: 'The AI account has run out of quota. Please contact your administrator.',
  provider_error: 'AI provider temporarily unavailable. Please try again.',
  timeout: 'AI request timed out. Please try again.',
  malformed_response: 'The AI response could not be read. Please try again.',
  stream_failed: 'The response was interrupted. The partial answer is kept above.',
  bad_request: 'That request could not be processed.',
  unsupported: 'The configured AI gateway does not support this feature.',
  internal_error: 'Something went wrong. Please try again.',
}

function toError(code: string | undefined, message: string | undefined): ChatRequestError {
  const known = (code ?? '') in FALLBACK_MESSAGES ? (code as GatewayErrorCode) : 'provider_error'
  return new ChatRequestError(known, message || FALLBACK_MESSAGES[known])
}

/* ============================================================
   Gateway status (health)
   ============================================================ */

export interface GatewayStatus {
  ok: boolean
  reachable: boolean
  authenticated: boolean | null
  code: string | null
  baseUrl?: string
  /** Which gateway backend the server selected, e.g. "omniroute". */
  name?: string
  /** Human-readable gateway name, e.g. "OmniRoute". */
  label?: string
  /** What the selected gateway actually supports; unsupported features can be hidden. */
  capabilities?: Record<string, boolean>
}

export async function fetchGatewayStatus(signal?: AbortSignal): Promise<GatewayStatus> {
  if (isDemoMode) return { ok: true, reachable: true, authenticated: true, code: null }
  try {
    const response = await fetch('/api/health', { signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const data = (await response.json()) as { ok?: boolean; gateway?: Partial<GatewayStatus> }
    return {
      ok: Boolean(data.ok),
      reachable: Boolean(data.gateway?.reachable),
      authenticated: data.gateway?.authenticated ?? null,
      code: data.gateway?.code ?? null,
      baseUrl: data.gateway?.baseUrl,
      name: data.gateway?.name,
      label: data.gateway?.label,
      capabilities: data.gateway?.capabilities,
    }
  } catch {
    // The PixGPT server itself is unreachable
    return { ok: false, reachable: false, authenticated: null, code: 'server_unavailable' }
  }
}

export interface GatewayModels {
  models: string[]
  aliases: Record<string, string>
  /** Per-alias capability — a gateway supporting vision does not make every model see. */
  modelCapabilities: Record<string, { vision: boolean }>
  imageLimits: { maxImageBytes: number; maxImagesPerMessage: number; allowedTypes: string[] }
  /** Whether a web-search provider is configured server-side. */
  webSearch?: { available: boolean; provider: string; reason: string | null }
}

const NO_MODELS: GatewayModels = {
  models: [],
  aliases: {},
  modelCapabilities: {},
  imageLimits: { maxImageBytes: 0, maxImagesPerMessage: 0, allowedTypes: [] },
  webSearch: { available: false, provider: 'none', reason: 'disabled' },
}

/** Model catalogue + capabilities, resolved server-side. Never includes credentials. */
export async function fetchModels(signal?: AbortSignal): Promise<GatewayModels> {
  if (isDemoMode) return NO_MODELS
  try {
    const response = await fetch('/api/models', { signal, cache: 'no-store' })
    if (!response.ok) return NO_MODELS
    const data = (await response.json()) as Partial<GatewayModels>
    return {
      models: data.models ?? [],
      aliases: data.aliases ?? {},
      modelCapabilities: data.modelCapabilities ?? {},
      imageLimits: data.imageLimits ?? NO_MODELS.imageLimits,
      webSearch: data.webSearch ?? NO_MODELS.webSearch,
    }
  } catch {
    return NO_MODELS
  }
}

/* ============================================================
   Multimodal request building
   ---------------------------
   Attachment bytes live only as object URLs in the browser (they
   are deliberately never persisted — see store.dropDeadPreviewUrls),
   so they are read back and inlined as base64 data URLs at request
   time. The resulting shape is the OpenAI content-part format, which
   OmniRoute accepts (verified against its visionBridgeHelpers
   contract) as does every OpenAI-compatible gateway.
   ============================================================ */

type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /** PixGPT-only: the server extracts text and the model never sees the binary. */
  | { type: 'file'; file: { name: string; mime: string; url: string } }

type WireContent = string | WirePart[]

async function objectUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    if (blob.size === 0) return null
    return await new Promise<string>((resolvePromise, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolvePromise(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null // a revoked or dead object URL — the message still sends as text
  }
}

async function toWireMessages(
  messages: ChatMessage[],
): Promise<Array<{ role: string; content: WireContent }>> {
  const out: Array<{ role: string; content: WireContent }> = []

  for (const message of messages) {
    const ready = (message.attachments ?? []).filter((a) => a.status === 'completed' && a.url)
    const images = ready.filter((a) => a.kind === 'image')
    const files = ready.filter((a) => a.kind === 'file')

    if (images.length === 0 && files.length === 0) {
      out.push({ role: message.role, content: message.content })
      continue
    }

    const parts: WirePart[] = []
    if (message.content.trim()) parts.push({ type: 'text', text: message.content })

    for (const image of images) {
      const dataUrl = await objectUrlToDataUrl(image.url as string)
      if (dataUrl) parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
    for (const file of files) {
      const dataUrl = await objectUrlToDataUrl(file.url as string)
      if (dataUrl) {
        parts.push({
          type: 'file',
          file: { name: file.name, mime: file.mime ?? '', url: dataUrl },
        })
      }
    }

    // If every attachment failed to read, fall back to the plain text message
    const hasAttachment = parts.some((p) => p.type !== 'text')
    out.push({ role: message.role, content: hasAttachment ? parts : message.content })
  }

  return out
}

/** How many images the request would carry — lets the UI warn before sending. */
export function countImageAttachments(messages: ChatMessage[]): number {
  return messages.reduce(
    (n, m) => n + (m.attachments ?? []).filter((a) => a.kind === 'image' && a.url).length,
    0,
  )
}

/* ============================================================
   Server-backed provider
   ============================================================ */

/**
 * If the server or network dies mid-stream without closing the socket, the read
 * loop would wait forever and the UI would sit on "Generating…". This watchdog
 * aborts after a period of silence so the store always reaches a final state.
 * It resets on every received event, so slow answers are unaffected.
 */
const CLIENT_IDLE_TIMEOUT_MS = 90_000

const httpStreamCompletion: ChatAPI['streamCompletion'] = async (request, signal, onToken, onSource, onDone) => {
  const internal = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let idleExpired = false

  const armWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleExpired = true
      internal.abort()
    }, CLIENT_IDLE_TIMEOUT_MS)
  }
  const disarmWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer)
  }

  // A user-initiated stop must still propagate
  const onOuterAbort = () => internal.abort()
  if (signal.aborted) internal.abort()
  else signal.addEventListener('abort', onOuterAbort, { once: true })

  const cleanup = () => {
    disarmWatchdog()
    signal.removeEventListener('abort', onOuterAbort)
  }

  /** Distinguishes "user pressed Stop" from "the stream went silent". */
  const abortReason = (error: unknown) => {
    if (idleExpired && !signal.aborted) {
      return new ChatRequestError('timeout', FALLBACK_MESSAGES.timeout)
    }
    return error
  }

  let response: Response
  try {
    // Reading attachment bytes happens before the watchdog starts so a slow
    // base64 conversion is never mistaken for a stalled gateway.
    const wireMessages = await toWireMessages(request.messages)

    armWatchdog()
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: internal.signal,
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature,
        stream: true,
        web: request.web === true,
        messages: wireMessages,
      }),
    })
  } catch (error) {
    cleanup()
    const reason = abortReason(error)
    if (reason instanceof ChatRequestError) throw reason
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
    throw new ChatRequestError('gateway_unavailable', FALLBACK_MESSAGES.gateway_unavailable)
  }

  // A failure before the stream opens arrives as JSON
  if (!response.ok) {
    cleanup()
    let code: string | undefined
    let message: string | undefined
    try {
      const data = (await response.json()) as { error?: { code?: string; message?: string } }
      code = data.error?.code
      message = data.error?.message
    } catch {
      /* non-JSON error body */
    }
    throw toError(code, message)
  }

  if (!response.body) {
    cleanup()
    throw new ChatRequestError('malformed_response', FALLBACK_MESSAGES.malformed_response)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamError: ChatRequestError | null = null

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      armWatchdog() // the stream is alive; restart the silence clock
      buffer += decoder.decode(value, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue

          let event: {
            type?: string
            value?: string
            code?: string
            message?: string
            title?: string
            url?: string
            /** `done` carries the route that actually answered. */
            model?: string
            fellBack?: boolean
            /** True when the model hit its output ceiling mid-answer. */
            truncated?: boolean
          }
          try {
            event = JSON.parse(payload)
          } catch {
            continue // ignore a single malformed frame rather than fail the answer
          }

          if (event.type === 'token' && typeof event.value === 'string') onToken(event.value)
          else if (event.type === 'source' && event.url) {
            onSource?.({ title: event.title || event.url, url: event.url })
          } else if (event.type === 'done') {
            // The server names the route that actually answered; it is not
            // always the one requested, and the UI has to be able to say so.
            onDone?.({
              model: event.model,
              fellBack: Boolean(event.fellBack),
              truncated: Boolean(event.truncated),
            })
          } else if (event.type === 'error') streamError = toError(event.code, event.message)
          // Unknown event types are ignored on purpose, so the server can add
          // new ones (tool_call, status…) without breaking older clients.
        }
      }
    }
  } catch (error) {
    const reason = abortReason(error)
    if (reason instanceof ChatRequestError) throw reason
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
    // Transport died mid-stream: partial text is kept, the turn ends as an error
    throw new ChatRequestError('stream_failed', FALLBACK_MESSAGES.stream_failed)
  } finally {
    cleanup()
    // Releasing the lock lets an aborted fetch tear the connection down cleanly
    reader.releaseLock?.()
  }

  // Reported after the stream closes so partial text stays on screen
  if (streamError) throw streamError
}

/* ============================================================
   Local capabilities
   --------------------
   OmniRoute is a chat gateway: it does not accept file uploads or
   speech-to-text. These two keep their existing local behaviour so
   nothing that worked before stops working. They are the place to
   wire real services later.
   ============================================================ */

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

const localUploadAttachment: ChatAPI['uploadAttachment'] = async (file, signal, onProgress) => {
  // Dev-only fault injection so the upload failure/retry path can be
  // exercised end to end. Stripped from production builds.
  if (import.meta.env.DEV && (window as unknown as { __PIXGPT_FAIL_UPLOAD__?: boolean }).__PIXGPT_FAIL_UPLOAD__) {
    throw new Error('injected upload failure')
  }
  // Attachments are held client-side and previewed locally; they are not sent
  // to the model. Progress is reported in steps so the UI's bar tracks it.
  const steps = 8
  const perStep = (60 + Math.random() * 60) / steps
  for (let i = 1; i <= steps; i++) {
    await sleep(perStep, signal)
    onProgress(i / steps)
  }
  return { id: file.name + Date.now(), name: file.name, size: file.size }
}

const localTranscribeAudio: ChatAPI['transcribeAudio'] = async (_blob, signal) => {
  await sleep(1100, signal)
  return 'This is a demo voice transcription. Connect a speech-to-text backend to replace it.'
}

/* ============================================================
   Demo provider — used only when VITE_PIXGPT_DEMO=1
   ============================================================ */

function* tokenize(text: string): Generator<string> {
  let i = 0
  while (i < text.length) {
    const len = 1 + Math.floor(Math.random() * 3)
    yield text.slice(i, i + len)
    i += len
  }
}

const DEMO_REPLY = `# Here's what I found

Great question — let's break it down step by step.

## Key points

1. **Clarity first.** Define the outcome before the implementation details.
2. **Keep it composable.** Small, focused pieces are easier to test and reuse.
3. **Measure, then optimize.** Never guess about performance.

### Example implementation

Here is a production-ready TypeScript example:

\`\`\`tsx
interface Result<T> {
  ok: true
  data: T
} | { ok: false; error: string }

async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
\`\`\`

## Comparison

| Approach | Speed | Complexity | Best for |
| --- | --- | --- | --- |
| Callback | Fast | Low | Small utilities |
| Promise | Fast | Medium | Most async work |
| Stream | Medium | High | Large payloads |

> **Tip:** prefer \`AbortSignal\` over boolean flags — it works with \`fetch\`, streams, and workers.

## The math

The expected value is $E[X] = \\sum_{i=1}^{n} p_i x_i$, which for equally likely outcomes simplifies to:

$$
\\mu = \\frac{1}{n} \\sum_{i=1}^{n} x_i
$$

Want me to go deeper on any of these points?`

export const demoChatApi: ChatAPI = {
  async streamCompletion(_request, signal, onToken) {
    await sleep(450 + Math.random() * 350, signal)
    for (const token of tokenize(DEMO_REPLY)) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await sleep(10 + Math.random() * 26, signal)
      onToken(token)
    }
  },
  uploadAttachment: localUploadAttachment,
  transcribeAudio: localTranscribeAudio,
}

export const omniRouteChatApi: ChatAPI = {
  streamCompletion: httpStreamCompletion,
  uploadAttachment: localUploadAttachment,
  transcribeAudio: localTranscribeAudio,
}

export const chatApi: ChatAPI = isDemoMode ? demoChatApi : omniRouteChatApi
