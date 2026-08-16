import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { GatewayError } from '../gateway/errors.mjs'
import { log } from '../config.mjs'

/* ============================================================
   ZIP import
   ----------
   Reads an uploaded archive and writes it into the task workspace.

   Everything an archive can do to a host, it is assumed to be trying:
   - zip-slip ("../../.ssh/authorized_keys") and absolute paths
   - Windows drive letters and UNC paths
   - symlinks and other non-regular entries that escape the workspace
   - decompression bombs (small archive, enormous expansion)
   - tens of thousands of entries, or one gigantic file
   - filenames with NUL, control characters or reserved device names
   - nested archives, which are stored but never expanded

   Nothing is written until the whole archive has been validated, so a
   malicious entry near the end cannot leave a half-written workspace.
   ============================================================ */

export const IMPORT_LIMITS = {
  archiveBytes: 60 * 1024 * 1024, //  60 MB uploaded
  totalBytes: 400 * 1024 * 1024, // 400 MB expanded
  fileBytes: 25 * 1024 * 1024, //  25 MB per file
  entries: 8000,
  ratio: 120, // expanded / compressed, per file
  pathLength: 320,
  depth: 24,
}

/* Signatures */
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50

/** Entries PixGPT never imports: build output, VCS internals, secrets, junk. */
const SKIP_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.venv|venv)\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /(^|\/)__MACOSX\//i,
  /(^|\/)\.env(\.|$)/, // never import someone's credentials
  /(^|\/)(id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc)$/,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
]

/** Reserved Windows device names — writing one can hang or misbehave. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

/**
 * NUL and other control characters truncate or mangle paths in the C APIs the
 * filesystem calls end up in. Checked by code point so this file contains no
 * invisible characters itself.
 */
