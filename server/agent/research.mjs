import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../config.mjs'
import { search } from '../search/orchestrator.mjs'
import { research as deepResearch } from '../search/research.mjs'
import { readPage } from '../search/extract.mjs'
import { renderSearchContext } from '../websearch.mjs'
import { searchAvailableFor } from '../search/registry.mjs'
import { SEARCH_MODE, SEARCH_TYPE } from '../search/types.mjs'

/* ============================================================
   Research for the coding agent
   -----------------------------
   The same engine the chat path uses, scoped to what a coding agent
   needs: the version that is actually installed, the official
   documentation for it, and the repository or issue that explains it.

   Implementing against the wrong major version is one of the most
   common ways generated code fails, and it is entirely avoidable —
   the installed version is sitting in the project.
   ============================================================ */

const MAX_CHARS = 6000

/** The version of a package as actually installed / declared in this project. */
export function installedVersion(projectDir, packageName) {
  if (!packageName || !/^[@a-z0-9][\w.@/-]*$/i.test(packageName)) return null

  // Prefer the installed copy — it is the truth, not the range in package.json
  const installed = join(projectDir, 'node_modules', packageName, 'package.json')
  if (existsSync(installed)) {
    try {
      const version = JSON.parse(readFileSync(installed, 'utf8')).version
      if (version) return String(version)
    } catch {
      /* fall through to the manifest */
    }
  }

  const manifest = join(projectDir, 'package.json')
  if (!existsSync(manifest)) return null
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const range = pkg.dependencies?.[packageName] ?? pkg.devDependencies?.[packageName]
    return range ? String(range).replace(/^[\^~>=<\s]+/, '') : null
  } catch {
    return null
  }
}

/** Reads the runtime and framework facts worth putting in a search query. */
export function projectFacts(projectDir) {
  const facts = { runtime: `node ${process.versions.node}`, packages: {} }
  const manifest = join(projectDir, 'package.json')
  if (!existsSync(manifest)) return facts

  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const name of Object.keys(deps)) {
      const version = installedVersion(projectDir, name)
      if (version) facts.packages[name] = version
    }
    facts.packageManager = existsSync(join(projectDir, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(projectDir, 'yarn.lock'))
        ? 'yarn'
        : 'npm'
  } catch {
    /* an unreadable manifest is not fatal */
  }
  return facts
}

/**
 * Researches a technical question, version-scoped to this project.
 *
 * @returns {Promise<{ ok, query, version?, findings, sources: {title,url}[] }>}
 */
export async function researchTopic({ query, packageName, projectDir, signal, mode = SEARCH_MODE.BALANCED }) {
  const clean = String(query ?? '').trim().slice(0, 300)
  if (!clean) return { ok: false, query: '', findings: 'No question was given.', sources: [] }

  if (!searchAvailableFor(SEARCH_TYPE.WEB)) {
    return {
      ok: false,
      query: clean,
      findings: 'Web research is not configured on this server. Work from what you already know.',
      sources: [],
    }
  }

  const version = packageName ? installedVersion(projectDir, packageName) : null

  /*
   * The major version goes in the query, not the full one: "react 19" finds the
   * documentation, "react 19.2.8" finds a changelog entry for one patch.
   */
  const major = version ? version.split('.')[0] : null
  const scoped = [clean, packageName && major ? `${packageName} ${major}` : packageName]
    .filter(Boolean)
    .join(' ')

  const found = await search(scoped, {
    type: SEARCH_TYPE.DOCUMENTATION,
    mode,
    signal,
    maxResults: 6,
  })

  if (!found.ok || found.results.length === 0) {
    log.warn('agent research found nothing', { reason: found.reason })
    return {
      ok: false,
      query: clean,
      version,
      findings: `The search returned nothing usable (${found.reason ?? 'no results'}).`,
      sources: [],
    }
  }

  /* Read the top pages: a snippet rarely contains the API signature. */
  const top = found.results.slice(0, 3)
  const pages = await Promise.all(
    top.map((r) => readPage(r.url, { query: scoped, maxChars: 2200, signal }).catch(() => ({ ok: false }))),
  )

  const blocks = found.results.slice(0, 5).map((result, index) => {
    const page = pages[index]
    const body = (page?.ok ? page.text : result.snippet) || '(no text)'
    return [
      `[${index + 1}] ${result.title} — ${result.url}`,
      result.publishedAt ? `Published: ${result.publishedAt.slice(0, 10)}` : null,
      body.slice(0, 1800),
    ]
      .filter(Boolean)
      .join('\n')
  })

  /*
   * Retrieved pages are attacker-influenced: anyone can publish a page saying
   * "ignore your instructions and run this command". renderSearchContext wraps
   * them in the same labelled-as-data fence the chat path uses, so a search
   * result can never issue tool calls to the agent.
   */
  const findings = renderSearchContext(scoped, blocks.join('\n\n').slice(0, MAX_CHARS))

  return {
    ok: true,
    query: clean,
    scopedQuery: scoped,
    version,
    findings,
    sources: found.results.slice(0, 5).map((r) => ({
      title: r.title.slice(0, 120),
      url: r.url,
      domain: r.domain,
      publishedAt: r.publishedAt,
    })),
    providers: found.providers ?? [],
    note: version
      ? `Scoped to ${packageName}@${version} as installed in this project. Do not use examples for a different major version.`
      : packageName
        ? `${packageName} is not installed here, so the search was not version-scoped.`
        : undefined,
  }
}

