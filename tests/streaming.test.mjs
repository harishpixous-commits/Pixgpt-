import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createClient } from '../server/gateway/openai-compatible.mjs'
import omniroute from '../server/gateway/adapters/omniroute.mjs'

/* ============================================================
   Streaming robustness — driven against a real local HTTP server
   so the SSE parser, timeouts and fallback rules are exercised
   end to end rather than mocked at the function level.
   ============================================================ */

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** Scenario is chosen by the requested model, like the QA mock. */
let server
let port

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'auto' }] }))
      return
    }

    let body = ''
    for await (const chunk of req) body += chunk
    const { model } = JSON.parse(body || '{}')
    const sse = () => res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const token = (t) => frame({ model, choices: [{ delta: { content: t } }] })

    switch (model) {
      case 'normal':
        sse(); token('Hello'); token(' world'); res.write('data: [DONE]\n\n'); res.end(); return

      case 'empty': // valid stream that yields no content
        sse(); res.write('data: [DONE]\n\n'); res.end(); return

      case 'malformed': // junk frames interleaved with good ones
        sse()
        res.write('data: {not json at all\n\n')
        token('kept')
        res.write('data: \n\n')
        res.write(': a comment line\n\n')
        token(' text')
        res.write('data: [DONE]\n\n'); res.end(); return

      case 'no-done': // stream just ends without [DONE]
        sse(); token('partial'); res.end(); return

      case 'disconnect': // provider drops the socket mid-stream
        sse(); token('before drop'); setTimeout(() => res.destroy(), 30); return

      case 'error-midstream':
        sse(); token('partial ')
        setTimeout(() => { frame({ error: { message: 'provider exploded' } }); res.end() }, 20)
        return

      case 'quota-midstream':
        sse(); setTimeout(() => { frame({ error: { message: 'quota exhausted' } }); res.end() }, 10)
        return

      case 'slow-headers': // accepts the socket, never responds
        return

      case 'idle-stall': // sends one token then goes silent forever
        sse(); token('then silence'); return

      case 'fail-500':
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream failed' } })); return

      case 'fail-401':
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key' } })); return

      case 'nonstream-ok':
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model, choices: [{ message: { content: 'complete answer' } }] })); return

      case 'nonstream-cutoff': // finished, but at the output ceiling
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model, choices: [{ message: { content: 'cut off here' }, finish_reason: 'length' }] })); return

      case 'cutoff': // ends mid-sentence with finish_reason "length"
        sse(); token('The answer starts and then ')
        res.write(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`)
        res.write('data: [DONE]\n\n'); res.end(); return

      case 'max-tokens-echo': // echoes back the max_tokens the client sent
        sse(); token(String(JSON.parse(body || '{}').max_tokens ?? 'none'))
        res.write('data: [DONE]\n\n'); res.end(); return

      case 'nonstream-malformed':
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"choices":[{"oops":'); return

      case 'reject-image': // a route that refuses the image with a bare 400
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'image_url is not supported' } })); return

      default:
        sse(); token(`[${model}] ok`); res.write('data: [DONE]\n\n'); res.end(); return
    }
  })
  await new Promise((r) => server.listen(0, r))
  port = server.address().port
})

after(() => server?.close())

function client(overrides = {}) {
  const cfg = {
    provider: 'omniroute',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: '',
    connectTimeoutMs: 2000,
    timeoutMs: 2000,
    maxStreamMs: 10_000,
    healthPath: null,
    defaultModel: 'auto',
    defaultAlias: 'pixgpt-pro',
    modelAliases: { 'pixgpt-fast': 'auto', 'pixgpt-pro': 'auto', 'pixgpt-vision': 'auto' },
    fallbackModels: [],
    ...overrides,
  }
  return createClient(omniroute, cfg, silent)
}

/** Collects tokens and returns the outcome without throwing. */
async function run(c, model, signal) {
  const tokens = []
  try {
    const result = await c.streamCompletion({ model, messages: [{ role: 'user', content: 'x' }] }, signal, (t) =>
      tokens.push(t),
    )
    return { ok: true, text: tokens.join(''), result }
  } catch (error) {
    return { ok: false, text: tokens.join(''), code: error.code, message: error.message }
  }
}

describe('streaming — happy paths', () => {
  test('delivers tokens progressively and reports completion', async () => {
    const out = await run(client(), 'normal')
    assert.equal(out.ok, true)
    assert.equal(out.text, 'Hello world')
    assert.equal(out.result.fellBack, false)
  })

  test('an empty but valid stream completes cleanly', async () => {
    const out = await run(client(), 'empty')
    assert.equal(out.ok, true)
    assert.equal(out.text, '')
    assert.equal(out.result.streamed, 0)
  })

  test('a stream that ends without [DONE] still completes', async () => {
    const out = await run(client(), 'no-done')
    assert.equal(out.ok, true, 'must not hang or error — the browser has to reach a final state')
    assert.equal(out.text, 'partial')
  })

  test('malformed SSE frames are skipped, valid ones survive', async () => {
    const out = await run(client(), 'malformed')
    assert.equal(out.ok, true)
    assert.equal(out.text, 'kept text')
  })

  test('non-streaming completion works', async () => {
    const c = client()
    const res = await c.completion({ model: 'nonstream-ok', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(res.content, 'complete answer')
  })

  test('a non-streaming reply that stops at the ceiling is flagged truncated', async () => {
    const c = client()
    const res = await c.completion({ model: 'nonstream-cutoff', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(res.content, 'cut off here')
    assert.equal(res.truncated, true, 'finish_reason "length" must surface as truncated')
    assert.equal(res.finishReason, 'length')
  })

  test('a malformed non-streaming body is reported, not thrown raw', async () => {
    const c = client()
    await assert.rejects(
      () => c.completion({ model: 'nonstream-malformed', messages: [{ role: 'user', content: 'x' }] }),
      (e) => e.code === 'malformed_response',
    )
  })
})

describe('streaming — output ceilings', () => {
  test('a stream that ends with finish_reason "length" is flagged truncated', async () => {
    const out = await run(client(), 'cutoff')
    assert.equal(out.ok, true, 'the stream itself succeeded — the answer was just cut off')
    assert.equal(out.text, 'The answer starts and then ')
    assert.equal(out.result.truncated, true)
    assert.equal(out.result.finishReason, 'length')
  })

  test('a stream that ends cleanly is not truncated', async () => {
    const out = await run(client(), 'normal')
    assert.equal(out.ok, true)
    assert.equal(out.result.truncated, false)
    assert.equal(out.result.finishReason, null)
  })

  test('the configured default max_tokens is sent when the caller names none', async () => {
    const out = await run(client({ defaultMaxTokens: 12_345 }), 'max-tokens-echo')
    assert.equal(out.ok, true)
    assert.equal(out.text, '12345', 'the provider must receive the default ceiling')
  })

  test('an explicit maxTokens always wins over the default', async () => {
    const c = client({ defaultMaxTokens: 12_345 })
    const tokens = []
    const res = await c.streamCompletion(
      { model: 'max-tokens-echo', maxTokens: 999, messages: [{ role: 'user', content: 'x' }] },
      undefined,
      (t) => tokens.push(t),
    )
    assert.equal(tokens.join(''), '999')
    assert.equal(res.truncated, false)
  })

  test('no default configured means no max_tokens is sent', async () => {
    const out = await run(client({ defaultMaxTokens: undefined }), 'max-tokens-echo')
    assert.equal(out.ok, true)
    assert.equal(out.text, 'none')
  })
})

describe('streaming — failure paths', () => {
  test('provider disconnect mid-stream keeps partial text and ends in error', async () => {
    const out = await run(client(), 'disconnect')
    assert.equal(out.ok, false)
    assert.equal(out.text, 'before drop', 'text already delivered must be preserved')
    assert.ok(out.code, 'must surface a code so the UI leaves the generating state')
  })

  test('a mid-stream error event surfaces after the partial text', async () => {
    const out = await run(client(), 'error-midstream')
    assert.equal(out.ok, false)
    assert.equal(out.text, 'partial ')
    assert.equal(out.code, 'provider_error')
  })

  test('mid-stream quota wording is classified as quota_exceeded', async () => {
    const out = await run(client(), 'quota-midstream')
    assert.equal(out.ok, false)
    assert.equal(out.code, 'quota_exceeded')
  })

  test('never leaks the upstream message for auth failures', async () => {
    const out = await run(client(), 'fail-401')
    assert.equal(out.code, 'invalid_api_key')
    assert.ok(!out.message.includes('bad key'))
  })
})

describe('streaming — timeouts', () => {
  test('connect timeout fires when headers never arrive', async () => {
    const out = await run(client({ connectTimeoutMs: 300 }), 'slow-headers')
    assert.equal(out.ok, false)
    assert.equal(out.code, 'timeout')
  })

  test('idle timeout fires when a live stream goes silent', async () => {
    const out = await run(client({ timeoutMs: 300 }), 'idle-stall')
    assert.equal(out.ok, false)
    assert.equal(out.text, 'then silence', 'partial text is kept')
    assert.equal(out.code, 'timeout')
  })

  test('a dead connection cannot hang forever', async () => {
    const started = Date.now()
    await run(client({ connectTimeoutMs: 250, timeoutMs: 250 }), 'slow-headers')
    assert.ok(Date.now() - started < 3000, 'must fail fast, not hang')
  })
})

describe('streaming — client cancellation', () => {
  test('an aborted request reports client_closed, not a provider fault', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const out = await run(client(), 'idle-stall', controller.signal)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'client_closed')
  })
})

describe('fallback rules', () => {
  test('falls back when the failure happens before any bytes', async () => {
    const out = await run(client({ fallbackModels: ['normal'] }), 'fail-500')
    assert.equal(out.ok, true, 'a pre-stream failure is safe to retry')
    assert.equal(out.text, 'Hello world')
    assert.equal(out.result.fellBack, true)
  })

  test('does NOT fall back once bytes have reached the client', async () => {
    const out = await run(client({ fallbackModels: ['normal'] }), 'error-midstream')
    assert.equal(out.ok, false, 'switching models mid-answer would concatenate two replies')
    assert.equal(out.text, 'partial ', 'only the original partial text is kept')
    assert.ok(!out.text.includes('Hello world'), 'the fallback answer must not be appended')
  })

  /*
   * A 401 used to end the chain. That was right when a gateway meant one
   * upstream with one key — retrying another model behind the same bad key is
   * pointless. It is wrong for a gateway that fronts several pools with
   * separate credentials: OmniRoute's `tllm/*` pool 401s while `auto/*` serves
   * happily on the same gateway key, and aborting there surfaced "the gateway
   * rejected this server's credentials" to users with working routes unused
   * further down the chain. Observed breaking document Q&A.
   */
  test('a 401 from one route does not end a chain that has others left', async () => {
    const out = await run(client({ fallbackModels: ['normal'] }), 'fail-401')
    assert.equal(out.ok, true, 'another pool may well have valid credentials')
    assert.equal(out.text, 'Hello world')
    assert.equal(out.result.fellBack, true)
  })

  test('but an exhausted chain still reports the credential failure', async () => {
    const out = await run(client({ fallbackModels: ['fail-401'] }), 'fail-401')
    assert.equal(out.ok, false)
    assert.equal(out.code, 'invalid_api_key', 'the last error is what the user is told')
  })

  test('a genuinely non-retryable failure still ends the chain', async () => {
    const out = await run(client({ fallbackModels: ['normal'] }), 'error-midstream')
    assert.equal(out.ok, false, 'bytes already sent — a second answer must never be appended')
  })

  test('reports failure when the whole chain is exhausted', async () => {
    const out = await run(client({ fallbackModels: ['fail-500'] }), 'fail-500')
    assert.equal(out.ok, false)
    assert.equal(out.code, 'provider_error')
  })

  test('model chain resolves aliases then appends fallbacks', () => {
    const c = client({ fallbackModels: ['auto'] })
    assert.deepEqual(c.modelChain('pixgpt-pro'), ['auto'], 'duplicates are collapsed')
    assert.deepEqual(c.modelChain('gpt-4o'), ['gpt-4o', 'auto'])
  })
})

