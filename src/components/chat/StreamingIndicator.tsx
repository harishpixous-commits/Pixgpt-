import { motion } from 'framer-motion'

export function StreamingIndicator({ label = 'Thinking' }: { label?: string }) {
  return (
    <div className="streaming-indicator" aria-live="polite" role="status">
      <span className="streaming-dots" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="streaming-dot"
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
          />
        ))}
      </span>
      <span className="streaming-label">{label}…</span>
    </div>
  )
}
