/* ============================================================
   Gateway error vocabulary
   ------------------------
   One error shape for every gateway, so the frontend never has to
   know which backend produced a failure. Upstream bodies are never
   forwarded verbatim — they can carry provider identifiers or key
   fragments — they go to the server log instead.

   Extracted unchanged in behaviour from the original OmniRoute
   client so existing responses stay byte-identical.
   ============================================================ */

export class GatewayError extends Error {
  constructor(code, message, { status = 502, retryable = false, detail } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.detail = detail
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } }
  }
}

/**
 * `retryable` drives model-level fallback: only these are worth re-attempting
 * with another model, and only before any bytes have reached the browser.
 */
export const ERRORS = {
  gateway_unavailable: {
    status: 503,
    message: 'The AI gateway is not reachable. Make sure it is running.',
    retryable: true,
  },
  invalid_api_key: {
    status: 502,
    // Deliberately vague to the browser — the actionable detail (which env var
    // to fix) goes to the server log, not to end users.
    message: 'The AI gateway rejected this server’s credentials.',
    retryable: false,
  },
  provider_unavailable: {
    status: 502,
    message: 'The upstream AI provider is unavailable right now.',
    retryable: true,
  },
  model_unavailable: {
    status: 502,
    message: 'That model is not available right now.',
    retryable: true,
  },
  rate_limited: {
    status: 429,
    message: 'Rate limit reached. Please try again in a moment.',
    retryable: true,
  },
  quota_exceeded: {
    status: 402,
    message: 'The configured AI account has run out of quota.',
    retryable: false,
  },
  provider_error: {
    status: 502,
    message: 'The AI provider failed to complete this request.',
    retryable: true,
  },
  timeout: {
    status: 504,
    message: 'The AI gateway took too long to respond.',
    retryable: true,
  },
  malformed_response: {
    status: 502,
    message: 'The AI gateway returned an unreadable response.',
    retryable: true,
  },
  stream_failed: {
    status: 502,
    message: 'The response stream ended unexpectedly.',
    retryable: false,
  },
  bad_request: {
    status: 400,
    message: 'That request could not be processed.',
    retryable: false,
  },
  unsupported: {
    status: 501,
    message: 'The selected AI gateway does not support this feature.',
    retryable: false,
  },
  client_closed: {
    status: 499,
    message: 'Client closed the request.',
    retryable: false,
  },
}

export function gatewayError(code, detail) {
  const spec = ERRORS[code] ?? ERRORS.provider_error
  return new GatewayError(code, spec.message, {
    status: spec.status,
    retryable: spec.retryable,
    detail,
  })
}

/** Transport-level failure -> stable code. */
export function classifyNetworkError(error, timedOut) {
  if (timedOut) return gatewayError('timeout', 'idle timeout exceeded')
  const cause = error?.cause ?? error
  const sysCode = cause?.code
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(sysCode)) {
    return gatewayError('gateway_unavailable', sysCode)
  }
  if (error?.name === 'AbortError') return gatewayError('timeout', 'aborted')
  return gatewayError('gateway_unavailable', error?.message)
}

/**
 * HTTP status (plus a peek at the body) -> stable code.
 *
 * Gateways differ in how they signal quota vs rate limit vs missing model, so
 * the body text is inspected for well-known markers. An adapter can override
 * this entirely via `classifyStatus` when its gateway is idiosyncratic.
 */
export function classifyStatus(status, bodyText) {
  const body = (bodyText ?? '').slice(0, 400)
  const lower = body.toLowerCase()

  if (status === 401 || status === 403) {
    return gatewayError('invalid_api_key', `status=${status} — check the gateway API key in your .env`)
  }
  if (status === 402 || lower.includes('insufficient_quota') || lower.includes('quota')) {
    return gatewayError('quota_exceeded', `status=${status} ${body}`)
  }
  if (status === 429) return gatewayError('rate_limited', `status=${status}`)
  if (status === 404) return gatewayError('model_unavailable', `status=${status} ${body}`)
  if (status === 400 && /model/i.test(body)) return gatewayError('model_unavailable', body)
  if (status === 400) return gatewayError('bad_request', body)
  if (status === 502 || status === 503 || status === 504) {
    return gatewayError('provider_unavailable', `status=${status} ${body}`)
  }
  if (status >= 500) return gatewayError('provider_error', `status=${status} ${body}`)
  return gatewayError('provider_error', `status=${status} ${body}`)
}
