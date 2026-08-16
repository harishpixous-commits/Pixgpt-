import { MotionConfig } from 'framer-motion'
import { ToastProvider } from './components/ui/Toast'
import { ChatLayout } from './components/chat/ChatLayout'

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <ChatLayout />
      </ToastProvider>
    </MotionConfig>
  )
}
