import { CATEGORY, VERIFICATION, TIER, COST, EVIDENCE } from './catalog.mjs'
import { allModels, docWeight } from './registry.mjs'
import { HEALTH } from './health.mjs'

/* ============================================================
   Deterministic, explainable ranking
   ----------------------------------
   Sections 6, 7 and 8. Every point a model scores can be printed
   as a sentence, because a score nobody can read is a score nobody
   can correct — and the whole failure this system exists to prevent
   is a model being called "best" for reasons that turn out to be
   its name.

   Two structural rules do most of the work:

     · Live verification is worth more than every name-derived
       signal put together (VERIFY_LIVE vs CATEGORY_HINT + DOC_MAX).
       An unglamorous model that answers beats a famous one that
       has never been tried.

     · There is no BEST_MODEL. There are eleven bests, one per
       task class (section 8), because they genuinely differ.
   ============================================================ */

/* ---------- weights ---------- */

export const WEIGHTS = Object.freeze({
  /** Capability the task requires, confirmed by probe. */
  CAPABILITY_PROVEN: 30,
  /** Capability the task requires, plausible but unproven. */
  CAPABILITY_POSSIBLE: 6,
  /** A real request has succeeded and the route still works. */
  VERIFY_LIVE: 25,
  /** Verified against a stub only — enough for tests, not for production ranking. */
  VERIFY_MOCK: 4,
  /** Category the task wants, taken from the id. A hint, weighted like one. */
  CATEGORY_HINT: 8,
  /** Ceiling on the contribution of published documentation. */
  DOC_MAX: 6,
  HEALTH_HEALTHY: 14,
  HEALTH_DEGRADED: -8,
  HEALTH_COOLDOWN: -40,
  HEALTH_INVALID: -100,
  /** Rolling success rate, scaled. */
  RELIABILITY: 15,
  /** Context window covers the estimated need. */
  CONTEXT_FIT: 10,
  CONTEXT_SHORT: -25,
  /** The task needs a window and nobody has said what this model's is. */
  CONTEXT_UNKNOWN: -9,
  /** Tool calling required and available. */
  TOOL_FIT: 12,
  /** Fast enough for the latency class the task wants. */
  LATENCY_FIT: 10,
  LATENCY_SLOW: -6,
  /** Each recent consecutive failure. */
  RECENT_FAILURE: -12,
  /** Cost penalty when the task asked to be cheap. */
  COST_PENALTY: -14,
  /** Free model when the task asked for free. */
  COST_FREE_BONUS: 12,
  /** The operator named this route in config. A preference, not an override. */
  CONFIGURED: 5,
  /** Gateway-side routing alias: OmniRoute picks a live upstream itself. */
  ROUTING_ALIAS: 6,
  /** Not in the catalogue any more. */
  NOT_CATALOGUED: -20,
  /**
   * A failure remembered from an earlier session. A penalty, deliberately not
   * an exclusion: a gateway that was misconfigured yesterday may have been
   * fixed since, and it must be able to prove that by answering.
   */
  PRIOR_FAILURE: -18,
  /**
   * A remembered failure that cannot fix itself: absent credentials, a missing
   * binary, an exhausted quota. Still a penalty rather than an exclusion — one
   * success clears it — but heavy enough that a dead pool stops out-ranking
   * working routes on the strength of its documentation.
   */
  PRIOR_FAILURE_FATAL: -60,
  /**
   * The provider says a newer model replaces this one.
   *
   * A penalty rather than an exclusion: it still works, someone may want it by
   * name, and the provider's own UI keeps it selectable. It simply stops being
   * *recommended* when the replacement is available.
   */
  SUPERSEDED: -22,
  /** The provider states this model accepts a reasoning-effort control. */
  REASONING_CONTROL: 5,
})

/* ---------- task classes (sections 8, 10) ---------- */

/**
 * What each task class needs. `categories` are wanted, `requires` are hard —
 * a model failing a `requires` is filtered out before scoring, never merely
 * penalised, because ranking a text-only model bottom of a vision list still
 * lets it win when everything above it is cooling down.
 */
