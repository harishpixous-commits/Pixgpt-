/* ============================================================
   Output validation
   -----------------
   A generation backend that returns a truncated file, an HTML error
   page with an image content-type, or a zero-byte placeholder has
   failed — but it has failed in a way that looks like success to
   anything that only checks the HTTP status.

   So every artifact is parsed: the magic bytes must match the claimed
   type, the dimensions must be readable from the header, and the
   declared structure must be internally consistent. Nothing is trusted
   because a provider said so.

   Format parsing is done here rather than by shelling out to ffprobe,
   because a header parse needs no dependency and cannot be missing on
   a given machine.
   ============================================================ */

export class ValidationError extends Error {
  constructor(message, reason) {
    super(message)
    this.name = 'ValidationError'
    this.reason = reason
  }
}

const MAX_IMAGE_BYTES = Number.parseInt(process.env.MAX_IMAGE_OUTPUT_MB ?? '', 10) * 1024 * 1024 || 25 * 1024 * 1024
const MAX_VIDEO_BYTES = Number.parseInt(process.env.MAX_VIDEO_OUTPUT_MB ?? '', 10) * 1024 * 1024 || 200 * 1024 * 1024

/* ---------- images ---------- */

/** PNG: an 8-byte signature, then an IHDR chunk carrying the dimensions. */
function readPng(buffer) {
  if (buffer.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((byte, i) => buffer[i] === byte)) return null
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null

  return {
    format: 'png',
    mime: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType: buffer[25],
    // A complete PNG ends with an IEND chunk; without it the file was truncated
    complete: buffer.subarray(-8).toString('latin1').includes('IEND'),
  }
}

/** JPEG: walk the segment markers to the SOF that carries the dimensions. */
function readJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

  let offset = 2
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buffer[offset + 1]

    // SOF0..SOF15, excluding the non-dimension markers DHT, JPG and DAC
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        format: 'jpeg',
        mime: 'image/jpeg',
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        // EOI marker
        complete: buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9,
      }
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null
    offset += 2 + length
  }
  return null
}

