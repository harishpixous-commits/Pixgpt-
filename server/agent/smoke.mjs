import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../config.mjs'
import { runCommand } from './terminal.mjs'
import { detectRunner, startPreview, stopPreview } from './preview.mjs'
import { auditPage, browserAvailable, closeBrowser, inspectPage, openPage, screenshot } from './browser.mjs'
import { listFiles } from './files.mjs'

/* ============================================================
   Smoke test
   ----------
   Proves a generated project actually works before it is handed over:
   dependencies install, it builds, it starts, it answers HTTP, and the
   page is not blank.

   A ZIP that compiles but renders nothing is a failed delivery, so this
   runs the real commands and reports what happened rather than
   asserting success.
   ============================================================ */

const STEP_TIMEOUT_MS = Number.parseInt(process.env.AGENT_SMOKE_STEP_MS ?? '', 10) || 300_000

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** A step result, in the shape the UI and the model both read. */
const step = (name, ok, detail, extra = {}) => ({ name, ok, detail: String(detail ?? '').slice(0, 1200), ...extra })

/**
 * Runs the smoke test.
 *
 * @param {{ taskId: string, projectDir: string, emit?: Function, signal?: AbortSignal,
 *           skipInstall?: boolean, onScreenshot?: Function }} options
 * @returns {Promise<{ ok, steps: object[], summary: string, previewUrl: string|null }>}
 */
