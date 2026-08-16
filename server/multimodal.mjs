import { GatewayError } from './gateway/errors.mjs'
import { documentLimits, extractDocument, renderDocumentBlock } from './documents.mjs'

/* ============================================================
   Multimodal (image) input
   ------------------------
   PixGPT sends images as OpenAI-style content parts:

     { role: 'user', content: [
         { type: 'text',      text: '…' },
         { type: 'image_url', image_url: { url: 'data:image/png;base64,…' } },
     ]}

   That shape is verified against OmniRoute's own contract — see
   src/lib/guardrails/visionBridgeHelpers.ts in the OmniRoute repo,
   which declares `{ type: "image_url"; image_url: { url, detail? } }`
   as an accepted top-level part. It is also the documented OpenAI
   Chat Completions vision format, so every OpenAI-compatible
   gateway understands it.

   SECURITY: data: URLs only, by default. Accepting arbitrary
   http(s) image URLs would hand the gateway (and through it, the
   provider) a request-forgery primitive against anything reachable
   from its network. Remote URLs are therefore opt-in and
   host-allowlisted.
   ============================================================ */

function num(name, fallback) {
  const raw = Number.parseFloat(process.env[name] ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function intFrom(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * Formats PixGPT will forward. Deliberately conservative: these four are the
 * ones broadly supported by vision models. GIF is included because the UI
 * accepts it, but note that most models read only its first frame.
 */
const DEFAULT_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export const imageLimits = {
  maxImageBytes: Math.round(num('MAX_IMAGE_SIZE_MB', 4) * 1024 * 1024),
  maxImagesPerMessage: intFrom('MAX_IMAGES_PER_MESSAGE', 3),
  maxRequestBytes: Math.round(num('MAX_REQUEST_SIZE_MB', 10) * 1024 * 1024),
  mimeAllowlist: (process.env.ALLOWED_IMAGE_TYPES ?? DEFAULT_MIME_ALLOWLIST.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  allowRemoteUrls: process.env.ALLOW_REMOTE_IMAGE_URLS === 'true',
  remoteHostAllowlist: (process.env.REMOTE_IMAGE_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
}

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

/** Base64 decodes to 3 bytes per 4 chars, minus padding. Avoids decoding to measure. */
function base64Bytes(base64) {
  const clean = base64.replace(/\s/g, '')
  const padding = (clean.match(/=+$/) ?? [''])[0].length
  return Math.floor((clean.length * 3) / 4) - padding
}

/** Hosts that must never be reachable, even when remote URLs are enabled. */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  if (h === '0.0.0.0' || h === '169.254.169.254') return true // link-local / cloud metadata
  // IPv4 private and loopback ranges
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true
    if (a === 169 && b === 254) return true
  }
  // IPv6 loopback / unique-local / link-local
  if (h.startsWith('[::') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

/**
 * Validates one image reference and returns the value to forward.
 * @returns {string} the url to place in `image_url.url`
 */
export function validateImageUrl(url) {
  if (typeof url !== 'string' || url.length === 0) throw bad('An image is missing its data.')

  if (url.startsWith('data:')) {
    const match = DATA_URL.exec(url)
    if (!match) throw bad('That image could not be read. Only base64 image data is accepted.')

    const mime = match[1].toLowerCase()
    if (!imageLimits.mimeAllowlist.includes(mime)) {
      throw bad(`Unsupported image type. Allowed: ${imageLimits.mimeAllowlist.join(', ')}.`)
    }

    const bytes = base64Bytes(match[2])
    if (bytes <= 0) throw bad('That image appears to be empty.')
    if (bytes > imageLimits.maxImageBytes) {
      const mb = (imageLimits.maxImageBytes / (1024 * 1024)).toFixed(1)
      throw bad(`Image is too large. The limit is ${mb} MB per image.`)
    }
    return url
  }

  // Anything non-data: is a remote fetch performed by the gateway/provider
  if (!/^https?:\/\//i.test(url)) throw bad('Only base64 or https image URLs are accepted.')
  if (!imageLimits.allowRemoteUrls) {
    throw bad('Remote image URLs are not enabled on this server.')
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw bad('That image URL is not valid.')
  }
  if (parsed.protocol !== 'https:') throw bad('Remote image URLs must use https.')
  if (isPrivateHost(parsed.hostname)) throw bad('That image URL is not allowed.')
  if (imageLimits.remoteHostAllowlist.length > 0) {
    const host = parsed.hostname.toLowerCase()
    const ok = imageLimits.remoteHostAllowlist.some((h) => host === h || host.endsWith(`.${h}`))
    if (!ok) throw bad('That image host is not allowed.')
  }
  return parsed.toString()
}

/**
 * Normalises one message's `content` when it is an array of parts.
 *
 * @returns {{ content: string|Array, images: number, textChars: number }}
 */
export async function normaliseContentParts(parts, { visionAllowed, gatewaySupportsVision, modelLabel }) {
  const text = []
  const images = []
  const files = []

  for (const part of parts) {
    if (part === null || typeof part !== 'object') throw bad('Message content parts must be objects.')

    if (part.type === 'text' || part.type === 'input_text') {
      if (typeof part.text !== 'string') throw bad('A text part is missing its `text`.')
      text.push(part.text)
      continue
    }

    if (part.type === 'image_url') {
      const raw = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      images.push(validateImageUrl(raw))
      continue
    }

    // A PixGPT-only part: the server extracts text and the model receives that,
    // never the binary. See documents.mjs.
    if (part.type === 'file') {
      if (files.length >= documentLimits.maxFilesPerMessage) {
        throw bad(`Too many files. The limit is ${documentLimits.maxFilesPerMessage} per message.`)
      }
      files.push(part.file ?? {})
      continue
    }

    throw bad(`Unsupported content part type: ${String(part.type).slice(0, 40)}.`)
  }

  // Extract documents sequentially so a batch cannot multiply peak memory
  for (const file of files) {
    const extracted = await extractDocument({ name: file.name, mime: file.mime, url: file.url })
    text.push(renderDocumentBlock({ name: file.name, ...extracted }))
  }

  if (images.length > 0) {
    if (!gatewaySupportsVision) {
      throw new GatewayError(
        'unsupported',
        'The configured AI gateway does not support image input.',
        { status: 501 },
      )
    }
    if (!visionAllowed) {
      throw new GatewayError(
        'unsupported',
        `${modelLabel} does not support image input. Please select a vision-capable model.`,
        { status: 501 },
      )
    }
    if (images.length > imageLimits.maxImagesPerMessage) {
      throw bad(`Too many images. The limit is ${imageLimits.maxImagesPerMessage} per message.`)
    }
  }

  const joinedText = text.join('\n\n').trim()
  if (images.length === 0) {
    // No images: a plain string, so text-only gateways and models see exactly
    // what they saw before. Extracted document text rides along here.
    return { content: joinedText, images: 0, files: files.length, textChars: joinedText.length }
  }

  const content = []
  if (joinedText) content.push({ type: 'text', text: joinedText })
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })

  return { content, images: images.length, files: files.length, textChars: joinedText.length }
}
