/**
 * OmniRoute — https://github.com/diegosouzapw/OmniRoute  (MIT)
 *
 * PixGPT's default gateway. Plain OpenAI-compatible surface with Bearer auth,
 * so it needs no overrides beyond its defaults.
 *
 * Capabilities verified against the repository README (v3.8.50).
 */
export default {
  id: 'omniroute',
  label: 'OmniRoute',
  repo: 'https://github.com/diegosouzapw/OmniRoute',
  license: 'MIT',
  // 127.0.0.1, not localhost: OmniRoute binds IPv4, and Node's resolver can
  // hand `localhost` back as ::1, which then fails with ECONNREFUSED even
  // though the gateway is running. Observed on Windows + Node 18.
  defaultBaseUrl: 'http://127.0.0.1:20128/v1',
  defaultHealthPath: '/api/health/ping',
  defaultModel: 'auto',
  run: 'npm install -g omniroute && omniroute   (requires Node >= 22)',

  capabilities: {
    chat: true,
    streaming: true,
    models: true, // GET /v1/models documented
    routing: true, // 19 routing strategies
    fallback: true, // `auto` cascades across 4 provider tiers
    vision: true, // "Modality Bridge — vision" in v3.8.50
    // LIVE VERIFIED 2026-08-14: sent an OpenAI `tools` array to auto/best-coding
    // and got back finish_reason:"tool_calls" with correctly parsed arguments.
    // 100 of the 115 catalogued models declare tool_calling.
    tools: true,
    embeddings: false, // not documented in the README
  },

  notes:
    'Model `auto` performs zero-config routing with automatic provider fallback. ' +
    'Works with no API key when the instance runs with REQUIRE_API_KEY=false.',
}
