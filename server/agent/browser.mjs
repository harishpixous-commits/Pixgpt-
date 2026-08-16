import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GatewayError } from '../gateway/errors.mjs'
import { log } from '../config.mjs'
import { artifactsDir } from './workspace.mjs'

/* ============================================================
   Controlled browser
   ------------------
   Drives the preview like a tester: navigate, click, type, submit,
   screenshot, and collect console + network failures.

   Isolation: a throwaway user-data-dir per task, so the agent never
   touches the real browser profile, cookies or saved passwords. It
   may only navigate to the task's own preview origin.
   ============================================================ */

const SCREENSHOT_DIR = 'screenshots'
const NAV_TIMEOUT_MS = Number.parseInt(process.env.AGENT_BROWSER_TIMEOUT_MS ?? '', 10) || 30_000
const MAX_SESSIONS = 4

/** taskId -> session */
const SESSIONS = new Map()

function bad(message) {
  return new GatewayError('bad_request', message, { status: 400 })
}

/** Chrome/Edge on this machine. Checked lazily so PixGPT boots without one. */
function findBrowser() {
  const candidates = [
    process.env.PIXGPT_BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

/** The browser executable, for callers that need to launch their own instance. */
export function chromiumPath() {
  try {
    return findBrowser()
  } catch {
    return null
  }
}

export function browserAvailable() {
  try {
    return Boolean(findBrowser())
  } catch {
    return false
  }
}

/* ---------- session ---------- */

async function getSession(taskId, projectDir, allowedOrigin) {
  const existing = SESSIONS.get(taskId)
  if (existing && !existing.browser.process()?.killed) return existing

  if (SESSIONS.size >= MAX_SESSIONS) {
    const [oldest] = SESSIONS.keys()
    await closeBrowser(oldest)
  }

  const executablePath = findBrowser()
  if (!executablePath) {
    throw new GatewayError('unsupported', 'No Chrome or Edge installation was found for browser testing.', { status: 501 })
  }

  let puppeteer
  try {
    puppeteer = (await import('puppeteer-core')).default
  } catch {
    throw new GatewayError('unsupported', 'Browser testing is not available on this server.', { status: 501 })
  }

  // Outside the project directory: a Chrome profile is not the user's code and
  // must not be counted, listed or shipped with it.
  const userDataDir = join(artifactsDir(projectDir), 'browser', randomUUID().slice(0, 8))
  mkdirSync(userDataDir, { recursive: true })

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    // A fresh profile directory: no access to the user's cookies or history.
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
    ],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

  const session = { taskId, browser, page, allowedOrigin, consoleErrors: [], networkErrors: [], userDataDir }

  page.on('console', (msg) => {
    if (msg.type() === 'error') session.consoleErrors.push(msg.text().slice(0, 400))
  })
  page.on('pageerror', (error) => session.consoleErrors.push(`Uncaught: ${String(error?.message ?? error).slice(0, 400)}`))
  page.on('requestfailed', (req) => {
    session.networkErrors.push(`${req.method()} ${req.url().slice(0, 200)} — ${req.failure()?.errorText ?? 'failed'}`)
  })
  page.on('response', (res) => {
    if (res.status() >= 400) session.networkErrors.push(`HTTP ${res.status()} ${res.url().slice(0, 200)}`)
  })

  SESSIONS.set(taskId, session)
  return session
}

export async function closeBrowser(taskId) {
  const session = SESSIONS.get(taskId)
  if (!session) return { closed: false }
  SESSIONS.delete(taskId)
  try {
    await session.browser.close()
  } catch {
    /* already gone */
  }
  return { closed: true }
}

export async function closeAllBrowsers() {
  await Promise.all([...SESSIONS.keys()].map((id) => closeBrowser(id)))
}

/** The agent may only browse its own preview. */
function assertAllowed(session, url) {
  let target
  try {
    target = new URL(url, session.allowedOrigin)
  } catch {
    throw bad('That URL is not valid.')
  }
  if (new URL(session.allowedOrigin).origin !== target.origin) {
    throw bad('The browser may only open the task preview.')
  }
  return target.toString()
}

/* ---------- actions ---------- */

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
}

