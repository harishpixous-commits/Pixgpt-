import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { toWireMessages } from '../server/validate.mjs'
import { imageLimits, normaliseContentParts, validateImageUrl } from '../server/multimodal.mjs'
import { GatewayError } from '../server/gateway/errors.mjs'

/* ============================================================
   Image / multimodal input.

   NOTE: image limits are read from env at module load, so these
   tests assert against `imageLimits` rather than literals.
   ============================================================ */

const VISION_ON = { visionAllowed: true, gatewaySupportsVision: true, modelLabel: 'Test model' }
const VISION_OFF = { visionAllowed: false, gatewaySupportsVision: true, modelLabel: 'PixGPT Fast' }
const GATEWAY_BLIND = { visionAllowed: true, gatewaySupportsVision: false, modelLabel: 'Test model' }

const throwsBad = (fn) =>
  assert.rejects(async () => fn(), (e) => e instanceof GatewayError && e.code === 'bad_request' && e.status === 400)
const throwsUnsupported = (fn) =>
  assert.rejects(async () => fn(), (e) => e instanceof GatewayError && e.code === 'unsupported' && e.status === 501)

/** A valid 1x1 PNG. */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9p8AAAAASUVORK5CYII='

const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.alloc(bytes, 1).toString('base64')}`

describe('1. text-only chat is unchanged', () => {
  test('a plain string message still produces a plain string', async () => {
    const { messages, images } = await toWireMessages([{ role: 'user', content: 'hello' }], VISION_ON)
    assert.deepEqual(messages, [{ role: 'user', content: 'hello' }])
    assert.equal(images, 0)
  })

  test('text-only content parts collapse back to a string', async () => {
    const { messages, images } = await toWireMessages(
      [{ role: 'user', content: [{ type: 'text', text: 'just words' }] }],
      VISION_ON,
    )
    assert.equal(messages[0].content, 'just words', 'no images → text-only gateways see what they always saw')
    assert.equal(images, 0)
  })
})

describe('2. image + text', () => {
  test('produces OpenAI-format content parts', async () => {
    const { messages, images } = await toWireMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: PNG_1PX } },
          ],
        },
      ],
      VISION_ON,
    )
    assert.equal(images, 1)
    assert.equal(Array.isArray(messages[0].content), true)
    assert.deepEqual(messages[0].content[0], { type: 'text', text: 'What is this?' })
    assert.equal(messages[0].content[1].type, 'image_url')
    assert.equal(messages[0].content[1].image_url.url, PNG_1PX)
  })

  test('an image with no text is allowed', async () => {
    const { messages } = await toWireMessages(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_1PX } }] }],
      VISION_ON,
    )
    assert.equal(messages[0].content.length, 1)
    assert.equal(messages[0].content[0].type, 'image_url')
  })

  test('accepts a bare string image_url as well as the object form', async () => {
    const { images } = await toWireMessages(
      [{ role: 'user', content: [{ type: 'image_url', image_url: PNG_1PX }] }],
      VISION_ON,
    )
    assert.equal(images, 1)
  })

  test('input_text is treated as text (Responses-API style)', async () => {
    const { messages } = await toWireMessages(
      [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      VISION_ON,
    )
    assert.equal(messages[0].content, 'hi')
  })
})

describe('3. multiple images', () => {
  test('several images in one message are kept in order', async () => {
    const { images } = await toWireMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: PNG_1PX } },
            { type: 'image_url', image_url: { url: PNG_1PX } },
          ],
        },
      ],
      VISION_ON,
    )
    assert.equal(images, 2)
  })

  test('rejects more than the configured per-message limit', async () => {
    const parts = Array.from({ length: imageLimits.maxImagesPerMessage + 1 }, () => ({
      type: 'image_url',
      image_url: { url: PNG_1PX },
    }))
    await throwsBad(() => normaliseContentParts(parts, VISION_ON))
  })
})

describe('4. unsupported image types', () => {
  test('rejects a MIME type outside the allowlist', async () => {
    await throwsBad(() => validateImageUrl(dataUrl('image/tiff', 64)))
    await throwsBad(() => validateImageUrl(dataUrl('application/pdf', 64)))
    await throwsBad(() => validateImageUrl(dataUrl('text/html', 64)))
  })

  test('accepts each allowlisted type', async () => {
    for (const mime of imageLimits.mimeAllowlist) {
      assert.ok(validateImageUrl(dataUrl(mime, 128)), `${mime} should be accepted`)
    }
  })

  test('rejects a malformed data URL', async () => {
    await throwsBad(() => validateImageUrl('data:image/png;base64'))
    await throwsBad(() => validateImageUrl('data:image/png,notbase64'))
    await throwsBad(() => validateImageUrl('data:;base64,AAAA'))
  })

  test('rejects an empty image', async () => {
    await throwsBad(() => validateImageUrl('data:image/png;base64,'))
  })
})

describe('5. oversized images', () => {
  test('rejects a payload above the byte limit', async () => {
    await throwsBad(() => validateImageUrl(dataUrl('image/png', imageLimits.maxImageBytes + 1024)))
  })

  test('accepts a payload just under the limit', async () => {
    assert.ok(validateImageUrl(dataUrl('image/png', imageLimits.maxImageBytes - 1024)))
  })

  test('the error names the limit so the user can act on it', async () => {
    assert.throws(
      () => validateImageUrl(dataUrl('image/png', imageLimits.maxImageBytes + 1024)),
      (e) => /too large/i.test(e.message) && /MB/.test(e.message),
    )
  })
})

describe('6 & 7. model capability', () => {
  test('a vision-capable model accepts images', async () => {
    const { images } = await toWireMessages(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_1PX } }] }],
      VISION_ON,
    )
    assert.equal(images, 1)
  })

  test('a non-vision model refuses, naming the model and the remedy', async () => {
    await assert.rejects(
      () =>
        toWireMessages(
          [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_1PX } }] }],
          VISION_OFF,
        ),
      (e) =>
        e.code === 'unsupported' &&
        e.message.includes('PixGPT Fast') &&
        /vision-capable/i.test(e.message),
    )
  })

  test('images are never silently dropped for a non-vision model', async () => {
    // The whole point: it must raise, not quietly send text only.
    await throwsUnsupported(() =>
      toWireMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_1PX } }] }], VISION_OFF),
    )
  })

  test('a blind gateway refuses regardless of the model', async () => {
    await throwsUnsupported(() => normaliseContentParts([{ type: 'image_url', image_url: { url: PNG_1PX } }], GATEWAY_BLIND))
  })

  test('a non-vision model still accepts text normally', async () => {
    const { messages } = await toWireMessages([{ role: 'user', content: 'text is fine' }], VISION_OFF)
    assert.equal(messages[0].content, 'text is fine')
  })
})

describe('10. malformed multimodal requests', () => {
  test('rejects unknown part types', async () => {
    await throwsBad(() => normaliseContentParts([{ type: 'video_url', video_url: { url: 'x' } }], VISION_ON))
  })

  test('rejects non-object parts', async () => {
    await throwsBad(() => normaliseContentParts(['just a string'], VISION_ON))
    await throwsBad(() => normaliseContentParts([null], VISION_ON))
  })

  test('rejects a text part with no text', async () => {
    await throwsBad(() => normaliseContentParts([{ type: 'text' }], VISION_ON))
  })

  test('rejects an image part with no url', async () => {
    await throwsBad(() => normaliseContentParts([{ type: 'image_url' }], VISION_ON))
    await throwsBad(() => normaliseContentParts([{ type: 'image_url', image_url: {} }], VISION_ON))
  })
})

describe('11. security — SSRF and scheme validation', () => {
  test('remote URLs are rejected unless explicitly enabled', async () => {
    assert.equal(imageLimits.allowRemoteUrls, false, 'data: only is the safe default')
    await throwsBad(() => validateImageUrl('https://example.com/cat.png'))
  })

  test('non-http(s) schemes are always rejected', async () => {
    for (const url of [
      'file:///etc/passwd',
      'file://C:/Windows/win.ini',
      'ftp://example.com/a.png',
      'gopher://example.com',
      'javascript:alert(1)',
      'blob:http://localhost/abc',
    ]) {
      await throwsBad(() => validateImageUrl(url))
    }
  })

  test('private and metadata hosts are rejected even when remote URLs are on', async () => {
    const original = imageLimits.allowRemoteUrls
    imageLimits.allowRemoteUrls = true
    try {
      for (const host of [
        'https://localhost/a.png',
        'https://127.0.0.1/a.png',
        'https://10.0.0.5/a.png',
        'https://192.168.1.10/a.png',
        'https://172.16.4.4/a.png',
        'https://169.254.169.254/latest/meta-data',
        'https://0.0.0.0/a.png',
        'https://api.internal/a.png',
      ]) {
        await throwsBad(() => validateImageUrl(host))
      }
      // http is refused even for a public host
      await throwsBad(() => validateImageUrl('http://example.com/a.png'))
      // a public https host is allowed once remote URLs are enabled
      assert.ok(validateImageUrl('https://example.com/cat.png'))
    } finally {
      imageLimits.allowRemoteUrls = original
    }
  })

  test('the host allowlist is enforced when configured', async () => {
    const originalAllow = imageLimits.allowRemoteUrls
    const originalHosts = imageLimits.remoteHostAllowlist
    imageLimits.allowRemoteUrls = true
    imageLimits.remoteHostAllowlist = ['cdn.example.com']
    try {
      assert.ok(validateImageUrl('https://cdn.example.com/a.png'))
      assert.ok(validateImageUrl('https://images.cdn.example.com/a.png'), 'subdomains are allowed')
      await throwsBad(() => validateImageUrl('https://evil.com/a.png'))
    } finally {
      imageLimits.allowRemoteUrls = originalAllow
      imageLimits.remoteHostAllowlist = originalHosts
    }
  })

  test('data URLs cannot smuggle a different MIME past the allowlist', async () => {
    await throwsBad(() => validateImageUrl('data:image/png;base64,AAAA;data:text/html;base64,AAAA'))
  })
})

describe('limits are configurable, not hardcoded', () => {
  test('defaults are conservative', async () => {
    assert.ok(imageLimits.maxImageBytes <= 8 * 1024 * 1024, 'per-image cap should stay modest')
    assert.ok(imageLimits.maxImagesPerMessage <= 10)
    assert.ok(imageLimits.mimeAllowlist.length > 0)
  })

  test('the request cap leaves room for the per-image cap', async () => {
    assert.ok(
      imageLimits.maxRequestBytes >= imageLimits.maxImageBytes,
      'a single allowed image must fit inside the request limit',
    )
  })
})
