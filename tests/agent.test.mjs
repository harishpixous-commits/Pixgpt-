import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureWorkspace, removeWorkspace, resolveInside, workspaceSize } from '../server/agent/workspace.mjs'
import { classify, resolveProgram, RISK, runCommand } from '../server/agent/terminal.mjs'
import { deleteFile, editFile, listFiles, projectTree, readFile, searchFiles, writeFile } from '../server/agent/files.mjs'
import { coerceArgs, toolDefinitions, toolNames } from '../server/agent/tools.mjs'
import { zipProject } from '../server/agent/zip.mjs'
import { GatewayError } from '../server/gateway/errors.mjs'

/* ============================================================
   Coding agent: sandbox containment, command policy, file tools.

   These are the security boundary, so the escape cases matter more
   than the happy paths.
   ============================================================ */

let ws

before(() => {
  ws = ensureWorkspace()
})

after(() => {
  if (ws) removeWorkspace(ws.taskId)
})

const throwsBad = (fn) => assert.throws(fn, (e) => e instanceof GatewayError && e.code === 'bad_request')

describe('workspace containment', () => {
  test('accepts ordinary relative paths', () => {
    assert.ok(resolveInside(ws.projectDir, 'src/index.js'))
    assert.ok(resolveInside(ws.projectDir, 'a/b/c/deep.txt'))
    assert.ok(resolveInside(ws.projectDir, './x.js'))
  })

  test('refuses parent-directory escapes', () => {
    for (const p of ['../escape.txt', '../../../../etc/passwd', 'src/../../../out.txt', 'a/./../../b']) {
      throwsBad(() => resolveInside(ws.projectDir, p))
    }
  })

  test('refuses absolute paths on both platforms', () => {
    for (const p of ['/etc/passwd', 'C:/Windows/win.ini', 'c:\\Windows\\system32', '//server/share']) {
      throwsBad(() => resolveInside(ws.projectDir, p))
    }
  })

  test('refuses null bytes and oversized paths', () => {
    throwsBad(() => resolveInside(ws.projectDir, 'a\u0000b'))
    throwsBad(() => resolveInside(ws.projectDir, 'a'.repeat(500)))
    throwsBad(() => resolveInside(ws.projectDir, ''))
  })

  test('mustExist reports a missing file rather than inventing one', () => {
    throwsBad(() => resolveInside(ws.projectDir, 'nope.txt', { mustExist: true }))
  })

  test('an invalid task id cannot create a workspace', () => {
    throwsBad(() => ensureWorkspace('../evil'))
    throwsBad(() => ensureWorkspace('not-a-task-id'))
    throwsBad(() => removeWorkspace('../../'))
  })

  test('workspaceSize walks the tree', () => {
    writeFile(ws.projectDir, 'size/a.txt', 'x'.repeat(100))
    assert.ok(workspaceSize(ws.projectDir) >= 100)
  })
})

