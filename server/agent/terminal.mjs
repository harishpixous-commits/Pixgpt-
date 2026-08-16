import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { GatewayError } from '../gateway/errors.mjs'
import { log } from '../config.mjs'

/* ============================================================
   Controlled terminal
   -------------------
   The agent needs to run npm, tests and builds. It must never get
   unrestricted host shell access.

   Three layers:
     1. classify()  — every command gets a risk level before it runs
     2. BLOCKED     — refused outright, no approval path
     3. cwd lock    — always the task workspace, never elsewhere

   Commands run WITHOUT a shell (`shell: false`), so `&&`, `;`, `|`,
   backticks and `$(...)` are inert: they cannot chain a second
   command past the classifier. A caller wanting two commands must
   ask twice, and each is classified on its own.
   ============================================================ */

export const RISK = {
  SAFE: 'SAFE',
  LOW_RISK: 'LOW_RISK',
  REQUIRES_APPROVAL: 'REQUIRES_APPROVAL',
  BLOCKED: 'BLOCKED',
}

/** Programs the agent may run at all. Anything not listed needs approval. */
const KNOWN_PROGRAMS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'pip', 'pip3',
  'git',
  'tsc', 'eslint', 'prettier', 'vite', 'jest', 'vitest', 'playwright',
  'go', 'cargo', 'rustc', 'java', 'javac', 'mvn', 'gradle',
  'dotnet', 'php', 'composer', 'ruby', 'bundle',
])

/** Never runs, at any risk level, with or without approval. */
const BLOCKED_PROGRAMS = new Set([
  // shells — would defeat the no-shell guarantee
  'sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh',
  // privilege escalation
  'sudo', 'su', 'runas', 'doas',
  // disk / system
  'mkfs', 'fdisk', 'diskpart', 'format', 'dd', 'shutdown', 'reboot', 'halt',
  'reg', 'regedit', 'sc', 'net', 'netsh', 'wmic', 'bcdedit',
  // credentials / users
  'passwd', 'useradd', 'usermod', 'chpasswd', 'ssh-keygen', 'ssh-add', 'keytool',
  'security', 'cmdkey', 'vaultcmd',
  // remote shells / tunnels
  'ssh', 'scp', 'sftp', 'telnet', 'nc', 'ncat', 'socat',
  // arbitrary fetch-and-run
  'curl', 'wget', 'iwr', 'invoke-webrequest',
])

/** Argument patterns that make an otherwise-fine program dangerous. */
const BLOCKED_PATTERNS = [
  { re: /^-{0,2}rf?\s*\/$/, why: 'recursive delete of the filesystem root' },
  { re: /^\/$/, why: 'filesystem root as a target' },
]

/** git subcommands that discard work — approval required. */
const GIT_DESTRUCTIVE = new Set(['reset', 'clean', 'checkout', 'restore', 'rebase', 'push', 'filter-branch'])

/**
 * Classifies a command.
 * @returns {{ risk: string, reason: string }}
 */
