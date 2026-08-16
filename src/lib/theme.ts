import type { Theme } from './types'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

/**
 * The user's *preference* ('dark' | 'light' | 'system') — not the resolved
 * value. `documentElement.dataset.theme` only ever holds the resolved value, so
 * it cannot tell us whether the user asked to follow the system.
 */
let preference: Theme = 'dark'

export function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') return darkQuery.matches ? 'dark' : 'light'
  return theme
}

export function applyTheme(theme: Theme): void {
  preference = theme
  document.documentElement.dataset.theme = resolveTheme(theme)
}

export function applyChatFontSize(px: number): void {
  document.documentElement.style.setProperty('--chat-font-size', `${px}px`)
}

export function initTheme(): void {
  // Read persisted appearance before first paint to avoid a flash
  try {
    const raw = localStorage.getItem('pixgpt:v1')
    if (raw) {
      const parsed = JSON.parse(raw) as { settings?: { theme?: Theme; chatFontSize?: number } }
      if (parsed.settings?.chatFontSize) applyChatFontSize(parsed.settings.chatFontSize)
      if (parsed.settings?.theme) {
        applyTheme(parsed.settings.theme)
        return
      }
    }
  } catch {
    /* ignore */
  }
  applyTheme('dark')
}

// Follow the OS only while the user's preference is "system"
darkQuery.addEventListener('change', () => {
  if (preference === 'system') applyTheme('system')
})
