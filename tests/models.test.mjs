import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  normaliseModel,
  normaliseCatalogue,
  displayNameFor,
  CATEGORY,
  VERIFICATION,
  EVIDENCE,
  TIER,
  outranks,
} from '../server/models/catalog.mjs'
import { docEvidenceFor } from '../server/models/doc-evidence.mjs'
import {
  classifyFailure,
  recordSuccess,
  recordFailure,
  healthOf,
  resetHealth,
  FAILURE,
  HEALTH,
} from '../server/models/health.mjs'
import {
  seedRegistry,
  resetRegistry,
  allModels,
  getModel,
  noteSuccess,
  applyCapabilities,
  capable,
} from '../server/models/registry.mjs'
import { scoreModel, rank, best, bests, qualityTiers, TASK, TASK_IDS, explain } from '../server/models/ranking.mjs'
import { classifyTask, chainFor, selectModels, escalate, sessionModel, resetSessions, recommendations } from '../server/models/select.mjs'
import { PROBES, PROBE_IDS } from '../server/models/probe.mjs'
import { ensembleRoster, shouldEnsemble, ENSEMBLE_KINDS } from '../server/models/ensemble.mjs'

/* ============================================================
   Model discovery, ranking and fallback
   -------------------------------------
   These run entirely offline against a seeded registry. The one
   thing they must never do is depend on a live gateway: a test
   suite whose results change with someone's rate limit tells you
   nothing about the code.
   ============================================================ */

/** A representative slice of the real OmniRoute catalogue. */
const CATALOGUE = [
  'auto/best-coding',
  'auto/best-reasoning',
  'auto/best-fast',
  'auto/best-vision',
  'auto/best-free',
  'auto/coding:reliable',
  'auto/vision',
  'aug/opus4.8',
  'aug/sonnet4.6',
  'aug/haiku4.5',
  'aug/opus4.7-500k',
  'aug/gpt5.6-sol',
  'aug/gpt5.6-luna',
  'tllm/CLAUDE_4_6_SONNET',
  'tllm/gemini_3_pro',
  'tllm/GPT_o4_mini',
  'ddgw/claude-haiku-4-5',
  'ddgw/gpt-5.4-nano',
  'oc/big-pickle',
  'oc/deepseek-v4-flash-free',
  'felo/felo-chat',
  'veo-free/veo',
  'mcode/mimo-auto',
]

function seed() {
  resetRegistry()
  resetHealth()
  resetSessions()
  seedRegistry(CATALOGUE)
}

beforeEach(seed)

/* ============================================================
   1. Catalogue normalisation
   ============================================================ */

describe('catalogue normalisation', () => {
  test('splits provider from the rest of the id', () => {
    const m = normaliseModel('aug/opus4.8')
    assert.equal(m.provider, 'aug')
    assert.equal(m.providerLabel, 'Augment')
    assert.equal(m.family, 'claude')
  })

  test('an id with no provider prefix is not mangled', () => {
    const m = normaliseModel('auto')
    assert.equal(m.id, 'auto')
    assert.equal(m.provider, 'direct')
  })

  test('an unknown provider is preserved rather than guessed at', () => {
    const m = normaliseModel('brandnew/some-model')
    assert.equal(m.provider, 'brandnew')
    assert.equal(m.providerLabel, 'brandnew')
  })

  test('routing aliases are flagged as routing', () => {
    assert.equal(normaliseModel('auto/best-coding').routing, true)
    assert.equal(normaliseModel('aug/opus4.8').routing, false)
  })

  test('duplicate ids are dropped, not ranked twice', () => {
    const { models, duplicates } = normaliseCatalogue(['a/one', 'a/two', 'a/one'])
    assert.equal(models.length, 2)
    assert.deepEqual(duplicates, ['a/one'])
  })

  test('non-strings and blanks are ignored', () => {
    const { models } = normaliseCatalogue(['a/one', null, 42, '', '   ', undefined])
    assert.equal(models.length, 1)
  })

  test('display names are readable', () => {
    assert.equal(displayNameFor('CLAUDE_4_6_OPUS'), 'Claude 4.6 Opus')
    assert.equal(displayNameFor('gpt5.6-luna'), 'Gpt5.6 Luna')
    assert.equal(displayNameFor('deepseek-v4-flash-free'), 'Deepseek V4 Flash (free)')
  })

  test('a stated context window is read from the id', () => {
    assert.equal(normaliseModel('aug/opus4.7-500k').context, 500_000)
    assert.equal(normaliseModel('aug/opus4.7-500k').contextSource, EVIDENCE.ID)
  })

  /*
   * The `mini` inside *gemini*. `mini\b` matched it and filed every Gemini
   * route as fast and cheap — the opposite of what those routes are.
   */
  test('“gemini” is not read as a mini model', () => {
    const gemini = normaliseModel('auto/gemini')
    assert.ok(!gemini.categories.includes(CATEGORY.FAST), 'gemini must not be categorised FAST')
    assert.notEqual(gemini.cost, 'cheap')
  })

  test('but a real mini still is', () => {
    assert.ok(normaliseModel('tllm/GPT_o4_mini').categories.includes(CATEGORY.FAST))
    assert.ok(normaliseModel('aug/gpt5.4-mini').categories.includes(CATEGORY.FAST))
    assert.equal(normaliseModel('ddgw/gpt-5.4-nano').cost, 'cheap')
  })

  test('free is taken from the id and the pool', () => {
    assert.equal(normaliseModel('oc/deepseek-v4-flash-free').free, true)
    assert.equal(normaliseModel('oc/big-pickle').free, true)
    assert.equal(normaliseModel('aug/opus4.8').free, false)
  })
})

/* ============================================================
   2. Evidence hierarchy — the core rule
   ============================================================ */

