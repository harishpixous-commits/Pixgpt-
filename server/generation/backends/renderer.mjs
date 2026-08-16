import { log } from '../../config.mjs'
import { GatewayError } from '../../gateway/errors.mjs'

/* ============================================================
   Deterministic renderer
   ----------------------
   This is NOT a diffusion model and must never be described as one.
   It composes real graphics — gradients, patterns, typographic cards,
   charts — and rasterises them through the headless browser PixGPT
   already drives for QA.

   Why it exists: a diffusion model needs a GPU, and a great many of
   the image assets a generated site actually needs are not
   photographs. A hero gradient, a repeating background, an Open Graph
   card, a bar chart — these are better produced deterministically than
   sampled. They come out crisp at any resolution, they are
   reproducible from a seed, they cost nothing, and they run anywhere.

   For a photographic subject this backend declines rather than
   producing something misleading. That is what ComfyUI or a remote
   model is for.
   ============================================================ */

const MAX_DIMENSION = 4096
const RENDER_TIMEOUT_MS = 30_000

/** What this backend can genuinely produce. Anything else, it refuses. */
export const STYLES = Object.freeze({
  gradient: 'A smooth colour field: linear, radial or a soft multi-point mesh.',
  mesh: 'Overlapping colour blobs blurred into a modern mesh gradient.',
  hero: 'A gradient background with headline typography, for a page hero.',
  card: 'A social/Open Graph card: title, subtitle and an accent bar.',
  pattern: 'A repeating geometric background: dots, grid, waves, diagonals or noise.',
  chart: 'A bar, line, area or donut chart rendered from real data.',
  placeholder: 'A labelled placeholder box showing its own dimensions.',
  swatch: 'A palette strip of colour swatches with their hex values.',
})

export const STYLE_NAMES = Object.keys(STYLES)

/** Subjects this backend cannot honestly render. */
const PHOTOGRAPHIC = /\b(photo|photograph|photorealistic|realistic|portrait|face|person|people|animal|cat|dog|landscape|scenery|product shot|render of a|3d render|illustration of a|painting of|drawing of|anime|character)\b/i

/**
 * Decides whether a prompt is something this renderer can actually do.
 *
 * Refusing is the point. A prompt asking for a photograph of a person must not
 * come back as a gradient with the word "person" on it.
 */
export function canRender(prompt, style) {
  if (style && STYLE_NAMES.includes(style)) return { ok: true, style }
  const text = String(prompt ?? '')

  if (PHOTOGRAPHIC.test(text)) {
    return {
      ok: false,
      reason: 'photographic_subject',
      detail:
        'This asks for a photographic or illustrated subject, which needs a diffusion model. ' +
        'The deterministic renderer produces gradients, patterns, typographic cards and charts.',
    }
  }

  // Infer a style from what was asked for
  const inferred = /\bchart|graph|bar|plot|data\b/i.test(text)
    ? 'chart'
    : /\bpattern|texture|tile|background\b/i.test(text)
      ? 'pattern'
      : /\bog|social|card|thumbnail|banner\b/i.test(text)
        ? 'card'
        : /\bhero|header|landing\b/i.test(text)
          ? 'hero'
          : /\bpalette|swatch|colou?rs?\b/i.test(text)
            ? 'swatch'
            : /\bmesh\b/i.test(text)
              ? 'mesh'
              : 'gradient'

  return { ok: true, style: inferred, inferred: true }
}

/* ---------- deterministic colour ---------- */

/**
 * A small seeded PRNG, so the same seed always gives the same image.
 *
 * The seed is scrambled first and the generator warmed up. A plain linear
 * congruential step is barely sensitive to its input: seeds 99 and 100 produced
 * a first value differing in the fourth decimal, which rounded to the same hue
 * and made consecutive seeds look identical.
 */
function rng(seed) {
  // xmur3-style avalanche, so one bit of seed changes many bits of state
  let h = (Number(seed) || 1) >>> 0
  h = Math.imul(h ^ (h >>> 16), 2_246_822_507) >>> 0
  h = Math.imul(h ^ (h >>> 13), 3_266_489_909) >>> 0
  let state = (h ^ (h >>> 16)) >>> 0

  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
  // Discard the first few, which stay correlated with the seed
  next()
  next()
  return next
}

