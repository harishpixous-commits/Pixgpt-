import { GatewayError } from '../gateway/errors.mjs'
import { log } from '../config.mjs'
import { PdfDocument } from './pdf.mjs'
import { buildDocx } from './docx.mjs'
import { buildPptx } from './pptx.mjs'
import { blocksToSlides, documentTitle, parseMarkdown } from './markdown.mjs'
import { editPdf, extractPdfText, findText } from './pdfedit.mjs'

/* ============================================================
   Document generation
   -------------------
   One entry point: markdown in, a real .pdf / .docx / .pptx / .md /
   .html out. The model writes markdown — which it is good at — and the
   writers turn it into a properly laid-out document.
   ============================================================ */

export const FORMATS = {
  pdf: { extension: 'pdf', mime: 'application/pdf', label: 'PDF' },
  docx: {
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
  },
  pptx: {
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint presentation',
  },
  md: { extension: 'md', mime: 'text/markdown; charset=utf-8', label: 'Markdown' },
  html: { extension: 'html', mime: 'text/html; charset=utf-8', label: 'HTML' },
  txt: { extension: 'txt', mime: 'text/plain; charset=utf-8', label: 'Plain text' },
}

export const MAX_CONTENT_CHARS = 400_000

/** Aliases people and models actually use. */
const ALIASES = {
  word: 'docx', doc: 'docx', document: 'docx',
  powerpoint: 'pptx', ppt: 'pptx', slides: 'pptx', deck: 'pptx', presentation: 'pptx',
  markdown: 'md', text: 'txt', webpage: 'html', web: 'html',
}

export function normaliseFormat(value) {
  const key = String(value ?? 'pdf').trim().toLowerCase().replace(/^\./, '')
  const resolved = ALIASES[key] ?? key
  if (!(resolved in FORMATS)) {
    throw new GatewayError('bad_request', `Unsupported document format: ${key}. Use ${Object.keys(FORMATS).join(', ')}.`, {
      status: 400,
    })
  }
  return resolved
}

/** Drops control characters, which are illegal in filenames and in headers. */
function stripControlCharacters(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    out += code < 0x20 || code === 0x7f ? ' ' : text[i]
  }
  return out
}

/** A filename that is safe on every filesystem and in a Content-Disposition header. */
export function safeFilename(title, extension) {
  const base =
    stripControlCharacters(String(title ?? 'document'))
      // Characters Windows reserves, plus both path separators. The class needs
      // a doubled backslash to mean a literal one — `\|` would only escape the
      // pipe and let backslashes through into the filename.
      .replace(/[<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 70) || 'document'
  return `${base}.${extension}`
}

/* ---------- renderers ---------- */

function renderPdf(blocks, { title, subtitle, author, coverPage, pageSize, bodyFont }) {
  const doc = new PdfDocument({
    size: pageSize ?? 'a4',
    title,
    author,
    bodyFont: bodyFont ?? 'Helvetica',
  })

  if (coverPage !== false) {
    doc.titleBlock(title, subtitle, author ? `${author}` : '')
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        doc.heading(block.text, block.level)
        break
      case 'paragraph':
        doc.paragraph(block.text)
        break
      case 'list':
        doc.bullet(block.items, { ordered: block.ordered })
        break
      case 'code':
        doc.code(block.text, { language: block.language })
        break
      case 'table':
        doc.table(block.rows)
        break
      case 'quote':
        // Indented italic with a rule, the conventional rendering for a quote
        doc.paragraph(block.text, { font: doc.italicFont, indent: 20, colour: [0.28, 0.3, 0.34] })
        break
      case 'rule':
        doc.divider()
        break
      default:
        break
    }
  }
  return doc.save()
}

