import { inflateSync } from 'node:zlib'

/* ============================================================
   PDF reader
   ----------
   Reads an existing PDF into an object map so it can be edited.

   Objects are found by scanning for "N G obj" rather than by trusting
   the xref table. That is what repair tools do, and it is deliberate:
   real-world PDFs have broken xrefs, and modern ones store the table as
   a compressed stream. Scanning handles every generation of the format
   with one code path.

   Objects hidden inside /ObjStm streams are expanded, because in a
   PDF 1.5+ file the page dictionaries usually live there.
   ============================================================ */

const MAX_PDF_BYTES = 80 * 1024 * 1024

export class PdfParseError extends Error {}

/* ---------- low-level scanning ---------- */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const isWhite = (byte) => WHITESPACE.has(byte)
const isDelim = (byte) => DELIMITER.has(byte)
const isRegular = (byte) => !isWhite(byte) && !isDelim(byte)

/**
 * Finds the extent of the object value starting at `start` in `text`.
 * Handles dictionaries, arrays, strings and hex strings with nesting, which a
 * regex cannot do — a `>>` inside a string must not end the dictionary.
 */
export function valueExtent(text, start) {
  let i = start
  while (i < text.length && isWhite(text.charCodeAt(i))) i++
  if (i >= text.length) return { start: i, end: i }

  const two = text.slice(i, i + 2)

  if (two === '<<') {
    let depth = 0
    let j = i
    while (j < text.length) {
      if (text.startsWith('<<', j)) {
        depth++
        j += 2
      } else if (text.startsWith('>>', j)) {
        depth--
        j += 2
        if (depth === 0) return { start: i, end: j }
      } else if (text[j] === '(') {
        j = skipLiteralString(text, j)
      } else if (text[j] === '%') {
        while (j < text.length && text[j] !== '\n') j++
      } else {
        j++
      }
    }
    throw new PdfParseError('Unterminated dictionary.')
  }

  if (text[i] === '[') {
    let depth = 0
    let j = i
    while (j < text.length) {
      if (text[j] === '[') {
        depth++
        j++
      } else if (text[j] === ']') {
        depth--
        j++
        if (depth === 0) return { start: i, end: j }
      } else if (text[j] === '(') {
        j = skipLiteralString(text, j)
      } else {
        j++
      }
    }
    throw new PdfParseError('Unterminated array.')
  }

  if (text[i] === '(') return { start: i, end: skipLiteralString(text, i) }

  if (text[i] === '<') {
    const close = text.indexOf('>', i)
    if (close === -1) throw new PdfParseError('Unterminated hex string.')
    return { start: i, end: close + 1 }
  }

  // A reference is three tokens: "12 0 R". Try that before a bare number.
  const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(text.slice(i, i + 32))
  if (ref) return { start: i, end: i + ref[0].length }

  let j = i
  if (text[j] === '/') j++
  while (j < text.length && isRegular(text.charCodeAt(j))) j++
  return { start: i, end: Math.max(j, i + 1) }
}

