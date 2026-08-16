/**
 * One API — https://github.com/songquanpeng/one-api  (MIT)
 *
 * OpenAI-format access to many providers via "channels". Client tokens are
 * created in its web UI; a channel can be pinned with `Bearer <token>-<channelId>`.
 */
export default {
  id: 'oneapi',
  label: 'One API',
  repo: 'https://github.com/songquanpeng/one-api',
  license: 'MIT',
  defaultBaseUrl: 'http://localhost:3000/v1',
  defaultHealthPath: '/api/status',
  defaultModel: 'gpt-4o-mini',
  run: 'docker run -d --name one-api -p 3000:3000 -v ./data:/data justsong/one-api',

  capabilities: {
    chat: true,
    streaming: true, // documented stream mode
    models: true,
    routing: true, // load balancing across channels
    fallback: true, // automatic retry on channel failure
    vision: false, // not documented in the README
    tools: false, // not documented in the README
    embeddings: false, // not documented in the README
  },

  notes:
    'Create a token in the One API dashboard and use it as the gateway API key. ' +
    'Append `-<channelId>` to the token to pin a specific channel. Available model ' +
    'names depend entirely on the channels you configure.',
}
