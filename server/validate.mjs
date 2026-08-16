import { GatewayError } from './gateway/errors.mjs'
import { imageLimits, normaliseContentParts } from './multimodal.mjs'

/* ============================================================
   Request validation for /api/chat
   --------------------------------
   Plain functions in the project's existing style — no schema
   framework for one endpoint. Every rejection is a `bad_request`
   GatewayError so the response shape matches every other failure.
   ============================================================ */

export const LIMITS = {
  /**
   * Text-only conversations need well under 1 MB, but a base64 image is ~1.37×
   * its byte size, so the body cap follows MAX_REQUEST_SIZE_MB. Rate limiting
   * bounds the cost of the larger ceiling.
   */
  bodyBytes: imageLimits.maxRequestBytes,
  messages: 200, // most recent N are forwarded
  totalPromptChars: 400_000, // prose only; image payloads are capped separately
  modelChars: 200,
  tools: 64,
}

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

/**
 * Model ids are interpolated into an upstream URL body and logged, so keep them
 * to the shape real gateways use: `auto`, `gpt-4o-mini`, `openai/gpt-4o`,
 * `oc/claude-sonnet-4.5`, `qwen-turbo:latest`. Rejecting anything else stops
 * newline/control-character injection into logs and upstream payloads.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/

export function validateModel(value) {
  if (value === undefined || value === null || value === '') return undefined // server picks the default
  if (typeof value !== 'string') throw bad('`model` must be a string.')
  const model = value.trim()
  if (model.length === 0) return undefined
  if (model.length > LIMITS.modelChars) throw bad('`model` is too long.')
  if (!MODEL_PATTERN.test(model)) throw bad('`model` contains unsupported characters.')
  return model
}

/**
 * Reduces PixGPT's stored messages to the OpenAI wire shape.
 *
 * The client persists extra fields (id, createdAt, status, attachments,
 * feedback). Stripping them here means the frontend keeps its existing message
 * format untouched — nothing in the store or components had to change.
 */
export async function toWireMessages(
  input,
  vision = { visionAllowed: false, gatewaySupportsVision: false, modelLabel: 'This model' },
) {
  if (!Array.isArray(input)) throw bad('`messages` must be an array.')
  if (input.length === 0) throw bad('`messages` must not be empty.')

  const messages = []
  let totalChars = 0
  let totalImages = 0
  let totalFiles = 0

  for (const m of input.slice(-LIMITS.messages)) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw bad('Each entry in `messages` must be an object.')
    }
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'

    let content
    let textChars

    if (Array.isArray(m.content)) {
      // Multimodal message: validate parts and extract any attached documents
      const result = await normaliseContentParts(m.content, vision)
      content = result.content
      textChars = result.textChars
      totalImages += result.images
      totalFiles += result.files
    } else {
      content = typeof m.content === 'string' ? m.content : ''
      textChars = content.length
    }

    // Skip the empty assistant placeholder the UI creates before streaming
    const isEmpty = typeof content === 'string' ? !content.trim() : content.length === 0
    if (isEmpty) continue

    // Base64 image payloads are bounded separately by imageLimits, so only
    // prose counts toward the prompt-size budget.
    totalChars += textChars
    if (totalChars > LIMITS.totalPromptChars) throw bad('The conversation is too large to send.')

    messages.push({ role, content })
  }

  if (messages.length === 0) throw bad('`messages` contained no usable content.')
  return { messages, images: totalImages, files: totalFiles }
}

export function clampTemperature(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || Number.isNaN(value)) throw bad('`temperature` must be a number.')
  return Math.min(Math.max(value, 0), 2)
}

export function clampMaxTokens(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('`max_tokens` must be a number.')
  return Math.min(Math.max(Math.trunc(value), 1), 200_000)
}

/**
 * PixGPT's UI does not use tool calling today. The field is accepted and
 * forwarded so the abstraction does not block it later, but it is shape-checked
 * rather than passed through blindly.
 */
export function validateTools(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw bad('`tools` must be an array.')
  if (value.length === 0) return undefined
  if (value.length > LIMITS.tools) throw bad('Too many entries in `tools`.')

  for (const tool of value) {
    if (tool === null || typeof tool !== 'object') throw bad('Each tool must be an object.')
    if (tool.type !== 'function') throw bad('Each tool must have type "function".')
    const fn = tool.function
    if (fn === null || typeof fn !== 'object') throw bad('Each tool needs a `function` object.')
    if (typeof fn.name !== 'string' || fn.name.length === 0) throw bad('Each tool function needs a `name`.')
  }
  return value
}

export function validateStream(value) {
  if (value === undefined || value === null) return true // streaming is the default
  if (typeof value !== 'boolean') throw bad('`stream` must be a boolean.')
  return value
}
