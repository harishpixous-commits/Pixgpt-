import { Plus, LogOut, Search, Settings, HelpCircle, ChevronRight } from 'lucide-react'
import { usePixGptStore } from '../../lib/store'
import { useIsMobile } from '../../lib/hooks'
import { Avatar } from '../ui/Avatar'
import { PixMark } from '../ui/PixMark'
import { Tooltip } from '../ui/Tooltip'
import { ConversationList } from './ConversationList'

interface ChatSidebarProps {
  onOpenSettings: () => void
  onOpenHelp: () => void
  onRequestDelete: (id: string) => void
  onLogout: () => void
  onOpenProfile: () => void
}

export function ChatSidebar({ onOpenSettings, onOpenHelp, onRequestDelete, onLogout, onOpenProfile }: ChatSidebarProps) {
  const newConversation = usePixGptStore((s) => s.newConversation)
  const setSidebarOpen = usePixGptStore((s) => s.setSidebarOpen)
  const searchQuery = usePixGptStore((s) => s.searchQuery)
  const setSearchQuery = usePixGptStore((s) => s.setSearchQuery)
  const settings = usePixGptStore((s) => s.settings)
  const isMobile = useIsMobile()

  return (
    <div className="sidebar-inner">
      <div className="sb-head">
        <div className="sb-brand">
          <span className="sb-logo">
            <PixMark size={22} />
          </span>
          <div className="sb-brand-text">
            <span className="sb-name">PixGPT</span>
            <span className="sb-sub">Pixous Technologies</span>
          </div>
        </div>
      </div>

      <div className="sb-body">
        <button
          type="button"
          className="sb-new"
          onClick={() => {
            newConversation()
            // Close the drawer on mobile so the composer is reachable
            if (isMobile) setSidebarOpen(false)
          }}
        >
          <Plus size={16} />
          New chat
        </button>

        <div className="sb-search">
          <Search size={15} className="sb-search-icon" aria-hidden="true" />
          <input
            type="search"
            className="sb-search-input"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="sb-list">
          <ConversationList onRequestDelete={onRequestDelete} />
        </div>
      </div>

      <div className="sb-foot">
        <div className="sb-foot-actions">
          <Tooltip label="Settings">
            <button type="button" className="sb-foot-btn" aria-label="Settings" onClick={onOpenSettings}>
              <Settings size={17} />
            </button>
          </Tooltip>
          <Tooltip label="Help & shortcuts">
            <button type="button" className="sb-foot-btn" aria-label="Help and shortcuts" onClick={onOpenHelp}>
              <HelpCircle size={17} />
            </button>
          </Tooltip>
          <Tooltip label="Sign out">
            <button type="button" className="sb-foot-btn" aria-label="Sign out" onClick={onLogout}>
              <LogOut size={17} />
            </button>
          </Tooltip>
        </div>
        <button type="button" className="sb-profile" onClick={onOpenProfile}>
          <Avatar name={settings.userName || 'PixGPT'} size="sm" />
          <span className="sb-profile-text">
            <span className="sb-profile-name">{settings.userName || 'Your name'}</span>
            <span className="sb-profile-email">{settings.userEmail || 'Add account email'}</span>
          </span>
          <ChevronRight size={15} className="sb-profile-chevron" />
        </button>
      </div>
    </div>
  )
}