function renderHtml(blocks, { title, subtitle }) {
  const escape = (t) =>
    String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const body = blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `<h${block.level}>${escape(block.text)}</h${block.level}>`
        case 'paragraph':
          return `<p>${escape(block.text)}</p>`
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul'
          return `<${tag}>${block.items.map((i) => `<li>${escape(i.trimStart())}</li>`).join('')}</${tag}>`
        }
        case 'code':
          return `<pre><code>${escape(block.text)}</code></pre>`
        case 'table': {
          const [head, ...rest] = block.rows
          return (
            '<table><thead><tr>' +
            head.map((c) => `<th>${escape(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            rest.map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`).join('') +
            '</tbody></table>'
          )
        }
        case 'quote':
          return `<blockquote>${escape(block.text)}</blockquote>`
        case 'rule':
          return '<hr>'
        default:
          return ''
      }
    })
    .join('\n')

  return Buffer.from(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark }
  body { max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 2rem; margin: 0 0 .25rem; letter-spacing: -.02em }
  h2 { margin-top: 2.25rem; letter-spacing: -.01em }
  .subtitle { color: #667; font-size: 1.05rem; margin: 0 0 2rem }
  pre { background: #f5f6f8; padding: 1rem; border-radius: 8px; overflow-x: auto;
        border: 1px solid #e3e6ea; font-size: .875rem }
  code { font-family: ui-monospace, Consolas, monospace }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: .925rem }
  th, td { border: 1px solid #d7dbe0; padding: .5rem .7rem; text-align: left }
  th { background: #f1f3f6 }
  blockquote { margin: 1.25rem 0; padding: .1rem 0 .1rem 1rem;
               border-left: 3px solid #c9cdd4; color: #4a4f57; font-style: italic }
  hr { border: none; border-top: 1px solid #d7dbe0; margin: 2rem 0 }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #e7e9ec }
    pre { background: #1c1f24; border-color: #2b2f36 }
    th { background: #1c1f24 } th, td { border-color: #2b2f36 }
    .subtitle { color: #9aa0aa }
  }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
${subtitle ? `<p class="subtitle">${escape(subtitle)}</p>` : ''}
${body}
</body>
</html>`,
    'utf8',
  )
}

/* ---------- public API ---------- */

/**
 * Generates a document.
 *
 * @param {{ content: string, format?: string, title?: string, subtitle?: string,
 *           author?: string, coverPage?: boolean, pageSize?: string,
 *           bodyFont?: string, accent?: string }} request
 * @returns {{ buffer: Buffer, filename: string, mime: string, format: string,
 *             title: string, blocks: number, pages?: number }}
 */
export function generateDocument(request) {
  const format = normaliseFormat(request.format)
  const content = String(request.content ?? '')

  if (!content.trim()) {
    throw new GatewayError('bad_request', 'There is no content to put in the document.', { status: 400 })
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw new GatewayError('bad_request', 'That content is too long for one document.', { status: 400 })
  }

  const blocks = parseMarkdown(content)
  const title = String(request.title ?? '').trim() || documentTitle(blocks)
  const subtitle = String(request.subtitle ?? '').trim()
  const author = String(request.author ?? 'PixGPT').slice(0, 120)

  let buffer
  let pages

  switch (format) {
    case 'pdf': {
      buffer = renderPdf(blocks, { ...request, title, subtitle, author })
      // Count pages from what was actually laid out
      pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
      break
    }
    case 'docx':
      buffer = buildDocx({ blocks, title, subtitle, author, coverPage: request.coverPage !== false })
      break
    case 'pptx': {
      const sections = blocksToSlides(blocks).filter((s) => s.title || s.blocks.length > 0)
      /*
       * buildPptx always opens with a title slide. A document that starts
       * "# Title" would otherwise also produce a content slide with the same
       * heading and nothing under it, so that duplicate is dropped.
       */
      const slides = sections.filter(
        (s, index) => s.title && !(index === 0 && s.title === title && s.blocks.length === 0),
      )
      buffer = buildPptx({ slides, title, subtitle, author, accent: request.accent })
      pages = slides.length + 1
      break
    }
    case 'html':
      buffer = renderHtml(blocks, { title, subtitle })
      break
    case 'md':
      buffer = Buffer.from(content, 'utf8')
      break
    case 'txt':
      buffer = Buffer.from(
        blocks
          .map((b) => {
            if (b.type === 'heading') return `${b.text}\n${'='.repeat(Math.min(b.text.length, 60))}`
            if (b.type === 'list') return b.items.map((i) => `  - ${i.trimStart()}`).join('\n')
            if (b.type === 'table') return b.rows.map((r) => r.join('\t')).join('\n')
            if (b.type === 'rule') return '-'.repeat(60)
            return b.text ?? ''
          })
          .join('\n\n'),
        'utf8',
      )
      break
    default:
      throw new GatewayError('bad_request', `Unsupported format: ${format}`, { status: 400 })
  }

  log.info('document generated', { format, bytes: buffer.length, blocks: blocks.length, pages })

  return {
    buffer,
    filename: safeFilename(title, FORMATS[format].extension),
    mime: FORMATS[format].mime,
    format,
    title,
    blocks: blocks.length,
    ...(pages ? { pages } : {}),
  }
}

/**
 * The instruction given to the model when a user asks for a document. Getting a
 * clean markdown skeleton back is what makes the output look designed rather
 * than like a chat reply pasted into a page.
 */
export function documentAuthoringPrompt(format) {
  const shared = [
    'Write the document as Markdown. It will be converted into a real file, so structure matters.',
    '',
    'Rules:',
    '- Start with a single "# Title" line.',
    '- Use "## " for sections and "### " for subsections.',
    '- Use tables for anything comparative or numeric.',
    '- Use fenced code blocks with a language tag for code.',
    '- Write real content. No placeholders, no "TODO", no "[insert here]", no lorem ipsum.',
    '- Do not describe the document or explain what you are about to do. Output only the document.',
    '- Do not wrap the whole document in a code fence.',
  ]

  if (format === 'pptx') {
    return [
      ...shared,
      '',
      'This will become a slide deck:',
      '- Every "## " heading becomes one slide. Keep it to 8–12 slides unless asked otherwise.',
      '- Each slide gets 3–6 short bullets. One idea per bullet, no paragraphs.',
      '- Bullets should be phrases, not sentences that run to two lines.',
    ].join('\n')
  }
  if (format === 'pdf' || format === 'docx') {
    return [
      ...shared,
      '',
      'This will become a formal document:',
      '- Open with a short summary paragraph before the first "## " section.',
      '- Write in full prose. Use lists where a list is genuinely clearer.',
    ].join('\n')
  }
  return shared.join('\n')
}

export { editPdf, extractPdfText, findText, parseMarkdown, documentTitle }
