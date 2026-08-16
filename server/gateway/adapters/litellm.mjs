/**
 * LiteLLM Proxy — https://github.com/BerriAI/litellm  (MIT; `enterprise/`
 * directory carries a separate commercial licence — we only call the HTTP API,
 * so no LiteLLM code is redistributed by PixGPT.)
 *
 * Straight OpenAI-compatible proxy with Bearer virtual keys (`sk-...`).
 */
export default {
  id: 'litellm',
  label: 'LiteLLM',
  repo: 'https://github.com/BerriAI/litellm',
  license: 'MIT (enterprise/ subdirectory licensed separately)',
  defaultBaseUrl: 'http://localhost:4000/v1',
  defaultHealthPath: '/health/liveliness',
  defaultModel: 'gpt-4o-mini',
  run: 'pip install "litellm[proxy]" && litellm --config litellm.config.yaml --port 4000',

  capabilities: {
    chat: true,
    streaming: true,
    models: true,
    routing: true, // Router with load balancing across deployments
    fallback: true, // native retry/fallback policy in the router config
    vision: true,
    tools: true,
    embeddings: true, // /embeddings endpoint
  },

  notes:
    'Routing and fallbacks are configured in LiteLLM\'s own config YAML (model_list + ' +
    'router_settings), not by PixGPT. Model names are the aliases you define there.',
}
