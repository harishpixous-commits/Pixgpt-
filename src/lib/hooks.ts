import { useCallback, useEffect, useState , type RefObject } from 'react'
import { fetchGatewayStatus, fetchModels, type GatewayModels, type GatewayStatus } from './api'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    setMatches(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Below this width the sidebar becomes a drawer. Mirrored in `store.ts`. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 1023px)')
}

/**
 * Availability of the AI gateway, polled from the PixGPT server's `/api/health`
 * (which probes OmniRoute). Lets the UI say "gateway offline" up front instead
 * of only failing once the user sends a message.
 *
 * Returns `null` until the first probe resolves, so the UI shows nothing rather
 * than flashing a false warning on load.
 */
export function useGatewayStatus(pollMs = 30_000): GatewayStatus | null {
  const [status, setStatus] = useState<GatewayStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const check = async () => {
      const next = await fetchGatewayStatus(controller.signal)
      if (!cancelled) setStatus(next)
    }

    void check()
    const id = setInterval(() => void check(), pollMs)
    // Re-probe as soon as the machine is back online
    window.addEventListener('online', check)

    return () => {
      cancelled = true
      controller.abort()
      clearInterval(id)
      window.removeEventListener('online', check)
    }
  }, [pollMs])

  return status
}

/**
 * Model catalogue and per-model capabilities, resolved server-side. Fetched once
 * per mount and shared via a module cache so several components can ask without
 * repeating the request.
 */
let modelsCache: GatewayModels | null = null
let modelsInFlight: Promise<GatewayModels> | null = null

export function useGatewayModels(): GatewayModels | null {
  const [models, setModels] = useState<GatewayModels | null>(modelsCache)

  useEffect(() => {
    if (modelsCache) return
    let cancelled = false
    modelsInFlight ??= fetchModels().then((result) => {
      modelsCache = result
      modelsInFlight = null
      return result
    })
    void modelsInFlight.then((result) => {
      if (!cancelled) setModels(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return models
}

/** Whether the given PixGPT model may carry images. Defaults to false until known. */
export function useModelSupportsVision(model: string): boolean {
  const models = useGatewayModels()
  if (!models) return false
  const capability = models.modelCapabilities[model]
  // A concrete provider model (not one of our aliases) is trusted — the operator
  // chose it explicitly and the gateway will reject it if it cannot see.
  if (!capability) return Object.keys(models.modelCapabilities).length > 0 && !(model in models.aliases)
  return capability.vision
}

/**
 * Browser connectivity, from the real `online`/`offline` events. `recheck()`
 * re-reads `navigator.onLine` so the "Reconnect" affordance reports the actual
 * current state rather than optimistically clearing itself.
 */
export function useOnlineStatus(): { online: boolean; recheck: () => boolean } {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const recheck = useCallback(() => {
    const next = navigator.onLine
    setOnline(next)
    return next
  }, [])

  return { online, recheck }
}

/** Whether the server has a web-search provider configured. */
export function useWebSearchAvailable(): boolean {
  const models = useGatewayModels()
  return Boolean(models?.webSearch?.available)
}

/**
 * Keeps keyboard focus inside an open dialog.
 *
 * `Dialog` has always done this, but the hand-built panels (Skills, Models) did
 * not: Tab walked straight out of the modal and into the sidebar and composer
 * behind it. It was easy to miss because Skills has 350 focusable elements, so
 * a short tab-through never reached the edge — you have to press Tab 349 times
 * to see the bug.
 *
 * Also restores focus to whatever opened the dialog, so closing it does not
 * dump the user back at the top of the page.
 */
export function useFocusTrap(open: boolean, panelRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return

      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
      if (focusables.length === 0) return

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null

      // Focus outside the panel entirely (the trap was bypassed): pull it back
      if (active && !panel.contains(active)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previouslyFocused?.focus()
    }
  }, [open, panelRef])
}
