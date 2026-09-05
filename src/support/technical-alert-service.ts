import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { CodeSyncFailure } from "../git-sync/project-errors.js"
import type { ReplyService, TechnicalAlertKind } from "../replies/reply-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeGroup } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import {
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

// 保留调用契约与真实停用状态，所有技术群投递（包括恢复重试）均在此终止。
export class TechnicalAlertService {
  constructor(
    _database: RuntimeDatabase,
    _store: SupportThreadStore,
    _replies: ReplyService,
    _redactor: ConfiguredSecretRedactor,
    _transport: TransportPort,
  ) {}

  async sendSupportAlert(
    sourceGroup: RuntimeGroup,
    replyId: string,
    reason: string,
    operatorAnswer?: string,
    alertKind?: TechnicalAlertKind,
  ): Promise<TechnicalAlertDelivery> {
    void alertKind
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
    void sourceGroup
    void replyId
    return this.suppressed()
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

  private suppressed(): TechnicalAlertDelivery {
    return { status: "not_configured", summary: "技术群转发与通知已停用", errorType: null }
  }
}