export function classify(program, args = []) {
  const prog = String(program ?? '').trim().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
  if (!prog) return { risk: RISK.BLOCKED, reason: 'No command given.' }

  // A program name must be a bare name — no paths, no separators
  if (/[\\/]/.test(prog)) {
    return { risk: RISK.BLOCKED, reason: 'Commands must be a bare program name, not a path.' }
  }
  if (BLOCKED_PROGRAMS.has(prog)) {
    return { risk: RISK.BLOCKED, reason: `\`${prog}\` is not permitted inside the workspace.` }
  }

  const flat = args.map((a) => String(a)).join(' ')
  for (const { re, why } of BLOCKED_PATTERNS) {
    if (args.some((a) => re.test(String(a).trim()))) {
      return { risk: RISK.BLOCKED, reason: `Refused: ${why}.` }
    }
  }
  // Absolute paths outside the workspace as arguments
  if (/(^|\s)([a-zA-Z]:[\\/]|\/(etc|usr|bin|sbin|var|root|home|Windows|Users)\b)/.test(flat)) {
    return { risk: RISK.REQUIRES_APPROVAL, reason: 'The command references a path outside the workspace.' }
  }

  if (!KNOWN_PROGRAMS.has(prog)) {
    return { risk: RISK.REQUIRES_APPROVAL, reason: `\`${prog}\` is not a recognised development tool.` }
  }

  /*
   * Inline-code execution is the one command form that reaches the machine
   * without ever touching a file: `node -e '…'` and `python -c '…'` run
   * arbitrary code straight from the prompt, invisible to the user. It is the
   * documented gap in this policy (see docs/freebuff-analysis.md), and the
   * fix is the same as for every other risky command — approval.
   *
   * Running a script FROM a file stays open: the code is inspectable and was
   * written through the same edit tools the agent already has, so it adds no
   * new capability. `-m`/`--module` is included because `python -m pip …`
   * would otherwise smuggle a package install past the pip gate, and
   * `python -m http.server` opens a listener.
   */
  const EVAL_FLAGS = {
    node: /^(-e|-p|-pe|-i|-r|--eval|--print|--interactive|--repl|--require|--import|--input-type)(=.*)?$/,
    python: /^(-c|-i|-m|--module)$/,
    python3: /^(-c|-i|-m|--module)$/,
    ruby: /^-e$/,
    php: /^-r$/,
  }
  const evalRe = EVAL_FLAGS[prog]
  if (evalRe && args.some((a) => evalRe.test(String(a).trim()))) {
    return {
      risk: RISK.REQUIRES_APPROVAL,
      reason: `\`${prog}\` inline code execution needs approval — the code never appears in a file.`,
    }
  }

  if (prog === 'git') {
    const sub = String(args[0] ?? '').toLowerCase()
    if (GIT_DESTRUCTIVE.has(sub)) {
      return { risk: RISK.REQUIRES_APPROVAL, reason: `\`git ${sub}\` can discard work.` }
    }
    return { risk: RISK.SAFE, reason: 'Read-only or additive git operation.' }
  }

  if (['npm', 'pnpm', 'yarn', 'npx', 'pip', 'pip3', 'composer', 'bundle'].includes(prog)) {
    const sub = String(args[0] ?? '').toLowerCase()

    if (['publish', 'login', 'token', 'config', 'adduser'].includes(sub)) {
      return { risk: RISK.REQUIRES_APPROVAL, reason: `\`${prog} ${sub}\` affects accounts or credentials.` }
    }

    /*
     * npx — and the exec/dlх forms of npm, pnpm and yarn — fetch a package
     * from the registry and run it. That is arbitrary remote code in the
     * workspace, which is precisely what approval is for.
     */
    if (prog === 'npx' || ['exec', 'x', 'dlx'].includes(sub)) {
      return {
        risk: RISK.REQUIRES_APPROVAL,
        reason:
          prog === 'npx'
            ? 'npx downloads and runs a package from the registry.'
            : `\`${prog} ${sub}\` downloads and runs a package from the registry.`,
      }
    }

    if (['install', 'i', 'add', 'ci', 'create'].includes(sub)) {
      /*
       * Restoring what package.json already declares is routine. Adding a NAMED
       * new package pulls third-party code the user never asked for, so that
       * needs a decision. Flags are not package names.
       */
      const named = args
        .slice(1)
        .map((a) => String(a))
        .filter((a) => a && !a.startsWith('-'))

      if (named.length === 0 && sub !== 'create') {
        return { risk: RISK.LOW_RISK, reason: 'Restores the dependencies already declared by the project.' }
      }
      return {
        risk: RISK.REQUIRES_APPROVAL,
        reason: `Adds third-party code to the project: ${named.slice(0, 4).join(', ')}${named.length > 4 ? `, and ${named.length - 4} more` : ''}.`,
      }
    }

    if (['uninstall', 'remove', 'rm', 'prune'].includes(sub)) {
      return { risk: RISK.LOW_RISK, reason: 'Removes dependencies from the project.' }
    }
    return { risk: RISK.SAFE, reason: 'Runs a project script.' }
  }

  return { risk: RISK.SAFE, reason: 'Standard development command.' }
}

/* ---------- program resolution ---------- */

/**
 * Finds the real executable for a bare program name by walking PATH.
 *
 * Needed because `spawn` with `shell: false` cannot run a Windows `.cmd` shim,
 * and npm/npx/yarn/tsc are all `.cmd` files. Resolving to an absolute path keeps
 * the no-shell guarantee (so metacharacters stay inert) while still letting the
 * agent use the tools it needs.
 *
 * Only PATH is searched, and only after classify() has approved the bare name,
 * so this cannot be used to reach an arbitrary binary.
 */
/**
 * Node-based CLIs ship as `.cmd` shims on Windows, and Node refuses to spawn
 * `.cmd` without a shell (CVE-2024-27980). Rather than re-enable a shell — which
 * would make `&&` and `|` live again — these are run as what they actually are:
 * a JavaScript file executed by node.
 */
const NODE_CLI_SCRIPTS = {
  npm: ['node_modules/npm/bin/npm-cli.js'],
  npx: ['node_modules/npm/bin/npx-cli.js'],
}

