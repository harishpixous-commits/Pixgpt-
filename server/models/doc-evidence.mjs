/* ============================================================
   Published-documentation evidence
   --------------------------------
   Section 33: use current official model documentation as *supporting*
   evidence when evaluating named families.

   Two rules keep this from becoming the name-based ranking that section
   32 forbids:

     1. It is keyed by **family**, not by route. Knowing what Anthropic
        publishes about Claude Sonnet 4.6 says nothing about whether
        `tllm/CLAUDE_4_6_SONNET` answers on this gateway.

     2. It contributes a small, fixed number of points and can never
        promote a model above one with live verification. A documented
        model that has never answered still loses to an undocumented one
        that has.

   `weight` is the ranking contribution, capped at DOC_MAX (see
   ranking.mjs). `note` is what the UI shows when asked why.
   ============================================================ */

import { CATEGORY } from './catalog.mjs'

/**
 * Families with published capability guidance.
 *
 * Kept short on purpose. Everything here is a claim about the *model family as
 * published by its vendor* — not about this gateway's route to it, and not
 * about a specific version. Where a vendor publishes a spread across a
 * generation (fast vs balanced vs flagship), that spread is captured in
 * `variants`, matched against the rest of the id.
 */
export const DOC_EVIDENCE = Object.freeze({
  claude: {
    note: 'Anthropic publishes this family as strong at coding, computer use, agent planning, knowledge work and long context.',
    categories: [CATEGORY.CODING, CATEGORY.REASONING, CATEGORY.TOOL_AGENT],
    longContext: true,
    weight: 3,
    variants: [
      { match: /opus/i, weight: 4, categories: [CATEGORY.REASONING, CATEGORY.CODING] },
      { match: /sonnet/i, weight: 4, categories: [CATEGORY.CODING, CATEGORY.TOOL_AGENT] },
      { match: /haiku/i, weight: 2, categories: [CATEGORY.FAST, CATEGORY.CHEAP] },
    ],
  },
  gpt: {
    note: 'OpenAI publishes a spread across this generation: a flagship for complex professional work and coding, a balanced tier, and a cost-sensitive tier.',
    categories: [CATEGORY.CODING, CATEGORY.REASONING],
    weight: 3,
    variants: [
      // The published positioning of the 5.6 line
      { match: /\bsol\b/i, weight: 4, categories: [CATEGORY.CODING, CATEGORY.REASONING], note: 'Published as the tier for complex professional work and coding.' },
      { match: /\bterra\b/i, weight: 3, categories: [CATEGORY.GENERAL_CHAT, CATEGORY.CODING], note: 'Published as the balanced tier.' },
      { match: /\bluna\b/i, weight: 2, categories: [CATEGORY.FAST, CATEGORY.CHEAP], note: 'Published as the cost-sensitive tier.' },
      { match: /mini|nano/i, weight: 1, categories: [CATEGORY.FAST, CATEGORY.CHEAP] },
    ],
  },
  gemini: {
    note: 'Google publishes this family with large context windows and native multimodal input.',
    categories: [CATEGORY.MULTIMODAL, CATEGORY.LONG_CONTEXT],
    longContext: true,
    weight: 3,
    variants: [
      { match: /pro/i, weight: 3, categories: [CATEGORY.REASONING] },
      { match: /flash/i, weight: 2, categories: [CATEGORY.FAST, CATEGORY.CHEAP] },
    ],
  },
  deepseek: {
    note: 'DeepSeek currently lists V4.0 as a released model; the family is published as reasoning- and code-oriented.',
    categories: [CATEGORY.REASONING, CATEGORY.CODING],
    weight: 2,
  },
  qwen: { note: 'Published as a code- and reasoning-capable family.', categories: [CATEGORY.CODING], weight: 2 },
  kimi: { note: 'Published with a long context window and agentic tool use.', categories: [CATEGORY.LONG_CONTEXT, CATEGORY.TOOL_AGENT], longContext: true, weight: 2 },
  glm: { note: 'Published as a general and coding-capable family.', categories: [CATEGORY.CODING], weight: 2 },
  perplexity: { note: 'Published as a search-grounded answering model.', categories: [CATEGORY.RESEARCH], weight: 2 },
  grok: { note: 'Published as a general reasoning family.', categories: [CATEGORY.REASONING], weight: 2 },
  mistral: { note: 'Published as an efficient general family.', categories: [CATEGORY.FAST], weight: 1 },
  llama: { note: 'Open-weight general family.', categories: [CATEGORY.GENERAL_CHAT], weight: 1 },
  gemma: { note: 'Open-weight lightweight family.', categories: [CATEGORY.FAST], weight: 1 },
  nemotron: { note: 'Open-weight reasoning-tuned family.', categories: [CATEGORY.REASONING], weight: 1 },
  minimax: { note: 'Published as a long-context family.', categories: [CATEGORY.LONG_CONTEXT], weight: 1 },
  felo: { note: 'Search-oriented endpoints rather than a general chat family.', categories: [CATEGORY.RESEARCH], weight: 0 },
  video: { note: 'Advertised as video generation. Nothing here has produced a validated output.', categories: [CATEGORY.VIDEO_GENERATION], weight: 0 },
})

/**
 * Documentation evidence for one model id.
 *
 * Returns `{ note, categories, weight, longContext }`, with the most specific
 * matching variant merged over the family entry.
 */
export function docEvidenceFor(id, family) {
  const base = DOC_EVIDENCE[family]
  if (!base) return null

  const rest = id.slice(id.indexOf('/') + 1)
  const variant = base.variants?.find((v) => v.match.test(rest))

  return {
    note: variant?.note ?? base.note,
    categories: [...new Set([...(base.categories ?? []), ...(variant?.categories ?? [])])],
    weight: variant?.weight ?? base.weight ?? 0,
    longContext: Boolean(base.longContext),
    context: base.context ?? null,
    family,
  }
}

/**
 * The lookup table `normaliseModel` consumes. Keyed by family so a record can
 * find its own evidence without this module knowing about ids.
 */
export function docEvidenceTable() {
  const out = {}
  for (const [family, entry] of Object.entries(DOC_EVIDENCE)) {
    out[family] = {
      note: entry.note,
      categories: entry.categories ?? [],
      longContext: Boolean(entry.longContext),
      context: entry.context ?? null,
    }
  }
  return out
}
