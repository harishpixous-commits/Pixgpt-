import { deflateSync } from 'node:zlib'
import { PdfFile, PdfParseError, decodeStream, dictGet, dictSet, refArray, refNumber } from './pdfparse.mjs'
import { pdfString } from './pdf.mjs'
import { textWidth } from './metrics.mjs'
import { wrapText } from './pdf.mjs'

/* ============================================================
   PDF editing
   -----------
   Modifies a region of an existing PDF: cover it, replace the text in
   it, highlight it, or stamp something onto it.

   The document is parsed into its objects, the target page's content is
   extended with an overlay stream, and the whole file is written out
   fresh with a new xref. A full rewrite rather than an incremental
   update, because incrementally appending to a file that uses xref
   streams means emitting a hybrid table that some readers mishandle —
   and a rewrite is always valid.

   Original page content is never discarded: the overlay is appended
   after it, so what was there still draws underneath.
   ============================================================ */

/** Fonts the overlay can use, added to the page's resources on demand. */
const OVERLAY_FONTS = {
  Helvetica: 'PXH',
  'Helvetica-Bold': 'PXHB',
  'Helvetica-Oblique': 'PXHO',
  'Times-Roman': 'PXT',
  'Times-Bold': 'PXTB',
  Courier: 'PXC',
}

function bad(message) {
  return new PdfParseError(message)
}

