import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatSystemPrompt, chatSystemPrompt, resetChatPromptCache } from '../server/chat-prompt.mjs'

const NO_GEN = { generativeImages: false, renderedImages: true, video: false }

test('names the product so the model knows what it is answering as', () => {
  const p = buildChatSystemPrompt(NO_GEN)
  assert.match(p, /PixGPT/)
  assert.match(p, /Pixous Technologies/)
})

test('forbids claiming an image was produced when nothing generative is configured', () => {
  const p = buildChatSystemPrompt(NO_GEN)
  assert.match(p, /cannot generate, edit, redraw or restyle images/i)
  // The specific failure this prompt exists to prevent: a lead-in for an image
  // that never arrives, which is what rendered as a bare "Please".
  assert.match(p, /Never say or imply that you have produced/i)
  assert.match(p, /here is the image/i)
})

test('offers the useful alternative rather than only refusing', () => {
  const p = buildChatSystemPrompt(NO_GEN)
  assert.match(p, /precise description of the design/i)
})

test('mentions the deterministic renderer only when it is actually available', () => {
  assert.match(buildChatSystemPrompt(NO_GEN), /gradients, mesh fields, cards, patterns and charts/)
  const bare = buildChatSystemPrompt({ ...NO_GEN, renderedImages: false })
  assert.doesNotMatch(bare, /mesh fields/)
  assert.match(bare, /cannot generate, edit, redraw or restyle images/i)
})

test('drops the image restriction once a generative backend exists', () => {
  const p = buildChatSystemPrompt({ generativeImages: true, renderedImages: true, video: false })
  assert.doesNotMatch(p, /cannot generate, edit, redraw or restyle images/i)
  // Video is still unavailable, so that limit stays and the section survives
  assert.match(p, /cannot generate video/i)
})

test('states no limits section at all when everything is available', () => {
  const p = buildChatSystemPrompt({ generativeImages: true, renderedImages: true, video: true })
  assert.doesNotMatch(p, /Limits you must respect/)
  assert.doesNotMatch(p, /Never say or imply that you have produced/i)
})

test('describes web search as server side, and only when configured', () => {
  const on = buildChatSystemPrompt({ ...NO_GEN, webSearch: true })
  assert.match(on, /no network access of your own/i)
  assert.doesNotMatch(buildChatSystemPrompt(NO_GEN), /web search/i)
})

test('always forbids narrating actions it did not take', () => {
  for (const caps of [
    NO_GEN,
    { generativeImages: true, renderedImages: true, video: true },
  ]) {
    assert.match(buildChatSystemPrompt(caps), /Never claim to have taken an action you did not take/i)
  }
})

test('chatSystemPrompt resolves against live capabilities and caches', async () => {
  resetChatPromptCache()
  const a = await chatSystemPrompt()
  assert.match(a, /You are PixGPT/)
  const b = await chatSystemPrompt()
  assert.equal(a, b, 'second call should come from the cache')
})

test('the webSearch flag busts the cache rather than serving a stale prompt', async () => {
  resetChatPromptCache()
  const off = await chatSystemPrompt({ webSearch: false })
  const on = await chatSystemPrompt({ webSearch: true })
  assert.notEqual(off, on)
  assert.match(on, /no network access of your own/i)
})