export async function openPage({ taskId, projectDir, previewUrl, path = '/', viewport = 'desktop' }) {
  const session = await getSession(taskId, projectDir, previewUrl)
  const url = assertAllowed(session, path)
  session.consoleErrors.length = 0
  session.networkErrors.length = 0

  await session.page.setViewport(VIEWPORTS[viewport] ?? VIEWPORTS.desktop)
  const response = await session.page.goto(url, { waitUntil: 'networkidle2' }).catch((e) => {
    throw bad(`Could not open ${url}: ${String(e?.message ?? e).slice(0, 200)}`)
  })
  // Let a client-rendered app settle
  await new Promise((r) => setTimeout(r, 600))

  return {
    ok: true,
    url,
    status: response?.status() ?? null,
    title: await session.page.title().catch(() => ''),
    viewport,
    consoleErrors: [...session.consoleErrors],
    networkErrors: [...session.networkErrors],
  }
}

export async function interact({ taskId, action, selector, text, viewport }) {
  const session = SESSIONS.get(taskId)
  if (!session) throw bad('No page is open. Call browser_open first.')
  const page = session.page

  try {
    switch (action) {
      case 'click':
        await page.click(selector)
        break
      case 'type':
        await page.click(selector)
        await page.type(selector, String(text ?? ''), { delay: 12 })
        break
      case 'select':
        await page.select(selector, String(text ?? ''))
        break
      case 'submit':
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
          selector ? page.click(selector) : page.keyboard.press('Enter'),
        ])
        break
      case 'scroll':
        await page.evaluate((y) => window.scrollBy(0, y), Number(text) || 600)
        break
      case 'wait':
        if (selector) await page.waitForSelector(selector, { visible: true })
        else await new Promise((r) => setTimeout(r, Math.min(Number(text) || 1000, 10_000)))
        break
      case 'viewport':
        await page.setViewport(VIEWPORTS[viewport ?? String(text)] ?? VIEWPORTS.desktop)
        break
      case 'press':
        await page.keyboard.press(String(text ?? 'Enter'))
        break
      default:
        throw bad(`Unknown browser action: ${action}`)
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error
    return { ok: false, action, selector, error: String(error?.message ?? error).slice(0, 300) }
  }

  await new Promise((r) => setTimeout(r, 350))
  return {
    ok: true,
    action,
    selector,
    url: page.url(),
    consoleErrors: [...session.consoleErrors],
    networkErrors: [...session.networkErrors],
  }
}

/** Reads visible text and structure so the agent can assert on real content. */
export async function inspectPage({ taskId, selector }) {
  const session = SESSIONS.get(taskId)
  if (!session) throw bad('No page is open. Call browser_open first.')

  return session.page.evaluate((sel) => {
    const scope = sel ? document.querySelector(sel) : document.body
    if (!scope) return { found: false }
    const text = (scope.innerText ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 4000)
    const pick = (q, map) => [...document.querySelectorAll(q)].slice(0, 40).map(map)
    return {
      found: true,
      title: document.title,
      url: location.href,
      text,
      headings: pick('h1,h2,h3', (el) => el.textContent.trim().slice(0, 120)),
      links: pick('a[href]', (el) => ({ text: el.textContent.trim().slice(0, 60), href: el.getAttribute('href') })),
      buttons: pick('button,[role="button"],input[type="submit"]', (el) => (el.textContent || el.value || '').trim().slice(0, 60)),
      inputs: pick('input,textarea,select', (el) => ({ type: el.type ?? el.tagName.toLowerCase(), name: el.name || el.id || '', label: el.labels?.[0]?.textContent?.trim().slice(0, 60) ?? '' })),
      // Horizontal overflow is the single most common responsive defect
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }
  }, selector ?? null)
}

/**
 * Measures the rendered page for visual defects, in the browser, from computed
 * styles and real geometry.
 *
 * This exists because a vision model is a remote dependency that can be rate
 * limited or unavailable, and "the UI was not checked" must never be reported
 * as "the UI is fine". Everything here is arithmetic on what the browser
 * actually laid out, so it works every time and gives exact numbers a fix can
 * be verified against. The vision pass stays valuable for judgement — taste,
 * hierarchy, whether it looks finished — but it is no longer the only check.
 */