/**
 * HSL to hex. Lightness and saturation arrive as percentages.
 *
 * Every channel is clamped: an out-of-range value makes toString(16) emit a
 * negative number, which produced colours like "#b16-271b2825" and silently
 * broke every fill that used them.
 */
function hslToHex(h, s, l) {
  const lightness = Math.max(0, Math.min(100, l)) / 100
  const saturation = Math.max(0, Math.min(100, s)) / 100
  const a = saturation * Math.min(lightness, 1 - lightness)

  const channel = (n) => {
    const k = (n + h / 30) % 12
    const value = lightness - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

/**
 * Builds a coherent palette from a seed and an optional mood.
 * Harmonies rather than random colours: a palette that clashes looks broken,
 * and "generated" should not mean "arbitrary".
 */
export function palette(seed, mood = '') {
  const random = rng(seed)
  const text = String(mood).toLowerCase()

  /*
   * Hue anchoring, in two tiers. A named colour is an explicit instruction and
   * outranks a mood word: "cool blue corporate" is blue, not whatever hue
   * "corporate" suggests. Within a tier the most specific match wins, so "warm
   * sunset" comes out sunset rather than merely warm.
   *
   * Matching is on word boundaries — a bare substring test finds "red" inside
   * "tired".
   */
  const COLOURS = {
    red: 5, orange: 25, amber: 40, yellow: 50, lime: 90, green: 145,
    emerald: 155, teal: 175, cyan: 190, blue: 215, slate: 215, indigo: 245,
    violet: 275, purple: 275, magenta: 310, pink: 330, crimson: 350,
  }
  const MOODS = {
    sunset: 15, energetic: 20, warm: 30, sunrise: 35, natural: 130, forest: 140,
    calm: 195, ocean: 200, cool: 210, corporate: 220, professional: 220,
    tech: 230, midnight: 240, luxury: 275, playful: 320,
  }

  const bestIn = (table) =>
    Object.keys(table)
      // `\\b` in source so the regex receives a word boundary; a single `\b`
      // inside a template literal is a backspace character and matches nothing
      .filter((name) => new RegExp(`\\b${name}\\b`).test(text))
      .sort((a, b) => b.length - a.length)[0]

  const colourMatch = bestIn(COLOURS)
  const moodMatch = bestIn(MOODS)
  const base = colourMatch ? COLOURS[colourMatch] : moodMatch ? MOODS[moodMatch] : Math.floor(random() * 360)

  const dark = /\b(dark|night|midnight|black|noir)\b/.test(text)
  const muted = /\b(muted|subtle|calm|minimal|professional|corporate)\b/.test(text)
  const saturation = muted ? 45 : 78

  /*
   * A restrained brief keeps the palette analogous. Running a gradient out to
   * the complementary hue looks striking on a playful landing page and garish
   * on anything described as professional — "blue and corporate" should not
   * come back blue-to-amber.
   */
  const accentOffset = muted ? 55 : 180

  return {
    base,
    primary: hslToHex(base, saturation, dark ? 55 : 52),
    secondary: hslToHex((base + (muted ? 22 : 40)) % 360, saturation - 8, dark ? 48 : 60),
    accent: hslToHex((base + accentOffset) % 360, saturation + 8, 58),
    surface: dark ? hslToHex(base, 22, 11) : hslToHex(base, 30, 97),
    text: dark ? hslToHex(base, 12, 96) : hslToHex(base, 40, 13),
    muted: dark ? hslToHex(base, 10, 68) : hslToHex(base, 18, 42),
    dark,
  }
}

/* ---------- SVG composition ---------- */

const escapeXml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Wraps text to a width, measured in characters at the given size. */
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = (current + ' ' + word).trim()
    }
  }
  if (current) lines.push(current)
  return lines
}

function gradientSvg({ width, height, colours, kind = 'linear', seed }) {
  const random = rng(seed)
  const angle = Math.floor(random() * 360)

  if (kind === 'radial') {
    return `<defs><radialGradient id="g" cx="${30 + random() * 40}%" cy="${25 + random() * 40}%" r="85%">
      <stop offset="0%" stop-color="${colours.primary}"/>
      <stop offset="55%" stop-color="${colours.secondary}"/>
      <stop offset="100%" stop-color="${colours.surface}"/>
    </radialGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>`
  }

  return `<defs><linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
    <stop offset="0%" stop-color="${colours.primary}"/>
    <stop offset="50%" stop-color="${colours.secondary}"/>
    <stop offset="100%" stop-color="${colours.accent}"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>`
}

