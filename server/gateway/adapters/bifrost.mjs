/**
 * Bifrost — https://github.com/maximhq/bifrost  (Apache-2.0)
 *
 * Exposes a unified OpenAI-compatible endpoint at `/v1`, plus provider-shaped
 * drop-in prefixes (`/openai`, `/anthropic`, `/genai`). We use `/v1`.
 */
export default {
  id: 'bifrost',
  label: 'Bifrost',
  repo: 'https://github.com/maximhq/bifrost',
  license: 'Apache-2.0',
  defaultBaseUrl: 'http://localhost:8080/v1',
  defaultHealthPath: null, // no documented health route; falls back to /v1/models
  defaultModel: 'openai/gpt-4o-mini',
  run: 'npx -y @maximhq/bifrost   (or: docker run -p 8080:8080 maximhq/bifrost)',

  capabilities: {
    chat: true,
    streaming: true,
    models: true,
    routing: true, // request distribution across keys and providers
    fallback: true, // "seamless failover between providers and models"
    vision: true, // text, images and audio behind one interface
    tools: true, // via MCP
    embeddings: false, // not documented in the README
  },

  notes:
    'Providers and keys are configured in Bifrost\'s own UI/config, and models are ' +
    'addressed as `provider/model` (e.g. `openai/gpt-4o-mini`). If your build serves the ' +
    'OpenAI drop-in prefix instead, set AI_GATEWAY_URL to http://localhost:8080/openai.',
}
