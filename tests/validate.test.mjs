import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMITS,
  clampMaxTokens,
  clampTemperature,
  toWireMessages,
  validateModel,
  validateStream,
  validateTools,
} from '../server/validate.mjs'
import { check, reset } from '../server/rate-limit.mjs'
import { classifyStatus, gatewayError, GatewayError } from '../server/gateway/errors.mjs'

const rejectsBadRequest = (fn) =>
  assert.rejects(async () => fn(), (e) => e instanceof GatewayError && e.code === 'bad_request' && e.status === 400)

const throwsBadRequest = (fn) =>
  assert.throws(fn, (e) => e instanceof GatewayError && e.code === 'bad_request' && e.status === 400)

describe('model validation', () => {
  test('accepts the shapes real gateways use', () => {
    for (const m of ['auto', 'gpt-4o-mini', 'openai/gpt-4o', 'oc/claude-sonnet-4.5', 'qwen-turbo:latest', 'a']) {
      assert.equal(validateModel(m), m)
    }
  })

  test('treats missing/blank as "server picks the default"', () => {
    assert.equal(validateModel(undefined), undefined)
    assert.equal(validateModel(''), undefined)
    assert.equal(validateModel('   '), undefined)
  })

  test('rejects injection attempts and control characters', () => {
    throwsBadRequest(() => validateModel('gpt-4o\nAuthorization: Bearer leak'))
    throwsBadRequest(() => validateModel('model with spaces'))
    throwsBadRequest(() => validateModel('../../etc/passwd'))
    throwsBadRequest(() => validateModel('model"quote'))
    throwsBadRequest(() => validateModel('-leading-dash'))
  })

  test('rejects non-strings and oversized values', () => {
    throwsBadRequest(() => validateModel(42))
    throwsBadRequest(() => validateModel({}))
    throwsBadRequest(() => validateModel('a'.repeat(LIMITS.modelChars + 1)))
  })
})