export async function auditPage({ taskId, viewport }) {
  const session = SESSIONS.get(taskId)
  if (!session) throw bad('No page is open. Call browser_open first.')

  if (viewport && VIEWPORTS[viewport]) {
    await session.page.setViewport(VIEWPORTS[viewport])
    await new Promise((r) => setTimeout(r, 400))
  }

  const findings = await session.page.evaluate(() => {
    /* --- colour maths (WCAG 2.1) --- */
    const parseColour = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value ?? '')
      if (!m) return null
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
      if (parts.length < 3 || parts.some(Number.isNaN)) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }

    const relativeLuminance = ({ r, g, b }) => {
      const channel = (c) => {
        const v = c / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    const contrastRatio = (fg, bg) => {
      const l1 = relativeLuminance(fg)
      const l2 = relativeLuminance(bg)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }

    /** Composites a translucent foreground over its backdrop. */
    const blend = (fg, bg) =>
      fg.a >= 1
        ? fg
        : {
            r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
            g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
            b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
            a: 1,
          }

    /** Walks up for the first non-transparent background. */
    const effectiveBackground = (element) => {
      let node = element
      while (node && node !== document.documentElement) {
        const colour = parseColour(getComputedStyle(node).backgroundColor)
        if (colour && colour.a > 0) return blend(colour, { r: 255, g: 255, b: 255, a: 1 })
        node = node.parentElement
      }
      const root = parseColour(getComputedStyle(document.body).backgroundColor)
      return root && root.a > 0 ? blend(root, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 }
    }

    const describe = (element) => {
      const id = element.id ? `#${element.id}` : ''
      const cls = typeof element.className === 'string' && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : ''
      return `${element.tagName.toLowerCase()}${id}${cls}`
    }

    const issues = []
    const add = (severity, kind, selector, detail, fix) =>
      issues.push({ severity, kind, selector, detail, fix })

    const doc = document.documentElement
    const viewportWidth = doc.clientWidth

    /* --- 1. horizontal overflow --- */
    if (doc.scrollWidth > viewportWidth + 1) {
      // Name the widest offender, so the fix has somewhere to go
      let worst = null
      for (const element of document.querySelectorAll('body *')) {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0) continue
        const right = rect.right + window.scrollX
        if (right > viewportWidth + 1 && (!worst || right > worst.right)) {
          worst = { right, element }
        }
      }
      add(
        'high',
        'overflow',
        worst ? describe(worst.element) : 'document',
        `The page is ${doc.scrollWidth}px wide in a ${viewportWidth}px viewport` +
          (worst ? `; ${describe(worst.element)} extends to ${Math.round(worst.right)}px` : ''),
        'Replace the fixed width with a fluid one (max-width, %, or a grid that wraps).',
      )
    }

    /* --- 2. unreadable text contrast --- */
    const seen = new Set()
    for (const element of document.querySelectorAll('body *')) {
      // Only elements with their own visible text
      const ownText = [...element.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim()
      if (ownText.length < 2) continue

      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue

      const foreground = parseColour(style.color)
      if (!foreground) continue
      const background = effectiveBackground(element)
      const ratio = contrastRatio(blend(foreground, background), background)

      const size = Number.parseFloat(style.fontSize)
      const weight = Number(style.fontWeight) || 400
      // WCAG "large text": 18.66px bold, or 24px
      const large = size >= 24 || (size >= 18.66 && weight >= 700)
      const required = large ? 3 : 4.5

      if (ratio < required) {
        const key = `${describe(element)}:${Math.round(ratio * 10)}`
        if (seen.has(key)) continue
        seen.add(key)
        add(
          ratio < 2 ? 'high' : 'medium',
          'contrast',
          describe(element),
          `"${ownText.slice(0, 40)}" has a contrast ratio of ${ratio.toFixed(2)}:1 against its background ` +
            `(${style.color} on rgb(${background.r}, ${background.g}, ${background.b})); ${required}:1 is required`,
          'Darken the text or lighten the background until the ratio meets the minimum.',
        )
      }
    }

    /* --- 3. content clipped by its container --- */
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element)
      if (style.overflow !== 'hidden' && style.overflowY !== 'hidden') continue
      if (element.scrollHeight > element.clientHeight + 4 && element.clientHeight > 0) {
        add(
          'medium',
          'clipped',
          describe(element),
          `Content is ${element.scrollHeight}px tall inside a ${element.clientHeight}px box with overflow hidden`,
          'Let the container grow, or allow it to scroll.',
        )
      }
    }

    /* --- 4. text rendered invisibly --- */
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element)
      const opacity = Number(style.opacity)
      if (opacity > 0 && opacity < 0.15 && (element.textContent ?? '').trim().length > 1) {
        add('high', 'invisible', describe(element), `Rendered at opacity ${opacity}`, 'Raise the opacity or remove it.')
      }
    }

    /* --- 5. tap targets too small to hit --- */
    for (const element of document.querySelectorAll('a, button, input, select, [role="button"]')) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.height < 24 || rect.width < 24) {
        add(
          'low',
          'tap-target',
          describe(element),
          `${Math.round(rect.width)}x${Math.round(rect.height)}px; 44x44 is the comfortable minimum`,
          'Increase the padding or set a minimum height.',
        )
      }
    }

    /* --- 6. images that failed to load --- */
    for (const image of document.querySelectorAll('img')) {
      if (image.complete && image.naturalWidth === 0) {
        add('high', 'broken-image', describe(image), `Failed to load: ${image.getAttribute('src') ?? '(no src)'}`, 'Fix the path or remove the image.')
      }
    }

    /* --- 7. a page with nothing on it --- */
    const visibleText = (document.body.innerText ?? '').trim()
    if (visibleText.length < 10) {
      add('high', 'blank', 'body', `The page renders only ${visibleText.length} characters of visible text`, 'Check the console and network for what failed.')
    }

    return {
      viewport: { width: viewportWidth, height: doc.clientHeight },
      scrollWidth: doc.scrollWidth,
      horizontalOverflow: doc.scrollWidth > viewportWidth + 1,
      visibleTextLength: visibleText.length,
      issues,
    }
  })

  const order = { high: 0, medium: 1, low: 2 }
  findings.issues.sort((a, b) => order[a.severity] - order[b.severity])

  log.info('page audit', {
    taskId,
    viewport: viewport ?? 'current',
    issues: findings.issues.length,
    high: findings.issues.filter((i) => i.severity === 'high').length,
  })

  return {
    ok: true,
    verified: true,
    viewport: viewport ?? 'current',
    ...findings,
    passed: findings.issues.filter((i) => i.severity === 'high').length === 0,
  }
}

