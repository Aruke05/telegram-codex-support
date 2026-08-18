import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { CodeSyncFailure } from "../git-sync/project-errors.js"
import type { ReplyService, TechnicalAlertKind } from "../replies/reply-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeGroup } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import {
  TelegramDeliveryError,
  type TelegramDeliveryErrorType,
  type TelegramOutputOwnership,
} from "../telegram/runtime.js"
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
  forwardMessages?(
    accountId: string | null,
    targetChatId: string,
    sourceChatId: string,
    messageIds: string[],
    ownership?: TelegramOutputOwnership,
  ): Promise<string[]>
}

export type TechnicalAlertDelivery = {
  status: "sent" | "not_configured" | "failed" | "uncertain"
  summary: string
  errorType: TelegramDeliveryErrorType | null
}

export type HourlyCodeSyncFailureInput = {
  serviceId: string
  service: string
  branch: string
  batchId: string
  failure: CodeSyncFailure
  snapshot: ProjectCodeSnapshot | null
}

export type CodeSyncRecoveryInput = {
  serviceId: string
  service: string
  branch: string
  batchId: string
  repositories: ProjectCodeSnapshot["repositories"]
}

type CodeSyncAlertInput = {
  sourceGroup: RuntimeGroup
  replyId: string
  branch: string
  batchId: string
  failure: CodeSyncFailure
  snapshot: ProjectCodeSnapshot | null
  additionalReason?: string
}

const deliverySummaries: Record<TelegramDeliveryErrorType, string> = {
  account_unavailable: "发送失败：Telegram 账号未配置或连接未就绪",
  rate_limited: "发送失败：Telegram 限流",
  forbidden: "发送失败：账号无权向技术告警群发消息",
  chat_not_found: "发送失败：技术告警群不存在或群 ID 无效",
  timeout: "发送结果未知：Telegram 请求超时",
  network: "发送结果未知：Telegram 网络连接中断",
  unknown: "发送失败：Telegram 返回未知错误",
}

export class TechnicalAlertService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly store: SupportThreadStore,
    private readonly replies: ReplyService,
    _redactor: ConfiguredSecretRedactor,
    private readonly transport: TransportPort,
  ) {}

  async sendSupportAlert(
    sourceGroup: RuntimeGroup,
    replyId: string,
    reason: string,
    operatorAnswer?: string,
    alertKind?: TechnicalAlertKind,
  ): Promise<TechnicalAlertDelivery> {
    if (alertKind === "escalation") {
      return this.forwardThread(sourceGroup, replyId, "technical_alert:escalation")
    }
    void sourceGroup
    void replyId
    void reason
    void operatorAnswer
    return this.suppressed()
  }

  async sendTransientFeatureRequest(
    sourceGroup: RuntimeGroup,
    replyId: string,
    reason: string,
    operatorAnswer: string,
  ): Promise<TechnicalAlertDelivery> {
    void reason
    void operatorAnswer
    return this.forwardThread(sourceGroup, replyId, "technical_alert:feature_request")
  }

  async sendCodeSyncFailure(input: CodeSyncAlertInput): Promise<TechnicalAlertDelivery> {
    void input
    return this.suppressed()
  }

  async sendHourlyCodeSyncFailure(input: HourlyCodeSyncFailureInput): Promise<TechnicalAlertDelivery> {
    void input
    return this.suppressed()
  }

  async sendCodeSyncRecovery(input: CodeSyncRecoveryInput): Promise<TechnicalAlertDelivery> {
    void input
    return this.suppressed()
  }

  private async forwardThread(
    sourceGroup: RuntimeGroup,
    replyId: string,
    outputKind: string,
  ): Promise<TechnicalAlertDelivery> {
    const target = this.database.readGroups().find((group) => (
      group.enabled && group.purpose === "technical_alert" && group.telegramChatId
    ))
    if (!target) return { status: "not_configured", summary: "技术告警群未配置", errorType: null }
    if (!target.accountId) return { status: "not_configured", summary: "技术告警群账号未配置", errorType: null }
    if (!sourceGroup.telegramChatId || !this.transport.forwardMessages) {
      return { status: "failed", summary: "原消息无法转发", errorType: "unknown" }
    }
    const targetAccountId = target.accountId
    const targetChatId = target.telegramChatId!
    const sourceChatId = sourceGroup.telegramChatId
    const record = this.replies.getDetail(replyId)
    const messageIds = record.threadId
      ? this.store.listThreadForwardMessageIds(record.threadId)
      : record.telegramMessageId ? [record.telegramMessageId] : []
    if (messageIds.length === 0) return { status: "failed", summary: "没有可转发的原消息", errorType: "unknown" }

    let forwarded = 0
    for (const messageId of messageIds) {
      try {
        const delivered = await this.transport.forwardMessages(
          targetAccountId,
          targetChatId,
          sourceChatId,
          [messageId],
          {
            groupId: target.id,
            threadId: record.threadId,
            serviceId: record.serviceId,
            replyId,
            kind: outputKind,
          },
        )
        if (delivered.length !== 1) throw new TelegramDeliveryError("unknown", "uncertain")
        forwarded += 1
      } catch (error) {
        const deliveryError = error instanceof TelegramDeliveryError
          ? error
          : new TelegramDeliveryError("unknown", "uncertain")
        if (forwarded > 0 || deliveryError.state === "uncertain") return {
          status: "uncertain",
          summary: deliveryError.state === "uncertain"
            ? `转发中断：已确认送达 ${forwarded} 条，当前消息结果未知`
            : `转发中断：已确认送达 ${forwarded} 条，当前消息明确未送达`,
          errorType: deliveryError.type,
        }
        return {
          status: "failed",
          summary: deliverySummaries[deliveryError.type],
          errorType: deliveryError.type,
        }
      }
    }
    return { status: "sent", summary: `已转发 ${forwarded} 条`, errorType: null }
  }

  private suppressed(): TechnicalAlertDelivery {
    return { status: "not_configured", summary: "技术群系统消息已停用", errorType: null }
  }
}