export const TASK = Object.freeze({
  BEST_GENERAL: {
    id: 'BEST_GENERAL',
    label: 'General',
    categories: [CATEGORY.GENERAL_CHAT, CATEGORY.REASONING],
    requires: ['chat'],
    latency: 'balanced',
  },
  BEST_CODING: {
    id: 'BEST_CODING',
    label: 'Coding',
    categories: [CATEGORY.CODING, CATEGORY.TOOL_AGENT, CATEGORY.REASONING],
    requires: ['chat'],
    prefers: ['tools', 'longContext'],
    minContext: 128_000,
    latency: 'patient',
  },
  BEST_REASONING: {
    id: 'BEST_REASONING',
    label: 'Reasoning',
    categories: [CATEGORY.REASONING],
    requires: ['chat'],
    latency: 'patient',
  },
  BEST_VISION: {
    id: 'BEST_VISION',
    label: 'Vision',
    categories: [CATEGORY.VISION, CATEGORY.MULTIMODAL],
    // Strict: only a probe-confirmed vision route qualifies (section 13)
    requires: ['vision'],
    strict: ['vision'],
    latency: 'balanced',
  },
  BEST_FAST: {
    id: 'BEST_FAST',
    label: 'Fast',
    categories: [CATEGORY.FAST],
    requires: ['chat'],
    latency: 'fast',
  },
  BEST_FREE: {
    id: 'BEST_FREE',
    label: 'Free',
    categories: [CATEGORY.FREE],
    requires: ['chat'],
    cost: COST.FREE,
    /*
     * Cost is a constraint the user set, not a quality dimension to trade off.
     * As a mere penalty it lost: the one verified route in the registry won
     * BEST_FREE on 64 points of evidence while not being free at all.
     */
    preferHard: (m) => m.free,
    preferHardNote: 'free routes',
    latency: 'balanced',
  },
  BEST_LONG_CONTEXT: {
    id: 'BEST_LONG_CONTEXT',
    label: 'Long context',
    categories: [CATEGORY.LONG_CONTEXT],
    requires: ['chat'],
    minContext: 200_000,
    // The window is the entire question for this class; a model whose window
    // nobody has stated is not an answer to it.
    preferHard: (m) => (m.context ?? 0) >= 200_000,
    preferHardNote: 'routes with a stated 200k+ window',
    latency: 'patient',
  },
  BEST_TOOL_AGENT: {
    id: 'BEST_TOOL_AGENT',
    label: 'Tool agent',
    categories: [CATEGORY.TOOL_AGENT, CATEGORY.CODING],
    requires: ['chat', 'tools'],
    prefers: ['tools'],
    latency: 'patient',
  },
  BEST_RESEARCH: {
    id: 'BEST_RESEARCH',
    label: 'Research',
    categories: [CATEGORY.RESEARCH, CATEGORY.LONG_CONTEXT, CATEGORY.REASONING],
    requires: ['chat'],
    latency: 'patient',
  },
  BEST_COST: {
    id: 'BEST_COST',
    label: 'Low cost',
    categories: [CATEGORY.CHEAP, CATEGORY.FREE, CATEGORY.FAST],
    requires: ['chat'],
    cost: COST.CHEAP,
    latency: 'fast',
  },
  BEST_FALLBACK: {
    id: 'BEST_FALLBACK',
    label: 'Fallback',
    categories: [CATEGORY.GENERAL_CHAT],
    requires: ['chat'],
    latency: 'balanced',
    /** Reliability matters more than brilliance for a last resort. */
    reliabilityBias: 2,
  },
})

export const TASK_IDS = Object.keys(TASK)

/** Latency budgets in ms. A model with no measurement is neither rewarded nor punished. */
const LATENCY_BUDGET = { fast: 3_000, balanced: 12_000, patient: 45_000 }

/* ---------- scoring ---------- */

/**
 * Scores one model for one task, returning both the number and the reasons.
 *
 * @returns {{ score: number, reasons: Array<{label: string, points: number}>, eligible: boolean, blockedBy: string|null }}
 */
