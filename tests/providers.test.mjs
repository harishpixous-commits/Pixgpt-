import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as gw from '../server/gateway/index.mjs'
import openrouter from '../server/gateway/adapters/openrouter.mjs'
import freebuff from '../server/gateway/adapters/freebuff.mjs'
import {
  applyProviderMetadata,
  FREEBUFF_MODEL_CARDS,
  DATA_USE,
  EFFORTS,
} from '../server/models/provider-metadata.mjs'
import { normaliseModel, EVIDENCE } from '../server/models/catalog.mjs'
import { scoreModel, TASK, WEIGHTS } from '../server/models/ranking.mjs'

/* ============================================================
   Provider integration
   --------------------
   Freebuff turned out to be a proxy in front of OpenRouter, so
   what got integrated is OpenRouter itself, plus a Freebuff adapter
   for accounts that only hold Freebuff credentials.

   These assert the parts that are testable without a key: adapter
   shape, the metadata join, and — the important one — that a
   provider's claim about a model is treated as evidence rather
   than as proof.
   ============================================================ */

const KEYS = ['OPENROUTER_API_KEY', 'FREEBUFF_API_KEY', 'OPENROUTER_BASE_URL', 'FREEBUFF_BASE_URL', 'AI_GATEWAY_PROVIDER']
const saved = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  gw.resetGateway()
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  gw.resetGateway()
})

/** A registry record shaped enough to score, without a live registry. */
function record(overrides = {}) {
  return {
    id: 'x/y',
    displayName: 'X',
    provider: 'x',
    family: 'other',
    categories: ['GENERAL_CHAT'],
    capabilities: { chat: { value: true, source: EVIDENCE.GATEWAY } },
    health: {
      state: 'healthy',
      fatal: false,
      successRate: null,
      latencyMs: null,
      consecutiveFailures: 0,
      successCount: 1,
      cooldownMs: 0,
    },
    verification: 'CATALOGUED',
    free: false,
    cost: 'standard',
    context: null,
    routing: false,
    configured: false,
    inCatalogue: true,
    ...overrides,
  }
}

describe('adapter registration', () => {
  test('openrouter and freebuff are registered', () => {
    assert.ok(gw.GATEWAY_IDS.includes('openrouter'))
    assert.ok(gw.GATEWAY_IDS.includes('freebuff'))
  })

  test('both point at their real endpoints', () => {
    assert.equal(gw.resolveConfig('openrouter').baseUrl, 'https://openrouter.ai/api/v1')
    assert.equal(gw.resolveConfig('freebuff').baseUrl, 'https://freebuff.com/api/v1')
  })

  test('both declare chat, streaming, tools and vision', () => {
    for (const a of [openrouter, freebuff]) {
      assert.equal(a.capabilities.chat, true, `${a.id} chat`)
      assert.equal(a.capabilities.streaming, true, `${a.id} streaming`)
      assert.equal(a.capabilities.tools, true, `${a.id} tools`)
      assert.equal(a.capabilities.vision, true, `${a.id} vision`)
    }
  })

  test('freebuff declares no catalogue route, because it publishes none', () => {
    assert.equal(freebuff.capabilities.models, false)
  })
})

describe('authentication', () => {
  test('openrouter sends a bearer token plus attribution headers', () => {
    const h = openrouter.buildHeaders({}, { apiKey: 'test-key' })
    assert.equal(h.Authorization, 'Bearer test-key')
    assert.ok(h['HTTP-Referer'])
    assert.ok(h['X-Title'])
  })

  /* Freebuff's own client sends both forms; its API gate reads the second. */
  test('freebuff sends both header forms', () => {
    const h = freebuff.buildHeaders({}, { apiKey: 'fb-key' })
    assert.equal(h.Authorization, 'Bearer fb-key')
    assert.equal(h['x-codebuff-api-key'], 'fb-key')
  })

  test('the BYOK header appears only when the operator sets it', () => {
    delete process.env.FREEBUFF_BYOK_OPENROUTER
    assert.equal(freebuff.buildHeaders({}, { apiKey: 'k' })['x-openrouter-api-key'], undefined)

    process.env.FREEBUFF_BYOK_OPENROUTER = 'or-key'
    try {
      assert.equal(freebuff.buildHeaders({}, { apiKey: 'k' })['x-openrouter-api-key'], 'or-key')
    } finally {
      delete process.env.FREEBUFF_BYOK_OPENROUTER
    }
  })

  test('no authorization header is sent when nothing is configured', () => {
    for (const a of [openrouter, freebuff]) {
      assert.equal(a.buildHeaders({}, { apiKey: '' }).Authorization, undefined, `${a.id} sent an empty bearer`)
    }
  })

  test('a keyed gateway with no key reports the problem', () => {
    assert.ok(openrouter.validate({ apiKey: '' }).length > 0)
    assert.equal(openrouter.validate({ apiKey: 'x' }).length, 0)
    assert.ok(freebuff.validate({ apiKey: '' }).length > 0)
  })
})