describe('capability-aware fallback (vision must not downgrade)', () => {
  test('a vision request uses the vision chain, not the text chain', () => {
    const c = client({ fallbackModels: ['text-only-model'], visionFallbackModels: ['vision-model-b'] })
    assert.deepEqual(c.modelChain('vision-model-a', { requiresVision: true }), ['vision-model-a', 'vision-model-b'])
    assert.deepEqual(c.modelChain('text-model', {}), ['text-model', 'text-only-model'])
  })

  test('with no vision chain configured, a vision request does not fall back at all', () => {
    const c = client({ fallbackModels: ['text-only-model'], visionFallbackModels: [] })
    assert.deepEqual(
      c.modelChain('vision-model-a', { requiresVision: true }),
      ['vision-model-a'],
      'better to fail than to send an image to a text-only model',
    )
  })

  test('an image request never inherits the text fallback', async () => {
    // fail-500 is retryable; the text chain would rescue it, the vision chain must not
    const c = client({ fallbackModels: ['normal'], visionFallbackModels: [] })
    const tokens = []
    await assert.rejects(
      () =>
        c.streamCompletion(
          { model: 'fail-500', requiresVision: true, messages: [{ role: 'user', content: 'x' }] },
          undefined,
          (t) => tokens.push(t),
        ),
      (e) => e.code === 'provider_error',
    )
    assert.equal(tokens.join(''), '', 'the text-only fallback answer must never appear')
  })

  test('a vision request whose route refuses the image surfaces a legible message', async () => {
    const c = client({ fallbackModels: ['normal'], visionFallbackModels: [] })
    await assert.rejects(
      () =>
        c.completion(
          { model: 'reject-image', requiresVision: true, messages: [{ role: 'user', content: 'x' }] },
          undefined,
        ),
      (e) => e.code === 'bad_request' && /No vision-capable model/.test(e.message),
    )
  })
})