describe('command policy', () => {
  test('development tools are permitted', () => {
    assert.equal(classify('npm', ['run', 'build']).risk, RISK.SAFE)
    assert.equal(classify('node', ['index.js']).risk, RISK.SAFE)
    assert.equal(classify('git', ['status']).risk, RISK.SAFE)
  })

  test('restoring declared dependencies is routine', () => {
    // No package named: this only installs what package.json already asks for
    assert.equal(classify('npm', ['install']).risk, RISK.LOW_RISK)
    assert.equal(classify('npm', ['ci']).risk, RISK.LOW_RISK)
    assert.equal(classify('npm', ['install', '--no-audit', '--no-fund']).risk, RISK.LOW_RISK)
  })

  test('adding a named third-party package needs approval', () => {
    // Pulling code the user never asked for is the case approval exists for
    for (const [prog, args] of [
      ['npm', ['install', 'express']],
      ['npm', ['i', '-D', 'vite']],
      ['yarn', ['add', 'lodash']],
      ['pnpm', ['add', 'react']],
      ['pip', ['install', 'requests']],
    ]) {
      const { risk, reason } = classify(prog, args)
      assert.equal(risk, RISK.REQUIRES_APPROVAL, `${prog} ${args.join(' ')} should need approval`)
      assert.match(reason, /third-party/i)
    }
  })

  test('npx needs approval — it runs remote code', () => {
    assert.equal(classify('npx', ['create-vite', 'app']).risk, RISK.REQUIRES_APPROVAL)
  })

  test('running project scripts stays unblocked', () => {
    assert.equal(classify('npm', ['run', 'build']).risk, RISK.SAFE)
    assert.equal(classify('npm', ['test']).risk, RISK.SAFE)
  })

  test('registry account operations need approval', () => {
    for (const sub of ['publish', 'login', 'token', 'config', 'adduser']) {
      assert.equal(classify('npm', [sub]).risk, RISK.REQUIRES_APPROVAL, `npm ${sub} should need approval`)
    }
  })

  test('shells are blocked outright — they would defeat the no-shell guarantee', () => {
    for (const shell of ['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']) {
      assert.equal(classify(shell, ['-c', 'echo hi']).risk, RISK.BLOCKED, `${shell} must be blocked`)
    }
  })

  test('privilege escalation and destructive system tools are blocked', () => {
    for (const prog of ['sudo', 'su', 'runas', 'mkfs', 'diskpart', 'format', 'shutdown', 'reg', 'netsh']) {
      assert.equal(classify(prog, []).risk, RISK.BLOCKED, `${prog} must be blocked`)
    }
  })

  test('credential and remote-access tools are blocked', () => {
    for (const prog of ['ssh', 'scp', 'ssh-keygen', 'passwd', 'cmdkey', 'curl', 'wget', 'nc']) {
      assert.equal(classify(prog, []).risk, RISK.BLOCKED, `${prog} must be blocked`)
    }
  })

  test('rm -rf / is blocked by argument, not just by program', () => {
    assert.equal(classify('rm', ['-rf', '/']).risk, RISK.BLOCKED)
  })

  test('a program given as a path is blocked', () => {
    assert.equal(classify('/usr/bin/node', []).risk, RISK.BLOCKED)
    assert.equal(classify('..\\evil.exe', []).risk, RISK.BLOCKED)
  })

  test('history-rewriting git needs approval', () => {
    for (const sub of ['reset', 'clean', 'checkout', 'rebase', 'push']) {
      assert.equal(classify('git', [sub]).risk, RISK.REQUIRES_APPROVAL, `git ${sub}`)
    }
  })

  test('publishing and credentials need approval', () => {
    assert.equal(classify('npm', ['publish']).risk, RISK.REQUIRES_APPROVAL)
    assert.equal(classify('npm', ['login']).risk, RISK.REQUIRES_APPROVAL)
  })

  test('paths outside the workspace as arguments need approval', () => {
    assert.equal(classify('node', ['C:/Windows/x.js']).risk, RISK.REQUIRES_APPROVAL)
    assert.equal(classify('node', ['/etc/passwd']).risk, RISK.REQUIRES_APPROVAL)
  })

  test('an unknown program needs approval rather than running silently', () => {
    assert.equal(classify('somethingnobodyknows', []).risk, RISK.REQUIRES_APPROVAL)
  })

  test('a blocked command is refused before it can run', async () => {
    await assert.rejects(
      () => runCommand({ program: 'bash', args: ['-c', 'echo hi'], projectDir: ws.projectDir }),
      (e) => e instanceof GatewayError,
    )
  })
})