function skipLiteralString(text, start) {
  let depth = 0
  let i = start
  while (i < text.length) {
    const char = text[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  throw new PdfParseError('Unterminated string.')
}

/**
 * Reads one key's raw value text from a dictionary.
 * @returns {{ value: string, start: number, end: number } | null}
 */
export function dictEntry(dictText, key) {
  const needle = `/${key}`
  let i = 0
  while (i < dictText.length) {
    const found = dictText.indexOf(needle, i)
    if (found === -1) return null
    // Must be a complete name: /Type must not match /TypeX
    const after = dictText.charCodeAt(found + needle.length)
    if (Number.isNaN(after) || !isRegular(after)) {
      const extent = valueExtent(dictText, found + needle.length)
      return { value: dictText.slice(extent.start, extent.end).trim(), start: extent.start, end: extent.end }
    }
    i = found + needle.length
  }
  return null
}

/** Convenience: the value of a key, or null. */
export const dictGet = (dictText, key) => dictEntry(dictText, key)?.value ?? null

/** Replaces (or inserts) a key in a dictionary's raw text. */
export function dictSet(dictText, key, newValue) {
  const entry = dictEntry(dictText, key)
  if (entry) return dictText.slice(0, entry.start) + newValue + dictText.slice(entry.end)
  // Insert just inside the opening <<
  const open = dictText.indexOf('<<')
  if (open === -1) throw new PdfParseError('Not a dictionary.')
  return `${dictText.slice(0, open + 2)} /${key} ${newValue}${dictText.slice(open + 2)}`
}

/** Object number from a "12 0 R" reference, or null. */
export function refNumber(value) {
  const m = /^(\d+)\s+\d+\s+R$/.exec(String(value ?? '').trim())
  return m ? Number(m[1]) : null
}

/** Object numbers from an array of references, e.g. "[3 0 R 7 0 R]". */
export function refArray(value) {
  return [...String(value ?? '').matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
}

/* ---------- stream decoding ---------- */

/** Undoes the PNG predictors used by xref and object streams. */
function unpredict(data, predictor, colours, bpc, columns) {
  if (predictor < 10) return data
  const bpp = Math.ceil((colours * bpc) / 8)
  const rowLength = Math.ceil((colours * bpc * columns) / 8)
  const rows = Math.floor(data.length / (rowLength + 1))
  const out = Buffer.alloc(rows * rowLength)
  let previous = Buffer.alloc(rowLength)

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)]
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1))
    const current = Buffer.from(row)

    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? current[i - bpp] : 0
      const up = previous[i]
      const upLeft = i >= bpp ? previous[i - bpp] : 0
      switch (type) {
        case 0:
          break
        case 1:
          current[i] = (current[i] + left) & 0xff
          break
        case 2:
          current[i] = (current[i] + up) & 0xff
          break
        case 3:
          current[i] = (current[i] + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          current[i] = (current[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
          break
        }
        default:
          break
      }
    }
    current.copy(out, r * rowLength)
    previous = current
  }
  return out
}

/** Decodes a stream's bytes according to its /Filter. */
export function decodeStream(dictText, raw) {
  const filter = dictGet(dictText, 'Filter') ?? ''
  if (!filter || filter === 'null') return raw

  if (!/FlateDecode/.test(filter)) {
    // LZW, DCT, CCITT and friends are image codecs; nothing here needs them
    throw new PdfParseError(`Unsupported stream filter: ${filter.slice(0, 40)}`)
  }

  let data
  try {
    data = inflateSync(raw)
  } catch {
    // Some writers leave trailing garbage after the deflate block
    try {
      data = inflateSync(raw, { finishFlush: 2 /* Z_SYNC_FLUSH */ })
    } catch {
      throw new PdfParseError('A stream could not be decompressed.')
    }
  }

  const parms = dictGet(dictText, 'DecodeParms')
  if (parms && /Predictor/.test(parms)) {
    const number = (key, fallback) => {
      const v = dictGet(parms, key)
      return v === null ? fallback : Number(v)
    }
    data = unpredict(data, number('Predictor', 1), number('Colors', 1), number('BitsPerComponent', 8), number('Columns', 1))
  }
  return data
}

/* ---------- document ---------- */

/**
 * @typedef {{ num: number, gen: number, dict: string, stream: Buffer|null,
 *             raw: Buffer|null, fromObjStm: boolean }} PdfObject
 */

