import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

/* ============================================================
   Codebase analysis
   -----------------
   Builds a map of an unknown project so the agent starts from facts
   instead of guessing: what it is built with, how it runs, where the
   entry points are, what the routes are, how it is tested.

   Everything here is read-only and derived from files on disk.
   ============================================================ */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage',
  '.venv', 'venv', '__pycache__', '.pytest_cache', 'target', 'vendor', '.cache',
  '.pixgpt', '.svelte-kit', '.turbo', '.parcel-cache',
])

const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.php', '.cs', '.swift', '.dart', '.css', '.scss',
  '.less', '.html', '.json', '.yml', '.yaml', '.sql', '.sh', '.md',
])

const MAX_FILES = 4000
const MAX_READ_BYTES = 200_000

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readTextCapped(path) {
  try {
    if (statSync(path).size > MAX_READ_BYTES) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Every code file, with sizes and line counts. Bounded so a huge repo can't stall the walk. */
function walk(root) {
  const files = []
  const stack = ['']
  let truncated = false

  while (stack.length > 0) {
    const rel = stack.pop()
    let entries
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push(childRel)
        continue
      }
      if (!entry.isFile()) continue // never follow symlinks out of the workspace
      const ext = extname(entry.name).toLowerCase()
      if (!CODE_EXT.has(ext)) continue
      let size = 0
      try {
        size = statSync(join(root, childRel)).size
      } catch {
        continue
      }
      files.push({ path: childRel, ext, size })
    }
  }
  return { files, truncated }
}

/* ---------- stack detection ---------- */

function detectStack(projectDir, pkg) {
  const has = (name) =>
    Boolean(pkg && (pkg.dependencies?.[name] || pkg.devDependencies?.[name]))
  const file = (name) => existsSync(join(projectDir, name))

  const frameworks = []
  if (has('next')) frameworks.push('Next.js')
  if (has('nuxt')) frameworks.push('Nuxt')
  if (has('@remix-run/react')) frameworks.push('Remix')
  if (has('@angular/core')) frameworks.push('Angular')
  if (has('svelte')) frameworks.push(has('@sveltejs/kit') ? 'SvelteKit' : 'Svelte')
  if (has('vue')) frameworks.push('Vue')
  if (has('react') && !has('next')) frameworks.push('React')
  if (has('express')) frameworks.push('Express')
  if (has('fastify')) frameworks.push('Fastify')
  if (has('@nestjs/core')) frameworks.push('NestJS')
  if (has('koa')) frameworks.push('Koa')
  if (file('manage.py')) frameworks.push('Django')
  if (file('requirements.txt') || file('pyproject.toml')) {
    const reqs = readTextCapped(join(projectDir, 'requirements.txt')) + readTextCapped(join(projectDir, 'pyproject.toml'))
    if (/\bflask\b/i.test(reqs)) frameworks.push('Flask')
    if (/\bfastapi\b/i.test(reqs)) frameworks.push('FastAPI')
    if (/\btensorflow\b/i.test(reqs)) frameworks.push('TensorFlow')
    if (/\btorch\b/i.test(reqs)) frameworks.push('PyTorch')
  }

  const build = []
  if (has('vite')) build.push('Vite')
  if (has('webpack')) build.push('webpack')
  if (has('esbuild')) build.push('esbuild')
  if (has('rollup')) build.push('Rollup')
  if (has('typescript') || file('tsconfig.json')) build.push('TypeScript')
  if (has('tailwindcss')) build.push('Tailwind CSS')

  const testing = []
  if (has('vitest')) testing.push('Vitest')
  if (has('jest')) testing.push('Jest')
  if (has('mocha')) testing.push('Mocha')
  if (has('@playwright/test') || has('playwright')) testing.push('Playwright')
  if (has('cypress')) testing.push('Cypress')
  if (has('@testing-library/react')) testing.push('Testing Library')
  if (file('pytest.ini') || file('conftest.py')) testing.push('pytest')

  const database = []
  if (has('prisma') || has('@prisma/client') || file('prisma/schema.prisma')) database.push('Prisma')
  if (has('mongoose')) database.push('MongoDB (mongoose)')
  if (has('pg')) database.push('PostgreSQL')
  if (has('mysql2') || has('mysql')) database.push('MySQL')
  if (has('better-sqlite3') || has('sqlite3')) database.push('SQLite')
  if (has('drizzle-orm')) database.push('Drizzle')
  if (has('typeorm')) database.push('TypeORM')
  if (has('sequelize')) database.push('Sequelize')

  let packageManager = null
  if (file('pnpm-lock.yaml')) packageManager = 'pnpm'
  else if (file('yarn.lock')) packageManager = 'yarn'
  else if (file('bun.lockb')) packageManager = 'bun'
  else if (file('package-lock.json')) packageManager = 'npm'
  else if (pkg) packageManager = 'npm'

  let language = 'unknown'
  if (file('tsconfig.json')) language = 'TypeScript'
  else if (pkg) language = 'JavaScript'
  else if (file('requirements.txt') || file('pyproject.toml') || file('manage.py')) language = 'Python'
  else if (file('go.mod')) language = 'Go'
  else if (file('Cargo.toml')) language = 'Rust'
  else if (file('pom.xml') || file('build.gradle')) language = 'Java'
  else if (file('index.html')) language = 'HTML/CSS/JS'

  return { language, frameworks, build, testing, database, packageManager }
}

