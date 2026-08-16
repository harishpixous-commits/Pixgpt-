import { auditPage, browserAvailable, collectDiagnostics, inspectPage, interact, openPage, screenshot } from './browser.mjs'
import { getPreview, startPreview, stopPreview } from './preview.mjs'
import { analyseScreenshot } from './vision.mjs'
import { fetchPageForAgent, researchDeep, researchGithub, researchTopic } from './research.mjs'
import { analyseProject } from './analyze.mjs'
import { smokeTest } from './smoke.mjs'
import { findSymbols, getCodeMap, symbolInfo } from './codemap.mjs'
import { writeBinaryFile } from './files.mjs'
import { generateDocument } from '../docgen/index.mjs'
import { generateImageJob } from '../generation/index.mjs'
import { getJob, jobEvents } from '../generation/jobs.mjs'
import { getArtifact } from '../artifacts.mjs'

/* ============================================================
   Runtime tools: preview, browser, vision, research, analysis
   -----------------------------------------------------------
   Kept in their own module so the core file tools stay readable.
   Registered alongside them by tools.mjs.
   ============================================================ */

export const RUNTIME_TOOLS = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'start_preview',
        description:
          'Start the project so it can be opened in a browser. Detects the project type from what is on disk. Returns the preview URL, or the reason it would not start along with the server logs.',
        parameters: { type: 'object', properties: {} },
      },
    },
    mutates: true,
    run: async (ctx) => {
      const result = await startPreview({ taskId: ctx.taskId, projectDir: ctx.projectDir, emit: ctx.emit })
      ctx.setPreview?.(result.ready ? result.url : null)
      return result.ready
        ? { ok: true, url: result.url, kind: result.kind, hint: 'Now call browser_open to check it actually renders.' }
        : { ok: false, reason: result.reason, logs: result.logs, hint: 'Read the logs, fix the cause, then start it again.' }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'stop_preview',
        description: 'Stop this task’s preview server.',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async (ctx) => stopPreview(ctx.taskId, ctx.emit),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'browser_open',
        description:
          'Open a page of the running preview in a real browser. Reports HTTP status, page title, console errors and failed network requests. Call start_preview first.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path on the preview, e.g. "/" or "/login".' },
            viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
          },
        },
      },
    },
    run: async (ctx, { path = '/', viewport = 'desktop' }) => {
      const preview = getPreview(ctx.taskId)
      if (!preview) return { ok: false, error: 'No preview is running. Call start_preview first.' }
      if (!browserAvailable()) return { ok: false, error: 'No browser is installed on this server for testing.' }
      const result = await openPage({
        taskId: ctx.taskId,
        projectDir: ctx.projectDir,
        previewUrl: preview.url,
        path,
        viewport,
      })
      ctx.emit?.({ type: 'browser_action', action: `open ${path}`, detail: `${viewport} · HTTP ${result.status}` })
      for (const message of result.consoleErrors) ctx.emit?.({ type: 'console_error', message })
      for (const detail of result.networkErrors) ctx.emit?.({ type: 'network_error', detail })
      return result
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'browser_interact',
        description:
          'Interact with the open page: click, type, select, submit, scroll, wait, press a key, or switch viewport. Use selectors discovered with browser_inspect.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'select', 'submit', 'scroll', 'wait', 'press', 'viewport'] },
            selector: { type: 'string', description: 'CSS selector to act on.' },
            text: { type: 'string', description: 'Text to type, option value, key name, or scroll amount.' },
            viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
          },
          required: ['action'],
        },
      },
    },
    run: async (ctx, args) => {
      const result = await interact({ taskId: ctx.taskId, ...args })
      ctx.emit?.({
        type: 'browser_action',
        action: `${args.action} ${args.selector ?? ''}`.trim(),
        detail: result.ok ? 'ok' : result.error,
      })
      return result
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'browser_inspect',
        description:
          'Read the open page: visible text, headings, links, buttons, form fields, and whether it overflows horizontally. Use this to find selectors and to confirm content really rendered.',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string', description: 'Optional scope selector.' } },
        },
      },
    },
    run: async (ctx, { selector }) => inspectPage({ taskId: ctx.taskId, selector }),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description:
          'Capture a screenshot of the open page, then call analyze_screenshot to actually look at it. Never judge UI quality from source code alone.',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short name, e.g. "dashboard-desktop".' },
            fullPage: { type: 'boolean' },
            viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
          },
        },
      },
    },
    run: async (ctx, { label = 'screenshot', fullPage = false, viewport }) => {
      const shot = await screenshot({ taskId: ctx.taskId, projectDir: ctx.projectDir, label, fullPage, viewport })
      ctx.setLastScreenshot?.(shot)
      ctx.emit?.({ type: 'screenshot', name: shot.name, label: shot.label, viewport: shot.viewport })
      // The base64 image stays out of the transcript — only metadata goes back.
      return {
        ok: true,
        name: shot.name,
        label: shot.label,
        viewport: shot.viewport,
        bytes: shot.bytes,
        hint: 'Call analyze_screenshot to inspect it.',
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'analyze_screenshot',
        description:
          'Send the latest screenshot to a vision model and get concrete visual defects back: broken layout, overflow, clipped or missing content, poor contrast, bad spacing, mobile problems. This is how UI quality is judged.',
        parameters: {
          type: 'object',
          properties: {
            expectation: {
              type: 'string',
              description: 'What the page should show, so deviations can be spotted.',
            },
            name: {
              type: 'string',
              description:
                'Which screenshot to analyse, as returned by browser_screenshot. Defaults to the most recent one. Give it explicitly when you have taken several.',
            },
          },
        },
      },
    },
    run: async (ctx, { expectation = '', name }) => {
      const shot = name ? ctx.getScreenshot?.(name) : ctx.getLastScreenshot?.()
      if (!shot) {
        return {
          ok: false,
          error: name
            ? `No screenshot called "${name}". Take one with browser_screenshot first.`
            : 'No screenshot yet — call browser_screenshot first.',
        }
      }

      const analysis = await analyseScreenshot({
        dataUrl: shot.dataUrl,
        expectation,
        viewport: shot.viewport,
        signal: ctx.signal,
      })

      /*
       * A failed analysis must never read as a pass. If the vision model could
       * not be reached, the agent has to know the page is unverified rather
       * than believing it was checked and found clean.
       */
      if (analysis.failed) {
        ctx.emit?.({
          type: 'visual_analysis',
          failed: true,
          issues: 0,
          findings: `could not analyse the screenshot (${analysis.code})`,
        })
        return {
          ok: false,
          verified: false,
          error: analysis.summary,
          hint: 'Visual checking is unavailable. Verify what you can with browser_inspect, and say in your summary that the UI was not visually verified.',
        }
      }

      ctx.emit?.({
        type: 'visual_analysis',
        issues: analysis.issues.length,
        viewport: shot.viewport,
        findings: analysis.issues.slice(0, 3).join(' · ') || 'no visual defects found',
      })
      return { ...analysis, verified: true, screenshot: shot.name, viewport: shot.viewport }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'audit_page',
        description:
          'Measure the rendered page for real visual defects: horizontal overflow, unreadable contrast ratios, clipped content, invisible text, broken images, tiny tap targets, blank pages. Returns exact numbers and the element responsible. Run this at desktop AND mobile — it is the reliable visual check, and unlike analyze_screenshot it never depends on an external model.',
        parameters: {
          type: 'object',
          properties: {
            viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
          },
        },
      },
    },
    run: async (ctx, { viewport }) => {
      const result = await auditPage({ taskId: ctx.taskId, viewport })
      ctx.emit?.({
        type: 'visual_analysis',
        source: 'audit',
        viewport: result.viewport,
        issues: result.issues.length,
        findings:
          result.issues.slice(0, 3).map((i) => `${i.kind}: ${i.detail}`).join(' · ') || 'no measurable defects',
      })
      return {
        ...result,
        hint: result.passed
          ? 'No high-severity defects at this viewport.'
          : 'Fix the high-severity findings, then run audit_page again to confirm.',
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'browser_diagnostics',
        description: 'Console errors and failed network requests collected since the page was opened.',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: (ctx) => collectDiagnostics(ctx.taskId),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'research_web',
        description:
          'Search the web for authoritative technical information. Version-scoped: give packageName and the search is limited to the major version actually installed here, so you do not get examples for the wrong version. Use it when you are unsure of an API or a version-specific detail.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look up.' },
            packageName: {
              type: 'string',
              description: 'The package this is about. Scopes the search to the installed major version.',
            },
          },
          required: ['query'],
        },
      },
    },
    run: async (ctx, { query, packageName }) => {
      const result = await researchTopic({ query, packageName, projectDir: ctx.projectDir, signal: ctx.signal })
      ctx.emit?.({
        type: 'research',
        query: result.scopedQuery ?? query,
        sources: result.sources.map((s) => s.domain).slice(0, 4).join(' · '),
      })
      return result
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'research_deep',
        description:
          'Research a question properly: several searches, several sources read in full, cross-compared, with citations and any disagreements between sources called out. Slower than research_web — use it when the answer matters and one search is not enough.',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: 'The question to research.' } },
          required: ['question'],
        },
      },
    },
    run: async (ctx, { question }) => {
      const result = await researchDeep({
        question,
        projectDir: ctx.projectDir,
        signal: ctx.signal,
        onProgress: (stage) => ctx.emit?.({ type: 'research_progress', ...stage }),
      })
      ctx.emit?.({
        type: 'research',
        query: question,
        sources: result.sources.map((s) => s.domain).slice(0, 4).join(' · '),
      })
      return result
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'search_github',
        description:
          'Search GitHub for repositories, real code, or issues and pull requests. Use it to find how something is actually implemented, or whether a bug you are hitting is already reported.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'GitHub search query. Qualifiers like language: and repo: work.' },
            kind: {
              type: 'string',
              enum: ['repositories', 'code', 'issues'],
              description: 'What to search. Code search needs a configured GitHub token.',
            },
          },
          required: ['query'],
        },
      },
    },
    run: async (ctx, { query, kind = 'repositories' }) => {
      const result = await researchGithub({ query, kind, signal: ctx.signal })
      ctx.emit?.({ type: 'research', query: `github:${kind} ${query}`, sources: `${result.sources.length} result(s)` })
      return result
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'fetch_page',
        description:
          'Read one page in full. The URL must come from a search result you have already seen. Internal addresses and non-web schemes are refused.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The https URL to read.' },
            query: { type: 'string', description: 'What you are looking for, so the relevant passages are picked.' },
          },
          required: ['url'],
        },
      },
    },
    run: async (ctx, { url, query }) => {
      const result = await fetchPageForAgent({ url, query, signal: ctx.signal })
      ctx.emit?.({
        type: 'browser_action',
        action: 'read page',
        detail: result.ok ? `${result.domain} · ${result.title?.slice(0, 60) ?? ''}` : result.error,
      })
      return result
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'smoke_test',
        description:
          'Run the full delivery check: install, typecheck, lint, tests, build, start the server, confirm the page actually renders, and check the mobile layout. Run this before you finish — it is what proves the project works.',
        parameters: {
          type: 'object',
          properties: {
            skipInstall: { type: 'boolean', description: 'Skip npm install if it has already run.' },
          },
        },
      },
    },
    mutates: true,
    run: async (ctx, { skipInstall = false }) => {
      const result = await smokeTest({
        taskId: ctx.taskId,
        projectDir: ctx.projectDir,
        emit: ctx.emit,
        signal: ctx.signal,
        skipInstall,
        // Registered so the agent can analyse them by name afterwards
        onScreenshot: (shot) => ctx.setLastScreenshot?.(shot),
      })
      ctx.setSmokeResult?.(result)
      return {
        ok: result.ok,
        summary: result.summary,
        steps: result.steps.map((s) => ({ name: s.name, ok: s.ok, detail: s.detail.slice(0, 600), advisory: s.advisory })),
        warnings: result.warnings,
        hint: result.ok
          ? 'The project is verified. You may finish.'
          : 'Fix the failing step and run smoke_test again. Do not finish while it fails.',
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'generate_document',
        description:
          'Produce a real PDF, Word document, PowerPoint deck, HTML page or Markdown file from Markdown content, saved into the project. Use this when the task asks for a document, report, spec or deck rather than code.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Where to save it, e.g. "docs/report.pdf".' },
            format: {
              type: 'string',
              enum: ['pdf', 'docx', 'pptx', 'html', 'md', 'txt'],
              description: 'Omit to infer from the file extension.',
            },
            content: { type: 'string', description: 'The document body as Markdown.' },
            title: { type: 'string' },
            subtitle: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    mutates: true,
    run: async (ctx, { path, format, content, title, subtitle }) => {
      const extension = String(path).split('.').pop()?.toLowerCase()
      const document = generateDocument({
        content,
        format: format ?? extension ?? 'pdf',
        title,
        subtitle,
      })
      // The loop emits file_change for any mutating tool that returns a path
      const written = writeBinaryFile(ctx.projectDir, path, document.buffer)
      return {
        ok: true,
        path: written.path,
        action: written.action,
        format: document.format,
        bytes: document.buffer.length,
        pages: document.pages,
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Create an image asset and save it into the project — a hero background, a pattern, an Open Graph card, a chart, or a placeholder. Use it when the site needs a graphic rather than shipping an empty box or a hotlinked stock photo.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Where to save it, e.g. "assets/hero.png".' },
            prompt: { type: 'string', description: 'What the image is for, including any colour or mood.' },
            style: {
              type: 'string',
              enum: ['gradient', 'mesh', 'hero', 'card', 'pattern', 'chart', 'placeholder', 'swatch'],
              description: 'Omit to infer it from the prompt.',
            },
            title: { type: 'string', description: 'Headline text, for hero and card styles.' },
            subtitle: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            variant: { type: 'string', description: 'linear/radial for gradients; dots/grid/waves/diagonal/noise for patterns; bar/line/area/donut for charts.' },
            data: { type: 'array', description: 'Chart data: numbers, or objects with label and value.', items: { type: 'object' } },
            seed: { type: 'number', description: 'Same seed, same image.' },
            format: { type: 'string', enum: ['png', 'svg'] },
          },
          required: ['path', 'prompt'],
        },
      },
    },
    mutates: true,
    run: async (ctx, request) => {
      let job
      try {
        job = await generateImageJob({ ...request, taskId: ctx.taskId, count: 1 })
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? 'Image generation is unavailable.'),
          hint: 'No image backend is available. Continue without the asset, or use a CSS gradient instead.',
        }
      }

      ctx.emit?.({ type: 'generation_started', jobId: job.id, kind: 'image', provider: job.provider })

      // Wait for it: the agent needs the file on disk before it writes the markup
      const finished = await new Promise((resolve) => {
        const onUpdate = (update) => {
          ctx.emit?.({ type: 'generation_progress', jobId: job.id, state: update.state, progress: update.progress, stage: update.stage })
          if (['completed', 'failed', 'cancelled'].includes(update.state)) {
            jobEvents.off(`update:${job.id}`, onUpdate)
            resolve(update)
          }
        }
        jobEvents.on(`update:${job.id}`, onUpdate)
        // It may already have finished between creation and subscribing
        const current = getJob(job.id)
        if (current && ['completed', 'failed', 'cancelled'].includes(current.state)) {
          jobEvents.off(`update:${job.id}`, onUpdate)
          resolve(current)
        }
      })

      if (finished.state !== 'completed' || finished.artifacts.length === 0) {
        return {
          ok: false,
          error: finished.error?.message ?? `Generation ${finished.state}.`,
          hint: 'Continue without the asset rather than leaving a broken image reference.',
        }
      }

      const artifact = finished.artifacts[0]
      const stored = getArtifact(artifact.id)
      const written = writeBinaryFile(ctx.projectDir, request.path, stored.buffer)

      ctx.emit?.({
        type: 'generation_complete',
        jobId: job.id,
        path: written.path,
        width: artifact.width,
        height: artifact.height,
      })

      return {
        ok: true,
        path: written.path,
        action: written.action,
        width: artifact.width,
        height: artifact.height,
        format: artifact.format,
        bytes: artifact.bytes,
        style: artifact.style,
        seed: artifact.seed,
        backend: artifact.backend,
        /*
         * Stated so the agent describes the asset accurately to the user rather
         * than implying a photograph was generated.
         */
        generative: artifact.generative,
        note: artifact.generative
          ? undefined
          : 'Composed deterministically (gradient/pattern/typography/chart), not sampled by a diffusion model.',
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'analyze_project',
        description:
          'Build a map of the project: framework, runtime, package manager, entry points, routes, components, services, database, tests and build commands. Run this first when working on an imported codebase.',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async (ctx) => analyseProject(ctx.projectDir),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'find_symbol',
        description:
          'Find where a function, class, component or type is defined, and which files call it. Faster and more reliable than searching text, and it tells you what will break if you change the symbol. Use this before editing anything that already exists.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Symbol name, or part of one. `getGateway`, `Button`, `parse`.',
            },
          },
          required: ['name'],
        },
      },
    },
    run: async (ctx, { name }) => {
      const query = String(name ?? '').trim()
      if (!query) return { ok: false, error: 'A symbol name is required.' }

      const map = getCodeMap(ctx.projectDir)
      const exact = symbolInfo(map, query)
      if (exact) {
        return {
          ok: true,
          symbol: exact.name,
          definedIn: exact.definedIn,
          calledBy: exact.calledBy,
          /*
           * The caller list is the point of this tool: it answers "what breaks
           * if I change this" before the edit rather than after the test run.
           */
          hint:
            exact.calledBy.length > 0
              ? `Used by ${exact.calledBy.length} other file(s). Check them before changing its signature.`
              : 'No other file in this project calls it.',
        }
      }

      const matches = findSymbols(map, query, { limit: 12 })
      if (matches.length === 0) {
        return { ok: false, error: `No symbol matching "${query}". It may be defined in a dependency, or not exist yet.` }
      }
      return { ok: true, exact: false, matches }
    },
  },
]
