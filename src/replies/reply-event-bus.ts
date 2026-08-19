import type { AdminChatTurnStatus, ReplyStatus } from "../runtime/types.js"

export type ReplyStatusEvent = {
  id: string
  status: ReplyStatus
  updatedAt: string
  durationMs: number | null
}

export type AdminChatTurnEvent = {
  kind: "admin-chat-turn"
  id: string
  sessionId: string
  ownerUserId: string | null
  status: AdminChatTurnStatus
  updatedAt: string
}

export type ReplyEvent = ReplyStatusEvent | AdminChatTurnEvent

type Listener = (event: ReplyEvent) => void

export class ReplyEventBus {
  private readonly listeners = new Set<Listener>()

  publish(event: ReplyEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 单个实时订阅者不能影响其他监听器或业务状态机。 */ }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
