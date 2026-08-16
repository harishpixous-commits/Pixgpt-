import { ChevronDown, Eraser, PanelLeft, Share2, Trash2, Download, MoreVertical, Settings as SettingsIcon, MessageSquare, Hammer, Bug, ScanEye, Telescope, FileText, FileEdit, FileArchive, Blocks, Boxes, Star } from 'lucide-react'
import { usePixGptStore } from '../../lib/store'
import { useGatewayStatus } from '../../lib/hooks'
import type { GatewayStatus } from '../../lib/api'
import { MODELS } from '../../lib/models'
import { isDemoMode } from '../../lib/api'
import { Dropdown, type MenuItem } from '../ui/Dropdown'
import { IconButton } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { useToast } from '../ui/Toast'
import { cn, copyToClipboard, downloadTextFile, truncate } from '../../lib/utils'

interface ChatHeaderProps {
  onOpenModels: () => void
  onOpenSettings: () => void
  onRequestDelete: () => void
  onRequestClear: () => void
  onCreateDocument: () => void
  onEditPdf: () => void
  onImportProject: () => void
  onOpenSkills: () => void
}

/**
 * Gateway status shown in the header. Deliberately says nothing about URLs,
 * ports, keys or stack traces — only what state the connection is in and, when
 * it is broken, who can fix it.
 */
type GatewayView = { label: string; tone: 'ok' | 'warn' | 'busy'; hint: string }

function gatewayView(status: GatewayStatus | null, name: string): GatewayView {
  if (!status) return { label: 'Connecting', tone: 'busy', hint: `Checking the ${name} connection…` }
  if (status.ok) return { label: 'connected', tone: 'ok', hint: `${name} is connected and ready.` }
  if (status.authenticated === false) {
    return {
      label: 'auth error',
      tone: 'warn',
      hint: `${name} rejected this server’s credentials. Please contact your administrator.`,
    }
  }
  if (status.code === 'server_unavailable') {
    return { label: 'offline', tone: 'warn', hint: 'The PixGPT server is not responding.' }
  }
  if (status.reachable) {
    return { label: 'provider error', tone: 'warn', hint: `${name} is reachable but not serving requests.` }
  }
  return { label: 'offline', tone: 'warn', hint: `${name} is not reachable right now.` }
}

/**
 * The five PixGPT modes. Chat is unchanged — it still runs a normal completion.
 * Build and Debug drive the coding agent; Review and Research shape the prompt.
 */
