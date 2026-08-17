import type { RuntimeDatabase } from "../runtime/database.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { TelegramOutputOwnership } from "../telegram/runtime.js"
import { operatorCopy } from "./operator-copy.js"
import { humanizeOperatorAnswer } from "./operator-voice.js"
import type { SupportAnswerCancellationPort } from "./thread-lifecycle-service.js"
import type { HumanPriorityClaim, SupportThreadNotification, SupportThreadStore } from "./thread-store.js"

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

const sendTimeoutMs = 25_000
const hardDeadlineBatchSize = 512

class TelegramSendTimeoutError extends Error {}

async function withSendTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TelegramSendTimeoutError("Telegram 发送超时，最终结果未知")), sendTimeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function eachConcurrent<T>(items: T[], maximum: number, handler: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(maximum, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item !== undefined) await handler(item)
    }
  })
  await Promise.allSettled(workers)
}

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
    const humanPriority: HumanPriorityClaim[] = []
    for (let index = 0; index < 100; index += 1) {
      const claim = this.deps.store.claimDueHumanPriority(current)
      if (!claim) break
      humanPriority.push(claim)
    }
    const progress: SupportThreadNotification[] = []
    for (let index = 0; index < 100; index += 1) {
      const notification = this.deps.store.claimDueProgress(current)
      if (!notification) break
      progress.push(notification)
    }
    const pending: SupportThreadNotification[] = []
    for (let index = 0; index < 200; index += 1) {
      const notification = this.deps.store.claimPendingNotification(["timeout_operator", "timeout_alert"], current)
      if (!notification) break
      pending.push(notification)
    }
    await Promise.allSettled([
      eachConcurrent(humanPriority, 4, (claim) => this.sendHumanPriorityClaim(claim)),
      eachConcurrent(progress, 4, (notification) => this.sendProgress(notification)),
      eachConcurrent(pending, 4, (notification) => this.sendTimeout(notification)),
    ])
  }

  private async sendHumanPriorityClaim(claim: HumanPriorityClaim): Promise<void> {
    try {
      const thread = this.deps.store.getThread(claim.threadId)
      const detail = this.deps.store.getThreadDetail(thread.id)
      const group = this.deps.database.readGroups().find((item) => item.id === thread.groupId)
      const state = this.deps.database.prepare(`SELECT human_priority_state FROM support_threads
        WHERE id=? AND status='collecting'`).get(thread.id) as
        | { human_priority_state: string }
        | undefined
      if (state?.human_priority_state !== "sending" || !group?.enabled || !group.telegramChatId) {
        this.deps.store.completeHumanPriorityClaim(claim, null, "问题版本已变化或来源群不可用")
        return
      }
      const replyTargetMessageId = detail.messages.at(-1)?.event.telegramMessageId ?? thread.anchorMessageId
      const messageId = await withSendTimeout(this.deps.transport.sendMessage(
        group.accountId,
        group.telegramChatId,
        operatorCopy.progress,
        replyTargetMessageId,
        undefined,
        {
          groupId: group.id,
          threadId: thread.id,
          serviceId: thread.serviceId,
          kind: "mention_claim_progress",
        },
      ))
      this.deps.store.completeHumanPriorityClaim(claim, messageId)
    } catch (error) {
      const reason = error instanceof TelegramSendTimeoutError
        ? error.message
        : "人工优先等待结束后的稍等提示发送失败"
      this.deps.store.completeHumanPriorityClaim(claim, null, reason)
    }
  }

  private async sendProgress(notification: SupportThreadNotification): Promise<void> {
    try {
      const thread = this.deps.store.getThread(notification.threadId)
      const detail = this.deps.store.getThreadDetail(thread.id)
      const group = this.deps.database.readGroups().find((item) => item.id === thread.groupId)
      if (thread.status !== "generating" || thread.revision !== notification.inputRevision || !group?.enabled || !group.telegramChatId) {
        this.deps.store.failNotification(notification.id, "问题版本已变化或来源群不可用")
        return
      }
      const sending = this.deps.store.claimNotificationSending(notification.id)
      if (!sending) return
      const progressText = humanizeOperatorAnswer(operatorCopy.progress, "", thread.operatorStyleProfile)
      const replyTargetMessageId = detail.messages.at(-1)?.event.telegramMessageId ?? thread.anchorMessageId
      const messageId = await withSendTimeout(this.deps.transport.sendMessage(
        group.accountId,
        group.telegramChatId,
        progressText,
        replyTargetMessageId,
        undefined,
        {
          groupId: group.id,
          threadId: thread.id,
          serviceId: thread.serviceId,
          notificationId: sending.id,
          kind: "progress",
        },
      ))
      this.deps.store.completeNotification(notification.id, messageId)
    } catch (error) {
      this.finishFailedSend(notification.id, error, "三分钟进度提示发送失败")
    }
  }

  private async sendTimeout(notification: SupportThreadNotification): Promise<void> {
    try {
      const thread = this.deps.store.getThread(notification.threadId)
      const detail = this.deps.store.getThreadDetail(thread.id)
      const sourceGroup = this.deps.database.readGroups().find((item) => item.id === thread.groupId)
      const service = this.deps.database.readProjectServices("WHERE id=?", [thread.serviceId])[0]
      if (!sourceGroup?.telegramChatId || !service) {
        this.deps.store.failNotification(notification.id, "问题来源群或服务不可用")
        return
      }
      if (notification.kind === "timeout_operator") {
        const timeoutText = humanizeOperatorAnswer(operatorCopy.progress, "", thread.operatorStyleProfile)
        const safe = this.deps.redactor.redact(timeoutText).text
        const replyTargetMessageId = detail.messages.at(-1)?.event.telegramMessageId ?? thread.anchorMessageId
        const messageId = await withSendTimeout(this.deps.transport.sendMessage(
          sourceGroup.accountId,
          sourceGroup.telegramChatId,
          safe,
          replyTargetMessageId,
          undefined,
          {
            groupId: sourceGroup.id,
            threadId: thread.id,
            serviceId: thread.serviceId,
            notificationId: notification.id,
            kind: "timeout_operator",
          },
        ))
        this.deps.store.completeNotification(notification.id, messageId)
        return
      }
      this.deps.store.completeNotification(notification.id, null)
    } catch (error) {
      this.finishFailedSend(notification.id, error, "一小时超时通知发送失败")
    }
  }

  private finishFailedSend(notificationId: string, error: unknown, fallback: string): void {
    if (error instanceof TelegramSendTimeoutError) {
      this.deps.store.markNotificationUnknown(notificationId, error.message)
      return
    }
    this.deps.store.failNotification(notificationId, fallback)
  }

  private track(task: Promise<void>): void {
    this.active.add(task)
    void task.finally(() => this.active.delete(task))
  }
}
