import type { CloseThreadResult, SupportThreadStore } from "./thread-store.js"

export type HumanTakeoverStatus = "cancelled" | "delivery_in_flight" | "thread_already_terminal"

export type SupportAnswerCancellationPort = {
  cancel(threadId: string, revision?: number): boolean
  cancelClosed(): number
}

export class SupportThreadLifecycleService {
  constructor(
    private readonly store: SupportThreadStore,
    private readonly cancellation: SupportAnswerCancellationPort,
  ) {}

  closeManually(threadId: string, now = new Date().toISOString()): CloseThreadResult {
    const result = this.store.closeThread(threadId, "后台管理员", "后台手动关闭", now)
    if (result.changed) this.cancellation.cancel(threadId)
    return result
  }

  takeOverFromHuman<T>(
    threadId: string,
    actor: string,
    complete: (status: HumanTakeoverStatus) => T,
    now = new Date().toISOString(),
  ): T {
    const result = this.store.takeOverByHuman(threadId, actor, (takeover) => complete(takeover.takeoverStatus), now)
    if (result.takeover.changed) this.cancellation.cancel(threadId)
    return result.value
  }
}