describe('opting a gateway in', () => {
  test('a default base URL alone does not enrol a gateway', () => {
    assert.equal(gw.gatewayConfigured('openrouter'), false)
    assert.equal(gw.gatewayConfigured('litellm'), false)
  })

  test('setting a key opts it in', () => {
    process.env.OPENROUTER_API_KEY = 'k'
    gw.resetGateway()
    assert.equal(gw.gatewayConfigured('openrouter'), true)
  })

  test('the selected gateway always participates', () => {
    assert.ok(gw.configuredGateways().includes('omniroute'))
  })

  test('the provider listing never contains a key value', () => {
    process.env.OPENROUTER_API_KEY = 'super-secret-value'
    gw.resetGateway()
    const dump = JSON.stringify(gw.describeGateways())
    assert.ok(!dump.includes('super-secret-value'), 'a key leaked into the provider listing')
    assert.ok(dump.includes('"apiKey":"set"'))
  })
})

describe('freebuff 429 semantics', () => {
  /* Its free pool answers 429 with a queue marker. That is not a broken route. */
  test('a capacity deferral is a retryable rate limit', () => {
    const e = freebuff.classifyStatus(429, '{"error":"free_mode_capacity_deferred"}')
    assert.equal(e.code, 'rate_limited')
    assert.equal(e.retryable, true)
  })

  test('everything else falls through to the shared classifier', () => {
    assert.equal(freebuff.classifyStatus(500, 'boom'), null)
    assert.equal(freebuff.classifyStatus(401, 'nope'), null)
  })
})

describe('provider metadata', () => {
  const meta = new Map([
    [
      'anthropic/claude-opus-4.1',
      {
        displayName: 'Claude Opus 4.1',
        context: 200_000,
        tools: true,
        vision: true,
        reasoning: true,
        structured: true,
        free: false,
        pricePerMillionInput: 15,
        pricePerMillionOutput: 75,
        source: 'openrouter',
      },
    ],
    [
      'some/text-only',
      {
        displayName: 'Text Only',
        context: 8192,
        tools: false,
        vision: false,
        reasoning: false,
        structured: false,
        free: true,
        pricePerMillionInput: 0,
        pricePerMillionOutput: 0,
        source: 'openrouter',
      },
    ],
  ])

  test('an authoritative context window replaces the id guess', () => {
    const m = normaliseModel('anthropic/claude-opus-4.1')
    applyProviderMetadata([m], meta)
    assert.equal(m.context, 200_000)
    assert.equal(m.contextSource, EVIDENCE.GATEWAY)
  })

  test('capability statements are recorded at gateway strength', () => {
    const m = normaliseModel('anthropic/claude-opus-4.1')
    applyProviderMetadata([m], meta)
    assert.equal(m.capabilities.vision.value, true)
    assert.equal(m.capabilities.vision.source, EVIDENCE.GATEWAY)
    assert.equal(m.capabilities.tools.value, true)
  })

  /* The rule the registry rests on: a probe outranks a provider's claim. */
  test('a probe result is never overwritten by provider metadata', () => {
    const m = normaliseModel('anthropic/claude-opus-4.1')
    m.capabilities.vision = { value: false, source: EVIDENCE.PROBE }
    applyProviderMetadata([m], meta)
    assert.equal(m.capabilities.vision.value, false, 'a probe was overwritten')
    assert.equal(m.capabilities.vision.source, EVIDENCE.PROBE)
  })

  test('a provider saying "vision" does not make a route vision-verified', () => {
    const m = normaliseModel('anthropic/claude-opus-4.1')
    applyProviderMetadata([m], meta)
    const result = scoreModel(record({ capabilities: m.capabilities, categories: m.categories }), TASK.BEST_VISION)
    assert.equal(result.eligible, false, 'strict vision must still require a probe')
    assert.match(result.blockedBy, /not verified/)
  })

  test('zero pricing marks a model free', () => {
    const m = normaliseModel('some/text-only')
    applyProviderMetadata([m], meta)
    assert.equal(m.free, true)
  })

  test('a model with no provider entry is left untouched', () => {
    const m = normaliseModel('unknown/model')
    const before = JSON.stringify(m)
    applyProviderMetadata([m], meta)
    assert.equal(JSON.stringify(m), before)
  })
})

describe('freebuff model cards', () => {
  test('data-use values are normalised, never invented', () => {
    for (const [id, card] of Object.entries(FREEBUFF_MODEL_CARDS)) {
      assert.ok(Object.values(DATA_USE).includes(card.dataUse), `${id} has an unknown dataUse: ${card.dataUse}`)
    }
  })

  test('a model with no stated policy reports unknown rather than safe', () => {
    const m = normaliseModel('anthropic/claude-opus-4.1')
    applyProviderMetadata(
      [m],
      new Map([
        [
          'anthropic/claude-opus-4.1',
          { context: 1, tools: true, vision: true, structured: false, free: false, pricePerMillionInput: 1, pricePerMillionOutput: 1 },
        ],
      ]),
    )
    assert.equal(m.dataUse, DATA_USE.UNKNOWN)
  })

  test('reasoning efforts come only from the published ladder', () => {
    for (const [id, card] of Object.entries(FREEBUFF_MODEL_CARDS)) {
      for (const e of card.efforts ?? []) assert.ok(EFFORTS.includes(e), `${id} lists an unknown effort: ${e}`)
    }
  })

  test('a superseding pointer names a real, different replacement', () => {
    for (const [id, card] of Object.entries(FREEBUFF_MODEL_CARDS)) {
      if (!card.supersededBy) continue
      assert.ok(card.supersededBy.modelId, `${id} supersededBy has no model`)
      assert.notEqual(card.supersededBy.modelId, id, `${id} supersedes itself`)
    }
  })
})

