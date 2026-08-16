import { randomUUID } from 'node:crypto'
import { GatewayError } from './gateway/errors.mjs'
import { log } from './config.mjs'

/* ============================================================
   Generated-file store
   --------------------
   Documents are generated in memory and handed to the browser through
   a short-lived id, so a download is a plain GET the browser can drive
   and the bytes never have to be base64'd into a JSON reply.

   Held in memory on purpose: these are derived artefacts, not user
   data. They expire, and they do not survive a restart.
   ============================================================ */

const TTL_MS = Number.parseInt(process.env.ARTIFACT_TTL_MS ?? '', 10) || 30 * 60 * 1000
const MAX_ARTIFACTS = Number.parseInt(process.env.ARTIFACT_MAX_COUNT ?? '', 10) || 60
const MAX_TOTAL_BYTES = Number.parseInt(process.env.ARTIFACT_MAX_TOTAL_BYTES ?? '', 10) || 300 * 1024 * 1024

/** @type {Map<string, { id, filename, mime, buffer, createdAt, meta }>} */
const ARTIFACTS = new Map()

function totalBytes() {
  let total = 0
  for (const artifact of ARTIFACTS.values()) total += artifact.buffer.length
  return total
}

/** Drops expired entries, then the oldest, until the store is within its limits. */
function evict(incomingBytes = 0) {
  const now = Date.now()
  for (const [id, artifact] of ARTIFACTS) {
    if (now - artifact.createdAt > TTL_MS) ARTIFACTS.delete(id)
  }
  while (ARTIFACTS.size >= MAX_ARTIFACTS || totalBytes() + incomingBytes > MAX_TOTAL_BYTES) {
    const oldest = ARTIFACTS.keys().next()
    if (oldest.done) break
    ARTIFACTS.delete(oldest.value)
  }
}

/**
 * Stores a generated file.
 * @returns {{ id, filename, mime, bytes, expiresInMs }}
 */
export function putArtifact({ filename, mime, buffer, meta = {} }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new GatewayError('provider_error', 'The generated file was empty.')
  }
  if (buffer.length > MAX_TOTAL_BYTES) {
    throw new GatewayError('bad_request', 'That file is too large to serve.', { status: 413 })
  }

  evict(buffer.length)
  const id = `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  ARTIFACTS.set(id, { id, filename, mime, buffer, createdAt: Date.now(), meta })
  log.info('artifact stored', { id, filename, bytes: buffer.length, held: ARTIFACTS.size })

  return { id, filename, mime, bytes: buffer.length, expiresInMs: TTL_MS, ...meta }
}

export function getArtifact(id) {
  const artifact = ARTIFACTS.get(id)
  if (!artifact) {
    throw new GatewayError('not_found', 'That file is no longer available. Please generate it again.', { status: 404 })
  }
  if (Date.now() - artifact.createdAt > TTL_MS) {
    ARTIFACTS.delete(id)
    throw new GatewayError('not_found', 'That file has expired. Please generate it again.', { status: 404 })
  }
  return artifact
}

export function artifactStats() {
  return { count: ARTIFACTS.size, bytes: totalBytes(), ttlMs: TTL_MS }
}

/** Test seam. */
export function clearArtifacts() {
  ARTIFACTS.clear()
}

export { TTL_MS, MAX_ARTIFACTS }
