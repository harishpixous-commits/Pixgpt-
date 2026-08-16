import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, Mic, Square } from 'lucide-react'
import { chatApi } from '../../lib/api'
import { useToast } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'

type VoiceState = 'idle' | 'recording' | 'processing' | 'error'

interface VoiceInputProps {
  onTranscript: (text: string) => void
}

export function VoiceInput({ onTranscript }: VoiceInputProps) {
  const { push } = useToast()
  const [state, setState] = useState<VoiceState>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }

  useEffect(() => cleanup, [])

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
        setState('processing')
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const transcript = await chatApi.transcribeAudio(blob, controller.signal)
          onTranscript(transcript)
          setState('idle')
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            setState('idle')
            return
          }
          setState('error')
          push({ title: 'Voice transcription failed', tone: 'error' })
        } finally {
          abortRef.current = null
          cleanup()
        }
      }
      recorder.start()
      setState('recording')
    } catch {
      setState('error')
      push({ title: 'Microphone access denied', description: 'Allow microphone access to use voice input.', tone: 'error' })
    }
  }

  const stop = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    } else {
      cleanup()
      setState('idle')
    }
  }

  // Esc ends an in-progress recording (documented in Help & shortcuts)
  useEffect(() => {
    if (state !== 'recording') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      stop()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `stop` is stable in effect
  }, [state])

  return (
    <Tooltip label={state === 'recording' ? 'Stop recording' : 'Voice input'}>
      <button
        type="button"
        className={`voice-btn voice-${state}`}
        aria-label={state === 'recording' ? 'Stop recording' : 'Start voice input'}
        onClick={state === 'recording' ? stop : start}
      >
        <AnimatePresence mode="wait" initial={false}>
          {state === 'recording' ? (
            <motion.span
              key="rec"
              className="voice-pulse"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.span
                className="voice-ring"
                animate={{ scale: [1, 1.6], opacity: [0.5, 0] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }}
              />
              <Square size={14} fill="currentColor" />
            </motion.span>
          ) : state === 'processing' ? (
            <motion.span key="proc" className="voice-proc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Loader2 size={15} className="spin" />
            </motion.span>
          ) : (
            <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Mic size={16} />
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </Tooltip>
  )
}
