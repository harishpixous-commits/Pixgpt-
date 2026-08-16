/**
 * Higress — https://github.com/alibaba/higress  (Apache-2.0)
 *
 * An Envoy-based API gateway. Its AI capability comes from the `ai-proxy` wasm
 * plugin, which must be enabled and pointed at providers before it will serve
 * OpenAI-format traffic — unlike the other gateways it is not usable for chat
 * straight out of the box.
 */
export default {
  id: 'higress',
  label: 'Higress',
  repo: 'https://github.com/alibaba/higress',
  license: 'Apache-2.0',
  defaultBaseUrl: 'http://localhost:8080/v1',
  defaultHealthPath: null, // no OpenAI-format health route; liveness probed on the origin
  defaultModel: 'qwen-turbo',
  run:
    'docker run -d --name higress -v ${PWD}:/data -p 8001:8001 -p 8080:8080 -p 8443:8443 ' +
    'higress-registry.cn-hangzhou.cr.aliyuncs.com/higress/all-in-one:latest',

  capabilities: {
    chat: true, // through the ai-proxy plugin
    streaming: true, // full SSE streaming support
    models: false, // ai-proxy does not expose an OpenAI /v1/models catalogue
    routing: true, // multi-model load balancing
    fallback: true, // provider failover via plugin configuration
    vision: false, // not verified
    tools: false, // not verified
    embeddings: false, // not verified
  },

  notes:
    'Requires configuration before it can proxy AI traffic: enable the ai-proxy plugin in ' +
    'the console on :8001 and add provider credentials there. Because there is no model ' +
    'catalogue, PixGPT cannot list models for Higress — set AI_GATEWAY_DEFAULT_MODEL and ' +
    'the PIXGPT_MODEL_* aliases to models you have configured.',
}
