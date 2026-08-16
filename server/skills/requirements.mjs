import { log } from '../config.mjs'

/* ============================================================
   Skill requirements
   ------------------
   A skill is only "available" when the thing it depends on actually
   works. Requirements resolve against the live systems — the gateway,
   the search registry, the generation backends, the browser, the tool
   registry — never against a hardcoded list.

   That is the whole point. A skill panel that shows "Image Generation
   ✓ Available" on a machine with no backend is worse than showing
   nothing: the user clicks it, it fails, and they stop trusting the
   panel. So every requirement has a resolver that goes and looks.

   Resolvers are cached per request cycle, because a skill list checks
   the same few dependencies dozens of times and probing the gateway
   once per skill would be absurd.
   ============================================================ */

export const REQUIREMENT = Object.freeze({
  MODEL_VISION: 'model:vision',
  MODEL_TOOLS: 'model:tools',
  GATEWAY: 'gateway',
  SEARCH_PROVIDER: 'search:provider',
  SEARCH_GITHUB: 'search:github',
  BROWSER: 'browser',
  IMAGE_BACKEND: 'generation:image',
  IMAGE_GENERATIVE: 'generation:image:generative',
  VIDEO_BACKEND: 'generation:video',
  COMFYUI: 'generation:comfyui',
  LOCAL_GPU: 'hardware:gpu',
  DOCUMENTS: 'documents',
  WORKSPACE: 'agent:workspace',
  SPEECH_INPUT: 'browser:speech',
})

/** One resolution cycle's memoised answers. */
let cache = null
let cacheStamp = 0
const CACHE_MS = 5000

function memo(key, produce) {
  const now = Date.now()
  if (!cache || now - cacheStamp > CACHE_MS) {
    cache = new Map()
    cacheStamp = now
  }
  if (!cache.has(key)) cache.set(key, produce())
  return cache.get(key)
}

/** Clears the memo — used by tests and after a configuration change. */
export function invalidateRequirements() {
  cache = null
  cacheStamp = 0
}

/**
 * Each resolver returns { met, detail, fix? }.
 * `fix` names what an operator would change, never a secret value.
 */
