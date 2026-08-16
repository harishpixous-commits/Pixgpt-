import { motion } from 'framer-motion'
import { BookOpen, ClipboardList, Code2, FileText, Lightbulb, type LucideIcon } from 'lucide-react'
import { usePixGptStore } from '../../lib/store'
import { PixMark } from '../ui/PixMark'

interface Suggestion {
  icon: LucideIcon
  title: string
  description: string
  prompt: string
}

const SUGGESTIONS: Suggestion[] = [
  {
    icon: BookOpen,
    title: 'Explain a complex concept',
    description: 'In simple terms, with clear examples',
    prompt: 'Explain a complex concept in simple terms with examples.',
  },
  {
    icon: Code2,
    title: 'Write production-ready code',
    description: 'Typed, tested, and documented',
    prompt: 'Write production-ready code for a small feature, typed and documented.',
  },
  {
    icon: FileText,
    title: 'Analyze a document',
    description: 'Summarize the key insights',
    prompt: 'Help me analyze a document and summarize its key insights.',
  },
  {
    icon: Lightbulb,
    title: 'Generate ideas',
    description: 'Brainstorm with structure',
    prompt: 'Help me brainstorm ideas with structure.',
  },
  {
    icon: ClipboardList,
    title: 'Help me plan a project',
    description: 'Break it into clear milestones',
    prompt: 'Help me plan a project and break it into milestones.',
  },
]

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
}

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 380, damping: 30 } },
}

export function EmptyState() {
  const sendMessage = usePixGptStore((s) => s.sendMessage)

  return (
    <div className="chat-scroll empty-scroll">
      <motion.div
        className="empty"
        variants={container}
        initial="hidden"
        animate="show"
        role="presentation"
      >
        <motion.div variants={item} className="empty-logo">
          <PixMark size={62} />
        </motion.div>
        <motion.h1 variants={item} className="empty-title">
          PixGPT
        </motion.h1>
        <motion.p variants={item} className="empty-tagline">
          Your intelligent AI assistant.
        </motion.p>
        <motion.p variants={item} className="empty-support">
          Ask anything, explore ideas, analyze documents, write code, or solve problems.
        </motion.p>

        <motion.div variants={item} className="empty-suggestions">
          {SUGGESTIONS.map((s) => {
            const Icon = s.icon
            return (
              <motion.button
                key={s.title}
                type="button"
                className="suggestion-card"
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                onClick={() => void sendMessage(s.prompt, [])}
              >
                <span className="suggestion-icon">
                  <Icon size={18} />
                </span>
                <span className="suggestion-text">
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-desc">{s.description}</span>
                </span>
              </motion.button>
            )
          })}
        </motion.div>
      </motion.div>
    </div>
  )
}