/** Blurred overlapping blobs — the modern "mesh gradient" look. */
function meshSvg({ width, height, colours, seed }) {
  const random = rng(seed)
  const blobColours = [colours.primary, colours.secondary, colours.accent, colours.primary, colours.accent]

  const blobs = blobColours
    .map((colour, i) => {
      const cx = Math.round(random() * width)
      const cy = Math.round(random() * height)
      const r = Math.round((0.28 + random() * 0.35) * Math.max(width, height))
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}" opacity="${0.55 + random() * 0.3}"/>`
    })
    .join('')

  const blur = Math.round(Math.max(width, height) * 0.12)
  return `<defs><filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${blur}"/>
    </filter></defs>
    <rect width="${width}" height="${height}" fill="${colours.surface}"/>
    <g filter="url(#soft)">${blobs}</g>`
}

function patternSvg({ width, height, colours, variant = 'dots', seed }) {
  const random = rng(seed)
  const size = Math.max(16, Math.round(Math.min(width, height) / 18))
  const stroke = colours.primary
  let tile = ''

  switch (variant) {
    case 'grid':
      tile = `<path d="M ${size} 0 L 0 0 0 ${size}" fill="none" stroke="${stroke}" stroke-width="1.25" opacity="0.35"/>`
      break
    case 'diagonal':
      tile = `<path d="M0,${size} l${size},-${size} M-2,2 l4,-4 M${size - 2},${size + 2} l4,-4" stroke="${stroke}" stroke-width="1.5" opacity="0.4"/>`
      break
    case 'waves':
      tile = `<path d="M0 ${size / 2} q ${size / 4} -${size / 3}, ${size / 2} 0 t ${size / 2} 0" fill="none" stroke="${stroke}" stroke-width="1.75" opacity="0.4"/>`
      break
    case 'noise': {
      const dots = Array.from({ length: 22 }, () => {
        const x = (random() * size).toFixed(1)
        const y = (random() * size).toFixed(1)
        return `<circle cx="${x}" cy="${y}" r="${(0.6 + random() * 1.1).toFixed(1)}" fill="${stroke}" opacity="${(0.15 + random() * 0.4).toFixed(2)}"/>`
      }).join('')
      tile = dots
      break
    }
    default:
      tile = `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 7}" fill="${stroke}" opacity="0.45"/>`
  }

  return `<defs><pattern id="p" width="${size}" height="${size}" patternUnits="userSpaceOnUse">${tile}</pattern></defs>
    <rect width="${width}" height="${height}" fill="${colours.surface}"/>
    <rect width="${width}" height="${height}" fill="url(#p)"/>`
}