describe('command execution', () => {
  test('runs inside the workspace and reports the result', async () => {
    const r = await runCommand({
      program: 'node',
      args: ['-e', 'console.log(process.cwd())'],
      projectDir: ws.projectDir,
    })
    assert.equal(r.ok, true)
    assert.equal(r.exitCode, 0)
    assert.ok(r.stdout.includes(ws.taskId), 'cwd must be the task workspace')
    assert.ok(r.durationMs >= 0)
  })

  test('a non-zero exit is reported, not swallowed', async () => {
    const r = await runCommand({ program: 'node', args: ['-e', 'process.exit(3)'], projectDir: ws.projectDir })
    assert.equal(r.ok, false)
    assert.equal(r.exitCode, 3)
  })

  test('stderr is captured', async () => {
    const r = await runCommand({
      program: 'node',
      args: ['-e', 'console.error("boom"); process.exit(1)'],
      projectDir: ws.projectDir,
    })
    assert.ok(r.stderr.includes('boom'))
  })

  test('gateway credentials are NOT inherited by child processes', async () => {
    const r = await runCommand({
      program: 'node',
      args: [
        '-e',
        'const leaked=["OMNIROUTE_API_KEY","AI_GATEWAY_API_KEY","WEB_SEARCH_API_KEY","OMNIROUTE_BASE_URL"].filter(k=>process.env[k]!==undefined);console.log(JSON.stringify(leaked))',
      ],
      projectDir: ws.projectDir,
    })
    assert.equal(r.stdout.trim(), '[]', 'no secret may reach a spawned command')
  })

  test('a timeout kills the command', async () => {
    const r = await runCommand({
      program: 'node',
      args: ['-e', 'setTimeout(()=>{},60000)'],
      projectDir: ws.projectDir,
      timeoutMs: 700,
    })
    assert.equal(r.timedOut, true)
    assert.equal(r.ok, false)
  })

  test('a missing program is reported cleanly', async () => {
    const r = await runCommand({ program: 'nosuchtool', args: [], projectDir: ws.projectDir })
    assert.equal(r.ok, false)
    assert.ok(/not found/i.test(r.stderr))
  })

  test('node CLIs resolve to a real executable', () => {
    assert.ok(resolveProgram('node'), 'node must resolve')
    assert.equal(resolveProgram('definitely-not-installed-xyz'), null)
    assert.equal(resolveProgram('../escape'), null)
  })
})