/** WebP: a RIFF container; VP8, VP8L and VP8X each store size differently. */
function readWebp(buffer) {
  if (buffer.length < 30) return null
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null

  const chunk = buffer.toString('latin1', 12, 16)
  const base = { format: 'webp', mime: 'image/webp', complete: true }

  if (chunk === 'VP8X') {
    return {
      ...base,
      width: 1 + (buffer.readUIntLE(24, 3) & 0xffffff),
      height: 1 + (buffer.readUIntLE(27, 3) & 0xffffff),
    }
  }
  if (chunk === 'VP8 ') {
    return { ...base, width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { ...base, width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return null
}

/** GIF: dimensions sit in the logical screen descriptor. */
function readGif(buffer) {
  if (buffer.length < 10) return null
  const header = buffer.toString('latin1', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  return {
    format: 'gif',
    mime: 'image/gif',
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    complete: buffer[buffer.length - 1] === 0x3b, // trailer
  }
}

/** SVG is text, so the dimensions come from the markup. */
function readSvg(buffer) {
  const head = buffer.subarray(0, 2000).toString('utf8')
  if (!/<svg[\s>]/i.test(head)) return null

  const width = /\bwidth\s*=\s*["']?\s*([\d.]+)/i.exec(head)
  const height = /\bheight\s*=\s*["']?\s*([\d.]+)/i.exec(head)
  const viewBox = /viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i.exec(head)

  return {
    format: 'svg',
    mime: 'image/svg+xml',
    width: Math.round(Number(width?.[1] ?? viewBox?.[1] ?? 0)),
    height: Math.round(Number(height?.[1] ?? viewBox?.[2] ?? 0)),
    complete: buffer.subarray(-200).toString('utf8').includes('</svg>'),
  }
}

const IMAGE_READERS = [readPng, readJpeg, readWebp, readGif, readSvg]

/**
 * Validates a generated image.
 *
 * @param {Buffer} buffer
 * @param {{ expectWidth?: number, expectHeight?: number, tolerance?: number, maxBytes?: number }} [expectations]
 * @returns {{ ok: true, format, mime, width, height, bytes, warnings: string[] }
 *          | { ok: false, reason: string, detail: string }}
 */
export function validateImage(buffer, expectations = {}) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, reason: 'not_a_buffer', detail: 'No image data was returned.' }
  if (buffer.length === 0) return { ok: false, reason: 'empty', detail: 'The generated image is zero bytes.' }

  const maxBytes = expectations.maxBytes ?? MAX_IMAGE_BYTES
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: 'too_large',
      detail: `The image is ${Math.round(buffer.length / 1024 / 1024)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    }
  }

  /*
   * A provider erroring out often returns an HTML page or a JSON blob with an
   * image content-type. Caught here, it reads as "corrupt image" rather than
   * being written to disk as a .png that nothing can open.
   */
  const head = buffer.subarray(0, 200).toString('latin1').trimStart()
  if (head.startsWith('<!DOCTYPE html') || head.startsWith('<html')) {
    return { ok: false, reason: 'html_not_image', detail: 'The backend returned an HTML page instead of an image.' }
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    return { ok: false, reason: 'json_not_image', detail: 'The backend returned JSON instead of an image.' }
  }

  let info = null
  for (const reader of IMAGE_READERS) {
    info = reader(buffer)
    if (info) break
  }
  if (!info) {
    return { ok: false, reason: 'unrecognised_format', detail: 'The data does not match any supported image format.' }
  }

  if (!info.width || !info.height) {
    return { ok: false, reason: 'no_dimensions', detail: `A ${info.format} was returned but its dimensions are unreadable.` }
  }
  if (!info.complete) {
    return { ok: false, reason: 'truncated', detail: `The ${info.format} is missing its end marker — the transfer was cut short.` }
  }

  const warnings = []
  const tolerance = expectations.tolerance ?? 0.02

  // A backend often snaps dimensions to a multiple of 8 or 64; that is not a failure
  if (expectations.expectWidth && Math.abs(info.width - expectations.expectWidth) / expectations.expectWidth > tolerance) {
    warnings.push(`asked for ${expectations.expectWidth}px wide, got ${info.width}px`)
  }
  if (expectations.expectHeight && Math.abs(info.height - expectations.expectHeight) / expectations.expectHeight > tolerance) {
    warnings.push(`asked for ${expectations.expectHeight}px tall, got ${info.height}px`)
  }
  if (info.width < 16 || info.height < 16) {
    return { ok: false, reason: 'too_small', detail: `${info.width}x${info.height} is too small to be a real result.` }
  }

  return {
    ok: true,
    format: info.format,
    mime: info.mime,
    width: info.width,
    height: info.height,
    bytes: buffer.length,
    warnings,
  }
}

/* ---------- video ---------- */

/**
 * MP4/MOV: walk the top-level boxes for `moov`, then read the duration and
 * timescale out of `mvhd`.
 */
function readMp4(buffer) {
  if (buffer.length < 12) return null
  const brand = buffer.toString('latin1', 4, 8)
  if (brand !== 'ftyp' && brand !== 'moov' && brand !== 'mdat') return null

  const majorBrand = buffer.toString('latin1', 8, 12)
  const info = {
    format: 'mp4',
    mime: 'video/mp4',
    majorBrand,
    durationSec: null,
    width: null,
    height: null,
    complete: false,
    boxes: [],
  }

  let offset = 0
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (size < 8) break
    info.boxes.push(type)

    if (type === 'moov') {
      // mvhd is the first child; version decides the field widths
      const mvhd = buffer.indexOf('mvhd', offset, 'latin1')
      if (mvhd > 0 && mvhd + 32 < buffer.length) {
        const version = buffer[mvhd + 4]
        const timescale = version === 1 ? buffer.readUInt32BE(mvhd + 20) : buffer.readUInt32BE(mvhd + 16)
        const duration = version === 1 ? Number(buffer.readBigUInt64BE(mvhd + 24)) : buffer.readUInt32BE(mvhd + 20)
        if (timescale > 0) info.durationSec = Math.round((duration / timescale) * 100) / 100
      }
      // A file with both moov and mdat is structurally complete
      info.complete = info.boxes.includes('mdat') || buffer.includes('mdat')
    }

    // tkhd carries the presentation size as 16.16 fixed point
    const tkhd = buffer.indexOf('tkhd', offset, 'latin1')
    if (tkhd > 0 && tkhd + 88 < buffer.length && info.width === null) {
      const version = buffer[tkhd + 4]
      const base = tkhd + (version === 1 ? 100 : 88) - 8
      if (base + 8 <= buffer.length) {
        const width = buffer.readUInt32BE(base) / 65536
        const height = buffer.readUInt32BE(base + 4) / 65536
        if (width > 0 && width < 16384 && height > 0 && height < 16384) {
          info.width = Math.round(width)
          info.height = Math.round(height)
        }
      }
    }

    if (size === 0) break // box extends to end of file
    offset += size
  }

  info.complete = info.complete || (info.boxes.includes('moov') && info.boxes.includes('mdat'))
  return info
}

/** WebM/Matroska: an EBML header with the Matroska DocType. */
function readWebm(buffer) {
  if (buffer.length < 4) return null
  if (buffer.readUInt32BE(0) !== 0x1a45dfa3) return null

  const head = buffer.subarray(0, 4096).toString('latin1')
  return {
    format: /webm/i.test(head) ? 'webm' : 'mkv',
    mime: /webm/i.test(head) ? 'video/webm' : 'video/x-matroska',
    durationSec: null,
    width: null,
    height: null,
    // Cluster data present means there is actual media, not just a header
    complete: buffer.includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75])),
  }
}

/** Animated GIF, which some image-to-video backends return. */
function readAnimatedGif(buffer) {
  const gif = readGif(buffer)
  if (!gif) return null
  // Each frame begins with a graphic control extension
  const frames = buffer.toString('latin1').split('!ù').length - 1
  return { ...gif, format: 'gif', mime: 'image/gif', frames, animated: frames > 1, durationSec: null }
}

const VIDEO_READERS = [readMp4, readWebm, readAnimatedGif]

/**
 * Validates a generated video.
 *
 * @param {Buffer} buffer
 * @param {{ expectDurationSec?: number, expectWidth?: number, expectHeight?: number, maxBytes?: number }} [expectations]
 */
export function validateVideo(buffer, expectations = {}) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, reason: 'not_a_buffer', detail: 'No video data was returned.' }
  if (buffer.length === 0) return { ok: false, reason: 'empty', detail: 'The generated video is zero bytes.' }

  const maxBytes = expectations.maxBytes ?? MAX_VIDEO_BYTES
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: 'too_large',
      detail: `The video is ${Math.round(buffer.length / 1024 / 1024)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    }
  }

  const head = buffer.subarray(0, 200).toString('latin1').trimStart()
  if (head.startsWith('<!DOCTYPE html') || head.startsWith('<html')) {
    return { ok: false, reason: 'html_not_video', detail: 'The backend returned an HTML page instead of a video.' }
  }
  if (head.startsWith('{')) {
    return { ok: false, reason: 'json_not_video', detail: 'The backend returned JSON instead of a video.' }
  }

  let info = null
  for (const reader of VIDEO_READERS) {
    info = reader(buffer)
    if (info) break
  }
  if (!info) {
    return { ok: false, reason: 'unrecognised_format', detail: 'The data does not match any supported video container.' }
  }
  if (!info.complete) {
    return {
      ok: false,
      reason: 'truncated',
      detail: `The ${info.format} container is incomplete — it has no media data, so it will not play.`,
    }
  }

  const warnings = []
  if (expectations.expectDurationSec && info.durationSec) {
    const drift = Math.abs(info.durationSec - expectations.expectDurationSec)
    if (drift > Math.max(1, expectations.expectDurationSec * 0.25)) {
      warnings.push(`asked for ${expectations.expectDurationSec}s, got ${info.durationSec}s`)
    }
  }
  if (info.durationSec !== null && info.durationSec <= 0) {
    return { ok: false, reason: 'zero_duration', detail: 'The video reports a duration of zero.' }
  }
  if (info.width && expectations.expectWidth && Math.abs(info.width - expectations.expectWidth) > 16) {
    warnings.push(`asked for ${expectations.expectWidth}px wide, got ${info.width}px`)
  }

  return {
    ok: true,
    format: info.format,
    mime: info.mime,
    width: info.width,
    height: info.height,
    durationSec: info.durationSec,
    frames: info.frames ?? null,
    bytes: buffer.length,
    warnings,
  }
}

/** Sniffs the type of an artifact so the right validator is used. */
export function detectKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'unknown'
  for (const reader of VIDEO_READERS) {
    const info = reader(buffer)
    // An animated GIF is a video; a still GIF is an image
    if (info && (info.format !== 'gif' || info.animated)) return 'video'
  }
  for (const reader of IMAGE_READERS) {
    if (reader(buffer)) return 'image'
  }
  return 'unknown'
}

export { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, readPng, readJpeg, readWebp, readGif, readSvg, readMp4 }
