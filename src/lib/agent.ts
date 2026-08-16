/* ============================================================
   Build-mode client
   -----------------
   Talks to the existing /api/agent/* endpoints. No second agent
   backend — this is purely the browser side of the one that already
   works.
   ============================================================ */

export type AgentMode = 'chat' | 'build' | 'debug' | 'review' | 'research'

export interface PlanStep {
  title: string
  status: 'pending' | 'active' | 'done' | 'failed'
}

export interface AgentApproval {
  command: string
  program: string
  args: string[]
  risk: string
  reason: string
}

/** One rendered line in the activity log. */
export interface AgentActivity {
  id: string
  kind:
    | 'status'
    | 'analysis'
    | 'tool_call'
    | 'file_change'
    | 'command'
    | 'preview'
    | 'screenshot'
    | 'visual'
    | 'research'
    | 'test'
    | 'fix'
    | 'error'
  text: string
  detail?: string
  ok?: boolean
  url?: string
  /** Screenshot served from the task workspace. */
  image?: string
}

export interface AgentTaskState {
  taskId: string | null
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  objective: string
  plan: PlanStep[]
  activity: AgentActivity[]
  approval: AgentApproval | null
  changedFiles: Array<{ path: string; action: string }>
  summary: string | null
  verified: string[]
  knownIssues: string[]
  previewUrl: string | null
  downloadable: boolean
  durationMs: number | null
  error: string | null
}

export function emptyTask(objective = ''): AgentTaskState {
  return {
    taskId: null,
    status: 'idle',
    objective,
    plan: [],
    activity: [],
    approval: null,
    changedFiles: [],
    summary: null,
    verified: [],
    knownIssues: [],
    previewUrl: null,
    downloadable: false,
    durationMs: null,
    error: null,
  }
}

let seq = 0
const nextId = () => `a${++seq}`

/**
 * Folds one SSE event into task state.
 *
 * Unknown event types are ignored on purpose, so the server can add events
 * without breaking an older client.
 */
