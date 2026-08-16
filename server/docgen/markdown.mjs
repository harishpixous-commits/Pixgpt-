/* ============================================================
   Markdown → block model
   ----------------------
   Models write markdown. PDF, DOCX and PPTX all need the same
   structure, so it is parsed once into a block list and each writer
   renders that.

   Deliberately a block parser, not a full CommonMark implementation:
   headings, paragraphs, lists, code, tables, quotes and rules are what
   documents are actually made of.
   ============================================================ */

/**
 * @typedef {{ type: 'heading', level: number, text: string }
 *   | { type: 'paragraph', text: string }
 *   | { type: 'list', ordered: boolean, items: string[] }
 *   | { type: 'code', language: string, text: string }
 *   | { type: 'table', rows: string[][] }
 *   | { type: 'quote', text: string }
 *   | { type: 'rule' }} Block
 */

/** Strips inline markdown to plain text, keeping the words intact. */
export function stripInline(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // links → text (url)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .trim()
}

/** Splits a markdown table row, tolerating missing outer pipes. */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let current = ''
  let escaped = false
  for (const char of trimmed) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells.map(stripInline)
}

const isTableDivider = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')

/**
 * Parses markdown into blocks.
 * @param {string} source
 * @returns {Block[]}
 */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  /** @type {Block[]} */
  const blocks = []
  let i = 0

  const flushParagraph = (buffer) => {
    if (buffer.length === 0) return
    blocks.push({ type: 'paragraph', text: stripInline(buffer.join(' ')) })
    buffer.length = 0
  }
  const paragraph = []

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code — taken verbatim, no inline processing
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#-]*)/)
    if (fence) {
      flushParagraph(paragraph)
      const marker = fence[1][0].repeat(3)
      const language = fence[2] ?? ''
      const body = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i])
        i++
      }
      i++ // closing fence
      blocks.push({ type: 'code', language, text: body.join('\n') })
      continue
    }

    if (/^\s*$/.test(line)) {
      flushParagraph(paragraph)
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph(paragraph)
      blocks.push({ type: 'heading', level: heading[1].length, text: stripInline(heading[2]) })
      i++
      continue
    }

    // Setext heading: text underlined with === or ---
    if (i + 1 < lines.length && paragraph.length === 0 && /^\s*(={3,}|-{3,})\s*$/.test(lines[i + 1]) && line.trim()) {
      blocks.push({ type: 'heading', level: lines[i + 1].includes('=') ? 1 : 2, text: stripInline(line) })
      i += 2
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph(paragraph)
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    // Table: a header row followed by a divider
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph(paragraph)
      const rows = [splitRow(line)]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', rows })
      continue
    }

    const bullet = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/)
    if (bullet) {
      flushParagraph(paragraph)
      const ordered = /\d/.test(bullet[2])
      const items = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/)
        if (m && /\d/.test(m[2]) === ordered) {
          // Nested items are flattened with their indentation kept, which the
          // writers turn back into a visual indent.
          const depth = Math.floor(m[1].length / 2)
          items.push('  '.repeat(Math.min(depth, 3)) + stripInline(m[3]))
          i++
        } else if (/^\s+\S/.test(lines[i]) && items.length > 0) {
          // A continuation line belongs to the previous item
          items[items.length - 1] += ` ${stripInline(lines[i])}`
          i++
        } else {
          break
        }
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    if (/^\s*>/.test(line)) {
      flushParagraph(paragraph)
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: stripInline(body.join(' ')) })
      continue
    }

    paragraph.push(line.trim())
    i++
  }
  flushParagraph(paragraph)
  return blocks
}

/**
 * Splits blocks into slides for a presentation: each level-1 or level-2 heading
 * starts a new slide and becomes its title.
 */
export function blocksToSlides(blocks) {
  const slides = []
  let current = null

  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      if (current) slides.push(current)
      current = { title: block.text, blocks: [] }
      continue
    }
    if (!current) current = { title: '', blocks: [] }
    current.blocks.push(block)
  }
  if (current) slides.push(current)

  // A deck with no headings at all still needs one slide
  return slides.length > 0 ? slides : [{ title: '', blocks }]
}

/** First heading in the document, for use as a title. */
export function documentTitle(blocks, fallback = 'Document') {
  const heading = blocks.find((b) => b.type === 'heading')
  if (heading) return heading.text
  const para = blocks.find((b) => b.type === 'paragraph')
  return para ? para.text.slice(0, 80) : fallback
}
