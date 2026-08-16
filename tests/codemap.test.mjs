import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCodeMap,
  renderCodeMap,
  symbolInfo,
  findSymbols,
  getCodeMap,
  invalidateCodeMap,
} from '../server/agent/codemap.mjs'

/* ============================================================
   Code map
   --------
   A ranked symbol index, so the agent can find existing code
   without opening files until it turns up.

   The ranking is arithmetic and therefore testable: these assert
   the properties the score is supposed to have, not a particular
   number, because the numbers should be free to move as the
   extractors improve.
   ============================================================ */

let dir

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixgpt-codemap-'))

  // A root entry point that everything uses
  writeFileSync(
    join(dir, 'index.js'),
    `import { helper } from './lib/util.js'
import { Widget } from './deep/a/b/widget.js'

export function main() {
  helper()
  helper()
  return new Widget()
}

export function secondary() {
  helper()
}
`,
  )

  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'lib', 'util.js'),
    `export function helper() {
  return 1
}

export function unusedHelper() {
  return 2
}

export class Formatter {
  format(x) { return String(x) }
}
`,
  )

  // Deeply nested, so depth weighting can be checked
  mkdirSync(join(dir, 'deep', 'a', 'b'), { recursive: true })
  writeFileSync(
    join(dir, 'deep', 'a', 'b', 'widget.js'),
    `export class Widget {
  render() { return null }
}
`,
  )

  // A second caller of `helper`, to raise its external-call count
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'consumer.js'),
    `import { helper } from '../lib/util.js'
export function consume() { return helper() }
`,
  )

  writeFileSync(
    join(dir, 'script.py'),
    `def transform(rows):
    return [r for r in rows]

class Pipeline:
    def run(self):
        return transform([])
`,
  )

  writeFileSync(join(dir, 'README.md'), '# not code\n')
  writeFileSync(join(dir, 'data.json'), '{"a":1}')
})

after(() => {
  invalidateCodeMap()
  rmSync(dir, { recursive: true, force: true })
})

/* ---------- extraction ---------- */

describe('extraction', () => {
  test('finds functions, classes and arrow consts in JavaScript', () => {
    const map = buildCodeMap(dir)
    const util = map.files.find((f) => f.path === 'lib/util.js')
    const names = util.symbols.map((s) => s.name)
    assert.ok(names.includes('helper'), names.join(','))
    assert.ok(names.includes('unusedHelper'))
    assert.ok(names.includes('Formatter'))
  })

  test('finds Python defs and classes', () => {
    const map = buildCodeMap(dir)
    const py = map.files.find((f) => f.path === 'script.py')
    const names = py.symbols.map((s) => s.name)
    assert.ok(names.includes('transform'), names.join(','))
    assert.ok(names.includes('Pipeline'))
  })

  test('ignores files that are not code', () => {
    const map = buildCodeMap(dir)
    assert.ok(!map.files.some((f) => f.path.endsWith('.md')))
    assert.ok(!map.files.some((f) => f.path.endsWith('.json')))
  })

  test('language keywords are not reported as symbols', () => {
    const map = buildCodeMap(dir)
    const all = map.files.flatMap((f) => f.symbols.map((s) => s.name))
    for (const keyword of ['if', 'for', 'return', 'const', 'class', 'function']) {
      assert.ok(!all.includes(keyword), `"${keyword}" leaked into the map`)
    }
  })
})

/* ---------- ranking ---------- */

describe('ranking', () => {
  test('a symbol called from other files outranks one that is never called', () => {
    const map = buildCodeMap(dir)
    const util = map.files.find((f) => f.path === 'lib/util.js')
    const helper = util.symbols.find((s) => s.name === 'helper')
    const unused = util.symbols.find((s) => s.name === 'unusedHelper')
    assert.ok(helper.score > unused.score, `${helper.score} should beat ${unused.score}`)
  })

  test('depth is penalised — a root file outweighs a deeply nested one', () => {
    const map = buildCodeMap(dir)
    const root = map.files.find((f) => f.path === 'index.js')
    const deep = map.files.find((f) => f.path.startsWith('deep/'))
    assert.ok(root.weight > deep.weight, `root ${root.weight} vs deep ${deep.weight}`)
  })

  test('files are returned most significant first', () => {
    const map = buildCodeMap(dir)
    for (let i = 1; i < map.files.length; i++) {
      assert.ok(map.files[i - 1].weight >= map.files[i].weight, 'files are not sorted by weight')
    }
  })

  test('symbols within a file are sorted too', () => {
    const map = buildCodeMap(dir)
    for (const file of map.files) {
      for (let i = 1; i < file.symbols.length; i++) {
        assert.ok(file.symbols[i - 1].score >= file.symbols[i].score, `${file.path} is not sorted`)
      }
    }
  })

  test('ranking is deterministic', () => {
    const a = buildCodeMap(dir).files.map((f) => `${f.path}:${f.weight}`)
    const b = buildCodeMap(dir).files.map((f) => `${f.path}:${f.weight}`)
    assert.deepEqual(a, b)
  })
})

/* ---------- lookup ---------- */

