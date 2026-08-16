import { deflateRawSync } from 'node:zlib'

/* ============================================================
   ZIP builder
   -----------
   Builds a ZIP from in-memory entries. DOCX, XLSX and PPTX are all
   ZIP containers of XML parts, so one correct writer serves all three.

   Format: [local header + data]* + [central directory]* + EOCD.
   ============================================================ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

/**
 * Builds a ZIP archive.
 *
 * @param {{ name: string, data: Buffer|string, store?: boolean }[]} entries
 * @param {Date} [now]  fixed timestamp — keeps output reproducible
 * @returns {Buffer}
 */
export function buildZip(entries, now = new Date(2024, 0, 1, 12, 0, 0)) {
  const { time, date } = dosDateTime(now)
  const locals = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const crc = crc32(raw)

    // `store` for already-compressed payloads (PNG, JPEG) — deflating them again
    // only makes them bigger.
    const deflated = entry.store ? raw : deflateRawSync(raw, { level: 9 })
    const useStore = entry.store || deflated.length >= raw.length
    const data = useStore ? raw : deflated
    const method = useStore ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(0, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30) // extra
    dir.writeUInt16LE(0, 32) // comment
    dir.writeUInt16LE(0, 34) // disk
    dir.writeUInt16LE(0, 36) // internal attrs
    // External attrs: Unix mode 0644 in the high 16 bits. `>>> 0` is required —
    // a plain `<< 16` overflows into a negative signed int and writeUInt32LE throws.
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

/**
 * True for a code point XML 1.0 forbids.
 *
 * Tab, newline and carriage return are the only C0 controls XML allows; the
 * rest make the document unparseable, so they are dropped. Checked by code
 * point rather than a character class, so this source file carries no
 * invisible characters of its own.
 */
function isForbiddenXmlCode(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/** XML text escaping. Everything user-supplied goes through this. */
export function xml(text) {
  const source = String(text ?? '')
  let out = ''

  for (const char of source) {
    switch (char) {
      case '&':
        out += '&amp;'
        break
      case '<':
        out += '&lt;'
        break
      case '>':
        out += '&gt;'
        break
      case '"':
        out += '&quot;'
        break
      case "'":
        out += '&apos;'
        break
      default:
        if (!isForbiddenXmlCode(char.codePointAt(0))) out += char
    }
  }
  return out
}
