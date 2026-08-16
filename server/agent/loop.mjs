import { log } from '../config.mjs'
import { GatewayError } from '../gateway/errors.mjs'
import { getGateway } from '../gateway/index.mjs'
import { closeBrowser } from './browser.mjs'
import { agentSystemPrompt, coerceArgs, executeTool, toolDefinitions } from './tools.mjs'
import { projectTree } from './files.mjs'
import { getCodeMap, renderCodeMap } from './codemap.mjs'
import { compactTranscript, dropOrphanToolMessages } from './transcript.mjs'
import { detectRunner } from './preview.mjs'
import { workspaceSize } from './workspace.mjs'

/* ============================================================
   Agent loop
   ----------
       plan → act → observe → verify → continue

   A standard OpenAI tool-calling loop, with the guardrails that
   make it safe to run unattended:

     * hard iteration cap        — no infinite tool ping-pong
     * wall-clock budget         — no runaway task
     * workspace size cap        — no disk exhaustion
     * repeated-failure detector — stops flailing on the same error
     * every step emitted        — the user watches it happen

   Tool failures are fed back to the model as results, not thrown:
   an agent that cannot see its own errors cannot fix them.
   ============================================================ */

const MAX_ITERATIONS = Number.parseInt(process.env.AGENT_MAX_ITERATIONS ?? '', 10) || 40
const MAX_WALL_MS = Number.parseInt(process.env.AGENT_MAX_WALL_MS ?? '', 10) || 900_000
const MAX_WORKSPACE_BYTES = Number.parseInt(process.env.AGENT_MAX_WORKSPACE_BYTES ?? '', 10) || 300 * 1024 * 1024
const MAX_TOOL_RESULT_CHARS = 12_000
const MODEL_CALL_TIMEOUT_MS = Number.parseInt(process.env.AGENT_MODEL_TIMEOUT_MS ?? '', 10) || 180_000

/**
 * How much of the context the symbol map may occupy.
 *
 * Big enough to carry a real project's shape, small enough that it never
 * competes with the conversation for room. The renderer degrades to fit.
 */
const CODE_MAP_TOKEN_BUDGET = Number.parseInt(process.env.AGENT_CODEMAP_TOKENS ?? '', 10) || 2500

/**
 * How much context one agent turn may send.
 *
 * Deliberately below the smallest window in the fallback chain: a transcript
 * that only fits the primary model turns a routine fallback into a failed
 * request at the worst possible moment.
 */
const TRANSCRIPT_TOKEN_BUDGET = Number.parseInt(process.env.AGENT_CONTEXT_TOKENS ?? '', 10) || 60_000

/**
 * Keeps the transcript within budget.
 *
 * Previously this kept the system prompt and the last forty messages, which
 * loses the record of everything older — including which commands have already
 * been tried and failed. Compaction now simplifies old tool *results* first,
 * so `npm test → exit 1` survives even when its two thousand lines of output
 * do not. Dropping messages is the fallback, not the first move.
 */
function trimTranscript(messages) {
  const result = compactTranscript(messages, { tokenBudget: TRANSCRIPT_TOKEN_BUDGET })
  if (result.level !== 'none') {
    log.debug('transcript compacted', {
      level: result.level,
      before: result.before,
      after: result.after,
      simplified: result.simplified || undefined,
      dropped: result.dropped || undefined,
    })
  }
  return dropOrphanToolMessages(result.messages)
}

function compactResult(result) {
  const json = JSON.stringify(result)
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json
  return `${json.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated]`
}

/**
 * Runs one agent task to completion.
 *
 * `emit(event)` receives progress events shaped for the SSE stream:
 * plan | status | file_change | command | command_result | approval | token |
 * analysis | done | error
 */
export async function runAgent(options) {
  try {
    return await runAgentInner(options)
  } finally {
    /*
     * The browser is always closed: it holds a Chrome process and a throwaway
     * profile directory, and nothing after the run needs it.
     *
     * The preview is deliberately LEFT RUNNING — the user's whole point in
     * building something is to click the link and look at it. It is stopped
     * when the task is discarded, on explicit stop, or at shutdown.
     */
    await closeBrowser(options.taskId).catch(() => {})
  }
}

