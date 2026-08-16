/* ============================================================
   Text-to-speech — Web Speech API
   -------------------------------
   The Voice settings (voice, speech rate, auto-read) drive this
   module. Voices are the real ones the browser reports, so the
   settings screen never shows an option that does nothing. If the
   browser has no speech support, callers get `speechSupported ===
   false` and the UI hides the controls rather than faking them.
   ============================================================ */

import { useEffect, useState, useSyncExternalStore } from 'react'

export const speechSupported =
  typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

/* ---------- markdown → speakable text ---------- */

/**
 * Strips markdown syntax so a response is spoken as prose instead of
 * "hash hash Key points, star star clarity star star".
 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/~~~[\s\S]*?~~~/g, ' (code block) ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' (formula) ')
    .replace(/\$[^$\n]+\$/g, ' (formula) ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-:|\s]+$/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ---------- available voices ---------- */

export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() =>
    speechSupported ? window.speechSynthesis.getVoices() : [],
  )

  useEffect(() => {
    if (!speechSupported) return
    const read = () => setVoices(window.speechSynthesis.getVoices())
    read()
    // Chrome populates the list asynchronously
    window.speechSynthesis.addEventListener('voiceschanged', read)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', read)
  }, [])

  return voices
}

/* ---------- what is speaking right now ---------- */

const listeners = new Set<() => void>()
let speakingKey: string | null = null

function setSpeakingKey(key: string | null): void {
  if (speakingKey === key) return
  speakingKey = key
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The key passed to `speak()` for the utterance currently playing, if any. */
export function useSpeakingKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => speakingKey,
    () => null,
  )
}

/* ---------- controls ---------- */

export interface SpeakOptions {
  /** `SpeechSynthesisVoice.voiceURI`; falls back to the browser default. */
  voiceURI?: string
  rate?: number
}

/**
 * Speaks `text`, replacing anything already playing.
 * `key` identifies the source (e.g. a message id) so the UI can show which
 * message is being read.
 */
export function speak(key: string, text: string, { voiceURI, rate = 1 }: SpeakOptions = {}): void {
  if (!speechSupported) return
  const body = toPlainText(text)
  if (!body) return

  const synth = window.speechSynthesis
  synth.cancel()

  const utterance = new SpeechSynthesisUtterance(body)
  utterance.rate = Math.min(Math.max(rate, 0.5), 2)
  if (voiceURI) {
    const match = synth.getVoices().find((v) => v.voiceURI === voiceURI)
    if (match) {
      utterance.voice = match
      utterance.lang = match.lang
    }
  }

  utterance.onend = () => setSpeakingKey(null)
  utterance.onerror = () => setSpeakingKey(null)

  setSpeakingKey(key)
  synth.speak(utterance)
}

export function stopSpeaking(): void {
  if (!speechSupported) return
  window.speechSynthesis.cancel()
  setSpeakingKey(null)
}
