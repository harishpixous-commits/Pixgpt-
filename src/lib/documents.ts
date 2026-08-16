/* ============================================================
   Document client
   ---------------
   Generating a file, and editing a PDF the user attached.

   Files are never inlined into a JSON reply: the server hands back an
   id and the browser downloads it with a plain GET, so the download
   works the way a download normally does.
   ============================================================ */

export type DocFormat = 'pdf' | 'docx' | 'pptx' | 'html' | 'md' | 'txt'

export interface DocFormatInfo {
  id: DocFormat
  label: string
  extension: string
}

export const DOC_FORMATS: DocFormatInfo[] = [
  { id: 'pdf', label: 'PDF', extension: 'pdf' },
  { id: 'docx', label: 'Word', extension: 'docx' },
  { id: 'pptx', label: 'PowerPoint', extension: 'pptx' },
  { id: 'html', label: 'Web page', extension: 'html' },
  { id: 'md', label: 'Markdown', extension: 'md' },
]

export interface GeneratedDocument {
  id: string
  filename: string
  mime: string
  bytes: number
  format: DocFormat
  title: string
  pages?: number
  /** Present when the model authored the content, so it can be shown or revised. */
  markdown?: string
  model?: string
}

export interface PdfPageInfo {
  page: number
  width: number
  height: number
  characters: number
  excerpt: string
}

export interface PdfInspection {
  pageCount: number
  pages: PdfPageInfo[]
  characters: number
  matches?: Array<{ page: number; line: number; text: string }>
}

export interface PdfModification extends GeneratedDocument {
  applied: number
  requested?: number
  pages: number
  explanation: string
  edits: unknown[]
  report: Array<{ index: number; page: number; ok: boolean; error?: string }>
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    /* fall through to the status-based message */
  }

  if (!response.ok) {
    const error = (payload as { error?: { message?: string } } | null)?.error
    throw new Error(error?.message ?? `That request failed (${response.status}).`)
  }
  return payload as T
}

/** The model writes the document, then it is rendered to the chosen format. */
export function composeDocument(
  input: { prompt: string; format: DocFormat; title?: string; subtitle?: string; context?: string },
  signal?: AbortSignal,
): Promise<GeneratedDocument> {
  return post<GeneratedDocument>('/api/documents/compose', input, signal)
}

/** Renders content that already exists — turning a chat reply into a file. */
export function generateDocument(
  input: { content: string; format: DocFormat; title?: string; subtitle?: string },
  signal?: AbortSignal,
): Promise<GeneratedDocument> {
  return post<GeneratedDocument>('/api/documents/generate', input, signal)
}

export function inspectPdf(pdf: string, find?: string, signal?: AbortSignal): Promise<PdfInspection> {
  return post<PdfInspection>('/api/documents/pdf/inspect', { pdf, find }, signal)
}

/** The model works out which regions to change from a plain-language instruction. */
export function modifyPdf(
  input: { pdf: string; instruction: string; filename?: string },
  signal?: AbortSignal,
): Promise<PdfModification> {
  return post<PdfModification>('/api/documents/pdf/modify', input, signal)
}

export function documentUrl(id: string): string {
  return `/api/documents/${id}`
}

/**
 * Starts a download.
 *
 * A real anchor click is used rather than `window.open`, so the
 * Content-Disposition filename is honoured and no popup blocker is involved.
 */
export function downloadDocument(document_: GeneratedDocument): void {
  const link = document.createElement('a')
  link.href = documentUrl(document_.id)
  link.download = document_.filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
}

/** Reads a File as a base64 data URL, which is what the PDF endpoints accept. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsDataURL(file)
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 104857.6) / 10} MB`
}
