import { motion } from 'framer-motion'
import { AlertTriangle, Check, FileText, Image as ImageIcon, Loader2, RefreshCw, X } from 'lucide-react'
import type { Attachment } from '../../lib/types'
import { formatBytes } from '../../lib/utils'

interface AttachmentPreviewProps {
  attachment: Attachment
  onRemove?: () => void
  /** Offered only for failed uploads (§21) */
  onRetry?: () => void
  /** Compact mode renders inside a message (no remove, wider card) */
  compact?: boolean
}

const STATUS_LABEL: Record<Attachment['status'], string> = {
  uploading: 'Uploading…',
  processing: 'Processing…',
  completed: 'Ready',
  failed: 'Unable to process this file',
}

export function AttachmentPreview({ attachment, onRemove, onRetry, compact }: AttachmentPreviewProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className={`attach-preview ${compact ? 'attach-preview-compact' : ''} ${attachment.status === 'failed' ? 'attach-preview-failed' : ''}`}
    >
      {attachment.kind === 'image' && attachment.url ? (
        <img className="attach-thumb" src={attachment.url} alt="" />
      ) : (
        <span className="attach-icon">
          {attachment.kind === 'image' ? <ImageIcon size={16} /> : <FileText size={16} />}
        </span>
      )}

      <div className="attach-meta">
        <span className="attach-name" title={attachment.name}>
          {attachment.name}
        </span>
        <span className={`attach-status attach-status-${attachment.status}`}>
          {attachment.status === 'completed' ? <Check size={12} /> : null}
          {attachment.status === 'failed' ? <AlertTriangle size={12} /> : null}
          {attachment.status === 'uploading' || attachment.status === 'processing' ? (
            <Loader2 size={12} className="spin" />
          ) : null}
          {attachment.status === 'failed' || compact
            ? STATUS_LABEL[attachment.status]
            : formatBytes(attachment.size)}
        </span>
        {attachment.status === 'uploading' ? (
          <div
            className="attach-progress"
            role="progressbar"
            aria-label={`Uploading ${attachment.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((attachment.progress ?? 0) * 100)}
          >
            <div
              className="attach-progress-bar"
              style={{ width: `${Math.round((attachment.progress ?? 0) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      {onRetry ? (
        <button type="button" className="attach-retry" onClick={onRetry}>
          <RefreshCw size={12} />
          Try again
        </button>
      ) : null}

      {onRemove ? (
        <button type="button" className="attach-remove" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
          <X size={14} />
        </button>
      ) : null}
    </motion.div>
  )
}

export function AttachmentGroup({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="attach-group">
      {attachments.map((a) => (
        <AttachmentPreview key={a.id} attachment={a} compact />
      ))}
    </div>
  )
}
