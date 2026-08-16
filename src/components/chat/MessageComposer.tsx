import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Globe, ImagePlus, Paperclip, Send, Square } from 'lucide-react'
import { usePixGptStore } from '../../lib/store'
import { useModelSupportsVision, useWebSearchAvailable } from '../../lib/hooks'
import { chatApi } from '../../lib/api'
import type { Attachment } from '../../lib/types'
import { cn, uid } from '../../lib/utils'
import { AttachmentPreview } from './AttachmentPreview'
import { VoiceInput } from './VoiceInput'
import { useToast } from '../ui/toast-context'
import { Tooltip } from '../ui/Tooltip'

const MAX_FILES_PER_SEND = 5

/**
 * The composer asks for different things in different modes. Build and Debug
 * take an objective for the agent, not a chat message, and saying so is the
 * difference between the mode being discoverable and being invisible.
 */
const PLACEHOLDERS: Record<string, string> = {
  chat: 'Ask PixGPT anything…',
  build: 'Describe what to build — PixGPT will write it, run it and check it',
  debug: 'Describe what is broken — PixGPT will reproduce it and fix it',
  review: 'Paste code or describe what to review…',
  research: 'What should PixGPT research?',
}

const ARIA_LABELS: Record<string, string> = {
  chat: 'Message PixGPT',
  build: 'Describe what to build',
  debug: 'Describe what to debug',
  review: 'Describe what to review',
  research: 'Describe what to research',
}

function newComposerAttachment(file: File): Attachment {
  const isImage = file.type.startsWith('image/')
  return {
    id: uid(),
    name: file.name,
    size: file.size,
    kind: isImage ? 'image' : 'file',
    mime: file.type,
    status: 'uploading',
    progress: 0,
    // Documents need an object URL too — their bytes are read back at request
    // time so the server can extract text from them.
    url: URL.createObjectURL(file),
  }
}

