import type { AnswerDecision } from "../codex/schemas.js"
import { CodexExecutionTimeoutError } from "../codex/executor.js"
import { ProjectCodeSyncUnavailableError, type ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { ReplyService } from "../replies/reply-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeKnowledgeService } from "../runtime/knowledge-service.js"
import type { ModelConfigService } from "../runtime/model-config-service.js"
import { ModelExecutionError } from "../models/errors.js"
import type {
  ProjectServiceRecord,
  RuntimeGroup,
  SupportThread,
  SupportThreadDetail,
  SupportThreadDetailMessage,
} from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import { TelegramDeliveryError, type TelegramOutputOwnership } from "../telegram/runtime.js"
import type { SupportAttachmentContext, SupportDecisionAgentPort } from "./agent.js"
import {
  SupportCodeConfigurationChangedError,
  SupportCodeSyncRuntimeError,
  SupportInvestigationService,
  SupportModelOutputRejectedError,
} from "./investigation-service.js"
import { operatorCopy } from "./operator-copy.js"
import type { ResourceWorkspace } from "./resource-workspace.js"
import { routeSupportMessage } from "./routing.js"
import type { TechnicalAlertDelivery, TechnicalAlertService } from "./technical-alert-service.js"
import type { SupportThreadStore } from "./thread-store.js"
import type { TrustedDatabaseQueryRequest } from "./trusted-command-observation.js"

type CodeSyncPort = {
  readCurrentSnapshot(serviceId: string): ProjectCodeSnapshot
  currentServiceForSnapshot(snapshot: ProjectCodeSnapshot): ProjectServiceRecord | null
  recordAlert?(batchId: string, delivery: TechnicalAlertDelivery): void
}
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
type LearningPort = { enqueue(replyId: string): void }
type ResourceBrokerPort = {
  runServerCheck(resourceId: string, check: "nginx_routes" | "system_resources"): Promise<{ exitCode: number; stdout: string; stderr: string }>
  verifyDatabaseQuery?(serviceId: string, request: TrustedDatabaseQueryRequest, signal?: AbortSignal): Promise<{
    columns: string[]
    rows: unknown[]
    truncated: boolean
  }>
}
export type SupportAnswerWorkerDependencies = {
  database: RuntimeDatabase
  store: SupportThreadStore
  replies: ReplyService
  config: ModelConfigService
  knowledge: RuntimeKnowledgeService
  redactor: ConfiguredSecretRedactor
  codeSync: CodeSyncPort
  agent: SupportDecisionAgentPort
  transport: TransportPort
  technicalAlerts: Pick<TechnicalAlertService, "sendSupportAlert" | "sendCodeSyncFailure"> & {
    sendTransientFeatureRequest?: TechnicalAlertService["sendTransientFeatureRequest"]
  }
  learning: LearningPort
  resourceWorkspace: Pick<ResourceWorkspace, "open">
  resourceBroker?: ResourceBrokerPort
}

const maximumPendingAnswers = 128
const recentGroupContextWindowMs = 60 * 60 * 1000
const recentGroupContextMaximumItems = 40
const recentGroupContextMaximumChars = 8_000

function garbled(value: string): boolean {
  return value.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)
}

function fitQuestion(value: string): string {
  if (value.length <= 12_000) return value
  return `${value.slice(0, 5_800)}\n\n[中间较早内容已省略]\n\n${value.slice(-5_800)}`
}

function deliveryState(error: unknown): "failed" | "uncertain" {
  return error instanceof TelegramDeliveryError ? error.state : "uncertain"
}

export class SupportAnswerWorker {
  readonly replies: ReplyService
  private readonly investigation: SupportInvestigationService
  private readonly active = new Set<Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly processingWaiters: Array<{ maximum: number; resume: () => void }> = []
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private launching = false
  private activeClaims = 0
  private processingRunning = 0

  constructor(private readonly deps: SupportAnswerWorkerDependencies) {
    this.replies = deps.replies
    this.investigation = new SupportInvestigationService(deps)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.recover()
    this.timer = setInterval(() => this.wake(), 500)
    this.timer.unref()
    this.wake()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    ;[...this.controllers.values()].forEach((controller) => controller.abort())
    await this.drain()
  }