export function scoreModel(model, task, { estimatedTokens = 0, requireTools = false, requireVision = false } = {}) {
  const reasons = []
  const add = (label, points) => {
    if (points !== 0) reasons.push({ label, points: Math.round(points * 10) / 10 })
  }

  /* --- hard requirements --- */

  const needed = new Set([...(task.requires ?? [])])
  if (requireTools) needed.add('tools')
  if (requireVision) needed.add('vision')

  for (const capability of needed) {
    const entry = model.capabilities?.[capability]
    if (!entry || entry.value === false) {
      return { score: -Infinity, reasons, eligible: false, blockedBy: `cannot ${capability}` }
    }
    // Strict capabilities demand a probe, not a plausible name
    if ((task.strict ?? []).includes(capability) && !(entry.value === true && entry.source === EVIDENCE.PROBE)) {
      return { score: -Infinity, reasons, eligible: false, blockedBy: `${capability} not verified` }
    }
  }

  if (model.health.fatal) {
    return { score: -Infinity, reasons, eligible: false, blockedBy: model.health.lastFailureKind ?? 'unavailable' }
  }
  if (model.verification === VERIFICATION.UNAVAILABLE) {
    return { score: -Infinity, reasons, eligible: false, blockedBy: 'not available' }
  }

  let score = 0

  /* --- capability match --- */

  for (const capability of needed) {
    const entry = model.capabilities[capability]
    if (entry.value === true && entry.source === EVIDENCE.PROBE) {
      score += WEIGHTS.CAPABILITY_PROVEN
      add(`${capability} confirmed by probe`, WEIGHTS.CAPABILITY_PROVEN)
    } else if (entry.value === true) {
      score += WEIGHTS.CAPABILITY_PROVEN / 2
      add(`${capability} declared by the gateway`, WEIGHTS.CAPABILITY_PROVEN / 2)
    } else {
      score += WEIGHTS.CAPABILITY_POSSIBLE
      add(`${capability} plausible but unverified`, WEIGHTS.CAPABILITY_POSSIBLE)
    }
  }

  for (const capability of task.prefers ?? []) {
    const entry = model.capabilities?.[capability]
    if (entry?.value === true) {
      score += WEIGHTS.TOOL_FIT / 2
      add(`supports ${capability}`, WEIGHTS.TOOL_FIT / 2)
    }
  }

  /* --- live verification (section 2) --- */

  if (model.verification === VERIFICATION.LIVE_VERIFIED) {
    score += WEIGHTS.VERIFY_LIVE
    add('a real request has succeeded on this route', WEIGHTS.VERIFY_LIVE)
  } else if (model.verification === VERIFICATION.MOCK_VERIFIED) {
    score += WEIGHTS.VERIFY_MOCK
    add('verified against a stub only', WEIGHTS.VERIFY_MOCK)
  }

  /* --- task suitability from categories (a hint) --- */

  const wanted = task.categories ?? []
  const matched = wanted.filter((c) => model.categories.includes(c))
  if (matched.length > 0) {
    // Diminishing: matching three category hints is not three times the evidence
    const points = WEIGHTS.CATEGORY_HINT * (1 + Math.log2(matched.length))
    score += points
    add(`catalogued as ${matched.join(', ').toLowerCase().replace(/_/g, ' ')}`, points)
  }

  /* --- published documentation (section 33) --- */

  const doc = docWeight(model.id)
  if (doc?.weight) {
    const relevant = (doc.categories ?? []).some((c) => wanted.includes(c))
    const points = Math.min(doc.weight * (relevant ? 1 : 0.5), WEIGHTS.DOC_MAX)
    if (points > 0) {
      score += points
      add('published documentation supports this family', points)
    }
  }

  /* --- health --- */

  switch (model.health.state) {
    case HEALTH.HEALTHY:
      score += WEIGHTS.HEALTH_HEALTHY
      add('route is healthy', WEIGHTS.HEALTH_HEALTHY)
      break
    case HEALTH.DEGRADED:
      score += WEIGHTS.HEALTH_DEGRADED
      add('route is degraded', WEIGHTS.HEALTH_DEGRADED)
      break
    case HEALTH.COOLDOWN:
    case HEALTH.RATE_LIMITED:
      score += WEIGHTS.HEALTH_COOLDOWN
      add(`route is cooling down (${model.health.lastFailureKind ?? 'recent failures'})`, WEIGHTS.HEALTH_COOLDOWN)
      break
    case HEALTH.INVALID:
    case HEALTH.UNREACHABLE:
      score += WEIGHTS.HEALTH_INVALID
      add('route is not usable', WEIGHTS.HEALTH_INVALID)
      break
    default:
      break // UNKNOWN: no evidence either way, so no adjustment
  }

  /* --- reliability --- */

  if (model.health.successRate !== null) {
    const bias = task.reliabilityBias ?? 1
    const points = (model.health.successRate - 0.5) * 2 * WEIGHTS.RELIABILITY * bias
    score += points
    add(`${Math.round(model.health.successRate * 100)}% of recent calls succeeded`, points)
  }
  if (model.health.consecutiveFailures > 0) {
    const points = WEIGHTS.RECENT_FAILURE * Math.min(model.health.consecutiveFailures, 3)
    score += points
    add(`${model.health.consecutiveFailures} recent consecutive failure(s)`, points)
  }

  /* --- context fit --- */

  const need = Math.max(estimatedTokens, task.minContext ?? 0)
  if (need > 0) {
    if (!model.context) {
      /*
       * An unknown context window is a real risk when the task depends on one:
       * the request simply fails at the provider. Without this, a verified model
       * whose window nobody has stated outranked a route that says 500k
       * outright — for the *long context* task, which is the one case where the
       * window is the whole question. Smaller than the known-too-small penalty,
       * because unknown is not the same as insufficient.
       */
      score += WEIGHTS.CONTEXT_UNKNOWN
      add('context window is not stated anywhere', WEIGHTS.CONTEXT_UNKNOWN)
    } else if (model.context >= need) {
      score += WEIGHTS.CONTEXT_FIT
      add(`${Math.round(model.context / 1000)}k context covers this task`, WEIGHTS.CONTEXT_FIT)
    } else {
      score += WEIGHTS.CONTEXT_SHORT
      add(`${Math.round(model.context / 1000)}k context is short for this task`, WEIGHTS.CONTEXT_SHORT)
    }
  }

  /* --- latency --- */

  const budget = LATENCY_BUDGET[task.latency ?? 'balanced']
  if (model.health.latencyMs !== null) {
    if (model.health.latencyMs <= budget) {
      const points = WEIGHTS.LATENCY_FIT * (1 - model.health.latencyMs / budget)
      score += points
      add(`responds in about ${(model.health.latencyMs / 1000).toFixed(1)}s`, points)
    } else {
      score += WEIGHTS.LATENCY_SLOW
      add(`slower than this task wants (${(model.health.latencyMs / 1000).toFixed(1)}s)`, WEIGHTS.LATENCY_SLOW)
    }
  }

  /* --- cost --- */

  if (task.cost === COST.FREE) {
    if (model.free) {
      score += WEIGHTS.COST_FREE_BONUS
      add('free tier', WEIGHTS.COST_FREE_BONUS)
    } else {
      score += WEIGHTS.COST_PENALTY
      add('not a free route', WEIGHTS.COST_PENALTY)
    }
  } else if (task.cost === COST.CHEAP) {
    if (model.cost === COST.PREMIUM) {
      score += WEIGHTS.COST_PENALTY
      add('premium tier when the task asked to be cheap', WEIGHTS.COST_PENALTY)
    } else if (model.free || model.cost === COST.CHEAP) {
      score += WEIGHTS.COST_FREE_BONUS / 2
      add('inexpensive route', WEIGHTS.COST_FREE_BONUS / 2)
    }
  }

  /* --- structural --- */

  if (model.configured) {
    score += WEIGHTS.CONFIGURED
    add('named in this server’s configuration', WEIGHTS.CONFIGURED)
  }
  if (model.routing) {
    score += WEIGHTS.ROUTING_ALIAS
    add('gateway-side routing alias, so the gateway picks a live upstream', WEIGHTS.ROUTING_ALIAS)
  }
  if (!model.inCatalogue) {
    score += WEIGHTS.NOT_CATALOGUED
    add('no longer listed in the catalogue', WEIGHTS.NOT_CATALOGUED)
  }
  if (model.supersededBy) {
    score += WEIGHTS.SUPERSEDED
    add(`superseded by ${model.supersededBy.modelId}`, WEIGHTS.SUPERSEDED)
  }
  /*
   * Only where the task wants deliberation. A reasoning control is worth
   * nothing to a request that wants an answer in two seconds.
   */
  if (model.reasoning?.supported && (task.latency === 'patient' || task.id === 'BEST_REASONING')) {
    score += WEIGHTS.REASONING_CONTROL
    add('supports a reasoning-effort control', WEIGHTS.REASONING_CONTROL)
  }

  // Only while nothing this session contradicts it
  if (model.priorFailure && model.health.successCount === 0) {
    const points = model.priorFailureFatal ? WEIGHTS.PRIOR_FAILURE_FATAL : WEIGHTS.PRIOR_FAILURE
    score += points
    add(`failed in an earlier session (${model.priorFailure})`, points)
  }

  return {
    score: Math.round(score * 10) / 10,
    reasons: reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    eligible: true,
    blockedBy: null,
  }
}