export class PdfFile {
  /** @param {Buffer} buffer */
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new PdfParseError('Not a buffer.')
    if (buffer.length > MAX_PDF_BYTES) throw new PdfParseError('That PDF is too large to edit.')
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      // Some files carry junk before the header; tolerate a small offset
      const at = buffer.indexOf('%PDF-')
      if (at === -1 || at > 1024) throw new PdfParseError('That file is not a PDF.')
    }

    this.buffer = buffer
    /** @type {Map<number, PdfObject>} */
    this.objects = new Map()
    this.trailer = ''
    this.#scan()
    this.#expandObjectStreams()
  }

  /** Latin-1 view: byte-for-byte index parity with the buffer. */
  get text() {
    if (!this.#text) this.#text = this.buffer.toString('latin1')
    return this.#text
  }
  #text = null

  /** Finds every top-level "N G obj … endobj". */
  #scan() {
    const text = this.text
    const pattern = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g
    let match

    while ((match = pattern.exec(text)) !== null) {
      const num = Number(match[1])
      const gen = Number(match[2])
      const bodyStart = match.index + match[0].length

      // A stream's data is binary and may contain "endobj", so the stream length
      // decides where the object ends — never a search for the keyword.
      const streamAt = this.#findStreamKeyword(text, bodyStart)
      let dict
      let stream = null
      let end

      if (streamAt !== -1) {
        dict = text.slice(bodyStart, streamAt).trim()
        let dataStart = streamAt + 6 // "stream"
        if (text[dataStart] === '\r') dataStart++
        if (text[dataStart] === '\n') dataStart++

        const length = this.#streamLength(dict, dataStart, text)
        stream = this.buffer.subarray(dataStart, dataStart + length)
        end = text.indexOf('endobj', dataStart + length)
        // Keep the scanner from re-entering this object's binary payload
        pattern.lastIndex = end === -1 ? dataStart + length : end + 6
      } else {
        const objEnd = text.indexOf('endobj', bodyStart)
        end = objEnd === -1 ? text.length : objEnd
        dict = text.slice(bodyStart, end).trim()
      }

      // A later definition of the same object supersedes an earlier one, which
      // is exactly how incremental updates work.
      this.objects.set(num, { num, gen, dict, stream, fromObjStm: false })
    }

    const trailerAt = text.lastIndexOf('trailer')
    if (trailerAt !== -1) {
      const extent = valueExtent(text, trailerAt + 7)
      this.trailer = text.slice(extent.start, extent.end)
    }
  }

  /** "stream" belonging to this object, not one inside a nested string. */
  #findStreamKeyword(text, from) {
    const at = text.indexOf('stream', from)
    if (at === -1) return -1
    const nextObj = text.indexOf(' obj', from)
    // If another object header comes first, this object has no stream
    if (nextObj !== -1 && nextObj < at) return -1
    const between = text.slice(from, at)
    // The dictionary must have closed before the stream keyword
    if (!between.includes('>>')) return -1
    return at
  }

  #streamLength(dict, dataStart, text) {
    const raw = dictGet(dict, 'Length')
    const direct = Number(raw)
    if (Number.isFinite(direct) && direct > 0) return direct

    // /Length can be an indirect reference — resolve it by looking ahead
    const ref = refNumber(raw)
    if (ref !== null) {
      const pattern = new RegExp(`(?:^|[^0-9])${ref}\\s+\\d+\\s+obj\\b([\\s\\S]{0,40})`)
      const found = pattern.exec(text)
      const value = found ? Number(/\d+/.exec(found[1])?.[0]) : NaN
      if (Number.isFinite(value)) return value
    }

    // Last resort: find "endstream" and work backwards
    const endAt = text.indexOf('endstream', dataStart)
    if (endAt === -1) throw new PdfParseError('A stream has no length and no endstream.')
    let end = endAt
    if (text[end - 1] === '\n') end--
    if (text[end - 1] === '\r') end--
    return end - dataStart
  }

  /** Pulls objects out of /ObjStm containers so pages become reachable. */
  #expandObjectStreams() {
    for (const object of [...this.objects.values()]) {
      if (!object.stream || dictGet(object.dict, 'Type') !== '/ObjStm') continue

      let data
      try {
        data = decodeStream(object.dict, object.stream)
      } catch {
        continue // an unreadable container is not fatal to the rest
      }
      const count = Number(dictGet(object.dict, 'N'))
      const first = Number(dictGet(object.dict, 'First'))
      if (!Number.isFinite(count) || !Number.isFinite(first)) continue

      const header = data.subarray(0, first).toString('latin1')
      const numbers = header.trim().split(/\s+/).map(Number)
      const body = data.subarray(first).toString('latin1')

      for (let i = 0; i < count; i++) {
        const num = numbers[i * 2]
        const offset = numbers[i * 2 + 1]
        if (!Number.isFinite(num) || !Number.isFinite(offset)) continue
        // An object defined directly in the file wins over one in a stream:
        // that is an incremental update overriding it.
        if (this.objects.has(num) && !this.objects.get(num).fromObjStm) continue

        const extent = valueExtent(body, offset)
        this.objects.set(num, {
          num,
          gen: 0,
          dict: body.slice(extent.start, extent.end).trim(),
          stream: null,
          fromObjStm: true,
        })
      }
    }
  }

  get(num) {
    return this.objects.get(num) ?? null
  }

  /** The document catalogue. */
  catalog() {
    const fromTrailer = refNumber(dictGet(this.trailer, 'Root'))
    if (fromTrailer !== null && this.objects.has(fromTrailer)) return this.objects.get(fromTrailer)

    // Xref-stream files have no classic trailer; the Root is in the xref stream
    // dictionary, and failing that the Catalog can be found by type.
    for (const object of this.objects.values()) {
      if (dictGet(object.dict, 'Type') === '/XRef') {
        const root = refNumber(dictGet(object.dict, 'Root'))
        if (root !== null && this.objects.has(root)) return this.objects.get(root)
      }
    }
    for (const object of this.objects.values()) {
      if (dictGet(object.dict, 'Type') === '/Catalog') return object
    }
    throw new PdfParseError('That PDF has no catalogue.')
  }

  /**
   * Page objects in document order, walking the page tree.
   * @returns {PdfObject[]}
   */
  pages() {
    const catalog = this.catalog()
    const rootRef = refNumber(dictGet(catalog.dict, 'Pages'))
    const out = []
    const seen = new Set()

    const walk = (num, depth) => {
      if (num === null || seen.has(num) || depth > 64) return
      seen.add(num)
      const node = this.get(num)
      if (!node) return
      const type = dictGet(node.dict, 'Type')
      if (type === '/Page') {
        out.push(node)
        return
      }
      const kids = dictGet(node.dict, 'Kids')
      if (kids) for (const kid of refArray(kids)) walk(kid, depth + 1)
    }

    walk(rootRef, 0)

    if (out.length === 0) {
      // Fall back to type scanning if the tree is broken
      for (const object of this.objects.values()) {
        if (dictGet(object.dict, 'Type') === '/Page') out.push(object)
      }
      out.sort((a, b) => a.num - b.num)
    }
    return out
  }

  /**
   * A page's box, with inheritance — MediaBox is often only on the parent.
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  pageBox(page) {
    let node = page
    for (let depth = 0; depth < 32 && node; depth++) {
      const box = dictGet(node.dict, 'MediaBox')
      if (box) {
        const numbers = [...box.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]))
        if (numbers.length >= 4) {
          const [x1, y1, x2, y2] = numbers
          return {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
          }
        }
      }
      const parent = refNumber(dictGet(node.dict, 'Parent'))
      node = parent === null ? null : this.get(parent)
    }
    return { x: 0, y: 0, width: 612, height: 792 } // US Letter, the PDF default
  }

  /** A page's rotation in degrees, with inheritance. */
  pageRotation(page) {
    let node = page
    for (let depth = 0; depth < 32 && node; depth++) {
      const rotate = dictGet(node.dict, 'Rotate')
      if (rotate !== null && rotate !== '') {
        const value = Number(rotate)
        if (Number.isFinite(value)) return ((value % 360) + 360) % 360
      }
      const parent = refNumber(dictGet(node.dict, 'Parent'))
      node = parent === null ? null : this.get(parent)
    }
    return 0
  }

  /** Decoded text of every content stream on a page, concatenated. */
  pageContent(page) {
    const contents = dictGet(page.dict, 'Contents')
    if (!contents) return ''
    const parts = []
    for (const num of refArray(contents)) {
      const object = this.get(num)
      if (!object?.stream) continue
      try {
        parts.push(decodeStream(object.dict, object.stream).toString('latin1'))
      } catch {
        /* skip an unreadable stream */
      }
    }
    return parts.join('\n')
  }

  get pageCount() {
    return this.pages().length
  }
}

export { MAX_PDF_BYTES }
