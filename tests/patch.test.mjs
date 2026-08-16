import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatch, planPatch, PatchError } from '../server/agent/patch.mjs'

/* ============================================================
   Multi-file patches
   ------------------
   `edit_file` changes one place. A real change is rarely one
   place, and doing it as N sequential edits means N chances to
   half-finish — the function renamed, two of its callers not.

   The load-bearing property is atomicity: every hunk resolves
   before anything is written.
   ============================================================ */

let dir
const io = () => ({
  exists: (p) => existsSync(join(dir, p)),
  read: (p) => readFileSync(join(dir, p), 'utf8'),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixgpt-patch-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'a.js'), 'const a = 1\nconst keep = true\n')
  writeFileSync(join(dir, 'src', 'b.js'), 'export function b() {\n  return 2\n}\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const patch = (...body) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

describe('parsing', () => {
  test('an update section with one hunk', () => {
    const { ops } = parsePatch(patch('*** Update File: a.js', '-const a = 1', '+const a = 2'))
    assert.equal(ops.length, 1)
    assert.equal(ops[0].action, 'update')
    assert.equal(ops[0].path, 'a.js')
    assert.equal(ops[0].hunks.length, 1)
  })

  test('context lines are kept on both sides of the hunk', () => {
    const { ops } = parsePatch(patch('*** Update File: a.js', ' const keep = true', '-const a = 1', '+const a = 2'))
    const [hunk] = ops[0].hunks
    assert.deepEqual(hunk.before, ['const keep = true', 'const a = 1'])
    assert.deepEqual(hunk.after, ['const keep = true', 'const a = 2'])
  })

  test('add, update and delete in one patch', () => {
    const { ops } = parsePatch(
      patch('*** Update File: a.js', '-const a = 1', '+const a = 2', '*** Add File: c.js', '+x', '*** Delete File: d.js'),
    )
    assert.deepEqual(ops.map((o) => o.action), ['update', 'add', 'delete'])
  })

  test('an @@ locator line is a hint, not content', () => {
    const { ops } = parsePatch(patch('*** Update File: a.js', '@@ const a = 1', '-const a = 1', '+const a = 2'))
    assert.equal(ops[0].hunks.length, 1)
    assert.ok(!JSON.stringify(ops[0].hunks).includes('@@'))
  })

  /* Editors and models both strip trailing whitespace from blank lines. */
  test('a blank line is treated as a context line', () => {
    const { ops } = parsePatch(patch('*** Update File: a.js', ' const keep = true', '', '-const a = 1', '+const a = 2'))
    assert.ok(ops[0].hunks[0].before.includes(''))
  })

  test('an added file keeps its content verbatim', () => {
    const { ops } = parsePatch(patch('*** Add File: c.js', '+line one', '+line two'))
    assert.equal(ops[0].content, 'line one\nline two')
  })
})

describe('malformed patches are refused', () => {
  const cases = [
    ['no begin marker', 'just text'],
    ['no end marker', '*** Begin Patch\n*** Update File: a.js\n-const a = 1\n+const a = 2'],
    ['no operations', '*** Begin Patch\n*** End Patch'],
    ['update with no changes', patch('*** Update File: a.js')],
    ['path missing', patch('*** Update File:', '-x', '+y')],
    ['bad line marker', patch('*** Update File: a.js', '?const a = 1')],
  ]
  for (const [label, text] of cases) {
    test(label, () => assert.throws(() => parsePatch(text), PatchError))
  }
})

describe('applying', () => {
  test('a single-file edit resolves', () => {
    const { plan, writes } = planPatch(parsePatch(patch('*** Update File: a.js', '-const a = 1', '+const a = 2')), io())
    assert.equal(plan[0].action, 'edited')
    assert.ok(writes[0].content.includes('const a = 2'))
    assert.ok(writes[0].content.includes('const keep = true'), 'untouched lines survived')
  })

  test('several files in one patch', () => {
    const { plan } = planPatch(
      parsePatch(
        patch(
          '*** Update File: a.js',
          '-const a = 1',
          '+const a = 2',
          '*** Update File: src/b.js',
          '-  return 2',
          '+  return 3',
          '*** Add File: src/c.js',
          '+export const c = 3',
          '*** Delete File: a.js',
        ),
      ),
      io(),
    )
    assert.equal(plan.length, 4)
    assert.deepEqual(plan.map((p) => p.action), ['edited', 'edited', 'created', 'deleted'])
  })

  /* `@@` separates hunks within a file section — a bare blank line is context. */
  test('hunks apply in order, each against the previous result', () => {
    const { writes } = planPatch(
      parsePatch(
        patch(
          '*** Update File: a.js',
          '@@',
          '-const a = 1',
          '+const a = 2',
          '@@',
          '-const keep = true',
          '+const keep = false',
        ),
      ),
      io(),
    )
    assert.ok(writes[0].content.includes('const a = 2'))
    assert.ok(writes[0].content.includes('const keep = false'))
  })

  test('two hunks in one section are parsed as two, not merged', () => {
    const { ops } = parsePatch(
      patch('*** Update File: a.js', '@@', '-const a = 1', '+const a = 2', '@@', '-const keep = true', '+const keep = false'),
    )
    assert.equal(ops[0].hunks.length, 2)
  })

  /* The property the whole tool exists for. */
  test('one bad hunk fails the whole patch, before anything is written', () => {
    assert.throws(
      () =>
        planPatch(
          parsePatch(
            patch('*** Update File: a.js', '-const a = 1', '+const a = 2', '*** Update File: src/b.js', '-NOT PRESENT', '+x'),
          ),
          io(),
        ),
      PatchError,
    )
    // planPatch never writes; the caller commits only on success
    assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'const a = 1\nconst keep = true\n')
  })

  test('updating a file that does not exist is refused', () => {
    assert.throws(() => planPatch(parsePatch(patch('*** Update File: nope.js', '-x', '+y')), io()), /does not exist/)
  })

  test('adding over an existing file is refused', () => {
    assert.throws(() => planPatch(parsePatch(patch('*** Add File: a.js', '+x')), io()), /already exists/)
  })

  test('deleting a file that does not exist is refused', () => {
    assert.throws(() => planPatch(parsePatch(patch('*** Delete File: nope.js')), io()), /does not exist/)
  })

  test('an ambiguous hunk is refused rather than guessed at', () => {
    writeFileSync(join(dir, 'dup.js'), 'x()\ny()\nx()\n')
    assert.throws(() => planPatch(parsePatch(patch('*** Update File: dup.js', '-x()', '+z()')), io()), /matches 2 places/)
  })
})

describe('tolerant context matching', () => {
  /* Reuses edit_file's tiers, so one stray CRLF cannot fail a nine-hunk patch. */
  test('a hunk with the wrong line ending still applies', () => {
    const { plan } = planPatch(parsePatch(patch('*** Update File: a.js', '-const a = 1\r', '+const a = 2')), io())
    assert.equal(plan[0].action, 'edited')
  })

  test('a loose match is reported, not hidden', () => {
    const { plan } = planPatch(parsePatch(patch('*** Update File: a.js', '-const a = 1   ', '+const a = 2')), io())
    assert.ok(plan[0].matchedBy, 'a fuzzy match should say so')
  })
})
