import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { MessageSquare, Pencil, Trash2 } from 'lucide-react'
import type { Conversation } from '../../lib/types'
import { usePixGptStore } from '../../lib/store'
import { cn, truncate } from '../../lib/utils'
import { Dropdown } from '../ui/Dropdown'
import { useToast } from '../ui/Toast'

interface ConversationItemProps {
  conversation: Conversation
  onRequestDelete: (id: string) => void
}

export function ConversationItem({ conversation, onRequestDelete }: ConversationItemProps) {
  const activeId = usePixGptStore((s) => s.activeId)
  const openConversation = usePixGptStore((s) => s.openConversation)
  const renameConversation = usePixGptStore((s) => s.renameConversation)
  const { push } = useToast()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conversation.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const isActive = activeId === conversation.id

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitRename = () => {
    renameConversation(conversation.id, draft)
    setEditing(false)
    push({ title: 'Chat renamed' })
  }

  if (editing) {
    return (
      <div className="conv-item conv-item-editing" role="listitem">
        <input
          ref={inputRef}
          className="conv-rename-input"
          value={draft}
          aria-label="Conversation title"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              setDraft(conversation.title)
              setEditing(false)
            }
          }}
          onBlur={commitRename}
        />
      </div>
    )
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className={cn('conv-item', isActive && 'conv-item-active')}
      role="listitem"
    >
      <button
        type="button"
        className="conv-item-main"
        onClick={() => openConversation(conversation.id)}
        aria-current={isActive ? 'true' : undefined}
        title={conversation.title}
      >
        <MessageSquare size={15} className="conv-item-icon" aria-hidden="true" />
        <span className="conv-item-title">{truncate(conversation.title, 40)}</span>
      </button>
      <Dropdown
        align="right"
        ariaLabel="Conversation actions"
        className="conv-item-more"
        trigger={({ open, toggle, ref }) => (
          <button
            ref={ref}
            type="button"
            className={cn('conv-item-more-btn', open && 'conv-item-more-open')}
            aria-label={`Actions for ${conversation.title}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <span className="conv-dots" aria-hidden="true" />
          </button>
        )}
        items={[
          {
            label: 'Rename',
            icon: Pencil,
            onSelect: () => {
              setDraft(conversation.title)
              setEditing(true)
            },
          },
          {
            label: 'Delete',
            icon: Trash2,
            danger: true,
            onSelect: () => onRequestDelete(conversation.id),
          },
        ]}
      />
    </motion.div>
  )
}
