import { test, describe, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'

import { validateImage, validateVideo, detectKind, readPng, readMp4 } from '../server/generation/validate.mjs'
import {
  createJob,
  cancelJob,
  retryJob,
  getJob,
  listJobs,
  queueStats,
  resetJobs,
  jobEvents,
  JOB_STATE,
} from '../server/generation/jobs.mjs'
import { detectResources, describeLocalCapability, resetResourceCache, VRAM_REQUIREMENTS } from '../server/generation/resources.mjs'
import { selectBackends, listBackends, generationStatus, CAPABILITY } from '../server/generation/index.mjs'
import { canRender, composeSvg, palette, STYLE_NAMES, capabilities } from '../server/generation/backends/renderer.mjs'
import { clearArtifacts } from '../server/artifacts.mjs'
import { GatewayError } from '../server/gateway/errors.mjs'

/* ============================================================
   Image and video generation.

   The abstraction, routing, job lifecycle and output validation are
   covered here without touching a GPU. Real generation through the
   deterministic renderer is exercised too, because it runs anywhere.

   Diffusion backends are verified separately, on hardware that has an
   accelerator — see docs/generation-backends.md.
   ============================================================ */

/** A minimal valid PNG, built by hand so the tests need no fixture file. */
function makePng(width = 64, height = 48) {
  const { deflateSync } = require('node:zlib')
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour

  const raw = Buffer.alloc(height * (1 + width * 3))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// node:test runs as ESM; createRequire gives makePng access to zlib synchronously
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

describe('output validation', () => {
  test('a real PNG is accepted with its true dimensions', () => {
    const result = validateImage(makePng(320, 240))
    assert.equal(result.ok, true, result.detail)
    assert.equal(result.format, 'png')
    assert.equal(result.width, 320)
    assert.equal(result.height, 240)
  })

  test('an HTML error page with an image content-type is rejected', () => {
    // The failure mode that looks like success to anything checking only status
    const result = validateImage(Buffer.from('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'html_not_image')
  })

  test('a JSON error body is rejected', () => {
    const result = validateImage(Buffer.from('{"error":"model not loaded"}'))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'json_not_image')
  })

  test('a truncated PNG is rejected, not written out', () => {
    const result = validateImage(makePng(64, 64).subarray(0, 40))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'truncated')
  })

  test('an empty buffer is rejected', () => {
    assert.equal(validateImage(Buffer.alloc(0)).reason, 'empty')
    assert.equal(validateImage(null).reason, 'not_a_buffer')
  })

  test('a 1x1 result is too small to be real output', () => {
    const tiny = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    )
    assert.equal(validateImage(tiny).reason, 'too_small')
  })

  test('unrecognised bytes are refused rather than guessed at', () => {
    assert.equal(validateImage(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])).reason, 'unrecognised_format')
  })

  test('SVG is read as an image with its declared size', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600"/></svg>')
    const result = validateImage(svg)
    assert.equal(result.ok, true)
    assert.equal(result.format, 'svg')
    assert.equal(result.width, 800)
  })

  test('a dimension mismatch is a warning, not a failure', () => {
    // Backends snap to a multiple of 8 or 64; that is not a broken result
    const result = validateImage(makePng(512, 512), { expectWidth: 500, expectHeight: 500 })
    assert.equal(result.ok, true)
    assert.ok(result.warnings.length > 0, 'the difference should still be reported')
  })

  test('an oversized file is refused before it is stored', () => {
    const huge = Buffer.concat([makePng(64, 64), Buffer.alloc(2048)])
    assert.equal(validateImage(huge, { maxBytes: 100 }).reason, 'too_large')
  })

  test('video validation rejects the same disguised failures', () => {
    assert.equal(validateVideo(Buffer.alloc(0)).reason, 'empty')
    assert.equal(validateVideo(Buffer.from('<html>error</html>')).reason, 'html_not_video')
    assert.equal(validateVideo(Buffer.from('{"error":"x"}')).reason, 'json_not_video')
    assert.equal(validateVideo(Buffer.from('nothing like a container at all here')).reason, 'unrecognised_format')
  })

  test('an mp4 with no media data is reported as truncated', () => {
    // ftyp header only: structurally a video, but there is nothing to play
    const ftyp = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom', 'latin1'),
      Buffer.alloc(16),
    ])
    ftyp.writeUInt32BE(24, 0)
    const result = validateVideo(ftyp)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'truncated')
  })

  test('detectKind distinguishes an image from a video', () => {
    assert.equal(detectKind(makePng()), 'image')
    assert.equal(detectKind(Buffer.from('not media')), 'unknown')
  })
})