/* ---------- ranking ---------- */

/**
 * Whether a model could plausibly serve a request right now.
 *
 * Not "is it good" — only "is it not known to be broken". Used to decide
 * whether a hard preference is worth applying at all.
 */
const usable = (model) =>
  !model.health.fatal &&
  model.verification !== VERIFICATION.UNAVAILABLE &&
  !model.priorFailureFatal &&
  model.health.cooldownMs === 0

/**
 * Ranks the whole registry for one task.
 *
 * Ties break on id so the order is reproducible: the same registry state must
 * always produce the same ranking, or the "why this model" explanation stops
 * being reproducible too.
 */
export function rank(taskId, options = {}) {
  const task = TASK[taskId]
  if (!task) throw new Error(`unknown task class: ${taskId}`)

  /*
   * A soft-hard filter: applied only when something satisfies it.
   *
   * This is the difference between "prefer" and "require". Requiring outright
   * would make the class return nothing when the registry is thin; preferring
   * alone let a verified-but-unsuitable model win on evidence points. Filtering
   * when the field allows it, and degrading when it does not, is both honest
   * and useful.
   */
  let pool = options.pool ?? allModels()
  if (task.preferHard) {
    const matching = pool.filter(task.preferHard)
    /*
     * …and only when at least one of them could actually serve the request.
     *
     * `aug/*` is the only pool stating a 200k+ window on this deployment, and
     * the whole pool is down. Filtering to it regardless produced a chain that
     * spent four slots on doomed routes before reaching a working one. A hard
     * preference that only broken routes satisfy is not a useful preference.
     */
    if (matching.some(usable)) pool = matching
  }

  const scored = []

  for (const model of pool) {
    const result = scoreModel(model, task, options)
    if (!result.eligible) continue
    scored.push({
      id: model.id,
      displayName: model.displayName,
      provider: model.provider,
      family: model.family,
      score: result.score,
      reasons: result.reasons,
      verification: model.verification,
      health: model.health.state,
      free: model.free,
      cost: model.cost,
      context: model.context,
      routing: model.routing,
    })
  }

  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/** The winner for a task class, or null when nothing qualifies. */
export function best(taskId, options = {}) {
  return rank(taskId, options)[0] ?? null
}

/**
 * The eleven bests (section 8). Deliberately not "the best model".
 */
export function bests(options = {}) {
  const out = {}
  for (const id of TASK_IDS) out[id] = best(id, options)
  return out
}

/* ---------- quality tiers (section 7) ---------- */

/**
 * Tiers are recomputed from the current registry, never hardcoded.
 *
 * They are relative: a tier is a model's standing among what is available now.
 * Free routes are their own tier because comparing them on quality against paid
 * flagships tells the user nothing they can act on — the question a free tier
 * answers is "what is the best thing that costs nothing".
 */
export function qualityTiers(options = {}) {
  const ranked = rank('BEST_GENERAL', options)
  const tiers = new Map()

  const paid = ranked.filter((m) => !m.free)
  const free = ranked.filter((m) => m.free)

  for (const m of free) tiers.set(m.id, TIER.FREE)

  if (paid.length > 0) {
    const top = paid[0].score
    for (const m of paid) {
      const relative = top > 0 ? m.score / top : 0
      const verified = m.verification === VERIFICATION.LIVE_VERIFIED

      /*
       * The top two tiers require live verification.
       *
       * Without this the tiers are computed entirely from ids and published
       * documentation, and every plausible-sounding route lands in TIER_A
       * having never answered a request — which is section 32's failure exactly,
       * dressed up as a grade. An unverified model tops out at B: "looks right,
       * unproven". Verification is what moves it.
       */
      if (relative >= 0.9 && verified) tiers.set(m.id, TIER.S)
      else if (relative >= 0.75 && verified) tiers.set(m.id, TIER.A)
      else if (relative >= 0.55) tiers.set(m.id, TIER.B)
      else tiers.set(m.id, TIER.C)
    }
  }

  return tiers
}

/**
 * A one-sentence explanation safe to show a user (section 27).
 *
 * Says what was measured, never how the model was prompted or what any internal
 * reasoning was.
 */
export function explain(entry, taskLabel = 'this task') {
  if (!entry) return 'No model currently qualifies for this task.'
  const top = entry.reasons.filter((r) => r.points > 0).slice(0, 3).map((r) => r.label)
  const verified =
    entry.verification === VERIFICATION.LIVE_VERIFIED
      ? 'it is verified against a real request'
      : 'it has not been verified yet on this server'
  return `Selected for ${taskLabel} because ${verified}${top.length ? `, and ${top.join(', ')}` : ''}.`
}