function hasControlCharacter(name) {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/* ---------- central directory ---------- */

function findEocd(buf) {
  // The EOCD is at the end, but a trailing comment can push it back up to 64 KB
  const from = Math.max(0, buf.length - 66_560)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * Parses the central directory. This is the authoritative entry list — reading
 * local headers alone lets an attacker hide entries from validation.
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf)
  if (eocd === -1) throw bad('That file is not a valid ZIP archive.')

  let count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)

  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) {
      throw bad('That ZIP archive uses an unsupported format.')
    }
    const z64 = Number(buf.readBigUInt64LE(locator + 8))
    if (z64 < 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== SIG_EOCD64) {
      throw bad('That ZIP archive is malformed.')
    }
    count = Number(buf.readBigUInt64LE(z64 + 32))
    offset = Number(buf.readBigUInt64LE(z64 + 48))
  }

  if (count > IMPORT_LIMITS.entries) {
    throw bad(`That archive has ${count} entries; the limit is ${IMPORT_LIMITS.entries}.`)
  }

  const entries = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) throw bad('That ZIP archive is truncated.')
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw bad('That ZIP archive is malformed.')

    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const externalAttrs = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)

    if (p + 46 + nameLen > buf.length) throw bad('That ZIP archive is truncated.')
    const rawName = buf.subarray(p + 46, p + 46 + nameLen)

    entries.push({
      name: rawName.toString('utf8'),
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      // The high 16 bits are Unix st_mode; 0xA000 is S_IFLNK
      unixMode: (externalAttrs >>> 16) & 0xffff,
      dosDirectory: (externalAttrs & 0x10) !== 0,
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/* ---------- validation ---------- */

/**
 * Normalises and screens one entry name.
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function safeEntryPath(rawName) {
  const name = String(rawName ?? '')

  if (!name) return { ok: false, reason: 'empty name' }
  if (name.length > IMPORT_LIMITS.pathLength) return { ok: false, reason: 'path too long' }
  // NUL and control characters truncate paths in C APIs
  if (hasControlCharacter(name)) return { ok: false, reason: 'control character in name' }
  if (/^[a-zA-Z]:/.test(name)) return { ok: false, reason: 'drive letter' }
  if (name.startsWith('\\\\')) return { ok: false, reason: 'UNC path' }

  // Backslash is a separator on Windows and a legal filename character on Unix;
  // treating it as a separator is the safe reading.
  const unified = name.replace(/\\/g, '/')
  if (unified.startsWith('/')) return { ok: false, reason: 'absolute path' }

  const parts = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { ok: false, reason: 'parent traversal' }
    if (RESERVED.test(segment)) return { ok: false, reason: 'reserved device name' }
    // Trailing dots and spaces are silently stripped by Windows, which would
    // let "a.txt " and "a.txt" collide after the fact
    if (/[ .]$/.test(segment)) return { ok: false, reason: 'trailing dot or space' }
    if (segment.includes(':')) return { ok: false, reason: 'colon in name' }
    parts.push(segment)
  }

  if (parts.length === 0) return { ok: false, reason: 'empty path' }
  if (parts.length > IMPORT_LIMITS.depth) return { ok: false, reason: 'too deeply nested' }

  return { ok: true, path: parts.join('/') }
}

/** True if the archive nests everything under one folder, as GitHub exports do. */
function commonPrefix(paths) {
  if (paths.length < 2) return null
  const first = paths[0].split('/')[0]
  if (!first || !paths.every((p) => p.startsWith(`${first}/`))) return null
  return first
}

/* ---------- extraction ---------- */

function readEntryData(buf, entry) {
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw bad(`The archive entry "${entry.name}" is corrupt.`)
  }
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen

  // Trust the central directory's size, but never read past the buffer
  const end = start + entry.compressedSize
  if (end > buf.length) throw bad(`The archive entry "${entry.name}" is truncated.`)
  const raw = buf.subarray(start, end)

  if (entry.method === 0) return raw
  if (entry.method !== 8) {
    throw bad(`The archive entry "${entry.name}" uses an unsupported compression method.`)
  }

  /*
   * maxOutputLength makes zlib refuse a bomb rather than exhausting memory:
   * a 40 KB entry claiming to expand to 4 GB stops here, not in the OOM killer.
   */
  const ceiling = Math.min(
    IMPORT_LIMITS.fileBytes,
    Math.max(entry.uncompressedSize, 1024) + 1024,
  )
  try {
    return inflateRawSync(raw, { maxOutputLength: ceiling })
  } catch (error) {
    if (/maxOutputLength|buffer/i.test(String(error?.message))) {
      throw bad(`The archive entry "${entry.name}" expands far beyond its declared size.`)
    }
    throw bad(`The archive entry "${entry.name}" could not be decompressed.`)
  }
}

/**
 * Extracts an uploaded ZIP into `projectDir`.
 *
 * @param {Buffer} archive
 * @param {string} projectDir  an already-created task workspace
 * @returns {{ ok, files: number, bytes: number, skipped: {name,reason}[], stripped: string|null }}
 */
export function extractZip(archive, projectDir) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) throw bad('No archive was uploaded.')
  if (archive.length > IMPORT_LIMITS.archiveBytes) {
    throw bad(`That archive is ${Math.round(archive.length / 1048576)} MB; the limit is ${Math.round(IMPORT_LIMITS.archiveBytes / 1048576)} MB.`)
  }

  const entries = readCentralDirectory(archive)
  const skipped = []
  const planned = []

  /* --- pass 1: validate every entry, write nothing --- */
  for (const entry of entries) {
    const isDir = entry.dosDirectory || entry.name.endsWith('/') || entry.name.endsWith('\\')

    // 0xA000 = S_IFLNK. A symlink is how an archive reaches outside the workspace.
    if ((entry.unixMode & 0xf000) === 0xa000) {
      skipped.push({ name: entry.name.slice(0, 120), reason: 'symlink' })
      continue
    }
    // Only regular files and directories; no devices, sockets or FIFOs
    const type = entry.unixMode & 0xf000
    if (type !== 0 && type !== 0x8000 && type !== 0x4000) {
      skipped.push({ name: entry.name.slice(0, 120), reason: 'not a regular file' })
      continue
    }
    if (entry.flags & 0x1) {
      skipped.push({ name: entry.name.slice(0, 120), reason: 'encrypted' })
      continue
    }

    const safe = safeEntryPath(entry.name)
    if (!safe.ok) {
      skipped.push({ name: entry.name.slice(0, 120), reason: safe.reason })
      continue
    }
    if (isDir) continue // directories are created implicitly

    if (SKIP_PATTERNS.some((re) => re.test(safe.path))) {
      skipped.push({ name: safe.path, reason: 'excluded by policy' })
      continue
    }
    if (entry.uncompressedSize > IMPORT_LIMITS.fileBytes) {
      skipped.push({ name: safe.path, reason: 'file too large' })
      continue
    }
    // Nested archives are stored as-is and never expanded
    if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i.test(safe.path)) {
      skipped.push({ name: safe.path, reason: 'nested archive' })
      continue
    }
    if (
      entry.compressedSize > 512 &&
      entry.uncompressedSize / Math.max(entry.compressedSize, 1) > IMPORT_LIMITS.ratio
    ) {
      skipped.push({ name: safe.path, reason: 'suspicious compression ratio' })
      continue
    }
    planned.push({ entry, path: safe.path })
  }

  if (planned.length === 0) {
    throw bad('That archive contained no importable files.')
  }

  const declared = planned.reduce((sum, p) => sum + p.entry.uncompressedSize, 0)
  if (declared > IMPORT_LIMITS.totalBytes) {
    throw bad(`That archive expands to ${Math.round(declared / 1048576)} MB; the limit is ${Math.round(IMPORT_LIMITS.totalBytes / 1048576)} MB.`)
  }

  // "my-app-main/src/index.js" -> "src/index.js"
  const strip = commonPrefix(planned.map((p) => p.path))

  /* --- pass 2: decompress and write --- */
  let bytes = 0
  let files = 0
  for (const { entry, path } of planned) {
    const data = readEntryData(archive, entry)

    bytes += data.length
    if (bytes > IMPORT_LIMITS.totalBytes) {
      throw bad('That archive expanded beyond the size limit.')
    }

    const relative = strip ? path.slice(strip.length + 1) : path
    if (!relative) continue

    // Final containment check on the real path we are about to write
    const target = join(projectDir, relative.split('/').join(sep))
    if (!target.startsWith(projectDir + sep)) {
      skipped.push({ name: path, reason: 'escapes the workspace' })
      continue
    }

    mkdirSync(dirname(target), { recursive: true })
    // 'wx' would fail on a duplicate entry; last-write-wins matches unzip
    writeFileSync(target, data)
    files++
  }

  log.info('project imported', { files, bytes, skipped: skipped.length, stripped: strip ?? null })
  return { ok: true, files, bytes, skipped: skipped.slice(0, 40), skippedTotal: skipped.length, stripped: strip }
}
