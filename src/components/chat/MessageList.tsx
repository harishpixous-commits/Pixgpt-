import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown } from 'lucide-react'
import { usePixGptStore } from '../../lib/store'
import type { ChatMessage } from '../../lib/types'
import { UserMessage } from './UserMessage'
import { AIMessage } from './AIMessage'
import { EmptyState } from './EmptyState'

/** Distance from the bottom that still counts as "following along". */
const FOLLOW_THRESHOLD = 220

/** Stable reference so the scroll effect does not re-run on every render. */
const NO_MESSAGES: ChatMessage[] = []

export function MessageList() {
  const conversations = usePixGptStore((s) => s.conversations)
  const activeId = usePixGptStore((s) => s.activeId)
  const streaming = usePixGptStore((s) => s.streaming)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const conv = conversations.find((c) => c.id === activeId)
  const messages = conv?.messages ?? NO_MESSAGES
  const isStreamingHere = streaming?.convId === activeId

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD)
  }, [])

  useEffect(() => {
    if (messages.length === 0) return
    const el = scrollRef.current
    if (!el) return
    if (!streaming) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    // While streaming, only follow if the user is near the bottom
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages, streaming])

  if (messages.length === 0) return <EmptyState />

  return (
    <div className="chat-region">
      {/*
        The log itself is not a live region: it mutates on every streamed token,
        which would make a screen reader re-announce the response continuously.
        State changes are announced once, below.
      */}
      <div
        ref={scrollRef}
        className="chat-scroll"
        role="log"
        aria-live="off"
        aria-label="Conversation"
        aria-busy={isStreamingHere}
        onScroll={checkAtBottom}
      >
        <div className="chat-scroll-inner">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              >
                {m.role === 'user' ? <UserMessage message={m} /> : <AIMessage convId={conv!.id} message={m} />}
              </motion.div>
            ))}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {isStreamingHere ? 'PixGPT is responding' : 'Response ready'}
      </p>

      <AnimatePresence>
        {!atBottom && (
          <motion.button
            type="button"
            className="scroll-bottom"
            aria-label="Scroll to latest message"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
          >
            <ArrowDown size={17} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