export function applyAgentEvent(state: AgentTaskState, event: Record<string, unknown>): AgentTaskState {
  const type = String(event.type ?? '')
  const push = (activity: Omit<AgentActivity, 'id'>): AgentTaskState => ({
    ...state,
    activity: [...state.activity, { id: nextId(), ...activity }].slice(-300),
  })

  switch (type) {
    case 'task':
      return { ...state, taskId: String(event.taskId ?? ''), status: 'running' }

    case 'plan':
      return { ...state, plan: (event.steps as PlanStep[]) ?? [] }

    case 'status':
      return push({ kind: 'status', text: String(event.message ?? ''), detail: String(event.phase ?? '') })

    case 'analysis':
      return push({ kind: 'analysis', text: String(event.text ?? '') })

    case 'tool_call': {
      const name = String(event.name ?? '')
      const args = (event.args ?? {}) as Record<string, unknown>
      const label = TOOL_LABELS[name] ?? name
      const detail = args.path ?? args.command ?? args.query ?? args.url ?? ''
      return push({ kind: 'tool_call', text: label, detail: String(detail) })
    }

    case 'file_change':
      return {
        ...push({
          kind: 'file_change',
          text: `${event.action ?? 'changed'} ${event.path ?? ''}`,
          detail: event.lines ? `${event.lines} lines` : undefined,
        }),
        changedFiles: [
          ...state.changedFiles.filter((f) => f.path !== event.path),
          { path: String(event.path ?? ''), action: String(event.action ?? 'changed') },
        ],
      }

    case 'command_result':
      return push({
        kind: 'command',
        text: String(event.command ?? ''),
        detail: event.ok ? `exit 0 · ${event.durationMs}ms` : `exit ${event.exitCode} · ${String(event.output ?? '').slice(-300)}`,
        ok: Boolean(event.ok),
      })

    case 'approval':
      return {
        ...state,
        approval: {
          command: String(event.command ?? ''),
          program: String(event.program ?? ''),
          args: (event.args as string[]) ?? [],
          risk: String(event.risk ?? ''),
          reason: String(event.reason ?? ''),
        },
      }

    case 'approval_resolved':
      return { ...state, approval: null }

    case 'preview_started':
      return push({ kind: 'preview', text: 'Starting preview server', detail: String(event.command ?? '') })

    case 'preview_ready':
      return {
        ...push({ kind: 'preview', text: 'Preview is running', url: String(event.url ?? ''), ok: true }),
        previewUrl: String(event.url ?? ''),
      }

    case 'preview_stopped':
      return { ...push({ kind: 'preview', text: 'Preview stopped' }), previewUrl: null }

    case 'browser_action':
      return push({ kind: 'tool_call', text: `Browser: ${event.action ?? ''}`, detail: String(event.detail ?? '') })

    case 'console_error':
      return push({ kind: 'error', text: 'Console error', detail: String(event.message ?? '') })

    case 'network_error':
      return push({ kind: 'error', text: 'Network error', detail: String(event.detail ?? '') })

    case 'screenshot':
      return push({
        kind: 'screenshot',
        text: String(event.label ?? 'Screenshot'),
        detail: String(event.viewport ?? ''),
        image: state.taskId ? `/api/agent/${state.taskId}/screenshot/${event.name}` : undefined,
      })

    case 'visual_analysis': {
      const measured = event.source === 'audit'
      const viewport = event.viewport ? ` · ${String(event.viewport)}` : ''
      return push({
        kind: 'visual',
        text: measured ? `Visual audit${viewport}` : `Visual review${viewport}`,
        detail: String(event.findings ?? ''),
        // A failed analysis is not a pass. Without this the row would show a tick
        // for a check that never actually ran.
        ok: event.failed ? false : event.issues === 0,
      })
    }

    case 'smoke_started':
      return push({ kind: 'test', text: 'Running the delivery check' })

    case 'smoke_step':
      return push({
        kind: 'test',
        text: `${String(event.name ?? 'step')}`,
        detail: String(event.detail ?? ''),
        ok: Boolean(event.ok),
      })

    case 'smoke_complete': {
      const next = push({
        kind: 'test',
        text: String(event.summary ?? (event.ok ? 'Delivery check passed' : 'Delivery check failed')),
        ok: Boolean(event.ok),
      })
      // A verified project is offered for download straight away
      return { ...next, downloadable: next.downloadable || Boolean(event.ok) }
    }

    case 'research':
      return push({ kind: 'research', text: `Researched: ${event.query ?? ''}`, detail: String(event.sources ?? '') })

    case 'test_complete':
      return push({ kind: 'test', text: String(event.summary ?? 'Tests finished'), ok: Boolean(event.ok) })

    case 'fix_started':
      return push({ kind: 'fix', text: `Fixing: ${event.issue ?? ''}` })

    case 'fix_complete':
      return push({ kind: 'fix', text: String(event.result ?? 'Fix applied'), ok: Boolean(event.ok) })

    case 'zip_ready':
      return { ...state, downloadable: true }

    case 'done': {
      const finished = (event.finished ?? null) as { summary?: string; verified?: string[]; knownIssues?: string[] } | null
      const plan = (event.plan as PlanStep[]) ?? state.plan

      /*
       * The agent does not always update its plan one last time before calling
       * finish, which leaves the final steps unticked on a build that actually
       * succeeded — and an unticked step reads as failed work.
       *
       * Reconciled only when the agent declared completion with no known issues:
       * that declaration is its own assertion that the objective is done. If it
       * reported problems, or the run errored, the plan is left exactly as it
       * was, because then the unticked steps are the truth.
       */
      const completedCleanly = Boolean(finished) && (finished?.knownIssues?.length ?? 0) === 0
      const reconciled = completedCleanly ? plan.map((step) => ({ ...step, status: 'done' as const })) : plan

      return {
        ...state,
        status: 'done',
        plan: reconciled,
        changedFiles: (event.changedFiles as AgentTaskState['changedFiles']) ?? state.changedFiles,
        summary: finished?.summary ?? null,
        verified: finished?.verified ?? [],
        knownIssues: finished?.knownIssues ?? [],
        downloadable: Boolean(event.downloadable) || state.downloadable,
        durationMs: Number(event.durationMs ?? 0),
        approval: null,
      }
    }

    case 'error':
      return {
        ...push({ kind: 'error', text: String(event.message ?? 'The task failed.') }),
        status: 'error',
        error: String(event.code ?? 'error'),
        approval: null,
      }

    default:
      return state
  }
}

