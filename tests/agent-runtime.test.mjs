import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureWorkspace, removeWorkspace } from '../server/agent/workspace.mjs'
import { writeBinaryFile, writeFile } from '../server/agent/files.mjs'
import { detectRunner, previewCount, stopAllPreviews } from '../server/agent/preview.mjs'
import { analyseProject } from '../server/agent/analyze.mjs'
import { IMPORT_LIMITS, extractZip, safeEntryPath } from '../server/agent/unzip.mjs'
import { installedVersion } from '../server/agent/research.mjs'
import { toolDefinitions, toolNames } from '../server/agent/tools.mjs'
import { browserAvailable, VIEWPORTS } from '../server/agent/browser.mjs'
import { buildZip } from '../server/docgen/zipwriter.mjs'
import { GatewayError } from '../server/gateway/errors.mjs'

/* ============================================================
   Agent runtime: project detection, codebase analysis, and the
   ZIP import path.

   The import path is a security boundary — an uploaded archive is
   hostile input — so the escape cases carry the weight here.
   ============================================================ */

let ws

before(() => {
  ws = ensureWorkspace()
})

after(async () => {
  await stopAllPreviews()
  if (ws) removeWorkspace(ws.taskId)
})

/* ---------- tool registry ---------- */

describe('tool registry', () => {
  test('every runtime capability is registered', () => {
    const names = toolNames()
    for (const expected of [
      'start_preview',
      'stop_preview',
      'browser_open',
      'browser_interact',
      'browser_inspect',
      'browser_screenshot',
      'analyze_screenshot',
      'browser_diagnostics',
      'research_web',
      'analyze_project',
      'smoke_test',
      'generate_document',
    ]) {
      assert.ok(names.includes(expected), `${expected} is not registered`)
    }
  })

  test('the original file and command tools are still present', () => {
    const names = toolNames()
    for (const expected of [
      'list_files',
      'read_file',
      'search_code',
      'write_file',
      'edit_file',
      'rename_file',
      'delete_file',
      'run_command',
      'report_plan',
      'finish',
    ]) {
      assert.ok(names.includes(expected), `${expected} went missing`)
    }
  })

  test('no duplicate tool names', () => {
    const names = toolNames()
    assert.equal(new Set(names).size, names.length)
  })

  test('every definition is a well-formed function schema', () => {
    for (const definition of toolDefinitions()) {
      assert.equal(definition.type, 'function')
      assert.ok(definition.function.name)
      assert.ok(definition.function.description, `${definition.function.name} has no description`)
      assert.equal(definition.function.parameters.type, 'object')
      for (const required of definition.function.parameters.required ?? []) {
        assert.ok(
          definition.function.parameters.properties[required],
          `${definition.function.name} requires ${required} but does not declare it`,
        )
      }
    }
  })

  test('browserAvailable answers without throwing', () => {
    assert.equal(typeof browserAvailable(), 'boolean')
  })

  test('the viewports cover phone, tablet and desktop', () => {
    assert.ok(VIEWPORTS.mobile.width < VIEWPORTS.tablet.width)
    assert.ok(VIEWPORTS.tablet.width < VIEWPORTS.desktop.width)
  })
})

/* ---------- project detection ---------- */

