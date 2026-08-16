import { useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { SearchX } from 'lucide-react'
import { usePixGptStore } from '../../lib/store'
import { conversationGroupKey, GROUP_LABELS, GROUP_ORDER, type ConversationGroupKey } from '../../lib/utils'
import { ConversationItem } from './ConversationItem'

interface ConversationListProps {
  onRequestDelete: (id: string) => void
}

export function ConversationList({ onRequestDelete }: ConversationListProps) {
  const conversations = usePixGptStore((s) => s.conversations)
  const searchQuery = usePixGptStore((s) => s.searchQuery)

  const groups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const filtered = conversations.filter((c) => !query || c.title.toLowerCase().includes(query))
    const sorted = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt)
    const grouped = new Map<ConversationGroupKey, typeof sorted>()
    for (const conv of sorted) {
      const key = conversationGroupKey(conv.updatedAt)
      const list = grouped.get(key) ?? []
      list.push(conv)
      grouped.set(key, list)
    }
    return GROUP_ORDER.filter((k) => (grouped.get(k)?.length ?? 0) > 0).map((k) => ({
      key: k,
      items: grouped.get(k)!,
    }))
  }, [conversations, searchQuery])

  if (groups.length === 0) {
    return (
      <div className="conv-empty">
        <SearchX size={20} />
        <p>{searchQuery ? 'No matching conversations' : 'No conversations yet'}</p>
      </div>
    )
  }

  return (
    <div className="conv-groups" role="list" aria-label="Conversations">
      {groups.map((group) => (
        <div key={group.key} className="conv-group">
          <p className="conv-group-label">{GROUP_LABELS[group.key]}</p>
          <AnimatePresence initial={false}>
            {group.items.map((conv) => (
              <ConversationItem key={conv.id} conversation={conv} onRequestDelete={onRequestDelete} />
            ))}
          </AnimatePresence>
        </div>
      ))}
    </div>
  )
}
