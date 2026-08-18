import { create } from 'zustand'
import { ChatRequestError, chatApi } from './api'
import { speak, stopSpeaking } from './speech'
import { applyChatFontSize, applyTheme } from './theme'
import type { Attachment, ChatMessage, Conversation, ModelId, Settings } from './types'
import {
  approveCommand,
  emptyTask,
  runAgentTask,
  type AgentMode,
  type AgentTaskState,
} from './agent'
import { truncate, uid } from './utils'

const STORAGE_KEY = 'pixgpt:v1'

export interface StreamingState {
  convId: string
  messageId: string
}

export const defaultSettings: Settings = {
  theme: 'dark',
  chatFontSize: 15,
  defaultModel: 'pixgpt-pro',
  temperature: 0.7,
  autoTitle: true,
  keepHistory: true,
  /** Empty means "browser default voice"; otherwise a real `SpeechSynthesisVoice.voiceURI`. */
  voice: '',
  speechRate: 1,
  autoReadResponses: false,
  favouriteModels: [],
  userName: 'Harish',
  userEmail: '',
}

function defaultTitle(text: string): string {
  const t = truncate(text, 60)
  return t || 'New chat'
}

/** Mirrors `useIsMobile()` — the width at which the sidebar becomes a drawer. */
function isDrawerViewport(): boolean {
  return window.matchMedia('(max-width: 1023px)').matches
}

/* ---------- persistence ---------- */

interface PersistedShape {
  conversations?: Conversation[]
  settings?: Partial<Settings>
  activeId?: string | null
}

/**
 * `blob:` preview URLs are only valid for the session that created them. After a
 * reload they would render as broken images, so drop them and let the
 * attachment fall back to its file icon. A real upload backend returns a durable
 * URL, which survives this pass untouched.
 */
function dropDeadPreviewUrls(conv: Conversation): Conversation {
  if (!conv.messages?.some((m) => m.attachments?.some((a) => a.url?.startsWith('blob:')))) {
    return conv
  }
  return {
    ...conv,
    messages: conv.messages.map((m) =>
      m.attachments?.some((a) => a.url?.startsWith('blob:'))
        ? {
            ...m,
            attachments: m.attachments.map((a) =>
              a.url?.startsWith('blob:') ? { ...a, url: undefined } : a,
            ),
          }
        : m,
    ),
  }
}

function loadPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistedShape
    return {
      conversations: Array.isArray(parsed.conversations)
        ? parsed.conversations.map(dropDeadPreviewUrls)
        : undefined,
      settings: parsed.settings ?? undefined,
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : undefined,
    }
  } catch {
    return {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(get: () => PixGptState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const s = get()
    if (!s.settings.keepHistory) return
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          conversations: s.conversations,
          settings: s.settings,
          activeId: s.activeId,
        }),
      )
    } catch {
      /* storage full or unavailable — fail silently */
    }
  }, 350)
}

/* ---------- streaming plumbing ---------- */

let streamController: AbortController | null = null
let agentController: AbortController | null = null

interface PixGptState {
  conversations: Conversation[]
  activeId: string | null
  sidebarOpen: boolean
  searchQuery: string
  settings: Settings
  streaming: StreamingState | null
  composerFocusTick: number
  /** Ground answers in live web results. Off by default; the user opts in. */
  webEnabled: boolean
  /** Chat behaves exactly as before; Build routes to the coding agent. */
  mode: AgentMode
  agent: AgentTaskState

  newConversation: () => string
  openConversation: (id: string) => void
  deleteConversation: (id: string) => void
  clearConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setSearchQuery: (q: string) => void
  toggleSidebar: () => void
  toggleWeb: () => void
  setMode: (mode: AgentMode) => void
  runBuild: (objective: string, taskId?: string) => Promise<void>
  resolveApproval: (decision: 'once' | 'task' | 'deny') => Promise<void>
  stopBuild: () => void
  setSidebarOpen: (open: boolean) => void
  setConversationModel: (id: string, model: ModelId) => void
  updateSettings: (patch: Partial<Settings>) => void
  setFeedback: (convId: string, messageId: string, feedback: 'like' | 'dislike' | null) => void
  sendMessage: (text: string, attachments: Attachment[]) => Promise<void>
  stopStreaming: () => void
  retryLast: (convId: string) => Promise<void>
  regenerateFrom: (convId: string, assistantMessageId: string) => Promise<void>
  /** Continues a response the model cut off at its output ceiling. */
  continueFrom: (convId: string, assistantMessageId: string) => Promise<void>
  resetAll: () => void
}