  wake(): void {
    if (!this.running || this.launching) return
    this.launching = true
    const task = this.runDueLoop().finally(() => { this.launching = false })
    this.track(task)
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active])
  }

  recover(now = new Date()): number {
    const current = now.toISOString()
    const staleBefore = new Date(now.getTime() + 1_000).toISOString()
    return this.deps.store.recoverStaleGenerating(current, staleBefore)
  }

  cancel(threadId: string, revision?: number): boolean {
    let cancelled = false
    for (const [key, controller] of this.controllers) {
      const [activeThreadId, activeRevision] = key.split(":")
      if (activeThreadId !== threadId || (revision !== undefined && Number(activeRevision) !== revision)) continue
      controller.abort()
      cancelled = true
    }
    return cancelled
  }

  cancelClosed(): number {
    let cancelled = 0
    for (const [key, controller] of this.controllers) {
      const [threadId, revisionText] = key.split(":")
      if (threadId && this.deps.store.isCurrentRevision(threadId, Number(revisionText))) continue
      controller.abort()
      cancelled += 1
    }
    return cancelled
  }

  async runDueOnce(now = new Date()): Promise<boolean> {
    if (await this.sendPendingEscalationDeliveryFailure()) return true
    const claimed = this.deps.store.claimDue(
      now.toISOString(),
      this.deps.config.getSettings().progressNotificationSeconds,
    )
    if (!claimed) return false
    await this.processClaim(claimed.thread, claimed.inputRevision)
    return true
  }

  private async runDueLoop(): Promise<void> {
    this.drainProcessingWaiters()
    while (this.running && this.activeClaims < maximumPendingAnswers) {
      if (await this.sendPendingEscalationDeliveryFailure()) continue
      const claimed = this.deps.store.claimDue(
        new Date().toISOString(),
        this.deps.config.getSettings().progressNotificationSeconds,
      )
      if (!claimed) break
      this.activeClaims += 1
      const task = this.processClaim(claimed.thread, claimed.inputRevision).finally(() => {
        this.activeClaims = Math.max(0, this.activeClaims - 1)
        this.wake()
      })
      this.track(task)
    }
  }

  private async processClaim(thread: SupportThread, inputRevision: number): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return
    const detail = this.deps.store.getThreadDetail(thread.id)
    const group = this.deps.database.readGroups().find((item) => item.id === thread.groupId)
    let service = this.deps.database.readProjectServices("WHERE id=? AND enabled=1", [thread.serviceId])[0]
    if (!group?.enabled || !group.telegramChatId || !service || group.purpose === "technical_alert") {
      this.deps.store.finishGeneration(thread.id, inputRevision, "closed")
      return
    }
    const preparedEscalation = this.deps.replies.findPreparedTechnicalEscalation(thread.id, inputRevision)
    if (preparedEscalation) {
      await this.resumePreparedTechnicalEscalation(preparedEscalation.id, thread, inputRevision, group)
      return
    }
    const question = this.question(detail)
    const latestMessage = this.latestQuestion(detail)
    const origin = detail.messages[0]?.event
    const replyTarget = detail.messages.at(-1)?.event ?? origin
    let reply = this.deps.replies.createPending({
      threadId: thread.id,
      inputRevision,
      groupId: group.id,
      accountId: group.accountId,
      projectId: service.projectId,
      serviceId: service.id,
      telegramMessageId: replyTarget?.telegramMessageId ?? thread.anchorMessageId,
      service: service.key,
      question,
      senderUserId: replyTarget?.senderUserId ?? null,
      senderUsername: replyTarget?.senderUsername ?? null,
      senderDisplayName: replyTarget?.senderDisplayName ?? null,
      senderRole: replyTarget?.senderRole ?? null,
      serviceSource: "group_binding",
    })
    reply = this.deps.replies.transition(reply.id, "generating")
    const conversationContext = this.conversationContext(detail, reply.id)
    const controllerKey = `${thread.id}:${inputRevision}`
    const controller = new AbortController()
    this.controllers.set(controllerKey, controller)
    const heartbeat = setInterval(() => this.deps.replies.heartbeat(reply.id), 20_000)
    heartbeat.unref()
    let processingSlotAcquired = false
    const configuredAnswerTimeoutSeconds = thread.answerTimeoutSeconds
    try {
      const modelSnapshot = this.deps.config.getModelInstanceSnapshot(thread.answerModelInstanceId)
      await this.acquireProcessingSlot(thread.answerMaxConcurrency, controller.signal)
      processingSlotAcquired = true
      try {
        const result = await this.investigation.investigate({
          serviceId: service.id,
          groupName: group.name,
          question,
          latestMessage,
          ...(conversationContext.value ? { conversationContext: conversationContext.value } : {}),
          responseDepth: conversationContext.hasThreadHistory ? "followup" : "initial",
          senderRole: replyTarget?.senderRole ?? null,
          scope: group.knowledgeScope,
          attachments: this.attachments(detail),
          answerTimeoutSeconds: thread.answerTimeoutSeconds,
          operatorStyleProfile: thread.operatorStyleProfile,
          modelInstanceId: thread.answerModelInstanceId,
          modelSnapshot,
          answerMaxConcurrency: thread.answerMaxConcurrency,
          answerBindingEnabled: thread.answerBindingEnabled,
          includeAiMemory: thread.answerIncludeAiMemory,
          includeInterfaceDocs: thread.answerIncludeInterfaceDocs,
          includeMagicBook: thread.answerIncludeMagicBook,
          replyStyle: thread.answerReplyStyle,
          onSnapshot: (snapshot) => {
            if (controller.signal.aborted || !this.current(thread.id, inputRevision)) return
            this.deps.replies.updateInvestigationProgress(reply.id, {
              codeRevision: snapshot.commit,
              codeSnapshotId: snapshot.snapshotId,
              codeSyncBatchId: snapshot.syncBatchId,
              summary: "已读取定时任务最近发布的代码快照 回答任务已进入只读排查队列",
            })
          },
        }, controller.signal)
        service = result.service
        await this.waitForPendingRouting(thread.id, inputRevision, controller.signal)
        if (this.hardDeadlineReached(thread.id, inputRevision)) return
        if (!this.current(thread.id, inputRevision)) return this.supersede(reply.id)
        await this.applyDecision(
          reply.id,
          thread,
          inputRevision,
          group,
          result.decision,
          result.snapshot.commit,
          result.allowedMemoryIds,
          replyTarget?.safeText ?? "",
        )
      } catch (error) {
        if (controller.signal.aborted) {
          if (!this.current(thread.id, inputRevision)) this.supersede(reply.id)
          return
        }
        if (this.hardDeadlineReached(thread.id, inputRevision)) return
        if (error instanceof SupportCodeConfigurationChangedError) {
          return this.retryForCodeConfiguration(reply.id, thread, inputRevision)
        }
        if (error instanceof ProjectCodeSyncUnavailableError) {
          if (!this.current(thread.id, inputRevision)) return this.supersede(reply.id)
          const currentService = this.deps.database.readProjectServices("WHERE id=? AND enabled=1", [service.id])[0]
          return await this.failWithoutSnapshot(
            reply.id, thread, inputRevision, group, currentService?.branch ?? service.branch, error,
          )
        }
        if (error instanceof SupportCodeSyncRuntimeError) {
          return await this.failInvestigationRuntime(reply.id, thread, inputRevision, group, error.message)
        }
        throw error
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const currentReply = this.deps.replies.getDetail(reply.id)
        if (currentReply.status === "sending") {
          this.deps.replies.transition(reply.id, "failed", {
            errorCode: "delivery_state_unknown",
            decisionReason: "问题关闭时 Telegram 发送结果未知",
            operatorDeliveryStatus: "uncertain",
          })
        } else if (!this.current(thread.id, inputRevision)) this.supersede(reply.id)
        return
      }
      if (this.hardDeadlineReached(thread.id, inputRevision)) return
      const current = this.deps.replies.getDetail(reply.id)
      if (!this.current(thread.id, inputRevision)) {
        this.supersede(reply.id)
        return
      }
      if (current.status === "generating") {
        const timeout = error instanceof CodexExecutionTimeoutError
          || (error instanceof Error && error.name === "CodexExecutionTimeoutError")
          || (error instanceof ModelExecutionError && error.code === "provider_timeout")
        const limit = configuredAnswerTimeoutSeconds
        const structuredOutputInvalid = error instanceof ModelExecutionError
          && error.code === "structured_output_invalid"
        const errorCode = timeout
          ? "answer_model_timeout"
          : structuredOutputInvalid
            ? "structured_output_invalid"
            : "answer_model_failed"
        const rejectedOutputReason = error instanceof SupportModelOutputRejectedError
          ? `${error.name}：${this.deps.redactor.redact(error.message).text}`.slice(0, 1_800)
          : null
        const failureReason = timeout
          ? `回答模型达到当前配置上限（${limit} 秒）`
          : rejectedOutputReason
            ?? (error instanceof ModelExecutionError
              ? `${error.name}(${error.code})：${this.deps.redactor.redact(error.message).text}`
              : `回答模型执行失败：${error instanceof Error ? error.name : "unknown"}`)
        if (await this.handoffClaimedHumanPriority(
          reply.id, thread, inputRevision, group, failureReason, errorCode,
        )) return
        this.deps.replies.transition(reply.id, "failed", {
          errorCode,
          decisionReason: timeout
            ? `回答模型达到当前配置上限（${limit} 秒），未向运营群发送代码兜底文案。`
            : rejectedOutputReason
              ? `${rejectedOutputReason}，未向运营群发送代码兜底文案。`
              : structuredOutputInvalid
                ? `${failureReason}；本次未向运营群发送代码兜底文案。`
                : `回答模型执行失败，未向运营群发送代码兜底文案：${error instanceof Error ? error.name : "unknown"}`,
          decisionConfidence: 0,
        })
        if (structuredOutputInvalid && this.structuredOutputFailureCount(thread.id, inputRevision) < 2) {
          if (this.deps.store.retryGeneration(thread.id, inputRevision)) this.wake()
          return
        }
        this.deps.store.finishGeneration(thread.id, inputRevision, "answered")
        return
      }
      if (current.status === "sending") {
        const state = deliveryState(error)
        const deliveryReason = state === "uncertain" ? "运营群回复发送结果未知" : "运营群回复发送失败"
        this.deps.replies.transition(reply.id, "failed", {
          errorCode: state === "uncertain" ? "delivery_state_unknown" : "support_delivery_failed",
          decisionReason: `${current.decisionReason ? `${current.decisionReason}\n` : ""}${deliveryReason}`.slice(0, 2000),
          operatorDeliveryStatus: state,
        })
        const alertKind = "support_delivery_failure" as const
        if (!this.deps.replies.claimTechnicalAlert(reply.id, alertKind)) return
        try {
          const alert = await this.deps.technicalAlerts.sendSupportAlert(
            group, reply.id,
            state === "uncertain" ? "运营群回复发送结果未知，需要人工确认是否送达。" : "运营群回复发送失败，需要技术继续处理。",
            current.answer || undefined,
            alertKind,
          )
          this.deps.replies.completeTechnicalAlert(reply.id, alertKind, alert.status)
        } catch {
          this.deps.replies.completeTechnicalAlert(reply.id, alertKind, "failed")
        }
        this.deps.store.finishGeneration(thread.id, inputRevision, "escalated")
      }
    } finally {
      clearInterval(heartbeat)
      if (processingSlotAcquired) this.releaseProcessingSlot()
      if (this.controllers.get(controllerKey) === controller) this.controllers.delete(controllerKey)
    }
  }

  private async sendPendingEscalationDeliveryFailure(): Promise<boolean> {
    const reply = this.deps.replies.findPendingEscalationDeliveryFailure()
    if (!reply?.threadId) return false
    const group = this.deps.database.readGroups().find((item) => item.id === reply.groupId)
    if (!group) return false
    const alertKind = "support_delivery_failure" as const
    if (!this.deps.replies.claimTechnicalAlert(reply.id, alertKind)) return false
    try {
      const alert = await this.deps.technicalAlerts.sendSupportAlert(
        group,
        reply.id,
        reply.operatorDeliveryStatus === "uncertain"
          ? "运营群回复发送结果未知，需要人工确认是否送达。"
          : "运营群回复发送失败，需要技术继续处理。",
        reply.answer || undefined,
        alertKind,
      )
      this.deps.replies.completeTechnicalAlert(reply.id, alertKind, alert.status)
    } catch {
      this.deps.replies.completeTechnicalAlert(reply.id, alertKind, "failed")
    }
    return true
  }

  private semanticQuestion(message: SupportThreadDetailMessage, thread: SupportThread): string {
    if (message.relation === "origin") {
      const summary = thread.summary.trim()
      const candidates = (["support", "technical_alert"] as const).flatMap((purpose) => {
        const route = routeSupportMessage({
          purpose,
          senderRole: message.event.senderRole,
          canCorrect: false,
          text: message.event.safeText,
        })
        return route.action === "process" ? [route.question] : []
      })
      const snapshotted = candidates.find((candidate) => candidate === summary)
      if (snapshotted !== undefined) return snapshotted
      if (/^\/ai(?:@\w+)?(?:\s|$)/iu.test(message.event.safeText.trim())) return summary
    }
    return message.questionFragment.trim() || message.event.safeText.trim()
  }

  private question(detail: SupportThreadDetail): string {
    return fitQuestion(detail.messages.map((message) => {
      const sender = message.event.senderDisplayName || message.event.senderUsername || message.event.senderUserId
      const text = this.semanticQuestion(message, detail.thread)
      const attachmentSummary = message.event.attachmentSummary.trim()
      const attachment = attachmentSummary ? `\n附件：${attachmentSummary}` : ""
      return `[${sender} ${message.event.createdAt}]\n${text}${attachment}`
    }).join("\n\n"))
  }

  private latestQuestion(detail: SupportThreadDetail): string {
    const message = detail.messages.at(-1)
    return message ? this.semanticQuestion(message, detail.thread) : ""
  }

  private conversationContext(
    detail: SupportThreadDetail,
    currentReplyId: string,
  ): { value: string; hasThreadHistory: boolean } {
    const previous = this.deps.database.readReplies(`WHERE r.thread_id=? AND r.id<>?
      AND r.status IN ('replied','escalated','corrected') AND p.answer<>''
      ORDER BY r.updated_at,r.id`, [detail.thread.id, currentReplyId])
    const threadTurns = [
      ...detail.messages.map((message) => ({
        at: message.event.createdAt,
        order: message.position * 2,
        value: `[运营 ${message.event.createdAt} message_id=${message.event.telegramMessageId}]\n${this.semanticQuestion(message, detail.thread)}`,
      })),
      ...previous.map((reply, index) => ({
        at: reply.updatedAt,
        order: index * 2 + 1,
        value: `[客服 ${reply.updatedAt} reply_message_id=${reply.telegramReplyMessageId ?? "unknown"}]\n${reply.answer}`,
      })),
    ].sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order)
    const threadHistory = previous.length > 0
      ? threadTurns.map((turn) => turn.value).join("\n\n")
      : ""
    const nearbyHistory = this.recentGroupConversationContext(detail, currentReplyId)
    const sections = [
      ...(nearbyHistory ? [
        "【同群最近一小时语境 可能包含其他事项 只用于理解指代和承接关系 不代表已核实证据】",
        nearbyHistory,
      ] : []),
      ...(threadHistory ? ["【当前问题线程历史】", threadHistory] : []),
    ]
    return {
      value: sections.length > 0 ? fitQuestion(sections.join("\n\n")) : "",
      hasThreadHistory: previous.length > 0,
    }
  }

  private recentGroupConversationContext(detail: SupportThreadDetail, currentReplyId: string): string {
    const latestAt = detail.thread.latestMessageAt
    const latestTimestamp = Date.parse(latestAt)
    if (!Number.isFinite(latestTimestamp)) return ""
    const cutoff = new Date(latestTimestamp - recentGroupContextWindowMs).toISOString()
    type NearbyRow = {
      kind: "operator" | "support"
      created_at: string
      stable_id: string
      sender_display_name: string | null
      sender_username: string | null
      sender_role: string | null
      text: string
      attachment_summary: string | null
    }
    const operatorRows = this.deps.database.prepare(`SELECT
        'operator' AS kind,e.created_at,e.id AS stable_id,e.sender_display_name,e.sender_username,e.sender_role,
        e.safe_text AS text,e.attachment_summary
      FROM support_message_events e INDEXED BY support_message_events_recent_idx
      WHERE e.group_id=? AND e.created_at>=? AND e.created_at<?
        AND NOT EXISTS (
          SELECT 1 FROM support_thread_messages linked
          WHERE linked.message_event_id=e.id AND linked.thread_id=?
        )
      ORDER BY e.created_at DESC LIMIT 80`).all(
      detail.thread.groupId,
      cutoff,
      latestAt,
      detail.thread.id,
    ) as NearbyRow[]
    const supportRows = this.deps.database.prepare(`SELECT
        'support' AS kind,r.updated_at AS created_at,r.id AS stable_id,
        NULL AS sender_display_name,NULL AS sender_username,NULL AS sender_role,
        p.answer AS text,NULL AS attachment_summary
      FROM support_replies r INDEXED BY support_replies_group_recent_idx
      JOIN support_reply_payloads p ON p.reply_id=r.id
      WHERE r.group_id=? AND r.service_id=? AND r.id<>?
        AND r.created_at>=? AND r.created_at<?
        AND r.status IN ('replied','escalated','corrected')
        AND r.operator_delivery_status='sent' AND p.answer<>''
        AND (r.thread_id IS NULL OR r.thread_id<>?)
      ORDER BY r.created_at DESC,r.id DESC LIMIT 80`).all(
      detail.thread.groupId,
      detail.thread.serviceId,
      currentReplyId,
      cutoff,
      latestAt,
      detail.thread.id,
    ) as NearbyRow[]
    const items = [...operatorRows, ...supportRows]
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.stable_id.localeCompare(right.stable_id))
      .slice(-recentGroupContextMaximumItems)
      .map((row) => {
        const text = row.text.trim() || (row.attachment_summary?.trim() ? `[附件 ${row.attachment_summary.trim()}]` : "")
        if (!text) return ""
        if (row.kind === "support") return `[客服 ${row.created_at}]\n${text}`
        const sender = row.sender_display_name?.trim() || row.sender_username?.trim() || "群成员"
        const role = row.sender_role ? "人工" : "运营"
        return `[${role} ${sender} ${row.created_at}]\n${text}`
      })
      .filter(Boolean)
    let value = items.join("\n\n")
    if (value.length > recentGroupContextMaximumChars) {
      value = `[较早同群消息已省略]\n\n${value.slice(-recentGroupContextMaximumChars)}`
    }
    return value
  }

  private attachments(detail: SupportThreadDetail): SupportAttachmentContext[] {
    return detail.messages.flatMap((message) => message.attachments.map((attachment) => ({
      name: attachment.fileName,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      size: attachment.fileSize,
      extractedText: attachment.extractedText,
      localPath: attachment.storagePath || null,
    })))
  }

  private async applyDecision(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
    decision: AnswerDecision,
    codeRevision: string | null,
    allowedMemoryIds: Set<string>,
    originText: string,
  ): Promise<void> {
    if (decision.decision === "ignore") {
      if (await this.handoffClaimedHumanPriority(
        replyId,
        thread,
        inputRevision,
        group,
        `回答模型选择忽略：${decision.reason}`,
        "answer_ignored_after_human_priority",
        codeRevision,
      )) return
      this.deps.replies.transition(replyId, "ignored", {
        codeRevision,
        decisionReason: decision.reason,
        decisionConfidence: decision.confidence,
      })
      this.deps.store.finishGeneration(thread.id, inputRevision, "closed")
      this.deps.learning.enqueue(replyId)
      return
    }
    if (decision.decision === "escalate") {
      if (decision.escalationType === "feature_request") {
        return this.forwardFeatureRequest(
          replyId, thread, inputRevision, group, decision, codeRevision, allowedMemoryIds,
        )
      }
      return this.escalate(
        replyId, thread, inputRevision, group, decision, codeRevision, allowedMemoryIds,
      )
    }
    const safe = this.deps.redactor.assertSafeOutbound(decision.answer)
    if (!safe.allowed) {
      throw new Error("回答模型输出命中敏感信息拦截")
    }
    const answer = this.deps.redactor.assertSafeOutbound(decision.answer).safeText.trim()
    if (!answer || garbled(answer)) {
      throw new Error("回答模型输出为空或包含乱码")
    }
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    const quote = decision.quote && originText.includes(decision.quote) ? decision.quote : null
    const memoryVersionRefs = decision.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id))
    const sending = this.deps.replies.claimSending(replyId, {
      answer,
      quote,
      codeRevision,
      memoryVersionRefs,
      errorCode: null,
      decisionReason: decision.reason,
      decisionConfidence: decision.confidence,
    })
    if (!sending) return
    const messageId = await this.deps.transport.sendMessage(
      group.accountId,
      group.telegramChatId!,
      answer,
      this.replyTargetMessageId(replyId, thread),
      quote,
      { groupId: group.id, threadId: thread.id, serviceId: thread.serviceId, replyId, kind: "support_reply" },
    )
    this.deps.replies.transition(replyId, "replied", { telegramReplyMessageId: messageId })
    if (sending.senderUserId) this.deps.store.setSenderFocusAfterDeliveredReply(
      thread.id, sending.senderUserId, messageId,
    )
    this.deps.store.finishGeneration(thread.id, inputRevision, "answered")
    this.deps.learning.enqueue(replyId)
  }

  private async forwardFeatureRequest(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
    decision: AnswerDecision,
    codeRevision: string | null,
    allowedMemoryIds: Set<string>,
  ): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    const proposedAnswer = decision.answer.trim()
    const outbound = this.deps.redactor.assertSafeOutbound(proposedAnswer)
    if (!outbound.allowed || !outbound.safeText.trim() || garbled(outbound.safeText)) {
      throw new Error("产品需求的模型回复未通过发送前安全校验")
    }
    const answer = outbound.safeText.trim()
    const memoryVersionRefs = decision.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id))
    const prepared = this.deps.replies.prepareTechnicalEscalation(replyId, {
      answer,
      quote: null,
      codeRevision,
      decisionReason: decision.reason,
      decisionConfidence: decision.confidence,
      memoryVersionRefs,
    })
    if (!prepared) return

    try {
      await this.deps.technicalAlerts.sendTransientFeatureRequest?.(
        group,
        replyId,
        decision.reason,
        answer,
      )
    } catch { /* 产品需求即时通知失败不持久化也不阻止运营回复。 */ }

    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    const sending = this.deps.replies.claimSending(replyId, {
      answer,
      quote: null,
      codeRevision,
      errorCode: null,
      decisionReason: decision.reason,
      decisionConfidence: decision.confidence,
      memoryVersionRefs,
    })
    if (!sending) return
    try {
      const operatorMessageId = await this.deps.transport.sendMessage(
        group.accountId,
        group.telegramChatId!,
        answer,
        this.replyTargetMessageId(replyId, thread),
        undefined,
        { groupId: group.id, threadId: thread.id, serviceId: thread.serviceId, replyId, kind: "support_reply" },
      )
      this.deps.replies.transition(replyId, "escalated", { telegramReplyMessageId: operatorMessageId })
      if (sending.senderUserId) this.deps.store.setSenderFocusAfterDeliveredReply(
        thread.id, sending.senderUserId, operatorMessageId,
      )
      this.deps.store.finishGeneration(thread.id, inputRevision, "escalated")
      this.deps.learning.enqueue(replyId)
    } catch (error) {
      const state = deliveryState(error)
      this.deps.replies.transition(replyId, "failed", {
        errorCode: state === "uncertain" ? "delivery_state_unknown" : "support_delivery_failed",
        decisionReason: `${decision.reason}\n运营群回复${state === "uncertain" ? "发送结果未知" : "发送失败"}`.slice(0, 2000),
        operatorDeliveryStatus: state,
      })
      this.deps.store.finishGeneration(thread.id, inputRevision, "escalated")
    }
  }

  private async escalate(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
    decision: AnswerDecision,
    codeRevision: string | null = null,
    allowedMemoryIds: Set<string> = new Set(),
  ): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    const memoryVersionRefs = decision.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id))
    const proposedAnswer = decision.answer.trim()
    const outbound = this.deps.redactor.assertSafeOutbound(proposedAnswer)
    if (!outbound.allowed || !outbound.safeText.trim() || garbled(outbound.safeText)) {
      throw new Error("技术升级的模型回复未通过发送前安全校验")
    }
    const answer = outbound.safeText.trim()
    const prepared = this.deps.replies.prepareTechnicalEscalation(replyId, {
      answer,
      quote: null,
      codeRevision,
      decisionReason: `${decision.reason}\n技术告警：发送中`.slice(0, 2000),
      decisionConfidence: decision.confidence,
      memoryVersionRefs,
    })
    if (!prepared) return
    await this.resumePreparedTechnicalEscalation(replyId, thread, inputRevision, group)
  }

  private async resumePreparedTechnicalEscalation(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
  ): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    let prepared = this.deps.replies.getDetail(replyId)
    let delivery = this.deps.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='escalation'`).get(replyId) as { status?: string } | undefined
    if (!delivery) {
      if (!this.deps.replies.claimTechnicalAlert(replyId, "escalation")) return
      const reason = (prepared.decisionReason ?? "已确认需要技术处理").replace(/\n技术告警：发送中$/u, "")
      let alert: TechnicalAlertDelivery
      try {
        alert = await this.deps.technicalAlerts.sendSupportAlert(group, replyId, reason, prepared.answer, "escalation")
        this.deps.replies.completeTechnicalAlert(replyId, "escalation", alert.status)
      } catch {
        alert = { status: "failed", summary: "发送失败：技术告警执行异常", errorType: "unknown" }
        this.deps.replies.completeTechnicalAlert(replyId, "escalation", alert.status)
      }
      const decisionReason = `${reason}\n技术告警：${alert.summary}`.slice(0, 2000)
      this.deps.replies.updateInvestigationProgress(replyId, {
        codeRevision: prepared.codeRevision ?? "",
        codeSnapshotId: prepared.codeSnapshotId,
        codeSyncBatchId: prepared.codeSyncBatchId,
        summary: decisionReason,
      })
      prepared = this.deps.replies.getDetail(replyId)
      delivery = { status: alert.status }
    }
    if (delivery.status === "sending") return
    await this.sendPreparedEscalationOperator(prepared.id, thread, inputRevision, group)
  }

  private async sendPreparedEscalationOperator(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
  ): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    const prepared = this.deps.replies.getDetail(replyId)
    const delivery = this.deps.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='escalation'`).get(replyId) as { status?: string } | undefined
    const alertSummary = delivery?.status === "sent" ? "已发送"
      : delivery?.status === "not_configured" ? "技术告警群未配置"
        : delivery?.status === "uncertain" ? "发送结果未知"
          : "发送失败"
    const baseReason = (prepared.decisionReason ?? "已确认需要技术处理").replace(/\n技术告警：[^\n]*$/u, "")
    const decisionReason = `${baseReason}\n技术告警：${alertSummary}`.slice(0, 2000)
    const sending = this.deps.replies.claimSending(replyId, {
      answer: prepared.answer,
      quote: null,
      codeRevision: prepared.codeRevision,
      errorCode: prepared.errorCode,
      decisionReason,
      decisionConfidence: prepared.decisionConfidence,
      memoryVersionRefs: prepared.memoryVersionRefs,
    })
    if (!sending) return
    try {
      const operatorMessageId = await this.deps.transport.sendMessage(
        group.accountId,
        group.telegramChatId!,
        prepared.answer,
        this.replyTargetMessageId(replyId, thread),
        undefined,
        { groupId: group.id, threadId: thread.id, serviceId: thread.serviceId, replyId, kind: "support_reply" },
      )
      this.deps.replies.transition(replyId, "escalated", { telegramReplyMessageId: operatorMessageId })
      if (sending.senderUserId) this.deps.store.setSenderFocusAfterDeliveredReply(
        thread.id, sending.senderUserId, operatorMessageId,
      )
      this.deps.store.finishGeneration(thread.id, inputRevision, "escalated")
      this.deps.learning.enqueue(replyId)
    } catch (error) {
      const state = deliveryState(error)
      const deliveryReason = state === "uncertain" ? "运营群回复发送结果未知" : "运营群回复发送失败"
      this.deps.replies.transition(replyId, "failed", {
        errorCode: state === "uncertain" ? "delivery_state_unknown" : "support_delivery_failed",
        decisionReason: `${decisionReason}\n${deliveryReason}`.slice(0, 2000),
        operatorDeliveryStatus: state,
      })
      const alertKind = "support_delivery_failure" as const
      if (this.deps.replies.claimTechnicalAlert(replyId, alertKind)) {
        try {
          const alert = await this.deps.technicalAlerts.sendSupportAlert(
            group,
            replyId,
            state === "uncertain" ? "运营群回复发送结果未知，需要人工确认是否送达。" : "运营群回复发送失败，需要技术继续处理。",
            prepared.answer,
            alertKind,
          )
          this.deps.replies.completeTechnicalAlert(replyId, alertKind, alert.status)
        } catch {
          this.deps.replies.completeTechnicalAlert(replyId, alertKind, "failed")
        }
      }
      this.deps.store.finishGeneration(thread.id, inputRevision, "escalated")
    }
  }

  private async failWithoutSnapshot(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
    branch: string,
    error: ProjectCodeSyncUnavailableError,
  ): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    if (await this.handoffClaimedHumanPriority(
      replyId, thread, inputRevision, group, error.message, "code_snapshot_unavailable",
    )) return
    const alertKind = "code_sync_unavailable" as const
    let alertSummary = "未发送"
    if (this.deps.replies.claimTechnicalAlert(replyId, alertKind)) {
      try {
        const alert = await this.deps.technicalAlerts.sendCodeSyncFailure({
          sourceGroup: group,
          replyId,
          branch,
          batchId: error.batchId,
          failure: error.failure,
          snapshot: null,
          additionalReason: `${error.message}；回答模型未运行，运营群保持静默。`,
        })
        alertSummary = alert.summary
        this.deps.replies.completeTechnicalAlert(replyId, alertKind, alert.status)
        this.deps.codeSync.recordAlert?.(error.batchId, alert)
      } catch (alertError) {
        this.deps.replies.completeTechnicalAlert(replyId, alertKind, "failed")
        throw alertError
      }
    }
    this.deps.replies.transition(replyId, "failed", {
      codeSyncBatchId: error.batchId,
      errorCode: "code_snapshot_unavailable",
      decisionReason: `${error.message}\n运营群未发送代码兜底文案\n技术告警：${alertSummary}`.slice(0, 2000),
    })
    this.deps.store.finishGeneration(thread.id, inputRevision, "answered")
  }

  private async failInvestigationRuntime(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
    reason: string,
  ): Promise<void> {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    if (await this.handoffClaimedHumanPriority(
      replyId, thread, inputRevision, group, reason, "investigation_runtime_failed",
    )) return
    const alertKind = "investigation_runtime_failure" as const
    let alertSummary = "未发送"
    if (this.deps.replies.claimTechnicalAlert(replyId, alertKind)) {
      try {
        const alert = await this.deps.technicalAlerts.sendSupportAlert(
          group,
          replyId,
          `${reason}；回答模型未形成回复，运营群保持静默。`,
          undefined,
          alertKind,
        )
        alertSummary = alert.summary
        this.deps.replies.completeTechnicalAlert(replyId, alertKind, alert.status)
      } catch (error) {
        this.deps.replies.completeTechnicalAlert(replyId, alertKind, "failed")
        throw error
      }
    }
    this.deps.replies.transition(replyId, "failed", {
      errorCode: "investigation_runtime_failed",
      decisionReason: `${reason}\n运营群未发送代码兜底文案\n运行告警：${alertSummary}`.slice(0, 2000),
    })
    this.deps.store.finishGeneration(thread.id, inputRevision, "answered")
  }

  private async handoffClaimedHumanPriority(
    replyId: string,
    thread: SupportThread,
    inputRevision: number,
    group: RuntimeGroup,
    reason: string,
    errorCode: string,
    codeRevision: string | null = null,
  ): Promise<boolean> {
    if (!this.deps.store.hasClaimedHumanPriority(thread.id)) return false
    if (!this.current(thread.id, inputRevision)) {
      this.supersede(replyId)
      return true
    }
    const prepared = this.deps.replies.prepareTechnicalEscalation(replyId, {
      answer: operatorCopy.humanPriorityHandoff,
      quote: null,
      codeRevision,
      errorCode,
      decisionReason: `${reason}\n人工优先等待后的失败接管\n技术告警：发送中`.slice(0, 2000),
      decisionConfidence: 0,
      memoryVersionRefs: [],
    })
    if (!prepared) return false
    await this.resumePreparedTechnicalEscalation(replyId, thread, inputRevision, group)
    return true
  }

  private current(threadId: string, revision: number): boolean {
    return this.deps.store.isCurrentRevision(threadId, revision)
  }

  private async waitForPendingRouting(
    threadId: string,
    inputRevision: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (this.current(threadId, inputRevision) && this.deps.store.hasPendingRoutingEventForThread(threadId)) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("问题版本已变化"))
          return
        }
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort)
          resolve()
        }, 100)
        timer.unref()
        const abort = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
          reject(new Error("问题版本已变化"))
        }
        signal.addEventListener("abort", abort, { once: true })
      })
    }
  }

  private replyTargetMessageId(replyId: string, thread: SupportThread): string {
    return this.deps.replies.getDetail(replyId).telegramMessageId ?? thread.anchorMessageId
  }

  private hardDeadlineReached(threadId: string, revision: number, now = new Date()): boolean {
    try {
      const thread = this.deps.store.getThread(threadId)
      return thread.status === "generating" && thread.revision === revision
        && thread.hardDeadlineAt !== null && Date.parse(thread.hardDeadlineAt) <= now.getTime()
    } catch {
      return false
    }
  }

  private structuredOutputFailureCount(threadId: string, revision: number): number {
    return Number((this.deps.database.prepare(`SELECT COUNT(*) AS count FROM support_replies
      WHERE thread_id=? AND input_revision=? AND status='failed' AND error_code='structured_output_invalid'`)
      .get(threadId, revision) as { count: number }).count)
  }

  private retryForCodeConfiguration(replyId: string, thread: SupportThread, inputRevision: number): void {
    if (!this.current(thread.id, inputRevision)) return this.supersede(replyId)
    this.supersede(replyId, "服务代码配置变化，旧回答已作废并重新生成")
    if (this.deps.store.retryGeneration(thread.id, inputRevision)) this.wake()
  }

  private async acquireProcessingSlot(maximum: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Codex 执行已取消")
    if (this.processingRunning < maximum) {
      this.processingRunning += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener("abort", cancel)
        resolve()
      }
      const cancel = () => {
        const index = this.processingWaiters.findIndex((waiter) => waiter.resume === resume)
        if (index >= 0) this.processingWaiters.splice(index, 1)
        reject(new Error("Codex 执行已取消"))
      }
      signal.addEventListener("abort", cancel, { once: true })
      this.processingWaiters.push({ maximum, resume })
    })
  }

  private releaseProcessingSlot(): void {
    this.processingRunning = Math.max(0, this.processingRunning - 1)
    this.drainProcessingWaiters()
  }

  private drainProcessingWaiters(): void {
    while (this.processingWaiters.length > 0) {
      const next = this.processingWaiters[0]
      if (!next || this.processingRunning >= next.maximum) break
      this.processingWaiters.shift()
      this.processingRunning += 1
      next.resume()
    }
  }

  private supersede(replyId: string, reason = "收到新的有效补充，旧结果已作废"): void {
    const reply = this.deps.replies.getDetail(replyId)
    if (reply.status === "generating") {
      this.deps.replies.transition(replyId, "superseded", { decisionReason: reason })
    }
  }

  private track(task: Promise<void>): void {
    this.active.add(task)
    void task.finally(() => this.active.delete(task))
  }
}
