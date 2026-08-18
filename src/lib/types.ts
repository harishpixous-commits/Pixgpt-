export type Theme = 'dark' | 'light' | 'system'

/**
 * The three aliases, or any concrete model id from the catalogue.
 *
 * `(string & {})` keeps editor autocomplete offering the aliases while still
 * accepting `auto/claude-opus`. Pinning a specific model has to be possible —
 * the picker lists 116 of them, and a type that only allowed three made the
 * "Use" button unbuildable.
 */
export type ModelAlias = 'pixgpt-fast' | 'pixgpt-pro' | 'pixgpt-vision'
export type ModelId = ModelAlias | (string & {})

export const MODEL_ALIASES: ModelAlias[] = ['pixgpt-fast', 'pixgpt-pro', 'pixgpt-vision']
export const isModelAlias = (id: string): id is ModelAlias => (MODEL_ALIASES as string[]).includes(id)

export type MessageRole = 'user' | 'assistant'

export type MessageStatus = 'complete' | 'streaming' | 'error'

export type AttachmentStatus = 'uploading' | 'processing' | 'completed' | 'failed'

export interface Attachment {
  id: string
  name: string
  size: number
  kind: 'file' | 'image'
  /** Browser-reported MIME type; the server re-validates it. */
  mime?: string
  status: AttachmentStatus
  /** Upload progress, 0–1, while `status === 'uploading'` */
  progress?: number
  /** Object URL preview for images */
  url?: string
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  status: MessageStatus
  attachments?: Attachment[]
  feedback?: 'like' | 'dislike' | null
  /** User-facing reason this message failed; set when `status === 'error'`. */
  error?: string
  /** Stable error code from the gateway, for UI branching. */
  errorCode?: string
  /** Web-search citations, only present when real sources were retrieved. */
  sources?: Array<{ title: string; url: string }>
  /**
   * The model that actually answered, and whether it was the one asked for.
   *
   * A pinned model can fail and a compatible fallback serve instead. Showing
   * only the pinned name then makes the header a lie — you ask `aug/fable-5`,
   * something else replies, and nothing says so.
   */
  servedBy?: string
  fellBack?: boolean
  /**
   * The model stopped at its output ceiling, so the answer is incomplete.
   *
   * Kept separate from `status: 'error'` — the request itself succeeded, but
   * the response was cut short and the UI should say so and offer to continue.
   */
  truncated?: boolean
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: ModelId
  messages: ChatMessage[]
}

export interface Settings {
  theme: Theme
  /** Base font size in px for chat content (messages + composer). */
  chatFontSize: number
  defaultModel: ModelId
  temperature: number
  autoTitle: boolean
  keepHistory: boolean
  voice: string
  speechRate: number
  autoReadResponses: boolean
  userName: string
  userEmail: string
  /**
   * Models the user has starred, newest first.
   *
   * These appear above the three aliases in the model dropdown, so a model you
   * picked once is one click away instead of four (open menu, browse, filter,
   * find). Held in settings rather than per-conversation because a favourite is
   * a preference about you, not about one chat.
   */
  favouriteModels: string[]
}