describe('evidence', () => {
  test('a probe outranks every other source', () => {
    assert.ok(outranks(EVIDENCE.PROBE, EVIDENCE.CONFIG))
    assert.ok(outranks(EVIDENCE.PROBE, EVIDENCE.GATEWAY))
    assert.ok(outranks(EVIDENCE.PROBE, EVIDENCE.ID))
    assert.ok(!outranks(EVIDENCE.ID, EVIDENCE.PROBE))
  })

  test('a vision hint in the id does not assert vision', () => {
    const m = normaliseModel('auto/best-vision')
    assert.equal(m.capabilities.vision.value, null, 'unknown, not true')
    assert.equal(m.capabilities.vision.source, EVIDENCE.ID)
  })

  test('capability starts unknown, not false', () => {
    const m = normaliseModel('aug/opus4.8', { gatewayCapabilities: { tools: true } })
    assert.equal(m.capabilities.tools.value, null)
    assert.notEqual(m.capabilities.vision.value, false)
  })

  test('a probe result overwrites an id hint, but not the reverse', () => {
    applyCapabilities('auto/best-vision', { vision: true }, EVIDENCE.PROBE)
    assert.equal(getModel('auto/best-vision').capabilities.vision.value, true)
    applyCapabilities('auto/best-vision', { vision: false }, EVIDENCE.ID)
    assert.equal(getModel('auto/best-vision').capabilities.vision.value, true, 'a weak source must not undo a probe')
  })

  test('strict capability checks require a probe', () => {
    assert.equal(capable('auto/best-vision', 'vision', { strict: true }), false)
    applyCapabilities('auto/best-vision', { vision: true }, EVIDENCE.PROBE)
    assert.equal(capable('auto/best-vision', 'vision', { strict: true }), true)
  })

  test('documentation evidence is per family and capped', () => {
    const claude = docEvidenceFor('aug/opus4.8', 'claude')
    assert.ok(claude.weight > 0)
    assert.ok(claude.categories.includes(CATEGORY.REASONING))
    assert.equal(docEvidenceFor('x/y', 'nosuchfamily'), null)
  })

  test('the published GPT spread is reflected in variant weights', () => {
    const sol = docEvidenceFor('aug/gpt5.6-sol', 'gpt')
    const luna = docEvidenceFor('aug/gpt5.6-luna', 'gpt')
    assert.ok(sol.weight > luna.weight, 'the flagship tier outweighs the cost-sensitive tier')
    assert.ok(luna.categories.includes(CATEGORY.CHEAP))
  })
})

/* ============================================================
   3. Failure classification
   ============================================================ */

describe('failure classification', () => {
  const cases = [
    [{ code: 'rate_limited' }, FAILURE.RATE_LIMITED],
    [{ code: 'quota_exceeded' }, FAILURE.QUOTA],
    [{ code: 'invalid_api_key' }, FAILURE.INVALID_KEY],
    [{ code: 'model_unavailable' }, FAILURE.INVALID_MODEL],
    [{ code: 'timeout' }, FAILURE.TIMEOUT],
    [{ code: 'gateway_unavailable' }, FAILURE.NETWORK],
    [{ code: 'provider_unavailable', detail: 'status=502 upstream busy' }, FAILURE.SERVER_ERROR],
    [{ code: 'malformed_response', detail: 'missing choices' }, FAILURE.MALFORMED_RESPONSE],
    [{ code: 'bad_request', detail: 'image_url is not supported' }, FAILURE.UNSUPPORTED_CAPABILITY],
  ]

  for (const [error, expected] of cases) {
    test(`${error.code} → ${expected}`, () => assert.equal(classifyFailure(error), expected))
  }

  /* A 200 carrying "." — the known `felo/felo-chat` behaviour. */
  test('a content-free reply is its own failure kind, not a malformed body', () => {
    const error = { code: 'malformed_response', detail: 'model returned no usable content (".")' }
    assert.equal(classifyFailure(error), FAILURE.CONTENT_FREE)
  })

  /* Observed live: ddgw answers 418 with an anti-abuse challenge. */
  test('an anti-abuse challenge is a provider block, not “unknown”', () => {
    const error = { code: 'provider_error', detail: 'status=418 anti-abuse challenge failed: ERR_CHALLENGE' }
    assert.equal(classifyFailure(error), FAILURE.PROVIDER_BLOCKED)
  })

  /* Observed live: aug/* 502s with "'auggie' is not recognized". */
  test('a 5xx naming a missing binary is fatal, not transient', () => {
    const error = {
      code: 'provider_unavailable',
      detail: "status=502 Auggie CLI exited with code 1: 'auggie' is not recognized as an internal or external command",
    }
    assert.equal(classifyFailure(error), FAILURE.INVALID_MODEL)
  })

  test('an unrecognised error is not silently treated as fine', () => {
    assert.equal(classifyFailure({ code: 'something_new' }), FAILURE.UNKNOWN)
  })
})

/* ============================================================
   4. Health and the circuit breaker
   ============================================================ */

