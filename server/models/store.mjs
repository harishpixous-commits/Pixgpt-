import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { log } from '../config.mjs'
import { TERMINAL_FAILURES } from './health.mjs'

/* ============================================================
   What the registry remembers across restarts
   -------------------------------------------
   Without this, every restart forgets which routes work, and the
   first request of each session goes to whatever *sounds* best.
   Observed exactly that: a fresh server ranked `aug/opus4.6-500k`
   first for coding minutes after a probe had proved the gateway
   cannot reach it at all.

   Three rules keep a cache from becoming a lie:

     · Everything expires. "It answered last Tuesday" is not
       evidence about today.
     · A past failure is a penalty, never an exclusion. A route
       that was misconfigured yesterday may have been fixed this
       morning, and it must be able to prove that.
     · Cooldowns are never restored. A circuit breaker describes
       right now; reloading one would keep a healthy route out of
       rotation for a problem that has already passed.

   The file holds route names and counters. No prompts, no
   responses, no credentials.
   ============================================================ */

const ROOT = resolve(process.env.WORKSPACE_ROOT ?? join(process.cwd(), '.pixgpt-workspaces'))
const FILE = join(ROOT, 'model-registry.json')
const VERSION = 1

/** How long a remembered verification stays meaningful. */
const TTL = {
  /** "This route answered." Re-earned constantly by ordinary traffic. */
  verification: Number.parseInt(process.env.PIXGPT_MODEL_MEMORY_TTL_MS ?? '', 10) || 24 * 3_600_000,
  /** "This route can/cannot see images." A stable property of the model. */
  capability: 7 * 24 * 3_600_000,
  /** "This route was misconfigured." Short: deployments get fixed. */
  failure: 6 * 3_600_000,
  /**
   * Failures that are configuration facts rather than weather.
   *
   * A missing binary, a rejected credential or an exhausted quota does not
   * resolve itself overnight. Expiring those on the same six-hour clock as a
   * timeout meant a full probe run was forgotten by morning, and 62 known-dead
   * routes went back to reading "not yet verified" — losing the very evidence
   * the probe was run to collect. Still finite: fixed deployments must be able
   * to come back without anyone clearing a cache.
   */
  terminalFailure: 7 * 24 * 3_600_000,
}

/** Failures that survive on the longer clock. One shared definition. */
const TERMINAL_KINDS = new Set(TERMINAL_FAILURES)

const fresh = (at, ttl) => Boolean(at) && Date.now() - new Date(at).getTime() < ttl

/* ---------- reading ---------- */

/**
 * Loads the snapshot, dropping anything expired.
 *
 * A corrupt or unreadable file is not an error worth failing over — the
 * registry simply starts empty and relearns, which is what it does on a first
 * run anyway.
 */
export function loadSnapshot() {
  if (!existsSync(FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (raw?.version !== VERSION || typeof raw.models !== 'object') return {}

    const out = {}
    for (const [id, entry] of Object.entries(raw.models)) {
      if (typeof id !== 'string' || !entry || typeof entry !== 'object') continue

      const kept = {}
      if (fresh(entry.lastVerified, TTL.verification) && entry.verified === true) {
        kept.verified = true
        kept.lastVerified = entry.lastVerified
        kept.verifiedBy = typeof entry.verifiedBy === 'string' ? entry.verifiedBy : 'a previous session'
        if (Number.isFinite(entry.latencyMs)) kept.latencyMs = entry.latencyMs
      }
      if (fresh(entry.capabilitiesAt, TTL.capability) && entry.capabilities && typeof entry.capabilities === 'object') {
        kept.capabilities = {}
        for (const [name, value] of Object.entries(entry.capabilities)) {
          if (typeof value === 'boolean') kept.capabilities[name] = value
        }
        kept.capabilitiesAt = entry.capabilitiesAt
      }
      if (typeof entry.lastFailureKind === 'string') {
        const ttl = TERMINAL_KINDS.has(entry.lastFailureKind) ? TTL.terminalFailure : TTL.failure
        if (fresh(entry.lastFailure, ttl)) {
          kept.priorFailure = entry.lastFailureKind
          kept.lastFailure = entry.lastFailure
        }
      }

      if (Object.keys(kept).length > 0) out[id] = kept
    }
    return out
  } catch (error) {
    log.warn('could not read the model memory; starting fresh', { detail: error?.message })
    return {}
  }
}

/* ---------- writing ---------- */

let pending = null
let dirty = false

/**
 * Persists the snapshot.
 *
 * Written to a temporary file and renamed, so a crash mid-write cannot leave a
 * half-file that the next start would refuse to parse.
 */
export function saveSnapshot(models) {
  try {
    mkdirSync(dirname(FILE), { recursive: true })

    const out = { version: VERSION, savedAt: new Date().toISOString(), models: {} }
    for (const model of models) {
      const probed = {}
      for (const [name, entry] of Object.entries(model.capabilities ?? {})) {
        if (entry?.source === 'probe' && typeof entry.value === 'boolean') probed[name] = entry.value
      }

      const entry = {}
      if (model.verified) {
        entry.verified = true
        entry.lastVerified = model.lastVerified
        entry.verifiedBy = model.verifiedBy
        if (Number.isFinite(model.health?.latencyMs)) entry.latencyMs = model.health.latencyMs
      }
      if (Object.keys(probed).length > 0) {
        entry.capabilities = probed
        entry.capabilitiesAt = model.lastVerified ?? new Date().toISOString()
      }
      /*
       * Live health first, then what an earlier session remembered.
       *
       * Saving from live health alone silently *erased* memory: a restart
       * restores `priorFailure` but not the health record, so the next save
       * found nothing there and wrote the model out clean. A full probe of 116
       * models was down to 4 remembered failures after two restarts — the
       * registry forgetting precisely what it had been run to learn.
       */
      if (model.health?.lastFailure && model.health?.lastFailureKind) {
        entry.lastFailure = model.health.lastFailure
        entry.lastFailureKind = model.health.lastFailureKind
      } else if (model.priorFailure && model.priorFailureAt) {
        entry.lastFailure = model.priorFailureAt
        entry.lastFailureKind = model.priorFailure
      }

      if (Object.keys(entry).length > 0) out.models[model.id] = entry
    }

    const temporary = `${FILE}.tmp`
    writeFileSync(temporary, JSON.stringify(out), 'utf8')
    renameSync(temporary, FILE)
    dirty = false
    return Object.keys(out.models).length
  } catch (error) {
    // Losing the cache costs a relearn, never a request
    log.warn('could not write the model memory', { detail: error?.message })
    return 0
  }
}

/**
 * Marks the snapshot stale and schedules a write.
 *
 * Debounced because every request updates health, and rewriting the file on
 * each one would turn chat latency into disk latency.
 */
export function scheduleSave(getModels, delayMs = 30_000) {
  dirty = true
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    if (dirty) saveSnapshot(getModels())
  }, delayMs)
  pending.unref?.()
}

/** Flushes immediately. Called on shutdown so a clean exit keeps what it learned. */
export function flushSnapshot(getModels) {
  if (pending) {
    clearTimeout(pending)
    pending = null
  }
  if (!dirty) return 0
  return saveSnapshot(getModels())
}

export { FILE as SNAPSHOT_FILE, TTL as SNAPSHOT_TTL }