/* ---------- routes ---------- */

/** HTTP routes declared in server code, plus client-side route declarations. */
function findRoutes(projectDir, files) {
  const routes = []
  const serverPattern = /\b(?:app|router|server|api|fastify)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]{1,120})['"`]/gi
  const clientPattern = /\bpath\s*:\s*['"`]([^'"`]{1,120})['"`]/g
  const jsxRoute = /<Route\b[^>]*\bpath\s*=\s*['"{]+([^'"}\s]{1,120})/g

  for (const f of files.slice(0, 400)) {
    if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(f.ext)) continue
    const text = readTextCapped(join(projectDir, f.path))
    if (!text) continue
    for (const m of text.matchAll(serverPattern)) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], file: f.path, kind: 'server' })
    }
    for (const m of text.matchAll(jsxRoute)) routes.push({ method: 'PAGE', path: m[1], file: f.path, kind: 'client' })
    if (/createBrowserRouter|createRouter|routes\s*[:=]/.test(text)) {
      for (const m of text.matchAll(clientPattern)) {
        routes.push({ method: 'PAGE', path: m[1], file: f.path, kind: 'client' })
      }
    }
    if (routes.length > 200) break
  }

  // Next.js / Nuxt / SvelteKit derive routes from the filesystem
  for (const f of files) {
    const m = f.path.match(/^(?:src\/)?(?:app|pages|routes)\/(.+)\.(?:jsx?|tsx?|vue|svelte)$/)
    if (!m) continue
    if (/^_|\/_/.test(m[1])) continue
    const path = `/${m[1].replace(/\/?(page|index|\+page|route)$/, '')}`.replace(/\/+/g, '/')
    routes.push({ method: 'PAGE', path: path === '' ? '/' : path, file: f.path, kind: 'file-route' })
  }

  const seen = new Set()
  return routes.filter((r) => {
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 120)
}

/* ---------- entry points ---------- */

function findEntryPoints(projectDir, pkg, files) {
  const entries = []
  const add = (path, role) => {
    if (path && existsSync(join(projectDir, path)) && !entries.some((e) => e.path === path)) {
      entries.push({ path, role })
    }
  }

  if (pkg?.main) add(pkg.main, 'package main')
  if (pkg?.module) add(pkg.module, 'ES module entry')
  for (const [name, script] of Object.entries(pkg?.scripts ?? {})) {
    const m = String(script).match(/\b(?:node|tsx|ts-node|python)\s+([\w./-]+\.(?:m?js|cjs|ts|py))/)
    if (m) add(m[1], `script: ${name}`)
  }
  for (const candidate of [
    'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js', 'src/index.tsx',
    'src/index.ts', 'src/index.js', 'src/App.tsx', 'index.html', 'server.js',
    'server/index.mjs', 'app.py', 'main.py', 'manage.py', 'main.go', 'src/main.rs',
  ]) {
    add(candidate, 'conventional entry')
  }
  if (entries.length === 0 && files.length > 0) {
    add(files.sort((a, b) => b.size - a.size)[0].path, 'largest source file')
  }
  return entries.slice(0, 10)
}

/* ---------- commands ---------- */

function findCommands(projectDir, pkg, stack) {
  const scripts = pkg?.scripts ?? {}
  const pm = stack.packageManager ?? 'npm'
  const run = (name) => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`)
  const pick = (...names) => names.find((n) => scripts[n])

  const install = pkg
    ? pm === 'npm' ? 'npm install' : `${pm} install`
    : existsSync(join(projectDir, 'requirements.txt'))
      ? 'pip install -r requirements.txt'
      : null

  const dev = pick('dev', 'start', 'serve')
  const build = pick('build', 'compile')
  const test = pick('test', 'test:unit')
  const lint = pick('lint')
  const typecheck = pick('typecheck', 'type-check', 'tsc')

  return {
    install,
    dev: dev ? run(dev) : existsSync(join(projectDir, 'manage.py')) ? 'python manage.py runserver' : null,
    build: build ? run(build) : null,
    test: test ? run(test) : existsSync(join(projectDir, 'pytest.ini')) ? 'pytest' : null,
    lint: lint ? run(lint) : null,
    typecheck: typecheck ? run(typecheck) : null,
  }
}