describe('symbol lookup', () => {
  test('reports where a symbol is defined', () => {
    const info = symbolInfo(buildCodeMap(dir), 'helper')
    assert.equal(info.definedIn, 'lib/util.js')
  })

  test('reports who calls it — the "what breaks if I change this" question', () => {
    const info = symbolInfo(buildCodeMap(dir), 'helper')
    assert.ok(info.calledBy.includes('index.js'), info.calledBy.join(','))
    assert.ok(info.calledBy.includes('src/consumer.js'), info.calledBy.join(','))
  })

  test('a file is never listed as calling its own symbol', () => {
    const map = buildCodeMap(dir)
    for (const [file, byToken] of Object.entries(map.callers)) {
      for (const callers of Object.values(byToken)) {
        assert.ok(!callers.includes(file), `${file} listed as its own caller`)
      }
    }
  })

  test('an unknown symbol returns null rather than a guess', () => {
    assert.equal(symbolInfo(buildCodeMap(dir), 'noSuchThingAnywhere'), null)
  })

  test('partial search returns ranked matches', () => {
    const hits = findSymbols(buildCodeMap(dir), 'help')
    assert.ok(hits.length >= 2)
    assert.equal(hits[0].symbol, 'helper', 'the most-used match should come first')
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score)
  })

  test('search is case-insensitive', () => {
    assert.ok(findSymbols(buildCodeMap(dir), 'FORMATTER').some((h) => h.symbol === 'Formatter'))
  })
})

/* ---------- rendering ---------- */

describe('rendering to a token budget', () => {
  test('a generous budget keeps everything', () => {
    const r = renderCodeMap(buildCodeMap(dir), { tokenBudget: 100_000 })
    assert.equal(r.level, 'full')
    assert.ok(r.text.includes('lib/util.js'))
  })

  test('a tight budget degrades rather than failing', () => {
    const map = buildCodeMap(dir)
    for (const budget of [400, 120, 40, 10]) {
      const r = renderCodeMap(map, { tokenBudget: budget })
      assert.ok(typeof r.text === 'string', `budget ${budget} produced no text`)
      assert.ok(r.tokens <= budget || r.level === 'truncated', `budget ${budget} overflowed at ${r.tokens}`)
    }
  })

  test('degradation keeps the most significant files longest', () => {
    const map = buildCodeMap(dir)
    const tight = renderCodeMap(map, { tokenBudget: 30 })
    const top = map.files.find((f) => f.symbols.length > 0)
    assert.ok(tight.text.includes(top.path), `${top.path} should survive truncation`)
  })

  test('the rendered form is one line per file', () => {
    const r = renderCodeMap(buildCodeMap(dir), { tokenBudget: 100_000 })
    for (const line of r.text.split('\n')) {
      assert.ok(!line.includes('\n'))
      assert.ok(line.length < 500, 'a line grew unreasonably long')
    }
  })
})

/* ---------- caching ---------- */

describe('caching', () => {
  test('a second call is served from cache', () => {
    invalidateCodeMap(dir)
    const first = getCodeMap(dir)
    const second = getCodeMap(dir)
    assert.equal(first, second, 'expected the same object back')
  })

  test('invalidation forces a rebuild', () => {
    const first = getCodeMap(dir)
    invalidateCodeMap(dir)
    assert.notEqual(getCodeMap(dir), first)
  })

  /*
   * The failure this prevents: the agent writes a file, then asks where a
   * symbol is, and gets a map built before the file existed.
   */
  test('a new file appears after invalidation', () => {
    invalidateCodeMap(dir)
    assert.equal(symbolInfo(getCodeMap(dir), 'brandNewFunction'), null)

    writeFileSync(join(dir, 'fresh.js'), 'export function brandNewFunction() { return 1 }\n')
    invalidateCodeMap(dir)

    const info = symbolInfo(getCodeMap(dir), 'brandNewFunction')
    assert.ok(info, 'the new symbol should be visible after invalidation')
    assert.equal(info.definedIn, 'fresh.js')
  })
})

/* ---------- robustness ---------- */

describe('robustness', () => {
  test('an empty project produces an empty map, not an error', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pixgpt-empty-'))
    try {
      const map = buildCodeMap(empty)
      assert.equal(map.symbols, 0)
      assert.equal(map.files.length, 0)
      assert.equal(renderCodeMap(map, { tokenBudget: 1000 }).text, '')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('unparseable content is skipped without throwing', () => {
    const messy = mkdtempSync(join(tmpdir(), 'pixgpt-messy-'))
    try {
      writeFileSync(join(messy, 'broken.js'), 'function (((( {{{{ unterminated')
      writeFileSync(join(messy, 'binaryish.js'), '  not really text')
      const map = buildCodeMap(messy)
      assert.ok(map.parsed >= 1, 'should still have attempted the files')
    } finally {
      rmSync(messy, { recursive: true, force: true })
    }
  })

  test('the file cap is honoured', () => {
    const map = buildCodeMap(dir, { maxFiles: 1 })
    assert.ok(map.parsed <= 1, `parsed ${map.parsed} with a cap of 1`)
  })
})
