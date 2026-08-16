import { AnimatePresence, motion } from 'framer-motion'
import { RefreshCw, WifiOff } from 'lucide-react'
import { useOnlineStatus } from '../../lib/hooks'
import { useToast } from '../ui/toast-context'

/**
 * Non-blocking connectivity notice (§21). Driven by the browser's real
 * online/offline events — it never guesses, and "Reconnect" reports the actual
 * state instead of optimistically dismissing itself.
 */
export function ConnectionBanner() {
  const { online, recheck } = useOnlineStatus()
  const { push } = useToast()

  return (
    <AnimatePresence>
      {!online && (
        <motion.div
          className="conn-banner"
          role="status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="conn-banner-inner">
            <WifiOff size={15} />
            <span className="conn-banner-text">
              <strong>Connection lost</strong>
              <span className="conn-banner-desc">PixGPT can’t reach the network right now.</span>
            </span>
            <button
              type="button"
              className="conn-banner-action"
              onClick={() => {
                if (!recheck()) {
                  push({ title: 'Still offline', description: 'Check your connection and try again.', tone: 'error' })
                }
              }}
            >
              <RefreshCw size={13} />
              Reconnect
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
