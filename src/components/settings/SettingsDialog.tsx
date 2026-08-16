import { useState } from 'react'
import {
  AudioLines,
  Bot,
  Gauge,
  MessageSquare,
  Trash2,
  KeyRound,
  LogOut,
  User,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { usePixGptStore } from '../../lib/store'
import { MODELS, MODEL_IDS } from '../../lib/models'
import { speak, speechSupported, stopSpeaking, useSpeakingKey, useVoices } from '../../lib/speech'
import { useToast } from '../ui/toast-context'
import { cn } from '../../lib/utils'

type TabId = 'general' | 'ai' | 'chat' | 'voice' | 'account'

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: Gauge },
  { id: 'ai', label: 'AI', icon: Bot },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'voice', label: 'Voice', icon: AudioLines },
  { id: 'account', label: 'Account', icon: User },
]

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const

/** Identifies the settings-screen voice preview in the speech module. */
const VOICE_PREVIEW_KEY = 'settings-voice-preview'

const TEXT_SIZES = [
  { value: 14, label: 'Small' },
  { value: 15, label: 'Default' },
  { value: 17, label: 'Large' },
] as const

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  initialTab?: TabId
  onLogout: () => void
  onDeleteAllHistory: () => void
}

export function SettingsDialog({ open, onClose, initialTab = 'general', onLogout, onDeleteAllHistory }: SettingsDialogProps) {
  const { push } = useToast()
  const settings = usePixGptStore((s) => s.settings)
  const updateSettings = usePixGptStore((s) => s.updateSettings)
  const [tab, setTab] = useState<TabId>(initialTab)

  const voices = useVoices()
  const speakingKey = useSpeakingKey()
  const speaking = speakingKey === VOICE_PREVIEW_KEY
  // A voice stored on another device (or a stale build) may not exist here —
  // fall back to the system default rather than showing an empty select.
  const selectedVoice = voices.some((v) => v.voiceURI === settings.voice) ? settings.voice : ''

  return (
    <Dialog open={open} onClose={onClose} title="Settings" description="Manage your PixGPT preferences" width={760} className="settings-dialog">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                className={cn('settings-tab', tab === t.id && 'settings-tab-active')}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <Icon size={16} />
                {t.label}
              </button>
            )
          })}
        </nav>

        <div className="settings-content">
          {tab === 'general' && (
            <div className="settings-section" role="tabpanel">
              <h3 className="settings-section-title">Appearance</h3>
              <div className="settings-field">
                <div className="settings-field-head">
                  <span className="settings-field-label">Theme</span>
                  <span className="settings-field-hint">Matches your system when set to System</span>
                </div>
                <div className="segmented" role="radiogroup" aria-label="Theme">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={settings.theme === opt.value}
                      className={cn('segmented-opt', settings.theme === opt.value && 'segmented-opt-active')}
                      onClick={() => updateSettings({ theme: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-head">
                  <span className="settings-field-label">Text size</span>
                  <span className="settings-field-hint">Applies to messages and the composer</span>
                </div>
                <div className="segmented" role="radiogroup" aria-label="Text size">
                  {TEXT_SIZES.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={settings.chatFontSize === opt.value}
                      className={cn('segmented-opt', settings.chatFontSize === opt.value && 'segmented-opt-active')}
                      onClick={() => updateSettings({ chatFontSize: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <label className="settings-field-label" htmlFor="setting-language">
                  Language
                </label>
                <select
                  id="setting-language"
                  className="field-select"
                  value="en"
                  onChange={() => push({ title: 'Localization is coming soon' })}
                >
                  <option value="en">English</option>
                  <option value="ta" disabled>
                    தமிழ் — coming soon
                  </option>
                  <option value="hi" disabled>
                    हिन्दी — coming soon
                  </option>
                </select>
              </div>
            </div>
          )}

          {tab === 'ai' && (
            <div className="settings-section" role="tabpanel">
              <h3 className="settings-section-title">Model & responses</h3>
              <div className="settings-field">
                <label className="settings-field-label" htmlFor="setting-model">
                  Default model
                </label>
                <select
                  id="setting-model"
                  className="field-select"
                  value={settings.defaultModel}
                  onChange={(e) => updateSettings({ defaultModel: e.target.value as (typeof MODEL_IDS)[number] })}
                >
                  {MODEL_IDS.map((id) => (
                    <option key={id} value={id}>
                      {MODELS[id].label} — {MODELS[id].blurb}
                    </option>
                  ))}
                </select>
              </div>

              <div className="settings-field">
                <div className="settings-field-head">
                  <label className="settings-field-label" htmlFor="setting-temp">
                    Temperature
                  </label>
                  <span className="settings-value">{settings.temperature.toFixed(2)}</span>
                </div>
                <input
                  id="setting-temp"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => updateSettings({ temperature: Number(e.target.value) })}
                  className="range"
                />
                <span className="settings-field-hint">Lower is more focused; higher is more creative.</span>
              </div>
            </div>
          )}

          {tab === 'chat' && (
            <div className="settings-section" role="tabpanel">
              <h3 className="settings-section-title">Conversation</h3>
              <div className="settings-field settings-row">
                <div>
                  <span className="settings-field-label">Auto-title chats</span>
                  <p className="settings-field-hint">Name new chats from the first message.</p>
                </div>
                <Switch checked={settings.autoTitle} onChange={(v) => updateSettings({ autoTitle: v })} label="Auto-title chats" />
              </div>
              <div className="settings-field settings-row">
                <div>
                  <span className="settings-field-label">Keep conversation history</span>
                  <p className="settings-field-hint">Save chats on this device between sessions.</p>
                </div>
                <Switch checked={settings.keepHistory} onChange={(v) => updateSettings({ keepHistory: v })} label="Keep conversation history" />
              </div>
              <div className="settings-field">
                <Button variant="danger" onClick={onDeleteAllHistory} disabled={settings.keepHistory === false}>
                  <Trash2 size={15} />
                  Delete all conversations
                </Button>
              </div>
            </div>
          )}

          {tab === 'voice' && (
            <div className="settings-section" role="tabpanel">
              <h3 className="settings-section-title">Voice</h3>
              {!speechSupported ? (
                <p className="settings-field-hint">
                  This browser does not provide speech synthesis, so read-aloud is unavailable.
                </p>
              ) : (
                <>
                  <div className="settings-field">
                    <label className="settings-field-label" htmlFor="setting-voice">
                      Voice
                    </label>
                    <select
                      id="setting-voice"
                      className="field-select"
                      value={selectedVoice}
                      onChange={(e) => updateSettings({ voice: e.target.value })}
                    >
                      <option value="">System default</option>
                      {voices.map((v) => (
                        <option key={v.voiceURI} value={v.voiceURI}>
                          {v.name} — {v.lang}
                        </option>
                      ))}
                    </select>
                    <span className="settings-field-hint">
                      {voices.length > 0
                        ? `${voices.length} voice${voices.length === 1 ? '' : 's'} available on this device.`
                        : 'Loading the voices installed on this device…'}
                    </span>
                  </div>
                  <div className="settings-field">
                    <div className="settings-field-head">
                      <label className="settings-field-label" htmlFor="setting-rate">
                        Speech speed
                      </label>
                      <span className="settings-value">{settings.speechRate.toFixed(1)}×</span>
                    </div>
                    <input
                      id="setting-rate"
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.1}
                      value={settings.speechRate}
                      onChange={(e) => updateSettings({ speechRate: Number(e.target.value) })}
                      className="range"
                    />
                  </div>
                  <div className="settings-field settings-row">
                    <div>
                      <span className="settings-field-label">Auto-read responses</span>
                      <p className="settings-field-hint">Speak responses aloud as they finish.</p>
                    </div>
                    <Switch checked={settings.autoReadResponses} onChange={(v) => updateSettings({ autoReadResponses: v })} label="Auto-read responses" />
                  </div>
                  <div className="settings-field">
                    <Button
                      variant="outline"
                      onClick={() =>
                        speaking
                          ? stopSpeaking()
                          : speak(VOICE_PREVIEW_KEY, 'PixGPT — your intelligent AI assistant.', {
                              voiceURI: selectedVoice,
                              rate: settings.speechRate,
                            })
                      }
                    >
                      {speaking ? <VolumeX size={15} /> : <Volume2 size={15} />}
                      {speaking ? 'Stop' : 'Preview voice'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'account' && (
            <div className="settings-section" role="tabpanel">
              <h3 className="settings-section-title">Profile</h3>
              <div className="settings-field">
                <label className="settings-field-label" htmlFor="setting-name">
                  Display name
                </label>
                <input
                  id="setting-name"
                  className="field-input"
                  value={settings.userName}
                  placeholder="Your name"
                  onChange={(e) => updateSettings({ userName: e.target.value })}
                  onBlur={() => push({ title: 'Profile updated', tone: 'success' })}
                />
              </div>
              <div className="settings-field">
                <label className="settings-field-label" htmlFor="setting-email">
                  Email
                </label>
                <input
                  id="setting-email"
                  type="email"
                  className="field-input"
                  value={settings.userEmail}
                  placeholder="you@company.com"
                  onChange={(e) => updateSettings({ userEmail: e.target.value })}
                  onBlur={() => push({ title: 'Profile updated', tone: 'success' })}
                />
              </div>

              <h3 className="settings-section-title settings-section-title-second">Security</h3>
              <div className="settings-field settings-row">
                <div>
                  <span className="settings-field-label">Password</span>
                  <p className="settings-field-hint">Change or reset your account password.</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => push({ title: 'Password reset email sent', description: 'Demo mode — no email was actually sent.' })}
                >
                  <KeyRound size={15} />
                  Change password
                </Button>
              </div>

              <h3 className="settings-section-title settings-section-title-second">Session</h3>
              <div className="settings-field settings-row">
                <div>
                  <span className="settings-field-label">Sign out</span>
                  <p className="settings-field-hint">End this session on this device.</p>
                </div>
                <Button variant="danger" onClick={onLogout}>
                  <LogOut size={15} />
                  Sign out
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn('switch', checked && 'switch-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

export type { TabId }
