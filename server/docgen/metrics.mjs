/* ============================================================
   Base-14 font metrics
   --------------------
   Adobe's published advance widths for the standard PDF fonts, in
   1/1000 em, for codes 32–126.

   These are needed for real word wrapping. Without them you either
   guess a fixed character width — which makes every line ragged and
   overflows the margin on capitals — or you embed a font.
   ============================================================ */

const HELVETICA =
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'

const HELVETICA_BOLD =
  '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584'

const TIMES =
  '250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541'

const TIMES_BOLD =
  '250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520'

const TIMES_ITALIC =
  '250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541'

const parse = (csv) => Float64Array.from(csv.split(',').map(Number))

/** Advance widths for codes 32..126; Courier is monospace at 600. */
const WIDTHS = {
  Helvetica: parse(HELVETICA),
  'Helvetica-Bold': parse(HELVETICA_BOLD),
  // Adobe's oblique variants share the roman advance widths exactly
  'Helvetica-Oblique': parse(HELVETICA),
  'Helvetica-BoldOblique': parse(HELVETICA_BOLD),
  'Times-Roman': parse(TIMES),
  'Times-Bold': parse(TIMES_BOLD),
  'Times-Italic': parse(TIMES_ITALIC),
  Courier: null,
  'Courier-Bold': null,
  'Courier-Oblique': null,
}

export const FONT_NAMES = Object.keys(WIDTHS)

/**
 * Width of `text` in points.
 * @param {string} text
 * @param {string} font  a base-14 font name
 * @param {number} size  point size
 */
export function textWidth(text, font, size) {
  /*
   * `in` rather than `??`: the Courier faces are deliberately stored as null to
   * mean "monospaced, 600 for every glyph". Nullish-coalescing would treat that
   * null as a missing font and silently measure Courier with Helvetica's
   * proportional widths, which wrecks every code block's layout.
   */
  const table = font in WIDTHS ? WIDTHS[font] : WIDTHS.Helvetica
  const scale = size / 1000
  let total = 0
  const s = String(text)

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (table === null) {
      total += 600 // Courier: every glyph is 600
      continue
    }
    if (code >= 32 && code <= 126) {
      total += table[code - 32]
    } else if (code === 9) {
      total += table[0] * 4 // tab ≈ four spaces
    } else {
      // Anything outside ASCII renders through WinAnsi; the lowercase-average
      // advance is a closer estimate than the space width would be.
      total += 500
    }
  }
  return total * scale
}

/** Widest line in a block, in points. */
export function maxLineWidth(lines, font, size) {
  return lines.reduce((max, line) => Math.max(max, textWidth(line, font, size)), 0)
}

export { WIDTHS }