describe('runner detection', () => {
  /** A throwaway project directory for one detection case. */
  const project = (name, files) => {
    const dir = join(ws.projectDir, 'detect', name)
    mkdirSync(dir, { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, path)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
    return dir
  }

  test('detects a Vite project', () => {
    const dir = project('vite', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0' } }),
      'index.html': '<html></html>',
    })
    const runner = detectRunner(dir)
    assert.equal(runner.kind, 'vite')
    assert.ok(runner.args.includes('--strictPort'), 'the port must be pinned or the preview URL is wrong')
  })

  test('detects Next.js', () => {
    const dir = project('next', {
      'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '^15.0.0' } }),
    })
    assert.equal(detectRunner(dir).kind, 'next')
  })

  test('falls back to a dev script', () => {
    const dir = project('npm-dev', { 'package.json': JSON.stringify({ scripts: { dev: 'node server.js' } }) })
    const runner = detectRunner(dir)
    assert.equal(runner.kind, 'npm-dev')
    assert.equal(runner.portEnv, 'PORT')
  })

  test('falls back to a start script', () => {
    const dir = project('npm-start', { 'package.json': JSON.stringify({ scripts: { start: 'node .' } }) })
    assert.equal(detectRunner(dir).kind, 'npm-start')
  })

  test('finds a conventional node entry point', () => {
    const dir = project('node-entry', {
      'package.json': JSON.stringify({ name: 'x' }),
      'server.js': 'console.log(1)',
    })
    const runner = detectRunner(dir)
    assert.equal(runner.kind, 'node')
    assert.equal(runner.args[0], 'server.js')
  })

  test('detects a plain static site', () => {
    const dir = project('static', { 'index.html': '<html></html>' })
    const runner = detectRunner(dir)
    assert.equal(runner.kind, 'static')
    assert.equal(runner.needsInstall, false)
  })

  test('detects Django and Python entry points', () => {
    assert.equal(detectRunner(project('django', { 'manage.py': '' })).kind, 'django')
    assert.equal(detectRunner(project('flask', { 'app.py': '' })).kind, 'python')
  })

  test('reports needsInstall only when dependencies are missing', () => {
    const dir = project('needs-install', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }),
    })
    assert.equal(detectRunner(dir).needsInstall, true)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    assert.equal(detectRunner(dir).needsInstall, false)
  })

  test('returns null when there is nothing to run', () => {
    assert.equal(detectRunner(project('nothing', { 'notes.txt': 'hi' })), null)
  })

  test('no previews are left running', () => {
    assert.equal(previewCount(), 0)
  })
})

/* ---------- codebase analysis ---------- */

describe('codebase analysis', () => {
  let dir

  before(() => {
    dir = join(ws.projectDir, 'analyse')
    mkdirSync(join(dir, 'src', 'components'), { recursive: true })
    mkdirSync(join(dir, 'server'), { recursive: true })
    mkdirSync(join(dir, 'tests'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'sample-app',
        version: '2.1.0',
        description: 'A sample',
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' },
        dependencies: { react: '^19.0.0', express: '^4.19.0' },
        devDependencies: { vite: '^6.0.0', typescript: '^5.6.0', vitest: '^2.0.0', tailwindcss: '^3.4.0' },
      }),
    )
    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    writeFileSync(join(dir, 'README.md'), '# Sample App\n\nDoes things.')
    writeFileSync(join(dir, 'src', 'main.tsx'), 'export const main = 1')
    writeFileSync(join(dir, 'src', 'components', 'Card.tsx'), 'export const Card = () => null')
    writeFileSync(
      join(dir, 'server', 'index.js'),
      `app.get('/api/health', h)\napp.post('/api/users', c)\nrouter.delete('/api/users/:id', d)`,
    )
    writeFileSync(join(dir, 'tests', 'app.test.ts'), 'test("x", () => {})')
    // Must be ignored by the walk
    writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), 'module.exports = {}')
  })

  test('identifies the stack', async () => {
    const analysis = await analyseProject(dir)
    assert.equal(analysis.ok, true)
    assert.equal(analysis.name, 'sample-app')
    assert.equal(analysis.version, '2.1.0')
    assert.equal(analysis.stack.language, 'TypeScript')
    assert.ok(analysis.stack.frameworks.includes('React'))
    assert.ok(analysis.stack.frameworks.includes('Express'))
    assert.ok(analysis.stack.build.includes('Vite'))
    assert.ok(analysis.stack.build.includes('Tailwind CSS'))
    assert.ok(analysis.stack.testing.includes('Vitest'))
    assert.equal(analysis.stack.packageManager, 'npm')
  })

  test('reports the real commands', async () => {
    const { commands } = await analyseProject(dir)
    assert.equal(commands.install, 'npm install')
    assert.equal(commands.dev, 'npm run dev')
    assert.equal(commands.build, 'npm run build')
    assert.equal(commands.test, 'npm run test')
    assert.equal(commands.typecheck, 'npm run typecheck')
  })

  test('finds server routes', async () => {
    const { routes } = await analyseProject(dir)
    const paths = routes.map((r) => `${r.method} ${r.path}`)
    assert.ok(paths.includes('GET /api/health'))
    assert.ok(paths.includes('POST /api/users'))
    assert.ok(paths.includes('DELETE /api/users/:id'))
  })

  test('finds entry points', async () => {
    const { entryPoints } = await analyseProject(dir)
    assert.ok(entryPoints.some((e) => e.path === 'src/main.tsx'))
  })

  test('excludes node_modules from the walk', async () => {
    const analysis = await analyseProject(dir)
    assert.ok(
      !analysis.largestFiles.some((f) => f.path.includes('node_modules')),
      'node_modules leaked into the analysis',
    )
    assert.ok(!Object.keys(analysis.stats.topLevelDirectories).includes('node_modules'))
  })

  test('counts test files', async () => {
    const { tests } = await analyseProject(dir)
    assert.ok(tests.count >= 1)
    assert.ok(tests.files.some((f) => f.includes('app.test.ts')))
  })

  test('includes the readme', async () => {
    const analysis = await analyseProject(dir)
    assert.match(analysis.readme, /Sample App/)
  })

  test('a missing directory is reported, not thrown', async () => {
    const analysis = await analyseProject(join(ws.projectDir, 'does-not-exist'))
    assert.equal(analysis.ok, false)
  })

  test('an empty directory analyses cleanly', async () => {
    const empty = join(ws.projectDir, 'empty-analysis')
    mkdirSync(empty, { recursive: true })
    const analysis = await analyseProject(empty)
    assert.equal(analysis.ok, true)
    assert.equal(analysis.stats.files, 0)
  })
})