const MODES = [
  { id: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { id: 'build' as const, label: 'Build', icon: Hammer },
  { id: 'debug' as const, label: 'Debug', icon: Bug },
  { id: 'review' as const, label: 'Review', icon: ScanEye },
  { id: 'research' as const, label: 'Research', icon: Telescope },
]

export function ChatHeader({
  onOpenModels,
  onOpenSettings,
  onRequestDelete,
  onRequestClear,
  onCreateDocument,
  onEditPdf,
  onImportProject,
  onOpenSkills,
}: ChatHeaderProps) {
  const { push } = useToast()
  const gateway = useGatewayStatus()
  const mode = usePixGptStore((s) => s.mode)
  const setMode = usePixGptStore((s) => s.setMode)
  const gatewayName = gateway?.label ?? 'AI gateway'
  const gatewayStatus = gatewayView(gateway, gatewayName)
  const conversations = usePixGptStore((s) => s.conversations)
  const activeId = usePixGptStore((s) => s.activeId)
  const toggleSidebar = usePixGptStore((s) => s.toggleSidebar)
  const setConversationModel = usePixGptStore((s) => s.setConversationModel)
  const updateSettings = usePixGptStore((s) => s.updateSettings)
  const defaultModel = usePixGptStore((s) => s.settings.defaultModel)
  const favouriteModels = usePixGptStore((s) => s.settings.favouriteModels)

  const conv = conversations.find((c) => c.id === activeId)
  // With no conversation open the selector edits the default for the next chat,
  // so the model is always visible and changeable — including on first launch.
  const activeModelId = conv?.model ?? defaultModel
  /*
   * A pinned concrete model has no entry in MODELS — that map only describes
   * the three aliases. Falling back to a derived label keeps the header honest
   * about what is actually selected instead of showing a blank or defaulting
   * back to "PixGPT Pro" while a different model serves the request.
   */
  const model = MODELS[activeModelId as keyof typeof MODELS] ?? {
    label: activeModelId.includes('/') ? activeModelId.split('/').slice(1).join('/') : activeModelId,
    blurb: `Pinned model — ${activeModelId}`,
    icon: Boxes,
  }
  const title = conv ? truncate(conv.title, 50) : 'PixGPT'

  const onShare = async () => {
    const ok = await copyToClipboard(`https://pixgpt.app/chat/${conv?.id ?? 'new'}`)
    push(
      ok
        ? { title: 'Share link copied', description: 'Anyone with the link can open this chat.', tone: 'success' }
        : { title: 'Could not copy link', tone: 'error' },
    )
  }

  const onExport = () => {
    if (!conv) return
    const body = conv.messages
      .map((m) => `## ${m.role === 'user' ? 'You' : 'PixGPT'}\n\n${m.content}`)
      .join('\n\n---\n\n')
    downloadTextFile(`${conv.title.replace(/[^\w\d -]/g, '').trim() || 'conversation'}.md`, `# ${conv.title}\n\n${body}`)
    push({ title: 'Conversation exported', description: 'Downloaded as Markdown.', tone: 'success' })
  }

  /*
   * Three aliases, not a hundred and twenty rows.
   *
   * The aliases are no longer fixed targets: the server ranks the live
   * catalogue per request and each alias resolves to the best healthy, verified
   * route for the task in hand. "Browse all models" opens the full catalogue for
   * anyone who wants to pin something specific.
   */
  const modelItems: MenuItem[] = (Object.keys(MODELS) as (keyof typeof MODELS)[]).map((id) => {
    const m = MODELS[id]
    return {
      label: m.label,
      icon: m.icon,
      checked: activeModelId === id,
      onSelect: () => {
        if (conv) {
          setConversationModel(conv.id, id)
        } else {
          updateSettings({ defaultModel: id })
        }
        push({ title: `Switched to ${m.label}` })
      },
    }
  })

  /*
   * Starred models sit above the aliases.
   *
   * A model you picked once should be one click away, not four (open menu →
   * browse → filter → find). Shown first because that is the order people
   * reach for them in; the aliases stay below as the default path.
   */
  if (favouriteModels.length > 0) {
    modelItems.unshift(
      ...favouriteModels.slice(0, 8).map((id) => ({
        label: id.includes('/') ? id.split('/').slice(1).join('/') : id,
        icon: Star,
        checked: activeModelId === id,
        onSelect: () => {
          if (conv) setConversationModel(conv.id, id)
          else updateSettings({ defaultModel: id })
          push({ title: `Switched to ${id}` })
        },
      })),
      { separator: true },
    )
  }

  modelItems.push({ label: 'Browse all models…', icon: Boxes, onSelect: onOpenModels })

  const moreItems: MenuItem[] = [
    { label: 'Skills', icon: Blocks, onSelect: onOpenSkills },
    { label: 'Models', icon: Boxes, onSelect: onOpenModels },
    { label: 'Create a document', icon: FileText, onSelect: onCreateDocument },
    { label: 'Edit a PDF', icon: FileEdit, onSelect: onEditPdf },
    { label: 'Import a project', icon: FileArchive, onSelect: onImportProject },
    { label: 'Settings', icon: SettingsIcon, onSelect: onOpenSettings },
    { label: 'Export conversation', icon: Download, onSelect: onExport, disabled: !conv || conv.messages.length === 0 },
    { label: 'Clear conversation', icon: Eraser, onSelect: onRequestClear, disabled: !conv || conv.messages.length === 0 },
    { label: 'Delete conversation', icon: Trash2, danger: true, onSelect: onRequestDelete, disabled: !conv },
  ]

  return (
    <header className="chat-header">
      <div className="chat-header-left">
        <Tooltip label="Toggle sidebar">
          <IconButton aria-label="Toggle sidebar" onClick={toggleSidebar}>
            <PanelLeft size={18} />
          </IconButton>
        </Tooltip>
        <h1 className="chat-header-title" title={conv?.title ?? 'PixGPT'}>
          {title}
        </h1>
        {isDemoMode ? (
          <Tooltip label="Demo mode — no gateway is being used">
            <span className="demo-badge">Demo</span>
          </Tooltip>
        ) : (
          <Tooltip label={gatewayStatus.hint}>
            <span
              className={cn(
                'gw-badge',
                gatewayStatus.tone === 'ok' && 'gw-badge-ok',
                gatewayStatus.tone === 'warn' && 'gw-badge-warn',
                gatewayStatus.tone === 'busy' && 'gw-badge-busy',
              )}
              role="status"
            >
              <span className="gw-dot" aria-hidden="true" />
              <span className="gw-badge-text">
                {gatewayName} {gatewayStatus.label}
              </span>
            </span>
          </Tooltip>
        )}
      </div>

      <div className="chat-header-right">
        <Dropdown
          ariaLabel="Select mode"
          className="mode-select-wrap"
          menuClassName="model-menu"
          items={MODES.map((m) => ({
            label: m.label,
            icon: m.icon,
            checked: mode === m.id,
            onSelect: () => setMode(m.id),
          }))}
          trigger={({ open, toggle, ref }) => {
            const active = MODES.find((m) => m.id === mode) ?? MODES[0]
            return (
              <button
                ref={ref}
                type="button"
                className={cn('model-select', mode !== 'chat' && 'model-select-accent')}
                aria-label={`Mode: ${active.label}. Change mode`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                <active.icon size={15} />
                <span className="model-select-label">{active.label}</span>
                <ChevronDown size={14} className={open ? 'chev-open' : ''} />
              </button>
            )
          }}
        />
        <Dropdown
          ariaLabel="Select model"
          className="model-select-wrap"
          menuClassName="model-menu"
          trigger={({ open, toggle, ref }) => (
            <button
              ref={ref}
              type="button"
              className="model-select"
              // The label is hidden under 420px, so the accessible name has to
              // come from aria-label or the button becomes unnamed on phones.
              aria-label={`Model: ${model.label}. Change model`}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            >
              <model.icon size={15} />
              <span className="model-select-label">{model.label}</span>
              <ChevronDown size={14} className={open ? 'chev-open' : ''} />
            </button>
          )}
          items={modelItems}
        />
        {conv ? (
          <Tooltip label="Share">
            <IconButton aria-label="Share conversation" onClick={onShare}>
              <Share2 size={17} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Dropdown
          ariaLabel="More options"
          trigger={({ open, toggle, ref }) => (
            <IconButton ref={ref} aria-label="More options" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <MoreVertical size={17} />
            </IconButton>
          )}
          items={moreItems}
        />
      </div>
    </header>
  )
}
