/* ============================================================
   Chat system prompt
   ------------------
   Until this existed, `/api/chat` sent the transcript with no system turn at
   all, so the model had no idea what PixGPT is or what it can do. That is not
   a cosmetic gap. Asked to edit an attached image, a vision model that knows
   its own family can emit images assumes the product can too, and answers with
   a lead-in for a picture that never arrives:

       "Please"
       "Here is the updated logo:"
       "An image has been created based on your request."

   The image was never dropped in transport — `buildBody` never asks for image
   output, so the reply is text only and the model is confabulating. The user
   sees a one-word answer and reasonably reads it as a bug in PixGPT.

   The prompt is built from the live capability snapshot rather than a hardcoded
   list, so the day a generative backend is configured the restriction lifts by
   itself instead of leaving the model under standing orders to deny a feature
   that now works.
   ============================================================ */

import { generationStatus } from './generation/index.mjs'

/** Capability probing touches the filesystem, so hold the answer briefly. */
const TTL_MS = 60_000
let cached = null

/**
 * @param {object} caps
 * @param {boolean} caps.generativeImages  a backend that actually samples imagery
 * @param {boolean} caps.renderedImages    the deterministic renderer (gradients, charts)
 * @param {boolean} caps.video
 * @param {boolean} [caps.webSearch]       grounding available for the user to enable
 * @returns {string}
 */
export function buildChatSystemPrompt({ generativeImages, renderedImages, video, webSearch = false }) {
  const lines = [
    'You are PixGPT, an AI assistant built by Pixous Technologies.',
    '',
    'You can hold a conversation, explain and analyse, write and review code, read images and documents the user attaches, and draft documents that PixGPT can export as PDF, Word, PowerPoint, Markdown, HTML or plain text.',
  ]

  if (webSearch) {
    lines.push(
      'The user can switch on web search for a turn. When they do, results are fetched for you and supplied as context; you have no network access of your own.',
    )
  }

  /*
   * Stated as "do not claim", not merely "you cannot". A bare capability list
   * still leaves the model free to narrate the act ("generating that now…"),
   * which produces exactly the stub replies this prompt exists to prevent.
   */
  const cannot = []
  if (!generativeImages) {
    cannot.push(
      renderedImages
        ? 'You cannot generate, edit, redraw or restyle images. PixGPT can only render deterministic graphics such as gradients, mesh fields, cards, patterns and charts, and that is a separate tool the user invokes, not something you produce in a reply.'
        : 'You cannot generate, edit, redraw or restyle images.',
    )
  }
  if (!video) cannot.push('You cannot generate video.')

  if (cannot.length > 0) {
    lines.push('', 'Limits you must respect:', ...cannot.map((c) => `- ${c}`))
    lines.push(
      '- Never say or imply that you have produced, attached, generated or updated an image or video. Do not write "here is the image", "an image has been created", or any similar lead-in. Nothing you write becomes a file the user can see.',
      '- When asked for one anyway, say plainly in one sentence that you cannot produce images, then give the most useful thing you can instead: a precise description of the design, exact text, colours and layout the user could hand to a designer, or an offer to write it up as a document.',
    )
  }

  lines.push(
    '',
    'Never claim to have taken an action you did not take. If you are unsure whether something is within reach, say so rather than describing the result as though it exists.',
    'Answer in Markdown. Be direct and concise; give the answer before the caveats.',
  )

  return lines.join('\n')
}

/**
 * The prompt for the current server, from live capability flags.
 * @param {object} [opts]
 * @param {boolean} [opts.webSearch]
 * @returns {Promise<string>}
 */
export async function chatSystemPrompt({ webSearch = false } = {}) {
  const now = Date.now()
  if (cached && cached.webSearch === webSearch && now - cached.at < TTL_MS) return cached.prompt

  let caps = { generativeImages: false, renderedImages: false, video: false }
  try {
    const status = await generationStatus({ probe: false })
    caps = {
      generativeImages: status.image?.generative === true,
      renderedImages: status.image?.available === true,
      video: status.video?.available === true,
    }
  } catch {
    /*
     * Capability detection failing must not take chat down with it. The
     * conservative default is "cannot", which is also the correct answer on
     * every deployment that has no generative backend configured.
     */
  }

  const prompt = buildChatSystemPrompt({ ...caps, webSearch })
  cached = { prompt, webSearch, at: now }
  return prompt
}

/** Test seam — drops the capability cache. */
export function resetChatPromptCache() {
  cached = null
}
