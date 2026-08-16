import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyReplace, nearestMiss } from '../server/agent/fuzzy-edit.mjs'

/* ============================================================
   Tolerant edit matching
   ----------------------
   An exact-only match failed whenever the model reproduced a
   snippet with one space or one CRLF wrong, costing a re-read and
   a retry each time.

   The two things that must stay true no matter how loose the
   matching gets: ambiguity is refused, and a fuzzy match never
   corrupts the indentation of the block it just matched.
   ============================================================ */

const fn = ['function greet(name) {', '  const msg = "hi " + name', '  return msg', '}'].join('\n')

describe('tiers', () => {
  test('an exact match uses the exact tier', () => {
    const r = fuzzyReplace(fn, '  return msg', '  return msg.trim()')
    assert.equal(r.ok, true)
    assert.equal(r.tier, 'exact')
    assert.equal(r.fuzz, 0)
    assert.ok(r.text.includes('msg.trim()'))
  })

  test('a stray carriage return still matches', () => {
    const r = fuzzyReplace(fn, '  const msg = "hi " + name\r\n  return msg', '  return `hi ${name}`')
    assert.equal(r.ok, true)
    assert.equal(r.tier, 'line-endings')
  })

  test('trailing whitespace is ignored', () => {
    const r = fuzzyReplace(fn, '  const msg = "hi " + name   \n  return msg', '  return `hi ${name}`')
    assert.equal(r.ok, true)
    assert.equal(r.tier, 'trailing-space')
  })

  test('the tier used is reported, so loose matches are visible', () => {
    assert.equal(fuzzyReplace(fn, '  return msg', 'x').fuzz, 0)
    assert.ok(fuzzyReplace(fn, '  return msg  \n}', 'x').fuzz > 0)
  })

  test('the matched line number is reported', () => {
    assert.equal(fuzzyReplace(fn, '  return msg', 'x').line, 3)
  })
})

describe('ambiguity is always refused', () => {
  const dup = ['a()', 'b()', 'a()'].join('\n')

  test('two exact matches are refused, not guessed at', () => {
    const r = fuzzyReplace(dup, 'a()', 'c()')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'ambiguous')
    assert.equal(r.count, 2)
  })

  test('a loose tier does not license picking one of several', () => {
    const spaced = ['  x = 1  ', '  y = 2', '  x = 1'].join('\n')
    const r = fuzzyReplace(spaced, '  x = 1', '  x = 9')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'ambiguous')
  })

  test('nothing matching is not_found, not a silent no-op', () => {
    const r = fuzzyReplace(fn, '  const nope = 1', '  const yes = 2')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not_found')
  })
})

describe('indentation', () => {
  const cls = [
    'class Cart {',
    '    total(items) {',
    '        let n = 0',
    '        return n',
    '    }',
    '}',
  ].join('\n')

  /* The failure this prevents: a 2-space model rewriting a 4-space file. */
  test('indentation is scaled by level, not shifted by difference', () => {
    const find = ['  total(items) {', '    let n = 0', '    return n', '  }'].join('\n')
    const replace = ['  total(items) {', '    return items.length', '  }'].join('\n')
    const r = fuzzyReplace(cls, find, replace)

    assert.equal(r.ok, true)
    assert.equal(r.tier, 'indentation')
    const lines = r.text.split('\n')
    assert.equal(lines[1], '    total(items) {', 'method lost the file’s indentation')
    assert.equal(lines[2], '        return items.length', 'body was shifted instead of scaled')
    assert.equal(lines[3], '    }')
  })

  test('the surrounding file is untouched', () => {
    const find = ['  total(items) {', '    let n = 0', '    return n', '  }'].join('\n')
    const r = fuzzyReplace(cls, find, ['  total() {', '    return 0', '  }'].join('\n'))
    const lines = r.text.split('\n')
    assert.equal(lines[0], 'class Cart {')
    assert.equal(lines.at(-1), '}')
  })

  test('mixed tabs and spaces degrade conservatively rather than corrupting', () => {
    const tabbed = ['function f() {', '\tif (a) {', '\t\treturn 1', '\t}', '}'].join('\n')
    const r = fuzzyReplace(tabbed, ['  if (a) {', '    return 1', '  }'].join('\n'), ['  if (a) {', '    return 2', '  }'].join('\n'))
    assert.equal(r.ok, true)
    assert.ok(r.text.includes('return 2'))
    assert.ok(r.text.startsWith('function f() {'), 'the file structure survived')
  })

  test('blank lines stay blank rather than becoming whitespace', () => {
    const src = ['class A {', '    m() {', '        x()', '    }', '}'].join('\n')
    const r = fuzzyReplace(src, ['  m() {', '    x()', '  }'].join('\n'), ['  m() {', '    x()', '', '    y()', '  }'].join('\n'))
    assert.equal(r.ok, true)
    assert.ok(r.text.split('\n').includes(''), 'a blank line became whitespace')
  })
})

describe('correctness under edit', () => {
  test('only the matched span changes', () => {
    const src = ['a', 'TARGET', 'b'].join('\n')
    const r = fuzzyReplace(src, 'TARGET', 'CHANGED')
    assert.equal(r.text, ['a', 'CHANGED', 'b'].join('\n'))
  })

  test('a multi-line replacement of different length works', () => {
    const src = ['a', 'one', 'two', 'b'].join('\n')
    const r = fuzzyReplace(src, ['one', 'two'].join('\n'), ['1', '2', '3'].join('\n'))
    assert.equal(r.text, ['a', '1', '2', '3', 'b'].join('\n'))
  })

  test('replacing with empty text deletes the span', () => {
    const src = ['a', 'gone', 'b'].join('\n')
    assert.equal(fuzzyReplace(src, 'gone\n', '').text, ['a', 'b'].join('\n'))
  })

  test('an edit at the start or end of a file works', () => {
    const src = ['first', 'mid', 'last'].join('\n')
    assert.ok(fuzzyReplace(src, 'first', 'FIRST').text.startsWith('FIRST'))
    assert.ok(fuzzyReplace(src, 'last', 'LAST').text.endsWith('LAST'))
  })
})

describe('nearest miss', () => {
  /* "Not found" is unactionable; naming the closest line usually fixes the retry. */
  test('a near miss is reported with its line number', () => {
    const near = nearestMiss(fn, '  const msg = "hello " + name')
    assert.ok(near.length > 0)
    assert.equal(near[0].line, 2)
  })

  test('unrelated text produces no misleading suggestion', () => {
    assert.equal(nearestMiss(fn, 'zzzzzzzzzz qqqqqqqqqq').length, 0)
  })

  test('whitespace-only input suggests nothing', () => {
    assert.deepEqual(nearestMiss(fn, '   \n  '), [])
  })
})
