/**
 * Portkey Gateway — https://github.com/Portkey-AI/gateway  (MIT)
 *
 * The one supported gateway that is not plain Bearer auth: it needs the target
 * provider named in a header, with the provider's own key in `Authorization`.
 * That difference lives here rather than leaking into the shared transport.
 */
export default {
  id: 'portkey',
  label: 'Portkey Gateway',
  repo: 'https://github.com/Portkey-AI/gateway',
  license: 'MIT',
  defaultBaseUrl: 'http://localhost:8787/v1',
  defaultHealthPath: null, // no documented health route
  defaultModel: 'gpt-4o-mini',
  run: 'npx @portkey-ai/gateway   (or: docker run -p 8787:8787 portkeyai/gateway)',

  capabilities: {
    chat: true,
    streaming: true,
    models: false, // no OpenAI /v1/models catalogue verified on the OSS gateway
    routing: true,
    fallback: true, // via x-portkey-config routing configs
    vision: true, // documented multi-modal support
    tools: true,
    embeddings: false, // not verified
  },

  /**
   * Portkey identifies the upstream provider by header and expects that
   * provider's key as the bearer token.
   */
  buildHeaders(base, cfg) {
    const headers = { ...base }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

    const provider = process.env.PORTKEY_PROVIDER
    if (provider) headers['x-portkey-provider'] = provider

    // Optional: Portkey platform key, virtual key, or a routing config that
    // enables Portkey's own load balancing and fallbacks.
    //
    // Note the name: PORTKEY_API_KEY is already claimed by the generic
    // <PROVIDER>_API_KEY pattern for the upstream provider's bearer token, so
    // the platform key gets its own variable rather than colliding with it.
    if (process.env.PORTKEY_PLATFORM_KEY) headers['x-portkey-api-key'] = process.env.PORTKEY_PLATFORM_KEY
    if (process.env.PORTKEY_VIRTUAL_KEY) headers['x-portkey-virtual-key'] = process.env.PORTKEY_VIRTUAL_KEY
    if (process.env.PORTKEY_CONFIG) headers['x-portkey-config'] = process.env.PORTKEY_CONFIG

    return headers
  },

  /** Fail fast with a clear message instead of a confusing 4xx from Portkey. */
  validate(cfg) {
    const problems = []
    if (!process.env.PORTKEY_PROVIDER && !process.env.PORTKEY_VIRTUAL_KEY && !process.env.PORTKEY_CONFIG) {
      problems.push('set PORTKEY_PROVIDER (e.g. "openai"), PORTKEY_VIRTUAL_KEY, or PORTKEY_CONFIG')
    }
    if (!cfg.apiKey && !process.env.PORTKEY_VIRTUAL_KEY) {
      problems.push('set AI_GATEWAY_API_KEY to the upstream provider key')
    }
    return problems
  },

  notes:
    'Portkey self-hosts on port 8787 by default — the same port PixGPT\'s server uses. ' +
    'Change one of them (e.g. PORT=8788 for PixGPT). Native fallback/load balancing is ' +
    'configured through PORTKEY_CONFIG, which is passed as the x-portkey-config header.',
}
