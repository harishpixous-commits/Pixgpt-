import { motion } from 'framer-motion'
import { Check, Copy, MoreHorizontal, RotateCcw, ThumbsDown, ThumbsUp, Type, Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import type { ChatMessage } from '../../lib/types'
import { copyToClipboard, cn } from '../../lib/utils'
import { usePixGptStore } from '../../lib/store'
import { speak, speechSupported, stopSpeaking, toPlainText, useSpeakingKey } from '../../lib/speech'
import { useToast } from '../ui/toast-context'
import { Tooltip } from '../ui/Tooltip'
import { Dropdown, type MenuItem } from '../ui/Dropdown'

interface MessageActionsProps {
  convId: string
  message: ChatMessage
}

export function MessageActions({ convId, message }: MessageActionsProps) {
  const { push } = useToast()
  const setFeedback = usePixGptStore((s) => s.setFeedback)
  const regenerateFrom = usePixGptStore((s) => s.regenerateFrom)
  const streaming = usePixGptStore((s) => s.streaming)
  const settings = usePixGptStore((s) => s.settings)
  // Regenerating replaces everything after the message, so it is only offered on
  // the final turn — otherwise it would silently discard later messages.
  const isLastMessage = usePixGptStore(
    (s) => s.conversations.find((c) => c.id === convId)?.messages.at(-1)?.id === message.id,
  )
  const speakingKey = useSpeakingKey()
  const [copied, setCopied] = useState(false)

  const isBusy = streaming?.convId === convId
  const isSpeaking = speakingKey === message.id

  const onCopy = async () => {
    const ok = await copyToClipboard(message.content)
    if (ok) {
      setCopied(true)
      push({ title: 'Copied to clipboard', tone: 'success' })
      setTimeout(() => setCopied(false), 1600)
    } else {
      push({ title: 'Could not copy', tone: 'error' })
    }
  }

  const onFeedback = (value: 'like' | 'dislike') => {
    setFeedback(convId, message.id, message.feedback === value ? null : value)
    push({ title: 'Thanks for your feedback' })
  }

  const onRegenerate = () => {
    regenerateFrom(convId, message.id)
  }

  const onCopyPlain = async () => {
    const ok = await copyToClipboard(toPlainText(message.content))
    push(
      ok
        ? { title: 'Copied without formatting', tone: 'success' }
        : { title: 'Could not copy', tone: 'error' },
    )
  }

  const moreItems: MenuItem[] = [
    ...(speechSupported
      ? [
          {
            label: isSpeaking ? 'Stop reading' : 'Read aloud',
            icon: isSpeaking ? VolumeX : Volume2,
            onSelect: () =>
              isSpeaking
                ? stopSpeaking()
                : speak(message.id, message.content, {
                    voiceURI: settings.voice,
                    rate: settings.speechRate,
                  }),
          },
        ]
      : []),
    { label: 'Copy without formatting', icon: Type, onSelect: () => void onCopyPlain() },
  ]

  const item = (label: string, children: React.ReactNode, extraClass?: string) => (
    <Tooltip label={label}>
      <span className={cn('msg-action', extraClass)}>{children}</span>
    </Tooltip>
  )

  return (
    <motion.div
      className="msg-actions"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.25, duration: 0.2 }}
    >
      {item('Copy message', (
        <button type="button" className="msg-action-btn" aria-label="Copy message" onClick={onCopy}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      ), copied ? 'msg-action-active' : undefined)}

      {item('Good response', (
        <button
          type="button"
          className={cn('msg-action-btn', message.feedback === 'like' && 'msg-action-active')}
          aria-label="Like response"
          aria-pressed={message.feedback === 'like'}
          onClick={() => onFeedback('like')}
        >
          <ThumbsUp size={15} />
        </button>
      ), message.feedback === 'like' ? 'msg-action-active' : undefined)}

      {item('Bad response', (
        <button
          type="button"
          className={cn('msg-action-btn', message.feedback === 'dislike' && 'msg-action-active')}
          aria-label="Dislike response"
          aria-pressed={message.feedback === 'dislike'}
          onClick={() => onFeedback('dislike')}
        >
          <ThumbsDown size={15} />
        </button>
      ), message.feedback === 'dislike' ? 'msg-action-active' : undefined)}

      {isLastMessage
        ? item('Regenerate', (
            <button
              type="button"
              className="msg-action-btn"
              aria-label="Regenerate response"
              disabled={isBusy || message.status === 'streaming'}
              onClick={onRegenerate}
            >
              <RotateCcw size={15} />
            </button>
          ))
        : null}

      {isSpeaking ? (
        <Tooltip label="Stop reading">
          <span className="msg-action">
            <button
              type="button"
              className="msg-action-btn msg-action-active"
              aria-label="Stop reading aloud"
              onClick={stopSpeaking}
            >
              <VolumeX size={15} />
            </button>
          </span>
        </Tooltip>
      ) : null}

      <Dropdown
        ariaLabel="More message actions"
        className="msg-action"
        items={moreItems}
        trigger={({ open, toggle, ref }) => (
          <button
            ref={ref}
            type="button"
            className={cn('msg-action-btn', open && 'msg-more-open')}
            aria-label="More message actions"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
      />
    </motion.div>
  )
}