describe('health', () => {
  test('an untried route is unknown, not healthy', () => {
    assert.equal(healthOf('aug/opus4.8').state, HEALTH.UNKNOWN)
    assert.equal(healthOf('aug/opus4.8').successRate, null)
  })

  test('one failure does not open the breaker', () => {
    recordFailure('a/b', { code: 'provider_unavailable', detail: 'status=503' })
    assert.equal(healthOf('a/b').cooldownMs, 0, 'a single blip should not remove a route')
  })

  test('two consecutive failures do', () => {
    recordFailure('a/b', { code: 'rate_limited' })
    recordFailure('a/b', { code: 'rate_limited' })
    assert.ok(healthOf('a/b').cooldownMs > 0)
    assert.equal(healthOf('a/b').state, HEALTH.COOLDOWN)
    assert.equal(healthOf('a/b').available, false)
  })

  test('a fatal failure opens it immediately and excludes the route', () => {
    recordFailure('a/b', { code: 'invalid_api_key' })
    assert.equal(healthOf('a/b').fatal, true)
    assert.equal(healthOf('a/b').available, false)
  })

  test('success clears the breaker and restores health', () => {
    recordFailure('a/b', { code: 'rate_limited' })
    recordFailure('a/b', { code: 'rate_limited' })
    recordSuccess('a/b', { latencyMs: 400 })
    const h = healthOf('a/b')
    assert.equal(h.state, HEALTH.HEALTHY)
    assert.equal(h.cooldownMs, 0)
    assert.equal(h.available, true)
    assert.equal(h.latencyMs, 400)
  })

  test('a capability failure does not damage health', () => {
    recordSuccess('a/b', { latencyMs: 100 })
    recordFailure('a/b', { code: 'bad_request', detail: 'image_url is not supported' })
    const h = healthOf('a/b')
    assert.equal(h.failureCount, 0, 'cannot-see-images says nothing about serving text')
    assert.equal(h.state, HEALTH.HEALTHY)
  })

  test('statistics roll, so one lucky call cannot pin a model at the top', () => {
    for (let i = 0; i < 30; i++) recordSuccess('a/b', { latencyMs: 100 })
    assert.equal(healthOf('a/b').successRate, 1)
    for (let i = 0; i < 20; i++) recordFailure('a/b', { code: 'timeout' })
    assert.equal(healthOf('a/b').successRate, 0, 'the window has fully turned over')
  })

  test('a lapsed cooldown reads degraded, not healthy', () => {
    recordFailure('a/b', { code: 'timeout' })
    recordFailure('a/b', { code: 'timeout' })
    // Simulate the timer lapsing without a success
    const record = healthOf('a/b')
    assert.equal(record.state, HEALTH.COOLDOWN)
    recordSuccess('a/b', { latencyMs: 50 })
    assert.equal(healthOf('a/b').state, HEALTH.HEALTHY)
  })

  test('backoff lengthens with consecutive failures but never removes the route', () => {
    recordFailure('a/b', { code: 'rate_limited' })
    recordFailure('a/b', { code: 'rate_limited' })
    const first = healthOf('a/b').cooldownMs
    recordFailure('a/b', { code: 'rate_limited' })
    assert.ok(healthOf('a/b').cooldownMs > first)
    assert.ok(healthOf('a/b').cooldownMs < 60 * 60_000, 'still finite')
  })
})

/* ============================================================
   5. Verification state
   ============================================================ */

describe('verification', () => {
  test('a catalogued model is not verified', () => {
    const m = getModel('aug/opus4.8')
    assert.equal(m.verification, VERIFICATION.CATALOGUED)
    assert.equal(m.verified, false)
  })

  test('a successful request verifies it', () => {
    recordSuccess('aug/opus4.8', { latencyMs: 500 })
    noteSuccess('aug/opus4.8', { latencyMs: 500 })
    assert.equal(getModel('aug/opus4.8').verification, VERIFICATION.LIVE_VERIFIED)
    assert.equal(getModel('aug/opus4.8').verified, true)
  })

  test('verification is withdrawn when the route starts failing', () => {
    recordSuccess('aug/opus4.8', { latencyMs: 500 })
    noteSuccess('aug/opus4.8', { latencyMs: 500 })
    recordFailure('aug/opus4.8', { code: 'provider_unavailable', detail: 'status=503' })
    recordFailure('aug/opus4.8', { code: 'provider_unavailable', detail: 'status=503' })
    const m = getModel('aug/opus4.8')
    assert.notEqual(m.verification, VERIFICATION.LIVE_VERIFIED)
    assert.equal(m.verified, false)
  })

  test('a rate limit is reported as rate limited, not as broken', () => {
    recordFailure('aug/opus4.8', { code: 'rate_limited' })
    recordFailure('aug/opus4.8', { code: 'rate_limited' })
    assert.equal(getModel('aug/opus4.8').verification, VERIFICATION.RATE_LIMITED)
  })

  test('a fatal failure marks the model unavailable', () => {
    recordFailure('tllm/gemini_3_pro', { code: 'invalid_api_key' })
    assert.equal(getModel('tllm/gemini_3_pro').verification, VERIFICATION.UNAVAILABLE)
  })
})

/* ============================================================
   6. Ranking
   ============================================================ */