async function runAgentInner({ objective, projectDir, taskId, signal, emit, model, onApproval, maxIterations = MAX_ITERATIONS }) {
  const { client, id: gateway } = getGateway()
  const started = Date.now()

  const state = {
    plan: [],
    changedFiles: new Map(),
    commands: [],
    approvals: new Map(), // "prog args" -> true
    pendingApprovals: [],
    finished: null,
    iterations: 0,
    previewUrl: null,
    screenshots: [],
    smoke: null,
  }

  /**
   * Screenshots are held outside `state` because each carries a large base64
   * image. Keyed by name so the agent can analyse a specific one — it commonly
   * captures desktop and mobile before analysing either.
   */
  const screenshots = new Map()
  let lastScreenshot = null

  const approvalKey = (program, args) => `${program} ${(args ?? []).join(' ')}`.trim()

  const ctx = {
    projectDir,
    taskId,
    signal,
    /**
     * Approval is asked once and then *waited on*: the tool call parks until the
     * user decides. Skipping ahead would let the agent quietly proceed without
     * the thing it said it needed.
     */
    requestApprovalAndWait: async ({ program, args, risk, reason }) => {
      const key = approvalKey(program, args)
      const entry = { command: key, program, args, risk, reason }
      state.pendingApprovals.push(entry)
      emit({ type: 'approval', ...entry })
      if (!onApproval) return { approved: false, reason: 'No approval channel is available.' }
      return onApproval(entry)
    },
    onPlan: (steps) => {
      state.plan = steps
      emit({ type: 'plan', steps })
    },
    onCommand: (result) => {
      state.commands.push({ command: result.command, exitCode: result.exitCode, ok: result.ok, ms: result.durationMs })
      emit({
        type: 'command_result',
        command: result.command,
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        // Tail only: enough to see what happened without flooding the UI
        output: (result.stderr || result.stdout || '').slice(-1500),
      })
    },
    onFinish: (payload) => {
      state.finished = payload
    },
    emit,
    /*
     * Preview URL and last screenshot are task state, not tool arguments: the
     * agent takes a screenshot in one turn and analyses it in the next, so the
     * image has to outlive a single tool call. The data URL is held here rather
     * than passed through the transcript, which would blow the context window.
     */
    setPreview: (url) => {
      state.previewUrl = url
    },
    setLastScreenshot: (shot) => {
      state.screenshots.push({ name: shot.name, label: shot.label, viewport: shot.viewport })
      screenshots.set(shot.name, shot)
      // Bound the memory: only the recent ones can still be analysed
      if (screenshots.size > 12) screenshots.delete(screenshots.keys().next().value)
      lastScreenshot = shot
    },
    getLastScreenshot: () => lastScreenshot,
    getScreenshot: (name) =>
      screenshots.get(name) ??
      // Tolerate the label being given instead of the generated filename
      [...screenshots.values()].reverse().find((s) => s.label === name || s.name.includes(name)) ??
      null,
    setSmokeResult: (result) => {
      state.smoke = { ok: result.ok, summary: result.summary, warnings: result.warnings }
    },
  }

  const tree = projectTree(projectDir).tree

  /*
   * The symbol map, built once at the start of the task.
   *
   * A new project has nothing to map — the cost is a wasted scan and a heading
   * over an empty block — so it is only built when files already exist. On an
   * imported codebase it is the difference between the model knowing where
   * things are and finding out by opening files one at a time.
   *
   * Failure here must never stop a build: the tree alone is what the agent had
   * before this existed, and it is still enough to work with.
   */
  let codeMap = null
  try {
    const map = getCodeMap(projectDir)
    if (map.symbols > 0) {
      const rendered = renderCodeMap(map, { tokenBudget: CODE_MAP_TOKEN_BUDGET })
      codeMap = rendered.text
      log.info('code map built', {
        taskId,
        files: map.parsed,
        symbols: map.symbols,
        level: rendered.level,
        tokens: rendered.tokens,
        ms: map.ms,
      })
    }
  } catch (error) {
    log.warn('code map unavailable', { taskId, detail: error?.message })
  }

  const messages = [
    { role: 'system', content: agentSystemPrompt({ tree, objective, codeMap }) },
    { role: 'user', content: objective },
  ]

  const tools = toolDefinitions()
  let consecutiveFailures = 0
  /** The forced delivery check runs at most once per task. */
  let forcedSmoke = false
  let lastFailureSignature = ''

  /*
   * Delivery is gated on the smoke test, so the server runs it rather than
   * relying on the model to remember. Observed: the agent found and fixed two
   * real visual defects, re-verified them clean, then finished without running
   * the final check — the work was done but unproven.
   *
   * Returns true when the run must continue because the check failed. Only one
   * forced attempt: if it fails again the agent's own report stands, with the
   * failure recorded.
   */
  async function forceDeliveryCheck() {
    if (state.smoke || forcedSmoke) return false
    if (signal?.aborted) return false
    if (!detectRunner(projectDir)) return false

    forcedSmoke = true
    emit({ type: 'status', message: 'Running the delivery check before finishing', phase: 'verify' })

    const outcome = await executeTool(ctx, 'smoke_test', { skipInstall: false })
    const smoke = outcome.result
    if (smoke?.ok !== false) return false

    // Hand the failure back so the agent fixes it, rather than the user
    // downloading a project that does not work.
    state.finished = null
    messages.push({
      role: 'user',
      content: [
        'The delivery check was run automatically and it FAILED:',
        smoke.summary ?? '',
        ...(smoke.steps ?? [])
          .filter((step) => !step.ok && !step.advisory)
          .map((step) => `- ${step.name}: ${step.detail}`),
        '',
        'Fix the cause and then call finish again. Do not finish while this is failing.',
      ].join('\n'),
    })
    return true
  }

  emit({ type: 'status', message: 'Analysing the task', phase: 'analyze' })

  while (state.iterations < maxIterations) {
    if (signal?.aborted) {
      emit({ type: 'status', message: 'Cancelled', phase: 'cancelled' })
      return { ...summarise(state, started), cancelled: true }
    }
    if (Date.now() - started > MAX_WALL_MS) {
      emit({ type: 'status', message: 'Time budget reached', phase: 'stopped' })
      break
    }
    const size = workspaceSize(projectDir)
    if (size > MAX_WORKSPACE_BYTES) {
      emit({ type: 'error', code: 'workspace_full', message: 'The task workspace exceeded its size limit.' })
      break
    }

    state.iterations++

    let reply
    try {
      reply = await client.completion(
        {
          model,
          messages: trimTranscript(messages),
          tools,
          temperature: 0.2,
          // One agent turn may generate an entire file; a non-streaming reply
          // only arrives after generation completes.
          timeoutMs: MODEL_CALL_TIMEOUT_MS,
        },
        signal,
      )
    } catch (error) {
      const e = error instanceof GatewayError ? error : null
      // A transport hiccup should not kill a long task; a bad key should.
      if (e && e.retryable && consecutiveFailures < 2) {
        consecutiveFailures++
        emit({ type: 'status', message: `Model call failed (${e.code}); retrying`, phase: 'retry' })
        continue
      }
      emit({ type: 'error', code: e?.code ?? 'provider_error', message: e?.message ?? 'The model call failed.' })
      return { ...summarise(state, started), error: e?.code ?? 'provider_error' }
    }

    const toolCalls = reply.toolCalls ?? []

    // Narration between tool calls is useful context for the user
    if (reply.content?.trim()) {
      emit({ type: 'analysis', text: reply.content.trim().slice(0, 4000) })
      messages.push({ role: 'assistant', content: reply.content })
    }

    if (toolCalls.length === 0) {
      // No tools requested: the model is done talking. Treat as completion.
      if (!state.finished) state.finished = { summary: reply.content?.trim() || 'Task ended.', verified: [] }
      // Verify before accepting that, so a silent stop is still checked
      if (await forceDeliveryCheck()) continue
      break
    }

    messages.push({
      role: 'assistant',
      content: reply.content ?? '',
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    })

    for (const call of toolCalls) {
      if (signal?.aborted) break
      const name = call.function?.name ?? 'unknown'
      const argsRaw = call.function?.arguments ?? '{}'

      emit({ type: 'tool_call', name, args: summariseArgs(name, argsRaw) })

      const outcome = await executeTool(ctx, name, argsRaw)

      if (outcome.mutates && outcome.ok && outcome.result?.path) {
        state.changedFiles.set(outcome.result.path, outcome.result.action ?? 'changed')
        emit({ type: 'file_change', path: outcome.result.path, action: outcome.result.action, lines: outcome.result.lines })
      }

      // Detect flailing: the same tool failing the same way over and over
      if (!outcome.ok) {
        const signature = `${name}:${String(outcome.result?.error ?? outcome.result?.reason ?? '').slice(0, 80)}`
        consecutiveFailures = signature === lastFailureSignature ? consecutiveFailures + 1 : 1
        lastFailureSignature = signature
      } else {
        consecutiveFailures = 0
        lastFailureSignature = ''
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: compactResult(outcome.result),
      })
    }

    if (state.finished && (await forceDeliveryCheck())) continue

    if (state.finished) break

    if (consecutiveFailures >= 4) {
      emit({
        type: 'status',
        message: 'Stopping: the same step kept failing',
        phase: 'stuck',
      })
      break
    }
  }

  const result = summarise(state, started)
  log.info('agent run finished', {
    taskId,
    gateway,
    iterations: state.iterations,
    files: state.changedFiles.size,
    commands: state.commands.length,
    ms: result.durationMs,
    finished: Boolean(state.finished),
  })
  return result
}

function summarise(state, started) {
  return {
    plan: state.plan,
    changedFiles: [...state.changedFiles].map(([path, action]) => ({ path, action })),
    commands: state.commands,
    pendingApprovals: state.pendingApprovals,
    finished: state.finished,
    iterations: state.iterations,
    previewUrl: state.previewUrl,
    screenshots: state.screenshots,
    smoke: state.smoke,
    durationMs: Date.now() - started,
  }
}

/** Short, safe rendering of tool arguments for the progress stream. */
function summariseArgs(name, rawArgs) {
  let args
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs ?? {}
  } catch {
    return {}
  }
  switch (name) {
    case 'write_file':
    case 'read_file':
    case 'delete_file':
      return { path: args.path }
    case 'edit_file':
      return { path: args.path }
    case 'rename_file':
      return { from: args.from, to: args.to }
    case 'search_code':
      return { query: String(args.query ?? '').slice(0, 80) }
    case 'run_command':
      return { command: `${args.program ?? ''} ${coerceArgs(args.args).join(' ')}`.trim().slice(0, 160) }
    case 'list_files':
      return { path: args.path ?? '.' }
    case 'report_plan':
      return { steps: Array.isArray(args.steps) ? args.steps.length : 0 }
    default:
      return {}
  }
}