describe('resource detection', () => {
  test('it measures the machine and reports a verdict', async () => {
    const resources = await detectResources()
    assert.equal(typeof resources.localGeneration, 'boolean')
    assert.ok(resources.cpu.cores > 0)
    assert.ok(resources.ramGb > 0)
    assert.ok(Array.isArray(resources.reasons))
  })

  test('when local generation is unavailable it says why', async () => {
    const resources = await detectResources()
    if (!resources.localGeneration) {
      assert.ok(resources.reasons.length > 0, 'an unavailable verdict must be explained')
      assert.match(describeLocalCapability(resources), /unavailable/i)
    } else {
      assert.equal(resources.reasons.length, 0)
    }
  })

  test('a model is only marked runnable when there is VRAM for it', async () => {
    const resources = await detectResources()
    for (const [model, needed] of Object.entries(VRAM_REQUIREMENTS)) {
      if (resources.canRun[model]) {
        assert.ok(resources.vramGb >= needed, `${model} claims to run on ${resources.vramGb} GB but needs ${needed}`)
      }
    }
  })

  test('detection is cached, because hardware does not change per request', async () => {
    const first = await detectResources()
    const second = await detectResources()
    assert.equal(first.detectedAt, second.detectedAt)
  })
})

describe('backend routing', () => {
  test('a backend is only offered for a capability it declares', () => {
    for (const capability of Object.values(CAPABILITY)) {
      for (const backend of selectBackends(capability)) {
        assert.ok(backend.capabilities.includes(capability), `${backend.id} was chosen for ${capability}`)
      }
    }
  })

  test('video never falls back to an image-only backend', () => {
    const videoBackends = selectBackends(CAPABILITY.VIDEO, { kind: 'video' }).map((b) => b.id)
    // The renderer produces images and must never be offered as a video route
    assert.ok(!videoBackends.includes('renderer'), 'a still delivered as a video is a wrong answer')
  })

  test('the registry never exposes a key, only what is missing', async () => {
    const backends = await listBackends()
    const serialised = JSON.stringify(backends)
    assert.ok(!/apiKey|api_key|GENERATION_REMOTE_API_KEY=/.test(serialised))
    for (const backend of backends) {
      if (!backend.configured) assert.ok(backend.requires, `${backend.id} should say what it needs`)
    }
  })

  test('the deterministic renderer is never described as generative', async () => {
    const backends = await listBackends()
    const renderer = backends.find((b) => b.id === 'renderer')
    assert.equal(renderer.generative, false, 'it composes graphics; it does not sample them')
    assert.equal(capabilities().generative, false)
  })

  test('status reports video honestly when nothing can produce one', async () => {
    const status = await generationStatus()
    if (!status.video.available) {
      assert.equal(status.video.backends.length, 0)
      assert.ok(status.video.reason, 'an unavailable capability needs a reason')
    }
    assert.ok(status.local.summary.length > 0)
  })
})

