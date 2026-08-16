import { log } from '../config.mjs'
import { getGateway } from '../gateway/index.mjs'
import { TASK, TASK_IDS, rank, best, explain } from './ranking.mjs'
import { getModel, allModels } from './registry.mjs'
import { VERIFICATION, CATEGORY } from './catalog.mjs'

/* ============================================================
   Task classification, selection and fallback chains
   --------------------------------------------------
   Sections 10, 15, 35, 36, 37, 38 and 39.

   Classification is pattern-based, not a model call. It runs on
   every request, so it has to be instant and free; and a wrong
   guess is cheap because ranking only reorders candidates that
   were all capable in the first place.

   The chain rule that matters most is section 15's last line:
   **never fall back to an incompatible capability.** A vision
   request that falls back to a text model does not degrade
   gracefully — it produces a confident answer about an image the
   model never saw.
   ============================================================ */

/* ---------- task classification (section 10) ---------- */

/**
 * Ordered rules. First match wins, so the specific ones come first.
 *
 * `notWhen` exists for the same reason it does in the skills catalogue: "generate
 * an image" contains the word image and has nothing to do with vision.
 */
const CLASSIFIERS = [
  {
    task: 'BEST_VISION',
    match: [
      /\b(look at|analyse|analyze|describe|read|inspect|examine)\b.{0,30}\b(image|screenshot|photo|picture|diagram|chart)\b/i,
      /\bwhat(\s+does|'?s)\b.{0,30}\b(image|screenshot|photo|picture)\b/i,
      /\b(this|that|the|attached|uploaded)\s+(image|screenshot|photo|picture)\b/i,
    ],
    notWhen: [/\b(generate|create|make|draw|render|produce)\b.{0,20}\b(image|picture|photo)\b/i],
  },
  {
    task: 'BEST_CODING',
    match: [
      /\b(build|write|create|scaffold|implement)\b.{0,40}\b(app|application|component|api|service|website|page|script|function|module|feature)\b/i,
      /\b(fix|debug|refactor|migrate|patch|repair)\b.{0,40}\b(bug|code|repo|repository|test|error|function|component|build)\b/i,
      /\b(react|typescript|javascript|python|rust|golang|node|css|sql)\b.{0,30}\b(code|error|bug|component|function)\b/i,
      /\bcode review\b|\bunit tests?\b|\bstack trace\b|\bcompile error\b/i,
    ],
  },
  {
    task: 'BEST_RESEARCH',
    match: [
      /\b(research|investigate|survey|compare|literature|sources?|citations?)\b/i,
      /\b(what|which|who|when)\b.{0,40}\b(latest|current|newest|recent|today|2\d{3})\b/i,
      /\bfind out\b|\blook up\b|\bsearch (the web|online)\b/i,
    ],
  },
  {
    task: 'BEST_REASONING',
    match: [
      /\b(solve|prove|derive|explain why|reason through|work out|think through)\b/i,
      /\b(complex|difficult|hard|tricky|subtle)\b.{0,30}\b(problem|question|issue|architecture|design|trade-?offs?)\b/i,
      /\b(architecture|trade-?offs?|design decision|algorithm)\b/i,
    ],
  },
  {
    task: 'BEST_LONG_CONTEXT',
    match: [/\b(whole|entire|full)\b.{0,20}\b(codebase|repository|repo|document|book|transcript)\b/i, /\bacross (the )?(whole|entire|all)\b/i],
  },
  {
    task: 'BEST_COST',
    match: [/\b(cheap|cheapest|free|no cost|low cost|budget)\b/i],
  },
  {
    task: 'BEST_FAST',
    match: [/\b(quick|quickly|fast|briefly|short|tldr|tl;dr|one[- ]liner|summarise|summarize)\b/i, /^(hi|hey|hello|yo|thanks|thank you|ok|okay)\b/i],
  },
]

/**
 * Classifies a request into a task class.
 *
 * @param {string} text        the user's message
 * @param {object} [context]
 * @param {string} [context.mode]        PixGPT mode: chat|build|debug|review|research
 * @param {boolean} [context.hasImages]  images attached to this turn
 * @param {boolean} [context.hasTools]   the caller passed a tools array
 * @param {number} [context.estimatedTokens]
 */
export function classifyTask(text, context = {}) {
  const input = String(text ?? '')

  /*
   * Attachments and mode beat wording. Someone can attach a screenshot and type
   * "thoughts?" — the word count says fast chat, the image says vision, and the
   * image is the fact.
   */
  if (context.hasImages) {
    return { task: 'BEST_VISION', reason: 'an image is attached', confidence: 'certain' }
  }
  if (context.mode === 'build' || context.mode === 'debug') {
    return { task: 'BEST_CODING', reason: `${context.mode} mode`, confidence: 'certain' }
  }
  if (context.mode === 'research') {
    return { task: 'BEST_RESEARCH', reason: 'research mode', confidence: 'certain' }
  }
  if (context.hasTools) {
    return { task: 'BEST_TOOL_AGENT', reason: 'the request supplies tools', confidence: 'certain' }
  }

  // A genuinely large request needs the context window regardless of wording
  if ((context.estimatedTokens ?? 0) > 150_000) {
    return { task: 'BEST_LONG_CONTEXT', reason: 'the conversation is very large', confidence: 'certain' }
  }

  for (const rule of CLASSIFIERS) {
    if (rule.notWhen?.some((p) => p.test(input))) continue
    const hit = rule.match.find((p) => p.test(input))
    if (hit) return { task: rule.task, reason: `matched ${describePattern(rule.task)}`, confidence: 'likely' }
  }

  return { task: 'BEST_GENERAL', reason: 'no specific signal', confidence: 'default' }
}

function describePattern(task) {
  return (TASK[task]?.label ?? task).toLowerCase() + ' wording'
}

/* ---------- alias resolution (section 9) ---------- */

/**
 * PixGPT's three user-facing aliases, mapped to task classes.
 *
 * `pixgpt-pro` deliberately has no fixed target: section 9 asks it to be the
 * best general / reasoning / coding route *depending on the task*, so it defers
 * to whatever the classifier decided.
 */
const ALIAS_TASKS = {
  'pixgpt-fast': (classified) => (classified === 'BEST_VISION' ? 'BEST_VISION' : 'BEST_FAST'),
  'pixgpt-vision': () => 'BEST_VISION',
  /*
   * BEST_VISION is in this list for a reason. Without it, "what is in this
   * screenshot" sent on `pixgpt-pro` fell through to BEST_GENERAL and was
   * routed to text-only models — a confident answer about an image nothing
   * had looked at. No alias may downgrade a vision request (section 39).
   */
  'pixgpt-pro': (classified) =>
    ['BEST_VISION', 'BEST_CODING', 'BEST_REASONING', 'BEST_RESEARCH', 'BEST_LONG_CONTEXT', 'BEST_TOOL_AGENT'].includes(
      classified,
    )
      ? classified
      : 'BEST_GENERAL',
}

export const ALIASES = Object.keys(ALIAS_TASKS)

export const isAlias = (model) => Object.prototype.hasOwnProperty.call(ALIAS_TASKS, model)

/* ---------- chain construction (section 15) ---------- */

/** How many models a chain may contain. Beyond this the user is just waiting. */
const CHAIN_LENGTH = Number.parseInt(process.env.PIXGPT_CHAIN_LENGTH ?? '', 10) || 4

/**
 * The fallback chain for one task.
 *
 * Diversity matters more than raw score after the first pick: four routes from
 * the same pool fail together when that pool has an outage, which is precisely
 * when the chain is needed. So each subsequent slot prefers a different provider.
 */
/**
 * How far below the leader a different-provider candidate may sit and still be
 * preferred over a stronger same-provider one.
 *
 * Diversity is a tiebreak, not an override. As an unconditional skip it did
 * real damage here: with `auto/*` the only working pool, every chain spent
 * slots two and three on `aug/*` and `tllm/*` — pools that are entirely dead —
 * because they happened to be different. A fallback that cannot work is not a
 * fallback.
 */
const DIVERSITY_FLOOR = 0.6

export function chainFor(taskId, options = {}) {
  const ranked = rank(taskId, options)
  if (ranked.length === 0) return []

  const chain = [ranked[0]]
  const providers = new Set([ranked[0].provider])
  const leader = ranked[0].score

  for (const entry of ranked.slice(1)) {
    if (chain.length >= (options.length ?? CHAIN_LENGTH)) break
    if (chain.some((c) => c.id === entry.id)) continue

    if (providers.has(entry.provider)) {
      // Yield to an unused provider only if that candidate is still competitive
      const better = ranked.find(
        (r) =>
          !providers.has(r.provider) &&
          !chain.some((c) => c.id === r.id) &&
          r.score >= Math.max(leader * DIVERSITY_FLOOR, entry.score * DIVERSITY_FLOOR),
      )
      if (better) continue
    }

    chain.push(entry)
    providers.add(entry.provider)
  }

  /*
   * Task-class fallback (section 15's tail): a coding chain ends on a strong
   * general model, because a general model that answers beats a coding model
   * that is down. Never applied to vision — see below.
   */
  const tail = TAIL_TASK[taskId]
  if (tail && chain.length < (options.length ?? CHAIN_LENGTH)) {
    for (const entry of rank(tail, options)) {
      if (chain.length >= (options.length ?? CHAIN_LENGTH)) break
      if (chain.some((c) => c.id === entry.id)) continue
      chain.push({ ...entry, viaTail: tail })
    }
  }

  return chain
}

/**
 * Where a chain may end when its own class runs out.
 *
 * `BEST_VISION` is absent on purpose and must stay absent. Vision has no
 * compatible fallback outside vision (section 39): the honest outcome when no
 * vision route works is "unavailable", not an answer from a model that cannot see.
 */
const TAIL_TASK = {
  BEST_CODING: 'BEST_REASONING',
  BEST_REASONING: 'BEST_GENERAL',
  BEST_TOOL_AGENT: 'BEST_CODING',
  BEST_RESEARCH: 'BEST_GENERAL',
  BEST_LONG_CONTEXT: 'BEST_GENERAL',
  BEST_FAST: 'BEST_GENERAL',
  BEST_FREE: 'BEST_COST',
  BEST_COST: 'BEST_GENERAL',
  BEST_GENERAL: 'BEST_FALLBACK',
}

/* ---------- selection (section 35) ---------- */

/**
 * Picks the model chain for a request.
 *
 * Steps 1–6 of section 35. Execution, validation and health updates are the
 * caller's (the gateway client's) job; this function only decides.
 *
 * @returns {{ task: string, taskLabel: string, reason: string, chain: string[],
 *             primary: string|null, why: string, entries: object[], degraded: boolean }}
 */
export function selectModels(requested, context = {}) {
  const { config } = getGateway()

  /*
   * A concrete model the user typed is honoured as the primary. Overriding it
   * would make the picker a lie. Ranking still supplies the *fallbacks*, so a
   * manual choice gets the same resilience as an automatic one.
   */
  if (requested && !isAlias(requested)) {
    const classified = classifyTask(context.text, context)
    const model = getModel(requested)
    const chain = [requested]
    for (const entry of chainFor(classified.task, context)) {
      if (chain.length >= CHAIN_LENGTH) break
      if (!chain.includes(entry.id)) chain.push(entry.id)
    }
    return {
      task: classified.task,
      taskLabel: TASK[classified.task]?.label ?? classified.task,
      reason: 'you chose this model',
      chain: context.requiresVision ? chain.filter((id) => visionSafe(id)) : chain,
      primary: requested,
      why: model
        ? `You selected ${model.displayName}. ${model.verified ? 'It is verified on this server.' : 'It has not been verified on this server yet.'}`
        : `You selected ${requested}.`,
      entries: [],
      manual: true,
      degraded: false,
    }
  }

  const classified = classifyTask(context.text, context)
  const aliasTask = requested ? ALIAS_TASKS[requested]?.(classified.task) : classified.task

  /*
   * A structural guard, deliberately independent of the alias table above.
   * An image is attached or it is not; no alias, wording or configuration may
   * turn that request into a text one. Belt and braces on purpose — this is the
   * failure mode with the worst consequence, because the wrong answer looks
   * exactly like a right one.
   */
  const taskId = context.requiresVision ? 'BEST_VISION' : (aliasTask ?? classified.task)
  const task = TASK[taskId]

  const options = {
    estimatedTokens: context.estimatedTokens ?? 0,
    requireTools: Boolean(context.hasTools),
    requireVision: Boolean(context.requiresVision),
  }

  let entries = chainFor(taskId, options)

  /*
   * Vision is the one class allowed to come back empty. Everything else falls
   * through to the general chain, because refusing to answer "hello" for want
   * of a category match would be absurd.
   */
  if (entries.length === 0 && taskId !== 'BEST_VISION') {
    entries = chainFor('BEST_FALLBACK', { ...options, requireTools: false })
  }

  if (entries.length === 0) {
    return {
      task: taskId,
      taskLabel: task?.label ?? taskId,
      reason: classified.reason,
      chain: [],
      primary: null,
      why:
        taskId === 'BEST_VISION'
          ? 'No vision-capable route has been verified on this server, so images cannot be analysed right now.'
          : 'No model currently qualifies for this request.',
      entries: [],
      degraded: true,
    }
  }

  const chain = entries.map((e) => e.id)

  /*
   * The configured alias joins the end of the chain if ranking did not already
   * choose it. Section 30: configuration is a preference the health system may
   * bypass — but it should never be discarded outright, because the operator
   * knows something about their deployment that the registry does not.
   */
  const configuredTarget = requested ? config.modelAliases?.[requested] : null
  if (configuredTarget && !chain.includes(configuredTarget) && (!options.requireVision || visionSafe(configuredTarget))) {
    chain.push(configuredTarget)
  }

  return {
    task: taskId,
    taskLabel: task?.label ?? taskId,
    reason: classified.reason,
    chain,
    primary: chain[0],
    why: explain(entries[0], (task?.label ?? taskId).toLowerCase()),
    entries,
    degraded: entries[0].verification !== VERIFICATION.LIVE_VERIFIED,
  }
}

/**
 * Whether a model may carry an image.
 *
 * Deliberately permissive about *unknown* and strict about *known-false*: a
 * route we have never tried is worth trying once, a route that has told us it
 * cannot see never is.
 */
function visionSafe(id) {
  const model = getModel(id)
  if (!model) return false
  return model.capabilities.vision?.value !== false
}

/* ---------- escalation (sections 37, 38) ---------- */

/** Cheap first, harder only on evidence. */
const ESCALATION = ['BEST_FAST', 'BEST_GENERAL', 'BEST_REASONING', 'BEST_CODING']

/**
 * The next task class up when a task turns out to be harder than it looked.
 *
 * Escalation is driven by *events* — a failed verification, a rejected patch, a
 * low-confidence answer — not by a guess made before the work started, because
 * guessing high is how every chat ends up on the most expensive route (section 38).
 */
export function escalate(currentTask, { reason } = {}) {
  const index = ESCALATION.indexOf(currentTask)
  if (index === -1) {
    // Classes outside the ladder escalate to reasoning once, then stop
    return currentTask === 'BEST_REASONING' ? null : { task: 'BEST_REASONING', reason: reason ?? 'escalated' }
  }
  const next = ESCALATION[index + 1]
  return next ? { task: next, reason: reason ?? 'escalated' } : null
}

/* ---------- continuity (section 36) ---------- */

/** @type {Map<string, { model: string, task: string, since: number, switches: object[] }>} */
const SESSIONS = new Map()

/**
 * Keeps one long task on one model.
 *
 * A coding agent that silently changes model between iterations produces work
 * in two different styles and loses whatever the first model had inferred.
 * Switching is allowed, but only for a reason, and the reason is recorded.
 */
export function sessionModel(sessionId, { task, chain, allowSwitch = false, reason } = {}) {
  if (!sessionId) return chain?.[0] ?? null

  const existing = SESSIONS.get(sessionId)
  if (existing && !allowSwitch) {
    const model = getModel(existing.model)
    // Continuity yields to health: staying on a dead route is not continuity
    if (!model || model.health.available) return existing.model
    log.info('session model switched: route unavailable', { sessionId, from: existing.model })
  }

  const next = chain?.find((id) => getModel(id)?.health.available !== false) ?? chain?.[0] ?? null
  if (!next) return existing?.model ?? null

  if (existing && existing.model !== next) {
    existing.switches.push({ from: existing.model, to: next, reason: reason ?? 'unavailable', at: new Date().toISOString() })
    existing.model = next
    existing.task = task ?? existing.task
  } else if (!existing) {
    SESSIONS.set(sessionId, { model: next, task, since: Date.now(), switches: [] })
  }
  return next
}

export function sessionState(sessionId) {
  const s = SESSIONS.get(sessionId)
  return s ? { ...s, switches: [...s.switches] } : null
}

export function endSession(sessionId) {
  SESSIONS.delete(sessionId)
}

export function resetSessions() {
  SESSIONS.clear()
}

/* ---------- recommendations for the UI (section 26) ---------- */

/**
 * The grouped view the picker shows instead of 121 flat rows.
 *
 * Every group is capped: the point of this endpoint is that a user sees five
 * good choices, not a longer list sorted differently.
 */
export function recommendations(context = {}) {
  const groups = []
  const seen = new Set()

  const classified = classifyTask(context.text, context)
  const forTask = best(classified.task, context)

  if (forTask) {
    groups.push({
      key: 'recommended',
      label: 'Recommended',
      note: `Best for ${(TASK[classified.task]?.label ?? '').toLowerCase()} work`,
      models: [{ ...forTask, why: explain(forTask, (TASK[classified.task]?.label ?? '').toLowerCase()), star: true }],
    })
    seen.add(forTask.id)
  }

  const GROUPS = [
    ['coding', 'Coding', 'BEST_CODING', 3],
    ['reasoning', 'Reasoning', 'BEST_REASONING', 3],
    ['vision', 'Vision', 'BEST_VISION', 2],
    ['fast', 'Fast', 'BEST_FAST', 3],
    ['free', 'Free', 'BEST_FREE', 3],
  ]

  for (const [key, label, taskId, limit] of GROUPS) {
    const ranked = rank(taskId, context).slice(0, limit)
    groups.push({
      key,
      label,
      note: taskId === 'BEST_VISION' && ranked.length === 0 ? 'No vision route is verified on this server.' : null,
      models: ranked.map((m, i) => ({
        ...m,
        star: i === 0,
        why: i === 0 ? explain(m, label.toLowerCase()) : null,
      })),
    })
  }

  return { task: classified.task, taskLabel: TASK[classified.task]?.label ?? classified.task, reason: classified.reason, groups }
}

/** Everything, for the "All models" tab. Grouped by provider so it stays readable. */
export function allGrouped() {
  const byProvider = new Map()
  for (const model of allModels()) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, [])
    byProvider.get(model.provider).push(model)
  }
  return [...byProvider.entries()]
    .map(([provider, models]) => ({
      provider,
      label: models[0].providerLabel,
      count: models.length,
      models: models.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
}

export { TASK, TASK_IDS, CATEGORY, CHAIN_LENGTH }
