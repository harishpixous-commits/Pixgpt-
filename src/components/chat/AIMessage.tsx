import { lazy, Suspense } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, ChevronsDown, RefreshCw } from 'lucide-react'
import { StreamingIndicator } from './StreamingIndicator'
import { MessageActions } from './MessageActions'
import { usePixGptStore } from '../../lib/store'
import { MODELS } from '../../lib/models'
import { isModelAlias } from '../../lib/types'
import type { ChatMessage, ModelId } from '../../lib/types'

// Markdown pulls in react-markdown, katex, and syntax highlighting —
// load it only when a response actually needs rendering.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

interface AIMessageProps {
  convId: string
  /** What the user actually asked for — an alias like `pixgpt-pro` or a pinned catalogue id. */
  requested: ModelId
  message: ChatMessage
}

/** Headline per failure kind; the body carries the server's safe explanation. */
const ERROR_TITLES: Record<string, string> = {
  gateway_unavailable: 'AI gateway unavailable',
  invalid_api_key: 'Authentication failed',
  provider_unavailable: 'Provider unavailable',
  model_unavailable: 'Model unavailable',
  rate_limited: 'Too many requests',
  quota_exceeded: 'Quota exhausted',
  timeout: 'Request timed out',
  provider_error: 'Provider unavailable',
  malformed_response: 'Unreadable response',
  stream_failed: 'Response interrupted',
  unsupported: 'Not supported',
}

export function AIMessage({ convId, requested, message }: AIMessageProps) {
  const retryLast = usePixGptStore((s) => s.retryLast)
  const continueFrom = usePixGptStore((s) => s.continueFrom)
  const isStreaming = message.status === 'streaming'
  const hasError = message.status === 'error'

  /*
   * A human label for the model that was asked for. Aliases get their friendly
   * name ("PixGPT Pro"); a pinned catalogue id is shown as-is, since that is
   * what the user typed/selected.
   */
  const requestedLabel = isModelAlias(requested) ? MODELS[requested].label : requested

  return (
    <div className="msg-row msg-row-ai">
      <div className="msg-ai">
        {isStreaming && !message.content ? (
          <StreamingIndicator />
        ) : (
          <>
            {message.content ? (
              <Suspense fallback={<StreamingIndicator label="Preparing response" />}>
                <Markdown content={message.content} />
              </Suspense>
            ) : null}
            {hasError && (
              <div className="error-box" role="alert">
                <AlertTriangle size={17} />
                <div>
                  <p className="error-title">{ERROR_TITLES[message.errorCode ?? ''] ?? 'Something went wrong'}</p>
                  <p className="error-desc">
                    {message.error ?? 'The response could not be generated. Please try again.'}
                  </p>
                </div>
                <button type="button" className="error-retry" onClick={() => retryLast(convId)}>
                  <RefreshCw size={14} />
                  Try again
                </button>
              </div>
            )}
            {/*
              Shown only when a *different* model answered than the one asked
              for. A pinned model can fail and a compatible fallback serve
              instead; without this the header keeps showing the pinned name
              while something else wrote the reply — and the only clue is the
              model contradicting itself when asked what it is.
            */}
            {message.truncated && !isStreaming && !hasError ? (
              <div className="msg-truncated">
                <p className="msg-truncated-note">
                  <ChevronsDown size={14} aria-hidden="true" />
                  The answer hit the model's output limit and was cut off here.
                </p>
                <button
                  type="button"
                  className="msg-truncated-continue"
                  onClick={() => continueFrom(convId, message.id)}
                >
                  Continue writing
                </button>
              </div>
            ) : null}
            {message.fellBack && message.servedBy ? (
              <p className="msg-served">
                Answered by <strong>{message.servedBy}</strong> — {requestedLabel} was unavailable, using a fallback.
              </p>
            ) : null}
            {message.sources && message.sources.length > 0 ? (
              <div className="msg-sources">
                <p className="msg-sources-label">Sources</p>
                <ol className="msg-sources-list">
                  {message.sources.map((s, i) => (
                    <li key={s.url + i}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {!isStreaming && (message.content || hasError) ? (
              <MessageActions convId={convId} message={message} />
            ) : null}
          </>
        )}
      </div>
      {isStreaming ? <motion.span className="msg-streaming-edge" aria-hidden="true" /> : null}
    </div>
  )
}