describe('superseded models', () => {
  test('being superseded costs ranking points', () => {
    const plain = scoreModel(record(), TASK.BEST_GENERAL).score
    const old = scoreModel(record({ supersededBy: { modelId: 'x/new' } }), TASK.BEST_GENERAL).score
    assert.ok(old < plain, `${old} should be below ${plain}`)
    assert.equal(Math.round(plain - old), Math.abs(WEIGHTS.SUPERSEDED))
  })

  /* A penalty, not an exclusion — someone may still want it by name. */
  test('a superseded model remains eligible', () => {
    assert.equal(scoreModel(record({ supersededBy: { modelId: 'x/new' } }), TASK.BEST_GENERAL).eligible, true)
  })

  test('the penalty is explained', () => {
    const r = scoreModel(record({ supersededBy: { modelId: 'x/new' } }), TASK.BEST_GENERAL)
    assert.ok(r.reasons.some((x) => /superseded by x\/new/.test(x.label)))
  })
})

describe('reasoning controls', () => {
  test('a reasoning control helps where the task wants deliberation', () => {
    const without = scoreModel(record({ categories: ['REASONING'] }), TASK.BEST_REASONING).score
    const with_ = scoreModel(record({ categories: ['REASONING'], reasoning: { supported: true } }), TASK.BEST_REASONING).score
    assert.ok(with_ > without)
  })

  test('and is worth nothing to a fast task', () => {
    const without = scoreModel(record({ categories: ['FAST'] }), TASK.BEST_FAST).score
    const with_ = scoreModel(record({ categories: ['FAST'], reasoning: { supported: true } }), TASK.BEST_FAST).score
    assert.equal(with_, without, 'a fast request should not pay for deliberation')
  })
})

/* ============================================================
   Persisted memory must survive a restart
   ---------------------------------------
   Saving from live health alone erased what a restart had just
   restored: 87 remembered failures fell to 4 after two restarts.
   The registry was forgetting exactly what probing existed to learn.
   ============================================================ */

describe('failure memory survives save/load cycles', () => {
  test('a restored failure is written back out', async () => {
    const { saveSnapshot, loadSnapshot, SNAPSHOT_FILE } = await import('../server/models/store.mjs')
    const { mkdtempSync, rmSync, existsSync, renameSync } = await import('node:fs')
    void mkdtempSync
    void rmSync

    // A model that was restored (priorFailure set) but never tried this session
    const restored = [
      {
        id: 'aug/opus4.8',
        verified: false,
        lastVerified: null,
        verifiedBy: null,
        capabilities: {},
        health: { latencyMs: null, lastFailure: null, lastFailureKind: null },
        priorFailure: 'invalid_model',
        priorFailureAt: new Date().toISOString(),
      },
    ]

    const backup = `${SNAPSHOT_FILE}.testbak`
    const had = existsSync(SNAPSHOT_FILE)
    if (had) renameSync(SNAPSHOT_FILE, backup)
    try {
      saveSnapshot(restored)
      const loaded = loadSnapshot()
      assert.equal(loaded['aug/opus4.8']?.priorFailure, 'invalid_model', 'the remembered failure was dropped on save')
    } finally {
      if (had) renameSync(backup, SNAPSHOT_FILE)
      else if (existsSync(SNAPSHOT_FILE)) rmSync(SNAPSHOT_FILE)
    }
  })

  test('a live failure takes precedence over a remembered one', async () => {
    const { saveSnapshot, loadSnapshot, SNAPSHOT_FILE } = await import('../server/models/store.mjs')
    const { existsSync, renameSync, rmSync } = await import('node:fs')
    const now = new Date().toISOString()
    const model = [
      {
        id: 'x/y',
        verified: false,
        capabilities: {},
        health: { latencyMs: null, lastFailure: now, lastFailureKind: 'rate_limited' },
        priorFailure: 'invalid_key',
        priorFailureAt: now,
      },
    ]
    const backup = `${SNAPSHOT_FILE}.testbak2`
    const had = existsSync(SNAPSHOT_FILE)
    if (had) renameSync(SNAPSHOT_FILE, backup)
    try {
      saveSnapshot(model)
      assert.equal(loadSnapshot()['x/y']?.priorFailure, 'rate_limited', 'the newer live failure should win')
    } finally {
      if (had) renameSync(backup, SNAPSHOT_FILE)
      else if (existsSync(SNAPSHOT_FILE)) rmSync(SNAPSHOT_FILE)
    }
  })
})
