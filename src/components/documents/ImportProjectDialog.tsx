import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FileArchive, Loader2, Upload, X } from 'lucide-react'
import { importProjectZip, type ImportedProject } from '../../lib/agent'
import { formatBytes } from '../../lib/documents'
import { Button, IconButton } from '../ui/Button'
import { useToast } from '../ui/toast-context'

interface ImportProjectDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the new task id once the import succeeds. */
  onImported: (taskId: string, objective: string) => void
}

/**
 * Imports a source ZIP so the agent can work on an existing codebase.
 *
 * What was skipped is shown rather than hidden: an archive that quietly lost
 * its `.env` or had an entry rejected is something the user needs to know
 * about before asking for changes.
 */
export function ImportProjectDialog({ open, onClose, onImported }: ImportProjectDialogProps) {
  const { push } = useToast()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportedProject | null>(null)
  const [objective, setObjective] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) return
    setResult(null)
    setObjective('')
    setBusy(false)
    setDragging(false)
  }, [open])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onClose])

  const upload = async (file: File) => {
    const isZip = file.type === 'application/zip' || /\.zip$/i.test(file.name)
    if (!isZip) {
      push({ title: 'That is not a ZIP archive', description: file.name, tone: 'error' })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const imported = await importProjectZip(file)
      setResult(imported)
      push({
        title: `${imported.files} file${imported.files === 1 ? '' : 's'} imported`,
        description: imported.analysis?.stack?.frameworks?.length
          ? imported.analysis.stack.frameworks.join(', ')
          : (imported.analysis?.stack?.language ?? undefined),
        tone: 'success',
      })
    } catch (error) {
      push({
        title: 'That project could not be imported',
        description: error instanceof Error ? error.message : undefined,
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const stack = result?.analysis?.stack
  const commands = result?.analysis?.commands

  return (
    <AnimatePresence>
      {open && (
        <div className="dialog-root">
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => !busy && onClose()}
          />
          <motion.div
            className="dialog doc-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <header className="dialog-head">
              <h2 id="import-title">
                <FileArchive size={17} aria-hidden="true" /> Import a project
              </h2>
              <IconButton aria-label="Close" onClick={onClose} disabled={busy}>
                <X size={17} />
              </IconButton>
            </header>

            <div className="doc-dialog-body">
              {!result ? (
                <button
                  type="button"
                  className={`doc-drop${dragging ? ' doc-drop-over' : ''}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    const file = e.dataTransfer.files?.[0]
                    if (file) void upload(file)
                  }}
                  disabled={busy}
                >
                  {busy ? <Loader2 size={22} className="spin" aria-hidden="true" /> : <Upload size={22} aria-hidden="true" />}
                  <strong>{busy ? 'Importing…' : 'Choose or drop a .zip'}</strong>
                  <span>
                    {busy
                      ? 'Reading the archive and analysing the code'
                      : 'node_modules, build output and secrets are left out'}
                  </span>
                </button>
              ) : (
                <>
                  <div className="doc-result" role="status">
                    <div className="doc-result-info">
                      <FileArchive size={18} aria-hidden="true" />
                      <div>
                        <strong>
                          {result.files} file{result.files === 1 ? '' : 's'} · {formatBytes(result.bytes)}
                        </strong>
                        <span className="doc-result-meta">
                          {[stack?.language, ...(stack?.frameworks ?? []).slice(0, 3)].filter(Boolean).join(' · ') ||
                            'stack not identified'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {commands ? (
                    <dl className="import-facts">
                      {commands.install ? (
                        <>
                          <dt>Install</dt>
                          <dd>
                            <code>{commands.install}</code>
                          </dd>
                        </>
                      ) : null}
                      {commands.dev ? (
                        <>
                          <dt>Run</dt>
                          <dd>
                            <code>{commands.dev}</code>
                          </dd>
                        </>
                      ) : null}
                      {commands.test ? (
                        <>
                          <dt>Test</dt>
                          <dd>
                            <code>{commands.test}</code>
                          </dd>
                        </>
                      ) : null}
                      {result.analysis?.routes?.length ? (
                        <>
                          <dt>Routes</dt>
                          <dd>{result.analysis.routes.length} found</dd>
                        </>
                      ) : null}
                    </dl>
                  ) : null}

                  {result.skipped.length > 0 ? (
                    <details className="doc-pages">
                      <summary>
                        {result.skippedTotal} entr{result.skippedTotal === 1 ? 'y was' : 'ies were'} skipped
                      </summary>
                      <ul className="import-skipped">
                        {result.skipped.slice(0, 25).map((s) => (
                          <li key={s.name}>
                            <code>{s.name}</code> — {s.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  <label className="doc-field">
                    <span className="doc-label">What should be done to it?</span>
                    <textarea
                      className="doc-textarea"
                      rows={3}
                      value={objective}
                      onChange={(e) => setObjective(e.target.value)}
                      placeholder="Fix the failing build and make the header responsive on mobile"
                    />
                  </label>
                </>
              )}

              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void upload(file)
                  e.target.value = ''
                }}
              />
            </div>

            <footer className="dialog-actions doc-dialog-actions">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!result || busy || objective.trim().length === 0}
                onClick={() => {
                  if (!result) return
                  onImported(result.taskId, objective.trim())
                  onClose()
                }}
              >
                Start working
              </Button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
