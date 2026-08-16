import { deflateSync } from 'node:zlib'
import { textWidth } from './metrics.mjs'

/* ============================================================
   PDF writer
   ----------
   Produces a real, standards-conformant PDF: object table, xref,
   trailer, base-14 fonts, WinAnsi text encoding, and a layout engine
   that wraps text and paginates.

   No dependency, because a PDF is a documented file format and the
   alternative was a 12 MB rendering stack for one feature.
   ============================================================ */

export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  a4landscape: { width: 841.89, height: 595.28 },
  slide: { width: 720, height: 540 }, // 4:3, for slide-style PDFs
  slide169: { width: 960, height: 540 },
}

/** Unicode → WinAnsi for the characters models actually emit. */
const WINANSI = new Map([
  [0x20ac, 128], [0x201a, 130], [0x0192, 131], [0x201e, 132], [0x2026, 133],
  [0x2020, 134], [0x2021, 135], [0x02c6, 136], [0x2030, 137], [0x0160, 138],
  [0x2039, 139], [0x0152, 140], [0x017d, 142], [0x2018, 145], [0x2019, 146],
  [0x201c, 147], [0x201d, 148], [0x2022, 149], [0x2013, 150], [0x2014, 151],
  [0x02dc, 152], [0x2122, 153], [0x0161, 154], [0x203a, 155], [0x0153, 156],
  [0x017e, 158], [0x0178, 159],
])

/** Characters with no WinAnsi glyph, mapped to something readable. */
const FALLBACK = new Map([
  [0x2192, '->'], [0x2190, '<-'], [0x21d2, '=>'], [0x2264, '<='], [0x2265, '>='],
  [0x2260, '!='], [0x00d7, 'x'], [0x2713, 'v'], [0x2717, 'x'], [0x2500, '-'],
  [0x25cf, '*'], [0x25aa, '*'], [0x00a0, ' '], [0x200b, ''], [0xfe0f, ''],
])

/**
 * Encodes a string as a PDF literal string in WinAnsiEncoding.
 * Parentheses and backslashes must be escaped or the stream is corrupt.
 */
function pdfString(text) {
  const bytes = []
  for (const char of String(text)) {
    const cp = char.codePointAt(0)
    let code
    if (cp < 0x80) code = cp
    else if (WINANSI.has(cp)) code = WINANSI.get(cp)
    else if (cp <= 0xff) code = cp // Latin-1 passes through
    else if (FALLBACK.has(cp)) {
      for (const c of FALLBACK.get(cp)) bytes.push(c.charCodeAt(0))
      continue
    } else code = 0x3f // '?'

    if (code === 0x28 || code === 0x29 || code === 0x5c) bytes.push(0x5c) // ( ) \
    bytes.push(code)
  }
  return Buffer.from(bytes).toString('latin1')
}

/** Strips characters that would not render, for width measurement. */
function normaliseForWidth(text) {
  let out = ''
  for (const char of String(text)) {
    const cp = char.codePointAt(0)
    if (cp < 0x80) out += char
    else if (FALLBACK.has(cp)) out += FALLBACK.get(cp)
    else out += 'x'
  }
  return out
}

/* ---------- word wrapping ---------- */

/**
 * Wraps text to a maximum width, breaking on spaces and, when a single word is
 * too long to fit at all, inside the word.
 */
export function wrapText(text, font, size, maxWidth) {
  const lines = []
  for (const rawLine of String(text).split('\n')) {
    const words = rawLine.trimStart().split(/ +/)
    // Leading indentation is meaningful (nested lists, quoted blocks) and would
    // otherwise be swallowed by the split on runs of spaces.
    const indent = rawLine.slice(0, rawLine.length - rawLine.trimStart().length).replace(/\t/g, '    ')
    let current = indent

    for (const word of words) {
      const candidate = current && current !== indent ? `${current} ${word}` : `${current}${word}`
      if (textWidth(normaliseForWidth(candidate), font, size) <= maxWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current)

      // A long unbroken token (a URL, a hash) still has to fit the page
      if (textWidth(normaliseForWidth(word), font, size) > maxWidth) {
        let chunk = ''
        for (const char of word) {
          if (textWidth(normaliseForWidth(chunk + char), font, size) > maxWidth && chunk) {
            lines.push(chunk)
            chunk = char
          } else {
            chunk += char
          }
        }
        current = chunk
      } else {
        current = word
      }
    }
    lines.push(current)
  }
  return lines
}

/**
 * Wraps monospaced text without altering a single space.
 *
 * Code indentation carries meaning, so the space-collapsing path in wrapText is
 * wrong for it. Courier advances 600/1000 em per glyph, so the column count is
 * exact and lines can be cut by character position.
 */
