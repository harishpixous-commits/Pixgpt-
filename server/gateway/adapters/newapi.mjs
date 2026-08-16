/**
 * New API — https://github.com/Calcium-Ion/new-api  (AGPL-3.0)
 *
 * A One API fork with a broader endpoint surface. PixGPT talks to it over HTTP
 * only — no New API code is copied or linked, so AGPL copyleft does not reach
 * PixGPT's own source. See docs/ai-gateways.md for the licence note.
 */
export default {
  id: 'newapi',
  label: 'New API',
  repo: 'https://github.com/Calcium-Ion/new-api',
  license: 'AGPL-3.0',
  defaultBaseUrl: 'http://localhost:3000/v1',
  defaultHealthPath: '/api/status',
  defaultModel: 'gpt-4o-mini',
  run: 'docker run -d --name new-api -p 3000:3000 -v ./data:/data calciumion/new-api:latest',

  capabilities: {
    chat: true,
    streaming: true, // STREAMING_TIMEOUT is configurable
    models: true,
    routing: true, // channel weighted random
    fallback: true, // automatic retry on failure
    vision: true, // documented image interface
    tools: false, // only "implied through format conversion" for some models — not verified
    embeddings: true, // documented embeddings interface
  },

  notes:
    'Shares One API\'s token model: create a token in the dashboard and use it as the ' +
    'gateway API key. Default port 3000 clashes with One API — run only one of them.',
}