describe('message validation', () => {
  test('reduces stored messages to the OpenAI wire shape', async () => {
    const { messages: out } = await toWireMessages([
      { id: 'x', role: 'user', content: 'hello', createdAt: 1, status: 'complete', attachments: [] },
      { id: 'y', role: 'assistant', content: 'hi', feedback: 'like' },
    ])
    assert.deepEqual(out, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  test('preserves system prompts', async () => {
    const { messages: out } = await toWireMessages([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
    assert.equal(out[0].role, 'system')
    assert.equal(out.length, 2)
  })

  test('drops the empty assistant placeholder the UI creates', async () => {
    const { messages: out } = await toWireMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ])
    assert.deepEqual(out, [{ role: 'user', content: 'hi' }])
  })

  test('normalises unknown roles to user rather than forwarding them', async () => {
    assert.equal((await toWireMessages([{ role: 'hacker', content: 'x' }])).messages[0].role, 'user')
  })

  test('keeps only the most recent messages', async () => {
    const many = Array.from({ length: LIMITS.messages + 50 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    const { messages: out } = await toWireMessages(many)
    assert.equal(out.length, LIMITS.messages)
    assert.equal(out.at(-1).content, `m${many.length - 1}`)
  })

  test('rejects missing, non-array and empty messages', async () => {
    await rejectsBadRequest(() => toWireMessages(undefined))
    await rejectsBadRequest(() => toWireMessages('nope'))
    await rejectsBadRequest(() => toWireMessages({}))
    await rejectsBadRequest(() => toWireMessages([]))
  })

  test('rejects malformed entries', async () => {
    await rejectsBadRequest(() => toWireMessages([null]))
    await rejectsBadRequest(() => toWireMessages(['just a string']))
    await rejectsBadRequest(() => toWireMessages([[]]))
  })

  test('rejects a conversation with no usable content', async () => {
    await rejectsBadRequest(() => toWireMessages([{ role: 'user', content: '   ' }]))
  })

  test('rejects an excessively large prompt', async () => {
    const huge = [{ role: 'user', content: 'x'.repeat(LIMITS.totalPromptChars + 1) }]
    await rejectsBadRequest(() => toWireMessages(huge))
  })
})

describe('parameter validation', () => {
  test('temperature is clamped to 0..2', () => {
    assert.equal(clampTemperature(0.7), 0.7)
    assert.equal(clampTemperature(-5), 0)
    assert.equal(clampTemperature(99), 2)
    assert.equal(clampTemperature(undefined), undefined)
  })

  test('temperature rejects non-numbers', () => {
    throwsBadRequest(() => clampTemperature('hot'))
    throwsBadRequest(() => clampTemperature(Number.NaN))
  })

  test('max_tokens is clamped and truncated', () => {
    assert.equal(clampMaxTokens(64), 64)
    assert.equal(clampMaxTokens(0), 1)
    assert.equal(clampMaxTokens(10.9), 10)
    assert.equal(clampMaxTokens(9_999_999), 200_000)
    assert.equal(clampMaxTokens(undefined), undefined)
  })

  test('max_tokens rejects non-numbers and Infinity', () => {
    throwsBadRequest(() => clampMaxTokens('many'))
    throwsBadRequest(() => clampMaxTokens(Number.POSITIVE_INFINITY))
  })

  test('stream defaults to true and must be boolean', () => {
    assert.equal(validateStream(undefined), true)
    assert.equal(validateStream(false), false)
    throwsBadRequest(() => validateStream('yes'))
  })

  test('tools are shape-checked, not passed through blindly', () => {
    const ok = [{ type: 'function', function: { name: 'get_weather' } }]
    assert.deepEqual(validateTools(ok), ok)
    assert.equal(validateTools(undefined), undefined)
    assert.equal(validateTools([]), undefined)
    throwsBadRequest(() => validateTools('nope'))
    throwsBadRequest(() => validateTools([{ type: 'evil' }]))
    throwsBadRequest(() => validateTools([{ type: 'function' }]))
    throwsBadRequest(() => validateTools([{ type: 'function', function: {} }]))
    throwsBadRequest(() => validateTools(Array.from({ length: LIMITS.tools + 1 }, () => ok[0])))
  })
})

describe('error classification', () => {
  test('maps auth failures without leaking the upstream body', () => {
    const e = classifyStatus(401, 'provider key sk-abc123 rejected')
    assert.equal(e.code, 'invalid_api_key')
    assert.equal(e.retryable, false, 'a bad key must never trigger model fallback')
    assert.ok(!e.message.includes('sk-abc123'), 'upstream body must not reach the user message')
  })

  test('distinguishes quota from rate limit', () => {
    assert.equal(classifyStatus(429, 'slow down').code, 'rate_limited')
    assert.equal(classifyStatus(402, 'payment required').code, 'quota_exceeded')
    assert.equal(classifyStatus(400, 'insufficient_quota for this key').code, 'quota_exceeded')
    assert.equal(classifyStatus(429, 'quota exhausted').code, 'quota_exceeded')
  })

  test('maps missing models and upstream outages', () => {
    assert.equal(classifyStatus(404, 'model not found').code, 'model_unavailable')
    assert.equal(classifyStatus(400, 'unknown model xyz').code, 'model_unavailable')
    assert.equal(classifyStatus(503, 'upstream down').code, 'provider_unavailable')
    assert.equal(classifyStatus(500, 'boom').code, 'provider_error')
  })

  test('only transient failures are retryable', () => {
    assert.equal(classifyStatus(429, '').retryable, true)
    assert.equal(classifyStatus(503, '').retryable, true)
    assert.equal(classifyStatus(401, '').retryable, false)
    assert.equal(classifyStatus(402, '').retryable, false)
    assert.equal(gatewayError('bad_request').retryable, false)
  })

  test('serialises to the frontend contract', () => {
    assert.deepEqual(gatewayError('timeout').toJSON(), {
      error: { code: 'timeout', message: 'The AI gateway took too long to respond.' },
    })
  })
})

describe('rate limiting', () => {
  test('allows requests up to the limit then blocks', () => {
    reset()
    const now = Date.now()
    let last
    for (let i = 0; i < 60; i++) last = check('1.2.3.4', now)
    assert.equal(last.allowed, true, 'the 60th request is still inside a 60/min budget')

    const over = check('1.2.3.4', now)
    assert.equal(over.allowed, false)
    assert.ok(over.retryAfterSec >= 1)
  })

  test('buckets are per client', () => {
    reset()
    const now = Date.now()
    for (let i = 0; i < 61; i++) check('a', now)
    assert.equal(check('a', now).allowed, false)
    assert.equal(check('b', now).allowed, true, 'another client is unaffected')
  })

  test('the window resets', () => {
    reset()
    const now = Date.now()
    for (let i = 0; i < 61; i++) check('c', now)
    assert.equal(check('c', now).allowed, false)
    assert.equal(check('c', now + 61_000).allowed, true)
  })
})