describe('file tools', () => {
  test('write then read round-trips', () => {
    const w = writeFile(ws.projectDir, 'f/app.js', 'const a = 1;\n')
    assert.equal(w.action, 'created')
    assert.equal(readFile(ws.projectDir, 'f/app.js').content, 'const a = 1;\n')
    assert.equal(writeFile(ws.projectDir, 'f/app.js', 'const a = 2;\n').action, 'updated')
  })

  test('edit replaces a unique snippet', () => {
    writeFile(ws.projectDir, 'f/edit.js', 'let x = 1;\nlet y = 2;\n')
    editFile(ws.projectDir, 'f/edit.js', 'let x = 1;', 'let x = 99;')
    assert.ok(readFile(ws.projectDir, 'f/edit.js').content.includes('let x = 99;'))
  })

  test('an ambiguous edit fails loudly instead of guessing', () => {
    writeFile(ws.projectDir, 'f/dup.js', 'same\nsame\n')
    assert.throws(
      () => editFile(ws.projectDir, 'f/dup.js', 'same', 'other'),
      (e) => /appears 2 times/.test(e.message),
    )
  })

  test('editing text that is not present fails loudly', () => {
    writeFile(ws.projectDir, 'f/miss.js', 'hello\n')
    assert.throws(
      () => editFile(ws.projectDir, 'f/miss.js', 'goodbye', 'x'),
      (e) => /was not found/.test(e.message),
    )
  })

  test('file tools honour containment', () => {
    throwsBad(() => writeFile(ws.projectDir, '../escaped.txt', 'x'))
    throwsBad(() => readFile(ws.projectDir, '../../../etc/passwd'))
    throwsBad(() => deleteFile(ws.projectDir, '../../important'))
  })

  test('binary files are refused rather than mangled', () => {
    const abs = join(ws.projectDir, 'f', 'bin.dat')
    mkdirSync(join(ws.projectDir, 'f'), { recursive: true })
    writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    throwsBad(() => readFile(ws.projectDir, 'f/bin.dat'))
  })

  test('search finds matches with line numbers', () => {
    writeFile(ws.projectDir, 'f/search.js', 'const needle = 1;\nconst other = 2;\n')
    const { hits } = searchFiles(ws.projectDir, 'needle')
    assert.ok(hits.some((h) => h.path === 'f/search.js' && h.line === 1))
  })

  test('regex search works and a bad pattern is reported', () => {
    assert.ok(searchFiles(ws.projectDir, 'const\\s+\\w+', { regex: true }).hits.length > 0)
    throwsBad(() => searchFiles(ws.projectDir, '([', { regex: true }))
  })

  test('listing skips dependency and build noise', () => {
    mkdirSync(join(ws.projectDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(ws.projectDir, 'node_modules', 'pkg', 'index.js'), 'x')
    const { entries } = listFiles(ws.projectDir)
    const nm = entries.find((e) => e.path === 'node_modules')
    assert.equal(nm?.skipped, true, 'node_modules must be marked skipped, not walked')
    assert.ok(!entries.some((e) => e.path.startsWith('node_modules/')), 'must not walk into node_modules')
  })

  test('projectTree renders something usable', () => {
    const { tree, fileCount } = projectTree(ws.projectDir)
    assert.ok(fileCount > 0)
    assert.ok(tree.includes('app.js'))
  })

  test('deleting the project root is refused', () => {
    throwsBad(() => deleteFile(ws.projectDir, '.'))
  })
})

describe('tool registry', () => {
  test('exposes the expected tools with valid schemas', () => {
    const names = toolNames()
    for (const expected of ['list_files', 'read_file', 'search_code', 'write_file', 'edit_file', 'run_command', 'report_plan', 'finish']) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`)
    }
    for (const def of toolDefinitions()) {
      assert.equal(def.type, 'function')
      assert.ok(def.function.name)
      assert.ok(def.function.description.length > 20, `${def.function.name} needs a real description`)
      assert.equal(def.function.parameters.type, 'object')
    }
  })

  test('string args from the model are coerced to an array', () => {
    assert.deepEqual(coerceArgs('install express'), ['install', 'express'])
    assert.deepEqual(coerceArgs(['a', 'b']), ['a', 'b'])
    assert.deepEqual(coerceArgs('commit -m "a b"'), ['commit', '-m', 'a b'])
    assert.deepEqual(coerceArgs(undefined), [])
  })
})

describe('zip packaging', () => {
  test('produces a valid archive under one root folder', () => {
    writeFile(ws.projectDir, 'zipme/package.json', '{"name":"z"}')
    writeFile(ws.projectDir, 'zipme/src/a.js', 'export const a = 1\n')
    const { buffer, entries } = zipProject(ws.projectDir, { rootName: 'demo' })
    assert.ok(entries > 0)
    // Local file header and end-of-central-directory signatures
    assert.equal(buffer.readUInt32LE(0), 0x04034b50)
    assert.ok(buffer.includes(Buffer.from('demo/', 'utf8')), 'entries live under the root folder')
    assert.ok(buffer.length > 100)
  })

  test('an empty project cannot be packaged', () => {
    const empty = ensureWorkspace()
    try {
      throwsBad(() => zipProject(empty.projectDir))
    } finally {
      removeWorkspace(empty.taskId)
    }
  })

  test('node_modules is excluded from the archive', () => {
    const { buffer } = zipProject(ws.projectDir, { rootName: 'demo' })
    assert.ok(!buffer.includes(Buffer.from('demo/node_modules/', 'utf8')), 'dependencies must not be shipped')
  })
})
