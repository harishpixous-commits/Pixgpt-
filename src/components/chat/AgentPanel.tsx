import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  Download,
  ExternalLink,
  FileCode2,
  Loader2,
  Search,
  ShieldAlert,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { usePixGptStore } from '../../lib/store'
import { zipUrl, type AgentActivity } from '../../lib/agent'
import { cn } from '../../lib/utils'
import { Button } from '../ui/Button'

/* ============================================================
   Build-mode panel
   ----------------
   Renders the real agent SSE stream: the plan as a checklist, the
   activity log, an approval prompt, the live preview link and the
   download. Nothing here is simulated — every line comes from an
   event the server actually sent.
   ============================================================ */

const KIND_ICON: Record<AgentActivity['kind'], typeof Check> = {
  status: CircleDot,
  analysis: ChevronDown,
  tool_call: Loader2,
  file_change: FileCode2,
  command: TerminalSquare,
  preview: ExternalLink,
  screenshot: FileCode2,
  visual: Check,
  research: Search,
  test: Check,
  fix: AlertTriangle,
  error: AlertTriangle,
}

export function AgentPanel() {
  const agent = usePixGptStore((s) => s.agent)
  const resolveApproval = usePixGptStore((s) => s.resolveApproval)
  const stopBuild = usePixGptStore((s) => s.stopBuild)
  const [showLog, setShowLog] = useState(true)

  if (agent.status === 'idle' && agent.plan.length === 0) return null

  const running = agent.status === 'running'
  const doneSteps = agent.plan.filter((s) => s.status === 'done').length

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <div className="agent-head-text">
          <p className="agent-title">
            {running ? 'Building' : agent.status === 'error' ? 'Build failed' : agent.status === 'cancelled' ? 'Build stopped' : 'Build complete'}
          </p>
          <p className="agent-objective" title={agent.objective}>
            {agent.objective}
          </p>
        </div>
        {running ? (
          <button type="button" className="agent-stop" onClick={stopBuild} aria-label="Stop the build">
            <Square size={13} fill="currentColor" />
            Stop
          </button>
        ) : null}
      </div>

      {/* Plan checklist — completed steps are struck through */}
      {agent.plan.length > 0 ? (
        <ol className="agent-plan" aria-label="Build plan">
          {agent.plan.map((step, i) => (
            <li key={`${i}-${step.title}`} className={cn('agent-step', `agent-step-${step.status}`)}>
              <span className="agent-step-mark" aria-hidden="true">
                {step.status === 'done' ? (
                  <Check size={13} />
                ) : step.status === 'failed' ? (
                  <X size={13} />
                ) : step.status === 'active' ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <span className="agent-step-dot" />
                )}
              </span>
              <span className="agent-step-title">{step.title}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {agent.plan.length > 0 ? (
        <p className="agent-progress-line">
          {doneSteps} of {agent.plan.length} steps complete
          {agent.changedFiles.length > 0 ? ` · ${agent.changedFiles.length} files` : ''}
          {agent.durationMs ? ` · ${(agent.durationMs / 1000).toFixed(0)}s` : ''}
        </p>
      ) : null}

      {/* Approval — blocks the agent until answered */}
      <AnimatePresence>
        {agent.approval ? (
          <motion.div
            className="agent-approval"
            role="alertdialog"
            aria-label="Command approval required"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="agent-approval-head">
              <ShieldAlert size={15} />
              <span>Approval required</span>
              <span className={cn('agent-risk', `agent-risk-${agent.approval.risk.toLowerCase()}`)}>
                {agent.approval.risk.replace(/_/g, ' ').toLowerCase()}
              </span>
            </div>
            <code className="agent-approval-cmd">{agent.approval.command}</code>
            <p className="agent-approval-reason">{agent.approval.reason}</p>
            <div className="agent-approval-actions">
              <Button size="sm" variant="primary" onClick={() => void resolveApproval('once')}>
                Allow once
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void resolveApproval('task')}>
                Allow for task
              </Button>
              <Button size="sm" variant="danger" onClick={() => void resolveApproval('deny')}>
                Deny
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Live preview */}
      {agent.previewUrl ? (
        <a className="agent-preview" href={agent.previewUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={14} />
          Open live preview
          <span className="agent-preview-url">{agent.previewUrl}</span>
        </a>
      ) : null}

      {/* Activity log */}
      {agent.activity.length > 0 ? (
        <div className="agent-log-wrap">
          <button
            type="button"
            className="agent-log-toggle"
            onClick={() => setShowLog((v) => !v)}
            aria-expanded={showLog}
          >
            <ChevronDown size={13} className={showLog ? '' : 'chev-closed'} />
            Activity ({agent.activity.length})
          </button>
          {showLog ? (
            <ul className="agent-log">
              {agent.activity.slice(-60).map((item) => {
                const Icon = KIND_ICON[item.kind] ?? CircleDot
                return (
                  <li key={item.id} className={cn('agent-log-item', item.ok === false && 'agent-log-bad')}>
                    <Icon size={12} className="agent-log-icon" />
                    <span className="agent-log-text">
                      {item.text}
                      {item.detail ? <span className="agent-log-detail"> {item.detail}</span> : null}
                    </span>
                    {item.image ? (
                      <img className="agent-shot" src={item.image} alt={item.text} loading="lazy" />
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Result */}
      {agent.summary ? (
        <div className="agent-result">
          <p className="agent-result-summary">{agent.summary}</p>
          {agent.verified.length > 0 ? (
            <ul className="agent-verified">
              {agent.verified.map((v) => (
                <li key={v}>
                  <Check size={13} /> {v}
                </li>
              ))}
            </ul>
          ) : null}
          {agent.knownIssues.length > 0 ? (
            <ul className="agent-issues">
              {agent.knownIssues.map((v) => (
                <li key={v}>
                  <AlertTriangle size={13} /> {v}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {agent.taskId && agent.downloadable ? (
        <a className="agent-download" href={zipUrl(agent.taskId)} download>
          <Download size={15} />
          Download project ZIP
        </a>
      ) : null}
    </div>
  )
}
