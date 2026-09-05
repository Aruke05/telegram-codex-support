import type { RuntimeDatabase } from "../runtime/database.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { TelegramOutputOwnership } from "../telegram/runtime.js"
import type { SupportAnswerCancellationPort } from "./thread-lifecycle-service.js"
import type { SupportThreadStore } from "./thread-store.js"

type TransportPort = {
  sendMessage(
    accountId: string | null,
    chatId: string,
    text: string,
    replyToMessageId?: string,
    quote?: string | null,
    ownership?: TelegramOutputOwnership,
  ): Promise<string>
}

export type SupportDeadlineServiceDependencies = {
  database: RuntimeDatabase
  store: SupportThreadStore
  redactor: ConfiguredSecretRedactor
  cancellation: SupportAnswerCancellationPort
  transport: TransportPort
}

const hardDeadlineBatchSize = 512

export class SupportDeadlineService {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly active = new Set<Promise<void>>()
  private running = false
  private busy = false

  constructor(private readonly deps: SupportDeadlineServiceDependencies) {}

  start(intervalMs = 5_000): void {
    if (this.running) return
    this.deps.store.recoverInterruptedNotifications()
    this.deps.store.recoverInterruptedHumanPriorityClaims()
    this.running = true
    this.timer = setInterval(() => this.wake(), Math.max(250, intervalMs))
    this.timer.unref()
    this.wake()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.allSettled([...this.active])
  }

  wake(): void {
    if (!this.running || this.busy) return
    this.busy = true
    const task = this.runOnce().finally(() => { this.busy = false })
    this.track(task)
  }

  async runOnce(now = new Date()): Promise<void> {
    const current = now.toISOString()
    this.deps.cancellation.cancelClosed()
    for (let index = 0; index < hardDeadlineBatchSize; index += 1) {
      const timeout = this.deps.store.claimDueTimeout(current)
      if (!timeout) break
      this.deps.cancellation.cancel(timeout.threadId, timeout.inputRevision)
    }
    // 人工优先窗口仍然生效，到期后静默交给 AI，不再发送接单提示。
    for (let index = 0; index < 100; index += 1) {
      const claim = this.deps.store.claimDueHumanPriority(current)
      if (!claim) break
      this.deps.store.completeHumanPriorityClaim(claim, null, null, current)
    }
    // 清理旧版本留下的待发送通知，重启后也不得补发“稍等”或超时通知。
    for (let index = 0; index < 200; index += 1) {
      const notification = this.deps.store.claimPendingNotification(
        ["progress", "timeout_operator", "timeout_alert"], current,
      )
      if (!notification) break
      this.deps.store.failNotification(notification.id, "进度回复与技术群通知已停用", current)
    }
  }

  private track(task: Promise<void>): void {
    this.active.add(task)
    void task.finally(() => this.active.delete(task))
  }
}