/* ---------- research version scoping ---------- */

describe('research version scoping', () => {
  test('prefers the installed version over the declared range', () => {
    const dir = join(ws.projectDir, 'versions')
    mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }))
    writeFileSync(join(dir, 'node_modules', 'react', 'package.json'), JSON.stringify({ version: '19.0.2' }))
    assert.equal(installedVersion(dir, 'react'), '19.0.2')
  })

  test('falls back to the manifest range with the caret stripped', () => {
    const dir = join(ws.projectDir, 'versions-manifest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '^6.3.1' } }))
    assert.equal(installedVersion(dir, 'vite'), '6.3.1')
  })

  test('returns null for an unknown package', () => {
    const dir = join(ws.projectDir, 'versions-manifest')
    assert.equal(installedVersion(dir, 'not-installed'), null)
  })

  test('refuses a package name that could escape the directory', () => {
    assert.equal(installedVersion(ws.projectDir, '../../../etc/passwd'), null)
    assert.equal(installedVersion(ws.projectDir, ''), null)
  })
})

/* ---------- zip import: path screening ---------- */

describe('zip entry screening', () => {
  test('accepts ordinary paths', () => {
    for (const path of ['src/index.ts', 'a.txt', 'deep/nested/dir/file.css', 'my-app/src/App.tsx']) {
      assert.equal(safeEntryPath(path).ok, true, `${path} was rejected`)
    }
  })

  test('rejects parent traversal', () => {
    for (const path of ['../etc/passwd', 'a/../../b', '../../../../../../etc/shadow', 'a/./../../b']) {
      const result = safeEntryPath(path)
      assert.equal(result.ok, false, `${path} was accepted`)
      assert.equal(result.reason, 'parent traversal')
    }
  })

  test('rejects absolute paths', () => {
    assert.equal(safeEntryPath('/etc/passwd').reason, 'absolute path')
    assert.equal(safeEntryPath('C:/Windows/System32/x').reason, 'drive letter')
    assert.equal(safeEntryPath('c:file.txt').reason, 'drive letter')
  })

  test('treats a backslash as a separator', () => {
    // On Windows "..\\..\\x" escapes just as "../../x" does
    assert.equal(safeEntryPath('..\\..\\windows\\x').reason, 'parent traversal')
    assert.equal(safeEntryPath('\\\\server\\share\\x').ok, false)
  })

  test('rejects control characters in a name', () => {
    assert.equal(safeEntryPath(`a${String.fromCharCode(0)}b`).reason, 'control character in name')
    assert.equal(safeEntryPath(`a${String.fromCharCode(31)}b`).reason, 'control character in name')
  })

  test('rejects Windows device names, with or without an extension', () => {
    for (const name of ['nul', 'CON', 'aux.txt', 'com1', 'LPT9.log', 'dir/nul.txt']) {
      assert.equal(safeEntryPath(name).reason, 'reserved device name', `${name} was accepted`)
    }
  })

  test('rejects trailing dots and spaces, which Windows silently strips', () => {
    assert.equal(safeEntryPath('file.txt ').reason, 'trailing dot or space')
    assert.equal(safeEntryPath('dir./file').reason, 'trailing dot or space')
  })

  test('rejects an over-long or over-deep path', () => {
    assert.equal(safeEntryPath('x'.repeat(IMPORT_LIMITS.pathLength + 1)).reason, 'path too long')
    assert.equal(safeEntryPath(`${'a/'.repeat(IMPORT_LIMITS.depth + 2)}f`).reason, 'too deeply nested')
  })

  test('rejects an empty name', () => {
    assert.equal(safeEntryPath('').ok, false)
    assert.equal(safeEntryPath('///').ok, false)
    assert.equal(safeEntryPath(null).ok, false)
  })

  test('normalises redundant separators', () => {
    assert.equal(safeEntryPath('a//b/./c.txt').path, 'a/b/c.txt')
  })
})