async function runStream(
  get: () => PixGptState,
  set: (partial: Partial<PixGptState> | ((s: PixGptState) => Partial<PixGptState>)) => void,
  convId: string,
  messageId: string,
  history: ChatMessage[],
  model: ModelId,
): Promise<void> {
  const controller = new AbortController()
  streamController = controller

  let pendingText = ''
  let rafQueued = false
  const sources: Array<{ title: string; url: string }> = []

  const flush = () => {
    const text = pendingText
    pendingText = ''
    if (!text) return
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, content: m.content + text } : m,
              ),
            }
          : c,
      ),
    }))
  }

  const onToken = (token: string) => {
    pendingText += token
    if (!rafQueued) {
      rafQueued = true
      requestAnimationFrame(() => {
        rafQueued = false
        flush()
      })
    }
  }

  const attachSources = () => {
    if (sources.length === 0) return
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, sources: [...sources] } : m)) }
          : c,
      ),
    }))
  }

  /** Which route actually answered. Set from the stream's `done` event. */
  let served: { model?: string; fellBack?: boolean; truncated?: boolean } = {}

  const finish = (status: 'complete' | 'error', failure?: { message: string; code?: string }) => {
    flush()
    const s = get()
    if (status === 'complete' && s.settings.autoReadResponses) {
      const text = s.conversations
        .find((c) => c.id === convId)
        ?.messages.find((m) => m.id === messageId)?.content
      if (text) speak(messageId, text, { voiceURI: s.settings.voice, rate: s.settings.speechRate })
    }
    set({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      status,
                      error: failure?.message,
                      errorCode: failure?.code,
                      servedBy: served.model,
                      fellBack: served.fellBack,
                      truncated: served.truncated,
                    }
                  : m,
              ),
            }
          : c,
      ),
      streaming: null,
    })
  }

  try {
    await chatApi.streamCompletion(
      { messages: history, model, temperature: get().settings.temperature, web: get().webEnabled },
      controller.signal,
      onToken,
      (source) => {
        sources.push(source)
        attachSources()
      },
      (info) => {
        served = info
      },
    )
    finish('complete')
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    // A user stop keeps the partial response; a real failure surfaces as an error state
    if (aborted) {
      finish('complete')
    } else {
      finish('error', {
        message: error instanceof Error ? error.message : 'The response could not be generated.',
        code: error instanceof ChatRequestError ? error.code : undefined,
      })
    }
  } finally {
    streamController = null
  }
}

/* ---------- store ---------- */

const persisted = loadPersisted()

