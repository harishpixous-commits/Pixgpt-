import { Dialog } from '../ui/Dialog'
import { isDemoMode } from '../../lib/api'

const SHORTCUTS = [
  { keys: 'Enter', label: 'Send message' },
  { keys: 'Shift + Enter', label: 'New line' },
  { keys: 'Ctrl / ⌘ + K', label: 'Focus composer' },
  { keys: 'Ctrl / ⌘ + B', label: 'Toggle sidebar' },
  { keys: 'Esc', label: 'Close dialog, stop generating, or end recording' },
  { keys: 'Tab', label: 'Navigate controls' },
]

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Help & shortcuts" description="PixGPT keyboard shortcuts" width={460}>
      <div className="help-section">
        <p className="help-label">Keyboard shortcuts</p>
        <ul className="help-shortcuts">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="help-shortcut">
              <kbd className="help-kbd">{s.keys}</kbd>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="help-section">
        <p className="help-label">About</p>
        <p className="help-about">
          PixGPT v0.1.0 — your intelligent AI assistant, built by{' '}
          <strong>Pixous Technologies</strong>.
        </p>
        {isDemoMode ? (
          <p className="help-about help-about-muted">
            Currently running in demo mode. Connect a backend to enable live responses.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
