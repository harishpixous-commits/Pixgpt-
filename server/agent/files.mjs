import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { GatewayError } from '../gateway/errors.mjs'
import { displayPath, resolveInside } from './workspace.mjs'
import { invalidateCodeMap } from './codemap.mjs'
import { fuzzyReplace, nearestMiss } from './fuzzy-edit.mjs'
import { parsePatch, planPatch } from './patch.mjs'

/* ============================================================
   Structured file operations
   -------------------------
   The agent edits code through these, not by shelling out to
   `echo >` or `sed`. Reasons: every path goes through the same
   containment check, results are structured (so the model can
   reason over them), and a failed edit reports why instead of
   silently writing nonsense.

   Every function takes `projectDir` and a *relative* path. Absolute
   paths and `..` escapes are refused by resolveInside().
   ============================================================ */

const MAX_FILE_BYTES = Number.parseInt(process.env.AGENT_MAX_FILE_BYTES ?? '', 10) || 2_000_000
const MAX_LIST_ENTRIES = 800
const MAX_SEARCH_HITS = 200

/** Never walked or returned — noise, or none of the agent's business. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage',
  '.turbo', 'venv', '__pycache__', '.venv',
  // Agent working files live outside the project, but never list them if a
  // stray one appears: they are not the user's code.
  '.pixgpt',
])

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

/* ---------- read ---------- */

/** Recursive directory listing, skipping build noise. */
export function listFiles(projectDir, relPath = '.', { depth = 6 } = {}) {
  const start = relPath === '.' || relPath === '' ? projectDir : resolveInside(projectDir, relPath, { mustExist: true })
  const entries = []
  let truncated = false

  const walk = (dir, level) => {
    if (truncated || level > depth) return
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true
        return
      }
      if (item.name.startsWith('.') && item.name !== '.env.example') continue
      const abs = join(dir, item.name)
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) {
          entries.push({ path: displayPath(projectDir, abs), type: 'dir', skipped: true })
          continue
        }
        entries.push({ path: displayPath(projectDir, abs), type: 'dir' })
        walk(abs, level + 1)
      } else {
        let size = 0
        try {
          size = statSync(abs).size
        } catch {
          /* ignore */
        }
        entries.push({ path: displayPath(projectDir, abs), type: 'file', size })
      }
    }
  }

  walk(start, 0)
  return { entries, truncated, count: entries.length }
}

export function readFile(projectDir, relPath, { maxBytes = MAX_FILE_BYTES } = {}) {
  const abs = resolveInside(projectDir, relPath, { mustExist: true })
  const stat = statSync(abs)
  if (stat.isDirectory()) throw bad(`${relPath} is a directory, not a file.`)
  if (stat.size > maxBytes) throw bad(`${relPath} is too large to read (${stat.size} bytes).`)

  const buffer = readFileSync(abs)
  if (buffer.includes(0)) throw bad(`${relPath} appears to be a binary file.`)
  const content = buffer.toString('utf8')
  return { path: displayPath(projectDir, abs), content, lines: content.split('\n').length, size: stat.size }
}

/** Literal or regex search across the project. */
export function searchFiles(projectDir, query, { regex = false, glob = null, maxHits = MAX_SEARCH_HITS } = {}) {
  if (typeof query !== 'string' || query.length === 0) throw bad('A search query is required.')
  if (query.length > 500) throw bad('That search query is too long.')

  let matcher
  if (regex) {
    try {
      matcher = new RegExp(query, 'i')
    } catch {
      throw bad('That regular expression is not valid.')
    }
  }

  const { entries } = listFiles(projectDir, '.', { depth: 12 })
  const hits = []
  let filesScanned = 0

  for (const entry of entries) {
    if (entry.type !== 'file' || entry.skipped) continue
    if (glob && !entry.path.includes(glob) && !entry.path.endsWith(glob)) continue
    if (hits.length >= maxHits) break

    let text
    try {
      const abs = resolveInside(projectDir, entry.path, { mustExist: true })
      if (statSync(abs).size > 1_000_000) continue
      const buf = readFileSync(abs)
      if (buf.includes(0)) continue
      text = buf.toString('utf8')
    } catch {
      continue
    }
    filesScanned++

    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const found = regex ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())
      if (!found) continue
      hits.push({ path: entry.path, line: i + 1, text: line.trim().slice(0, 300) })
      if (hits.length >= maxHits) break
    }
  }

  return { hits, filesScanned, truncated: hits.length >= maxHits }
}

/* ---------- write ---------- */

export function writeFile(projectDir, relPath, content) {
  // The symbol map describes a project that just changed
  invalidateCodeMap(projectDir)
  if (typeof content !== 'string') throw bad('File content must be a string.')
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw bad('That content is too large to write.')

  const abs = resolveInside(projectDir, relPath)
  const existed = existsSync(abs)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return {
    path: displayPath(projectDir, abs),
    action: existed ? 'updated' : 'created',
    bytes: Buffer.byteLength(content),
    lines: content.split('\n').length,
  }
}

/**
 * Writes binary content — a generated PDF, a Word document, an image.
 * Separate from writeFile because that one enforces UTF-8 text.
 */
export function writeBinaryFile(projectDir, relPath, buffer) {
  // The symbol map describes a project that just changed
  invalidateCodeMap(projectDir)
  if (!Buffer.isBuffer(buffer)) throw bad('Binary content must be a buffer.')
  if (buffer.length > MAX_FILE_BYTES) throw bad('That file is too large to write.')

  const abs = resolveInside(projectDir, relPath)
  const existed = existsSync(abs)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buffer)
  return {
    path: displayPath(projectDir, abs),
    action: existed ? 'updated' : 'created',
    bytes: buffer.length,
  }
}