export const usePixGptStore = create<PixGptState>()((set, get) => ({
  conversations: persisted.conversations ?? [],
  activeId: persisted.activeId ?? null,
  // On phones the sidebar is an overlay drawer, so opening it by default would
  // cover the composer on first load. Desktop keeps it open.
  sidebarOpen: !isDrawerViewport(),
  searchQuery: '',
  settings: { ...defaultSettings, ...persisted.settings },
  streaming: null,
  composerFocusTick: 0,
  webEnabled: false,
  mode: 'chat',
  agent: emptyTask(),

  newConversation: () => {
    const conv: Conversation = {
      id: uid(),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: get().settings.defaultModel,
      messages: [],
    }
    set((s) => ({
      conversations: [conv, ...s.conversations],
      activeId: conv.id,
      searchQuery: '',
      composerFocusTick: s.composerFocusTick + 1,
    }))
    return conv.id
  },

  openConversation: (id) => {
    if (get().streaming) return
    stopSpeaking()
    set({ activeId: id })
  },

  deleteConversation: (id) => {
    stopSpeaking()
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id)
      const activeId = s.activeId === id ? conversations[0]?.id ?? null : s.activeId
      return { conversations, activeId }
    })
  },

  clearConversation: (id) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, messages: [], updatedAt: Date.now() } : c,
      ),
    }))
  },

  renameConversation: (id, title) => {
    const clean = title.trim() || 'New chat'
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title: clean } : c,
      ),
    }))
  },

  setSearchQuery: (q) => set({ searchQuery: q }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  toggleWeb: () => set((s) => ({ webEnabled: !s.webEnabled })),

  setMode: (mode) => set({ mode }),

  /**
   * Build mode. Deliberately separate from sendMessage: the chat path and its
   * message format are untouched, and agent progress lives in its own state so
   * a long build cannot corrupt the conversation.
   */
  runBuild: async (objective, taskId) => {
    const trimmed = objective.trim()
    if (!trimmed || get().agent.status === 'running') return

    agentController?.abort()
    agentController = new AbortController()

    // `taskId` continues an existing workspace — an imported project keeps its files
    set({ agent: { ...emptyTask(trimmed), status: 'running', taskId: taskId ?? null } })
    try {
      await runAgentTask(
        { objective: trimmed, model: get().settings.defaultModel, taskId },
        agentController.signal,
        (updater) => set((s) => ({ agent: updater(s.agent) })),
      )
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      set((s) => ({
        agent: {
          ...s.agent,
          status: aborted ? 'cancelled' : 'error',
          error: aborted ? null : 'transport',
        },
      }))
    } finally {
      agentController = null
      set((s) => ({ agent: s.agent.status === 'running' ? { ...s.agent, status: 'done' } : s.agent }))
    }
  },

  resolveApproval: async (decision) => {
    const { agent } = get()
    if (!agent.taskId || !agent.approval) return
    const { command, program } = agent.approval
    // Clear locally first so the dialog cannot be double-submitted
    set((s) => ({ agent: { ...s.agent, approval: null } }))
    await approveCommand(agent.taskId, command, program, decision)
  },

  stopBuild: () => {
    agentController?.abort()
    set((s) => ({ agent: { ...s.agent, status: 'cancelled', approval: null } }))
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  setConversationModel: (id, model) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, model } : c,
      ),
    }))
  },

  updateSettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
    const next = get().settings
    if (patch.theme) applyTheme(next.theme)
  },

  setFeedback: (convId, messageId, feedback) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, feedback } : m,
              ),
            }
          : c,
      ),
    }))
  },

  sendMessage: async (text, attachments) => {
    const state = get()
    if (state.streaming) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return

    let convId = state.activeId
    if (!convId) {
      convId = uid()
      const conv: Conversation = {
        id: convId,
        title: defaultTitle(trimmed),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: state.settings.defaultModel,
        messages: [],
      }
      set({
        conversations: [conv, ...state.conversations],
        activeId: convId,
        // Only the mobile drawer overlays the composer; the desktop sidebar stays put.
        sidebarOpen: isDrawerViewport() ? false : state.sidebarOpen,
      })
    } else if (state.settings.autoTitle) {
      const conv = state.conversations.find((c) => c.id === convId)
      if (conv && conv.messages.length === 0) {
        set({
          conversations: state.conversations.map((c) =>
            c.id === convId ? { ...c, title: defaultTitle(trimmed) } : c,
          ),
        })
      }
    }

    const conv = get().conversations.find((c) => c.id === convId)
    if (!conv) return

    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      status: 'complete',
      attachments: attachments.length > 0 ? attachments : undefined,
    }
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
    }

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? { ...c, messages: [...c.messages, userMessage, assistantMessage] }
          : c,
      ),
      streaming: { convId: convId!, messageId: assistantMessage.id },
    }))

    const history = [...conv.messages, userMessage]
    await runStream(get, set, convId, assistantMessage.id, history, conv.model)
  },

  stopStreaming: () => {
    streamController?.abort()
    stopSpeaking()
  },

  retryLast: async (convId) => {
    const state = get()
    if (state.streaming) return
    const conv = state.conversations.find((c) => c.id === convId)
    if (!conv) return

    const lastUserIndex = [...conv.messages].reverse().findIndex((m) => m.role === 'user')
    if (lastUserIndex === -1) return
    const userIndex = conv.messages.length - 1 - lastUserIndex
    const history = conv.messages.slice(0, userIndex + 1)

    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
    }
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, messages: [...history, assistantMessage] } : c,
      ),
      streaming: { convId, messageId: assistantMessage.id },
    }))
    await runStream(get, set, convId, assistantMessage.id, history, conv.model)
  },

  regenerateFrom: async (convId, assistantMessageId) => {
    const state = get()
    if (state.streaming) return
    const conv = state.conversations.find((c) => c.id === convId)
    if (!conv) return

    const targetIndex = conv.messages.findIndex((m) => m.id === assistantMessageId)
    if (targetIndex === -1) return

    // Find the user message at or before the target assistant message
    let userIndex = -1
    for (let i = targetIndex; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        userIndex = i
        break
      }
    }
    if (userIndex === -1) return

    const history = conv.messages.slice(0, userIndex + 1)
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
    }
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, messages: [...history, assistantMessage] } : c,
      ),
      streaming: { convId, messageId: assistantMessage.id },
    }))
    await runStream(get, set, convId, assistantMessage.id, history, conv.model)
  },

  /**
   * Continues a response the model cut off at its output ceiling.
   *
   * The truncated text stays in place and the stream appends to the same
   * message, so the continuation reads as one answer rather than a second
   * reply. The transcript sent upstream ends with a short "continue" turn
   * (only in the request, never rendered), so the model knows to pick up where
   * it stopped instead of repeating itself.
   */
  continueFrom: async (convId, assistantMessageId) => {
    const state = get()
    if (state.streaming) return
    const conv = state.conversations.find((c) => c.id === convId)
    if (!conv) return

    const index = conv.messages.findIndex((m) => m.id === assistantMessageId)
    if (index === -1) return
    const target = conv.messages[index]
    if (target.role !== 'assistant' || target.status !== 'complete') return

    // Flip the message back to streaming so the live edge shows while it grows
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMessageId ? { ...m, status: 'streaming', truncated: false } : m,
              ),
            }
          : c,
      ),
      streaming: { convId, messageId: assistantMessageId },
    }))

    // Everything so far, ending with a hidden continue instruction. The partial
    // assistant turn stays in the transcript so the model has its own words to
    // resume from; the extra user turn exists only in the request.
    // The partial assistant turn stays in the transcript so the model has its
    // own words to resume from; the extra user turn exists only in the request.
    const history: ChatMessage[] = [
      ...conv.messages.slice(0, index + 1),
      {
        id: uid(),
        role: 'user',
        content: 'Please continue your previous answer from exactly where you stopped.',
        createdAt: Date.now(),
        status: 'complete',
      },
    ]
    await runStream(get, set, convId, assistantMessageId, history, conv.model)
  },

  resetAll: () => {
    stopSpeaking()
    set({ conversations: [], activeId: null, searchQuery: '' })
  },
}))

/* ---------- persistence + theme wiring ---------- */

let lastTheme = usePixGptStore.getState().settings.theme
let lastFontSize = usePixGptStore.getState().settings.chatFontSize

usePixGptStore.subscribe((state) => {
  scheduleSave(() => usePixGptStore.getState())
  // This runs on every state change — including each streamed token flush — so
  // only touch the DOM when appearance actually changed.
  if (state.settings.theme !== lastTheme) {
    lastTheme = state.settings.theme
    applyTheme(state.settings.theme)
  }
  if (state.settings.chatFontSize !== lastFontSize) {
    lastFontSize = state.settings.chatFontSize
    applyChatFontSize(state.settings.chatFontSize)
  }
})