export function MessageComposer() {
  const { push } = useToast()
  const sendMessage = usePixGptStore((s) => s.sendMessage)
  const mode = usePixGptStore((s) => s.mode)
  const runBuild = usePixGptStore((s) => s.runBuild)
  const agentRunning = usePixGptStore((s) => s.agent.status === 'running')
  const stopStreaming = usePixGptStore((s) => s.stopStreaming)
  const streaming = usePixGptStore((s) => s.streaming)
  const activeId = usePixGptStore((s) => s.activeId)
  const composerFocusTick = usePixGptStore((s) => s.composerFocusTick)

  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileMapRef = useRef(new Map<string, File>())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)

  const isStreamingHere = streaming?.convId === activeId

  // Vision gating: an attached image must never be silently dropped, so the
  // composer checks the *selected model's* capability before sending.
  const activeModel = usePixGptStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.model ?? s.settings.defaultModel,
  )
  const visionSupported = useModelSupportsVision(activeModel)
  const webEnabled = usePixGptStore((s) => s.webEnabled)
  const toggleWeb = usePixGptStore((s) => s.toggleWeb)
  const webAvailable = useWebSearchAvailable()
  const hasImages = attachments.some((a) => a.kind === 'image')
  const imagesBlocked = hasImages && !visionSupported

  useEffect(() => {
    if (composerFocusTick > 0) textareaRef.current?.focus()
  }, [composerFocusTick])

  // Auto-grow the textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  // Global shortcuts: Cmd/Ctrl+K focuses the composer, Esc halts generation.
  // Open dialogs stop Escape in the capture phase, so they take priority.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        textareaRef.current?.focus()
        return
      }
      if (e.key === 'Escape' && isStreamingHere) {
        e.preventDefault()
        stopStreaming()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isStreamingHere, stopStreaming])

  const canSend =
    (text.trim().length > 0 || attachments.some((a) => a.status === 'completed')) &&
    !isStreamingHere &&
    !agentRunning

  /*
   * Build and Debug drive the coding agent, which takes only an objective —
   * attachments are never sent. Offering the buttons anyway would let a user
   * attach files that then vanish silently on send, so they are not shown.
   */
  const canAttach = mode !== 'build' && mode !== 'debug'

  /** Uploads one already-registered attachment; reused by retry. */
  const runUpload = useCallback(
    async (id: string, name: string) => {
      const controller = new AbortController()
      try {
        const file = fileMapRef.current.get(id)
        await chatApi.uploadAttachment(file ?? new File([], name), controller.signal, (fraction) => {
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, progress: fraction } : a)))
        })
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: 'processing', progress: 1 } : a)),
        )
        // Demo boundary: brief processing pass, then complete
        setTimeout(() => {
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'completed' } : a)))
        }, 700)
      } catch {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'failed' } : a)))
        push({ title: 'Unable to process this file', description: name, tone: 'error' })
      }
    },
    [push],
  )

  const upload = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return
      const all = Array.from(files)
      const accepted = all.slice(0, MAX_FILES_PER_SEND)
      if (all.length > accepted.length) {
        push({
          title: `Only ${MAX_FILES_PER_SEND} files at a time`,
          description: `${all.length - accepted.length} file(s) were not attached.`,
          tone: 'error',
        })
      }
      const items = accepted.map((f) => {
        const a = newComposerAttachment(f)
        fileMapRef.current.set(a.id, f)
        return a
      })
      setAttachments((prev) => [...prev, ...items])
      for (const item of items) await runUpload(item.id, item.name)
    },
    [push, runUpload],
  )

  const retryUpload = useCallback(
    (id: string, name: string) => {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: 'uploading', progress: 0 } : a)),
      )
      void runUpload(id, name)
    },
    [runUpload],
  )

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target?.url) URL.revokeObjectURL(target.url)
      fileMapRef.current.delete(id)
      return prev.filter((a) => a.id !== id)
    })
  }

  const send = async () => {
    if (!canSend) return

    // Build / Debug drive the coding agent instead of a chat completion.
    if (mode === 'build' || mode === 'debug') {
      const objective = text.trim()
      if (!objective) return
      setText('')
      await runBuild(objective)
      return
    }
    if (imagesBlocked) {
      push({
        title: 'This model does not support image input',
        description: 'Please select a vision-capable model, or remove the image.',
        tone: 'error',
      })
      return
    }
    // Ownership of each preview URL transfers to the message — revoking here
    // would leave the sent message rendering a dead blob: URL.
    const ready = attachments.filter((a) => a.status !== 'failed')
    ready.forEach((a) => fileMapRef.current.delete(a.id))
    setAttachments([])
    setText('')
    await sendMessage(text, ready)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // Drag-and-drop. `dragDepth` survives dragleave events fired by child nodes.
  const dragDepth = useRef(0)

  const onDragEnter = (e: React.DragEvent) => {
    if (!canAttach || !e.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const onDrop = (e: React.DragEvent) => {
    if (!canAttach || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void upload(e.dataTransfer.files)
  }

  return (
    <div
      className="composer-zone"
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (canAttach && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={cn('composer', dragging && 'composer-dragging')}>
        <AnimatePresence>
          {dragging && (
            <motion.div
              className="composer-drop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
            >
              <Paperclip size={16} />
              Drop files to attach
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {imagesBlocked && (
            <motion.p
              className="composer-notice"
              role="status"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              <AlertTriangle size={14} />
              This model does not support image input. Select a vision-capable model to send it.
            </motion.p>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {attachments.length > 0 && (
            <motion.div className="composer-attachments" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <AnimatePresence>
                {attachments.map((a) => (
                  <AttachmentPreview
                    key={a.id}
                    attachment={a}
                    onRemove={() => removeAttachment(a.id)}
                    onRetry={a.status === 'failed' ? () => retryUpload(a.id, a.name) : undefined}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={PLACEHOLDERS[mode] ?? PLACEHOLDERS.chat}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          // The accessible name follows the mode too, so a screen-reader user
          // knows Build takes an objective rather than a message.
          aria-label={ARIA_LABELS[mode] ?? ARIA_LABELS.chat}
        />

        <div className="composer-tools">
          <div className="composer-tools-left">
            {canAttach && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    void upload(e.target.files)
                    e.target.value = ''
                  }}
                />
                <input
                  ref={imageRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    void upload(e.target.files)
                    e.target.value = ''
                  }}
                />
                <Tooltip label="Attach file">
                  <button type="button" className="composer-tool" aria-label="Attach file" onClick={() => fileRef.current?.click()}>
                    <Paperclip size={17} />
                  </button>
                </Tooltip>
                <Tooltip label="Upload image">
                  <button type="button" className="composer-tool" aria-label="Upload image" onClick={() => imageRef.current?.click()}>
                    <ImagePlus size={17} />
                  </button>
                </Tooltip>
              </>
            )}
            {webAvailable ? (
            <Tooltip label={webEnabled ? 'Web search on — answers use live results' : 'Search the web for current information'}>
              <button
                type="button"
                className={cn('composer-tool', webEnabled && 'composer-tool-active')}
                aria-label="Search the web"
                aria-pressed={webEnabled}
                onClick={toggleWeb}
              >
                <Globe size={16} />
              </button>
            </Tooltip>
          ) : null}

          <VoiceInput onTranscript={(t) => setText((prev) => (prev ? `${prev} ${t}` : t))} />
          </div>

          <div className="composer-tools-right">
            {isStreamingHere ? (
              <motion.button
                key="stop"
                type="button"
                className="composer-send composer-stop"
                aria-label="Stop generating"
                onClick={stopStreaming}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                whileTap={{ scale: 0.92 }}
              >
                <Square size={16} fill="currentColor" />
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="button"
                className="composer-send"
                aria-label="Send message"
                disabled={!canSend}
                onClick={() => void send()}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                whileTap={{ scale: 0.92 }}
              >
                <Send size={16} />
              </motion.button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-hint">
        PixGPT can make mistakes. Check important information.
        {isStreamingHere ? <span className="composer-hint-stop"> Press stop or Esc to halt.</span> : null}
      </p>
    </div>
  )
}
