import { log } from '../config.mjs'
import { getGateway } from '../gateway/index.mjs'
import { rank } from './ranking.mjs'
import { recordSuccess, recordFailure, classifyFailure } from './health.mjs'
import { noteSuccess, noteFailure } from './registry.mjs'

/* ============================================================
   Optional multi-model verification
   ---------------------------------
   Sections 17, 18 and 19. A second model reviews the first one's
   work, and a third settles disagreements.

   This is off by default and stays off by default. Section 17 is
   explicit — "do not run ensembles for every chat" — because the
   cost is linear in the number of models and the benefit only
   appears where a mistake is expensive: security-sensitive
   changes, architecture decisions, research that will be cited.

   The reviewer never edits anything. Section 18: its output is a
   list of claims handed back to the primary, which decides. That
   ordering is what keeps one model from silently overwriting
   another's work with a confident wrong opinion.
   ============================================================ */

/** Where an ensemble is worth the money. Anything else runs single-model. */
export const ENSEMBLE_KINDS = Object.freeze({
  CODE_REVIEW: 'code_review',
  SECURITY: 'security',
  RESEARCH: 'research',
  ARCHITECTURE: 'architecture',
})

const KIND_TASKS = {
  [ENSEMBLE_KINDS.CODE_REVIEW]: { primary: 'BEST_CODING', reviewer: 'BEST_REASONING' },
  [ENSEMBLE_KINDS.SECURITY]: { primary: 'BEST_REASONING', reviewer: 'BEST_CODING' },
  [ENSEMBLE_KINDS.RESEARCH]: { primary: 'BEST_RESEARCH', reviewer: 'BEST_REASONING' },
  [ENSEMBLE_KINDS.ARCHITECTURE]: { primary: 'BEST_REASONING', reviewer: 'BEST_GENERAL' },
}

const MAX_TOKENS = Number.parseInt(process.env.PIXGPT_ENSEMBLE_MAX_TOKENS ?? '', 10) || 1200

/**
 * Picks distinct models for the roles.
 *
 * "Independent" is the whole point (section 18): two routes into the same model
 * agree with each other by construction, so the reviewer must differ from the
 * primary in *family* wherever the catalogue allows it.
 */
export function ensembleRoster(kind, { size = 2, options = {} } = {}) {
  const spec = KIND_TASKS[kind]
  if (!spec) throw new Error(`unknown ensemble kind: ${kind}`)

  const primary = rank(spec.primary, options)[0] ?? null
  if (!primary) return { primary: null, reviewers: [], reason: 'no model qualifies as primary' }

  const reviewers = []
  const pool = [...rank(spec.reviewer, options), ...rank('BEST_GENERAL', options)]

  for (const candidate of pool) {
    if (reviewers.length >= size - 1) break
    if (candidate.id === primary.id) continue
    if (reviewers.some((r) => r.id === candidate.id)) continue
    // A different family first; a different provider will do; identical last
    if (candidate.family === primary.family && pool.some((p) => p.family !== primary.family && p.id !== primary.id)) continue
    reviewers.push(candidate)
  }

  return {
    primary,
    reviewers,
    reason: reviewers.length === 0 ? 'no independent reviewer is available; running single-model' : null,
  }
}

/* ---------- execution ---------- */

async function ask(model, messages, { signal, maxTokens = MAX_TOKENS, temperature = 0.2 } = {}) {
  const { client } = getGateway()
  const started = Date.now()
  try {
    const reply = await client.completion({ model, messages, temperature, maxTokens, noFallback: true }, signal)
    const ms = Date.now() - started
    recordSuccess(model, { latencyMs: ms })
    noteSuccess(model, { latencyMs: ms, via: 'ensemble' })
    return { ok: true, model, content: reply.content, ms }
  } catch (error) {
    const kind = classifyFailure(error)
    recordFailure(model, error)
    noteFailure(model, kind)
    return { ok: false, model, reason: kind, ms: Date.now() - started }
  }
}

/**
 * Code-review ensemble (section 18).
 *
 * Primary produces, reviewer critiques, primary decides. The reviewer's text is
 * returned to the caller as *findings* — it is never applied, and the return
 * shape has no field that could be mistaken for an edit.
 *
 * @param {{ kind?: string, task: string, artefact: string, signal?: AbortSignal }} input
 */