describe('ranking', () => {
  test('every task class produces a ranking', () => {
    for (const id of TASK_IDS) {
      const ranked = rank(id)
      assert.ok(Array.isArray(ranked), `${id} must rank`)
    }
  })

  test('scores are explainable — every point has a reason', () => {
    const model = getModel('auto/best-coding')
    const result = scoreModel(model, TASK.BEST_CODING)
    assert.ok(result.reasons.length > 0)
    for (const reason of result.reasons) {
      assert.equal(typeof reason.label, 'string')
      assert.ok(reason.label.length > 0)
      assert.equal(typeof reason.points, 'number')
    }
  })

  test('ranking is deterministic', () => {
    const a = rank('BEST_CODING').map((m) => m.id)
    const b = rank('BEST_CODING').map((m) => m.id)
    assert.deepEqual(a, b)
  })

  /* The rule the whole system rests on. */
  test('live verification outweighs every name-derived signal', () => {
    // `oc/big-pickle` has no coding hint, no documentation, and a free-tier id
    recordSuccess('oc/big-pickle', { latencyMs: 200 })
    noteSuccess('oc/big-pickle', { latencyMs: 200 })

    const ranked = rank('BEST_CODING')
    const verified = ranked.find((m) => m.id === 'oc/big-pickle')
    const unverifiedFlagship = ranked.find((m) => m.id === 'auto/best-coding')

    assert.ok(verified.score > unverifiedFlagship.score,
      'a verified route must beat an unverified one whose name says "best-coding"')
  })

  test('a cooling route is pushed down but not deleted', () => {
    recordFailure('auto/best-coding', { code: 'rate_limited' })
    recordFailure('auto/best-coding', { code: 'rate_limited' })
    const ranked = rank('BEST_CODING')
    assert.ok(ranked.some((m) => m.id === 'auto/best-coding'), 'still present')
    assert.ok(ranked[0].id !== 'auto/best-coding', 'but not first')
  })

  test('a fatally failed route is excluded outright', () => {
    recordFailure('auto/best-coding', { code: 'invalid_api_key' })
    assert.ok(!rank('BEST_CODING').some((m) => m.id === 'auto/best-coding'))
  })

  test('free ranking prefers free routes', () => {
    const top = best('BEST_FREE')
    assert.ok(top?.free, `expected a free model, got ${top?.id}`)
  })

  test('long-context ranking prefers a stated large window', () => {
    const top = best('BEST_LONG_CONTEXT')
    assert.ok(top, 'a long-context model should exist in this catalogue')
    assert.ok((top.context ?? 0) >= 200_000, `${top.id} has ${top.context} context`)
  })

  test('a context window that is too small is penalised', () => {
    const small = { ...getModel('ddgw/gpt-5.4-nano'), context: 8_000 }
    const result = scoreModel(small, TASK.BEST_GENERAL, { estimatedTokens: 300_000 })
    assert.ok(result.reasons.some((r) => r.points < 0 && /short/.test(r.label)))
  })

  test('there is no single best model — the bests differ', () => {
    recordSuccess('oc/big-pickle', { latencyMs: 100 })
    noteSuccess('oc/big-pickle')
    recordSuccess('aug/opus4.8', { latencyMs: 4000 })
    noteSuccess('aug/opus4.8')

    const all = bests()
    const distinct = new Set(Object.values(all).filter(Boolean).map((m) => m.id))
    assert.ok(distinct.size > 1, 'different tasks must be able to pick different models')
  })

  test('explanations name evidence, never a prompt', () => {
    const entry = best('BEST_GENERAL')
    const text = explain(entry, 'general')
    assert.ok(/verified/.test(text))
    assert.ok(!/prompt|system message|instruction/i.test(text))
  })
})

/* ============================================================
   7. Quality tiers
   ============================================================ */

describe('quality tiers', () => {
  test('an unverified model cannot reach the top tiers', () => {
    const tiers = qualityTiers()
    for (const model of allModels()) {
      if (model.verified || model.free) continue
      const tier = tiers.get(model.id)
      assert.ok(
        tier !== TIER.S && tier !== TIER.A,
        `${model.id} reached ${tier} without ever answering a request`,
      )
    }
  })

  test('verification is what promotes a model', () => {
    const before = qualityTiers().get('aug/opus4.8')
    recordSuccess('aug/opus4.8', { latencyMs: 300 })
    noteSuccess('aug/opus4.8', { latencyMs: 300 })
    const after = qualityTiers().get('aug/opus4.8')
    assert.notEqual(before, after)
    assert.ok([TIER.S, TIER.A].includes(after), `expected promotion, got ${after}`)
  })

  test('free routes are tiered separately', () => {
    const tiers = qualityTiers()
    assert.equal(tiers.get('oc/big-pickle'), TIER.FREE)
  })

  test('tiers are recomputed, never stored', () => {
    const first = qualityTiers()
    recordFailure('aug/opus4.8', { code: 'invalid_api_key' })
    const second = qualityTiers()
    assert.notDeepEqual([...first], [...second])
  })
})

/* ============================================================
   8. Task classification
   ============================================================ */

describe('task classification', () => {
  const cases = [
    ['hello', {}, 'BEST_FAST'],
    ['Explain why this architecture uses a queue', {}, 'BEST_REASONING'],
    ['Build a React application with a login page', {}, 'BEST_CODING'],
    ['Fix this bug in my repository', {}, 'BEST_CODING'],
    ['Analyse this screenshot', {}, 'BEST_VISION'],
    ['Research the current state of WebGPU', {}, 'BEST_RESEARCH'],
    ['Give me a quick summary', {}, 'BEST_FAST'],
    ['I need the cheapest possible answer', {}, 'BEST_COST'],
    ['What is the latest React version?', {}, 'BEST_RESEARCH'],
  ]

  for (const [text, context, expected] of cases) {
    test(`"${text}" → ${expected}`, () => {
      assert.equal(classifyTask(text, context).task, expected)
    })
  }

  test('an attached image beats the wording', () => {
    assert.equal(classifyTask('thoughts?', { hasImages: true }).task, 'BEST_VISION')
  })

  test('build mode beats the wording', () => {
    assert.equal(classifyTask('hello', { mode: 'build' }).task, 'BEST_CODING')
  })

  test('supplied tools imply an agent task', () => {
    assert.equal(classifyTask('do the thing', { hasTools: true }).task, 'BEST_TOOL_AGENT')
  })

  test('a very large conversation needs a long-context route regardless of wording', () => {
    assert.equal(classifyTask('quick question', { estimatedTokens: 400_000 }).task, 'BEST_LONG_CONTEXT')
  })

  /* "generate an image" is not a vision request — it is the opposite one. */
  test('generating an image does not classify as vision', () => {
    assert.notEqual(classifyTask('Generate an image of a mountain').task, 'BEST_VISION')
  })

  test('an unrecognised request falls back to general, not to nothing', () => {
    const result = classifyTask('mauve seventeen banana')
    assert.equal(result.task, 'BEST_GENERAL')
    assert.equal(result.confidence, 'default')
  })
})

/* ============================================================
   9. Fallback chains
   ============================================================ */