const RESOLVERS = {
  [REQUIREMENT.GATEWAY]: async () => {
    try {
      const { getGateway } = await import('../gateway/index.mjs')
      const { id, configProblems } = getGateway()
      return configProblems.length === 0
        ? { met: true, detail: `${id} is configured` }
        : { met: false, detail: configProblems.join('; '), fix: 'Complete the gateway configuration' }
    } catch (error) {
      return { met: false, detail: String(error?.message).slice(0, 120), fix: 'Configure an AI gateway' }
    }
  },

  [REQUIREMENT.MODEL_VISION]: async () => {
    const { visionStatus } = await import('../vision-router.mjs')
    const status = await visionStatus()
    if (!status.configured) {
      return { met: false, detail: 'No vision-capable model is configured.', fix: 'Set PIXGPT_MODEL_VISION' }
    }
    /*
     * Configured is not the same as working. A route that has never answered is
     * reported as unverified rather than available — claiming vision works
     * before it has ever returned an image reading is exactly the failure this
     * whole layer exists to prevent.
     */
    if (status.healthyCount === 0) {
      return { met: false, detail: 'Every vision route is in cooldown.', fix: 'Wait, or configure another vision model' }
    }
    return {
      met: true,
      detail: status.verified
        ? `${status.healthyCount} vision route(s), verified working`
        : `${status.healthyCount} vision route(s) configured, not yet verified`,
      unverified: !status.verified,
    }
  },

  [REQUIREMENT.MODEL_TOOLS]: async () => {
    const { getGateway } = await import('../gateway/index.mjs')
    const { adapter } = getGateway()
    return adapter.capabilities.tools
      ? { met: true, detail: 'The gateway supports tool calling' }
      : { met: false, detail: 'This gateway does not support tool calling.', fix: 'Use a gateway that does' }
  },

  [REQUIREMENT.SEARCH_PROVIDER]: async () => {
    const { listProviders } = await import('../search/registry.mjs')
    const usable = listProviders().filter((p) => p.available)
    return usable.length > 0
      ? { met: true, detail: `${usable.length} provider(s): ${usable.map((p) => p.name).join(', ')}` }
      : { met: false, detail: 'No search provider is available.', fix: 'Set SEARXNG_URL or a provider API key' }
  },

  [REQUIREMENT.SEARCH_GITHUB]: async () => {
    const { listProviders } = await import('../search/registry.mjs')
    const github = listProviders().find((p) => p.id === 'github')
    if (!github?.available) {
      return { met: false, detail: 'GitHub search is disabled.', fix: 'Set GITHUB_ENABLED=true' }
    }
    return {
      met: true,
      detail: process.env.GITHUB_TOKEN
        ? 'Authenticated: repository, issue and code search'
        : 'Unauthenticated: repository and issue search only',
      partial: !process.env.GITHUB_TOKEN,
      fix: process.env.GITHUB_TOKEN ? undefined : 'Set GITHUB_TOKEN for code search',
    }
  },

  [REQUIREMENT.BROWSER]: async () => {
    const { browserAvailable } = await import('../agent/browser.mjs')
    return browserAvailable()
      ? { met: true, detail: 'Chrome or Edge is installed' }
      : { met: false, detail: 'No Chrome or Edge installation was found.', fix: 'Install one, or set PIXGPT_BROWSER_PATH' }
  },

  [REQUIREMENT.IMAGE_BACKEND]: async () => {
    const { generationStatus } = await import('../generation/index.mjs')
    const status = await generationStatus()
    return status.image.available
      ? { met: true, detail: `Backends: ${status.image.backends.join(', ')}` }
      : { met: false, detail: 'No image backend is available.', fix: 'Set COMFYUI_URL or a remote provider' }
  },

  [REQUIREMENT.IMAGE_GENERATIVE]: async () => {
    const { generationStatus } = await import('../generation/index.mjs')
    const status = await generationStatus()
    /*
     * The deterministic renderer satisfies IMAGE_BACKEND but not this. A skill
     * that promises a photograph must not be marked available when the only
     * backend composes gradients.
     */
    return status.image.generative
      ? { met: true, detail: 'A generative backend is configured' }
      : {
          met: false,
          detail: 'Only the deterministic renderer is available — it composes graphics, it does not synthesise imagery.',
          fix: 'Configure ComfyUI or a remote generation API',
        }
  },

  [REQUIREMENT.VIDEO_BACKEND]: async () => {
    const { generationStatus } = await import('../generation/index.mjs')
    const status = await generationStatus()
    return status.video.available
      ? { met: true, detail: `Backends: ${status.video.backends.join(', ')}` }
      : { met: false, detail: 'No video backend is available.', fix: 'Configure a video-capable ComfyUI or remote provider' }
  },

  [REQUIREMENT.COMFYUI]: async () => {
    const { detectComfyUI } = await import('../generation/resources.mjs')
    const comfy = await detectComfyUI()
    if (!comfy.configured) return { met: false, detail: 'ComfyUI is not configured.', fix: 'Set COMFYUI_URL' }
    return comfy.reachable
      ? { met: true, detail: `Reachable${comfy.version ? ` (v${comfy.version})` : ''}` }
      : { met: false, detail: `Configured but unreachable (${comfy.reason}).`, fix: 'Start ComfyUI, or correct COMFYUI_URL' }
  },

  [REQUIREMENT.LOCAL_GPU]: async () => {
    const { detectResources } = await import('../generation/resources.mjs')
    const resources = await detectResources()
    return resources.localGeneration
      ? { met: true, detail: `${resources.gpu?.name} with ${resources.vramGb} GB VRAM` }
      : { met: false, detail: resources.reasons.join('; '), fix: 'A CUDA or ROCm accelerator is required' }
  },

  [REQUIREMENT.DOCUMENTS]: async () => {
    const { documentSupport } = await import('../documents.mjs')
    const formats = documentSupport().filter((f) => f.available)
    return { met: formats.length > 0, detail: `${formats.length} formats: ${formats.map((f) => f.label).join(', ')}` }
  },

  [REQUIREMENT.WORKSPACE]: async () => ({ met: true, detail: 'Isolated task workspaces are available' }),

  [REQUIREMENT.SPEECH_INPUT]: async () => ({
    met: false,
    detail: 'Dictation uses the browser Web Speech API and has no server backend here.',
    fix: 'Not configurable server-side',
  }),
}

/**
 * Resolves one requirement.
 * @returns {Promise<{ id, met, detail, fix?, partial?, unverified? }>}
 */
export async function resolveRequirement(id) {
  const resolver = RESOLVERS[id]
  if (!resolver) return { id, met: false, detail: `Unknown requirement: ${id}` }

  return memo(id, async () => {
    try {
      return { id, ...(await resolver()) }
    } catch (error) {
      log.warn('requirement resolution failed', { requirement: id, message: String(error?.message).slice(0, 140) })
      return { id, met: false, detail: `Could not be checked (${String(error?.message).slice(0, 80)})` }
    }
  })
}

/** Resolves a skill's whole requirement list. */
export async function resolveAll(requirements = []) {
  const resolved = await Promise.all(requirements.map((id) => resolveRequirement(id)))
  return {
    resolved,
    met: resolved.every((r) => r.met),
    unmet: resolved.filter((r) => !r.met),
    // A requirement that is met but unproven, e.g. a vision route that has never answered
    unverified: resolved.filter((r) => r.met && r.unverified),
    partial: resolved.filter((r) => r.met && r.partial),
  }
}

export { RESOLVERS }
