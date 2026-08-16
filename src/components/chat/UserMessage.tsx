import { AttachmentGroup } from './AttachmentPreview'
import type { ChatMessage } from '../../lib/types'

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="msg-row msg-row-user">
      <div className="msg-user">
        {message.attachments && message.attachments.length > 0 ? (
          <AttachmentGroup attachments={message.attachments} />
        ) : null}
        {message.content ? <p className="msg-user-text">{message.content}</p> : null}
      </div>
    </div>
  )
}
