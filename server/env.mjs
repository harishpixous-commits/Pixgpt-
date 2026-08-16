import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Minimal `.env` loader.
 *
 * Node 18 has no `--env-file`, and pulling in `dotenv` for ~20 lines would add
 * a runtime dependency the project does not otherwise need. Real environment
 * variables always win, so container/CI configuration overrides the file.
 */
export function loadEnvFile(file = '.env') {
  let raw
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8')
  } catch {
    return false // no .env — env vars or defaults will be used
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eq = trimmed.indexOf('=')
    if (eq === -1) continue

    const key = trimmed.slice(0, eq).trim()
    if (!key || key in process.env) continue

    let value = trimmed.slice(eq + 1).trim()
    // Strip matching surrounding quotes, keeping inner content verbatim
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
  return true
}