function chartSvg({ width, height, colours, data, title, variant = 'bar' }) {
  const points = (Array.isArray(data) && data.length > 0 ? data : [12, 19, 8, 25, 16, 30, 22]).map((d) =>
    typeof d === 'object' ? { label: String(d.label ?? ''), value: Number(d.value) || 0 } : { label: '', value: Number(d) || 0 },
  )

  const pad = { top: title ? 76 : 40, right: 40, bottom: 56, left: 64 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const max = Math.max(...points.map((p) => p.value), 1)

  const titleEl = title
    ? `<text x="${pad.left}" y="46" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="26" font-weight="700" fill="${colours.text}">${escapeXml(title)}</text>`
    : ''

  // Horizontal guides make a chart readable rather than decorative
  const guides = Array.from({ length: 5 }, (_, i) => {
    const y = pad.top + (plotHeight / 4) * i
    const value = Math.round(max - (max / 4) * i)
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${colours.muted}" stroke-width="1" opacity="0.22"/>
      <text x="${pad.left - 12}" y="${y + 5}" text-anchor="end" font-family="system-ui,sans-serif" font-size="13" fill="${colours.muted}">${value}</text>`
  }).join('')

  let series = ''
  if (variant === 'line' || variant === 'area') {
    const step = plotWidth / Math.max(points.length - 1, 1)
    const coords = points.map((p, i) => [pad.left + i * step, pad.top + plotHeight - (p.value / max) * plotHeight])
    const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')

    if (variant === 'area') {
      series += `<path d="${path} L ${pad.left + plotWidth} ${pad.top + plotHeight} L ${pad.left} ${pad.top + plotHeight} Z" fill="${colours.primary}" opacity="0.22"/>`
    }
    series += `<path d="${path}" fill="none" stroke="${colours.primary}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`
    series += coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${colours.primary}"/>`).join('')
  } else if (variant === 'donut') {
    const total = points.reduce((sum, p) => sum + p.value, 0) || 1
    const cx = width / 2
    const cy = pad.top + plotHeight / 2
    const radius = Math.min(plotWidth, plotHeight) / 2.4
    const inner = radius * 0.58
    let angle = -Math.PI / 2

    series = points
      .map((point, i) => {
        const sweep = (point.value / total) * Math.PI * 2
        const end = angle + sweep
        const large = sweep > Math.PI ? 1 : 0
        const arc = [
          `M ${cx + radius * Math.cos(angle)} ${cy + radius * Math.sin(angle)}`,
          `A ${radius} ${radius} 0 ${large} 1 ${cx + radius * Math.cos(end)} ${cy + radius * Math.sin(end)}`,
          `L ${cx + inner * Math.cos(end)} ${cy + inner * Math.sin(end)}`,
          `A ${inner} ${inner} 0 ${large} 0 ${cx + inner * Math.cos(angle)} ${cy + inner * Math.sin(angle)}`,
          'Z',
        ].join(' ')
        angle = end
        const shade = [colours.primary, colours.secondary, colours.accent, colours.muted][i % 4]
        return `<path d="${arc}" fill="${shade}"/>`
      })
      .join('')
    return `<rect width="${width}" height="${height}" fill="${colours.surface}"/>${titleEl}${series}`
  } else {
    const gap = plotWidth / points.length
    const barWidth = gap * 0.62
    series = points
      .map((point, i) => {
        const barHeight = (point.value / max) * plotHeight
        const x = pad.left + i * gap + (gap - barWidth) / 2
        const y = pad.top + plotHeight - barHeight
        const label = point.label
          ? `<text x="${x + barWidth / 2}" y="${pad.top + plotHeight + 24}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="${colours.muted}">${escapeXml(point.label)}</text>`
          : ''
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="6" fill="${colours.primary}"/>${label}`
      })
      .join('')
  }

  return `<rect width="${width}" height="${height}" fill="${colours.surface}"/>${titleEl}${guides}${series}
    <line x1="${pad.left}" y1="${pad.top + plotHeight}" x2="${width - pad.right}" y2="${pad.top + plotHeight}" stroke="${colours.muted}" stroke-width="1.5" opacity="0.5"/>`
}

function textOverlay({ width, height, colours, title, subtitle, style }) {
  if (!title && !subtitle) return ''

  const isCard = style === 'card'
  const titleSize = Math.round(Math.min(width / 14, height / (isCard ? 7 : 6)))
  const subtitleSize = Math.round(titleSize * 0.42)
  const maxChars = Math.floor(width / (titleSize * 0.52))
  const lines = wrap(title ?? '', maxChars).slice(0, 3)

  const blockHeight = lines.length * titleSize * 1.16 + (subtitle ? subtitleSize * 2.2 : 0)
  const startY = isCard ? height * 0.34 : (height - blockHeight) / 2 + titleSize

  // A scrim keeps the type readable over any colour underneath it
  const scrim = `<rect width="${width}" height="${height}" fill="${colours.dark ? '#000' : '#000'}" opacity="${isCard ? 0.22 : 0.18}"/>`

  const titleLines = lines
    .map(
      (line, i) =>
        `<text x="${isCard ? 64 : width / 2}" y="${startY + i * titleSize * 1.16}" ` +
        `text-anchor="${isCard ? 'start' : 'middle'}" font-family="system-ui,-apple-system,Segoe UI,Helvetica,sans-serif" ` +
        `font-size="${titleSize}" font-weight="800" letter-spacing="-0.02em" fill="#ffffff">${escapeXml(line)}</text>`,
    )
    .join('')

  const subtitleEl = subtitle
    ? `<text x="${isCard ? 64 : width / 2}" y="${startY + lines.length * titleSize * 1.16 + subtitleSize * 1.1}" ` +
      `text-anchor="${isCard ? 'start' : 'middle'}" font-family="system-ui,-apple-system,Segoe UI,sans-serif" ` +
      `font-size="${subtitleSize}" font-weight="500" fill="#ffffff" opacity="0.88">${escapeXml(wrap(subtitle, Math.floor(width / (subtitleSize * 0.55)))[0] ?? '')}</text>`
    : ''

  const accentBar = isCard
    ? `<rect x="64" y="${height - 96}" width="${Math.round(width * 0.12)}" height="8" rx="4" fill="${colours.accent}"/>`
    : ''

  return scrim + titleLines + subtitleEl + accentBar
}

function swatchSvg({ width, height, colours }) {
  const shades = [colours.primary, colours.secondary, colours.accent, colours.muted, colours.surface]
  const swatchWidth = width / shades.length

  return (
    `<rect width="${width}" height="${height}" fill="${colours.surface}"/>` +
    shades
      .map((shade, i) => {
        const x = i * swatchWidth
        return (
          `<rect x="${x}" y="0" width="${swatchWidth}" height="${height * 0.8}" fill="${shade}"/>` +
          `<text x="${x + swatchWidth / 2}" y="${height * 0.9}" text-anchor="middle" ` +
          `font-family="ui-monospace,Consolas,monospace" font-size="${Math.round(height * 0.05)}" fill="${colours.text}">${shade}</text>`
        )
      })
      .join('')
  )
}

function placeholderSvg({ width, height, colours, title }) {
  return (
    `<rect width="${width}" height="${height}" fill="${colours.surface}"/>` +
    `<rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="${colours.muted}" stroke-width="3" stroke-dasharray="14 10" rx="10"/>` +
    `<line x1="8" y1="8" x2="${width - 8}" y2="${height - 8}" stroke="${colours.muted}" stroke-width="1.5" opacity="0.4"/>` +
    `<line x1="${width - 8}" y1="8" x2="8" y2="${height - 8}" stroke="${colours.muted}" stroke-width="1.5" opacity="0.4"/>` +
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" ` +
    `font-size="${Math.round(Math.min(width, height) / 12)}" fill="${colours.text}">${escapeXml(title || `${width}x${height}`)}</text>`
  )
}

/**
 * Composes the SVG for a request. Exported so it can be tested and so an SVG
 * can be delivered directly when a vector asset is what the caller wants.
 */
export function composeSvg({
  style = 'gradient',
  width = 1200,
  height = 630,
  prompt = '',
  title = '',
  subtitle = '',
  seed = 1,
  variant,
  data,
  mood,
}) {
  const colours = palette(seed, mood || prompt)
  let body

  switch (style) {
    case 'mesh':
      body = meshSvg({ width, height, colours, seed })
      break
    case 'pattern':
      body = patternSvg({ width, height, colours, variant: variant ?? 'dots', seed })
      break
    case 'chart':
      body = chartSvg({ width, height, colours, data, title, variant: variant ?? 'bar' })
      break
    case 'swatch':
      body = swatchSvg({ width, height, colours })
      break
    case 'placeholder':
      body = placeholderSvg({ width, height, colours, title })
      break
    case 'card':
    case 'hero':
      body =
        (variant === 'mesh' ? meshSvg({ width, height, colours, seed }) : gradientSvg({ width, height, colours, kind: variant ?? 'linear', seed })) +
        textOverlay({ width, height, colours, title: title || prompt, subtitle, style })
      break
    default:
      body = gradientSvg({ width, height, colours, kind: variant ?? 'linear', seed })
      if (title) body += textOverlay({ width, height, colours, title, subtitle, style: 'hero' })
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

/* ---------- rasterisation ---------- */

/**
 * Rasterises SVG to PNG using the headless browser PixGPT already runs.
 *
 * Reusing that browser rather than adding a rasteriser dependency keeps the
 * install unchanged, and it is the same engine that renders the QA screenshots,
 * so what is generated and what is verified look identical.
 */
async function rasterise(svg, { width, height, signal }) {
  const { chromiumPath } = await import('../../agent/browser.mjs')
  const executablePath = chromiumPath()
  if (!executablePath) {
    throw new GatewayError('unsupported', 'No Chrome or Edge is installed, so SVG cannot be rasterised to PNG.', {
      status: 501,
    })
  }

  let puppeteer
  try {
    puppeteer = (await import('puppeteer-core')).default
  } catch {
    throw new GatewayError('unsupported', 'Rasterisation is unavailable on this server.', { status: 501 })
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--force-device-scale-factor=1'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    // A data URL keeps this entirely offline; no file and no network involved
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
         html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}
         svg{display:block}
       </style></head><body>${svg}</body></html>`,
      { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS },
    )
    // Let webfont-less system text settle before capturing
    await new Promise((resolve) => setTimeout(resolve, 120))
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } })
    // Puppeteer returns a Uint8Array; everything downstream expects a Buffer,
    // and Buffer.isBuffer on a Uint8Array is false, so validation would reject it
    return Buffer.isBuffer(shot) ? shot : Buffer.from(shot)
  } finally {
    await browser.close().catch(() => {})
  }
}

/* ---------- backend interface ---------- */

export function capabilities() {
  return {
    id: 'renderer',
    kind: 'deterministic',
    /*
     * Stated plainly so nothing downstream mistakes this for a generative
     * model. It composes graphics; it does not synthesise imagery.
     */
    generative: false,
    description: 'Composes gradients, patterns, typographic cards and charts. Not a diffusion model.',
    styles: STYLES,
    supportsImage: true,
    supportsVideo: false,
    supportsImageToImage: false,
    supportsEditing: false,
    supportsUpscaling: false,
    requiresGpu: false,
    maxWidth: MAX_DIMENSION,
    maxHeight: MAX_DIMENSION,
    formats: ['png', 'svg'],
  }
}

export async function health() {
  const { browserAvailable } = await import('../../agent/browser.mjs')
  const available = browserAvailable()
  return {
    ok: available,
    reason: available ? null : 'no_browser_for_rasterisation',
    // SVG needs no browser at all, so that path works regardless
    svgOnly: !available,
  }
}

/**
 * Generates an image.
 *
 * @param {{ prompt, style, width, height, seed, title, subtitle, variant, data,
 *           format, mood }} request
 * @param {object} [options] { report, signal }
 */
export async function generateImage(request, { report, signal } = {}) {
  const width = Math.min(Math.max(Number(request.width) || 1200, 16), MAX_DIMENSION)
  const height = Math.min(Math.max(Number(request.height) || 630, 16), MAX_DIMENSION)

  const decision = canRender(request.prompt, request.style)
  if (!decision.ok) {
    throw new GatewayError('unsupported', decision.detail, { status: 422, retryable: false })
  }

  const seed = Number.isFinite(Number(request.seed)) ? Number(request.seed) : Math.floor(Math.random() * 1e9)

  report?.progress(0.2, 'Composing')
  const svg = composeSvg({
    style: decision.style,
    width,
    height,
    prompt: request.prompt ?? '',
    title: request.title ?? '',
    subtitle: request.subtitle ?? '',
    seed,
    variant: request.variant,
    data: request.data,
    mood: request.mood,
  })

  if (request.format === 'svg') {
    report?.progress(1, 'Done')
    return {
      buffer: Buffer.from(svg, 'utf8'),
      mime: 'image/svg+xml',
      format: 'svg',
      width,
      height,
      seed,
      style: decision.style,
      inferredStyle: decision.inferred ?? false,
    }
  }

  report?.progress(0.55, 'Rasterising')
  const buffer = await rasterise(svg, { width, height, signal })
  report?.progress(0.95, 'Finalising')

  log.info('renderer produced an image', { style: decision.style, width, height, bytes: buffer.length, seed })

  return {
    buffer,
    mime: 'image/png',
    format: 'png',
    width,
    height,
    seed,
    style: decision.style,
    inferredStyle: decision.inferred ?? false,
    svg,
  }
}

export { MAX_DIMENSION, rasterise, escapeXml, wrap }