/** Metacharacters that cmd.exe would interpret; refused on the shim fallback. */
const CMD_METACHARS = /[&|<>^%!"`]/

export function resolveProgram(program) {
  const name = String(program)
  if (/[\/]/.test(name)) return null // classify() already refuses these

  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)

  for (const dir of dirs) {
    // On Windows the executable extensions must be tried FIRST: a bare `npm`
    // in the same directory is a shell script that CreateProcess cannot run.
    for (const ext of process.platform === 'win32' ? [...exts, ''] : ['', ...exts]) {
      const candidate = join(dir, name + ext)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/* ---------- execution ---------- */

const MAX_OUTPUT_CHARS = Number.parseInt(process.env.AGENT_MAX_OUTPUT_CHARS ?? '', 10) || 24_000
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.AGENT_COMMAND_TIMEOUT_MS ?? '', 10) || 300_000

/**
 * Environment handed to the child. Deliberately minimal: the agent's commands
 * must not inherit PixGPT's gateway key, the OmniRoute URL, or anything else
 * from the server process.
 */
function childEnv(projectDir) {
  const allow = ['PATH', 'Path', 'SystemRoot', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'TZ', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE']
  const env = {}
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k]
  env.CI = '1' // keeps installers and test runners non-interactive
  env.npm_config_yes = 'true'
  env.NO_COLOR = '1'
  env.PIXGPT_WORKSPACE = projectDir
  return env
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2)
  return {
    text: `${text.slice(0, half)}\n\n… [${text.length - MAX_OUTPUT_CHARS} characters trimmed] …\n\n${text.slice(-half)}`,
    truncated: true,
  }
}

/**
 * Runs one command inside the workspace.
 *
 * `async` deliberately: a blocked command must *reject*, not throw
 * synchronously, so every caller can handle both failure modes the same way.
 *
 * @returns {Promise<{ ok, exitCode, stdout, stderr, durationMs, truncated, timedOut, command }>}
 */
export async function runCommand({ program, args = [], projectDir, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onOutput }) {
  const { risk, reason } = classify(program, args)
  if (risk === RISK.BLOCKED) {
    throw new GatewayError('bad_request', reason, { status: 400 })
  }

  const display = [program, ...args].join(' ')
  const started = Date.now()

  return new Promise((resolvePromise, reject) => {
    // Prefer the real JS entry point for node-based CLIs
    let executable = null
    let spawnArgs = args.map(String)
    const nodeCli = NODE_CLI_SCRIPTS[String(program).toLowerCase()]
    if (nodeCli) {
      const nodeExe = process.execPath
      const nodeDir = dirname(nodeExe)
      for (const rel of nodeCli) {
        const candidate = join(nodeDir, rel)
        if (existsSync(candidate)) {
          executable = nodeExe
          spawnArgs = [candidate, ...spawnArgs]
          break
        }
      }
    }
    if (!executable) {
      const found = resolveProgram(program)
      if (found && /\.(cmd|bat)$/i.test(found)) {
        // Last resort: a shim we must go through cmd.exe for. Only allowed when
        // no argument can be reinterpreted as a command.
        if (spawnArgs.some((a) => CMD_METACHARS.test(a))) {
          resolvePromise({
            command: display, risk, ok: false, exitCode: null, stdout: '',
            stderr: `Refused: \`${program}\` arguments contain shell metacharacters.`,
            truncated: false, timedOut: false, durationMs: Date.now() - started,
          })
          return
        }
        executable = process.env.COMSPEC || 'cmd.exe'
        spawnArgs = ['/d', '/s', '/c', found, ...spawnArgs]
      } else {
        executable = found
      }
    }
    if (!executable) {
      resolvePromise({
        command: display,
        risk,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `\`${program}\` was not found on this system. It may not be installed.`,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
      })
      return
    }

    let child
    try {
      child = spawn(executable, spawnArgs, {
        cwd: projectDir,
        env: childEnv(projectDir),
        // No shell: metacharacters cannot chain a second, unclassified command.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new GatewayError('bad_request', `Could not start \`${program}\`.`, { status: 400, detail: error?.message }))
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })

    const cap = (current, chunk) =>
      current.length > MAX_OUTPUT_CHARS * 2 ? current : current + chunk

    child.stdout.on('data', (d) => {
      const s = d.toString()
      stdout = cap(stdout, s)
      onOutput?.({ stream: 'stdout', chunk: s })
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr = cap(stderr, s)
      onOutput?.({ stream: 'stderr', chunk: s })
    })

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const out = truncate(stdout)
      const err = truncate(stderr)
      const result = {
        command: display,
        risk,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        durationMs: Date.now() - started,
      }
      log.info('agent command', {
        command: display.slice(0, 120),
        risk,
        exitCode,
        ms: result.durationMs,
        timedOut,
      })
      resolvePromise(result)
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        command: display,
        risk,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `Failed to run \`${program}\`: ${error?.code ?? error?.message ?? 'unknown error'}`,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
      })
    })

    child.on('close', (code) => finish(code))
  })
}
