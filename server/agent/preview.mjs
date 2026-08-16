import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { GatewayError } from '../gateway/errors.mjs'
import { log } from '../config.mjs'
import { resolveProgram } from './terminal.mjs'

/* ============================================================
   Live preview
   ------------
   Starts the generated app, waits until it actually answers, and
   hands back a URL the agent (and the user) can open.

   Processes are owned by a task id and killed on stop/cleanup, so a
   finished or failed task never leaves a server listening. Ports are
   allocated from a private range and bound to loopback only.
   ============================================================ */

const PORT_MIN = Number.parseInt(process.env.AGENT_PREVIEW_PORT_MIN ?? '', 10) || 41000
const PORT_MAX = Number.parseInt(process.env.AGENT_PREVIEW_PORT_MAX ?? '', 10) || 41400
const READY_TIMEOUT_MS = Number.parseInt(process.env.AGENT_PREVIEW_READY_MS ?? '', 10) || 90_000

/** taskId -> preview record */
const PREVIEWS = new Map()

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

async function allocatePort() {
  const taken = new Set([...PREVIEWS.values()].map((p) => p.port))
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (taken.has(port)) continue
    if (await portFree(port)) return port
  }
  throw bad('No preview port is available.')
}

/* ---------- project detection ---------- */

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Works out how to start the project from what is actually on disk — never a
 * hardcoded framework guess.
 *
 * @returns {{ kind, program, args, needsInstall, portEnv, portFlag } | null}
 */
export function detectRunner(projectDir) {
  const pkgPath = join(projectDir, 'package.json')
  const pkg = readJson(pkgPath)

  if (pkg) {
    const scripts = pkg.scripts ?? {}
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const has = (name) => Object.prototype.hasOwnProperty.call(deps, name)
    const needsInstall = Object.keys(deps).length > 0 && !existsSync(join(projectDir, 'node_modules'))

    // Vite (also covers most React/Vue/Svelte scaffolds)
    if (has('vite') && scripts.dev) {
      return { kind: 'vite', program: 'npm', args: ['run', 'dev', '--', '--port', '{port}', '--strictPort'], needsInstall }
    }
    if (has('next')) {
      return { kind: 'next', program: 'npm', args: ['run', scripts.dev ? 'dev' : 'start', '--', '--port', '{port}'], needsInstall }
    }
    if (scripts.dev) {
      return { kind: 'npm-dev', program: 'npm', args: ['run', 'dev'], needsInstall, portEnv: 'PORT' }
    }
    if (scripts.start) {
      return { kind: 'npm-start', program: 'npm', args: ['start'], needsInstall, portEnv: 'PORT' }
    }
    if (pkg.main && existsSync(join(projectDir, pkg.main))) {
      return { kind: 'node', program: 'node', args: [pkg.main], needsInstall, portEnv: 'PORT' }
    }
    for (const entry of ['server.js', 'index.js', 'src/server.js', 'src/index.js', 'app.js']) {
      if (existsSync(join(projectDir, entry))) {
        return { kind: 'node', program: 'node', args: [entry], needsInstall, portEnv: 'PORT' }
      }
    }
  }

  // Python web apps
  for (const entry of ['manage.py']) {
    if (existsSync(join(projectDir, entry))) {
      return { kind: 'django', program: 'python', args: ['manage.py', 'runserver', '127.0.0.1:{port}'], needsInstall: false }
    }
  }
  for (const entry of ['app.py', 'main.py', 'server.py']) {
    if (existsSync(join(projectDir, entry))) {
      return { kind: 'python', program: 'python', args: [entry], needsInstall: false, portEnv: 'PORT' }
    }
  }

  // A plain static site can be served without any dependency
  for (const entry of ['index.html', 'public/index.html']) {
    if (existsSync(join(projectDir, entry))) {
      return { kind: 'static', program: '__static__', args: [], needsInstall: false, root: entry.includes('/') ? 'public' : '.' }
    }
  }
  return null
}