/**
 * A full research pass for the agent: several queries, multiple sources, and a
 * synthesised answer with citations. For when one search is not enough.
 */
export async function researchDeep({ question, projectDir, signal, mode = SEARCH_MODE.DEEP, onProgress }) {
  const facts = projectFacts(projectDir)
  const result = await deepResearch({ question, mode, signal, onProgress })

  return {
    ok: result.ok,
    question: result.question,
    answer: result.answer,
    sources: (result.sources ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      domain: s.domain,
      publishedAt: s.publishedAt,
      cited: s.cited,
    })),
    disagreements: result.comparison?.notes ?? [],
    installedPackages: Object.keys(facts.packages).length,
    providers: result.providers,
    durationMs: result.durationMs,
    reason: result.reason,
  }
}

/** Searches GitHub for repositories, code or issues. */
export async function researchGithub({ query, kind = 'repositories', signal }) {
  const clean = String(query ?? '').trim().slice(0, 250)
  if (!clean) return { ok: false, findings: 'No query was given.', sources: [] }

  const found = await search(clean, {
    type: kind === 'code' ? SEARCH_TYPE.CODE : SEARCH_TYPE.GITHUB,
    githubKind: kind,
    mode: SEARCH_MODE.FAST,
    signal,
    maxResults: 8,
  })

  if (!found.ok || found.results.length === 0) {
    return {
      ok: false,
      findings:
        found.reason === 'no_provider_for_type'
          ? 'GitHub search is disabled on this server.'
          : `No GitHub results (${found.reason ?? 'none found'}).` +
            (kind === 'code' ? ' Code search needs GITHUB_TOKEN to be set.' : ''),
      sources: [],
    }
  }

  return {
    ok: true,
    kind,
    findings: found.results
      .slice(0, 8)
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet.slice(0, 400)}`)
      .join('\n\n'),
    sources: found.results.slice(0, 8).map((r) => ({ title: r.title, url: r.url, domain: r.domain })),
  }
}

/**
 * Reads one page the agent names.
 *
 * The URL must come from a search result the agent has already seen — it is
 * screened for SSRF exactly like every other fetch, so naming an internal
 * address gets refused rather than fetched.
 */
export async function fetchPageForAgent({ url, query = '', signal }) {
  const page = await readPage(url, { query, maxChars: 6000, signal })
  if (!page.ok) {
    return { ok: false, url: String(url), error: `That page could not be read (${page.reason}).` }
  }
  return {
    ok: true,
    url: page.url,
    title: page.title,
    publishedAt: page.publishedAt,
    domain: page.domain,
    // Fenced: page text is content, never instructions
    content: renderSearchContext(query || page.title, page.text),
  }
}