export async function reviewEnsemble({ kind = ENSEMBLE_KINDS.CODE_REVIEW, task, artefact, signal, options = {} }) {
  const roster = ensembleRoster(kind, { options })
  if (!roster.primary) return { ran: false, reason: roster.reason, findings: [], roster }

  if (roster.reviewers.length === 0) {
    log.info('ensemble degraded to single model', { kind, primary: roster.primary.id })
    return { ran: false, reason: roster.reason, findings: [], roster }
  }

  const reviewer = roster.reviewers[0]
  const reply = await ask(
    reviewer.id,
    [
      {
        role: 'system',
        content:
          'You are reviewing work produced by a different model. Report only defects you can point at. ' +
          'For each, give one line: SEVERITY | LOCATION | WHAT IS WRONG. ' +
          'If you find nothing, reply with exactly: NO DEFECTS FOUND. Do not rewrite the work.',
      },
      { role: 'user', content: `Task:\n${task}\n\nWork to review:\n${clip(artefact)}` },
    ],
    { signal },
  )

  if (!reply.ok) {
    return { ran: false, reason: `reviewer failed (${reply.reason})`, findings: [], roster }
  }

  const findings = parseFindings(reply.content)
  log.info('review ensemble complete', { kind, reviewer: reviewer.id, findings: findings.length })

  return {
    ran: true,
    roster: { primary: roster.primary.id, reviewer: reviewer.id },
    findings,
    /** Explicit: the caller applies nothing without the primary agreeing. */
    applied: false,
    note: 'These are the reviewer’s claims. The primary model validates them before anything changes.',
  }
}

/**
 * Research ensemble (section 19).
 *
 * A verifier checks the synthesis against the *retrieved* sources. It is given
 * only what search actually returned, so it cannot invent a citation — the
 * failure this exists to catch is a plausible claim attributed to a real URL
 * that never said it.
 */
export async function researchEnsemble({ question, synthesis, sources = [], signal, options = {} }) {
  const roster = ensembleRoster(ENSEMBLE_KINDS.RESEARCH, { options })
  if (!roster.primary || roster.reviewers.length === 0) {
    return { ran: false, reason: roster.reason ?? 'no independent verifier available', claims: [], roster }
  }

  const verifier = roster.reviewers[0]
  const sourceList = sources
    .slice(0, 12)
    .map((s, i) => `[${i + 1}] ${s.title ?? 'untitled'} — ${s.url}\n${clip(s.snippet ?? s.excerpt ?? '', 600)}`)
    .join('\n\n')

  const reply = await ask(
    verifier.id,
    [
      {
        role: 'system',
        content:
          'You verify a research summary against the sources supplied. ' +
          'For each factual claim, reply on one line: SUPPORTED | UNSUPPORTED | CONTRADICTED — claim — [source number, or NONE]. ' +
          'Use only the numbered sources given. Never cite a source that is not in the list.',
      },
      { role: 'user', content: `Question: ${question}\n\nSummary:\n${clip(synthesis)}\n\nSources:\n${sourceList || '(none retrieved)'}` },
    ],
    { signal },
  )

  if (!reply.ok) return { ran: false, reason: `verifier failed (${reply.reason})`, claims: [], roster }

  const claims = parseClaims(reply.content, sources.length)
  return {
    ran: true,
    roster: { primary: roster.primary.id, verifier: verifier.id },
    claims,
    unsupported: claims.filter((c) => c.verdict !== 'SUPPORTED').length,
  }
}

/* ---------- parsing ---------- */

const clip = (text, limit = 12_000) => {
  const s = String(text ?? '')
  return s.length > limit ? `${s.slice(0, limit)}\n…(truncated)` : s
}

function parseFindings(text) {
  const body = String(text ?? '').trim()
  if (/^no defects found\.?$/im.test(body)) return []
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [severity, location, ...rest] = line.split('|').map((p) => p.trim())
      return { severity: severity.toLowerCase(), location, detail: rest.join(' | ') }
    })
    .filter((f) => f.detail)
}

/**
 * Parses verdicts, discarding any citation outside the range we supplied.
 *
 * A verifier that answers "[7]" when six sources were given has invented one,
 * and the reference is dropped rather than passed on as if it were real.
 */
function parseClaims(text, sourceCount) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter((line) => /^(SUPPORTED|UNSUPPORTED|CONTRADICTED)\b/i.test(line))
    .map((line) => {
      const parts = line.split('—').map((p) => p.trim())
      const verdict = parts[0].toUpperCase().split(/\s/)[0]
      const cite = /\[?(\d+)\]?/.exec(parts[2] ?? '')
      const index = cite ? Number.parseInt(cite[1], 10) : null
      return {
        verdict,
        claim: parts[1] ?? '',
        source: index && index >= 1 && index <= sourceCount ? index : null,
        ...(index && (index < 1 || index > sourceCount) ? { droppedCitation: true } : {}),
      }
    })
    .filter((c) => c.claim)
}

/**
 * Whether an ensemble is warranted (section 17).
 *
 * Errs towards "no". The default has to be single-model, or the cost of every
 * conversation multiplies for a benefit most turns do not need.
 */
export function shouldEnsemble({ kind, importance = 'normal', explicit = false } = {}) {
  if (explicit) return { yes: true, reason: 'explicitly requested' }
  if (importance === 'critical' && KIND_TASKS[kind]) return { yes: true, reason: `${kind} marked critical` }
  return { yes: false, reason: 'single model is sufficient for this request' }
}