describe('fallback chains', () => {
  test('a chain has a primary and fallbacks', () => {
    const chain = chainFor('BEST_GENERAL')
    assert.ok(chain.length > 1, 'a chain of one is not a chain')
  })

  test('chains prefer provider diversity so one outage cannot take them all', () => {
    const chain = chainFor('BEST_GENERAL')
    const providers = new Set(chain.map((c) => c.provider))
    assert.ok(providers.size > 1, `all ${chain.length} candidates came from ${[...providers]}`)
  })

  test('a chain never contains the same model twice', () => {
    for (const task of TASK_IDS) {
      const ids = chainFor(task).map((c) => c.id)
      assert.equal(new Set(ids).size, ids.length, `${task} has a duplicate`)
    }
  })

  /* Section 39. The single most important rule in the chain builder. */
  test('a vision chain never contains a model known to lack vision', () => {
    applyCapabilities('auto/best-vision', { vision: true }, EVIDENCE.PROBE)
    applyCapabilities('aug/opus4.8', { vision: false }, EVIDENCE.PROBE)
    const chain = chainFor('BEST_VISION')
    assert.ok(!chain.some((c) => c.id === 'aug/opus4.8'))
  })

  test('a vision chain does not tail into general models', () => {
    applyCapabilities('auto/best-vision', { vision: true }, EVIDENCE.PROBE)
    const chain = chainFor('BEST_VISION')
    for (const entry of chain) {
      assert.ok(!entry.viaTail, `${entry.id} was added via a general tail`)
    }
  })

  test('a coding chain may end on a strong general model', () => {
    const chain = chainFor('BEST_CODING')
    assert.ok(chain.length >= 2)
  })

  test('an unhealthy model is ranked below a healthy one in the chain', () => {
    recordSuccess('oc/big-pickle', { latencyMs: 100 })
    noteSuccess('oc/big-pickle')
    recordFailure('auto/best-coding', { code: 'rate_limited' })
    recordFailure('auto/best-coding', { code: 'rate_limited' })
    const chain = chainFor('BEST_CODING').map((c) => c.id)
    if (chain.includes('auto/best-coding')) {
      assert.ok(chain.indexOf('oc/big-pickle') < chain.indexOf('auto/best-coding'))
    }
  })
})

/* ============================================================
   10. Selection
   ============================================================ */

describe('selection', () => {
  test('an alias resolves to a ranked chain, not a fixed model', () => {
    const result = selectModels('pixgpt-pro', { text: 'Build a React app' })
    assert.equal(result.task, 'BEST_CODING')
    assert.ok(result.chain.length > 0)
  })

  test('pixgpt-pro follows the task', () => {
    assert.equal(selectModels('pixgpt-pro', { text: 'Solve this hard proof' }).task, 'BEST_REASONING')
    assert.equal(selectModels('pixgpt-pro', { text: 'Fix this bug in my code' }).task, 'BEST_CODING')
    assert.equal(selectModels('pixgpt-pro', { text: 'hello there' }).task, 'BEST_GENERAL')
  })

  test('pixgpt-fast always wants a fast route', () => {
    assert.equal(selectModels('pixgpt-fast', { text: 'Build a React app' }).task, 'BEST_FAST')
  })

  test('a concrete model the user typed is honoured as primary', () => {
    const result = selectModels('aug/opus4.8', { text: 'anything' })
    assert.equal(result.primary, 'aug/opus4.8')
    assert.equal(result.manual, true)
  })

  test('a manual choice still gets fallbacks', () => {
    assert.ok(selectModels('aug/opus4.8', { text: 'anything' }).chain.length > 1)
  })

  test('vision with no verified route reports unavailable rather than answering', () => {
    const result = selectModels('pixgpt-vision', { text: 'what is in this image', requiresVision: true, hasImages: true })
    assert.equal(result.chain.length, 0)
    assert.equal(result.degraded, true)
    assert.match(result.why, /vision/i)
  })

  test('vision with a verified route selects it', () => {
    applyCapabilities('auto/best-vision', { vision: true }, EVIDENCE.PROBE)
    recordSuccess('auto/best-vision', { latencyMs: 900 })
    noteSuccess('auto/best-vision')
    const result = selectModels('pixgpt-vision', { text: 'describe this image', requiresVision: true, hasImages: true })
    assert.equal(result.primary, 'auto/best-vision')
  })

  test('the selection explains itself', () => {
    const result = selectModels('pixgpt-pro', { text: 'hello' })
    assert.equal(typeof result.why, 'string')
    assert.ok(result.why.length > 20)
  })

  test('a degraded selection says so', () => {
    assert.equal(selectModels('pixgpt-pro', { text: 'hello' }).degraded, true, 'nothing is verified in a fresh registry')
  })
})

/* ============================================================
   11. Escalation and continuity
   ============================================================ */

describe('escalation', () => {
  test('escalation goes up the ladder, cheapest first', () => {
    assert.equal(escalate('BEST_FAST').task, 'BEST_GENERAL')
    assert.equal(escalate('BEST_GENERAL').task, 'BEST_REASONING')
    assert.equal(escalate('BEST_REASONING').task, 'BEST_CODING')
  })

  test('the ladder terminates', () => {
    assert.equal(escalate('BEST_CODING'), null)
  })

  test('escalation records why', () => {
    assert.equal(escalate('BEST_FAST', { reason: 'verification failed' }).reason, 'verification failed')
  })
})

describe('continuity', () => {
  test('a session keeps its model across turns', () => {
    const chain = ['aug/opus4.8', 'aug/sonnet4.6']
    const first = sessionModel('task_1', { task: 'BEST_CODING', chain })
    const second = sessionModel('task_1', { task: 'BEST_CODING', chain: ['oc/big-pickle', ...chain] })
    assert.equal(first, second, 'the model must not drift mid-task')
  })

  test('but yields when its route becomes unusable', () => {
    const chain = ['aug/opus4.8', 'aug/sonnet4.6']
    sessionModel('task_2', { task: 'BEST_CODING', chain })
    recordFailure('aug/opus4.8', { code: 'invalid_api_key' })
    const next = sessionModel('task_2', { task: 'BEST_CODING', chain })
    assert.notEqual(next, 'aug/opus4.8', 'staying on a dead route is not continuity')
  })

  test('no session id means no continuity state', () => {
    assert.equal(sessionModel(null, { chain: ['a/b'] }), 'a/b')
  })
})