/* ---------- zip import: extraction ---------- */

describe('zip import', () => {
  /** A fresh destination for each extraction, so cases cannot interfere. */
  let counter = 0
  const destination = () => {
    const dir = join(ws.projectDir, 'import', String(counter++))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test('extracts a normal archive', () => {
    const archive = buildZip([
      { name: 'src/index.js', data: 'console.log(1)' },
      { name: 'package.json', data: '{"name":"x"}' },
      { name: 'README.md', data: '# x' },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)

    assert.equal(result.files, 3)
    assert.equal(readFileSync(join(dir, 'src', 'index.js'), 'utf8'), 'console.log(1)')
    assert.ok(existsSync(join(dir, 'package.json')))
  })

  test('strips a single wrapping directory, as GitHub exports have', () => {
    const archive = buildZip([
      { name: 'my-app-main/src/index.js', data: 'x' },
      { name: 'my-app-main/package.json', data: '{}' },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)

    assert.equal(result.stripped, 'my-app-main')
    assert.ok(existsSync(join(dir, 'src', 'index.js')), 'the wrapper was not stripped')
    assert.ok(!existsSync(join(dir, 'my-app-main')))
  })

  test('keeps the structure when there is no common wrapper', () => {
    const archive = buildZip([
      { name: 'a/one.js', data: 'x' },
      { name: 'b/two.js', data: 'y' },
    ])
    const dir = destination()
    assert.equal(extractZip(archive, dir).stripped, null)
    assert.ok(existsSync(join(dir, 'a', 'one.js')))
  })

  test('excludes dependencies, build output and VCS internals', () => {
    const archive = buildZip([
      { name: 'src/a.js', data: 'keep' },
      { name: 'node_modules/react/index.js', data: 'drop' },
      { name: '.git/config', data: 'drop' },
      { name: 'dist/bundle.js', data: 'drop' },
      { name: 'coverage/lcov.info', data: 'drop' },
      { name: '__pycache__/x.pyc', data: 'drop' },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)

    assert.equal(result.files, 1)
    assert.ok(existsSync(join(dir, 'src', 'a.js')))
    assert.ok(!existsSync(join(dir, 'node_modules')))
    assert.ok(!existsSync(join(dir, 'dist')))
    assert.equal(result.skipped.filter((s) => s.reason === 'excluded by policy').length, 5)
  })

  test('never imports credentials', () => {
    const archive = buildZip([
      { name: 'src/a.js', data: 'keep' },
      { name: '.env', data: 'SECRET=1' },
      { name: '.env.production', data: 'SECRET=2' },
      { name: 'id_rsa', data: 'private key' },
      { name: 'certs/server.pem', data: 'cert' },
      { name: '.npmrc', data: '//registry:_authToken=x' },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)

    assert.equal(result.files, 1)
    for (const secret of ['.env', '.env.production', 'id_rsa', 'certs/server.pem', '.npmrc']) {
      assert.ok(!existsSync(join(dir, secret)), `${secret} was imported`)
    }
    assert.ok(result.skippedTotal >= 5)
  })

  test('refuses to write outside the destination', () => {
    const archive = buildZip([
      { name: 'ok.js', data: 'keep' },
      { name: '../../escaped.js', data: 'malicious' },
      { name: '/etc/passwd', data: 'malicious' },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)

    assert.equal(result.files, 1)
    assert.ok(!existsSync(join(dir, '..', '..', 'escaped.js')))
    assert.ok(result.skipped.some((s) => s.reason === 'parent traversal'))
    assert.ok(result.skipped.some((s) => s.reason === 'absolute path'))
  })

  test('does not expand a nested archive', () => {
    const inner = buildZip([{ name: 'deep.js', data: 'x' }])
    const archive = buildZip([
      { name: 'a.js', data: 'keep' },
      { name: 'bundle.zip', data: inner },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)

    assert.equal(result.files, 1)
    assert.ok(result.skipped.some((s) => s.reason === 'nested archive'))
  })

  test('rejects an archive with too many entries', () => {
    const entries = Array.from({ length: IMPORT_LIMITS.entries + 10 }, (_, i) => ({
      name: `f${i}.txt`,
      data: 'x',
    }))
    assert.throws(() => extractZip(buildZip(entries), destination()), /entries/i)
  })

  test('rejects a decompression bomb', () => {
    // 4 MB of zeros deflates to about 4 KB: a ratio of ~1000 against a limit of 120.
    // A second, ordinary file is included so the archive is not rejected wholesale
    // for having nothing importable — the bomb specifically must be the thing dropped.
    const bomb = buildZip([
      { name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024, 0) },
      { name: 'ok.js', data: 'keep' },
    ])
    const dir = destination()
    const result = extractZip(bomb, dir)

    assert.ok(
      result.skipped.some((s) => s.reason === 'suspicious compression ratio'),
      'the bomb was not flagged',
    )
    assert.ok(!existsSync(join(dir, 'bomb.bin')), 'the bomb was written to disk')
    assert.ok(existsSync(join(dir, 'ok.js')), 'the ordinary file should still arrive')
  })

  test('an archive of nothing but a bomb is refused outright', () => {
    const bomb = buildZip([{ name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024, 0) }])
    assert.throws(() => extractZip(bomb, destination()), /no importable files/i)
  })

  test('rejects an over-large single file', () => {
    const big = buildZip([
      { name: 'huge.bin', data: Buffer.alloc(IMPORT_LIMITS.fileBytes + 1024, 7) },
      { name: 'ok.js', data: 'keep' },
    ])
    const dir = destination()
    const result = extractZip(big, dir)
    assert.ok(result.skipped.some((s) => s.reason === 'file too large'))
    assert.ok(existsSync(join(dir, 'ok.js')), 'the good file should still arrive')
  })

  test('rejects something that is not a ZIP', () => {
    assert.throws(() => extractZip(Buffer.from('not a zip at all'), destination()), /not a valid ZIP/i)
    assert.throws(() => extractZip(Buffer.alloc(0), destination()), /no archive/i)
    assert.throws(() => extractZip('a string', destination()), GatewayError)
  })

  test('rejects an archive with nothing importable', () => {
    const archive = buildZip([{ name: 'node_modules/x/index.js', data: 'drop' }])
    assert.throws(() => extractZip(archive, destination()), /no importable files/i)
  })

  test('a directory entry does not become a file', () => {
    const archive = buildZip([
      { name: 'src/', data: '' },
      { name: 'src/a.js', data: 'x' },
    ])
    const dir = destination()
    const result = extractZip(archive, dir)
    assert.equal(result.files, 1)
    assert.ok(existsSync(join(dir, 'src', 'a.js')))
  })
})

/* ---------- binary writing ---------- */

describe('binary file writing', () => {
  test('writes a buffer and reports the action', () => {
    const first = writeBinaryFile(ws.projectDir, 'assets/out.bin', Buffer.from([1, 2, 3, 4]))
    assert.equal(first.action, 'created')
    assert.equal(first.bytes, 4)
    assert.deepEqual([...readFileSync(join(ws.projectDir, 'assets', 'out.bin'))], [1, 2, 3, 4])

    const second = writeBinaryFile(ws.projectDir, 'assets/out.bin', Buffer.from([5]))
    assert.equal(second.action, 'updated')
  })

  test('is confined to the workspace', () => {
    assert.throws(() => writeBinaryFile(ws.projectDir, '../escaped.bin', Buffer.from([1])), GatewayError)
    assert.throws(() => writeBinaryFile(ws.projectDir, 'C:/Windows/x.bin', Buffer.from([1])), GatewayError)
  })

  test('rejects a non-buffer', () => {
    assert.throws(() => writeBinaryFile(ws.projectDir, 'a.bin', 'a string'), /buffer/i)
  })

  test('text and binary writers coexist', () => {
    writeFile(ws.projectDir, 'mixed/a.txt', 'text')
    writeBinaryFile(ws.projectDir, 'mixed/b.bin', Buffer.from([0]))
    assert.equal(readFileSync(join(ws.projectDir, 'mixed', 'a.txt'), 'utf8'), 'text')
  })
})
