/**
 * OpenRouter — https://openrouter.ai
 *
 * Added after reverse-engineering Freebuff, which turned out not to be a
 * multi-provider system at all: it proxies everything through its own
 * `/api/v1` endpoint to OpenRouter, and its model ids — `anthropic/claude-*`,
 * `openai/gpt-*`, `deepseek/*`, `z-ai/glm-*`, `moonshotai/kimi-*` — are
 * OpenRouter ids passed straight through. Verified: `anthropic/claude-opus-4.1`
 * resolves on OpenRouter with the same 200k context window Freebuff records.
 *
 * So the useful integration is the upstream itself, reached with PixGPT's own
 * key rather than through anyone else's proxy.
 *
 * Two things make this adapter worth more than "another gateway":
 *
 *   · `GET /models` needs no key and returns authoritative metadata —
 *     context_length, supported_parameters, input_modalities, pricing. That
 *     replaces PixGPT's id-guessing with facts for 400+ models.
 *   · 245 of those models declare image input, which is the capability PixGPT
 *     has never once managed to verify through OmniRoute.
 */
export default {
  id: 'openrouter',
  label: 'OpenRouter',
  repo: 'https://openrouter.ai/docs',
  license: 'commercial — bring your own key',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  /**
   * No dedicated health route. `/models` answers without credentials, so the
   * shared client's catalogue probe doubles as the liveness check.
   */
  defaultHealthPath: null,
  defaultModel: 'openai/gpt-4o-mini',
  run: 'Set OPENROUTER_API_KEY. Create a key at https://openrouter.ai/keys',

  capabilities: {
    chat: true,
    streaming: true,
    models: true,
    routing: true, // `:floor`, `:nitro` and provider preferences
    fallback: true, // documented `models` array for automatic failover
    vision: true, // 245 models declare image input
    tools: true, // 346 models declare tool support
    embeddings: false, // OpenRouter does not expose an embeddings route
  },

  /**
   * OpenRouter asks for attribution headers and uses them for the public
   * leaderboard. They are optional, carry no credential, and are set from
   * configuration so a deployment can identify itself honestly.
   */
  buildHeaders(base, cfg) {
    const headers = { ...base }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL ?? 'https://pixgpt.local'
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME ?? 'PixGPT'
    return headers
  },

  /**
   * `usage.include` asks OpenRouter to report real cost and token counts on
   * every response — the same fields Freebuff reads to track spend. PixGPT does
   * not bill anyone, but the numbers are what a cost view would need and they
   * are free to ask for.
   */
  buildBody(body) {
    return { ...body, usage: { include: true } }
  },

  validate(cfg) {
    const problems = []
    // The catalogue is public; inference is not.
    if (!cfg.apiKey) problems.push('OPENROUTER_API_KEY is not set — the model catalogue will load but no request can be sent.')
    return problems
  },

  notes:
    'The upstream Freebuff proxies to. 400+ models under one OpenAI-compatible ' +
    'surface, with a keyless catalogue that carries authoritative context windows ' +
    'and capability flags.',
}
