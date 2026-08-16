/* ============================================================
   Tolerant edit matching
   ----------------------
   `edit_file` used to require an exact substring match. That is
   correct and it is brittle: the model reproduces a snippet from
   memory or from a file it read three tool calls ago, gets one
   space or one line ending wrong, and the edit fails. The agent
   then re-reads the file and tries again, which costs two tool
   calls and sometimes ends in it rewriting the whole file instead.

   The fix, taken from Freebuff's patch applier: do not match once,
   match in tiers, from strictest to loosest.

     0  exact
     1  line endings normalised          (CRLF vs LF)
     2  trailing whitespace ignored      (invisible, never meaningful)
     3  indentation ignored              (re-indented on the way back in)

   Two rules keep looseness from becoming damage:

     · Ambiguity is still an error at every tier. Matching three
       places loosely is not permission to pick one.
     · Tier 3 re-indents the replacement to the indentation actually
       found in the file. Matching indentation-insensitively and
       then writing the model's indentation verbatim would corrupt
       the block it just matched.

   The tier used is reported, so a agent that matched loosely knows
   it did.
   ============================================================ */

/** How each tier compares two lines. Strictest first; order is the algorithm. */
const TIERS = [
  { fuzz: 0, name: 'exact', compare: (a, b) => a === b },
  { fuzz: 1, name: 'line-endings', compare: (a, b) => a.replace(/\r$/, '') === b.replace(/\r$/, '') },
  { fuzz: 2, name: 'trailing-space', compare: (a, b) => a.trimEnd() === b.trimEnd() },
  { fuzz: 3, name: 'indentation', compare: (a, b) => a.trim() === b.trim() },
]

const leadingWhitespace = (line) => /^[ \t]*/.exec(line)[0]

/**
 * Every start line where `needle` matches `haystack` under `compare`.
 *
 * Returns all of them rather than the first: the caller has to be able to tell
 * "found it" from "found it three times", and a loose tier makes the second far
 * more likely than an exact match would.
 */
function matchesAt(haystack, needle, compare) {
  const hits = []
  if (needle.length === 0 || needle.length > haystack.length) return hits

  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (!compare(haystack[i + j], needle[j])) {
        ok = false
        break
      }
    }
    if (ok) hits.push(i)
  }
  return hits
}

/**
 * Re-indents a replacement block to sit where the match was found.
 *
 * Indentation has to be **scaled, not shifted**. A model writing 2-space
 * indentation into a 4-space file nests by 2 per level; shifting every line by
 * the +2 difference leaves the body of a method at 6 spaces where the file
 * wants 8. Scaling by levels puts it at 8.
 *
 * Falls back to a plain prefix when scaling cannot be trusted — mixed tabs and
 * spaces, or a model that used no base indent at all. Getting this wrong
 * corrupts the block that was just matched, so the uncertain case does the
 * conservative thing.
 */
function reindent(replacementLines, foundIndent, modelIndent) {
  if (foundIndent === modelIndent) return replacementLines

  const sameKind =
    (/^ *$/.test(foundIndent) && /^ *$/.test(modelIndent)) || (/^\t*$/.test(foundIndent) && /^\t*$/.test(modelIndent))
  const unit = modelIndent.length
  const scalable = sameKind && unit > 0 && foundIndent.length > 0

  return replacementLines.map((line) => {
    if (line.trim() === '') return ''
    const own = leadingWhitespace(line)
    const body = line.slice(own.length)

    if (!scalable) {
      // No reliable unit: strip the model's base if present, then prefix
      const relative = own.startsWith(modelIndent) ? own.slice(modelIndent.length) : own
      return foundIndent + relative + body
    }

    const levels = own.length / unit
    // A line that is not on a level boundary is left relative rather than guessed at
    if (!Number.isInteger(levels)) return foundIndent + own.slice(Math.min(unit, own.length)) + body
    return foundIndent.repeat(levels) + body
  })
}

/**
 * Locates `find` in `source` and returns the edited text.
 *
 * @param {string} source
 * @param {string} find
 * @param {string} replace
 * @returns {{ ok: true, text: string, tier: string, fuzz: number, line: number }
 *          | { ok: false, reason: 'not_found'|'ambiguous', tier?: string, count?: number }}
 */
export function fuzzyReplace(source, find, replace) {
  /*
   * The exact path first, on the raw strings. It is the common case, it is
   * cheapest, and it is the only tier that can safely operate on a substring
   * rather than whole lines — a find that starts mid-line is legitimate and
   * the line-based tiers below cannot represent it.
   */
  const exactCount = source.split(find).length - 1
  if (exactCount === 1) {
    const index = source.indexOf(find)
    return {
      ok: true,
      text: source.slice(0, index) + replace + source.slice(index + find.length),
      tier: 'exact',
      fuzz: 0,
      line: source.slice(0, index).split('\n').length,
    }
  }
  if (exactCount > 1) return { ok: false, reason: 'ambiguous', tier: 'exact', count: exactCount }

  /* --- line-based tiers --- */

  const sourceLines = source.split('\n')
  const findLines = find.split('\n')
  const replaceLines = replace.split('\n')

  for (const tier of TIERS.slice(1)) {
    const hits = matchesAt(sourceLines, findLines, tier.compare)
    if (hits.length === 0) continue
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', tier: tier.name, count: hits.length }

    const start = hits[0]
    let block = replaceLines

    if (tier.fuzz === 3) {
      // Match the file's indentation, not the model's recollection of it
      const foundIndent = leadingWhitespace(sourceLines[start])
      const modelIndent = leadingWhitespace(findLines[0])
      block = reindent(replaceLines, foundIndent, modelIndent)
    }

    const out = [...sourceLines.slice(0, start), ...block, ...sourceLines.slice(start + findLines.length)]
    return { ok: true, text: out.join('\n'), tier: tier.name, fuzz: tier.fuzz, line: start + 1 }
  }

  return { ok: false, reason: 'not_found' }
}

/**
 * A hint for the model when nothing matched.
 *
 * "Not found" tells it nothing it can act on. Naming the closest line, and how
 * close it was, usually turns the next attempt into a hit — the mismatch is
 * nearly always one line of the block rather than the whole thing.
 */
export function nearestMiss(source, find, { limit = 3 } = {}) {
  const sourceLines = source.split('\n')
  const firstMeaningful = find.split('\n').find((l) => l.trim().length > 0)
  if (!firstMeaningful) return []

  const target = firstMeaningful.trim()
  const scored = []

  for (const [i, line] of sourceLines.entries()) {
    const candidate = line.trim()
    if (candidate.length === 0) continue
    // Cheap similarity: shared prefix over the longer length. Good enough to
    // rank "nearly right" above "unrelated", which is all this has to do.
    let shared = 0
    while (shared < target.length && shared < candidate.length && target[shared] === candidate[shared]) shared++
    const score = shared / Math.max(target.length, candidate.length)
    if (score > 0.4) scored.push({ line: i + 1, text: line.slice(0, 120), score: Math.round(score * 100) / 100 })
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}
