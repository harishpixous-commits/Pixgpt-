import { deflateRawSync } from 'node:zlib'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listFiles } from './files.mjs'
import { GatewayError } from '../gateway/errors.mjs'

/* ============================================================
   ZIP packaging
   -------------
   A minimal, correct ZIP writer — no dependency for one feature.
   Format: [local header + data]* + [central directory]* + EOCD.

   Deliberately excludes node_modules, .git and build output: the
   recipient runs `npm install` from package.json, and shipping a
   200 MB dependency tree would be worse than useless.
   ============================================================ */

const MAX_ZIP_BYTES = Number.parseInt(process.env.AGENT_MAX_ZIP_BYTES ?? '', 10) || 60 * 1024 * 1024
const MAX_ENTRIES = 3000

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

/** DOS date/time, which is what the ZIP header actually stores. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

/**
 * Packages a project directory into a ZIP buffer.
 * @returns {{ buffer: Buffer, entries: number, bytes: number, skipped: string[] }}
 */
export function zipProject(projectDir, { rootName = 'project' } = {}) {
  const { entries } = listFiles(projectDir, '.', { depth: 20 })
  const files = entries.filter((e) => e.type === 'file')

  if (files.length === 0) throw new GatewayError('bad_request', 'There is nothing to package yet.', { status: 400 })
  if (files.length > MAX_ENTRIES) {
    throw new GatewayError('bad_request', `Too many files to package (${files.length}).`, { status: 400 })
  }

  const locals = []
  const central = []
  const skipped = []
  let offset = 0
  let total = 0

  for (const file of files) {
    const abs = join(projectDir, file.path)
    let data
    try {
      const stat = statSync(abs)
      if (stat.size > 8 * 1024 * 1024) {
        skipped.push(`${file.path} (too large)`)
        continue
      }
      data = readFileSync(abs)
    } catch {
      skipped.push(`${file.path} (unreadable)`)
      continue
    }

    total += data.length
    if (total > MAX_ZIP_BYTES) {
      skipped.push(`${file.path} (archive size limit)`)
      continue
    }

    // Forward slashes, and everything under a single top-level folder so the
    // archive never explodes loose files into the user's Downloads.
    const name = `${rootName}/${file.path}`
    const nameBuf = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 6 })
    const useDeflate = compressed.length < data.length
    const payload = useDeflate ? compressed : data
    const { time, date } = dosDateTime(new Date())
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8) // method
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length

    locals.push(local, nameBuf, payload)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0) // central directory signature
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(payload.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30) // extra
    dir.writeUInt16LE(0, 32) // comment
    dir.writeUInt16LE(0, 34) // disk
    dir.writeUInt16LE(0, 36) // internal attrs
    dir.writeUInt32LE(0, 38) // external attrs
    dir.writeUInt32LE(offset, 42) // relative offset of local header

    central.push(dir, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }

  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(central)
  const count = central.length / 2

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  const buffer = Buffer.concat([localBuf, centralBuf, eocd])
  return { buffer, entries: count, bytes: buffer.length, skipped }
}
