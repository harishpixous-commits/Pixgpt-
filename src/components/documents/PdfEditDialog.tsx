import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Download, FileEdit, Loader2, Upload, X } from 'lucide-react'
import {
  downloadDocument,
  fileToDataUrl,
  formatBytes,
  inspectPdf,
  modifyPdf,
  type PdfInspection,
  type PdfModification,
} from '../../lib/documents'
import { Button, IconButton } from '../ui/Button'
import { useToast } from '../ui/toast-context'

interface PdfEditDialogProps {
  open: boolean
  onClose: () => void
  /** Pre-loaded PDF, when the user opened this from an attachment. */
  initialFile?: File | null
}

/**
 * Edits a region of an existing PDF from a plain-language instruction.
 *
 * The page text is read first and shown to the user, because knowing what the
 * document actually contains is what makes it possible to write an instruction
 * the model can act on.
 */
export function PdfEditDialog({ open, onClose, initialFile }: PdfEditDialogProps) {
  const { push } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [inspection, setInspection] = useState<PdfInspection | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState<'reading' | 'editing' | null>(null)
  const [result, setResult] = useState<PdfModification | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setFile(null)
      setDataUrl(null)
      setInspection(null)
      setInstruction('')
      setResult(null)
      setBusy(null)
      return
    }
    if (initialFile) void load(initialFile)
    // `load` is stable for the dialog's lifetime; re-running on it would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onClose])

  const load = async (chosen: File) => {
    if (chosen.type !== 'application/pdf' && !chosen.name.toLowerCase().endsWith('.pdf')) {
      push({ title: 'That is not a PDF', tone: 'error' })
      return
    }
    setBusy('reading')
    setFile(chosen)
    setResult(null)
    try {
      const url = await fileToDataUrl(chosen)
      setDataUrl(url)
      setInspection(await inspectPdf(url))
    } catch (error) {
      push({
        title: 'That PDF could not be read',
        description: error instanceof Error ? error.message : undefined,
        tone: 'error',
      })
      setFile(null)
      setDataUrl(null)
    } finally {
      setBusy(null)
    }
  }

  const apply = async () => {
    if (!dataUrl || !instruction.trim() || busy) return
    setBusy('editing')
    setResult(null)
    try {
      const modification = await modifyPdf({
        pdf: dataUrl,
        instruction: instruction.trim(),
        filename: file ? file.name.replace(/\.pdf$/i, '-edited.pdf') : 'edited.pdf',
      })
      setResult(modification)
      if (modification.applied === 0) {
        push({ title: 'No change was made', description: modification.explanation, tone: 'error' })
      } else {
        push({
          title: `${modification.applied} edit${modification.applied === 1 ? '' : 's'} applied`,
          description: modification.explanation,
          tone: 'success',
        })
      }
    } catch (error) {
      push({
        title: 'The PDF could not be edited',
        description: error instanceof Error ? error.message : undefined,
        tone: 'error',
      })
    } finally {
      setBusy(null)
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
            aria-labelledby="pdf-edit-title"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <header className="dialog-head">
              <h2 id="pdf-edit-title">
                <FileEdit size={17} aria-hidden="true" /> Edit a PDF
              </h2>
              <IconButton aria-label="Close" onClick={onClose} disabled={Boolean(busy)}>
                <X size={17} />
              </IconButton>
            </header>

            <div className="doc-dialog-body">
              {!file ? (
                <button type="button" className="doc-drop" onClick={() => fileRef.current?.click()}>
                  <Upload size={22} aria-hidden="true" />
                  <strong>Choose a PDF</strong>
                  <span>Its text is read so the change can be located</span>
                </button>
              ) : (
                <div className="doc-file-row">
                  <FileEdit size={16} aria-hidden="true" />
                  <div className="doc-file-info">
                    <strong>{file.name}</strong>
                    <span className="doc-result-meta">
                      {formatBytes(file.size)}
                      {inspection ? ` · ${inspection.pageCount} page${inspection.pageCount === 1 ? '' : 's'}` : ''}
                      {busy === 'reading' ? ' · reading…' : ''}
                    </span>
                  </div>
                  <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                    Change
                  </Button>
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => {
                  const chosen = e.target.files?.[0]
                  if (chosen) void load(chosen)
                  e.target.value = ''
                }}
              />

              {inspection ? (
                <details className="doc-pages">
                  <summary>What is in this PDF</summary>
                  <ul>
                    {inspection.pages.slice(0, 12).map((p) => (
                      <li key={p.page}>
                        <strong>Page {p.page}</strong>{' '}
                        <span className="doc-result-meta">
                          {p.width}×{p.height}pt · {p.characters} characters
                        </span>
                        <p>{p.excerpt.slice(0, 220) || '(no extractable text)'}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {file ? (
                <label className="doc-field">
                  <span className="doc-label">What should change?</span>
                  <textarea
                    className="doc-textarea"
                    rows={3}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Change the title on page 1 to “Final Report”, and black out the phone number"
                    disabled={Boolean(busy)}
                  />
                </label>
              ) : null}

              {result ? (
                <div className="doc-result" role="status">
                  <div className="doc-result-info">
                    <FileEdit size={18} aria-hidden="true" />
                    <div>
                      <strong>{result.filename}</strong>
                      <span className="doc-result-meta">
                        {result.applied} of {result.requested ?? result.applied} edit
                        {(result.requested ?? result.applied) === 1 ? '' : 's'} applied · {formatBytes(result.bytes)}
                      </span>
                    </div>
                  </div>
                  {result.applied > 0 ? (
                    <Button variant="primary" onClick={() => downloadDocument(result)}>
                      <Download size={15} aria-hidden="true" /> Download
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {result && result.report.some((r) => !r.ok) ? (
                <ul className="doc-errors">
                  {result.report
                    .filter((r) => !r.ok)
                    .slice(0, 5)
                    .map((r) => (
                      <li key={r.index}>
                        Edit {r.index + 1} on page {r.page}: {r.error}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>

            <footer className="dialog-actions doc-dialog-actions">
              <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}>
                {result ? 'Done' : 'Cancel'}
              </Button>
              <Button
                variant="primary"
                onClick={apply}
                disabled={Boolean(busy) || !dataUrl || instruction.trim().length === 0}
              >
                {busy === 'editing' ? (
                  <>
                    <Loader2 size={15} className="spin" aria-hidden="true" /> Editing…
                  </>
                ) : (
                  'Apply change'
                )}
              </Button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