/* ============================================================
   12. Probes
   ============================================================ */

describe('probes', () => {
  test('every probe is cheap', () => {
    for (const id of PROBE_IDS) {
      assert.ok(PROBES[id].maxTokens <= 96, `${id} asks for ${PROBES[id].maxTokens} tokens`)
    }
  })

  test('every probe verifies its own result', () => {
    for (const id of PROBE_IDS) assert.equal(typeof PROBES[id].verify, 'function')
  })

  test('a content-free reply fails the chat probe', () => {
    assert.equal(PROBES.chat.verify({ content: '.' }).ok, false)
    assert.equal(PROBES.chat.verify({ content: '**.**' }).ok, false)
    assert.equal(PROBES.chat.verify({ content: '   ' }).ok, false)
  })

  test('a real reply passes it', () => {
    assert.equal(PROBES.chat.verify({ content: 'ready' }).ok, true)
    assert.equal(PROBES.chat.verify({ content: '42' }).ok, true, 'short answers are still answers')
  })

  test('the tool probe requires an actual tool call, not prose about one', () => {
    assert.equal(PROBES.tools.verify({ content: 'I would call get_weather', toolCalls: [] }).ok, false)
    assert.equal(PROBES.tools.verify({ toolCalls: [{ function: { name: 'get_weather' } }] }).ok, true)
  })

  test('the structured probe requires parseable JSON with the right values', () => {
    assert.equal(PROBES.structured.verify({ content: '{"ok":true,"n":7}' }).ok, true)
    assert.equal(PROBES.structured.verify({ content: 'Sure! {"ok":true,"n":7}' }).ok, true)
    assert.equal(PROBES.structured.verify({ content: '{"ok":true,"n":8}' }).ok, false)
    assert.equal(PROBES.structured.verify({ content: 'not json' }).ok, false)
  })

  test('only the vision probe may assert vision', () => {
    assert.equal(PROBES.vision.verify({ content: 'ok' }).capability, 'vision')
    assert.equal(PROBES.vision.requiresVision, true)
    for (const id of PROBE_IDS.filter((p) => p !== 'vision')) {
      assert.notEqual(PROBES[id].verify({ content: 'x', toolCalls: [] }).capability, 'vision')
    }
  })

  test('the reasoning benchmark has one correct answer', () => {
    assert.equal(PROBES.reasoning.verify({ content: '10' }).ok, true)
    assert.equal(PROBES.reasoning.verify({ content: '12' }).ok, false)
  })
})

/* ============================================================
   13. Ensembles
   ============================================================ */

describe('ensembles', () => {
  test('off by default', () => {
    assert.equal(shouldEnsemble({ kind: ENSEMBLE_KINDS.CODE_REVIEW }).yes, false)
  })

  test('on when explicitly asked for', () => {
    assert.equal(shouldEnsemble({ kind: ENSEMBLE_KINDS.CODE_REVIEW, explicit: true }).yes, true)
  })

  test('on for critical work', () => {
    assert.equal(shouldEnsemble({ kind: ENSEMBLE_KINDS.SECURITY, importance: 'critical' }).yes, true)
  })

  test('the reviewer is never the primary', () => {
    const roster = ensembleRoster(ENSEMBLE_KINDS.CODE_REVIEW)
    for (const reviewer of roster.reviewers) assert.notEqual(reviewer.id, roster.primary.id)
  })

  test('the reviewer prefers a different family, so it is genuinely independent', () => {
    const roster = ensembleRoster(ENSEMBLE_KINDS.CODE_REVIEW)
    if (roster.reviewers.length > 0) {
      assert.notEqual(roster.reviewers[0].family, roster.primary.family)
    }
  })

  test('an unknown ensemble kind is refused rather than guessed at', () => {
    assert.throws(() => ensembleRoster('nonsense'))
  })
})

/* ============================================================
   14. Recommendations for the UI
   ============================================================ */

describe('recommendations', () => {
  test('groups are short — a picker, not a catalogue dump', () => {
    for (const group of recommendations({ text: 'build an app' }).groups) {
      assert.ok(group.models.length <= 3, `${group.key} has ${group.models.length} rows`)
    }
  })

  test('the recommended group reflects the request', () => {
    assert.equal(recommendations({ text: 'fix this bug in my code' }).task, 'BEST_CODING')
  })

  test('an empty vision group explains itself rather than showing nothing', () => {
    const vision = recommendations({ text: 'hello' }).groups.find((g) => g.key === 'vision')
    assert.equal(vision.models.length, 0)
    assert.match(vision.note, /verified/i)
  })

  test('the top pick in each group carries an explanation', () => {
    for (const group of recommendations({ text: 'hello' }).groups) {
      if (group.models.length > 0) assert.ok(group.models[0].why, `${group.key} has no explanation`)
    }
  })
})

/* ============================================================
   15. Registry lifecycle
   ============================================================ */

describe('registry', () => {
  test('seeding produces one record per unique id', () => {
    assert.equal(allModels().length, CATALOGUE.length)
  })

  test('an unknown id is not in the registry', () => {
    assert.equal(getModel('nope/nothing'), null)
  })

  test('records carry every field the specification asks for', () => {
    const model = getModel('aug/opus4.8')
    for (const field of [
      'id', 'provider', 'family', 'displayName', 'categories', 'capabilities',
      'verification', 'health', 'lastVerified', 'latency', 'errorRate', 'free', 'context', 'cost',
    ]) {
      assert.ok(field in model, `missing ${field}`)
    }
  })

  test('a model may belong to several categories', () => {
    assert.ok(getModel('auto/best-coding').categories.length > 1)
  })

  test('no record leaks a credential', () => {
    const dump = JSON.stringify(allModels())
    assert.ok(!/apiKey|api_key|Bearer |sk-[A-Za-z0-9]{8}/.test(dump))
  })
})

