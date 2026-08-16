import { readFileSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { listFiles } from './files.mjs'

/* ============================================================
   Code map — a ranked symbol index of the project
   -----------------------------------------------
   The agent used to receive a bare file tree: names, no meaning.
   Finding where something lived meant reading files until it
   turned up, which costs a tool call and a chunk of context each
   time and often missed.

   This builds a map instead — for each file, the symbols it
   defines, ranked by how important they look — so the model can
   see `server/gateway/index.mjs · getGateway resolveConfig
   modelSupportsVision` and go straight there.

   The ranking is the interesting part, and it is deliberately
   arithmetic rather than a model call or an embedding index:

     base  = 0.8^depth · sqrt(lines / (symbols + 1))
     score = base · (1 + ln(1 + externalCallers))

   Three claims, each doing real work:

     · `0.8^depth` — a symbol at the root matters more than one
       buried six directories down. Entry points beat helpers.
     · `sqrt(lines / (symbols+1))` — a 400-line file with three
       exports has three significant symbols; a barrel file with
       eighty re-exports has eighty trivial ones. Density, not count.
     · `1 + ln(1 + callers)` — a function called from twelve other
       files is load-bearing. Logarithmic so a popular utility
       does not drown out everything else.

   Nothing here parses a full syntax tree. Extraction is per-language
   regex over declaration forms, which is wrong at the margins — it
   will miss a symbol defined by a macro and occasionally catch a
   word in a template literal — and entirely adequate for ranking.
   The alternative was a native tree-sitter dependency per language,
   which is a large amount of build surface for a list that only has
   to be roughly in the right order.
   ============================================================ */

/** Ceilings. A code map is an aid, not a reason for a request to hang. */
const LIMITS = {
  maxFiles: Number.parseInt(process.env.AGENT_CODEMAP_MAX_FILES ?? '', 10) || 600,
  maxFileBytes: 400_000,
  maxTotalBytes: 12_000_000,
  /** Callers recorded per symbol before the list is cut. */
  maxCallers: 25,
  /** Symbols shown per file in the rendered map. */
  topPerFile: 8,
}

/* ---------- language extraction ---------- */

/**
 * Per-language patterns.
 *
 * `defs` capture declarations; `calls` capture usage. Both are deliberately
 * conservative — a missed symbol costs a little ranking accuracy, whereas a
 * pattern that matches half the file would flood the map with noise.
 */
const LANGUAGES = {
  js: {
    ext: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
    defs: [
      /\bfunction\s+([A-Za-z_$][\w$]*)/g,
      /\bclass\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
      /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
      /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
    ],
    calls: [/\b([A-Za-z_$][\w$]{2,})\s*\(/g, /\.\s*([A-Za-z_$][\w$]{2,})\s*\(/g],
  },
  py: {
    ext: ['.py'],
    defs: [/^\s*def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
  go: {
    ext: ['.go'],
    defs: [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, /\btype\s+([A-Za-z_]\w*)/g],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
  rust: {
    ext: ['.rs'],
    defs: [/\bfn\s+([A-Za-z_]\w*)/g, /\b(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/g],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
  jvm: {
    ext: ['.java', '.kt', '.cs', '.scala'],
    defs: [
      /\b(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/g,
      /\b(?:public|private|protected|internal|static|final|override|suspend|\s)+[\w<>,[\]?]+\s+([A-Za-z_]\w*)\s*\(/g,
      /\bfun\s+([A-Za-z_]\w*)/g,
    ],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
  ruby: {
    ext: ['.rb'],
    defs: [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*)/gm, /^\s*(?:class|module)\s+([A-Za-z_]\w*)/gm],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
  c: {
    ext: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'],
    defs: [
      /\b(?:struct|class|enum|union)\s+([A-Za-z_]\w*)/g,
      /^[A-Za-z_][\w\s*&:<>,]*\s[*&]?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm,
    ],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
  php: {
    ext: ['.php'],
    defs: [/\bfunction\s+([A-Za-z_]\w*)/g, /\b(?:class|trait|interface)\s+([A-Za-z_]\w*)/g],
    calls: [/\b([A-Za-z_]\w{2,})\s*\(/g],
  },
}

const BY_EXT = new Map()
for (const [id, lang] of Object.entries(LANGUAGES)) for (const e of lang.ext) BY_EXT.set(e, { id, ...lang })

/**
 * Words that are syntax, not symbols.
 *
 * Without this the top of every ranking is `if`, `for` and `return`, because a
 * call pattern cannot tell a keyword from a function name.
 */
const IGNORE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'const', 'let', 'var',
  'new', 'typeof', 'instanceof', 'await', 'async', 'import', 'export', 'default', 'from', 'require',
  'console', 'log', 'error', 'warn', 'info', 'debug', 'this', 'super', 'null', 'true', 'false',
  'undefined', 'void', 'delete', 'throw', 'try', 'finally', 'else', 'case', 'break', 'continue',
  'def', 'self', 'print', 'len', 'str', 'int', 'dict', 'list', 'set', 'map', 'filter', 'range',
  'push', 'pop', 'slice', 'split', 'join', 'test', 'expect', 'describe', 'it', 'assert',
  'parse', 'stringify', 'then', 'catch2', 'forEach', 'includes', 'indexOf', 'toString', 'keys',
  'values', 'entries', 'has', 'get', 'add', 'size', 'length', 'match', 'replace', 'trim',
])

function extract(source, lang) {
  const identifiers = new Set()
  const calls = new Set()

  for (const re of lang.defs) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(source))) {
      if (m[1] && m[1].length > 1 && !IGNORE.has(m[1])) identifiers.add(m[1])
    }
  }
  for (const re of lang.calls) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(source))) {
      if (m[1] && m[1].length > 2 && !IGNORE.has(m[1])) calls.add(m[1])
    }
  }
  // A symbol a file defines is not an external call *by* that file
  for (const id of identifiers) calls.delete(id)

  return { identifiers: [...identifiers], calls: [...calls] }
}

/* ---------- building the map ---------- */

/**
 * Builds the ranked symbol index for a project.
 *
 * @param {string} projectDir
 * @returns {{ files: object[], symbols: number, parsed: number, skipped: number,
 *             callers: Record<string, Record<string, string[]>>, ms: number }}
 */
export function buildCodeMap(projectDir, { maxFiles = LIMITS.maxFiles } = {}) {
  const started = Date.now()
  const { entries } = listFiles(projectDir, '.', { depth: 8 })

  const scoresByFile = {}
  const callsByFile = new Map()
  const lineCounts = {}
  let parsed = 0
  let skipped = 0
  let totalBytes = 0

  for (const entry of entries) {
    if (entry.type !== 'file') continue
    if (parsed >= maxFiles || totalBytes >= LIMITS.maxTotalBytes) {
      skipped++
      continue
    }
    const lang = BY_EXT.get(extname(entry.path).toLowerCase())
    if (!lang) continue

    let source
    try {
      const abs = join(projectDir, entry.path.split('/').join(sep))
      if (statSync(abs).size > LIMITS.maxFileBytes) {
        skipped++
        continue
      }
      source = readFileSync(abs, 'utf8')
    } catch {
      skipped++
      continue
    }

    totalBytes += source.length
    parsed++

    const { identifiers, calls } = extract(source, lang)
    const numLines = source.split('\n').length
    lineCounts[entry.path] = numLines

    /*
     * Depth measured in path separators, and density as lines per symbol.
     * A file with no symbols at all still gets an entry so the tree stays
     * complete — it simply contributes nothing to the ranking.
     */
    const depth = entry.path.split('/').length - 1
    const base = 0.8 ** depth * Math.sqrt(numLines / (identifiers.length + 1))

    const scores = {}
    for (const id of identifiers) scores[id] = base
    scoresByFile[entry.path] = scores
    callsByFile.set(entry.path, calls)
  }

  /* --- which file defines each symbol, and who calls it --- */

  const definedIn = new Map()
  const best = new Map()
  for (const [file, scores] of Object.entries(scoresByFile)) {
    for (const [token, score] of Object.entries(scores)) {
      if (score > (best.get(token) ?? -Infinity)) {
        best.set(token, score)
        definedIn.set(token, file)
      }
    }
  }

  const callers = {}
  const externalCalls = {}
  for (const [caller, calls] of callsByFile) {
    for (const call of calls) {
      const owner = definedIn.get(call)
      if (!owner || owner === caller) continue
      externalCalls[call] = (externalCalls[call] ?? 0) + 1
      const byToken = (callers[owner] ??= {})
      const list = (byToken[call] ??= [])
      if (list.length < LIMITS.maxCallers && !list.includes(caller)) list.push(caller)
    }
  }

  // Boost by cross-file usage — the load-bearing symbols rise
  for (const scores of Object.values(scoresByFile)) {
    for (const token of Object.keys(scores)) {
      scores[token] *= 1 + Math.log(1 + (externalCalls[token] ?? 0))
      scores[token] = Math.round(scores[token] * 1000) / 1000
    }
  }

  const files = Object.entries(scoresByFile)
    .map(([path, scores]) => ({
      path,
      lines: lineCounts[path] ?? 0,
      symbols: Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .map(([name, score]) => ({ name, score })),
      /** The file's own weight: its best symbol. Used to order the map. */
      weight: Math.max(0, ...Object.values(scores)),
    }))
    .sort((a, b) => b.weight - a.weight)

  return {
    files,
    symbols: files.reduce((n, f) => n + f.symbols.length, 0),
    parsed,
    skipped,
    callers,
    ms: Date.now() - started,
  }
}

/* ---------- rendering ---------- */

/** Rough token estimate. Four characters per token is close enough to budget with. */
const estimateTokens = (text) => Math.ceil(text.length / 4)

/**
 * Renders the map to fit a token budget, degrading in a defined order.
 *
 * The order matters more than the numbers: losing symbol detail is a smaller
 * loss than losing files, and losing low-ranked files is a smaller loss than
 * truncating the middle of the list arbitrarily.
 *
 *   1. every file, up to `topPerFile` symbols each
 *   2. fewer symbols per file
 *   3. only files that have symbols
 *   4. the highest-weighted files only
 *
 * @returns {{ text: string, level: string, tokens: number, files: number }}
 */
export function renderCodeMap(map, { tokenBudget = 3000, topPerFile = LIMITS.topPerFile } = {}) {
  const render = (files, perFile) =>
    files
      .map((f) => {
        const names = f.symbols.slice(0, perFile).map((s) => s.name)
        return names.length > 0 ? `${f.path} · ${names.join(' ')}` : f.path
      })
      .join('\n')

  for (const [level, files, perFile] of [
    ['full', map.files, topPerFile],
    ['fewer-symbols', map.files, 4],
    ['symbols-only', map.files.filter((f) => f.symbols.length > 0), 4],
    ['top-files', map.files.filter((f) => f.symbols.length > 0).slice(0, 60), 3],
    ['minimal', map.files.filter((f) => f.symbols.length > 0).slice(0, 25), 2],
  ]) {
    const text = render(files, perFile)
    const tokens = estimateTokens(text)
    if (tokens <= tokenBudget) return { text, level, tokens, files: files.length }
  }

  // Even `minimal` overflows: cut to the budget rather than return nothing
  const files = map.files.filter((f) => f.symbols.length > 0).slice(0, 25)
  const text = render(files, 2).slice(0, tokenBudget * 4)
  return { text, level: 'truncated', tokens: estimateTokens(text), files: files.length }
}

/**
 * Who calls a symbol, and where it is defined.
 *
 * Answers "what breaks if I change this" before an edit rather than after the
 * test run — the question the file tree could never answer.
 */
export function symbolInfo(map, name) {
  const defining = map.files.find((f) => f.symbols.some((s) => s.name === name))
  if (!defining) return null
  const entry = defining.symbols.find((s) => s.name === name)
  return {
    name,
    definedIn: defining.path,
    score: entry.score,
    calledBy: map.callers[defining.path]?.[name] ?? [],
  }
}

/* ---------- caching ---------- */

/**
 * One map per project, rebuilt when the project changes.
 *
 * Rebuilding takes ~100ms on a 150-file project, which is cheap once and
 * wasteful on every tool call. The agent edits files constantly, so the cache
 * is invalidated explicitly on write rather than given a TTL — a stale map that
 * omits the file just created is worse than no map at all.
 *
 * @type {Map<string, {map: object, at: number}>}
 */
const CACHE = new Map()

/** Longest a map is trusted without an explicit invalidation. */
const CACHE_TTL_MS = 120_000

export function getCodeMap(projectDir, options) {
  const hit = CACHE.get(projectDir)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map
  const map = buildCodeMap(projectDir, options)
  CACHE.set(projectDir, { map, at: Date.now() })
  return map
}

/** Called after any write, edit, rename or delete. */
export function invalidateCodeMap(projectDir) {
  if (projectDir) CACHE.delete(projectDir)
  else CACHE.clear()
}

/** Files whose symbols match a query, best first. For locating work. */
export function findSymbols(map, query, { limit = 20 } = {}) {
  const q = String(query).toLowerCase()
  const hits = []
  for (const file of map.files) {
    for (const symbol of file.symbols) {
      if (symbol.name.toLowerCase().includes(q)) {
        hits.push({ symbol: symbol.name, file: file.path, score: symbol.score })
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

export { LIMITS as codeMapLimits }
