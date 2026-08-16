import { loadEnvFile } from './env.mjs'

loadEnvFile()

/* ============================================================
   Process-level configuration.

   Gateway configuration lives in `gateway/index.mjs` — it is
   per-adapter and resolved there. This module deliberately knows
   nothing about AI gateways so the two can't form an import cycle.
   ============================================================ */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function int(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  port: int('PORT', 8787),
  logLevel: process.env.LOG_LEVEL ?? 'info',
}

/* ---------- logging ---------- */

function enabled(level) {
  return (LEVELS[level] ?? 2) <= (LEVELS[config.logLevel] ?? 2)
}

function fmt(level, msg, meta) {
  const base = `[pixgpt:${level}] ${msg}`
  if (!meta) return base
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return parts.length ? `${base} ${parts.join(' ')}` : base
}

/**
 * Structured, single-line logging. Never logs request/response bodies,
 * Authorization headers, or API keys — only metadata needed to diagnose
 * routing problems.
 */
export const log = {
  error: (msg, meta) => enabled('error') && console.error(fmt('error', msg, meta)),
  warn: (msg, meta) => enabled('warn') && console.warn(fmt('warn', msg, meta)),
  info: (msg, meta) => enabled('info') && console.log(fmt('info', msg, meta)),
  debug: (msg, meta) => enabled('debug') && console.log(fmt('debug', msg, meta)),
}