/**
 * Replaces an exact substring. Fails loudly when `find` is missing or ambiguous —
 * a silent no-op edit is how an agent convinces itself it fixed something.
 */
export function editFile(projectDir, relPath, find, replace) {
  // The symbol map describes a project that just changed
  invalidateCodeMap(projectDir)
  if (typeof find !== 'string' || find.length === 0) throw bad('`find` text is required.')
  if (typeof replace !== 'string') throw bad('`replace` text is required.')

  const abs = resolveInside(projectDir, relPath, { mustExist: true })
  const before = readFileSync(abs, 'utf8')

  /*
   * Matched in tiers — exact, then line endings, then trailing space, then
   * indentation. Exact-only matching failed whenever the model reproduced a
   * snippet with one space or one CRLF different, and each failure cost a
   * re-read and a retry. Ambiguity is still refused at every tier.
   */
  const result = fuzzyReplace(before, find, replace)

  if (!result.ok) {
    if (result.reason === 'ambiguous') {
      throw bad(
        `The text to replace appears ${result.count} times in ${relPath}. Include more surrounding context to make it unique.`,
      )
    }
    const near = nearestMiss(before, find)
    throw bad(
      `The text to replace was not found in ${relPath}.` +
        (near.length > 0
          ? ` The closest lines are ${near.map((n) => `${n.line}: ${JSON.stringify(n.text)}`).join(', ')}. Read the file and copy the text exactly.`
          : ' Read the file first and copy the text exactly.'),
    )
  }

  writeFileSync(abs, result.text, 'utf8')
  return {
    path: displayPath(projectDir, abs),
    action: 'edited',
    linesBefore: before.split('\n').length,
    linesAfter: result.text.split('\n').length,
    line: result.line,
    /*
     * Reported so the agent can see it matched loosely. A tolerated mismatch is
     * still a mismatch, and one that keeps recurring is worth noticing.
     */
    ...(result.fuzz > 0 ? { matchedBy: result.tier } : {}),
  }
}

export function renameFile(projectDir, fromPath, toPath) {
  // The symbol map describes a project that just changed
  invalidateCodeMap(projectDir)
  const from = resolveInside(projectDir, fromPath, { mustExist: true })
  const to = resolveInside(projectDir, toPath)
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
  return { from: displayPath(projectDir, from), to: displayPath(projectDir, to), action: 'renamed' }
}

export function deleteFile(projectDir, relPath) {
  // The symbol map describes a project that just changed
  invalidateCodeMap(projectDir)
  const abs = resolveInside(projectDir, relPath, { mustExist: true })
  // Refuse to delete the project root itself
  if (relative(projectDir, abs) === '') throw bad('Refusing to delete the project root.')
  const isDir = statSync(abs).isDirectory()
  rmSync(abs, { recursive: isDir, force: false })
  return { path: displayPath(projectDir, abs), action: 'deleted', type: isDir ? 'dir' : 'file' }
}

/** Line-level diff summary — enough for the model and for a UI change list. */
export function diffText(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  let added = 0
  let removed = 0
  const setB = new Set(b)
  const setA = new Set(a)
  for (const line of b) if (!setA.has(line)) added++
  for (const line of a) if (!setB.has(line)) removed++
  return { added, removed }
}

/** A compact tree for prompts — cheaper than a full listing. */
export function projectTree(projectDir, { depth = 4 } = {}) {
  const { entries, truncated } = listFiles(projectDir, '.', { depth })
  const lines = entries.map((e) => {
    const indent = '  '.repeat(e.path.split('/').length - 1)
    const name = e.path.split('/').pop()
    if (e.type === 'dir') return `${indent}${name}/${e.skipped ? '  (skipped)' : ''}`
    return `${indent}${name}`
  })
  return { tree: lines.join('\n') || '(empty project)', truncated, fileCount: entries.filter((e) => e.type === 'file').length }
}

/**
 * Applies a multi-file patch.
 *
 * The patch module does the parsing and the matching; this supplies the
 * filesystem and, crucially, the containment. Every path in the patch goes
 * through `resolveInside` exactly like any other write — a patch asking for
 * `../../.env` is refused by the same guard that refuses it to `write_file`.
 *
 * Resolution happens for the whole patch before anything is written, so a
 * failure leaves the project untouched rather than half-changed.
 */
export function applyPatch(projectDir, patchText) {
  const parsed = parsePatch(patchText)

  // Refuse escapes up front, before any file is read
  for (const op of parsed.ops) resolveInside(projectDir, op.path)

  const io = {
    exists: (relPath) => {
      try {
        return existsSync(resolveInside(projectDir, relPath))
      } catch {
        return false
      }
    },
    read: (relPath) => readFileSync(resolveInside(projectDir, relPath, { mustExist: true }), 'utf8'),
  }

  const { plan, writes, deletes } = planPatch(parsed, io)

  // Everything resolved: now commit
  for (const { path: relPath, content } of writes) {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw bad(`${relPath} would be too large to write.`)
    const abs = resolveInside(projectDir, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  for (const relPath of deletes) {
    rmSync(resolveInside(projectDir, relPath, { mustExist: true }), { recursive: true, force: true })
  }

  invalidateCodeMap(projectDir)

  return {
    ok: true,
    files: plan.length,
    changes: plan,
    hint: 'All hunks applied. Run the tests or the build to confirm.',
  }
}

export const fileLimits = { maxFileBytes: MAX_FILE_BYTES, maxListEntries: MAX_LIST_ENTRIES, maxSearchHits: MAX_SEARCH_HITS, skipDirs: [...SKIP_DIRS] }
export { sep as pathSep }
