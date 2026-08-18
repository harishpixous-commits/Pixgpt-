import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { isContentFree } from '../server/gateway/openai-compatible.mjs'

/* ============================================================
   Gateway registry, selection, config precedence, aliases.
   Uses node:test — built into Node 18, so no new dependency.
   ============================================================ */

const GATEWAY_ENV = [
  'AI_GATEWAY_PROVIDER', 'AI_GATEWAY_URL', 'AI_GATEWAY_BASE_URL', 'AI_GATEWAY_API_KEY',
  'AI_GATEWAY_DEFAULT_MODEL', 'AI_GATEWAY_TIMEOUT_MS', 'AI_GATEWAY_CONNECT_TIMEOUT_MS',
  'AI_GATEWAY_MAX_STREAM_MS', 'AI_GATEWAY_HEALTH_PATH', 'AI_GATEWAY_FALLBACK_MODELS',
  'AI_GATEWAY_DEFAULT_MAX_TOKENS',
  'PIXGPT_MODEL_FAST', 'PIXGPT_MODEL_PRO', 'PIXGPT_MODEL_VISION',
]
const PROVIDERS = ['OMNIROUTE', 'LITELLM', 'BIFROST', 'ONEAPI', 'NEWAPI', 'HIGRESS', 'PORTKEY']
const SUFFIXES = ['BASE_URL', 'API_KEY', 'DEFAULT_MODEL', 'TIMEOUT_MS', 'CONNECT_TIMEOUT_MS',
  'MAX_STREAM_MS', 'DEFAULT_MAX_TOKENS', 'HEALTH_PATH', 'FALLBACK_MODELS', 'VISION_FALLBACK_MODELS',
  'MODEL_FAST', 'MODEL_PRO', 'MODEL_VISION', 'VISION_ALIASES']

/** The .env file is loaded at import time, so clear everything it may have set. */
function clearGatewayEnv() {
  for (const k of GATEWAY_ENV) delete process.env[k]
  for (const p of PROVIDERS) for (const s of SUFFIXES) delete process.env[`${p}_${s}`]
}

const gw = await import('../server/gateway/index.mjs')

beforeEach(() => {
  clearGatewayEnv()
  gw.resetGateway()
})

describe('gateway selection', () => {
  test('defaults to omniroute when AI_GATEWAY_PROVIDER is unset', () => {
    assert.equal(gw.selectedGatewayId(), 'omniroute')
    assert.equal(gw.DEFAULT_GATEWAY, 'omniroute')
  })

  test('selects each supported gateway by id', () => {
    for (const id of gw.GATEWAY_IDS) {
      process.env.AI_GATEWAY_PROVIDER = id
      assert.equal(gw.selectedGatewayId(), id)
    }
  })

  test('is case- and whitespace-insensitive', () => {
    process.env.AI_GATEWAY_PROVIDER = '  LiteLLM  '
    assert.equal(gw.selectedGatewayId(), 'litellm')
  })

  test('falls back to omniroute for an unknown provider', () => {
    process.env.AI_GATEWAY_PROVIDER = 'definitely-not-a-gateway'
    assert.equal(gw.selectedGatewayId(), 'omniroute')
  })

  test('falls back to omniroute for an empty value', () => {
    process.env.AI_GATEWAY_PROVIDER = ''
    assert.equal(gw.selectedGatewayId(), 'omniroute')
  })

  test('exposes exactly the nine supported gateways', () => {
    assert.deepEqual(
      [...gw.GATEWAY_IDS].sort(),
      ['bifrost', 'freebuff', 'higress', 'litellm', 'newapi', 'omniroute', 'oneapi', 'openrouter', 'portkey'],
    )
  })
})

