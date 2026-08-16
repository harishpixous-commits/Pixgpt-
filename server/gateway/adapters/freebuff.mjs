import { gatewayError } from '../errors.mjs'

/**
 * Freebuff / Codebuff — https://freebuff.com
 *
 * Reproduced from the shipped desktop application's own implementation
 * (`sdk/src/impl/model-provider.ts`), not from its stored credentials.
 *
 * What that implementation actually does:
 *
 *   new OpenAICompatibleChatLanguageModel(model, {
 *     provider: 'codebuff',
 *     url: ({ path }) => new URL(path.join('/api/v1', path), websiteUrl),
 *     headers: () => ({
 *       Authorization: `Bearer ${apiKey}`,
 *       ...(userId && { [FREEBUFF_ACTING_USER_HEADER]: userId }),
 *       ...(byokKey && { 'x-openrouter-api-key': byokKey }),
 *     }),
 *   })
 *
 * One adapter, OpenAI-compatible, Bearer auth — so it needs almost nothing
 * here beyond its base URL and the two optional headers.
 *
 * `x-openrouter-api-key` is their BYOK path (`CODEBUFF_BYOK_OPENROUTER`): supply
 * your own OpenRouter key and the proxy bills you instead of them. If you have
 * that key, the `openrouter` adapter reaches the same models one hop shorter,
 * and this adapter exists for accounts that only have Freebuff credentials.
 *
 * Credentials come from PixGPT's environment. Nothing is read from the
 * installed application.
 */
export default {
  id: 'freebuff',
  label: 'Freebuff',
  repo: 'https://freebuff.com',
  license: 'commercial — account required',
  defaultBaseUrl: 'https://freebuff.com/api/v1',
  defaultHealthPath: null,
  defaultModel: 'anthropic/claude-sonnet-4.5',
  run: 'Set FREEBUFF_API_KEY (and optionally FREEBUFF_BYOK_OPENROUTER).',

  capabilities: {
    chat: true,
    streaming: true,
    /**
     * The desktop client ships a hardcoded model list and never calls a
     * catalogue route; none is documented. Models come from configuration.
     */
    models: false,
    routing: true,
    fallback: true,
    vision: true, // its model cards carry `multimodal: true`
    tools: true, // the agent runtime is built on tool calling throughout
    embeddings: false,
  },

  buildHeaders(base, cfg) {
    const headers = { ...base }
    if (cfg.apiKey) {
      headers.Authorization = `Bearer ${cfg.apiKey}`
      // The client sends both; the second is what its own API gate reads.
      headers['x-codebuff-api-key'] = cfg.apiKey
    }
    /*
     * BYOK passthrough. Present only when the operator sets it, and it is their
     * own OpenRouter key — never anything recovered from the application.
     */
    const byok = process.env.FREEBUFF_BYOK_OPENROUTER
    if (byok) headers['x-openrouter-api-key'] = byok
    return headers
  },

  /**
   * Freebuff answers 429 with `{"error":"free_mode_capacity_deferred"}` and a
   * `retry-after` header when its free pool is saturated. That is a queue, not
   * a fault, and it must not be mistaken for a broken route — the model
   * registry cools a rate-limited route far more briefly than a failing one.
   */
  classifyStatus(status, bodyText) {
    if (status !== 429) return null // everything else uses the shared classifier
    const deferred = /free_mode_capacity_deferred/.test((bodyText ?? '').slice(0, 400))
    return gatewayError('rate_limited', `status=429${deferred ? ' free_mode_capacity_deferred' : ''}`)
  },

  validate(cfg) {
    const problems = []
    if (!cfg.apiKey) problems.push('FREEBUFF_API_KEY is not set — this gateway cannot be used.')
    return problems
  },

  notes:
    'A proxy in front of OpenRouter. Its model ids are OpenRouter ids. Prefer the ' +
    '`openrouter` adapter when you hold an OpenRouter key; use this one when your ' +
    'credentials are for Freebuff itself.',
}
