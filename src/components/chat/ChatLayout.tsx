import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { usePixGptStore } from '../../lib/store'
import { useIsMobile } from '../../lib/hooks'
import { ChatSidebar } from './ChatSidebar'
import { ChatHeader } from './ChatHeader'
import { ConnectionBanner } from './ConnectionBanner'
import { AgentPanel } from './AgentPanel'
import { MessageList } from './MessageList'
import { MessageComposer } from './MessageComposer'
import { SkillsDialog } from '../skills/SkillsDialog'
import { ModelsDialog } from '../models/ModelsDialog'
import { DocumentDialog } from '../documents/DocumentDialog'
import { PdfEditDialog } from '../documents/PdfEditDialog'
import { ImportProjectDialog } from '../documents/ImportProjectDialog'
import { SettingsDialog } from '../settings/SettingsDialog'
import { HelpDialog } from './HelpDialog'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useToast } from '../ui/Toast'

interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  action: () => void
}

export function ChatLayout() {
  const isMobile = useIsMobile()
  const sidebarOpen = usePixGptStore((s) => s.sidebarOpen)
  const toggleSidebar = usePixGptStore((s) => s.toggleSidebar)
  const setSidebarOpen = usePixGptStore((s) => s.setSidebarOpen)
  const deleteConversation = usePixGptStore((s) => s.deleteConversation)
  const clearConversation = usePixGptStore((s) => s.clearConversation)
  const resetAll = usePixGptStore((s) => s.resetAll)
  const activeId = usePixGptStore((s) => s.activeId)
  const conversations = usePixGptStore((s) => s.conversations)
  const setMode = usePixGptStore((s) => s.setMode)
  const runBuild = usePixGptStore((s) => s.runBuild)
  const mode = usePixGptStore((s) => s.mode)
  const setConversationModel = usePixGptStore((s) => s.setConversationModel)
  const updateSettings = usePixGptStore((s) => s.updateSettings)
  const favouriteModels = usePixGptStore((s) => s.settings.favouriteModels)
  const defaultModel = usePixGptStore((s) => s.settings.defaultModel)
  const activeModel = conversations.find((c) => c.id === activeId)?.model ?? defaultModel
  const { push } = useToast()

  /*
   * Recent turns are offered to the document writer as reference material, so
   * "turn this into a report" works without the user pasting anything back.
   * Bounded: a whole long conversation would crowd out the actual instruction.
   */
  const conversationContext = (() => {
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv || conv.messages.length === 0) return undefined
    return conv.messages
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
      .slice(-24_000)
  })()

  /*
   * The last user turn only, for the model picker's "Recommended" group. The
   * whole transcript would let an early message decide the recommendation for a
   * conversation that has since moved on to something else.
   */
  const lastUserText = (() => {
    const conv = conversations.find((c) => c.id === activeId)
    return [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content.slice(0, 400)
  })()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [docOpen, setDocOpen] = useState(false)
  const [pdfOpen, setPdfOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const requestDelete = (id: string) => {
    setConfirm({
      title: 'Delete conversation',
      message: 'This conversation and its messages will be permanently removed.',
      confirmLabel: 'Delete',
      danger: true,
      action: () => {
        deleteConversation(id)
        push({ title: 'Conversation deleted' })
      },
    })
  }

  const requestClear = () => {
    if (!activeId) return
    setConfirm({
      title: 'Clear conversation',
      message: 'All messages in this conversation will be removed. The conversation itself stays.',
      confirmLabel: 'Clear',
      danger: true,
      action: () => {
        clearConversation(activeId)
        push({ title: 'Conversation cleared' })
      },
    })
  }

  const requestLogout = () => {
    setConfirm({
      title: 'Sign out',
      message: 'You will be signed out of PixGPT on this device.',
      confirmLabel: 'Sign out',
      danger: true,
      action: () => push({ title: 'Signed out', description: 'Demo mode — no account session exists yet.' }),
    })
  }

  const requestDeleteAllHistory = () => {
    setConfirm({
      title: 'Delete all conversations',
      message: 'Every conversation stored on this device will be permanently deleted.',
      confirmLabel: 'Delete all',
      danger: true,
      action: () => {
        resetAll()
        push({ title: 'All conversations deleted' })
      },
    })
  }

  // Desktop: Cmd/Ctrl+B toggles the sidebar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  const sidebarContent = (
    <ChatSidebar
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenHelp={() => setHelpOpen(true)}
      onRequestDelete={requestDelete}
      onLogout={requestLogout}
      onOpenProfile={() => setSettingsOpen(true)}
    />
  )

  return (
    <div className="app-shell">
      {isMobile ? (
        <AnimatePresence>
          {sidebarOpen && (
            <>
              <motion.div
                className="drawer-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => setSidebarOpen(false)}
              />
              <motion.aside
                className="sidebar sidebar-drawer"
                initial={{ x: -300 }}
                animate={{ x: 0 }}
                exit={{ x: -300 }}
                transition={{ type: 'spring', stiffness: 380, damping: 36 }}
                aria-label="Conversation sidebar"
              >
                {sidebarContent}
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      ) : (
        <motion.aside
          className="sidebar"
          animate={{ width: sidebarOpen ? 'var(--sidebar-width)' : 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 40 }}
          aria-label="Conversation sidebar"
          aria-hidden={!sidebarOpen}
          // Collapsed to 0px: `inert` keeps its buttons and inputs out of the
          // tab order, which `aria-hidden` alone would not do.
          inert={!sidebarOpen}
        >
          {sidebarContent}
        </motion.aside>
      )}

      {/* <main> so screen-reader users can jump straight to the conversation
          and no content sits outside a landmark. */}
      <main className="main-col" aria-label="Chat">
        <ChatHeader
          onOpenSettings={() => setSettingsOpen(true)}
          onRequestDelete={() => activeId && requestDelete(activeId)}
          onRequestClear={requestClear}
          onCreateDocument={() => setDocOpen(true)}
          onEditPdf={() => setPdfOpen(true)}
          onImportProject={() => setImportOpen(true)}
          onOpenSkills={() => setSkillsOpen(true)}
          onOpenModels={() => setModelsOpen(true)}
        />
        <ConnectionBanner />
        <MessageList />
        <AgentPanel />
        <MessageComposer />
      </main>

      <SkillsDialog open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      <ModelsDialog
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        contextText={lastUserText}
        mode={mode}
        favourites={favouriteModels}
        selectedModel={activeModel}
        onToggleFavourite={(id) =>
          updateSettings({
            // Newest first, so the dropdown shows what you reached for most recently
            favouriteModels: favouriteModels.includes(id)
              ? favouriteModels.filter((m) => m !== id)
              : [id, ...favouriteModels].slice(0, 12),
          })
        }
        /*
         * Picking a model pins it for this conversation, or sets the default
         * when none is open. Without this the picker was browse-only: it listed
         * 116 models and offered no way to choose one.
         */
        onPick={(id) => {
          if (activeId) setConversationModel(activeId, id)
          else updateSettings({ defaultModel: id })
          setModelsOpen(false)
          push({ title: `Switched to ${id}`, description: 'This conversation will use it until you change it.' })
        }}
      />
      <DocumentDialog open={docOpen} onClose={() => setDocOpen(false)} context={conversationContext} />
      <PdfEditDialog open={pdfOpen} onClose={() => setPdfOpen(false)} />
      <ImportProjectDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(taskId, objective) => {
          // Switching to Build mode first means the agent panel is already
          // mounted when the first event arrives.
          setMode('build')
          void runBuild(objective, taskId)
          push({ title: 'Working on the imported project' })
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={requestLogout}
        onDeleteAllHistory={requestDeleteAllHistory}
      />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onConfirm={() => confirm?.action()}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}