/** Normalises a colour to PDF's 0–1 triple. Accepts #rrggbb, [r,g,b], or a name. */
function colour(value, fallback = [1, 1, 1]) {
  if (Array.isArray(value) && value.length === 3) {
    return value.map((v) => Math.min(1, Math.max(0, v > 1 ? v / 255 : v)))
  }
  if (typeof value === 'string') {
    const named = {
      white: [1, 1, 1], black: [0, 0, 0], red: [0.86, 0.15, 0.15],
      green: [0.13, 0.6, 0.28], blue: [0.13, 0.35, 0.85], yellow: [1, 0.93, 0.35],
      grey: [0.6, 0.6, 0.6], gray: [0.6, 0.6, 0.6],
    }
    const key = value.trim().toLowerCase()
    if (named[key]) return named[key]
    const hex = /^#?([0-9a-f]{6})$/i.exec(key)
    if (hex) {
      const n = Number.parseInt(hex[1], 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }
  }
  return fallback
}

/**
 * Resolves a region on a page.
 *
 * Accepts PDF points (origin bottom-left) or, with `units: 'fraction'`,
 * proportions of the page with the origin at the TOP-LEFT — which is how a
 * person describes "the top right corner" and how a vision model reports a
 * bounding box.
 */
export function resolveRegion(region, box) {
  const units = region.units ?? (isFraction(region) ? 'fraction' : 'points')

  if (units === 'fraction') {
    const w = (region.width ?? 0) * box.width
    const h = (region.height ?? 0) * box.height
    const x = box.x + (region.x ?? 0) * box.width
    // Flip: fractional y is measured from the top, PDF y from the bottom
    const y = box.y + box.height - (region.y ?? 0) * box.height - h
    return { x, y, width: w, height: h }
  }

  const height = region.height ?? 0
  // `fromTop` lets a caller give points measured from the top edge
  const y = region.fromTop ? box.y + box.height - (region.y ?? 0) - height : (region.y ?? 0)
  return { x: region.x ?? 0, y, width: region.width ?? 0, height }
}

const isFraction = (region) =>
  ['x', 'y', 'width', 'height'].every((k) => region[k] === undefined || (region[k] >= 0 && region[k] <= 1)) &&
  (region.width ?? 0) <= 1 &&
  (region.height ?? 0) <= 1

/* ---------- overlay building ---------- */

/**
 * Builds the content-stream operators for one edit.
 * @returns {{ ops: string[], fonts: Set<string> }}
 */
function buildEdit(edit, box) {
  const ops = []
  const fonts = new Set()
  const rect = resolveRegion(edit.region ?? {}, box)

  if (rect.width <= 0 || rect.height <= 0) {
    throw bad('The region has no width or height.')
  }

  const action = edit.action ?? 'replace_text'

  /* Cover the region. For a redaction or a text replacement the old content has
     to be hidden; for a highlight it must stay visible, so the fill is drawn
     with multiply blending instead. */
  if (action === 'cover' || action === 'redact' || action === 'replace_text') {
    const fill = colour(edit.fill ?? (action === 'redact' ? 'black' : 'white'))
    ops.push(
      'q',
      `${fill[0]} ${fill[1]} ${fill[2]} rg`,
      `${rect.x.toFixed(2)} ${rect.y.toFixed(2)} ${rect.width.toFixed(2)} ${rect.height.toFixed(2)} re f`,
      'Q',
    )
  } else if (action === 'highlight') {
    const fill = colour(edit.fill ?? 'yellow')
    ops.push(
      'q',
      // /GSH is a graphics state with Multiply blending, added to resources below
      '/GSH gs',
      `${fill[0]} ${fill[1]} ${fill[2]} rg`,
      `${rect.x.toFixed(2)} ${rect.y.toFixed(2)} ${rect.width.toFixed(2)} ${rect.height.toFixed(2)} re f`,
      'Q',
    )
  } else if (action === 'box') {
    const stroke = colour(edit.stroke ?? 'red', [0.86, 0.15, 0.15])
    ops.push(
      'q',
      `${stroke[0]} ${stroke[1]} ${stroke[2]} RG`,
      `${(edit.lineWidth ?? 1.5).toFixed(2)} w`,
      `${rect.x.toFixed(2)} ${rect.y.toFixed(2)} ${rect.width.toFixed(2)} ${rect.height.toFixed(2)} re S`,
      'Q',
    )
  } else if (action !== 'add_text') {
    throw bad(`Unknown edit action: ${action}`)
  }

  /* Draw text into the region. */
  const content = edit.text ?? ''
  if (content && action !== 'cover' && action !== 'redact' && action !== 'highlight' && action !== 'box') {
    const font = OVERLAY_FONTS[edit.font] ? edit.font : edit.bold ? 'Helvetica-Bold' : 'Helvetica'
    fonts.add(font)
    const size = edit.size ?? Math.min(12, Math.max(7, rect.height * 0.55))
    const padding = edit.padding ?? 2
    const lineHeight = size * (edit.lineHeight ?? 1.3)
    const textColour = colour(edit.colour ?? edit.color ?? 'black', [0, 0, 0])
    const lines = wrapText(content, font, size, Math.max(8, rect.width - padding * 2))

    ops.push('q', `${textColour[0]} ${textColour[1]} ${textColour[2]} rg`, `/${OVERLAY_FONTS[font]} ${size} Tf`)

    // Vertically centre a single line in its box; top-align a block
    const totalHeight = lines.length * lineHeight
    let y =
      lines.length === 1
        ? rect.y + (rect.height - size * 0.72) / 2
        : rect.y + rect.height - padding - size

    if (lines.length > 1 && totalHeight < rect.height) {
      y = rect.y + rect.height - (rect.height - totalHeight) / 2 - size
    }

    for (const line of lines) {
      let x = rect.x + padding
      const lineWidth = textWidth(line, font, size)
      if (edit.align === 'center') x = rect.x + (rect.width - lineWidth) / 2
      else if (edit.align === 'right') x = rect.x + rect.width - padding - lineWidth
      ops.push('BT', `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`, `(${pdfString(line)}) Tj`, 'ET')
      y -= lineHeight
      if (y < rect.y - size) break // never spill outside the region
    }
    ops.push('Q')
  }

  return { ops, fonts, needsBlend: action === 'highlight' }
}

/* ---------- serialisation ---------- */

/** Escapes nothing: object bodies are copied verbatim, so this only frames them. */
function serialiseObject(num, object) {
  const head = Buffer.from(`${num} 0 obj\n`, 'latin1')
  const dict = Buffer.from(object.dict, 'latin1')

  if (object.stream) {
    return Buffer.concat([
      head,
      dict,
      Buffer.from('\nstream\n', 'latin1'),
      object.stream,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
  }
  return Buffer.concat([head, dict, Buffer.from('\nendobj\n', 'latin1')])
}

/**
 * Writes a complete PDF from an object map.
 * @param {Map<number, {dict: string, stream: Buffer|null}>} objects
 */
function writePdf(objects, rootNum, infoNum) {
  const max = Math.max(...objects.keys())
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let offset = chunks[0].length

  /** Free-object entries for numbers with no object, as the xref requires. */
  const offsets = new Array(max + 1).fill(null)

  for (let num = 1; num <= max; num++) {
    const object = objects.get(num)
    if (!object) continue
    offsets[num] = offset
    const buffer = serialiseObject(num, object)
    chunks.push(buffer)
    offset += buffer.length
  }

  const xrefStart = offset
  const rows = ['xref\n', `0 ${max + 1}\n`, '0000000000 65535 f \n']
  for (let num = 1; num <= max; num++) {
    rows.push(
      offsets[num] === null
        ? '0000000000 65535 f \n'
        : `${String(offsets[num]).padStart(10, '0')} 00000 n \n`,
    )
  }
  chunks.push(Buffer.from(rows.join(''), 'latin1'))

  const trailer =
    `trailer\n<< /Size ${max + 1} /Root ${rootNum} 0 R` +
    (infoNum ? ` /Info ${infoNum} 0 R` : '') +
    ` >>\nstartxref\n${xrefStart}\n%%EOF\n`
  chunks.push(Buffer.from(trailer, 'latin1'))

  return Buffer.concat(chunks)
}

/* ---------- public API ---------- */

/**
 * @typedef {{ page?: number, action?: 'replace_text'|'add_text'|'cover'|'redact'|'highlight'|'box',
 *             region: { x?: number, y?: number, width?: number, height?: number,
 *                       units?: 'points'|'fraction', fromTop?: boolean },
 *             text?: string, font?: string, size?: number, bold?: boolean,
 *             colour?: string, fill?: string, stroke?: string, align?: string }} PdfEdit
 */

/**
 * Applies edits to specific areas of an existing PDF.
 *
 * @param {Buffer} input
 * @param {PdfEdit[]} edits
 * @returns {{ buffer: Buffer, pages: number, applied: number, report: object[] }}
 */
export function editPdf(input, edits) {
  const pdf = new PdfFile(input)
  const pages = pdf.pages()
  if (pages.length === 0) throw bad('That PDF has no pages.')
  if (!Array.isArray(edits) || edits.length === 0) throw bad('No edits were given.')

  // Copy every object; only the pages being edited get rewritten
  /** @type {Map<number, {dict: string, stream: Buffer|null}>} */
  const objects = new Map()
  for (const [num, object] of pdf.objects) {
    // An /ObjStm container is dropped: its contents were expanded into real
    // objects, so keeping it would duplicate them.
    if (object.stream && dictGet(object.dict, 'Type') === '/ObjStm') continue
    // The old cross-reference stream describes a file layout that no longer exists
    if (object.stream && dictGet(object.dict, 'Type') === '/XRef') continue
    objects.set(num, { dict: object.dict, stream: object.stream })
  }

  let nextNum = Math.max(...pdf.objects.keys()) + 1
  const addObject = (dict, stream = null) => {
    const num = nextNum++
    objects.set(num, { dict, stream })
    return num
  }

  /** Font objects are shared across every page that needs them. */
  const fontObjects = new Map()
  const fontObject = (name) => {
    if (!fontObjects.has(name)) {
      fontObjects.set(
        name,
        addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
      )
    }
    return fontObjects.get(name)
  }

  let blendState = null
  const report = []
  let applied = 0

  // Group by page so one page is rewritten once even with several edits
  const byPage = new Map()
  edits.forEach((edit, index) => {
    const pageNumber = Math.max(1, Math.min(pages.length, Number(edit.page ?? 1)))
    if (!byPage.has(pageNumber)) byPage.set(pageNumber, [])
    byPage.get(pageNumber).push({ edit, index })
  })

  for (const [pageNumber, group] of byPage) {
    const page = pages[pageNumber - 1]
    const box = pdf.pageBox(page)
    const ops = []
    const fonts = new Set()
    let needsBlend = false

    for (const { edit, index } of group) {
      try {
        const built = buildEdit(edit, box)
        ops.push(...built.ops)
        for (const font of built.fonts) fonts.add(font)
        needsBlend = needsBlend || built.needsBlend
        applied++
        report.push({ index, page: pageNumber, action: edit.action ?? 'replace_text', ok: true })
      } catch (error) {
        report.push({ index, page: pageNumber, ok: false, error: String(error?.message ?? error).slice(0, 200) })
      }
    }
    if (ops.length === 0) continue

    /* The overlay runs in its own q/Q so it cannot inherit a clipping path or a
       transform left set by the page's own content. */
    const streamText = `q\n1 0 0 1 0 0 cm\n${ops.join('\n')}\nQ\n`
    const compressed = deflateSync(Buffer.from(streamText, 'latin1'))
    const overlayNum = addObject(`<< /Length ${compressed.length} /Filter /FlateDecode >>`, compressed)

    /* Append the overlay to the page's content array. */
    const existing = dictGet(page.dict, 'Contents')
    const contentRefs = existing ? refArray(existing) : []
    let newDict = dictSet(
      page.dict,
      'Contents',
      `[${[...contentRefs.map((n) => `${n} 0 R`), `${overlayNum} 0 R`].join(' ')}]`,
    )

    /* A page whose content came as several streams may rely on them being
       concatenated; that still holds, and the overlay is simply last. */

    /* Merge the overlay's fonts into the page resources. */
    if (fonts.size > 0 || needsBlend) {
      newDict = mergeResources(newDict, pdf, {
        fonts: [...fonts].map((name) => ({ key: OVERLAY_FONTS[name], num: fontObject(name) })),
        blend: needsBlend
          ? (blendState ??= addObject('<< /Type /ExtGState /BM /Multiply /CA 1 /ca 1 >>'))
          : null,
        objects,
      })
    }

    objects.set(page.num, { dict: newDict, stream: page.stream })
  }

  const rootNum = pdf.catalog().num
  const infoNum = refNumber(dictGet(pdf.trailer, 'Info'))
  const buffer = writePdf(objects, rootNum, objects.has(infoNum) ? infoNum : null)

  return { buffer, pages: pages.length, applied, report }
}

/**
 * Adds fonts and, if needed, a blend-mode graphics state to a page's /Resources.
 *
 * Resources may be inherited from the page tree or shared between pages, so a
 * private copy is made for the page being edited rather than mutating a
 * dictionary other pages also point at.
 */
function mergeResources(pageDict, pdf, { fonts, blend, objects }) {
  const resourcesValue = dictGet(pageDict, 'Resources')
  let resources = '<< >>'

  if (resourcesValue) {
    const ref = refNumber(resourcesValue)
    if (ref !== null) {
      const object = pdf.get(ref)
      resources = object ? object.dict : '<< >>'
    } else {
      resources = resourcesValue
    }
  } else {
    // Inherited from an ancestor node
    let node = pageDict
    for (let depth = 0; depth < 32; depth++) {
      const parent = refNumber(dictGet(node, 'Parent'))
      if (parent === null) break
      const parentObject = pdf.get(parent)
      if (!parentObject) break
      const inherited = dictGet(parentObject.dict, 'Resources')
      if (inherited) {
        const ref = refNumber(inherited)
        resources = ref !== null ? (pdf.get(ref)?.dict ?? '<< >>') : inherited
        break
      }
      node = parentObject.dict
    }
  }

  /* Fonts */
  if (fonts.length > 0) {
    const fontValue = dictGet(resources, 'Font')
    let fontDict = '<< >>'
    if (fontValue) {
      const ref = refNumber(fontValue)
      fontDict = ref !== null ? (pdf.get(ref)?.dict ?? '<< >>') : fontValue
    }
    const additions = fonts.map((f) => `/${f.key} ${f.num} 0 R`).join(' ')
    // Insert into the existing font dictionary, keeping every original entry
    const open = fontDict.indexOf('<<')
    fontDict = open === -1 ? `<< ${additions} >>` : `${fontDict.slice(0, open + 2)} ${additions}${fontDict.slice(open + 2)}`
    resources = dictSet(resources, 'Font', fontDict)
  }

  /* Blend-mode state for highlighting */
  if (blend !== null) {
    const gsValue = dictGet(resources, 'ExtGState')
    let gsDict = '<< >>'
    if (gsValue) {
      const ref = refNumber(gsValue)
      gsDict = ref !== null ? (pdf.get(ref)?.dict ?? '<< >>') : gsValue
    }
    const open = gsDict.indexOf('<<')
    const addition = `/GSH ${blend} 0 R`
    gsDict = open === -1 ? `<< ${addition} >>` : `${gsDict.slice(0, open + 2)} ${addition}${gsDict.slice(open + 2)}`
    resources = dictSet(resources, 'ExtGState', gsDict)
  }

  void objects // resources are inlined on the page, so no new object is needed
  return dictSet(pageDict, 'Resources', resources)
}

/**
 * Extracts the text of a PDF page by page, for answering questions about it and
 * for locating the region an edit should target.
 *
 * @returns {{ pages: { page: number, text: string, width: number, height: number }[], text: string }}
 */
export function extractPdfText(input) {
  const pdf = new PdfFile(input)
  const out = []

  for (const [index, page] of pdf.pages().entries()) {
    const content = pdf.pageContent(page)
    const box = pdf.pageBox(page)
    out.push({ page: index + 1, text: textFromContent(content), width: box.width, height: box.height })
  }
  return { pages: out, text: out.map((p) => p.text).join('\n\n') }
}

/**
 * Pulls the strings out of a content stream.
 *
 * Text is drawn by Tj/TJ/'/" operators taking string operands; positioning
 * operators tell us where the lines break. This does not attempt to reconstruct
 * columns — it recovers the reading order the producer wrote.
 */
export function textFromContent(content) {
  const out = []
  let i = 0
  const source = String(content)

  while (i < source.length) {
    const char = source[i]

    if (char === '(') {
      // A literal string, then look ahead for the operator that consumes it
      let depth = 0
      let text = ''
      let j = i
      while (j < source.length) {
        const c = source[j]
        if (c === '\\') {
          const next = source[j + 1]
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
          if (next in escapes) {
            text += escapes[next]
            j += 2
            continue
          }
          const octal = /^[0-7]{1,3}/.exec(source.slice(j + 1, j + 4))
          if (octal) {
            text += String.fromCharCode(Number.parseInt(octal[0], 8))
            j += 1 + octal[0].length
            continue
          }
          j += 2
          continue
        }
        if (c === '(') {
          depth++
          if (depth > 1) text += c
          j++
          continue
        }
        if (c === ')') {
          depth--
          if (depth === 0) {
            j++
            break
          }
          text += c
          j++
          continue
        }
        text += c
        j++
      }
      out.push({ type: 'text', value: text })
      i = j
      continue
    }

    if (char === '<' && source[i + 1] !== '<') {
      // Hex string: two hex digits per byte
      const close = source.indexOf('>', i)
      if (close === -1) break
      const hex = source.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '')
      let text = ''
      for (let k = 0; k + 1 < hex.length; k += 2) {
        text += String.fromCharCode(Number.parseInt(hex.slice(k, k + 2), 16))
      }
      out.push({ type: 'text', value: text })
      i = close + 1
      continue
    }

    // Operators that end a line of text
    if (/^(T\*|Td|TD|TL|T[dD]|'|")/.test(source.slice(i, i + 2))) {
      const token = /^(T\*|Td|TD|TL|'|")/.exec(source.slice(i, i + 2))
      if (token) {
        out.push({ type: 'break' })
        i += token[0].length
        continue
      }
    }
    if (source.startsWith('ET', i) || source.startsWith('BT', i)) {
      out.push({ type: 'break' })
      i += 2
      continue
    }

    i++
  }

  // Assemble: consecutive text pieces join, breaks become newlines
  let result = ''
  let pending = false
  for (const item of out) {
    if (item.type === 'break') {
      pending = true
      continue
    }
    if (pending && result && !result.endsWith('\n')) result += '\n'
    pending = false
    result += item.value
  }

  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line || (index > 0 && all[index - 1]))
    .join('\n')
    .trim()
}

/**
 * Finds where a phrase appears on each page, so an edit can target it without
 * the caller having to know coordinates.
 *
 * Reports the text line and page. Precise glyph boxes would need the full text
 * matrix and font metrics of the original document; the line-level answer is
 * what a caller actually needs to then give a region.
 */
export function findText(input, phrase) {
  const needle = String(phrase ?? '').trim().toLowerCase()
  if (!needle) return []
  const { pages } = extractPdfText(input)
  const hits = []

  for (const page of pages) {
    const lines = page.text.split('\n')
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) {
        hits.push({
          page: page.page,
          line: index + 1,
          text: line.slice(0, 300),
          // A usable starting estimate: lines run top to bottom in reading order
          approximateY: lines.length > 0 ? index / lines.length : 0,
          pageWidth: page.width,
          pageHeight: page.height,
        })
      }
    })
  }
  return hits
}

export { PdfFile, PdfParseError, decodeStream }