export function wrapMonospace(text, size, maxWidth) {
  const columns = Math.max(8, Math.floor(maxWidth / (size * 0.6)))
  const out = []

  for (const rawLine of String(text).split('\n')) {
    let line = rawLine
    if (line.length === 0) {
      out.push('')
      continue
    }
    while (line.length > columns) {
      // Prefer a space near the end of the run; never break inside a token
      // unless the token itself is wider than the page.
      const window = line.slice(0, columns + 1)
      let cut = window.lastIndexOf(' ')
      if (cut < Math.floor(columns * 0.55)) cut = columns
      out.push(line.slice(0, cut))
      // A continuation keeps the original indentation, so wrapped code still
      // reads as belonging to its block.
      const indent = rawLine.slice(0, rawLine.length - rawLine.trimStart().length)
      line = indent + line.slice(cut).trimStart()
      if (line.length <= indent.length) break
    }
    out.push(line)
  }
  return out
}

/* ---------- document ---------- */

const FONT_KEYS = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  'Helvetica-Oblique': 'F3',
  'Times-Roman': 'F4',
  'Times-Bold': 'F5',
  'Times-Italic': 'F6',
  Courier: 'F7',
  'Courier-Bold': 'F8',
}

export class PdfDocument {
  /**
   * @param {{ size?: keyof PAGE_SIZES, margin?: number, title?: string,
   *           author?: string, bodyFont?: string, bodySize?: number }} [options]
   */
  constructor(options = {}) {
    const page = PAGE_SIZES[options.size ?? 'a4'] ?? PAGE_SIZES.a4
    this.width = page.width
    this.height = page.height
    this.margin = options.margin ?? 56
    this.title = options.title ?? 'Document'
    this.author = options.author ?? 'PixGPT'
    this.bodyFont = options.bodyFont ?? 'Helvetica'
    this.boldFont = this.bodyFont.startsWith('Times') ? 'Times-Bold' : 'Helvetica-Bold'
    this.italicFont = this.bodyFont.startsWith('Times') ? 'Times-Italic' : 'Helvetica-Oblique'
    this.bodySize = options.bodySize ?? 11
    this.leading = 1.45

    /** @type {string[][]} one array of content-stream operators per page */
    this.pages = []
    this.ops = null
    this.y = 0
    this.pageNumbers = options.pageNumbers !== false
    this.addPage()
  }

  get contentWidth() {
    return this.width - this.margin * 2
  }

  addPage() {
    this.ops = []
    this.pages.push(this.ops)
    this.y = this.height - this.margin
    return this
  }

  /** Starts a new page when the next block would not fit. */
  ensure(height) {
    if (this.y - height < this.margin + (this.pageNumbers ? 24 : 0)) this.addPage()
    return this
  }

  /* --- primitives --- */

