import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { uid } from '../../lib/utils'
import { ToastContext, type ToastTone } from './toast-context'

interface ToastData {
  id: string
  title: string
  description?: string
  tone: ToastTone
}

const TONE_ICON: Record<ToastTone, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  error: AlertTriangle,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    ({ title, description, tone = 'default' }: { title: string; description?: string; tone?: ToastTone }) => {
      const id = uid()
      setToasts((t) => [...t.slice(-3), { id, title, description, tone }])
      const timer = setTimeout(() => dismiss(id), 3800)
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="region" aria-live="polite" aria-label="Notifications">
        <AnimatePresence>
          {toasts.map((toast) => {
            const Icon = TONE_ICON[toast.tone]
            return (
              <motion.div
                key={toast.id}
                role="status"
                className={`toast toast-${toast.tone}`}
                initial={{ opacity: 0, y: 14, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 480, damping: 36 }}
              >
                <span className="toast-icon">
                  <Icon size={17} />
                </span>
                <div className="toast-body">
                  <p className="toast-title">{toast.title}</p>
                  {toast.description ? <p className="toast-desc">{toast.description}</p> : null}
                </div>
                <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
                  <X size={14} />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