const TOOL_LABELS: Record<string, string> = {
  list_files: 'Listing files',
  read_file: 'Reading',
  search_code: 'Searching code',
  write_file: 'Writing',
  edit_file: 'Editing',
  rename_file: 'Renaming',
  delete_file: 'Deleting',
  run_command: 'Running',
  report_plan: 'Updating plan',
  finish: 'Finishing up',
  start_preview: 'Starting preview',
  stop_preview: 'Stopping preview',
  browser_open: 'Opening page',
  browser_interact: 'Interacting with page',
  browser_screenshot: 'Taking screenshot',
  browser_inspect: 'Inspecting page',
  analyze_screenshot: 'Analysing screenshot',
  research_web: 'Researching',
  analyze_project: 'Analysing project',
}

/* ---------- transport ---------- */

/** Streams an agent run, folding each event through `onState`. */
export async function runAgentTask(
  { objective, model, taskId }: { objective: string; model?: string; taskId?: string },
  signal: AbortSignal,
  onState: (updater: (prev: AgentTaskState) => AgentTaskState) => void,
): Promise<void> {
  const response = await fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ objective, model, taskId }),
  })

  if (!response.ok || !response.body) {
    let message = 'The build task could not be started.'
    try {
      const data = (await response.json()) as { error?: { message?: string } }
      if (data.error?.message) message = data.error.message
    } catch {
      /* non-JSON */
    }
    onState((prev) => ({ ...prev, status: 'error', error: 'start_failed', activity: [...prev.activity, { id: nextId(), kind: 'error', text: message }] }))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          const event = JSON.parse(payload) as Record<string, unknown>
          onState((prev) => applyAgentEvent(prev, event))
        } catch {
          /* ignore a malformed frame */
        }
      }
    }
  }
}

export async function approveCommand(
  taskId: string,
  command: string,
  program: string,
  decision: 'once' | 'task' | 'deny',
): Promise<boolean> {
  const response = await fetch('/api/agent/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, command, program, decision }),
  })
  return response.ok
}

export function zipUrl(taskId: string): string {
  return `/api/agent/${taskId}/zip`
}

/** What the server reports back about an imported archive. */
export interface ProjectAnalysis {
  name?: string
  stack?: {
    language?: string
    frameworks?: string[]
    build?: string[]
    testing?: string[]
    database?: string[]
    packageManager?: string | null
  }
  commands?: {
    install?: string | null
    dev?: string | null
    build?: string | null
    test?: string | null
    lint?: string | null
    typecheck?: string | null
  }
  entryPoints?: Array<{ path: string; role: string }>
  routes?: Array<{ method: string; path: string; file: string }>
  stats?: { files: number; totalKb: number; topLevelDirectories?: Record<string, number> }
  tests?: { count: number; files: string[] }
}

export interface ImportedProject {
  taskId: string
  files: number
  bytes: number
  skipped: Array<{ name: string; reason: string }>
  skippedTotal: number
  stripped: string | null
  tree: string
  analysis?: ProjectAnalysis
}

/**
 * Uploads a source archive and returns the task it was imported into.
 *
 * The archive is sent as the raw request body rather than multipart: there is
 * exactly one file, and multipart parsing on the server would be a whole
 * parser to maintain for no benefit.
 */
export async function importProjectZip(file: File): Promise<ImportedProject> {
  const response = await fetch('/api/agent/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(data.error?.message ?? 'The project could not be imported.')
  }
  return (await response.json()) as ImportedProject
}