describe('config precedence', () => {
  test('adapter default applies when nothing is set', () => {
    const cfg = gw.resolveConfig('omniroute')
    // 127.0.0.1, not localhost — Node can resolve `localhost` to ::1 while
    // OmniRoute binds IPv4, which fails with ECONNREFUSED. Observed live.
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:20128/v1')
    assert.equal(cfg.apiKey, '')
  })

  test('vision fallbacks are a separate, empty-by-default chain', () => {
    const cfg = gw.resolveConfig('omniroute')
    assert.deepEqual(cfg.visionFallbackModels, [], 'no unsafe default vision fallback')
  })

  test('VISION_FALLBACK_MODELS is read independently of the text chain', () => {
    process.env.OMNIROUTE_FALLBACK_MODELS = 'auto'
    process.env.OMNIROUTE_VISION_FALLBACK_MODELS = 'ddgw/claude-haiku-4-5,aug/kimi-k2.7'
    const cfg = gw.resolveConfig('omniroute')
    assert.deepEqual(cfg.fallbackModels, ['auto'])
    assert.deepEqual(cfg.visionFallbackModels, ['ddgw/claude-haiku-4-5', 'aug/kimi-k2.7'])
  })

  test('AI_GATEWAY_URL is honoured (the documented generic name)', () => {
    process.env.AI_GATEWAY_URL = 'http://example.test:9000/v1'
    assert.equal(gw.resolveConfig('litellm').baseUrl, 'http://example.test:9000/v1')
  })

  test('AI_GATEWAY_BASE_URL is accepted as an alias', () => {
    process.env.AI_GATEWAY_BASE_URL = 'http://alias.test/v1'
    assert.equal(gw.resolveConfig('litellm').baseUrl, 'http://alias.test/v1')
  })

  test('provider-specific beats generic', () => {
    process.env.AI_GATEWAY_URL = 'http://generic.test/v1'
    process.env.LITELLM_BASE_URL = 'http://specific.test/v1'
    assert.equal(gw.resolveConfig('litellm').baseUrl, 'http://specific.test/v1')
  })

  test('BACKWARD COMPATIBILITY: legacy OMNIROUTE_* vars still drive omniroute', () => {
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:20128/v1'
    process.env.OMNIROUTE_API_KEY = 'legacy-key'
    process.env.OMNIROUTE_TIMEOUT_MS = '12345'
    process.env.OMNIROUTE_HEALTH_PATH = '/api/health/ping'
    process.env.OMNIROUTE_FALLBACK_MODELS = 'auto'
    const cfg = gw.resolveConfig('omniroute')
    assert.equal(cfg.baseUrl, 'http://localhost:20128/v1')
    assert.equal(cfg.apiKey, 'legacy-key')
    assert.equal(cfg.timeoutMs, 12345)
    assert.equal(cfg.healthPath, '/api/health/ping')
    assert.deepEqual(cfg.fallbackModels, ['auto'])
  })

  test('trailing slashes are trimmed from the base URL', () => {
    process.env.AI_GATEWAY_URL = 'http://x.test/v1///'
    assert.equal(gw.resolveConfig('bifrost').baseUrl, 'http://x.test/v1')
  })

  test('three independent timeouts with sane defaults', () => {
    const cfg = gw.resolveConfig('omniroute')
    assert.equal(cfg.connectTimeoutMs, 15_000)
    assert.equal(cfg.timeoutMs, 60_000)
    assert.equal(cfg.maxStreamMs, 300_000)
  })

  test('a generous default max_tokens is applied when none is sent', () => {
    assert.equal(gw.resolveConfig('omniroute').defaultMaxTokens, 8192)
  })

  test('DEFAULT_MAX_TOKENS is configurable and rejects junk', () => {
    process.env.AI_GATEWAY_DEFAULT_MAX_TOKENS = '12345'
    assert.equal(gw.resolveConfig('omniroute').defaultMaxTokens, 12345)
    process.env.OMNIROUTE_DEFAULT_MAX_TOKENS = '0'
    assert.equal(gw.resolveConfig('omniroute').defaultMaxTokens, 8192, 'invalid value falls back to the default')
  })

  test('timeouts are configurable and reject junk', () => {
    process.env.AI_GATEWAY_TIMEOUT_MS = '999'
    process.env.AI_GATEWAY_CONNECT_TIMEOUT_MS = 'not-a-number'
    const cfg = gw.resolveConfig('omniroute')
    assert.equal(cfg.timeoutMs, 999)
    assert.equal(cfg.connectTimeoutMs, 15_000, 'invalid value falls back to the default')
  })

  test('an explicit empty health path means "no health route"', () => {
    process.env.LITELLM_HEALTH_PATH = 'none'
    assert.equal(gw.resolveConfig('litellm').healthPath, null)
  })

  test('fallback list is empty by default (gateway-native routing only)', () => {
    assert.deepEqual(gw.resolveConfig('omniroute').fallbackModels, [])
  })
})

describe('model aliases', () => {
  test('all three aliases fall back to the gateway default model', () => {
    const cfg = gw.resolveConfig('litellm')
    assert.equal(cfg.modelAliases['pixgpt-pro'], 'gpt-4o-mini')
    assert.equal(cfg.modelAliases['pixgpt-fast'], 'gpt-4o-mini')
    assert.equal(cfg.modelAliases['pixgpt-vision'], 'gpt-4o-mini')
  })

  test('PIXGPT_MODEL_* overrides the default for every gateway', () => {
    process.env.PIXGPT_MODEL_PRO = 'auto'
    assert.equal(gw.resolveConfig('omniroute').modelAliases['pixgpt-pro'], 'auto')
    assert.equal(gw.resolveConfig('higress').modelAliases['pixgpt-pro'], 'auto')
  })

  test('<PROVIDER>_MODEL_* beats PIXGPT_MODEL_* — names are not portable', () => {
    process.env.PIXGPT_MODEL_PRO = 'auto'
    process.env.HIGRESS_MODEL_PRO = 'qwen-turbo'
    assert.equal(gw.resolveConfig('omniroute').modelAliases['pixgpt-pro'], 'auto')
    assert.equal(gw.resolveConfig('higress').modelAliases['pixgpt-pro'], 'qwen-turbo')
  })

  test('AI_GATEWAY_DEFAULT_MODEL feeds the aliases', () => {
    process.env.AI_GATEWAY_DEFAULT_MODEL = 'my-model'
    assert.equal(gw.resolveConfig('bifrost').modelAliases['pixgpt-pro'], 'my-model')
  })
})