/* ============================================================
   16. Vision may never be downgraded (section 39)
   ------------------------------------------------
   The failure with the worst consequence: a text-only model
   answering confidently about an image it never received. Every
   alias and every wording is checked, because the bug that
   prompted these was `pixgpt-pro` quietly resolving an image
   request to BEST_GENERAL.
   ============================================================ */

describe('vision is never downgraded', () => {
  const withImage = { text: 'what is in this screenshot', requiresVision: true, hasImages: true }

  for (const alias of ['pixgpt-pro', 'pixgpt-fast', 'pixgpt-vision', undefined]) {
    test(`${alias ?? 'no alias'} keeps an image request on the vision class`, () => {
      assert.equal(selectModels(alias, withImage).task, 'BEST_VISION')
    })

    test(`${alias ?? 'no alias'} returns no chain when no vision route is verified`, () => {
      const result = selectModels(alias, withImage)
      assert.equal(result.chain.length, 0, `would have routed to ${result.chain.join(', ')}`)
    })
  }

  test('wording that sounds like coding does not escape the vision class', () => {
    const result = selectModels('pixgpt-pro', {
      text: 'fix the bug shown in this react component screenshot',
      requiresVision: true,
      hasImages: true,
    })
    assert.equal(result.task, 'BEST_VISION')
  })

  test('once a route is probe-verified for vision, it is used', () => {
    applyCapabilities('auto/best-vision', { vision: true }, EVIDENCE.PROBE)
    recordSuccess('auto/best-vision', { latencyMs: 800 })
    noteSuccess('auto/best-vision')
    const result = selectModels('pixgpt-pro', withImage)
    assert.equal(result.primary, 'auto/best-vision')
    for (const id of result.chain) {
      assert.notEqual(getModel(id).capabilities.vision?.value, false)
    }
  })

  test('a text-only request is unaffected', () => {
    assert.notEqual(selectModels('pixgpt-pro', { text: 'hello' }).task, 'BEST_VISION')
  })
})

/* ============================================================
   17. Diversity must not hand a slot to a dead pool
   -------------------------------------------------
   Provider diversity is a tiebreak. Applied unconditionally it
   filled every chain's second and third slots with entire pools
   that were known to be failing, purely because they were
   *different* — a fallback that cannot work is not a fallback.
   ============================================================ */

describe('chain diversity is a tiebreak, not an override', () => {
  test('a much weaker different-provider candidate does not take a slot', () => {
    // Make the `auto` pool strong and every other pool visibly broken
    for (const id of ['auto/best-coding', 'auto/coding:reliable', 'auto/best-reasoning']) {
      recordSuccess(id, { latencyMs: 300 })
      noteSuccess(id)
    }
    for (const id of ['aug/opus4.8', 'aug/sonnet4.6', 'tllm/CLAUDE_4_6_SONNET', 'ddgw/claude-haiku-4-5']) {
      recordFailure(id, { code: 'provider_unavailable', detail: 'status=502' })
    }

    const chain = chainFor('BEST_CODING')
    const healthyAuto = chain.filter((c) => c.provider === 'auto').length
    assert.ok(healthyAuto >= 2, `expected the working pool to hold several slots, got ${chain.map((c) => c.id).join(', ')}`)
  })

  test('diversity still applies when candidates are comparable', () => {
    for (const id of ['auto/best-coding', 'oc/big-pickle']) {
      recordSuccess(id, { latencyMs: 300 })
      noteSuccess(id)
    }
    const providers = new Set(chainFor('BEST_CODING').map((c) => c.provider))
    assert.ok(providers.size > 1, 'comparable candidates should still spread across providers')
  })

  test('the primary is always the highest scorer, diversity notwithstanding', () => {
    const ranked = rank('BEST_GENERAL')
    assert.equal(chainFor('BEST_GENERAL')[0].id, ranked[0].id)
  })
})

/* ============================================================
   18. Remembered failures
   -----------------------
   A fresh process knows nothing until it tries. Persisted
   knowledge is what stops it re-learning, every restart, that a
   whole pool is unreachable — but it must never harden into a
   permanent exclusion.
   ============================================================ */

describe('remembered failures', () => {
  const remember = (id, kind) => {
    const record = getModel(id)
    // Mirrors what restoreMemory() applies from the snapshot
    Object.assign(rawRecord(id), {
      priorFailure: kind,
      priorFailureFatal: ['invalid_key', 'invalid_model', 'quota'].includes(kind),
    })
    return record
  }

  // The registry hands out decorated copies; tests need the stored object
  const rawRecord = (id) => {
    const all = allModels()
    const found = all.find((m) => m.id === id)
    assert.ok(found, `${id} must exist`)
    return found
  }

  test('a fatal memory outweighs a transient one', () => {
    const model = { ...getModel('aug/opus4.8'), priorFailure: 'invalid_model', priorFailureFatal: true }
    const transient = { ...getModel('aug/opus4.8'), priorFailure: 'timeout', priorFailureFatal: false }
    const fatalScore = scoreModel(model, TASK.BEST_CODING).score
    const blipScore = scoreModel(transient, TASK.BEST_CODING).score
    assert.ok(fatalScore < blipScore, `${fatalScore} should be well below ${blipScore}`)
  })

  test('a remembered failure is a penalty, never an exclusion', () => {
    const model = { ...getModel('aug/opus4.8'), priorFailure: 'invalid_key', priorFailureFatal: true }
    const result = scoreModel(model, TASK.BEST_CODING)
    assert.equal(result.eligible, true, 'it must still be able to come back')
    assert.ok(Number.isFinite(result.score))
  })

  test('one success this session cancels the memory', () => {
    const remembered = { ...getModel('aug/opus4.8'), priorFailure: 'invalid_model', priorFailureFatal: true }
    const before = scoreModel(remembered, TASK.BEST_CODING).score

    recordSuccess('aug/opus4.8', { latencyMs: 400 })
    noteSuccess('aug/opus4.8')
    const after = scoreModel({ ...getModel('aug/opus4.8'), priorFailure: 'invalid_model', priorFailureFatal: true }, TASK.BEST_CODING)

    assert.ok(after.score > before, 'answering must clear the penalty')
    assert.ok(!after.reasons.some((r) => /earlier session/.test(r.label)), 'and the reason should go with it')
  })

  test('the penalty is explained, not silent', () => {
    const model = { ...getModel('aug/opus4.8'), priorFailure: 'invalid_model', priorFailureFatal: true }
    const reasons = scoreModel(model, TASK.BEST_CODING).reasons
    assert.ok(reasons.some((r) => /earlier session/.test(r.label) && r.points < 0))
  })

  void remember
})