describe('the deterministic renderer', () => {
  test('it refuses a photographic subject instead of faking one', () => {
    for (const prompt of [
      'a photorealistic portrait of a woman',
      'photo of a cat on a windowsill',
      'an illustration of a dragon',
      '3d render of a sports car',
    ]) {
      const decision = canRender(prompt)
      assert.equal(decision.ok, false, `"${prompt}" is not something this backend can do`)
      assert.equal(decision.reason, 'photographic_subject')
    }
  })

  test('it accepts the work it can genuinely do', () => {
    for (const prompt of ['a blue gradient hero background', 'subtle dot pattern', 'bar chart of revenue', 'an open graph card']) {
      assert.equal(canRender(prompt).ok, true, `"${prompt}" should be renderable`)
    }
  })

  test('an explicit style is honoured over inference', () => {
    for (const style of STYLE_NAMES) {
      assert.equal(canRender('anything at all', style).style, style)
    }
  })

  test('palettes are always valid hex and vary by seed', () => {
    const seen = new Set()
    for (const seed of [1, 2, 3, 99, 100, 12345]) {
      const colours = palette(seed, '')
      for (const key of ['primary', 'secondary', 'accent', 'surface', 'text', 'muted']) {
        assert.match(colours[key], /^#[0-9a-f]{6}$/, `${key} for seed ${seed} was ${colours[key]}`)
      }
      seen.add(colours.primary)
    }
    // Adjacent seeds once collapsed to the same hue; they must not
    assert.ok(seen.size >= 5, `expected varied palettes, got ${seen.size} distinct`)
  })

  test('a named colour in the brief anchors the palette', () => {
    assert.equal(palette(1, 'a cool blue corporate site').base, 215)
    assert.equal(palette(1, 'warm sunset tones').base, 15)
  })

  test('a restrained brief stays analogous rather than complementary', () => {
    // "professional blue" coming back blue-to-amber reads as a mistake
    const professional = palette(42, 'blue professional')
    const playful = palette(42, 'blue playful')
    assert.notEqual(professional.accent, playful.accent)
  })

  test('composed SVG is well formed and carries the requested size', () => {
    for (const style of STYLE_NAMES) {
      const svg = composeSvg({ style, width: 400, height: 300, seed: 7, title: 'T', subtitle: 'S', data: [1, 2, 3] })
      assert.ok(svg.startsWith('<svg'), `${style} should produce an svg`)
      assert.ok(svg.endsWith('</svg>'), `${style} svg should be closed`)
      assert.ok(svg.includes('width="400"'), `${style} should honour the width`)
      // No unescaped angle brackets from user text
      assert.ok(!/<script/i.test(svg))
    }
  })

  test('title text is escaped, so markup cannot be injected', () => {
    const svg = composeSvg({ style: 'card', width: 400, height: 300, title: '<script>alert(1)</script>', seed: 1 })
    assert.ok(!svg.includes('<script>'), 'markup in a title must be escaped')
    assert.ok(svg.includes('&lt;script&gt;'))
  })
})

describe('the job system', () => {
  afterEach(() => {
    resetJobs()
    clearArtifacts()
  })

  /** Waits for a job to reach a terminal state. */
  const settle = (id) =>
    new Promise((resolve) => {
      const onUpdate = (job) => {
        if ([JOB_STATE.COMPLETED, JOB_STATE.FAILED, JOB_STATE.CANCELLED].includes(job.state)) {
          jobEvents.off(`update:${id}`, onUpdate)
          resolve(job)
        }
      }
      jobEvents.on(`update:${id}`, onUpdate)
      const current = getJob(id)
      if (current && [JOB_STATE.COMPLETED, JOB_STATE.FAILED, JOB_STATE.CANCELLED].includes(current.state)) {
        jobEvents.off(`update:${id}`, onUpdate)
        resolve(current)
      }
    })

  test('a job runs through its states and completes', async () => {
    const states = []
    const job = createJob({
      kind: 'image',
      provider: 'test',
      model: 'test',
      publicRequest: {},
      run: async (report) => {
        report.progress(0.5, 'Halfway')
        return { artifacts: [{ id: 'a1' }] }
      },
    })
    jobEvents.on(`update:${job.id}`, (update) => states.push(update.state))

    const finished = await settle(job.id)
    assert.equal(finished.state, JOB_STATE.COMPLETED)
    assert.equal(finished.progress, 1)
    assert.equal(finished.artifacts.length, 1)
    assert.ok(states.includes(JOB_STATE.RUNNING) || states.includes(JOB_STATE.STARTING))
  })

  test('a failing job records the error rather than throwing', async () => {
    const job = createJob({
      kind: 'image',
      provider: 'test',
      model: 'test',
      publicRequest: {},
      run: async () => {
        throw new GatewayError('provider_error', 'the backend fell over', { retryable: true })
      },
    })
    const finished = await settle(job.id)
    assert.equal(finished.state, JOB_STATE.FAILED)
    assert.match(finished.error.message, /fell over/)
    assert.equal(finished.error.retryable, true)
  })

  test('a queued job can be cancelled before it starts', () => {
    const job = createJob({ kind: 'image', provider: 'test', model: 't', publicRequest: {}, run: async () => ({ artifacts: [] }) })
    const result = cancelJob(job.id)
    assert.equal(result.ok, true)
    assert.equal(getJob(job.id).state, JOB_STATE.CANCELLED)
  })

  test('cancelling raises the abort signal a provider can honour', async () => {
    let sawAbort = false
    const job = createJob({
      kind: 'image',
      provider: 'test',
      model: 't',
      publicRequest: {},
      run: async (report) =>
        new Promise((resolve, reject) => {
          report.signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('aborted'))
          })
        }),
    })
    // Let it start before cancelling
    await new Promise((resolve) => setTimeout(resolve, 30))
    cancelJob(job.id)
    await settle(job.id)
    assert.equal(sawAbort, true, 'the provider must be told to stop')
    assert.equal(getJob(job.id).state, JOB_STATE.CANCELLED)
  })

  test('cancelling a finished job is refused, not silently accepted', async () => {
    const job = createJob({ kind: 'image', provider: 't', model: 't', publicRequest: {}, run: async () => ({ artifacts: [] }) })
    await settle(job.id)
    const result = cancelJob(job.id)
    assert.equal(result.ok, false)
    assert.match(result.reason, /already/)
  })

  test('only a retryable failure can be retried', async () => {
    const job = createJob({
      kind: 'image',
      provider: 't',
      model: 't',
      publicRequest: {},
      run: async () => {
        throw new GatewayError('bad_request', 'that prompt is not valid', { retryable: false })
      },
    })
    await settle(job.id)
    // Retrying a bad prompt would fail identically and just burn the queue
    assert.throws(() => retryJob(job.id), /not retryable/i)
  })

  test('a retryable failure can be retried and can then succeed', async () => {
    let attempts = 0
    const job = createJob({
      kind: 'image',
      provider: 't',
      model: 't',
      publicRequest: {},
      run: async () => {
        attempts++
        if (attempts === 1) throw new GatewayError('provider_error', 'transient', { retryable: true })
        return { artifacts: [{ id: 'a' }] }
      },
    })
    await settle(job.id)
    assert.equal(getJob(job.id).state, JOB_STATE.FAILED)

    retryJob(job.id)
    const finished = await settle(job.id)
    assert.equal(finished.state, JOB_STATE.COMPLETED)
    assert.equal(finished.retries, 1)
  })

  test('a job never exposes the raw output buffer', async () => {
    const job = createJob({
      kind: 'image',
      provider: 't',
      model: 't',
      publicRequest: {},
      run: async () => ({ artifacts: [{ id: 'a', bytes: 100 }] }),
    })
    await settle(job.id)
    const serialised = JSON.stringify(getJob(job.id))
    assert.ok(!serialised.includes('buffer'), 'a job payload must stay small')
  })

  test('queue statistics reflect what is happening', async () => {
    const job = createJob({ kind: 'image', provider: 't', model: 't', publicRequest: {}, run: async () => ({ artifacts: [] }) })
    await settle(job.id)
    const stats = queueStats()
    assert.equal(typeof stats.concurrency, 'number')
    assert.ok(stats.concurrency >= 1, 'two large models on one GPU exhaust VRAM, so concurrency is bounded')
    assert.equal(stats.byState[JOB_STATE.COMPLETED], 1)
  })

  test('jobs can be listed and filtered by task', async () => {
    const a = createJob({ kind: 'image', provider: 't', model: 't', publicRequest: {}, taskId: 'task_a', run: async () => ({ artifacts: [] }) })
    createJob({ kind: 'image', provider: 't', model: 't', publicRequest: {}, taskId: 'task_b', run: async () => ({ artifacts: [] }) })
    await settle(a.id)
    assert.equal(listJobs({ taskId: 'task_a' }).length, 1)
    assert.equal(listJobs().length, 2)
  })
})