/** Saves a PNG inside the task workspace and returns safe metadata. */
export async function screenshot({ taskId, projectDir, label = 'screenshot', fullPage = false, viewport }) {
  const session = SESSIONS.get(taskId)
  if (!session) throw bad('No page is open. Call browser_open first.')

  if (viewport && VIEWPORTS[viewport]) {
    await session.page.setViewport(VIEWPORTS[viewport])
    await new Promise((r) => setTimeout(r, 400))
  }

  const dir = join(artifactsDir(projectDir), SCREENSHOT_DIR)
  mkdirSync(dir, { recursive: true })
  const name = `${Date.now()}-${label.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40)}.png`
  const buffer = await session.page.screenshot({ fullPage })
  writeFileSync(join(dir, name), buffer)

  log.info('agent screenshot', { taskId, name, bytes: buffer.length, fullPage })
  return {
    ok: true,
    name,
    label,
    bytes: buffer.length,
    fullPage,
    viewport: viewport ?? 'desktop',
    // The agent gets a data URL so it can hand it straight to a vision model
    dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
  }
}

export function collectDiagnostics(taskId) {
  const session = SESSIONS.get(taskId)
  if (!session) return { consoleErrors: [], networkErrors: [] }
  return { consoleErrors: [...session.consoleErrors], networkErrors: [...session.networkErrors] }
}

export { SCREENSHOT_DIR, VIEWPORTS }