describe('adapter descriptors', () => {
  test('every adapter declares the required fields', () => {
    for (const [id, adapter] of Object.entries(gw.ADAPTERS)) {
      assert.equal(adapter.id, id, `${id}: id must match its registry key`)
      assert.ok(adapter.label, `${id}: label`)
      assert.ok(adapter.license, `${id}: license`)
      assert.ok(adapter.defaultBaseUrl, `${id}: defaultBaseUrl`)
      assert.ok(adapter.defaultModel, `${id}: defaultModel`)
      assert.ok(adapter.capabilities, `${id}: capabilities`)
      for (const key of ['chat', 'streaming', 'models', 'routing', 'fallback', 'vision', 'tools', 'embeddings']) {
        assert.equal(typeof adapter.capabilities[key], 'boolean', `${id}: capabilities.${key} must be boolean`)
      }
    }
  })

  test('every adapter supports chat and streaming — PixGPT requires both', () => {
    for (const [id, adapter] of Object.entries(gw.ADAPTERS)) {
      assert.ok(adapter.capabilities.chat, `${id} must support chat`)
      assert.ok(adapter.capabilities.streaming, `${id} must support streaming`)
    }
  })

  test('gateways without a model catalogue are marked honestly', () => {
    assert.equal(gw.ADAPTERS.higress.capabilities.models, false)
    assert.equal(gw.ADAPTERS.portkey.capabilities.models, false)
    assert.equal(gw.ADAPTERS.omniroute.capabilities.models, true)
  })

  test('portkey validates its required configuration', () => {
    const problems = gw.ADAPTERS.portkey.validate(gw.resolveConfig('portkey'))
    assert.ok(problems.length > 0, 'missing PORTKEY_PROVIDER should be reported')
  })

  test('portkey is satisfied once provider and key are set', () => {
    process.env.PORTKEY_PROVIDER = 'openai'
    process.env.PORTKEY_API_KEY = 'sk-upstream'
    assert.deepEqual(gw.ADAPTERS.portkey.validate(gw.resolveConfig('portkey')), [])
  })

  test('portkey sends its provider headers, not plain Bearer only', () => {
    process.env.PORTKEY_PROVIDER = 'openai'
    process.env.PORTKEY_CONFIG = '{"strategy":{"mode":"fallback"}}'
    const cfg = gw.resolveConfig('portkey')
    cfg.apiKey = 'sk-upstream'
    const headers = gw.ADAPTERS.portkey.buildHeaders({}, cfg)
    assert.equal(headers['x-portkey-provider'], 'openai')
    assert.equal(headers['x-portkey-config'], '{"strategy":{"mode":"fallback"}}')
    assert.equal(headers.Authorization, 'Bearer sk-upstream')
  })

  test('PORTKEY_PLATFORM_KEY is separate from the provider bearer token', () => {
    process.env.PORTKEY_PROVIDER = 'openai'
    process.env.PORTKEY_PLATFORM_KEY = 'pk-platform'
    const cfg = gw.resolveConfig('portkey')
    cfg.apiKey = 'sk-upstream'
    const headers = gw.ADAPTERS.portkey.buildHeaders({}, cfg)
    assert.equal(headers['x-portkey-api-key'], 'pk-platform')
    assert.equal(headers.Authorization, 'Bearer sk-upstream')
  })
})

describe('describeGateway — safe to log and to serve', () => {
  test('never returns the API key value', () => {
    process.env.AI_GATEWAY_API_KEY = 'super-secret-value'
    const described = gw.describeGateway()
    const serialised = JSON.stringify(described)
    assert.ok(!serialised.includes('super-secret-value'), 'the key value must not appear')
    assert.equal(described.apiKey, 'set')
  })

  test('reports "not set" when there is no key', () => {
    assert.equal(gw.describeGateway().apiKey, 'not set')
  })
})

describe('content-free replies', () => {
  /*
   * A provider that answers a real question with "." returns HTTP 200. Passed
   * through as success the caller acts on an empty answer, so it is treated as a
   * retryable failure and the fallback chain moves on. Observed live: one route
   * behind `auto/best-reasoning` did exactly this on a document question.
   */
  test('punctuation-only replies count as no content', () => {
    for (const reply of ['.', '..', '...', '**.', '**', '   ', '', '- - -', '#', '\n\n', '…']) {
      assert.equal(isContentFree(reply), true, `${JSON.stringify(reply)} should count as empty`)
    }
  })

  test('short but real answers are kept', () => {
    for (const reply of ['42', 'Yes', 'No.', 'a', 'South, 22750', '**South** has the highest revenue.', '`x`']) {
      assert.equal(isContentFree(reply), false, `${JSON.stringify(reply)} is a real answer`)
    }
  })

  test('a non-string is treated as no content', () => {
    assert.equal(isContentFree(null), true)
    assert.equal(isContentFree(undefined), true)
    assert.equal(isContentFree(42), true)
  })
})
