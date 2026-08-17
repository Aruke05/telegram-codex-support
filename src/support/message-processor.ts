import type { SupportMessageEvent } from "../runtime/types.js"
import type { SupportAnswerWorker } from "./answer-worker.js"
import type { SupportAttachmentContext } from "./agent.js"
import type { SupportThreadCoordinator } from "./thread-coordinator.js"

export type IncomingSupportMessage = {
  groupId: string
  messageId: string
  senderId: string
  senderUsername: string | null
  senderDisplayName: string | null
  fromBot: boolean
  accountOwnerOutgoing?: boolean
  replyToMessageId: string | null
  messageThreadId: string | null
  replyTargetIsBot: boolean
  text: string
  attachments: SupportAttachmentContext[]
  mediaGroupId?: string | null
  createdAt?: string
}

export class SupportMessageProcessor {
  constructor(
    private readonly coordinator: SupportThreadCoordinator,
    private readonly worker: SupportAnswerWorker,
  ) {}

  accept(input: IncomingSupportMessage): SupportMessageEvent | null {
    return this.coordinator.accept(input)
  }

  enrichAttachments(eventId: string, attachments: SupportAttachmentContext[]): SupportMessageEvent {
    return this.coordinator.enrichAttachments(eventId, attachments)
  }

  start(): void {
    this.coordinator.start()
    this.worker.start()
  }

  recover(): number {
    return this.worker.recover()
  }

  async stop(): Promise<void> {
    await this.coordinator.stop()
    await this.worker.stop()
  }

  async drain(): Promise<void> {
    await this.coordinator.drain()
    this.worker.wake()
    await this.worker.drain()
  }
}