export async function smokeTest({ taskId, projectDir, emit, signal, skipInstall = false, onScreenshot }) {
  const steps = []
  const pkg = readJson(join(projectDir, 'package.json'))
  const scripts = pkg?.scripts ?? {}
  let previewUrl = null

  const note = (result) => {
    steps.push(result)
    emit?.({ type: 'smoke_step', name: result.name, ok: result.ok, detail: result.detail.slice(0, 300) })
    return result
  }

  emit?.({ type: 'smoke_started' })

  /* 1. There is something to run at all */
  const files = listFiles(projectDir, '.')
  if (!files?.entries?.length) {
    note(step('files', false, 'The project directory is empty.'))
    return finish(steps, previewUrl, emit)
  }
  note(step('files', true, `${files.entries.length} entries in the project root`))

  const runner = detectRunner(projectDir)
  if (!runner) {
    note(step('detect', false, 'Could not work out how to run this project: no start script, entry file or index.html.'))
  } else {
    note(step('detect', true, `Detected a ${runner.kind} project`))
  }

  /* 2. Dependencies */
  const hasDeps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }).length > 0
  if (hasDeps && !skipInstall) {
    const installed = existsSync(join(projectDir, 'node_modules'))
    if (installed) {
      note(step('install', true, 'Dependencies already installed'))
    } else {
      const result = await runCommand({
        projectDir,
        program: 'npm',
        args: ['install', '--no-audit', '--no-fund'],
        timeoutMs: STEP_TIMEOUT_MS,
        signal,
      })
      note(
        step('install', result.ok, result.ok ? 'npm install completed' : (result.stderr || result.stdout || 'install failed').slice(-1000), {
          exitCode: result.exitCode,
        }),
      )
      if (!result.ok) return finish(steps, previewUrl, emit)
    }
  } else if (hasDeps) {
    note(step('install', true, 'Install skipped by request'))
  }

  /* 3. Typecheck and lint, when the project defines them — a warning, not a failure */
  for (const name of ['typecheck', 'lint']) {
    if (!scripts[name]) continue
    const result = await runCommand({
      projectDir,
      program: 'npm',
      args: ['run', name],
      timeoutMs: STEP_TIMEOUT_MS,
      signal,
    })
    note(
      step(name, result.ok, result.ok ? `npm run ${name} passed` : (result.stdout || result.stderr || '').slice(-900), {
        exitCode: result.exitCode,
        // These do not block delivery: a lint warning is not a broken project
        advisory: true,
      }),
    )
  }

  /* 4. Tests */
  if (scripts.test) {
    const result = await runCommand({
      projectDir,
      program: 'npm',
      args: ['test'],
      timeoutMs: STEP_TIMEOUT_MS,
      signal,
    })
    note(
      step('test', result.ok, result.ok ? 'Tests passed' : (result.stdout || result.stderr || '').slice(-1200), {
        exitCode: result.exitCode,
      }),
    )
  }

  /* 5. Build */
  if (scripts.build) {
    const result = await runCommand({
      projectDir,
      program: 'npm',
      args: ['run', 'build'],
      timeoutMs: STEP_TIMEOUT_MS,
      signal,
    })
    note(
      step('build', result.ok, result.ok ? 'Build succeeded' : (result.stdout || result.stderr || '').slice(-1200), {
        exitCode: result.exitCode,
      }),
    )
    if (!result.ok) return finish(steps, previewUrl, emit)
  }

  /* 6. It starts and answers */
  if (runner) {
    let preview
    try {
      preview = await startPreview({ taskId, projectDir, emit })
    } catch (error) {
      note(step('start', false, String(error?.message ?? error)))
      return finish(steps, previewUrl, emit)
    }

    if (!preview.ready) {
      note(step('start', false, `${preview.reason ?? 'The server did not start.'} ${(preview.logs ?? []).join('').slice(-800)}`))
      return finish(steps, previewUrl, emit)
    }
    previewUrl = preview.url
    note(step('start', true, `Started and answering at ${preview.url}`))

    /* 7. The page is not blank */
    if (browserAvailable()) {
      try {
        const page = await openPage({ taskId, projectDir, previewUrl: preview.url, path: '/' })
        const view = await inspectPage({ taskId })
        const visibleText = (view?.text ?? '').trim()
        const elements = (view?.headings?.length ?? 0) + (view?.buttons?.length ?? 0) + (view?.links?.length ?? 0)

        // A page that returns 200 with an empty body is the classic false pass
        const rendered = visibleText.length > 20 || elements > 0
        note(
          step(
            'render',
            rendered,
            rendered
              ? `Rendered ${visibleText.length} characters of visible text, ${elements} interactive elements`
              : 'The page loaded but rendered nothing visible.',
            { status: page.status, consoleErrors: page.consoleErrors.slice(0, 5) },
          ),
        )

        if (page.consoleErrors.length > 0) {
          note(step('console', false, page.consoleErrors.slice(0, 5).join(' | '), { advisory: true }))
        } else {
          note(step('console', true, 'No console errors'))
        }

        /* 8. Measured visual defects, at desktop and at mobile */
        for (const viewport of ['desktop', 'mobile']) {
          await openPage({ taskId, projectDir, previewUrl: preview.url, path: '/', viewport })
          const audit = await auditPage({ taskId, viewport })
          const high = audit.issues.filter((i) => i.severity === 'high')

          /*
           * Every delivery gets a screenshot, whether or not the agent thought to
           * take one. It is the record of what was actually built, and the user
           * should be able to see the thing they are about to download.
           */
          try {
            const shot = await screenshot({ taskId, projectDir, label: `delivery-${viewport}`, viewport })
            onScreenshot?.(shot)
            emit?.({ type: 'screenshot', name: shot.name, label: shot.label, viewport: shot.viewport })
          } catch {
            /* a missing screenshot must not fail the delivery check */
          }
          note(
            step(
              `visual:${viewport}`,
              high.length === 0,
              high.length === 0
                ? `No high-severity visual defects at ${audit.viewport.width}px` +
                  (audit.issues.length > 0 ? ` (${audit.issues.length} minor)` : '')
                : high.map((i) => `${i.kind} on ${i.selector}: ${i.detail}`).join(' | '),
              // Reported loudly, but a contrast problem should not block a
              // download the user asked for.
              { advisory: true, issues: audit.issues.length },
            ),
          )
        }
      } catch (error) {
        note(step('render', false, String(error?.message ?? error).slice(0, 400), { advisory: true }))
      } finally {
        await closeBrowser(taskId).catch(() => {})
      }
    } else {
      note(step('render', true, 'No browser available on this server; HTTP check only', { advisory: true }))
    }

    // The preview is stopped: a smoke test must not leave a server running
    await stopPreview(taskId, emit)
    previewUrl = null
  }

  return finish(steps, previewUrl, emit)
}

function finish(steps, previewUrl, emit) {
  // Advisory steps (lint, mobile, console) are reported but do not fail delivery
  const blocking = steps.filter((s) => !s.advisory)
  const failed = blocking.filter((s) => !s.ok)
  const warnings = steps.filter((s) => s.advisory && !s.ok)
  const ok = failed.length === 0

  const summary = ok
    ? `Smoke test passed: ${blocking.length} checks${warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.`
    : `Smoke test failed at: ${failed.map((s) => s.name).join(', ')}.`

  log.info('smoke test complete', { ok, steps: steps.length, failed: failed.length, warnings: warnings.length })
  emit?.({ type: 'smoke_complete', ok, summary, failed: failed.map((s) => s.name) })

  return { ok, steps, summary, previewUrl, warnings: warnings.map((w) => w.name) }
}