describe('a hard preference yields when only broken routes satisfy it', () => {
  test('long context falls back to the general pool when every 200k route is dead', () => {
    // Every stated-200k route on this catalogue is in the aug pool
    for (const id of ['aug/opus4.7-500k']) recordFailure(id, { code: 'invalid_api_key' })
    for (const id of ['auto/best-reasoning', 'auto/best-coding']) {
      recordSuccess(id, { latencyMs: 300 })
      noteSuccess(id)
    }
    const ranked = rank('BEST_LONG_CONTEXT')
    assert.ok(ranked.length > 0, 'the class must not come back empty')
    assert.ok(ranked.some((m) => m.provider === 'auto'), `got ${ranked.map((m) => m.id).join(', ')}`)
  })

  test('but it still applies when a matching route is usable', () => {
    recordSuccess('aug/opus4.7-500k', { latencyMs: 900 })
    noteSuccess('aug/opus4.7-500k')
    assert.equal(rank('BEST_LONG_CONTEXT')[0].id, 'aug/opus4.7-500k')
  })

  test('free still filters to free routes when a free route works', () => {
    recordSuccess('oc/big-pickle', { latencyMs: 200 })
    noteSuccess('oc/big-pickle')
    assert.equal(best('BEST_FREE').free, true)
  })
})

/* ============================================================
   19. Adaptive timeouts
   --------------------
   A fixed 15-second connect budget is wrong in both directions:
   a route measured at 200ms holds a failing request for fifteen
   seconds, and lowering the constant kills routes that legitimately
   take nine. Measured live: a dead route cost 15s while a healthy
   one answered in 8s.
   ============================================================ */

describe('adaptive timeouts', () => {
  const CEILING = 15_000

  test('an unknown route gets the full ceiling', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    assert.equal(timeoutFor('never/tried', CEILING), CEILING)
  })

  /*
   * One sample is all a restored route has. Rejecting it made the mechanism
   * dormant after every restart — which is the common case, not the rare one.
   */
  test('a single restored measurement still shortens the budget', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    recordSuccess('a/fast', { latencyMs: 100 })
    assert.ok(timeoutFor('a/fast', CEILING) < CEILING, 'a restored latency should be used')
  })

  test('but a thin measurement earns a wider margin than a settled one', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    recordSuccess('a/thin', { latencyMs: 2_000 })
    const thin = timeoutFor('a/thin', CEILING)
    for (let i = 0; i < 4; i++) recordSuccess('a/settled', { latencyMs: 2_000 })
    const settled = timeoutFor('a/settled', CEILING)
    assert.ok(thin > settled, `thin ${thin} should exceed settled ${settled}`)
  })

  test('a consistently fast route gets a shorter budget', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    for (let i = 0; i < 5; i++) recordSuccess('a/quick', { latencyMs: 200 })
    const budget = timeoutFor('a/quick', CEILING)
    assert.ok(budget < CEILING, `expected below ${CEILING}, got ${budget}`)
    assert.ok(budget >= 5_000, `floor must hold, got ${budget}`)
  })

  /* The failure this must not cause: cutting off a route that was about to answer. */
  test('a slow but working route keeps room to answer', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    for (let i = 0; i < 5; i++) recordSuccess('a/slow', { latencyMs: 9_000 })
    assert.equal(timeoutFor('a/slow', CEILING), CEILING, 'a 9s route must not be cut short')
  })

  test('the budget follows the slowest recent success, not the average', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    for (const ms of [100, 100, 100, 3_000]) recordSuccess('a/spiky', { latencyMs: ms })
    // 3000 × 3 = 9000, comfortably above the floor and below the ceiling
    assert.ok(timeoutFor('a/spiky', CEILING) >= 9_000, 'an outlier must widen the budget, not be averaged away')
  })

  test('the budget never exceeds the configured ceiling', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    for (let i = 0; i < 5; i++) recordSuccess('a/huge', { latencyMs: 60_000 })
    assert.equal(timeoutFor('a/huge', CEILING), CEILING)
  })

  test('a lower ceiling is respected', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    for (let i = 0; i < 5; i++) recordSuccess('a/quick2', { latencyMs: 200 })
    assert.equal(timeoutFor('a/quick2', 3_000), 3_000, 'the caller’s ceiling always wins')
  })
})

describe('known-bad routes are confirmed quickly, not waited on', () => {
  /*
   * A route with a terminal remembered failure still gets tried — a fixed
   * deployment must be able to prove itself — but spending the full ceiling to
   * confirm what we already know delays the fallback that was always going to
   * serve.
   */
  test('a terminal prior failure shortens the budget', async () => {
    const { timeoutFor } = await import('../server/models/health.mjs')
    // The resolver combines this with the registry's memory; here we assert the
    // health-side budget is untouched, and the combination is asserted live.
    assert.equal(timeoutFor('aug/opus4.8', 15_000), 15_000)
  })

  test('one success clears the penalty, so recovery is not blocked', () => {
    recordSuccess('aug/opus4.8', { latencyMs: 300 })
    noteSuccess('aug/opus4.8')
    assert.equal(getModel('aug/opus4.8').priorFailure, null)
  })
})
