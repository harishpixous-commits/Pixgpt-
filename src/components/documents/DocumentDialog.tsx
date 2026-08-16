import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Download, FileText, Loader2, Presentation, Sparkles, X } from 'lucide-react'
import {
  DOC_FORMATS,
  composeDocument,
  downloadDocument,
  formatBytes,
  type DocFormat,
  type GeneratedDocument,
} from '../../lib/documents'
import { Button, IconButton } from '../ui/Button'
import { useToast } from '../ui/Toast'
import { cn } from '../../lib/utils'

interface DocumentDialogProps {
  open: boolean
  onClose: () => void
  /** Recent conversation text, offered to the model as reference material. */
  context?: string
}

const ICONS: Partial<Record<DocFormat, typeof FileText>> = {
  pptx: Presentation,
}

/**
 * Asks the model to write a document, then renders it to a real file.
 *
 * The prompt is deliberately the whole interface: the format decides the
 * structure the model is told to write, so a deck comes back as slides and a
 * report comes back as prose without the user configuring anything.
 */
export function DocumentDialog({ open, onClose, context }: DocumentDialogProps) {
  const { push } = useToast()
  const [prompt, setPrompt] = useState('')
  const [format, setFormat] = useState<DocFormat>('pdf')
  const [useContext, setUseContext] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GeneratedDocument | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      // Focus after the entry animation, or the caret lands mid-transition
      const timer = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(timer)
    }
    setResult(null)
    setBusy(false)
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [open])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onClose])

  const create = async () => {
    const text = prompt.trim()
    if (!text || busy) return

    setBusy(true)
    setResult(null)
    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const document_ = await composeDocument(
        { prompt: text, format, context: useContext ? context : undefined },
        controller.signal,
      )
      setResult(document_)
      push({
        title: `${document_.filename} is ready`,
        description: document_.pages ? `${document_.pages} page${document_.pages === 1 ? '' : 's'}` : undefined,
        tone: 'success',
      })
    } catch (error) {
      if (controller.signal.aborted) return
      push({
        title: 'The document could not be created',
        description: error instanceof Error ? error.message : undefined,
        tone: 'error',
      })
    } finally {
      setBusy(false)
      controllerRef.current = null
    }
  }

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
            aria-labelledby="doc-dialog-title"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <header className="dialog-head">
              <h2 id="doc-dialog-title">
                <Sparkles size={17} aria-hidden="true" /> Create a document
              </h2>
              <IconButton aria-label="Close" onClick={onClose} disabled={busy}>
                <X size={17} />
              </IconButton>
            </header>

            <div className="doc-dialog-body">
              <label className="doc-field">
                <span className="doc-label">What should it contain?</span>
                <textarea
                  ref={inputRef}
                  className="doc-textarea"
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="A one-page summary of our Q3 results, with a table of the key metrics"
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void create()
                    }
                  }}
                />
              </label>

              <fieldset className="doc-field doc-formats" disabled={busy}>
                <legend className="doc-label">Format</legend>
                <div className="doc-format-row" role="radiogroup" aria-label="Document format">
                  {DOC_FORMATS.map((f) => {
                    const Icon = ICONS[f.id] ?? FileText
                    return (
                      <button
                        key={f.id}
                        type="button"
                        role="radio"
                        aria-checked={format === f.id}
                        className={cn('doc-format', format === f.id && 'doc-format-active')}
                        onClick={() => setFormat(f.id)}
                        disabled={busy}
                      >
                        <Icon size={15} aria-hidden="true" />
                        {f.label}
                      </button>
                    )
                  })}
                </div>
              </fieldset>

              {context ? (
                <label className="doc-checkbox">
                  <input
                    type="checkbox"
                    checked={useContext}
                    onChange={(e) => setUseContext(e.target.checked)}
                    disabled={busy}
                  />
                  <span>Use this conversation as reference material</span>
                </label>
              ) : null}

              {result ? (
                <div className="doc-result" role="status">
                  <div className="doc-result-info">
                    <FileText size={18} aria-hidden="true" />
                    <div>
                      <strong>{result.filename}</strong>
                      <span className="doc-result-meta">
                        {formatBytes(result.bytes)}
                        {result.pages ? ` · ${result.pages} page${result.pages === 1 ? '' : 's'}` : ''}
                      </span>
                    </div>
                  </div>
                  <Button variant="primary" onClick={() => downloadDocument(result)}>
                    <Download size={15} aria-hidden="true" /> Download
                  </Button>
                </div>
              ) : null}
            </div>

            <footer className="dialog-actions doc-dialog-actions">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {result ? 'Done' : 'Cancel'}
              </Button>
              <Button variant="primary" onClick={create} disabled={busy || prompt.trim().length === 0}>
                {busy ? (
                  <>
                    <Loader2 size={15} className="spin" aria-hidden="true" /> Writing…
                  </>
                ) : result ? (
                  'Create another'
                ) : (
                  'Create'
                )}
              </Button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