/* ---------- public API ---------- */

/**
 * Analyses a project directory.
 * @returns {Promise<object>} a structured map suitable for a model transcript
 */
export async function analyseProject(projectDir) {
  if (!existsSync(projectDir)) return { ok: false, error: 'The project directory does not exist.' }

  const pkg = readJson(join(projectDir, 'package.json'))
  const { files, truncated } = walk(projectDir)
  const stack = detectStack(projectDir, pkg)
  const routes = findRoutes(projectDir, files)

  const byExt = {}
  let totalBytes = 0
  for (const f of files) {
    byExt[f.ext] = (byExt[f.ext] ?? 0) + 1
    totalBytes += f.size
  }

  const dirs = new Map()
  for (const f of files) {
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '.'
    dirs.set(top, (dirs.get(top) ?? 0) + 1)
  }

  const testFiles = files.filter((f) => /(^|\/)(tests?|__tests__|spec)\//.test(f.path) || /\.(test|spec)\.\w+$/.test(f.path))
  const configFiles = files.filter((f) =>
    /^(vite|webpack|rollup|tailwind|postcss|eslint|jest|vitest|playwright|next|nuxt|svelte|tsconfig|babel)\.?/.test(f.path) ||
    /^\.?(eslintrc|prettierrc|babelrc)/.test(f.path),
  )

  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 12)
    .map((f) => ({ path: f.path, kb: Math.round(f.size / 102.4) / 10 }))

  return {
    ok: true,
    name: pkg?.name ?? projectDir.split(/[\\/]/).pop(),
    description: pkg?.description ?? null,
    version: pkg?.version ?? null,
    stack,
    commands: findCommands(projectDir, pkg, stack),
    entryPoints: findEntryPoints(projectDir, pkg, files),
    routes,
    scripts: pkg?.scripts ?? {},
    dependencies: Object.keys(pkg?.dependencies ?? {}),
    devDependencies: Object.keys(pkg?.devDependencies ?? {}),
    stats: {
      files: files.length,
      totalKb: Math.round(totalBytes / 1024),
      byExtension: Object.fromEntries(Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      topLevelDirectories: Object.fromEntries([...dirs.entries()].sort((a, b) => b[1] - a[1])),
      truncated,
    },
    tests: { count: testFiles.length, files: testFiles.slice(0, 20).map((f) => f.path) },
    configFiles: configFiles.map((f) => f.path).slice(0, 20),
    largestFiles: largest,
    hasEnvExample: existsSync(join(projectDir, '.env.example')),
    hasDockerfile: existsSync(join(projectDir, 'Dockerfile')),
    readme: existsSync(join(projectDir, 'README.md'))
      ? readTextCapped(join(projectDir, 'README.md')).slice(0, 1200)
      : null,
  }
}

export { SKIP_DIRS }
