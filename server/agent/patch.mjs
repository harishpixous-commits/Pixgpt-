import { fuzzyReplace } from './fuzzy-edit.mjs'

/* ============================================================
   Multi-file patches
   ------------------
   `edit_file` changes one place in one file. A real change is
   rarely one place: rename a function and three call sites move
   with it, add a route and the router, the handler and the test
   all change together.

   Doing that with `edit_file` costs one tool call per hunk, and
   each one can fail independently — leaving the project in a state
   where the function was renamed but two of its callers were not.

   This is Freebuff's patch format, which does the whole change in
   one call:

     *** Begin Patch
     *** Update File: src/lib/money.js
     @@ export function formatMoney(cents) {
     -  return '$' + cents
     +  return '$' + (cents / 100).toFixed(2)
     *** Add File: src/lib/tax.js
     +export const RATE = 0.2
     *** Delete File: src/old.js
     *** End Patch

   Three rules make it safe to apply unattended:

     · **All or nothing.** Every hunk is resolved against the current
       files before a single byte is written. A patch that half
       applies is worse than one that fails.
     · Context is matched through the same tiers as `edit_file`, so
       a stray CRLF does not fail a nine-hunk patch.
     · Every path is resolved by the caller through the workspace
       guard. This module never touches the filesystem.
   ============================================================ */

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const UPDATE = '*** Update File:'
const ADD = '*** Add File:'
const DELETE = '*** Delete File:'
const EOF_MARKER = '*** End of File'

/** Markers that terminate the body of a section. */
const TERMINATORS = [END, UPDATE, ADD, DELETE, EOF_MARKER]

const isTerminator = (line) => TERMINATORS.some((m) => line.startsWith(m)) || line.startsWith('@@')

class PatchError extends Error {}

/* ---------- parsing ---------- */

/**
 * Reads one hunk: its context lines and the changes inside it.
 *
 * A blank line in a diff is legitimately an empty string rather than a single
 * space, because editors and models both strip trailing whitespace. Treating
 * `''` as `' '` is what makes real-world patches parse at all.
 */
function readHunk(lines, start) {
  const before = []
  const after = []
  let index = start
  let sawChange = false

  while (index < lines.length && !isTerminator(lines[index])) {
    const raw = lines[index] === '' ? ' ' : lines[index]
    const marker = raw[0]
    const text = raw.slice(1)

    if (marker === '+') {
      after.push(text)
      sawChange = true
    } else if (marker === '-') {
      before.push(text)
      sawChange = true
    } else if (marker === ' ') {
      before.push(text)
      after.push(text)
    } else {
      throw new PatchError(`Invalid patch line (expected a leading '+', '-' or ' '): ${JSON.stringify(raw)}`)
    }
    index++
  }

  return { before, after, end: index, sawChange }
}

/**
 * Parses a patch into file operations.
 *
 * @returns {{ops: Array<{action:'update'|'add'|'delete', path:string, hunks?:object[], content?:string}>}}
 */
export function parsePatch(patchText) {
  const text = String(patchText ?? '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (!lines[i]?.startsWith(BEGIN)) {
    throw new PatchError(`A patch must start with "${BEGIN}".`)
  }
  i++

  const ops = []
  let sawEnd = false

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith(END)) {
      sawEnd = true
      break
    }
    if (line.trim() === '') {
      i++
      continue
    }

    if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim()
      if (!path) throw new PatchError('A "Delete File" section needs a path.')
      ops.push({ action: 'delete', path })
      i++
      continue
    }

    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim()
      if (!path) throw new PatchError('An "Add File" section needs a path.')
      i++
      const body = []
      while (i < lines.length && !isTerminator(lines[i])) {
        const raw = lines[i]
        // An added file is all `+` lines; tolerate a bare line rather than refuse
        body.push(raw.startsWith('+') ? raw.slice(1) : raw)
        i++
      }
      if (lines[i]?.startsWith(EOF_MARKER)) i++
      ops.push({ action: 'add', path, content: body.join('\n') })
      continue
    }

    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim()
      if (!path) throw new PatchError('An "Update File" section needs a path.')
      i++

      const hunks = []
      while (i < lines.length && !line.startsWith(END)) {
        if (lines[i]?.startsWith(END) || lines[i]?.startsWith(UPDATE) || lines[i]?.startsWith(ADD) || lines[i]?.startsWith(DELETE)) {
          break
        }
        // `@@ ...` is a locator line; its text is a hint, not part of the hunk
        if (lines[i]?.startsWith('@@')) {
          i++
          continue
        }
        if (lines[i]?.startsWith(EOF_MARKER)) {
          i++
          continue
        }
        if (lines[i] === undefined) break
        if (lines[i].trim() === '' && hunks.length > 0) {
          i++
          continue
        }

        const hunk = readHunk(lines, i)
        if (hunk.end === i) {
          i++
          continue
        }
        if (hunk.sawChange) hunks.push({ before: hunk.before, after: hunk.after })
        i = hunk.end
      }

      if (hunks.length === 0) throw new PatchError(`The section for ${path} contains no changes.`)
      ops.push({ action: 'update', path, hunks })
      continue
    }

    throw new PatchError(`Unexpected line in patch: ${JSON.stringify(line.slice(0, 80))}`)
  }

  if (!sawEnd) throw new PatchError(`The patch is missing its "${END}" marker.`)
  if (ops.length === 0) throw new PatchError('The patch contains no file operations.')
  return { ops }
}