/* ---------- static fallback server ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

/** Serves the project as static files, confined to the project directory. */
async function startStatic(projectDir, root, port) {
  const { createServer: createHttp } = await import('node:http')
  const { extname, join: pjoin, normalize, relative, resolve: presolve } = await import('node:path')
  const base = presolve(projectDir, root === '.' ? '' : root)

  const server = createHttp((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let file = pjoin(base, normalize(decodeURIComponent(url.pathname)))
    if (relative(base, file).startsWith('..')) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!existsSync(file) || file.endsWith('/') || file.endsWith('\\')) file = pjoin(base, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

/* ---------- readiness ---------- */

async function waitForHttp(port, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) return { ready: false, reason: 'The preview process exited.' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal })
      clearTimeout(timer)
      // Any HTTP answer means the server is up, even a 404
      if (response.status > 0) return { ready: true, status: response.status }
    } catch (error) {
      lastError = error?.cause?.code ?? error?.name ?? 'error'
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return { ready: false, reason: `Timed out waiting for the server (${lastError}).` }
}

/* ---------- lifecycle ---------- */

export function getPreview(taskId) {
  return PREVIEWS.get(taskId) ?? null
}

/**
 * Starts (or reuses) the preview for a task.
 * @returns {Promise<{ url, port, kind, ready, reason?, logs }>}
 */
export async function startPreview({ taskId, projectDir, emit }) {
  const existing = PREVIEWS.get(taskId)
  if (existing) {
    const check = await waitForHttp(existing.port, 3000)
    if (check.ready) return { url: existing.url, port: existing.port, kind: existing.kind, ready: true, logs: existing.logs.slice(-40) }
    await stopPreview(taskId)
  }

  const runner = detectRunner(projectDir)
  if (!runner) {
    throw bad('Could not work out how to start this project. There is no package.json script, entry file or index.html.')
  }

  const port = await allocatePort()
  const url = `http://127.0.0.1:${port}`
  const logs = []

  emit?.({ type: 'preview_started', command: runner.kind === 'static' ? 'built-in static server' : `${runner.program} ${runner.args.join(' ')}`, kind: runner.kind })

  // Static: no child process at all
  if (runner.program === '__static__') {
    const server = await startStatic(projectDir, runner.root ?? '.', port)
    const record = { taskId, port, url, kind: 'static', server, child: null, logs, startedAt: Date.now() }
    PREVIEWS.set(taskId, record)
    emit?.({ type: 'preview_ready', url, port, kind: 'static' })
    return { url, port, kind: 'static', ready: true, logs }
  }

  const executable = resolveProgram(runner.program) ?? runner.program
  const args = runner.args.map((a) => a.replace('{port}', String(port)))

  // npm is a .cmd shim; run its JS entry so no shell is needed
  let spawnExe = executable
  let spawnArgs = args
  if (/^npm(\.cmd)?$/i.test(runner.program)) {
    const npmCli = join(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js')
    if (existsSync(npmCli)) {
      spawnExe = process.execPath
      spawnArgs = [npmCli, ...args]
    }
  }

  const env = {
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATHEXT: process.env.PATHEXT,
    CI: '1',
    NO_COLOR: '1',
    BROWSER: 'none', // stop dev servers opening a real browser window
    HOST: '127.0.0.1',
  }
  if (runner.portEnv) env[runner.portEnv] = String(port)

  const child = spawn(spawnExe, spawnArgs, { cwd: projectDir, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let alive = true
  child.on('exit', (code) => {
    alive = false
    logs.push(`[exit ${code}]`)
  })
  const capture = (stream) =>
    stream.on('data', (d) => {
      const text = d.toString()
      logs.push(text)
      if (logs.length > 200) logs.splice(0, logs.length - 200)
    })
  capture(child.stdout)
  capture(child.stderr)

  const record = { taskId, port, url, kind: runner.kind, child, server: null, logs, startedAt: Date.now() }
  PREVIEWS.set(taskId, record)

  const ready = await waitForHttp(port, READY_TIMEOUT_MS, () => alive)
  if (!ready.ready) {
    log.warn('preview failed to start', { taskId, kind: runner.kind, reason: ready.reason })
    await stopPreview(taskId)
    return { url, port, kind: runner.kind, ready: false, reason: ready.reason, logs: logs.slice(-40) }
  }

  log.info('preview ready', { taskId, kind: runner.kind, port })
  emit?.({ type: 'preview_ready', url, port, kind: runner.kind })
  return { url, port, kind: runner.kind, ready: true, logs: logs.slice(-20) }
}

export async function stopPreview(taskId, emit) {
  const record = PREVIEWS.get(taskId)
  if (!record) return { stopped: false }
  PREVIEWS.delete(taskId)

  try {
    record.child?.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  if (record.server) {
    await new Promise((resolve) => record.server.close(resolve))
  }
  emit?.({ type: 'preview_stopped', taskId })
  log.info('preview stopped', { taskId })
  return { stopped: true }
}

/** Kills every preview — used on task cleanup and process shutdown. */
export async function stopAllPreviews() {
  await Promise.all([...PREVIEWS.keys()].map((id) => stopPreview(id)))
}

export function previewCount() {
  return PREVIEWS.size
}