  text(content, { x = this.margin, y = this.y, font = this.bodyFont, size = this.bodySize, colour = [0, 0, 0] } = {}) {
    this.ops.push(
      'BT',
      `${colour[0]} ${colour[1]} ${colour[2]} rg`,
      `/${FONT_KEYS[font] ?? 'F1'} ${size} Tf`,
      `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
      `(${pdfString(content)}) Tj`,
      'ET',
    )
    return this
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.75 } = {}) {
    if (fill) this.ops.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`)
    if (stroke) this.ops.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`, `${lineWidth} w`)
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`)
    this.ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S')
    return this
  }

  line(x1, y1, x2, y2, { colour = [0.8, 0.8, 0.8], lineWidth = 0.75 } = {}) {
    this.ops.push(
      `${colour[0]} ${colour[1]} ${colour[2]} RG`,
      `${lineWidth} w`,
      `${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    )
    return this
  }

  /* --- blocks --- */

  /** A wrapped paragraph, paginating mid-block if it is long. */
  paragraph(content, { font = this.bodyFont, size = this.bodySize, colour = [0, 0, 0], indent = 0, spaceAfter = 6, align = 'left' } = {}) {
    const width = this.contentWidth - indent
    const lines = wrapText(content, font, size, width)
    const lineHeight = size * this.leading

    for (const line of lines) {
      this.ensure(lineHeight)
      let x = this.margin + indent
      if (align === 'center') x += (width - textWidth(normaliseForWidth(line), font, size)) / 2
      else if (align === 'right') x += width - textWidth(normaliseForWidth(line), font, size)
      this.text(line, { x, y: this.y - size, font, size, colour })
      this.y -= lineHeight
    }
    this.y -= spaceAfter
    return this
  }

  heading(content, level = 1) {
    const sizes = { 1: 22, 2: 16, 3: 13.5, 4: 12 }
    const size = sizes[level] ?? 12
    const lineHeight = size * 1.3
    // Keep a heading with at least one line of what follows
    this.ensure(lineHeight + this.bodySize * this.leading + 8)
    if (level <= 2) this.y -= level === 1 ? 6 : 10

    const lines = wrapText(content, this.boldFont, size, this.contentWidth)
    for (const line of lines) {
      this.ensure(lineHeight)
      this.text(line, { y: this.y - size, font: this.boldFont, size, colour: level === 1 ? [0.05, 0.05, 0.08] : [0.1, 0.1, 0.14] })
      this.y -= lineHeight
    }
    if (level === 1) {
      this.y -= 2
      this.line(this.margin, this.y, this.width - this.margin, this.y, { colour: [0.82, 0.82, 0.85] })
      this.y -= 10
    } else {
      this.y -= 5
    }
    return this
  }

  bullet(items, { ordered = false, indent = 0 } = {}) {
    const size = this.bodySize
    items.forEach((item, i) => {
      const marker = ordered ? `${i + 1}.` : '•'
      const markerWidth = ordered ? 20 : 14
      const textIndent = indent + markerWidth
      const lines = wrapText(item, this.bodyFont, size, this.contentWidth - textIndent)
      const lineHeight = size * this.leading

      lines.forEach((line, li) => {
        this.ensure(lineHeight)
        if (li === 0) this.text(marker, { x: this.margin + indent, y: this.y - size, size })
        this.text(line, { x: this.margin + textIndent, y: this.y - size, size })
        this.y -= lineHeight
      })
      this.y -= 2
    })
    this.y -= 4
    return this
  }

  /** A monospaced block on a tinted panel. */
  code(content, { language = '' } = {}) {
    const size = Math.min(this.bodySize - 0.5, 9.5)
    const lineHeight = size * 1.4
    const padding = 8
    const wrapped = wrapMonospace(
      String(content).replace(/\t/g, '    ').replace(/\n+$/, ''),
      size,
      this.contentWidth - padding * 2,
    )

    this.y -= 4
    let index = 0
    while (index < wrapped.length) {
      const available = Math.floor((this.y - this.margin - padding * 2 - (this.pageNumbers ? 24 : 0)) / lineHeight)
      if (available < 2) {
        this.addPage()
        continue
      }
      const chunk = wrapped.slice(index, index + available)
      const boxHeight = chunk.length * lineHeight + padding * 2
      this.rect(this.margin, this.y - boxHeight, this.contentWidth, boxHeight, {
        fill: [0.965, 0.968, 0.976],
        stroke: [0.886, 0.894, 0.91],
      })
      if (language && index === 0) {
        this.text(language, {
          x: this.width - this.margin - 6 - textWidth(language, 'Helvetica', 7),
          y: this.y - 10,
          size: 7,
          colour: [0.45, 0.45, 0.5],
        })
      }
      let ty = this.y - padding - size
      for (const line of chunk) {
        this.text(line, { x: this.margin + padding, y: ty, font: 'Courier', size, colour: [0.11, 0.13, 0.18] })
        ty -= lineHeight
      }
      this.y -= boxHeight + 6
      index += chunk.length
    }
    return this
  }

  /**
   * A table with a header row. Column widths are derived from the content, then
   * scaled to the page — a fixed split makes narrow columns waste half the page.
   */
  table(rows, { header = true } = {}) {
    if (!rows?.length) return this
    const size = Math.min(this.bodySize - 0.5, 9.5)
    const padding = 5
    const columns = Math.max(...rows.map((r) => r.length))
    const grid = rows.map((r) => Array.from({ length: columns }, (_, i) => String(r[i] ?? '')))

    // Natural width of each column, capped so one long cell cannot crowd out the rest
    const natural = Array.from({ length: columns }, (_, c) =>
      Math.min(
        Math.max(...grid.map((r) => textWidth(normaliseForWidth(r[c]), this.bodyFont, size))) + padding * 2,
        this.contentWidth * 0.55,
      ),
    )
    const total = natural.reduce((a, b) => a + b, 0)
    const widths = natural.map((w) => (w / total) * this.contentWidth)

    const rowHeight = (cells) => {
      const lines = cells.map((cell, c) => wrapText(cell, this.bodyFont, size, widths[c] - padding * 2).length)
      return Math.max(...lines, 1) * size * 1.35 + padding * 2
    }

    this.y -= 4
    grid.forEach((cells, rowIndex) => {
      const isHeader = header && rowIndex === 0
      const height = rowHeight(cells)
      if (this.y - height < this.margin + (this.pageNumbers ? 24 : 0)) {
        this.addPage()
        // Repeat the header on the new page so the columns stay readable
        if (header && rowIndex > 0) {
          const hh = rowHeight(grid[0])
          this.#tableRow(grid[0], widths, hh, size, padding, true)
        }
      }
      this.#tableRow(cells, widths, height, size, padding, isHeader)
    })
    this.y -= 8
    return this
  }

  #tableRow(cells, widths, height, size, padding, isHeader) {
    let x = this.margin
    cells.forEach((cell, c) => {
      this.rect(x, this.y - height, widths[c], height, {
        fill: isHeader ? [0.945, 0.949, 0.957] : null,
        stroke: [0.855, 0.867, 0.886],
        lineWidth: 0.5,
      })
      const lines = wrapText(cell, isHeader ? this.boldFont : this.bodyFont, size, widths[c] - padding * 2)
      let ty = this.y - padding - size
      for (const line of lines) {
        this.text(line, { x: x + padding, y: ty, font: isHeader ? this.boldFont : this.bodyFont, size })
        ty -= size * 1.35
      }
      x += widths[c]
    })
    this.y -= height
  }

  divider() {
    this.ensure(16)
    this.y -= 6
    this.line(this.margin, this.y, this.width - this.margin, this.y, { colour: [0.855, 0.867, 0.886] })
    this.y -= 10
    return this
  }

  spacer(height = 10) {
    this.y -= height
    return this
  }

  /** A cover-style title block. */
  titleBlock(title, subtitle, meta) {
    this.y -= 40
    this.paragraph(title, { font: this.boldFont, size: 28, spaceAfter: 10 })
    if (subtitle) this.paragraph(subtitle, { size: 13, colour: [0.35, 0.35, 0.4], spaceAfter: 8 })
    if (meta) this.paragraph(meta, { size: 9.5, colour: [0.5, 0.5, 0.55], spaceAfter: 14 })
    this.line(this.margin, this.y, this.width - this.margin, this.y, { colour: [0.82, 0.82, 0.85] })
    this.y -= 16
    return this
  }

  /* --- output --- */

  /** Stamps "n / total" on every page. Runs at save time, when the total is known. */
  #stampPageNumbers() {
    const total = this.pages.length
    this.pages.forEach((ops, index) => {
      const label = `${index + 1} / ${total}`
      const width = textWidth(label, 'Helvetica', 8.5)
      ops.push(
        'BT',
        '0.55 0.55 0.6 rg',
        '/F1 8.5 Tf',
        `1 0 0 1 ${(this.width - this.margin - width).toFixed(2)} ${(this.margin - 18).toFixed(2)} Tm`,
        `(${pdfString(label)}) Tj`,
        'ET',
      )
    })
  }

  /** Serialises the document. @returns {Buffer} */
  save() {
    if (this.pageNumbers) this.#stampPageNumbers()

    /** @type {(string|Buffer)[]} 1-indexed; objects[0] is unused */
    const objects = []
    const add = (body) => {
      objects.push(body)
      return objects.length // object number
    }

    // Fonts: the base 14 need no embedded file, only a descriptor
    const fontObjects = Object.entries(FONT_KEYS).map(([name, key]) => ({
      key,
      id: add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
    }))
    const fontDict = fontObjects.map((f) => `/${f.key} ${f.id} 0 R`).join(' ')

    const pagesId = add('') // reserved: needs the kid ids, filled in below
    const pageIds = []

    for (const ops of this.pages) {
      const stream = Buffer.from(ops.join('\n'), 'latin1')
      // Compressing the content stream typically cuts the file by 60–80%
      const compressed = deflateSync(stream)
      const contentId = add(
        Buffer.concat([
          Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
          compressed,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      )
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width.toFixed(2)} ${this.height.toFixed(2)}] ` +
            `/Resources << /Font << ${fontDict} >> >> /Contents ${contentId} 0 R >>`,
        ),
      )
    }

    objects[pagesId - 1] =
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`

    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
    const stamp = pdfDate(this.date ?? new Date(2024, 0, 1, 12, 0, 0))
    const infoId = add(
      `<< /Title (${pdfString(this.title)}) /Author (${pdfString(this.author)}) ` +
        `/Producer (PixGPT) /Creator (PixGPT) /CreationDate (${stamp}) /ModDate (${stamp}) >>`,
    )

    /* Assemble: header, body, xref, trailer */
    const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
    let offset = chunks[0].length
    const offsets = []

    objects.forEach((body, i) => {
      offsets.push(offset)
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1')
      const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
      const tail = Buffer.from('\nendobj\n', 'latin1')
      chunks.push(head, bodyBuf, tail)
      offset += head.length + bodyBuf.length + tail.length
    })

    const xrefStart = offset
    const xref = [
      `xref\n0 ${objects.length + 1}\n`,
      '0000000000 65535 f \n',
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    ].join('')
    chunks.push(Buffer.from(xref, 'latin1'))
    chunks.push(
      Buffer.from(
        `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
        'latin1',
      ),
    )

    return Buffer.concat(chunks)
  }
}

/** PDF date format: D:YYYYMMDDHHmmSS. */
export function pdfDate(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export { pdfString, normaliseForWidth }