/* ---------- applying ---------- */

/**
 * Resolves every hunk of an update against the file's current contents.
 *
 * Applied in order, each against the result of the last, so two hunks touching
 * nearby lines cannot both match the same text.
 */
function applyHunks(source, hunks, path) {
  let text = source
  const applied = []

  for (const [n, hunk] of hunks.entries()) {
    const find = hunk.before.join('\n')
    const replace = hunk.after.join('\n')

    if (find === replace) continue // context-only hunk; nothing to do

    const result = fuzzyReplace(text, find, replace)
    if (!result.ok) {
      throw new PatchError(
        result.reason === 'ambiguous'
          ? `Hunk ${n + 1} of ${path} matches ${result.count} places. Include more context lines around the change.`
          : `Hunk ${n + 1} of ${path} did not match the file. Read the file and copy the surrounding lines exactly.`,
      )
    }
    text = result.text
    applied.push({ hunk: n + 1, line: result.line, ...(result.fuzz > 0 ? { matchedBy: result.tier } : {}) })
  }

  return { text, applied }
}

/**
 * Applies a parsed patch.
 *
 * `io` isolates this module from the filesystem so the caller keeps the
 * workspace guard — every path goes through the same containment check as any
 * other write, and this module cannot reach outside it even if a patch asks to.
 *
 * @param {object} parsed          from parsePatch
 * @param {object} io
 * @param {(p:string)=>string} io.read
 * @param {(p:string)=>boolean} io.exists
 * @returns {{plan: object[], writes: Array<{path:string, content:string}>, deletes: string[]}}
 */
export function planPatch(parsed, io) {
  const plan = []
  const writes = []
  const deletes = []

  /*
   * Everything is resolved before anything is written. A patch that applies
   * three of its five hunks and then fails has left the project in a state
   * neither the user nor the agent asked for, and the agent usually cannot
   * tell that is what happened.
   */
  for (const op of parsed.ops) {
    if (op.action === 'delete') {
      if (!io.exists(op.path)) throw new PatchError(`Cannot delete ${op.path}: it does not exist.`)
      deletes.push(op.path)
      plan.push({ path: op.path, action: 'deleted' })
      continue
    }

    if (op.action === 'add') {
      if (io.exists(op.path)) {
        throw new PatchError(`Cannot add ${op.path}: it already exists. Use "Update File" instead.`)
      }
      writes.push({ path: op.path, content: op.content })
      plan.push({ path: op.path, action: 'created', lines: op.content.split('\n').length })
      continue
    }

    if (!io.exists(op.path)) throw new PatchError(`Cannot update ${op.path}: it does not exist.`)
    const source = io.read(op.path)
    const { text, applied } = applyHunks(source, op.hunks, op.path)
    writes.push({ path: op.path, content: text })
    plan.push({
      path: op.path,
      action: 'edited',
      hunks: op.hunks.length,
      ...(applied.some((a) => a.matchedBy) ? { matchedBy: applied.find((a) => a.matchedBy).matchedBy } : {}),
    })
  }

  return { plan, writes, deletes }
}

export { PatchError }
