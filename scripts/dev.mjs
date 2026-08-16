import { spawn } from 'node:child_process'

/**
 * Runs the API server and the Vite dev server together.
 *
 * A tiny spawner rather than `concurrently`: two child processes do not justify
 * a dependency, and this keeps `npm run dev` a single command on every OS.
 */
const children = []
let shuttingDown = false

function run(name, command, args, color) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // npm/vite are .cmd shims on Windows
    env: process.env,
  })

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (stream, out) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) out.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)

  child.on('exit', (code) => {
    if (shuttingDown) return
    process.stdout.write(`${prefix}exited with code ${code}\n`)
    shutdown(code ?? 0)
  })

  children.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  setTimeout(() => process.exit(code), 200).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0))

run('server', 'node', ['server/index.mjs'], '36') // cyan
run('web', 'npx', ['vite'], '35') // magenta
