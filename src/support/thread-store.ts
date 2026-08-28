import { randomUUID } from "node:crypto"

import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import {
  supportMessageAttachmentSchema,
  supportMessageEventSchema,
  supportThreadMessageSchema,
  supportThreadSchema,
  supportSenderFocusSchema,
  supportRouteClarificationSchema,
  runtimeModelBindingSchema,
  type SupportEventRouteStatus,
  type SupportMessageAttachment,
  type SupportMessageEvent,
  type SupportThread,
  type SupportThreadDetail,
  type SupportThreadRelation,
  type SupportSenderFocus,
  type SupportSenderFocusSource,
  type SupportRouteClarification,
  type ReplyStatus,
} from "../runtime/types.js"
import { resolveAnswerPolicy } from "./answer-policy.js"
import { baselineOperatorStyleProfile, operatorStyleProfileSchema } from "./operator-style.js"
import type { ThreadRouteTimelineEntry } from "./thread-router.js"

type SqlRow = Record<string, unknown>
type ExpiredReplyUpdate = {
  id: string
  status: ReplyStatus
  updatedAt: string
  durationMs: number | null
}
const THREAD_EXPIRY_MS = 30 * 60 * 1000
const DEFAULT_PROGRESS_DELAY_SECONDS = 180
const HARD_DEADLINE_MS = 60 * 60 * 1000
const HUMAN_PRIORITY_WAIT_MS = 3 * 60 * 1000
const HARD_DEADLINE_ERROR_CODE = "answer_hard_deadline"
export const FEATURE_REQUEST_PREPARED_ERROR_CODE = "feature_request_prepared"
export const TECHNICAL_AVAILABILITY_REPLY_PENDING = "__technical_availability_reply_pending__"

export type SupportThreadNotificationKind = "progress" | "timeout_operator" | "timeout_alert"
export type ThreadOutputClaimKind = "progress" | "handoff"
export type ThreadOutputClaimSource =
  | "scheduled_progress"
  | "status_request"
  | "human_priority"
  | "code_defect"
  | "technical_change"
  | "feature_request"
  | "service_handoff"
  | "human_operation"
  | "failure_after_progress"
  | "hard_deadline"
export type SupportThreadOutputClaim = {
  threadId: string
  claimKind: ThreadOutputClaimKind
  source: ThreadOutputClaimSource
  replyId: string | null
  notificationId: string | null
  createdAt: string
  updatedAt: string
}
export type SupportThreadNotification = {
  id: string
  threadId: string
  inputRevision: number
  kind: SupportThreadNotificationKind
  status: "pending" | "sending" | "sent" | "failed" | "unknown"
  dueAt: string
  telegramMessageId: string | null
  outboundText: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}
export type SupportTimeoutClaim = {
  threadId: string
  inputRevision: number
  outcome: "closed"
  replyId: null
  notificationKinds: [] | ["timeout_operator", "timeout_alert"]
} | {
  threadId: string
  inputRevision: number
  outcome: "prepared_escalation"
  replyId: string
  notificationKinds: []
} | {
  threadId: string
  inputRevision: number
  outcome: "delivery_in_flight"
  replyId: string
  notificationKinds: []
}
export type HumanPriorityClaim = {
  threadId: string
  inputRevision: number
  notificationId: string
}
export type CloseThreadResult = {
  changed: boolean
  thread: SupportThread
  replyUpdates: ExpiredReplyUpdate[]
}
export type HumanTakeoverResult = CloseThreadResult & {
  takeoverStatus: "cancelled" | "delivery_in_flight" | "thread_already_terminal"
}

function expiryTimes(reference: string | Date): { now: string; cutoff: string } {
  const date = typeof reference === "string" ? new Date(reference) : reference
  return {
    now: date.toISOString(),
    cutoff: new Date(date.getTime() - THREAD_EXPIRY_MS).toISOString(),
  }
}

export type RecordSupportEventInput = {
  groupId: string
  accountId: string | null
  telegramMessageId: string
  replyToMessageId: string | null
  messageThreadId: string | null
  mediaGroupId?: string | null
  senderUserId: string
  senderUsername: string | null
  senderDisplayName: string | null
  senderRole: "operator" | "technical" | "reviewer" | "ignored" | null
  text: string
  attachmentSummary: string
  routeStatus: SupportEventRouteStatus
  skipReason: string | null
  humanPriorityUserIds?: string[]
  humanPriorityTechnicalMention?: boolean
  humanPriorityIgnoredUserIds?: string[]
  createdAt?: string
}

export type CreateSupportThreadInput = {
  groupId: string
  projectId: string
  serviceId: string
  originBatchId: string
  settleAt: string
  anchorMessageId: string
  latestMessageAt: string
  summary: string
  originEventId?: string
  questionFragment?: string
}

export type CreateSupportThreadResult = {
  created: boolean
  thread: SupportThread
}

export type SenderFocusUpdate = {
  senderUserId: string
  source: SupportSenderFocusSource
  operatorMessageId: string | null
  botMessageId?: string | null
}

export type CreateRouteClarificationInput = {
  groupId: string
  serviceId: string
  senderUserId: string
  messageEventId: string
  candidates: Array<{ threadId: string; label: string }>
  createdAt?: string
}

export type ResolveRouteClarificationInput = {
  clarificationId: string
  answerEventIds: string[]
  selectedCandidate: number
  settleAt: string
}

export type ResolveRouteClarificationResult = {
  thread: SupportThread
  mode: "active" | "audit_only"
}

export type SenderRouteCandidate = { thread: SupportThread; label: string }

export type AppendThreadMessageInput = {
  threadId: string
  eventId: string
  relation: SupportThreadRelation
  questionFragment: string
  settleAt: string
  expectedRevision?: number
}

export type StatusOnlyBatchEntry = {
  message: AppendThreadMessageInput
  focus: SenderFocusUpdate
}

export type AuditBatchEntry = StatusOnlyBatchEntry

export type StatusOnlyProgressCommit = {
  thread: SupportThread
  notification: SupportThreadNotification | null
}

export type RecordSupportAttachmentInput = {
  name: string
  mimeType: string
  size: number
  kind: "text" | "image" | "video" | "archive" | "pdf" | "other"
  localPath: string | null
  extractedText: string
}

function threadFromRow(row: SqlRow): SupportThread {
  const operatorStyleProfile = operatorStyleProfileSchema.parse(JSON.parse(String(row.operator_style_profile_json)))
  const operatorStyleVersionId = supportThreadSchema.shape.operatorStyleVersionId.parse(row.operator_style_version_id)
  return supportThreadSchema.parse({
    id: row.id,
    groupId: row.group_id,
    projectId: row.project_id,
    serviceId: row.service_id,
    status: row.status,
    revision: Number(row.revision),
    settleAt: row.settle_at,
    anchorMessageId: row.anchor_message_id,
    latestMessageAt: row.latest_message_at,
    summary: row.summary,
    originBatchId: row.origin_batch_id,
    operatorStyleVersionId,
    operatorStyleProfile,
    answerModelInstanceId: row.answer_model_instance_id,
    answerReplyStyle: row.answer_reply_style,
    answerTimeoutSeconds: Number(row.answer_timeout_seconds),
    answerMaxConcurrency: Number(row.answer_max_concurrency),
    answerBindingEnabled: Number(row.answer_binding_enabled) === 1,
    answerIncludeAiMemory: Number(row.answer_include_ai_memory) === 1,
    answerIncludeInterfaceDocs: Number(row.answer_include_interface_docs) === 1,
    answerIncludeMagicBook: Number(row.answer_include_magic_book) === 1,
    answerOperationMode: row.answer_operation_mode,
    generationStartedAt: row.generation_started_at,
    progressDueAt: row.progress_due_at,
    hardDeadlineAt: row.hard_deadline_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedReason: row.closed_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function senderFocusFromRow(row: SqlRow): SupportSenderFocus {
  return supportSenderFocusSchema.parse({
    groupId: row.group_id,
    serviceId: row.service_id,
    senderUserId: row.sender_user_id,
    threadId: row.thread_id,
    source: row.source,
    lastOperatorMessageId: row.last_operator_message_id,
    lastBotMessageId: row.last_bot_message_id,
    focusedAt: row.focused_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function routeClarificationFromRow(row: SqlRow): SupportRouteClarification {
  return supportRouteClarificationSchema.parse({
    id: row.id,
    groupId: row.group_id,
    serviceId: row.service_id,
    senderUserId: row.sender_user_id,
    messageEventId: row.message_event_id,
    candidateThreadIds: JSON.parse(String(row.candidate_thread_ids_json)),
    candidateLabels: JSON.parse(String(row.candidate_labels_json)),
    status: row.status,
    promptReplyId: row.prompt_reply_id,
    selectedThreadId: row.selected_thread_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  })
}

function notificationFromRow(row: SqlRow): SupportThreadNotification {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    inputRevision: Number(row.input_revision),
    kind: row.kind as SupportThreadNotificationKind,
    status: row.status as SupportThreadNotification["status"],
    dueAt: String(row.due_at),
    telegramMessageId: row.telegram_message_id === null ? null : String(row.telegram_message_id),
    outboundText: row.outbound_text === null ? null : String(row.outbound_text),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function eventFromRow(row: SqlRow): SupportMessageEvent {
  return supportMessageEventSchema.parse({
    id: row.id,
    groupId: row.group_id,
    accountId: row.account_id,
    telegramMessageId: row.telegram_message_id,
    replyToMessageId: row.reply_to_message_id,
    messageThreadId: row.message_thread_id,
    mediaGroupId: row.media_group_id,
    senderUserId: row.sender_user_id,
    senderUsername: row.sender_username,
    senderDisplayName: row.sender_display_name,
    senderRole: row.sender_role,
    safeText: row.safe_text,
    attachmentSummary: row.attachment_summary,
    ingestBatchId: row.ingest_batch_id,
    routeStatus: row.route_status,
    skipReason: row.skip_reason,
    createdAt: row.created_at,
  })
}

function attachmentFromRow(row: SqlRow): SupportMessageAttachment {
  return supportMessageAttachmentSchema.parse({
    id: row.id,
    messageEventId: row.message_event_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    kind: row.kind,
    storagePath: row.storage_path,
    extractedText: row.extracted_text,
    createdAt: row.created_at,
  })
}

export class SupportThreadStore {
  constructor(
    readonly database: RuntimeDatabase,
    _redactor: ConfiguredSecretRedactor,
    private readonly onExpiredReply?: (event: ExpiredReplyUpdate) => void,
  ) {}

  recordEvent(input: RecordSupportEventInput): { created: boolean; event: SupportMessageEvent } {
    const found = this.findEvent(input.groupId, input.telegramMessageId)
    if (found) return { created: false, event: found }

    // 客服原始输入是排查证据，必须原样保存。敏感信息只在发送回复时做出站检查。
    const safeText = input.text
    const attachmentSummary = input.attachmentSummary.trim()
    const event: SupportMessageEvent = supportMessageEventSchema.parse({
      id: randomUUID(),
      groupId: input.groupId,
      accountId: input.accountId,
      telegramMessageId: input.telegramMessageId,
      replyToMessageId: input.replyToMessageId,
      messageThreadId: input.messageThreadId,
      mediaGroupId: input.mediaGroupId ?? null,
      senderUserId: input.senderUserId,
      senderUsername: input.senderUsername,
      senderDisplayName: input.senderDisplayName,
      senderRole: input.senderRole,
      safeText,
      attachmentSummary,
      ingestBatchId: null,
      routeStatus: input.routeStatus,
      skipReason: input.skipReason,
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    const humanPriorityUserIds = [...new Set((input.humanPriorityUserIds ?? []).filter((id) => /^\d+$/u.test(id)))]
    const humanPriorityTechnicalMention = input.humanPriorityTechnicalMention
      ?? this.includesEnabledTechnical(humanPriorityUserIds)
    const humanPriorityIgnoredUserIds = [...new Set(
      (input.humanPriorityIgnoredUserIds ?? humanPriorityUserIds.filter((id) => this.isEnabledIgnored(id)))
        .filter((id) => humanPriorityUserIds.includes(id)),
    )]
    const humanPriorityTargetsJson = JSON.stringify({
      userIds: humanPriorityUserIds,
      mentionedTechnical: humanPriorityTechnicalMention,
      ignoredUserIds: humanPriorityIgnoredUserIds,
    })
    const humanPriorityDueAt = humanPriorityUserIds.length > 0
      ? event.createdAt
      : null
    const result = this.database.prepare(`INSERT OR IGNORE INTO support_message_events(
      id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,media_group_id,sender_user_id,
      sender_username,sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,
      human_priority_user_ids_json,human_priority_due_at,route_status,skip_reason,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.id,
      event.groupId,
      event.accountId,
      event.telegramMessageId,
      event.replyToMessageId,
      event.messageThreadId,
      event.mediaGroupId,
      event.senderUserId,
      event.senderUsername,
      event.senderDisplayName,
      event.senderRole,
      event.safeText,
      event.attachmentSummary,
      event.ingestBatchId,
      humanPriorityTargetsJson,
      humanPriorityDueAt,
      event.routeStatus,
      event.skipReason,
      event.createdAt,
    )
    if (Number(result.changes) === 1) return { created: true, event }
    const duplicate = this.findEvent(input.groupId, input.telegramMessageId)
    if (!duplicate) throw new Error("客服消息事件保存失败")
    return { created: false, event: duplicate }
  }

  recordAttachments(eventId: string, inputs: RecordSupportAttachmentInput[]): SupportMessageAttachment[] {
    const createdAt = new Date().toISOString()
    const records = inputs.map((input) => supportMessageAttachmentSchema.parse({
      id: randomUUID(),
      messageEventId: eventId,
      fileName: input.name.slice(0, 500),
      mimeType: input.mimeType.slice(0, 240),
      fileSize: Math.max(0, Math.trunc(input.size)),
      kind: input.kind,
      storagePath: input.localPath ?? "",
      extractedText: input.extractedText.slice(0, 12000),
      createdAt,
    }))
    const insert = this.database.prepare(`INSERT INTO support_message_attachments(
      id,message_event_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`)
    this.database.transaction(() => records.forEach((record) => insert.run(
      record.id,
      record.messageEventId,
      record.fileName,
      record.mimeType,
      record.fileSize,
      record.kind,
      record.storagePath,
      record.extractedText,
      record.createdAt,
    )))
    return records
  }

  replaceEventAttachments(
    eventId: string,
    inputs: RecordSupportAttachmentInput[],
    attachmentSummary: string,
  ): { event: SupportMessageEvent; refreshedThreadIds: string[] } {
    const createdAt = new Date().toISOString()
    const records = inputs.map((input) => supportMessageAttachmentSchema.parse({
      id: randomUUID(),
      messageEventId: eventId,
      fileName: input.name.slice(0, 500),
      mimeType: input.mimeType.slice(0, 240),
      fileSize: Math.max(0, Math.trunc(input.size)),
      kind: input.kind,
      storagePath: input.localPath ?? "",
      extractedText: input.extractedText.slice(0, 12000),
      createdAt,
    }))
    const safeSummary = attachmentSummary.trim()
    const insert = this.database.prepare(`INSERT INTO support_message_attachments(
      id,message_event_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`)
    const refreshedThreadIds: string[] = []
    this.database.transaction(() => {
      this.getEvent(eventId)
      this.database.prepare("DELETE FROM support_message_attachments WHERE message_event_id=?").run(eventId)
      records.forEach((record) => insert.run(
        record.id,
        record.messageEventId,
        record.fileName,
        record.mimeType,
        record.fileSize,
        record.kind,
        record.storagePath,
        record.extractedText,
        record.createdAt,
      ))
      this.database.prepare("UPDATE support_message_events SET attachment_summary=? WHERE id=?").run(safeSummary, eventId)
      const threads = this.database.prepare(`SELECT DISTINCT t.id,t.status,t.revision,t.settle_at FROM support_threads t
        JOIN support_thread_messages tm ON tm.thread_id=t.id
        WHERE tm.message_event_id=? AND t.status<>'closed'`).all(eventId) as SqlRow[]
      threads.forEach((thread) => {
        const id = String(thread.id)
        if (this.hasHandoffClaim(id)) {
          this.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(createdAt, id)
          return
        }
        if (thread.status === "collecting") {
          this.database.prepare(`UPDATE support_threads SET
            settle_at=CASE WHEN settle_at<? THEN ? ELSE settle_at END,updated_at=? WHERE id=?`).run(
            createdAt, createdAt, createdAt, id,
          )
        } else {
          this.database.prepare(`UPDATE support_threads SET
            revision=revision+1,status='collecting',settle_at=?,generation_started_at=NULL,
            progress_due_at=NULL,hard_deadline_at=NULL,closed_at=NULL,closed_by=NULL,
            closed_reason=NULL,updated_at=? WHERE id=?`).run(createdAt, createdAt, id)
          this.supersedeUnstartedProgress(id, Number(thread.revision), createdAt)
        }
        refreshedThreadIds.push(id)
      })
    })
    return { event: this.getEvent(eventId), refreshedThreadIds }
  }

  updateEventRoute(id: string, status: SupportEventRouteStatus, skipReason: string | null = null): SupportMessageEvent {
    this.setEventRoute(id, status, skipReason)
    return this.getEvent(id)
  }

  assignEventBatch(id: string, batchId: string): SupportMessageEvent {
    const result = this.database.prepare(`UPDATE support_message_events SET ingest_batch_id=?
      WHERE id=? AND (ingest_batch_id IS NULL OR ingest_batch_id=?)`).run(batchId, id, batchId)
    if (Number(result.changes) !== 1) {
      const current = this.getEvent(id)
      if (current.ingestBatchId !== batchId) throw new Error("客服消息事件已归入其他接收批次")
    }
    return this.getEvent(id)
  }

  createThread(input: CreateSupportThreadInput): CreateSupportThreadResult {
    const now = new Date().toISOString()
    const thread = {
      id: randomUUID(),
      groupId: input.groupId,
      projectId: input.projectId,
      serviceId: input.serviceId,
      status: "collecting",
      revision: 1,
      settleAt: input.settleAt,
      anchorMessageId: input.anchorMessageId,
      latestMessageAt: input.latestMessageAt,
      summary: input.summary.trim().slice(0, 12_000),
      originBatchId: input.originBatchId,
      operatorStyleVersionId: null,
      operatorStyleProfile: baselineOperatorStyleProfile,
      answerOperationMode: "live",
      generationStartedAt: null,
      progressDueAt: null,
      hardDeadlineAt: null,
      closedAt: null,
      closedBy: null,
      closedReason: null,
      createdAt: now,
      updatedAt: now,
    }
    return this.database.transaction(() => {
      const existingBatch = this.database.prepare(
        "SELECT * FROM support_threads WHERE origin_batch_id=?",
      ).get(input.originBatchId) as SqlRow | undefined
      if (existingBatch) return { created: false, thread: threadFromRow(existingBatch) }
      const activeStyle = this.database.readActiveOperatorStyle()
      const group = this.database.readGroups().find((candidate) => candidate.id === input.groupId)
      if (!group) throw new Error("客服群配置不存在")
      const bindingRow = this.database.prepare(
        "SELECT * FROM runtime_model_bindings WHERE purpose='answer'",
      ).get() as SqlRow | undefined
      if (!bindingRow) throw new Error("回答运行模型绑定不存在")
      const binding = runtimeModelBindingSchema.parse({
        purpose: bindingRow.purpose,
        modelInstanceId: bindingRow.model_instance_id,
        timeoutSeconds: Number(bindingRow.timeout_seconds),
        maxConcurrency: Number(bindingRow.max_concurrency),
        enabled: Number(bindingRow.enabled) === 1,
        updatedAt: bindingRow.updated_at,
      })
      const answerPolicy = resolveAnswerPolicy(group, binding)
      const pinnedThread = supportThreadSchema.parse({
        ...thread,
        operatorStyleVersionId: activeStyle.versionId,
        operatorStyleProfile: activeStyle.profile,
        answerModelInstanceId: answerPolicy.modelInstanceId,
        answerReplyStyle: answerPolicy.replyStyle,
        answerTimeoutSeconds: binding.timeoutSeconds,
        answerMaxConcurrency: binding.maxConcurrency,
        answerBindingEnabled: binding.enabled,
        answerIncludeAiMemory: answerPolicy.includeAiMemory,
        answerIncludeInterfaceDocs: answerPolicy.includeInterfaceDocs,
        answerIncludeMagicBook: answerPolicy.includeMagicBook,
        answerOperationMode: group.operationMode ?? "live",
      })
      this.database.prepare(`INSERT INTO support_threads(
        id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
        origin_batch_id,operator_style_version_id,operator_style_profile_json,
        answer_model_instance_id,answer_reply_style,answer_timeout_seconds,answer_max_concurrency,
        answer_binding_enabled,answer_include_ai_memory,answer_include_interface_docs,answer_include_magic_book,answer_operation_mode,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        pinnedThread.id,
        pinnedThread.groupId,
        pinnedThread.projectId,
        pinnedThread.serviceId,
        pinnedThread.status,
        pinnedThread.revision,
        pinnedThread.settleAt,
        pinnedThread.anchorMessageId,
        pinnedThread.latestMessageAt,
        pinnedThread.summary,
        pinnedThread.originBatchId,
        pinnedThread.operatorStyleVersionId,
        JSON.stringify(pinnedThread.operatorStyleProfile),
        pinnedThread.answerModelInstanceId,
        pinnedThread.answerReplyStyle,
        pinnedThread.answerTimeoutSeconds,
        pinnedThread.answerMaxConcurrency,
        Number(pinnedThread.answerBindingEnabled),
        Number(pinnedThread.answerIncludeAiMemory),
        Number(pinnedThread.answerIncludeInterfaceDocs),
        Number(pinnedThread.answerIncludeMagicBook),
        pinnedThread.answerOperationMode,
        pinnedThread.createdAt,
        pinnedThread.updatedAt,
      )
      if (input.originEventId) {
        this.insertThreadMessage(pinnedThread.id, input.originEventId, "origin", input.questionFragment ?? pinnedThread.summary, 0, now)
        this.setEventRoute(input.originEventId, "routed", null)
        this.applyHumanPriorityFromEvent(pinnedThread.id, input.originEventId, now)
      }
      return { created: true, thread: this.getThread(pinnedThread.id) }
    })
  }

  createThreadWithSenderFocus(
    input: CreateSupportThreadInput,
    focus: SenderFocusUpdate,
  ): CreateSupportThreadResult {
    return this.database.transaction(() => {
      const result = this.createThread(input)
      this.upsertSenderFocus(result.thread, focus, input.latestMessageAt)
      return result
    })
  }

  getSenderFocus(
    groupId: string,
    serviceId: string,
    senderUserId: string,
    reference: string | Date = new Date(),
  ): SupportSenderFocus | null {
    const { now, cutoff } = expiryTimes(reference)
    const row = this.database.prepare(`SELECT focus.* FROM support_sender_focus focus
      JOIN support_threads thread ON thread.id=focus.thread_id
      WHERE focus.group_id=? AND focus.service_id=? AND focus.sender_user_id=?
        AND focus.expires_at>? AND thread.status<>'closed' AND thread.group_id=focus.group_id
        AND thread.service_id=focus.service_id AND thread.latest_message_at>?
      LIMIT 1`).get(groupId, serviceId, senderUserId, now, cutoff) as SqlRow | undefined
    return row ? senderFocusFromRow(row) : null
  }

  createRouteClarification(input: CreateRouteClarificationInput): SupportRouteClarification {
    return this.database.transaction(() => {
      if (input.candidates.length < 1 || input.candidates.length > 2) {
        throw new Error("待归属候选必须是一到两个")
      }
      const event = this.getEvent(input.messageEventId)
      if (event.groupId !== input.groupId || event.senderUserId !== input.senderUserId) {
        throw new Error("待归属消息与群或发送人不匹配")
      }
      const candidateIds = input.candidates.map((candidate) => candidate.threadId)
      if (new Set(candidateIds).size !== candidateIds.length) throw new Error("待归属候选不能重复")
      const candidateLabels = input.candidates.map((candidate) => candidate.label.trim())
      if (candidateLabels.some((label) => label.length < 1 || label.length > 240)) {
        throw new Error("待归属候选标签格式错误")
      }
      for (const threadId of candidateIds) {
        const valid = this.database.prepare(`SELECT 1 FROM support_threads thread
          WHERE thread.id=? AND thread.group_id=? AND thread.service_id=? AND thread.status<>'closed'
            AND EXISTS(SELECT 1 FROM support_thread_messages messages
              JOIN support_message_events events ON events.id=messages.message_event_id
              WHERE messages.thread_id=thread.id AND events.sender_user_id=?)`).get(
          threadId, input.groupId, input.serviceId, input.senderUserId,
        )
        if (!valid) throw new Error("待归属候选不属于当前发送人的有效线程")
      }
      const now = input.createdAt ?? event.createdAt
      const expiresAt = new Date(Date.parse(now) + THREAD_EXPIRY_MS).toISOString()
      const replaced = this.database.prepare(`SELECT message_event_id FROM support_route_clarifications
        WHERE group_id=? AND service_id=? AND sender_user_id=? AND status='pending'`).all(
        input.groupId, input.serviceId, input.senderUserId,
      ) as SqlRow[]
      this.database.prepare(`UPDATE support_route_clarifications SET
        status='cancelled',resolved_at=?,updated_at=?
        WHERE group_id=? AND service_id=? AND sender_user_id=? AND status='pending'`).run(
        now, now, input.groupId, input.serviceId, input.senderUserId,
      )
      replaced.forEach((row) => this.setEventRoute(
        String(row.message_event_id), "ignored", "新的待归属问题取代了旧确认",
      ))
      const clarification = supportRouteClarificationSchema.parse({
        id: randomUUID(),
        groupId: input.groupId,
        serviceId: input.serviceId,
        senderUserId: input.senderUserId,
        messageEventId: input.messageEventId,
        candidateThreadIds: candidateIds,
        candidateLabels,
        status: "pending",
        promptReplyId: null,
        selectedThreadId: null,
        createdAt: now,
        expiresAt,
        resolvedAt: null,
        updatedAt: now,
      })
      this.database.prepare(`INSERT INTO support_route_clarifications(
        id,group_id,service_id,sender_user_id,message_event_id,candidate_thread_ids_json,candidate_labels_json,
        status,prompt_reply_id,selected_thread_id,created_at,expires_at,resolved_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        clarification.id,
        clarification.groupId,
        clarification.serviceId,
        clarification.senderUserId,
        clarification.messageEventId,
        JSON.stringify(clarification.candidateThreadIds),
        JSON.stringify(clarification.candidateLabels),
        clarification.status,
        clarification.promptReplyId,
        clarification.selectedThreadId,
        clarification.createdAt,
        clarification.expiresAt,
        clarification.resolvedAt,
        clarification.updatedAt,
      )
      return clarification
    })
  }

  getPendingRouteClarification(
    groupId: string,
    serviceId: string,
    senderUserId: string,
    reference: string | Date = new Date(),
  ): SupportRouteClarification | null {
    const now = (typeof reference === "string" ? new Date(reference) : reference).toISOString()
    const row = this.database.prepare(`SELECT * FROM support_route_clarifications
      WHERE group_id=? AND service_id=? AND sender_user_id=? AND status='pending' AND expires_at>?
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(groupId, serviceId, senderUserId, now) as SqlRow | undefined
    return row ? routeClarificationFromRow(row) : null
  }

  listSenderRouteCandidates(
    groupId: string,
    serviceId: string,
    senderUserId: string,
    limit = 2,
    reference: string | Date = new Date(),
  ): SenderRouteCandidate[] {
    const { cutoff } = expiryTimes(reference)
    const bounded = Math.min(Math.max(limit, 1), 2)
    const rows = this.database.prepare(`SELECT thread.*,
      (SELECT COALESCE(NULLIF(TRIM(event.safe_text),''),TRIM(event.attachment_summary))
        FROM support_thread_messages message
        JOIN support_message_events event ON event.id=message.message_event_id
        WHERE message.thread_id=thread.id AND event.sender_user_id=?
        ORDER BY message.position DESC,event.created_at DESC LIMIT 1) AS sender_label
      FROM support_threads thread
      WHERE thread.group_id=? AND thread.service_id=? AND thread.status<>'closed' AND thread.latest_message_at>?
        AND EXISTS(SELECT 1 FROM support_thread_messages message
          JOIN support_message_events event ON event.id=message.message_event_id
          WHERE message.thread_id=thread.id AND event.sender_user_id=?)
      ORDER BY thread.updated_at DESC,thread.id DESC LIMIT ${bounded}`).all(
      senderUserId, groupId, serviceId, cutoff, senderUserId,
    ) as SqlRow[]
    return rows.map((row) => ({
      thread: threadFromRow(row),
      label: String(row.sender_label ?? row.summary).trim().slice(0, 240),
    })).filter((candidate) => candidate.label.length > 0)
  }

  cancelPendingRouteClarification(
    groupId: string,
    serviceId: string,
    senderUserId: string,
    cancelledAt = new Date().toISOString(),
  ): number {
    return this.database.transaction(() => {
      const pending = this.database.prepare(`SELECT message_event_id FROM support_route_clarifications
        WHERE group_id=? AND service_id=? AND sender_user_id=? AND status='pending'`).all(
        groupId, serviceId, senderUserId,
      ) as SqlRow[]
      const changed = Number(this.database.prepare(`UPDATE support_route_clarifications SET
        status='cancelled',resolved_at=?,updated_at=?
        WHERE group_id=? AND service_id=? AND sender_user_id=? AND status='pending'`).run(
        cancelledAt, cancelledAt, groupId, serviceId, senderUserId,
      ).changes)
      pending.forEach((row) => this.setEventRoute(
        String(row.message_event_id), "ignored", "待归属确认已取消",
      ))
      return changed
    })
  }

  markRouteClarificationPrompt(id: string, promptReplyId: string | null, updatedAt = new Date().toISOString()): boolean {
    if (!promptReplyId) return false
    const clarification = this.database.prepare(
      "SELECT message_event_id FROM support_route_clarifications WHERE id=?",
    ).get(id) as SqlRow | undefined
    if (!clarification) return false
    const claim = this.claimRouteClarificationPrompt(
      id,
      promptReplyId,
      String(clarification.message_event_id),
      updatedAt,
    )
    return claim.claimed || claim.promptReplyId === promptReplyId
  }

  claimRouteClarificationPrompt(
    id: string,
    promptReplyId: string,
    messageEventId: string,
    updatedAt = new Date().toISOString(),
  ): { claimed: boolean; promptReplyId: string | null } {
    return this.database.transaction(() => {
      const row = this.database.prepare(`SELECT status,prompt_reply_id,message_event_id
        FROM support_route_clarifications WHERE id=?`).get(id) as SqlRow | undefined
      if (!row || String(row.message_event_id) !== messageEventId || String(row.status) !== "pending") {
        return {
          claimed: false,
          promptReplyId: row?.prompt_reply_id === null || row?.prompt_reply_id === undefined
            ? null
            : String(row.prompt_reply_id),
        }
      }
      const existing = row.prompt_reply_id === null ? null : String(row.prompt_reply_id)
      if (existing) {
        this.setEventRoute(messageEventId, "routed", "待归属确认已进入发送链路")
        return { claimed: false, promptReplyId: existing }
      }
      const changed = Number(this.database.prepare(`UPDATE support_route_clarifications
        SET prompt_reply_id=?,updated_at=?
        WHERE id=? AND status='pending' AND prompt_reply_id IS NULL`).run(
        promptReplyId,
        updatedAt,
        id,
      ).changes) === 1
      if (!changed) {
        const current = this.database.prepare(
          "SELECT prompt_reply_id FROM support_route_clarifications WHERE id=?",
        ).get(id) as SqlRow | undefined
        return {
          claimed: false,
          promptReplyId: current?.prompt_reply_id === null || current?.prompt_reply_id === undefined
            ? null
            : String(current.prompt_reply_id),
        }
      }
      this.setEventRoute(messageEventId, "routed", "待归属确认已进入发送链路")
      return { claimed: true, promptReplyId }
    })
  }

  resolveRouteClarification(input: ResolveRouteClarificationInput): ResolveRouteClarificationResult {
    return this.database.transaction(() => {
      const row = this.database.prepare(`SELECT * FROM support_route_clarifications
        WHERE id=? AND status='pending'`).get(input.clarificationId) as SqlRow | undefined
      if (!row) throw new Error("待归属确认已失效或被其他处理领取")
      const clarification = routeClarificationFromRow(row)
      const selectedThreadId = clarification.candidateThreadIds[input.selectedCandidate - 1]
      if (!selectedThreadId) throw new Error("选择不在待归属候选集合内")
      if (input.answerEventIds.length < 1 || new Set(input.answerEventIds).size !== input.answerEventIds.length) {
        throw new Error("待归属回答批次必须非空且不能重复")
      }
      const answers = input.answerEventIds.map((eventId) => this.getEvent(eventId))
      if (answers.some((answer) => (
        answer.groupId !== clarification.groupId || answer.senderUserId !== clarification.senderUserId
      ))) {
        throw new Error("待归属回答与群或发送人不匹配")
      }
      if (answers.some((answer) => clarification.expiresAt <= answer.createdAt)) {
        throw new Error("待归属确认已过期")
      }
      const original = this.getEvent(clarification.messageEventId)
      const selected = this.getThread(selectedThreadId)
      const auditOnly = this.hasHandoffClaim(selectedThreadId)
      let resolved: SupportThread
      if (auditOnly) {
        const appended = this.appendAuditBatchWithSenderFocus(
          [original, ...answers].map((event, index) => ({
            message: {
              threadId: selectedThreadId,
              eventId: event.id,
              relation: "supplement",
              questionFragment: event.safeText || event.attachmentSummary,
              settleAt: input.settleAt,
              ...(index === 0 ? { expectedRevision: selected.revision } : {}),
            },
            focus: {
              senderUserId: event.senderUserId,
              source: "clarification_answer",
              operatorMessageId: event.telegramMessageId,
            },
          })),
        )
        if (!appended) throw new Error("待归属回答批次无法完整追加到候选线程")
        resolved = appended
      } else {
        resolved = selected
        for (const [index, event] of [original, ...answers].entries()) {
          const appended = this.appendMessage({
            threadId: selectedThreadId,
            eventId: event.id,
            relation: "supplement",
            questionFragment: event.safeText || event.attachmentSummary,
            settleAt: input.settleAt,
            ...(index === 0 ? { expectedRevision: selected.revision } : {}),
          })
          const linked = this.database.prepare(`SELECT 1 FROM support_thread_messages
            WHERE thread_id=? AND message_event_id=?`).get(selectedThreadId, event.id)
          if (!appended || !linked || this.getEvent(event.id).routeStatus !== "routed") {
            throw new Error("待归属回答批次无法完整追加到候选线程")
          }
          resolved = appended
        }
      }
      const firstAnswer = answers[0]!
      const lastAnswer = answers.at(-1)!
      const changed = Number(this.database.prepare(`UPDATE support_route_clarifications SET
        status='resolved',selected_thread_id=?,resolved_at=?,updated_at=? WHERE id=? AND status='pending'`).run(
        selectedThreadId, firstAnswer.createdAt, firstAnswer.createdAt, clarification.id,
      ).changes)
      if (changed !== 1) throw new Error("待归属确认状态发生冲突")
      if (!auditOnly) {
        this.upsertSenderFocus(resolved, {
          senderUserId: clarification.senderUserId,
          source: "clarification_answer",
          operatorMessageId: lastAnswer.telegramMessageId,
        }, lastAnswer.createdAt)
      }
      return { thread: resolved, mode: auditOnly ? "audit_only" : "active" }
    })
  }

  setSenderFocusAfterDeliveredReply(
    threadId: string,
    senderUserId: string,
    botMessageId: string,
    deliveredAt: string = new Date().toISOString(),
  ): boolean {
    return this.database.transaction(() => {
      const thread = this.getThread(threadId)
      if (thread.status === "closed") return false
      const operatorMessage = this.database.prepare(`SELECT event.telegram_message_id,event.created_at FROM support_thread_messages message
        JOIN support_message_events event ON event.id=message.message_event_id
        WHERE message.thread_id=? AND event.sender_user_id=?
        ORDER BY message.position DESC,event.created_at DESC LIMIT 1`).get(threadId, senderUserId) as SqlRow | undefined
      if (!operatorMessage) return false
      const operatorCreatedAt = String(operatorMessage.created_at)
      if (Date.parse(deliveredAt) >= Date.parse(operatorCreatedAt) + THREAD_EXPIRY_MS) return false
      const existingFocus = this.database.prepare(`SELECT thread_id,focused_at FROM support_sender_focus
        WHERE group_id=? AND service_id=? AND sender_user_id=?`).get(
        thread.groupId, thread.serviceId, senderUserId,
      ) as SqlRow | undefined
      if (existingFocus && String(existingFocus.thread_id) !== threadId
        && String(existingFocus.focused_at) > operatorCreatedAt) return false
      this.upsertSenderFocus(thread, {
        senderUserId,
        source: "operator_reply",
        operatorMessageId: String(operatorMessage.telegram_message_id),
        botMessageId,
      }, operatorCreatedAt)
      return true
    })
  }

  appendMessage(input: AppendThreadMessageInput): SupportThread | null {
    return this.database.transaction(() => {
      const current = this.getThread(input.threadId)
      if (this.hasHandoffClaim(current.id)) return null
      const event = this.getEvent(input.eventId)
      const sameAssignedBatch = event.ingestBatchId !== null && (
        current.originBatchId === event.ingestBatchId
        || Boolean(this.database.prepare(`SELECT 1 FROM support_message_events sibling
          JOIN support_thread_messages tm ON tm.message_event_id=sibling.id
          WHERE sibling.ingest_batch_id=? AND tm.thread_id=? LIMIT 1`).get(event.ingestBatchId, current.id))
      )
      if ((current.status === "closed" && !sameAssignedBatch)
        || (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)) {
        return null
      }
      const existingLink = this.database.prepare(
        "SELECT 1 FROM support_thread_messages WHERE thread_id=? AND message_event_id=? LIMIT 1",
      ).get(input.threadId, input.eventId)
      if (existingLink) return current
      const position = Number((this.database.prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM support_thread_messages WHERE thread_id=?",
      ).get(input.threadId) as SqlRow).position)
      const inserted = this.insertThreadMessage(
        input.threadId,
        input.eventId,
        input.relation,
        input.questionFragment,
        position,
        event.createdAt,
      )
      if (!inserted) return current
      const now = new Date().toISOString()
      const reopensFinishedGeneration = current.status === "answered"
        || current.status === "escalated"
        || current.status === "closed"
      this.database.prepare(`UPDATE support_threads SET
        revision=revision+1,status='collecting',
        human_priority_state=CASE
          WHEN ?=1 AND human_priority_state='claimed' THEN 'none' ELSE human_priority_state END,
        settle_at=CASE
          WHEN human_priority_state='waiting' AND human_priority_due_at>? THEN human_priority_due_at ELSE ? END,
        latest_message_at=?,
        generation_started_at=NULL,progress_due_at=NULL,hard_deadline_at=NULL,
        closed_at=NULL,closed_by=NULL,closed_reason=NULL,updated_at=? WHERE id=?`).run(
        reopensFinishedGeneration ? 1 : 0,
        input.settleAt,
        input.settleAt,
        event.createdAt,
        now,
        input.threadId,
      )
      this.supersedeUnstartedProgress(input.threadId, current.revision, now)
      this.setEventRoute(input.eventId, "routed", null)
      this.applyHumanPriorityFromEvent(input.threadId, input.eventId, now)
      return this.getThread(input.threadId)
    })
  }

  appendAuditMessage(input: AppendThreadMessageInput): SupportThread | null {
    return this.database.transaction(() => {
      const current = this.getThread(input.threadId)
      if (!this.hasHandoffClaim(current.id)
        || (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)) return null
      const event = this.getEvent(input.eventId)
      const existingLink = this.database.prepare(
        "SELECT 1 FROM support_thread_messages WHERE thread_id=? AND message_event_id=? LIMIT 1",
      ).get(input.threadId, input.eventId)
      if (existingLink) {
        this.setEventRoute(input.eventId, "routed", "handoff_terminal:audit_only")
        return current
      }
      const position = Number((this.database.prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM support_thread_messages WHERE thread_id=?",
      ).get(input.threadId) as SqlRow).position)
      const inserted = this.insertThreadMessage(
        input.threadId,
        input.eventId,
        "supplement",
        input.questionFragment,
        position,
        event.createdAt,
      )
      if (!inserted) return current
      const now = new Date().toISOString()
      this.database.prepare(`UPDATE support_threads SET
        latest_message_at=CASE WHEN latest_message_at<? THEN ? ELSE latest_message_at END,updated_at=?
        WHERE id=? AND revision=? AND EXISTS(
          SELECT 1 FROM support_thread_output_claims claim
          WHERE claim.thread_id=support_threads.id AND claim.claim_kind='handoff'
        )`).run(event.createdAt, event.createdAt, now, current.id, current.revision)
      this.setEventRoute(input.eventId, "routed", "handoff_terminal:audit_only")
      return this.getThread(current.id)
    })
  }

  appendAuditMessageWithSenderFocus(
    input: AppendThreadMessageInput,
    focus: SenderFocusUpdate,
  ): SupportThread | null {
    return this.database.transaction(() => {
      const appended = this.appendAuditMessage(input)
      if (!appended) return null
      const event = this.getEvent(input.eventId)
      this.upsertSenderFocus(appended, focus, event.createdAt)
      return appended
    })
  }

  appendAuditBatchWithSenderFocus(entries: AuditBatchEntry[]): SupportThread | null {
    if (entries.length < 1) throw new Error("handoff audit 批次不能为空")
    if (new Set(entries.map((entry) => entry.message.eventId)).size !== entries.length) {
      throw new Error("handoff audit 批次事件不能重复")
    }
    return this.database.transaction(() => {
      const first = entries[0]!
      const current = this.getThread(first.message.threadId)
      if (!this.hasHandoffClaim(current.id)
        || (first.message.expectedRevision !== undefined
          && current.revision !== first.message.expectedRevision)) return null
      let appended = current
      for (const entry of entries) {
        if (entry.message.threadId !== current.id) throw new Error("handoff audit 批次不能跨线程")
        const event = this.getEvent(entry.message.eventId)
        if (entry.focus.senderUserId !== event.senderUserId
          || entry.focus.operatorMessageId !== event.telegramMessageId) {
          throw new Error("handoff audit sender focus 与原始数字发送人不一致")
        }
        const next = this.appendAuditMessage(entry.message)
        const linked = this.database.prepare(`SELECT 1 FROM support_thread_messages
          WHERE thread_id=? AND message_event_id=?`).get(current.id, event.id)
        if (!next || !linked || this.getEvent(event.id).routeStatus !== "routed") {
          throw new Error("handoff audit 批次无法完整追加到终态线程")
        }
        this.upsertSenderFocus(next, {
          ...entry.focus,
          senderUserId: event.senderUserId,
          operatorMessageId: event.telegramMessageId,
        }, event.createdAt)
        appended = next
      }
      return appended
    })
  }

  appendStatusOnlyMessage(input: AppendThreadMessageInput): SupportThread | null {
    return this.database.transaction(() => {
      const current = this.getThread(input.threadId)
      const event = this.getEvent(input.eventId)
      if ((current.status !== "collecting" && current.status !== "generating")
        || (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)) {
        return null
      }
      const existingLink = this.database.prepare(
        "SELECT 1 FROM support_thread_messages WHERE thread_id=? AND message_event_id=? LIMIT 1",
      ).get(input.threadId, input.eventId)
      if (existingLink) return current
      const position = Number((this.database.prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM support_thread_messages WHERE thread_id=?",
      ).get(input.threadId) as SqlRow).position)
      const inserted = this.insertThreadMessage(
        input.threadId,
        input.eventId,
        input.relation,
        input.questionFragment,
        position,
        event.createdAt,
      )
      if (!inserted) return current
      const now = new Date().toISOString()
      this.database.prepare(`UPDATE support_threads SET
        latest_message_at=CASE WHEN latest_message_at<? THEN ? ELSE latest_message_at END,updated_at=?
        WHERE id=? AND revision=? AND status IN ('collecting','generating')`).run(
        event.createdAt,
        event.createdAt,
        now,
        input.threadId,
        current.revision,
      )
      this.database.prepare(`UPDATE support_replies SET
        telegram_message_id=?,sender_user_id=?,sender_username=?,sender_display_name=?,sender_role=?,updated_at=?
        WHERE thread_id=? AND input_revision=? AND status IN ('pending','queued','generating')`).run(
        event.telegramMessageId,
        event.senderUserId,
        event.senderUsername,
        event.senderDisplayName,
        event.senderRole,
        now,
        input.threadId,
        current.revision,
      )
      this.setEventRoute(input.eventId, "batched", "已归入当前排查，等待进度回复完成")
      return this.getThread(input.threadId)
    })
  }

  appendStatusOnlyMessageWithSenderFocus(
    input: AppendThreadMessageInput,
    focus: SenderFocusUpdate,
  ): SupportThread | null {
    return this.database.transaction(() => {
      const appended = this.appendStatusOnlyMessage(input)
      if (!appended) return null
      const event = this.getEvent(input.eventId)
      this.upsertSenderFocus(appended, focus, event.createdAt)
      return appended
    })
  }

  appendStatusOnlyBatchAndClaimProgress(
    entries: StatusOnlyBatchEntry[],
    now = new Date().toISOString(),
  ): StatusOnlyProgressCommit | null {
    if (entries.length === 0) return null
    const threadId = entries[0]!.message.threadId
    if (entries.some((entry) => entry.message.threadId !== threadId)) {
      throw new Error("status-only 批次只能归入同一问题线程")
    }
    return this.database.transaction(() => {
      let current = this.getThread(threadId)
      if (current.status !== "collecting" && current.status !== "generating") return null
      for (const entry of entries) {
        const appended = this.appendStatusOnlyMessageWithSenderFocus(entry.message, entry.focus)
        if (!appended) throw new Error("status-only 批次关联时问题版本已变化")
        current = appended
      }
      const notification = current.answerOperationMode === "live"
        ? this.claimProgressNotification(
          current.id,
          current.revision,
          "status_request",
          now,
          now,
        )
        : null
      const routeReason = current.answerOperationMode !== "live"
        ? "status_only:telegram_output_suppressed"
        : notification
          ? "status_only:progress_claim_persisted"
          : "status_only:progress_claim_already_owned"
      entries.forEach((entry) => this.setEventRoute(entry.message.eventId, "routed", routeReason))
      return { thread: current, notification }
    })
  }

  hasPendingRoutingEventForThread(threadId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM support_threads thread
      JOIN support_message_events event ON event.group_id=thread.group_id
        AND event.route_status IN ('received','batched')
        AND event.created_at>=COALESCE(thread.generation_started_at,thread.updated_at)
      WHERE thread.id=? AND thread.status='generating' AND (
        event.reply_to_message_id IN (
          SELECT source.telegram_message_id FROM support_thread_messages message
          JOIN support_message_events source ON source.id=message.message_event_id
          WHERE message.thread_id=thread.id
        )
        OR event.reply_to_message_id IN (
          SELECT ownership.telegram_message_id FROM telegram_output_ownership ownership
          WHERE ownership.thread_id=thread.id AND ownership.telegram_message_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM support_sender_focus focus
          WHERE focus.group_id=thread.group_id AND focus.service_id=thread.service_id
            AND focus.sender_user_id=event.sender_user_id AND focus.thread_id=thread.id
            AND focus.expires_at>event.created_at
        )
      ) LIMIT 1`).get(threadId))
  }

  appendMessageWithSenderFocus(
    input: AppendThreadMessageInput,
    focus: SenderFocusUpdate,
  ): SupportThread | null {
    return this.database.transaction(() => {
      const appended = this.appendMessage(input)
      if (!appended) return null
      const event = this.getEvent(input.eventId)
      this.upsertSenderFocus(appended, focus, event.createdAt)
      return appended
    })
  }

  archiveExpired(reference: string | Date = new Date()): number {
    const { now, cutoff } = expiryTimes(reference)
    const archived = this.database.transaction(() => {
      const replies = this.database.prepare(`SELECT r.id,r.status FROM support_replies r
        JOIN support_threads t ON t.id=r.thread_id
        WHERE t.status NOT IN ('closed','generating') AND t.latest_message_at<=?
          AND r.status IN ('pending','queued','generating','sending')`).all(cutoff) as SqlRow[]
      this.database.prepare(`UPDATE support_replies SET
        status='superseded',updated_at=?,decision_reason='问题超过30分钟已归档',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status IN ('pending','queued','generating') AND thread_id IN (
          SELECT id FROM support_threads WHERE status NOT IN ('closed','generating') AND latest_message_at<=?
        )`).run(now, now, cutoff)
      this.database.prepare(`UPDATE support_replies SET
        status='failed',operator_delivery_status='uncertain',updated_at=?,error_code='delivery_state_unknown',decision_reason='问题归档时发送状态未知',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND thread_id IN (
          SELECT id FROM support_threads WHERE status NOT IN ('closed','generating') AND latest_message_at<=?
        )`).run(now, now, cutoff)
      const result = this.database.prepare(`UPDATE support_threads SET
        status='closed',closed_at=?,closed_by='AI 客服',closed_reason='30分钟无新消息',updated_at=?
        WHERE status NOT IN ('closed','generating') AND latest_message_at<=?`).run(now, now, cutoff)
      this.database.prepare(`UPDATE support_route_clarifications SET
        status='expired',resolved_at=?,updated_at=?
        WHERE status='pending' AND expires_at<=?`).run(now, now, now)
      this.database.prepare(`DELETE FROM support_sender_focus
        WHERE expires_at<=? OR EXISTS(
          SELECT 1 FROM support_threads thread
          WHERE thread.id=support_sender_focus.thread_id AND thread.status='closed'
        )`).run(now)
      const replyUpdates = replies.length === 0 ? [] : this.database.prepare(
        `SELECT id,status,duration_ms FROM support_replies WHERE id IN (${replies.map(() => "?").join(",")})`,
      ).all(...replies.map((reply) => String(reply.id))) as SqlRow[]
      return {
        count: Number(result.changes),
        replies: replyUpdates.map((reply) => ({
          id: String(reply.id),
          status: reply.status as "superseded" | "failed",
          updatedAt: now,
          durationMs: reply.duration_ms === null ? null : Number(reply.duration_ms),
        })),
      }
    })
    archived.replies.forEach((event) => this.onExpiredReply?.(event))
    return archived.count
  }

  listRouteCandidates(groupId: string, serviceId: string, limit = 12, reference: string | Date = new Date()): SupportThread[] {
    const { cutoff } = expiryTimes(reference)
    this.archiveExpired(reference)
    this.closeExpiredGeneratingForRoute(groupId, serviceId, reference)
    const bounded = Math.min(Math.max(limit, 1), 50)
    return (this.database.prepare(`SELECT * FROM support_threads
      WHERE group_id=? AND service_id=? AND status<>'closed' AND latest_message_at>?
      ORDER BY updated_at DESC,id DESC LIMIT ${bounded}`).all(groupId, serviceId, cutoff) as SqlRow[]).map(threadFromRow)
  }

  findUniqueMinimalClarificationThread(
    groupId: string,
    serviceId: string,
    senderUserId: string,
    reference: string | Date = new Date(),
  ): SupportThread | null {
    const { cutoff } = expiryTimes(reference)
    this.archiveExpired(reference)
    const rows = this.database.prepare(`SELECT t.* FROM support_threads t
      JOIN support_replies r ON r.id=(
        SELECT latest.id FROM support_replies latest
        WHERE latest.thread_id=t.id AND latest.input_revision=t.revision
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
      )
      WHERE t.group_id=? AND t.service_id=? AND t.status='answered' AND t.latest_message_at>?
        AND r.sender_user_id=? AND r.status='replied' AND r.decision='reply'
        AND r.operator_delivery_status='sent'
        AND instr(COALESCE(r.decision_reason,''),'strategy=minimal_clarification')>0
      ORDER BY r.updated_at DESC,r.id DESC LIMIT 2`).all(
      groupId,
      serviceId,
      cutoff,
      senderUserId,
    ) as SqlRow[]
    return rows.length === 1 ? threadFromRow(rows[0]!) : null
  }

  findActiveThreadByTelegramMessage(
    groupId: string,
    serviceId: string,
    telegramMessageId: string,
    reference: string | Date = new Date(),
  ): SupportThread | null {
    const { cutoff } = expiryTimes(reference)
    this.archiveExpired(reference)
    const row = this.database.prepare(`SELECT t.* FROM support_threads t
      WHERE t.group_id=? AND t.service_id=? AND t.status<>'closed' AND t.latest_message_at>?
        AND (
          EXISTS(SELECT 1 FROM support_thread_messages tm
            JOIN support_message_events e ON e.id=tm.message_event_id
            WHERE tm.thread_id=t.id AND e.telegram_message_id=?)
          OR EXISTS(SELECT 1 FROM support_replies r
            WHERE r.thread_id=t.id AND r.telegram_reply_message_id=?)
          OR EXISTS(SELECT 1 FROM support_thread_notifications n
            WHERE n.thread_id=t.id AND n.telegram_message_id=?)
          OR EXISTS(SELECT 1 FROM telegram_output_ownership ownership
            WHERE ownership.thread_id=t.id AND ownership.delivery_group_id=?
              AND ownership.telegram_message_id=?)
        )
      ORDER BY t.updated_at DESC,t.id DESC LIMIT 1`).get(
      groupId, serviceId, cutoff, telegramMessageId, telegramMessageId, telegramMessageId, groupId, telegramMessageId,
    ) as SqlRow | undefined
    return row ? threadFromRow(row) : null
  }

  listActiveThreadsByTelegramMessage(
    groupId: string,
    serviceId: string,
    telegramMessageId: string,
    reference: string | Date = new Date(),
  ): SupportThread[] {
    const { cutoff } = expiryTimes(reference)
    this.archiveExpired(reference)
    return (this.database.prepare(`SELECT DISTINCT t.* FROM support_threads t
      WHERE t.group_id=? AND t.service_id=? AND t.status<>'closed' AND t.latest_message_at>?
        AND (
          EXISTS(SELECT 1 FROM support_thread_messages tm
            JOIN support_message_events e ON e.id=tm.message_event_id
            WHERE tm.thread_id=t.id AND e.telegram_message_id=?)
          OR EXISTS(SELECT 1 FROM support_replies r
            WHERE r.thread_id=t.id AND r.telegram_reply_message_id=?)
          OR EXISTS(SELECT 1 FROM support_thread_notifications n
            WHERE n.thread_id=t.id AND n.telegram_message_id=?)
          OR EXISTS(SELECT 1 FROM telegram_output_ownership ownership
            WHERE ownership.thread_id=t.id AND ownership.delivery_group_id=?
              AND ownership.telegram_message_id=?)
        )
      ORDER BY t.updated_at DESC,t.id DESC`).all(
      groupId, serviceId, cutoff, telegramMessageId, telegramMessageId, telegramMessageId, groupId, telegramMessageId,
    ) as SqlRow[]).map(threadFromRow)
  }

  listRouteTimeline(
    groupId: string,
    serviceId: string,
    reference: string | Date = new Date(),
    limit = 80,
  ): ThreadRouteTimelineEntry[] {
    const { cutoff } = expiryTimes(reference)
    const bounded = Math.min(Math.max(limit, 1), 200)
    const inbound = (this.database.prepare(`SELECT e.*,
      (SELECT GROUP_CONCAT(DISTINCT tm.thread_id) FROM support_thread_messages tm
        WHERE tm.message_event_id=e.id) AS thread_ids
      FROM support_message_events e
      WHERE e.group_id=? AND (
        NOT EXISTS(SELECT 1 FROM support_thread_messages linked WHERE linked.message_event_id=e.id)
        OR EXISTS(SELECT 1 FROM support_thread_messages linked
          JOIN support_threads thread ON thread.id=linked.thread_id
          WHERE linked.message_event_id=e.id AND thread.service_id=?))
        AND e.created_at>? AND e.created_at<=?
      ORDER BY e.created_at DESC,e.id DESC LIMIT ${bounded}`).all(
      groupId,
      serviceId,
      cutoff,
      typeof reference === "string" ? reference : reference.toISOString(),
    ) as SqlRow[]).map((row): ThreadRouteTimelineEntry => ({
      direction: "inbound",
      eventId: String(row.id),
      messageId: String(row.telegram_message_id),
      replyToMessageId: row.reply_to_message_id === null ? null : String(row.reply_to_message_id),
      senderId: String(row.sender_user_id),
      sender: String(row.sender_display_name || row.sender_username || row.sender_user_id),
      senderRole: row.sender_role === null ? null : row.sender_role as ThreadRouteTimelineEntry["senderRole"],
      text: String(row.safe_text || row.attachment_summary || ""),
      threadIds: row.thread_ids ? String(row.thread_ids).split(",") : [],
      createdAt: String(row.created_at),
    }))
    const replyOutbound = (this.database.prepare(`SELECT r.telegram_reply_message_id,r.telegram_message_id,
      r.thread_id,r.updated_at,p.answer
      FROM support_replies r JOIN support_reply_payloads p ON p.reply_id=r.id
      WHERE r.group_id=? AND r.service_id=? AND r.telegram_reply_message_id IS NOT NULL
        AND r.status IN ('replied','escalated','corrected') AND r.updated_at>? AND r.updated_at<=?
      ORDER BY r.updated_at DESC,r.id DESC LIMIT ${bounded}`).all(
      groupId,
      serviceId,
      cutoff,
      typeof reference === "string" ? reference : reference.toISOString(),
    ) as SqlRow[]).map((row): ThreadRouteTimelineEntry => ({
      direction: "outbound",
      eventId: null,
      messageId: String(row.telegram_reply_message_id),
      replyToMessageId: row.telegram_message_id === null ? null : String(row.telegram_message_id),
      senderId: null,
      sender: "客服",
      senderRole: null,
      text: String(row.answer || ""),
      threadIds: row.thread_id === null ? [] : [String(row.thread_id)],
      createdAt: String(row.updated_at),
    }))
    const notificationOutbound = (this.database.prepare(`SELECT
      notification.telegram_message_id,notification.outbound_text,notification.thread_id,
      ownership.reply_to_message_id,ownership.updated_at
      FROM support_thread_notifications notification
      JOIN support_threads thread ON thread.id=notification.thread_id
      JOIN telegram_output_ownership ownership ON ownership.id=(
        SELECT sent.id FROM telegram_output_ownership sent
        WHERE sent.notification_id=notification.id AND sent.delivery_status='sent'
          AND sent.telegram_message_id=notification.telegram_message_id
        ORDER BY sent.updated_at DESC,sent.id DESC LIMIT 1
      )
      WHERE thread.group_id=? AND thread.service_id=? AND notification.kind='progress'
        AND notification.status='sent' AND notification.telegram_message_id IS NOT NULL
        AND length(trim(COALESCE(notification.outbound_text,'')))>0
        AND ownership.updated_at>? AND ownership.updated_at<=?
      ORDER BY ownership.updated_at DESC,ownership.id DESC LIMIT ${bounded}`).all(
      groupId,
      serviceId,
      cutoff,
      typeof reference === "string" ? reference : reference.toISOString(),
    ) as SqlRow[]).map((row): ThreadRouteTimelineEntry => ({
      direction: "outbound",
      eventId: null,
      messageId: String(row.telegram_message_id),
      replyToMessageId: row.reply_to_message_id === null ? null : String(row.reply_to_message_id),
      senderId: null,
      sender: "客服",
      senderRole: null,
      text: String(row.outbound_text),
      threadIds: [String(row.thread_id)],
      createdAt: String(row.updated_at),
    }))
    return [...inbound, ...replyOutbound, ...notificationOutbound]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId))
      .slice(-bounded)
  }

  findThreadByBotReplyMessage(groupId: string, telegramMessageId: string): SupportThread | null {
    const owned = this.database.prepare(`SELECT t.* FROM telegram_output_ownership ownership
      JOIN support_threads t ON t.id=ownership.thread_id
      WHERE ownership.delivery_group_id=? AND ownership.telegram_message_id=?
      ORDER BY ownership.created_at DESC,ownership.id DESC LIMIT 1`).get(
      groupId,
      telegramMessageId,
    ) as SqlRow | undefined
    if (owned) return threadFromRow(owned)
    const legacy = this.database.prepare(`SELECT t.* FROM support_replies r
      JOIN support_threads t ON t.id=r.thread_id
      WHERE r.group_id=? AND r.telegram_reply_message_id=? AND t.group_id=r.group_id
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`).get(groupId, telegramMessageId) as SqlRow | undefined
    return legacy ? threadFromRow(legacy) : null
  }

  findDeliveredBotReplyText(groupId: string, telegramMessageId: string): string | null {
    const row = this.database.prepare(`SELECT p.answer FROM support_replies r
      JOIN support_reply_payloads p ON p.reply_id=r.id
      WHERE r.group_id=? AND r.telegram_reply_message_id=?
        AND r.status IN ('replied','escalated','corrected') AND trim(p.answer)<>''
      ORDER BY r.updated_at DESC,r.id DESC LIMIT 1`).get(groupId, telegramMessageId) as SqlRow | undefined
    const answer = row?.answer === null || row?.answer === undefined ? "" : String(row.answer).trim()
    return answer || null
  }

  claimDue(now: string, progressNotificationSeconds = DEFAULT_PROGRESS_DELAY_SECONDS): { thread: SupportThread; inputRevision: number } | null {
    this.archiveExpired(now)
    return this.database.transaction(() => {
      const row = this.database.prepare(`SELECT * FROM support_threads
        WHERE status='collecting' AND settle_at<=? AND human_priority_state NOT IN ('waiting','sending')
        ORDER BY settle_at,id LIMIT 1`).get(now) as SqlRow | undefined
      if (!row) return null
      const claimed = threadFromRow(row)
      const progressDueAt = new Date(
        Date.parse(claimed.generationStartedAt ?? now) + progressNotificationSeconds * 1000,
      ).toISOString()
      const hardDeadlineAt = new Date(Date.parse(claimed.generationStartedAt ?? now) + HARD_DEADLINE_MS).toISOString()
      const result = this.database.prepare(`UPDATE support_threads SET
        status='generating',generation_started_at=COALESCE(generation_started_at,?),
        progress_due_at=COALESCE(progress_due_at,?),hard_deadline_at=COALESCE(hard_deadline_at,?),updated_at=?
        WHERE id=? AND status='collecting' AND revision=?`).run(
        now, progressDueAt, hardDeadlineAt, now, claimed.id, claimed.revision,
      )
      if (Number(result.changes) !== 1) return null
      return { thread: this.getThread(claimed.id), inputRevision: claimed.revision }
    })
  }

  claimDueHumanPriority(now = new Date().toISOString()): HumanPriorityClaim | null {
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT id,revision,answer_operation_mode FROM support_threads
        WHERE status='collecting' AND human_priority_state='waiting' AND human_priority_due_at<=?
        ORDER BY human_priority_due_at,id`).all(now) as SqlRow[]
      for (const row of rows) {
        const threadId = String(row.id)
        if (row.answer_operation_mode !== "live") {
          this.database.prepare(`UPDATE support_threads SET
            human_priority_state='claimed',settle_at=?,human_priority_error=?,updated_at=?
            WHERE id=? AND revision=? AND status='collecting' AND human_priority_state='waiting'`).run(
            now,
            "学习模式禁止 Telegram 输出",
            now,
            threadId,
            Number(row.revision),
          )
          continue
        }
        const reusableRow = this.database.prepare(`SELECT notification.*
          FROM support_thread_notifications notification
          JOIN support_thread_output_claims claim ON claim.notification_id=notification.id
            AND claim.thread_id=notification.thread_id AND claim.claim_kind='progress'
            AND claim.source_kind='human_priority'
          WHERE notification.thread_id=? AND notification.input_revision=? AND notification.kind='progress'
            AND notification.status IN ('pending','failed') AND notification.telegram_message_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM telegram_output_ownership ownership
              WHERE ownership.notification_id=notification.id
                AND (ownership.delivery_status IN ('sending','sent','unknown') OR ownership.telegram_message_id IS NOT NULL))
          LIMIT 1`).get(threadId, Number(row.revision)) as SqlRow | undefined
        let notification = reusableRow ? notificationFromRow(reusableRow) : null
        if (notification) {
          this.database.prepare(`UPDATE support_thread_notifications SET
            status='pending',due_at=?,error_message=NULL,updated_at=? WHERE id=?`).run(
            now,
            now,
            notification.id,
          )
          notification = { ...notification, status: "pending", dueAt: now, errorMessage: null, updatedAt: now }
        } else {
          notification = this.claimProgressNotification(
            threadId,
            Number(row.revision),
            "human_priority",
            now,
            now,
          )
        }
        if (!notification) {
          this.database.prepare(`UPDATE support_threads SET
            human_priority_state='claimed',settle_at=?,human_priority_error=?,updated_at=?
            WHERE id=? AND revision=? AND status='collecting' AND human_priority_state='waiting'`).run(
            now,
            "同一问题此前已发送稍等，不重复发送",
            now,
            threadId,
            Number(row.revision),
          )
          continue
        }
        const result = this.database.prepare(`UPDATE support_threads SET
          human_priority_state='sending',human_priority_error=NULL,updated_at=?
          WHERE id=? AND revision=? AND status='collecting' AND human_priority_state='waiting'`).run(
          now, threadId, Number(row.revision),
        )
        if (Number(result.changes) === 1) {
          return { threadId, inputRevision: Number(row.revision), notificationId: notification.id }
        }
        this.failNotification(notification.id, "人工优先等待状态已变化", now)
        this.releaseFailedProgressClaim(notification.id, now)
      }
      return null
    })
  }

  completeHumanPriorityClaim(
    claim: HumanPriorityClaim,
    telegramMessageId: string | null,
    error: string | null = null,
    now = new Date().toISOString(),
  ): boolean {
    return this.database.transaction(() => {
      const notification = this.database.prepare(`SELECT status FROM support_thread_notifications
        WHERE id=? AND thread_id=? AND kind='progress'`).get(
        claim.notificationId,
        claim.threadId,
      ) as { status?: string } | undefined
      const waitForHuman = notification?.status === "sent" || notification?.status === "unknown"
      const dueAt = waitForHuman
        ? new Date(Date.parse(now) + HUMAN_PRIORITY_WAIT_MS).toISOString()
        : now
      const result = this.database.prepare(`UPDATE support_threads SET
        human_priority_state=?,human_priority_progress_message_id=?,human_priority_error=?,
        human_priority_due_at=?,settle_at=?,updated_at=?
        WHERE id=? AND status='collecting' AND human_priority_state='sending'`).run(
        waitForHuman ? "waiting" : "claimed",
        telegramMessageId,
        error?.slice(0, 1000) ?? null,
        dueAt,
        dueAt,
        now,
        claim.threadId,
      )
      return Number(result.changes) === 1
    })
  }

  hasClaimedHumanPriority(threadId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM support_threads
      WHERE id=? AND human_priority_state='claimed' AND human_priority_source_event_id IS NOT NULL`).get(threadId))
  }

  hasStartedProgress(threadId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'
      LIMIT 1`).get(threadId))
  }

  claimProgressNotification(
    threadId: string,
    inputRevision: number,
    source: ThreadOutputClaimSource,
    dueAt: string,
    now = new Date().toISOString(),
  ): SupportThreadNotification | null {
    if (source !== "scheduled_progress" && source !== "status_request" && source !== "human_priority") {
      throw new Error("progress owner 来源无效")
    }
    return this.database.transaction(() => {
      const notification: SupportThreadNotification = {
        id: randomUUID(),
        threadId,
        inputRevision,
        kind: "progress",
        status: "pending",
        dueAt,
        telegramMessageId: null,
        outboundText: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }
      const insertedNotification = this.database.prepare(`INSERT INTO support_thread_notifications(
        id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
      ) SELECT ?,id,?,'progress','pending',?,NULL,NULL,?,? FROM support_threads
        WHERE id=? AND revision=?
      ON CONFLICT DO NOTHING`).run(
        notification.id,
        inputRevision,
        dueAt,
        now,
        now,
        threadId,
        inputRevision,
      )
      let claimedNotification = notification
      if (Number(insertedNotification.changes) !== 1) {
        const reusable = this.database.prepare(`SELECT notification.* FROM support_thread_notifications notification
          JOIN support_threads thread ON thread.id=notification.thread_id
          WHERE notification.thread_id=? AND notification.input_revision=? AND notification.kind='progress'
            AND thread.revision=?
            AND notification.status IN ('pending','failed') AND notification.telegram_message_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM support_thread_output_claims claim
              WHERE claim.notification_id=notification.id)
            AND NOT EXISTS(SELECT 1 FROM telegram_output_ownership ownership
              WHERE ownership.notification_id=notification.id
                AND (ownership.delivery_status IN ('sending','sent','unknown') OR ownership.telegram_message_id IS NOT NULL)
            )`).get(threadId, inputRevision, inputRevision) as SqlRow | undefined
        if (!reusable) return null
        claimedNotification = notificationFromRow(reusable)
      }
      const insertedClaim = this.database.prepare(`INSERT INTO support_thread_output_claims(
        thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
      ) VALUES (?,'progress',?,NULL,?,?,?) ON CONFLICT DO NOTHING`).run(
        threadId,
        source,
        claimedNotification.id,
        now,
        now,
      )
      if (Number(insertedClaim.changes) === 1) {
        if (claimedNotification.id !== notification.id) {
          const updatedNotification = this.database.prepare(`UPDATE support_thread_notifications SET
            status='pending',due_at=?,telegram_message_id=NULL,error_message=NULL,updated_at=?
            WHERE id=? AND status IN ('pending','failed')
              AND EXISTS(SELECT 1 FROM support_threads thread
                WHERE thread.id=support_thread_notifications.thread_id AND thread.revision=?)`).run(
            dueAt,
            now,
            claimedNotification.id,
            inputRevision,
          )
          if (Number(updatedNotification.changes) !== 1) {
            throw new Error("progress notification 版本已变化")
          }
          return {
            ...claimedNotification,
            status: "pending",
            dueAt,
            telegramMessageId: null,
            errorMessage: null,
            updatedAt: now,
          }
        }
        return notification
      }
      if (Number(insertedNotification.changes) === 1) {
        this.database.prepare("DELETE FROM support_thread_notifications WHERE id=?").run(notification.id)
      }
      return null
    })
  }

  claimHandoff(
    replyId: string,
    source: ThreadOutputClaimSource,
    now = new Date().toISOString(),
  ): boolean {
    if (source === "scheduled_progress" || source === "status_request" || source === "human_priority") {
      throw new Error("handoff owner 来源无效")
    }
    return this.database.transaction(() => {
      const inserted = this.database.prepare(`INSERT INTO support_thread_output_claims(
        thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
      ) SELECT thread_id,'handoff',?,?,NULL,?,? FROM support_replies
        WHERE id=? AND thread_id IS NOT NULL
      ON CONFLICT DO NOTHING`).run(source, replyId, now, now, replyId)
      if (Number(inserted.changes) === 1) return true
      return Boolean(this.database.prepare(`SELECT 1 FROM support_thread_output_claims
        WHERE claim_kind='handoff' AND reply_id=? LIMIT 1`).get(replyId))
    })
  }

  hasHandoffClaim(threadId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='handoff' LIMIT 1`).get(threadId))
  }

  handoffSource(threadId: string): ThreadOutputClaimSource | null {
    const row = this.database.prepare(`SELECT source_kind FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='handoff'`).get(threadId) as SqlRow | undefined
    return row ? row.source_kind as ThreadOutputClaimSource : null
  }

  releaseFailedProgressClaim(notificationId: string, _now = new Date().toISOString()): boolean {
    const released = this.database.prepare(`DELETE FROM support_thread_output_claims AS claim
      WHERE claim.claim_kind='progress' AND claim.notification_id=?
        AND EXISTS(SELECT 1 FROM support_thread_notifications notification
          WHERE notification.id=claim.notification_id AND notification.status='failed'
            AND notification.telegram_message_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.notification_id=claim.notification_id
            AND (ownership.delivery_status IN ('sending','sent','unknown') OR ownership.telegram_message_id IS NOT NULL)
        )`).run(notificationId)
    return Number(released.changes) === 1
  }

  private supersedeUnstartedProgress(threadId: string, inputRevision: number, now: string): void {
    const row = this.database.prepare(`SELECT notification.id,notification.status FROM support_thread_notifications notification
      JOIN support_thread_output_claims claim ON claim.notification_id=notification.id
        AND claim.claim_kind='progress'
      WHERE notification.thread_id=? AND notification.input_revision=? AND notification.kind='progress'
      LIMIT 1`).get(threadId, inputRevision) as SqlRow | undefined
    if (!row) return
    const notificationId = String(row.id)
    const ownershipStarted = Boolean(this.database.prepare(`SELECT 1 FROM telegram_output_ownership
      WHERE notification_id=?
        AND (delivery_status IN ('sending','sent','unknown') OR telegram_message_id IS NOT NULL)
      LIMIT 1`).get(notificationId))
    if (ownershipStarted) {
      if (row.status === "sending") {
        this.database.prepare(`UPDATE support_thread_notifications SET
          status='unknown',error_message='新输入版本到达时发送状态未知',updated_at=?
          WHERE id=? AND status='sending'`).run(now, notificationId)
      }
      return
    }
    if (row.status === "pending" || row.status === "sending") {
      this.database.prepare(`UPDATE support_thread_notifications SET
        status='failed',error_message='尚未开始发送的进度提示已被新输入版本替代',updated_at=?
        WHERE id=? AND status IN ('pending','sending')`).run(now, notificationId)
    }
    this.releaseFailedProgressClaim(notificationId, now)
  }

  findPreparedEscalationReplyId(threadId: string, inputRevision: number): string | null {
    const row = this.database.prepare(`SELECT reply.id FROM support_replies reply
      JOIN support_reply_payloads payload ON payload.reply_id=reply.id
      WHERE reply.thread_id=? AND reply.input_revision=? AND reply.status='generating'
        AND reply.decision='escalate' AND length(trim(payload.answer))>0
        AND EXISTS(SELECT 1 FROM support_thread_output_claims claim
          WHERE claim.thread_id=reply.thread_id AND claim.claim_kind='handoff' AND claim.reply_id=reply.id)
      ORDER BY reply.created_at DESC,reply.id DESC LIMIT 1`).get(threadId, inputRevision) as SqlRow | undefined
    return row ? String(row.id) : null
  }

  findPreparedHardDeadlineReplyId(threadId: string, inputRevision: number): string | null {
    const row = this.database.prepare(`SELECT reply.id FROM support_replies reply
      JOIN support_reply_payloads payload ON payload.reply_id=reply.id
      WHERE reply.thread_id=? AND reply.input_revision=? AND reply.status='generating'
        AND reply.decision='escalate' AND reply.error_code=? AND length(trim(payload.answer))>0
        AND EXISTS(SELECT 1 FROM support_thread_output_claims claim
          WHERE claim.thread_id=reply.thread_id AND claim.claim_kind='handoff' AND claim.reply_id=reply.id)
      ORDER BY reply.created_at DESC,reply.id DESC LIMIT 1`).get(
      threadId,
      inputRevision,
      HARD_DEADLINE_ERROR_CODE,
    ) as SqlRow | undefined
    return row ? String(row.id) : null
  }

  listPendingTechnicalAvailabilityReplies(limit = 512): Array<{
    threadId: string
    inputRevision: number
    replyId: string
  }> {
    const maximum = Math.max(1, Math.min(512, Math.trunc(limit)))
    const rows = this.database.prepare(`SELECT reply.thread_id,reply.input_revision,reply.id
      FROM support_replies reply
      JOIN support_reply_payloads payload ON payload.reply_id=reply.id
      JOIN support_threads thread ON thread.id=reply.thread_id
      JOIN support_thread_output_claims claim ON claim.thread_id=reply.thread_id
        AND claim.claim_kind='handoff' AND claim.reply_id=reply.id
      WHERE reply.status='generating' AND reply.decision='escalate'
        AND thread.status='generating' AND thread.revision=reply.input_revision
        AND payload.answer=? AND claim.source_kind IN ('failure_after_progress','hard_deadline')
      ORDER BY reply.updated_at,reply.id LIMIT ?`).all(
      TECHNICAL_AVAILABILITY_REPLY_PENDING,
      maximum,
    ) as SqlRow[]
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      inputRevision: Number(row.input_revision),
      replyId: String(row.id),
    }))
  }

  findPreparedFeatureRequestReplyId(threadId: string, inputRevision: number): string | null {
    const row = this.database.prepare(`SELECT reply.id FROM support_replies reply
      JOIN support_reply_payloads payload ON payload.reply_id=reply.id
      WHERE reply.thread_id=? AND reply.input_revision=? AND reply.status='generating'
        AND reply.decision='escalate' AND reply.error_code=? AND length(trim(payload.answer))>0
        AND EXISTS(SELECT 1 FROM support_thread_output_claims claim
          WHERE claim.thread_id=reply.thread_id AND claim.claim_kind='handoff' AND claim.reply_id=reply.id)
      ORDER BY reply.created_at DESC,reply.id DESC LIMIT 1`).get(
      threadId,
      inputRevision,
      FEATURE_REQUEST_PREPARED_ERROR_CODE,
    ) as SqlRow | undefined
    return row ? String(row.id) : null
  }

  hasFeatureRequestAlertOwnership(replyId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM telegram_output_ownership
      WHERE reply_id=? AND output_kind='technical_alert:feature_request' LIMIT 1`).get(replyId))
  }

  recoverInterruptedHumanPriorityClaims(now = new Date().toISOString()): { resumed: number; retried: number } {
    return this.database.transaction(() => {
      const started = this.database.prepare(`SELECT thread.id,MAX(ownership.updated_at) AS ownership_updated_at
        FROM support_threads thread
        JOIN telegram_output_ownership ownership ON ownership.thread_id=thread.id
          AND ownership.output_kind='mention_claim_progress'
          AND ownership.delivery_status IN ('sending','sent','unknown')
        WHERE thread.human_priority_state='sending'
        GROUP BY thread.id`).all() as SqlRow[]
      let resumed = 0
      for (const row of started) {
        const ownershipUpdatedAt = String(row.ownership_updated_at)
        const dueAt = new Date(Date.parse(ownershipUpdatedAt) + HUMAN_PRIORITY_WAIT_MS).toISOString()
        const result = this.database.prepare(`UPDATE support_threads SET
          human_priority_state='waiting',human_priority_due_at=?,settle_at=?,
          human_priority_error='服务重启前稍等提示发送状态未知，按已开始发送继续人工等待',updated_at=?
          WHERE id=? AND human_priority_state='sending'`).run(dueAt, dueAt, now, String(row.id))
        resumed += Number(result.changes)
      }
      const retried = this.database.prepare(`UPDATE support_threads AS thread SET
        human_priority_state='waiting',human_priority_due_at=?,settle_at=?,
        human_priority_error='服务重启前尚未开始发送稍等提示，重新领取',updated_at=?
        WHERE human_priority_state='sending' AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.thread_id=thread.id AND ownership.output_kind='mention_claim_progress'
            AND ownership.delivery_status IN ('sending','sent','unknown')
        )`).run(now, now, now)
      return { resumed, retried: Number(retried.changes) }
    })
  }

  resolveHumanPriorityByResponder(
    groupId: string,
    senderUserId: string,
    responseEventId: string,
    respondedAt: string,
  ): number {
    const outcome = this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT thread.id,thread.human_priority_state,
          thread.human_priority_user_ids_json,
          source.created_at AS source_created_at
        FROM support_threads thread
        LEFT JOIN support_message_events source ON source.id=thread.human_priority_source_event_id
        WHERE thread.group_id=? AND thread.status='collecting'
          AND thread.human_priority_state IN ('waiting','sending')
          AND (thread.human_priority_state='sending' OR thread.human_priority_due_at>=?
            OR NOT EXISTS(SELECT 1 FROM support_thread_output_claims claim
              WHERE claim.thread_id=thread.id AND claim.claim_kind='progress'))`).all(groupId, respondedAt) as SqlRow[]
      const updates: ExpiredReplyUpdate[] = []
      let count = 0
      for (const row of rows) {
        const target = this.humanPriorityTarget(row.human_priority_user_ids_json)
        const mentionedTechnical = target.mentionedTechnical
        const senderIsTechnical = this.isEnabledTechnical(senderUserId)
        const senderIsIgnored = this.isEnabledIgnored(senderUserId)
        const eligibleTechnical = mentionedTechnical && senderIsTechnical
        const eligibleIgnored = senderIsIgnored && target.ignoredUserIds.includes(senderUserId)
        if (!eligibleTechnical && !eligibleIgnored) continue
        if (row.source_created_at !== null && String(row.source_created_at) > respondedAt) continue
        const reason = eligibleTechnical ? "技术角色已在3分钟内回应" : "被@人员已在3分钟内回应"
        const changed = this.database.prepare(`UPDATE support_threads SET
          human_priority_state='answered',human_priority_error=?,updated_at=?
          WHERE id=? AND status='collecting' AND human_priority_state IN ('waiting','sending')`).run(
          `${reason} message_event_id=${responseEventId}`.slice(0, 1000),
          respondedAt,
          String(row.id),
        )
        if (Number(changed.changes) !== 1) continue
        const closed = this.closeThreadRows(String(row.id), "群内人工", reason, respondedAt)
        updates.push(...closed.replyUpdates)
        count += Number(closed.changed)
      }
      return { count, updates }
    })
    outcome.updates.forEach((event) => this.onExpiredReply?.(event))
    return outcome.count
  }

  isCurrentRevision(threadId: string, revision: number, reference: string | Date = new Date()): boolean {
    this.archiveExpired(reference)
    const row = this.database.prepare("SELECT revision,status FROM support_threads WHERE id=?").get(threadId) as SqlRow | undefined
    return row !== undefined && row.status === "generating" && Number(row.revision) === revision
  }

  finishGeneration(
    threadId: string,
    revision: number,
    status: "answered" | "escalated" | "closed",
    now = new Date().toISOString(),
  ): boolean {
    const result = this.database.prepare(`UPDATE support_threads SET status=?,
      human_priority_state=CASE WHEN human_priority_state='claimed' THEN 'none' ELSE human_priority_state END,
      updated_at=?
      WHERE id=? AND revision=? AND status='generating'`).run(status, now, threadId, revision)
    return Number(result.changes) === 1
  }

  retryGeneration(threadId: string, revision: number, now = new Date().toISOString()): boolean {
    const result = this.database.prepare(`UPDATE support_threads SET status='collecting',settle_at=?,
      generation_started_at=NULL,progress_due_at=NULL,hard_deadline_at=NULL,updated_at=?
      WHERE id=? AND revision=? AND status='generating'`).run(now, now, threadId, revision)
    return Number(result.changes) === 1
  }

  recoverStaleGenerating(now: string, staleBefore: string): number {
    const recovered = this.database.transaction(() => {
      const replies = this.database.prepare(`SELECT r.id,r.status FROM support_replies r
        JOIN support_threads t ON t.id=r.thread_id
        WHERE (t.status='generating' AND t.updated_at<?
          AND r.status IN ('pending','queued','generating','sending'))
          OR (t.status='closed' AND r.status='sending' AND r.updated_at<?)
          OR (t.status='collecting' AND r.status='sending' AND r.input_revision<t.revision
            AND r.updated_at<?)`).all(staleBefore, staleBefore, staleBefore) as SqlRow[]
      this.database.prepare(`DELETE FROM support_reply_alert_deliveries AS delivery
        WHERE delivery.status='sending' AND delivery.alert_kind='support_delivery_failure'
          AND delivery.updated_at<? AND EXISTS (
            SELECT 1 FROM support_replies reply JOIN support_threads thread ON thread.id=reply.thread_id
            WHERE reply.id=delivery.reply_id AND reply.status='failed'
              AND thread.status='escalated' AND thread.revision=reply.input_revision
          ) AND NOT EXISTS (
            SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=delivery.reply_id
              AND ownership.output_kind='technical_alert:support_delivery_failure'
              AND ownership.delivery_status IN ('sending','sent','unknown')
          )`).run(staleBefore)
      this.database.prepare(`UPDATE telegram_output_ownership AS ownership
        SET delivery_status='unknown',updated_at=?
        WHERE ownership.output_kind='technical_alert:support_delivery_failure'
          AND ownership.delivery_status='sending' AND EXISTS (
            SELECT 1 FROM support_reply_alert_deliveries delivery
            JOIN support_replies reply ON reply.id=delivery.reply_id
            JOIN support_threads thread ON thread.id=reply.thread_id
            WHERE delivery.reply_id=ownership.reply_id
              AND delivery.alert_kind='support_delivery_failure' AND delivery.status='sending'
              AND delivery.updated_at<? AND reply.status='failed'
              AND thread.status='escalated' AND thread.revision=reply.input_revision
          )`).run(now, staleBefore)
      this.database.prepare(`UPDATE support_reply_alert_deliveries AS delivery
        SET status='uncertain',updated_at=?
        WHERE delivery.status='sending' AND delivery.alert_kind='support_delivery_failure'
          AND delivery.updated_at<? AND EXISTS (
            SELECT 1 FROM support_replies reply JOIN support_threads thread ON thread.id=reply.thread_id
            WHERE reply.id=delivery.reply_id AND reply.status='failed'
              AND thread.status='escalated' AND thread.revision=reply.input_revision
          ) AND EXISTS (
            SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=delivery.reply_id
              AND ownership.output_kind='technical_alert:support_delivery_failure'
              AND ownership.delivery_status IN ('sending','sent','unknown')
          )`).run(now, staleBefore)
      this.database.prepare(`DELETE FROM support_reply_alert_deliveries AS delivery
        WHERE delivery.status='sending' AND delivery.alert_kind='escalation' AND EXISTS (
          SELECT 1 FROM support_replies reply JOIN support_threads thread ON thread.id=reply.thread_id
          WHERE reply.id=delivery.reply_id AND thread.status='generating' AND thread.updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=delivery.reply_id
            AND ownership.output_kind IN ('technical_alert','technical_alert:escalation')
            AND ownership.delivery_status IN ('sending','sent','unknown')
        )`).run(staleBefore)
      this.database.prepare(`UPDATE support_reply_alert_deliveries AS delivery
        SET status='uncertain',updated_at=? WHERE status='sending' AND EXISTS (
          SELECT 1 FROM support_replies r JOIN support_threads t ON t.id=r.thread_id
          WHERE r.id=delivery.reply_id AND (
            (t.status='generating' AND t.updated_at<?)
            OR (t.status='closed' AND delivery.updated_at<?)
          )
        )`).run(now, staleBefore, staleBefore)
      this.database.prepare(`UPDATE telegram_output_ownership AS ownership
        SET delivery_status='unknown',updated_at=? WHERE delivery_status='sending' AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=ownership.thread_id AND (
            (thread.status='generating' AND thread.updated_at<?)
            OR (thread.status='closed' AND ownership.updated_at<?)
          )
        )`).run(now, staleBefore, staleBefore)
      this.database.prepare(`UPDATE telegram_output_ownership AS ownership
        SET delivery_status='unknown',updated_at=?
        WHERE ownership.output_kind='support_reply' AND ownership.delivery_status='sending'
          AND ownership.updated_at<? AND EXISTS (
            SELECT 1 FROM support_replies reply
            JOIN support_threads thread ON thread.id=reply.thread_id
            WHERE reply.id=ownership.reply_id AND reply.status='sending'
              AND reply.input_revision<thread.revision AND reply.updated_at<?
              AND thread.status='collecting'
          )`).run(now, staleBefore, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status=CASE WHEN error_code=? OR decision='escalate' OR EXISTS (
          SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=reply.id AND delivery.alert_kind='escalation'
        ) THEN 'escalated' ELSE 'replied' END,
        decision=CASE WHEN error_code=? OR decision='escalate' OR EXISTS (
          SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=reply.id AND delivery.alert_kind='escalation'
        ) THEN 'escalate' ELSE 'reply' END,
        operator_delivery_status='sent',updated_at=?,error_code=NULL,
        telegram_reply_message_id=(SELECT ownership.telegram_message_id FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
            AND ownership.delivery_status='sent' AND ownership.telegram_message_id IS NOT NULL
          ORDER BY ownership.updated_at DESC,ownership.id DESC LIMIT 1),
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND updated_at<? AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id AND (
            thread.status='closed'
            OR (thread.status='collecting' AND reply.input_revision<thread.revision)
          )
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='sent'
            AND ownership.telegram_message_id IS NOT NULL
        )`).run(
        FEATURE_REQUEST_PREPARED_ERROR_CODE,
        FEATURE_REQUEST_PREPARED_ERROR_CODE,
        now,
        now,
        staleBefore,
      )
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='failed',operator_delivery_status='uncertain',updated_at=?,error_code='delivery_state_unknown',
        decision_reason='服务重启前运营群回复发送结果未知',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND updated_at<? AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id AND (
            thread.status='closed'
            OR (thread.status='collecting' AND reply.input_revision<thread.revision)
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='sent'
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='unknown'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='failed',operator_delivery_status='failed',updated_at=?,error_code='support_delivery_failed',
        decision_reason='服务重启前运营群回复已明确发送失败',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND updated_at<? AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id AND (
            thread.status='closed'
            OR (thread.status='collecting' AND reply.input_revision<thread.revision)
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status IN ('sent','unknown')
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='failed'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='superseded',operator_delivery_status=NULL,updated_at=?,error_code=NULL,
        decision_reason='问题关闭前运营回复 RPC 尚未开始',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND updated_at<? AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id AND (
            thread.status='closed'
            OR (thread.status='collecting' AND reply.input_revision<thread.revision)
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='escalated',decision='escalate',operator_delivery_status='sent',updated_at=?,error_code=NULL,
        telegram_reply_message_id=(SELECT ownership.telegram_message_id FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
            AND ownership.delivery_status='sent' AND ownership.telegram_message_id IS NOT NULL
          ORDER BY ownership.updated_at DESC,ownership.id DESC LIMIT 1),
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND error_code=? AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='sent'
            AND ownership.telegram_message_id IS NOT NULL
        )`).run(now, now, FEATURE_REQUEST_PREPARED_ERROR_CODE, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='replied',decision='reply',operator_delivery_status='sent',updated_at=?,error_code=NULL,
        telegram_reply_message_id=(SELECT ownership.telegram_message_id FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
            AND ownership.delivery_status='sent' AND ownership.telegram_message_id IS NOT NULL
          ORDER BY ownership.updated_at DESC,ownership.id DESC LIMIT 1),
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND decision<>'escalate' AND NOT EXISTS (
          SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=reply.id AND delivery.alert_kind='escalation'
        ) AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='sent'
            AND ownership.telegram_message_id IS NOT NULL
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='failed',operator_delivery_status='uncertain',updated_at=?,error_code='delivery_state_unknown',
        decision_reason='服务重启前运营群回复发送结果未知',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND (error_code=? OR (decision<>'escalate' AND NOT EXISTS (
          SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=reply.id AND delivery.alert_kind='escalation'
        ))) AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='sent'
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='unknown'
        )`).run(now, now, FEATURE_REQUEST_PREPARED_ERROR_CODE, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='failed',operator_delivery_status='failed',updated_at=?,error_code='support_delivery_failed',
        decision_reason='服务重启前运营群回复已明确发送失败',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND (error_code=? OR (decision<>'escalate' AND NOT EXISTS (
          SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=reply.id AND delivery.alert_kind='escalation'
        ))) AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status IN ('sent','unknown')
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='failed'
        )`).run(now, now, FEATURE_REQUEST_PREPARED_ERROR_CODE, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='generating',operator_delivery_status=NULL,updated_at=?
        WHERE status='sending' AND error_code=? AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.revision=reply.input_revision AND thread.updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
        )`).run(now, FEATURE_REQUEST_PREPARED_ERROR_CODE, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='superseded',operator_delivery_status=NULL,updated_at=?,error_code=NULL,
        decision_reason='服务重启前运营回复 RPC 尚未开始，重新生成回答',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND decision<>'escalate' AND NOT EXISTS (
          SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=reply.id AND delivery.alert_kind='escalation'
        ) AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.revision=reply.input_revision AND thread.updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='superseded',operator_delivery_status=NULL,updated_at=?,error_code=NULL,
        decision_reason='服务重启时旧输入版本的运营回复 RPC 尚未开始',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.revision<>reply.input_revision AND thread.updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='escalated',decision='escalate',operator_delivery_status='sent',updated_at=?,error_code=NULL,
        telegram_reply_message_id=(SELECT ownership.telegram_message_id FROM telegram_output_ownership ownership
          WHERE ownership.reply_id=reply.id AND ownership.output_kind='support_reply'
            AND ownership.delivery_status='sent' AND ownership.telegram_message_id IS NOT NULL
          ORDER BY ownership.updated_at DESC,ownership.id DESC LIMIT 1),
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND EXISTS (
          SELECT 1 FROM support_reply_payloads payload
          JOIN support_reply_alert_deliveries delivery ON delivery.reply_id=payload.reply_id
          WHERE payload.reply_id=reply.id AND length(trim(payload.answer))>0
            AND delivery.alert_kind='escalation'
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='sent'
            AND ownership.telegram_message_id IS NOT NULL
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='failed',decision='escalate',operator_delivery_status='uncertain',updated_at=?,
        error_code='delivery_state_unknown',decision_reason='服务重启前运营群回复发送结果未知',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND EXISTS (
          SELECT 1 FROM support_reply_payloads payload
          JOIN support_reply_alert_deliveries delivery ON delivery.reply_id=payload.reply_id
          WHERE payload.reply_id=reply.id AND length(trim(payload.answer))>0
            AND delivery.alert_kind='escalation'
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='unknown'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='failed',decision='escalate',operator_delivery_status='failed',updated_at=?,
        error_code='support_delivery_failed',decision_reason='服务重启前运营群回复已明确发送失败',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND EXISTS (
          SELECT 1 FROM support_reply_payloads payload
          JOIN support_reply_alert_deliveries delivery ON delivery.reply_id=payload.reply_id
          WHERE payload.reply_id=reply.id AND length(trim(payload.answer))>0
            AND delivery.alert_kind='escalation'
        ) AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status='failed'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies AS reply SET
        status='generating',operator_delivery_status=NULL,updated_at=?,error_code=NULL
        WHERE status='sending' AND EXISTS (
          SELECT 1 FROM support_threads thread WHERE thread.id=reply.thread_id
            AND thread.status='generating' AND thread.updated_at<?
        ) AND EXISTS (
          SELECT 1 FROM support_reply_payloads payload
          JOIN support_reply_alert_deliveries delivery ON delivery.reply_id=payload.reply_id
          WHERE payload.reply_id=reply.id AND length(trim(payload.answer))>0
            AND delivery.alert_kind='escalation'
        ) AND NOT EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership WHERE ownership.reply_id=reply.id
            AND ownership.output_kind='support_reply' AND ownership.delivery_status IN ('sent','unknown','failed')
        )`).run(now, staleBefore)
      this.database.prepare(`UPDATE support_replies SET
        status='failed',operator_delivery_status='uncertain',updated_at=?,error_code='delivery_state_unknown',
        decision_reason='服务重启前发送状态未知',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND updated_at<? AND thread_id IN (
          SELECT id FROM support_threads WHERE status='closed'
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies SET
        status='superseded',updated_at=?,decision_reason='服务重启，重新生成回答',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status IN ('pending','queued','generating') AND thread_id IN (
          SELECT id FROM support_threads WHERE status='generating' AND updated_at<?
        ) AND NOT EXISTS (
          SELECT 1 FROM support_reply_payloads payload
          WHERE payload.reply_id=support_replies.id AND support_replies.decision='escalate'
            AND length(trim(payload.answer))>0
        )`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_replies SET
        status='failed',operator_delivery_status='uncertain',updated_at=?,error_code='delivery_state_unknown',decision_reason='服务重启前发送状态未知',
        duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
          ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
        WHERE status='sending' AND thread_id IN (
          SELECT id FROM support_threads WHERE status='generating' AND updated_at<?
        )`).run(now, now, staleBefore)
      const result = this.database.prepare(`UPDATE support_threads SET status='collecting',settle_at=?,updated_at=?
        WHERE status='generating' AND updated_at<?`).run(now, now, staleBefore)
      this.database.prepare(`UPDATE support_threads AS thread SET status='answered',updated_at=?
        WHERE status='collecting' AND EXISTS (
          SELECT 1 FROM support_replies reply WHERE reply.thread_id=thread.id
            AND reply.input_revision=thread.revision AND reply.status='replied'
            AND reply.operator_delivery_status='sent'
        )`).run(now)
      this.database.prepare(`UPDATE support_threads AS thread SET status='escalated',updated_at=?
        WHERE status='collecting' AND EXISTS (
          SELECT 1 FROM support_replies reply WHERE reply.thread_id=thread.id
            AND reply.input_revision=thread.revision AND (
              (reply.status='escalated' AND reply.operator_delivery_status='sent')
              OR (reply.status='failed' AND reply.operator_delivery_status IN ('failed','uncertain'))
            )
        )`).run(now)
      this.database.prepare(`UPDATE support_threads AS thread SET status='escalated',updated_at=?
        WHERE status='collecting' AND EXISTS (
          SELECT 1 FROM support_replies reply
          JOIN support_reply_alert_deliveries delivery ON delivery.reply_id=reply.id
          WHERE reply.thread_id=thread.id AND reply.input_revision=thread.revision
            AND delivery.alert_kind='escalation'
            AND reply.status IN ('escalated','failed')
        )`).run(now)
      const replyUpdates = replies.length === 0 ? [] : this.database.prepare(
        `SELECT id,status,duration_ms FROM support_replies WHERE id IN (${replies.map(() => "?").join(",")})`,
      ).all(...replies.map((reply) => String(reply.id))) as SqlRow[]
      return {
        count: Number(result.changes),
        replies: replyUpdates.map((reply) => ({
          id: String(reply.id),
          status: reply.status as ReplyStatus,
          updatedAt: now,
          durationMs: reply.duration_ms === null ? null : Number(reply.duration_ms),
        })),
      }
    })
    recovered.replies.forEach((event) => this.onExpiredReply?.(event))
    return recovered.count
  }

  recoverInterruptedNotifications(now = new Date().toISOString()): { unknownProgress: number; retriedTimeouts: number } {
    return this.database.transaction(() => {
      this.database.prepare(`UPDATE telegram_output_ownership SET delivery_status='unknown',updated_at=?
        WHERE delivery_status='sending' AND notification_id IN (
          SELECT id FROM support_thread_notifications WHERE status='sending'
        )`).run(now)
      const progress = this.database.prepare(`UPDATE support_thread_notifications AS notification SET
        status='unknown',error_message='服务重启前发送状态未知',updated_at=?
        WHERE notification.status='sending' AND notification.kind='progress'
          AND EXISTS(SELECT 1 FROM telegram_output_ownership ownership
            WHERE ownership.notification_id=notification.id)`).run(now)
      this.database.prepare(`UPDATE support_thread_notifications AS notification SET
        status='pending',due_at=?,error_message='服务重启前发送尚未开始，重新发送',updated_at=?
        WHERE notification.status='sending' AND notification.kind='progress'
          AND NOT EXISTS(SELECT 1 FROM telegram_output_ownership ownership
            WHERE ownership.notification_id=notification.id)`).run(now, now)
      this.database.prepare(`UPDATE support_thread_notifications AS notification SET
        status='unknown',error_message='服务重启前 timeout 发送状态未知',updated_at=?
        WHERE status='sending' AND kind IN ('timeout_operator','timeout_alert') AND EXISTS (
          SELECT 1 FROM telegram_output_ownership ownership
          WHERE ownership.notification_id=notification.id
            AND ownership.delivery_status IN ('sending','sent','unknown')
        )`).run(now)
      const timeouts = this.database.prepare(`UPDATE support_thread_notifications SET
        status='pending',due_at=?,error_message='服务重启前发送状态未知，重新发送',updated_at=?
        WHERE status='sending' AND kind IN ('timeout_operator','timeout_alert')`).run(now, now)
      return { unknownProgress: Number(progress.changes), retriedTimeouts: Number(timeouts.changes) }
    })
  }

  claimDueProgress(now = new Date().toISOString()): SupportThreadNotification | null {
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT t.* FROM support_threads t
        WHERE t.status='generating' AND t.answer_operation_mode='live'
          AND t.progress_due_at IS NOT NULL AND t.progress_due_at<=?
          AND NOT EXISTS(SELECT 1 FROM support_thread_output_claims claim
            WHERE claim.thread_id=t.id AND claim.claim_kind='progress')
        ORDER BY t.progress_due_at,t.id`).all(now) as SqlRow[]
      for (const row of rows) {
        const thread = threadFromRow(row)
        const notification = this.claimProgressNotification(
          thread.id,
          thread.revision,
          "scheduled_progress",
          thread.progressDueAt!,
          now,
        )
        this.database.prepare(`UPDATE support_threads SET progress_due_at=NULL,updated_at=?
          WHERE id=? AND revision=? AND status='generating'`).run(now, thread.id, thread.revision)
        if (notification) return notification
      }
      return null
    })
  }

  claimPendingProgressNotification(now = new Date().toISOString()): SupportThreadNotification | null {
    return this.database.transaction(() => {
      const claimPending = (): SupportThreadNotification | null => {
        const row = this.database.prepare(`SELECT notification.* FROM support_thread_notifications notification
          JOIN support_thread_output_claims claim ON claim.notification_id=notification.id
            AND claim.claim_kind='progress'
          JOIN support_threads thread ON thread.id=notification.thread_id
          WHERE notification.kind='progress' AND notification.status='pending' AND notification.due_at<=?
            AND thread.revision=notification.input_revision
            AND thread.status IN ('collecting','generating') AND thread.answer_operation_mode='live'
            AND NOT (claim.source_kind='human_priority' AND thread.human_priority_state='sending')
          ORDER BY notification.due_at,notification.id LIMIT 1`).get(now) as SqlRow | undefined
        if (!row) return null
        return this.claimNotificationSending(String(row.id), now)
      }
      const pending = claimPending()
      if (pending) return pending
      if (!this.claimDueProgress(now)) return null
      return claimPending()
    })
  }

  claimNotificationSending(id: string, now = new Date().toISOString()): SupportThreadNotification | null {
    return this.database.transaction(() => {
      const row = this.database.prepare(`SELECT notification.* FROM support_thread_notifications notification
        JOIN support_threads thread ON thread.id=notification.thread_id
        WHERE notification.id=? AND notification.status='pending'
          AND thread.status IN ('collecting','generating') AND thread.revision=notification.input_revision
          AND thread.answer_operation_mode='live'`).get(id) as SqlRow | undefined
      if (!row) return null
      const result = this.database.prepare(`UPDATE support_thread_notifications SET status='sending',updated_at=?
        WHERE id=? AND status='pending' AND EXISTS (
          SELECT 1 FROM support_threads thread
          WHERE thread.id=support_thread_notifications.thread_id
            AND thread.status IN ('collecting','generating')
            AND thread.revision=support_thread_notifications.input_revision
            AND thread.answer_operation_mode='live'
        )`).run(now, id)
      return Number(result.changes) === 1
        ? notificationFromRow({ ...row, status: "sending", updated_at: now })
        : null
    })
  }

  claimDueTimeout(now = new Date().toISOString()): SupportTimeoutClaim | null {
    const outcome = this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT * FROM support_threads
        WHERE status='generating' AND hard_deadline_at IS NOT NULL AND hard_deadline_at<=?
        ORDER BY hard_deadline_at,id LIMIT 512`).all(now) as SqlRow[]
      for (const row of rows) {
        const claimed = this.claimTimeoutRow(threadFromRow(row), now)
        if (claimed) return claimed
      }
      return null
    })
    outcome?.replyUpdates.forEach((event) => this.onExpiredReply?.(event))
    return outcome?.claim ?? null
  }

  claimHardDeadline(
    threadId: string,
    inputRevision: number,
    now = new Date().toISOString(),
  ): SupportTimeoutClaim | null {
    const outcome = this.database.transaction(() => {
      const row = this.database.prepare(`SELECT * FROM support_threads
        WHERE id=? AND revision=? AND status='generating'
          AND hard_deadline_at IS NOT NULL AND hard_deadline_at<=?`).get(
        threadId,
        inputRevision,
        now,
      ) as SqlRow | undefined
      return row ? this.claimTimeoutRow(threadFromRow(row), now) : null
    })
    outcome?.replyUpdates.forEach((event) => this.onExpiredReply?.(event))
    return outcome?.claim ?? null
  }

  claimPendingNotification(kinds: SupportThreadNotificationKind[], now = new Date().toISOString()): SupportThreadNotification | null {
    if (kinds.length === 0) return null
    return this.database.transaction(() => {
      const placeholders = kinds.map(() => "?").join(",")
      this.database.prepare(`UPDATE support_thread_notifications AS notification SET
        status='failed',error_message='学习模式禁止 Telegram 输出',updated_at=?
        WHERE notification.status IN ('pending','sending') AND notification.kind IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM support_threads thread
            WHERE thread.id=notification.thread_id AND thread.answer_operation_mode='learning'
          )`).run(now, ...kinds)
      const row = this.database.prepare(`SELECT notification.* FROM support_thread_notifications notification
        JOIN support_threads thread ON thread.id=notification.thread_id
        WHERE notification.status='pending' AND notification.due_at<=?
          AND notification.kind IN (${placeholders}) AND thread.answer_operation_mode='live'
        ORDER BY notification.due_at,notification.id LIMIT 1`).get(now, ...kinds) as SqlRow | undefined
      if (!row) return null
      const result = this.database.prepare(`UPDATE support_thread_notifications SET status='sending',updated_at=?
        WHERE id=? AND status='pending' AND EXISTS (
          SELECT 1 FROM support_threads thread
          WHERE thread.id=support_thread_notifications.thread_id AND thread.answer_operation_mode='live'
        )`).run(now, String(row.id))
      if (Number(result.changes) !== 1) return null
      return notificationFromRow({ ...row, status: "sending", updated_at: now })
    })
  }

  completeNotification(
    id: string,
    telegramMessageId: string | null,
    outboundText: string | null,
    now = new Date().toISOString(),
  ): void {
    if (telegramMessageId !== null && !outboundText?.trim()) {
      throw new Error("已发送线程通知缺少真实出站文本")
    }
    this.database.prepare(`UPDATE support_thread_notifications SET
      status='sent',telegram_message_id=?,outbound_text=?,error_message=NULL,updated_at=?
      WHERE id=? AND status='sending'`).run(
      telegramMessageId, outboundText, now, id,
    )
  }

  failNotification(id: string, reason: string, now = new Date().toISOString()): void {
    this.database.prepare(`UPDATE support_thread_notifications SET
      status='failed',error_message=?,updated_at=? WHERE id=? AND status IN ('pending','sending')`).run(reason.slice(0, 1000), now, id)
  }

  markNotificationUnknown(id: string, reason: string, now = new Date().toISOString()): void {
    this.database.prepare(`UPDATE support_thread_notifications SET
      status='unknown',error_message=?,updated_at=? WHERE id=? AND status='sending'`).run(reason.slice(0, 1000), now, id)
  }

  closeThread(
    threadId: string,
    actor: string,
    reason: string,
    now = new Date().toISOString(),
  ): CloseThreadResult {
    const result = this.database.transaction(() => this.closeThreadRows(threadId, actor, reason, now))
    result.replyUpdates.forEach((event) => this.onExpiredReply?.(event))
    return result
  }

  mergeThreadInto(
    sourceThreadId: string,
    targetThreadId: string,
    reason: string,
    evidenceEventIds: string[],
    now = new Date().toISOString(),
  ): boolean {
    if (sourceThreadId === targetThreadId || evidenceEventIds.length === 0) return false
    const result = this.database.transaction((): CloseThreadResult | null => {
      const source = this.getThread(sourceThreadId)
      const target = this.getThread(targetThreadId)
      if (source.groupId !== target.groupId
        || source.projectId !== target.projectId
        || source.serviceId !== target.serviceId
        || source.status === "closed") return null
      const supported = this.database.prepare(`SELECT 1 FROM support_thread_messages
        WHERE thread_id=? AND message_event_id IN (${evidenceEventIds.map(() => "?").join(",")}) LIMIT 1`).get(
        sourceThreadId,
        ...evidenceEventIds,
      )
      if (!supported) return null
      this.database.prepare(`INSERT OR IGNORE INTO support_thread_links(
        source_thread_id,target_thread_id,relation,reason,created_at
      ) VALUES (?,?,'merged_into',?,?)`).run(sourceThreadId, targetThreadId, reason.slice(0, 1000), now)
      return this.closeThreadRows(sourceThreadId, "AI 客服", reason, now)
    })
    result?.replyUpdates.forEach((event) => this.onExpiredReply?.(event))
    return result !== null
  }

  linkSplitThread(
    sourceThreadId: string,
    targetThreadId: string,
    reason: string,
    now = new Date().toISOString(),
  ): boolean {
    if (sourceThreadId === targetThreadId) return false
    const source = this.getThread(sourceThreadId)
    const target = this.getThread(targetThreadId)
    if (source.groupId !== target.groupId
      || source.projectId !== target.projectId
      || source.serviceId !== target.serviceId) {
      throw new Error("拆分问题必须属于同一群和服务")
    }
    const result = this.database.prepare(`INSERT OR IGNORE INTO support_thread_links(
      source_thread_id,target_thread_id,relation,reason,created_at
    ) VALUES (?,?,'split_from',?,?)`).run(
      targetThreadId,
      sourceThreadId,
      reason.slice(0, 1000),
      now,
    )
    return Number(result.changes) === 1
  }

  takeOverByHuman<T>(
    threadId: string,
    actor: string,
    complete: (result: HumanTakeoverResult) => T,
    now = new Date().toISOString(),
  ): { takeover: HumanTakeoverResult; value: T } {
    const completed = this.database.transaction((): { takeover: HumanTakeoverResult; value: T } => {
      const current = this.getThread(threadId)
      if (["answered", "escalated", "closed"].includes(current.status)) {
        const takeover: HumanTakeoverResult = {
          changed: false,
          thread: current,
          replyUpdates: [],
          takeoverStatus: "thread_already_terminal",
        }
        return { takeover, value: complete(takeover) }
      }
      const deliveryInFlight = Boolean(this.database.prepare(
        `SELECT 1 FROM support_replies
          WHERE thread_id=? AND (status='sending' OR EXISTS (
            SELECT 1 FROM support_reply_alert_deliveries delivery
            WHERE delivery.reply_id=support_replies.id AND delivery.status='sending'
          ))
          UNION ALL
          SELECT 1 FROM support_thread_notifications
          WHERE thread_id=? AND status='sending'
          UNION ALL
          SELECT 1 FROM telegram_output_ownership
          WHERE thread_id=? AND delivery_status='sending'
          LIMIT 1`,
      ).get(threadId, threadId, threadId))
      const closed = this.closeThreadRows(threadId, actor, "可信人工回复接管", now)
      const takeover: HumanTakeoverResult = {
        ...closed,
        takeoverStatus: deliveryInFlight ? "delivery_in_flight" : "cancelled",
      }
      return { takeover, value: complete(takeover) }
    })
    completed.takeover.replyUpdates.forEach((event) => this.onExpiredReply?.(event))
    return completed
  }

  getThreadDetail(id: string): SupportThreadDetail {
    const thread = this.getThread(id)
    const rows = this.database.prepare(`SELECT
      tm.thread_id,tm.message_event_id,tm.relation,tm.question_fragment,tm.position,tm.created_at AS relation_created_at,
      e.*
      FROM support_thread_messages tm JOIN support_message_events e ON e.id=tm.message_event_id
      WHERE tm.thread_id=? ORDER BY tm.position,tm.created_at,tm.message_event_id`).all(id) as SqlRow[]
    const eventIds = rows.map((row) => String(row.message_event_id))
    const attachmentRows = eventIds.length === 0 ? [] : this.database.prepare(
      `SELECT * FROM support_message_attachments WHERE message_event_id IN (${eventIds.map(() => "?").join(",")})
       ORDER BY created_at,id`,
    ).all(...eventIds) as SqlRow[]
    const attachments = new Map<string, SupportMessageAttachment[]>()
    attachmentRows.map(attachmentFromRow).forEach((attachment) => attachments.set(attachment.messageEventId, [
      ...(attachments.get(attachment.messageEventId) ?? []),
      attachment,
    ]))
    return {
      thread,
      messages: rows.map((row) => {
        const event = eventFromRow(row)
        const message = supportThreadMessageSchema.parse({
          threadId: row.thread_id,
          messageEventId: row.message_event_id,
          relation: row.relation,
          questionFragment: row.question_fragment,
          position: Number(row.position),
          createdAt: row.relation_created_at,
        })
        return { ...message, event, attachments: attachments.get(event.id) ?? [] }
      }),
    }
  }

  listThreadForwardMessageIds(id: string): string[] {
    const direct = this.getThreadDetail(id).messages.map((message) => message.event)
    const included = new Map<string, SupportMessageEvent>()
    const pending = [...direct]
    const traversed = new Set<string>()
    while (pending.length > 0 && traversed.size < 200) {
      const event = pending.shift()!
      if (traversed.has(event.id)) continue
      traversed.add(event.id)
      if (event.senderRole === null) included.set(event.id, event)

      if (event.replyToMessageId) {
        const referenced = this.getEventByTelegramMessage(event.groupId, event.replyToMessageId)
        if (referenced && !traversed.has(referenced.id)) pending.push(referenced)
      }
      if (event.mediaGroupId) {
        const siblings = this.database.prepare(`SELECT * FROM support_message_events
          WHERE group_id=? AND media_group_id=? ORDER BY created_at,telegram_message_id,id`).all(
          event.groupId, event.mediaGroupId,
        ) as SqlRow[]
        for (const sibling of siblings.map(eventFromRow)) {
          if (!traversed.has(sibling.id)) pending.push(sibling)
        }
      }
    }
    return [...included.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || Number(left.telegramMessageId) - Number(right.telegramMessageId)
        || left.id.localeCompare(right.id))
      .map((event) => event.telegramMessageId)
  }

  getEvent(id: string): SupportMessageEvent {
    const row = this.database.prepare("SELECT * FROM support_message_events WHERE id=?").get(id) as SqlRow | undefined
    if (!row) throw new Error("客服消息事件不存在")
    return eventFromRow(row)
  }

  getEventAttachments(id: string): SupportMessageAttachment[] {
    return (this.database.prepare(`SELECT * FROM support_message_attachments
      WHERE message_event_id=? ORDER BY created_at,id`).all(id) as SqlRow[]).map(attachmentFromRow)
  }

  getEventByTelegramMessage(groupId: string, telegramMessageId: string): SupportMessageEvent | null {
    return this.findEvent(groupId, telegramMessageId)
  }

  getEventRelation(eventId: string): { thread: SupportThread; relation: SupportThreadRelation } | null {
    const row = this.database.prepare(`SELECT t.*,tm.relation AS message_relation
      FROM support_thread_messages tm JOIN support_threads t ON t.id=tm.thread_id
      WHERE tm.message_event_id=? LIMIT 1`).get(eventId) as SqlRow | undefined
    return row ? { thread: threadFromRow(row), relation: row.message_relation as SupportThreadRelation } : null
  }

  listUnroutedEvents(): SupportMessageEvent[] {
    return (this.database.prepare(`SELECT e.* FROM support_message_events e
      WHERE e.route_status IN ('received','batched','command')
        AND NOT EXISTS (
          SELECT 1 FROM support_thread_messages tm WHERE tm.message_event_id=e.id
        )
      ORDER BY e.created_at,e.id`).all() as SqlRow[]).map(eventFromRow)
  }

  findThreadByBatch(batchId: string): SupportThread | null {
    const row = this.database.prepare(`SELECT t.* FROM support_threads t
      WHERE t.origin_batch_id=? OR EXISTS (
        SELECT 1 FROM support_thread_messages tm
        JOIN support_message_events e ON e.id=tm.message_event_id
        WHERE tm.thread_id=t.id AND e.ingest_batch_id=?
      )
      ORDER BY t.created_at,t.id LIMIT 1`).get(batchId, batchId) as SqlRow | undefined
    return row ? threadFromRow(row) : null
  }

  findThreadByEvent(eventId: string): SupportThread | null {
    const row = this.database.prepare(`SELECT t.* FROM support_thread_messages tm
      JOIN support_threads t ON t.id=tm.thread_id
      WHERE tm.message_event_id=? ORDER BY t.created_at,t.id LIMIT 1`).get(eventId) as SqlRow | undefined
    return row ? threadFromRow(row) : null
  }

  private findEvent(groupId: string, telegramMessageId: string): SupportMessageEvent | null {
    const row = this.database.prepare(
      "SELECT * FROM support_message_events WHERE group_id=? AND telegram_message_id=?",
    ).get(groupId, telegramMessageId) as SqlRow | undefined
    return row ? eventFromRow(row) : null
  }

  getThread(id: string): SupportThread {
    const row = this.database.prepare("SELECT * FROM support_threads WHERE id=?").get(id) as SqlRow | undefined
    if (!row) throw new Error("客服问题线程不存在")
    return threadFromRow(row)
  }

  private insertThreadMessage(
    threadId: string,
    eventId: string,
    relation: SupportThreadRelation,
    questionFragment: string,
    position: number,
    createdAt: string,
  ): boolean {
    const result = this.database.prepare(`INSERT OR IGNORE INTO support_thread_messages(
      thread_id,message_event_id,relation,question_fragment,position,created_at
    ) VALUES (?,?,?,?,?,?)`).run(threadId, eventId, relation, questionFragment, position, createdAt)
    return Number(result.changes) === 1
  }

  private upsertSenderFocus(thread: SupportThread, focus: SenderFocusUpdate, focusedAt: string): void {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.parse(focusedAt) + THREAD_EXPIRY_MS).toISOString()
    this.database.prepare(`INSERT INTO support_sender_focus(
      group_id,service_id,sender_user_id,thread_id,source,last_operator_message_id,last_bot_message_id,
      focused_at,expires_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(group_id,service_id,sender_user_id) DO UPDATE SET
      thread_id=excluded.thread_id,source=excluded.source,
      last_operator_message_id=excluded.last_operator_message_id,
      last_bot_message_id=COALESCE(excluded.last_bot_message_id,support_sender_focus.last_bot_message_id),
      focused_at=excluded.focused_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    WHERE excluded.focused_at>=support_sender_focus.focused_at`).run(
      thread.groupId,
      thread.serviceId,
      focus.senderUserId,
      thread.id,
      focus.source,
      focus.operatorMessageId,
      focus.botMessageId ?? null,
      focusedAt,
      expiresAt,
      now,
      now,
    )
  }

  private setEventRoute(id: string, status: SupportEventRouteStatus, skipReason: string | null): void {
    this.database.prepare("UPDATE support_message_events SET route_status=?,skip_reason=? WHERE id=?").run(status, skipReason, id)
  }

  private humanPriorityTarget(value: unknown): {
    userIds: string[]
    mentionedTechnical: boolean
    ignoredUserIds: string[]
  } {
    try {
      const parsed = JSON.parse(String(value)) as unknown
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && /^\d+$/u.test(item))) {
        const userIds = [...new Set(parsed)]
        return {
          userIds,
          mentionedTechnical: this.includesEnabledTechnical(userIds),
          ignoredUserIds: userIds.filter((id) => this.isEnabledIgnored(id)),
        }
      }
      if (typeof parsed !== "object" || parsed === null) {
        return { userIds: [], mentionedTechnical: false, ignoredUserIds: [] }
      }
      const candidate = parsed as { userIds?: unknown; mentionedTechnical?: unknown; ignoredUserIds?: unknown }
      if (!Array.isArray(candidate.userIds)
        || !candidate.userIds.every((item) => typeof item === "string" && /^\d+$/u.test(item))
        || typeof candidate.mentionedTechnical !== "boolean") {
        return { userIds: [], mentionedTechnical: false, ignoredUserIds: [] }
      }
      const userIds = [...new Set(candidate.userIds)]
      const ignoredUserIds = Array.isArray(candidate.ignoredUserIds)
        && candidate.ignoredUserIds.every((item) => typeof item === "string" && /^\d+$/u.test(item))
        ? [...new Set(candidate.ignoredUserIds)].filter((id) => userIds.includes(id))
        : userIds.filter((id) => this.isEnabledIgnored(id))
      return {
        userIds,
        mentionedTechnical: candidate.mentionedTechnical,
        ignoredUserIds,
      }
    } catch {
      return { userIds: [], mentionedTechnical: false, ignoredUserIds: [] }
    }
  }

  private includesEnabledTechnical(userIds: string[]): boolean {
    if (userIds.length === 0) return false
    return Boolean(this.database.prepare(`SELECT 1 FROM telegram_roles
      WHERE enabled=1 AND role='technical' AND telegram_user_id IN (${userIds.map(() => "?").join(",")})
      LIMIT 1`).get(...userIds))
  }

  private isEnabledTechnical(userId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM telegram_roles
      WHERE enabled=1 AND role='technical' AND telegram_user_id=? LIMIT 1`).get(userId))
  }

  private isEnabledIgnored(userId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM telegram_roles
      WHERE enabled=1 AND role='ignored' AND telegram_user_id=? LIMIT 1`).get(userId))
  }

  private applyHumanPriorityFromEvent(threadId: string, eventId: string, now: string): void {
    const mode = this.database.prepare(`SELECT answer_operation_mode,human_priority_state,
      human_priority_user_ids_json,human_priority_due_at
      FROM support_threads WHERE id=?`).get(threadId) as
      | {
        answer_operation_mode?: string
        human_priority_state?: string
        human_priority_user_ids_json?: string
        human_priority_due_at?: string | null
      }
      | undefined
    if (mode?.answer_operation_mode === "learning") return
    const event = this.database.prepare(`SELECT rowid AS source_rowid,group_id,created_at,
      human_priority_user_ids_json,human_priority_due_at
      FROM support_message_events WHERE id=?`).get(eventId) as SqlRow | undefined
    if (!event?.human_priority_due_at) return
    const eventTarget = this.humanPriorityTarget(event.human_priority_user_ids_json)
    const progressStarted = this.hasStartedProgress(threadId)
    const currentTarget = this.humanPriorityTarget(mode?.human_priority_user_ids_json ?? "[]")
    const target = progressStarted ? {
      userIds: [...new Set([...currentTarget.userIds, ...eventTarget.userIds])],
      mentionedTechnical: currentTarget.mentionedTechnical || eventTarget.mentionedTechnical,
      ignoredUserIds: [...new Set([...currentTarget.ignoredUserIds, ...eventTarget.ignoredUserIds])],
    } : eventTarget
    const userIds = target.userIds
    if (userIds.length === 0) return
    const dueAt = progressStarted
      ? mode?.human_priority_due_at
        ?? new Date(Date.parse(String(event.created_at)) + HUMAN_PRIORITY_WAIT_MS).toISOString()
      : String(event.human_priority_due_at)
    const targetJson = JSON.stringify(target)
    const responseCandidates = this.database.prepare(`SELECT input.id,input.sender_user_id
      FROM support_message_events input
      WHERE input.group_id=? AND input.id<>? AND input.route_status='role_skipped' AND input.created_at<=?
        AND (input.created_at>? OR (input.created_at=? AND input.rowid>?))
      ORDER BY input.created_at,input.rowid`).all(
      String(event.group_id),
      eventId,
      now,
      String(event.created_at),
      String(event.created_at),
      Number(event.source_rowid),
    ) as SqlRow[]
    const response = responseCandidates.find((candidate) => {
      const senderUserId = String(candidate.sender_user_id)
      return (target.mentionedTechnical && this.isEnabledTechnical(senderUserId))
        || (target.ignoredUserIds.includes(senderUserId) && this.isEnabledIgnored(senderUserId))
    })
    if (response) {
      const reason = target.mentionedTechnical && this.isEnabledTechnical(String(response.sender_user_id))
        ? "技术角色已在人工等待前回应"
        : "被@人员已在人工等待前回应"
      this.database.prepare(`UPDATE support_threads SET
        human_priority_state='answered',human_priority_user_ids_json=?,human_priority_due_at=?,
        human_priority_source_event_id=?,human_priority_error=?,updated_at=? WHERE id=?`).run(
        targetJson,
        dueAt,
        eventId,
        `${reason} message_event_id=${String(response.id)}`.slice(0, 1000),
        now,
        threadId,
      )
      this.closeThreadRows(threadId, "群内人工", reason, now)
      return
    }
    if (progressStarted && mode?.human_priority_state !== "none") {
      this.database.prepare(`UPDATE support_threads SET
        human_priority_user_ids_json=?,human_priority_error=NULL,updated_at=?
        WHERE id=? AND status='collecting'`).run(targetJson, now, threadId)
      return
    }
    this.database.prepare(`UPDATE support_threads SET
      status='collecting',settle_at=?,generation_started_at=NULL,progress_due_at=NULL,hard_deadline_at=NULL,
      human_priority_state='waiting',human_priority_user_ids_json=?,human_priority_due_at=?,
      human_priority_source_event_id=?,human_priority_progress_message_id=NULL,human_priority_error=NULL,
      closed_at=NULL,closed_by=NULL,closed_reason=NULL,updated_at=? WHERE id=?`).run(
      dueAt,
      targetJson,
      dueAt,
      eventId,
      now,
      threadId,
    )
  }

  private closeExpiredGeneratingForRoute(groupId: string, serviceId: string, reference: string | Date): void {
    const { now, cutoff } = expiryTimes(reference)
    const rows = this.database.prepare(`SELECT id FROM support_threads
      WHERE group_id=? AND service_id=? AND status='generating' AND latest_message_at<=?`).all(
      groupId, serviceId, cutoff,
    ) as SqlRow[]
    rows.forEach((row) => this.closeThread(String(row.id), "AI 客服", "超过30分钟后收到新问题", now))
  }

  private claimTimeoutRow(
    thread: SupportThread,
    now: string,
  ): { claim: SupportTimeoutClaim; replyUpdates: ExpiredReplyUpdate[] } | null {
    if (thread.answerOperationMode === "live" && this.hasStartedProgress(thread.id)) {
      const reply = this.database.prepare(`SELECT reply.id,reply.status,reply.decision,reply.error_code,payload.answer
        FROM support_replies reply JOIN support_reply_payloads payload ON payload.reply_id=reply.id
        WHERE reply.thread_id=? AND reply.input_revision=?
        ORDER BY reply.created_at DESC,reply.id DESC LIMIT 1`).get(thread.id, thread.revision) as SqlRow | undefined
      if (!reply) return null
      const ordinaryDeliveryAlreadyPrepared = reply.status === "generating"
        && reply.decision === "escalate"
        && reply.error_code !== HARD_DEADLINE_ERROR_CODE
        && String(reply.answer ?? "").trim().length > 0
      if (reply.status === "sending" || ordinaryDeliveryAlreadyPrepared) {
        const updated = this.database.prepare(`UPDATE support_threads SET
          progress_due_at=NULL,hard_deadline_at=NULL,updated_at=?
          WHERE id=? AND revision=? AND status='generating'
            AND hard_deadline_at IS NOT NULL AND hard_deadline_at<=?`).run(
          now,
          thread.id,
          thread.revision,
          now,
        )
        if (Number(updated.changes) !== 1) return null
        return {
          claim: {
            threadId: thread.id,
            inputRevision: thread.revision,
            outcome: "delivery_in_flight",
            replyId: String(reply.id),
            notificationKinds: [],
          },
          replyUpdates: [],
        }
      }
      if (reply.status !== "generating") {
        const closed = this.closeThreadRows(
          thread.id,
          "AI 客服",
          "hard deadline 到达时最终回复已进入持久发送或终态恢复边界",
          now,
        )
        if (!closed.changed) return null
        return {
          claim: {
            threadId: thread.id,
            inputRevision: thread.revision,
            outcome: "closed",
            replyId: null,
            notificationKinds: [],
          },
          replyUpdates: closed.replyUpdates,
        }
      }
      const replyId = String(reply.id)
      if (!this.claimHandoff(replyId, "hard_deadline", now)) {
        const owner = this.database.prepare(`SELECT reply_id FROM support_thread_output_claims
          WHERE thread_id=? AND claim_kind='handoff'`).get(thread.id) as SqlRow | undefined
        if (!owner?.reply_id) throw new Error("handoff 领取冲突但未找到持久 owner")
        const updated = this.database.prepare(`UPDATE support_threads SET
          progress_due_at=NULL,hard_deadline_at=NULL,updated_at=?
          WHERE id=? AND revision=? AND status='generating'`).run(now, thread.id, thread.revision)
        if (Number(updated.changes) !== 1) return null
        return {
          claim: {
            threadId: thread.id,
            inputRevision: thread.revision,
            outcome: "delivery_in_flight",
            replyId: String(owner.reply_id),
            notificationKinds: [],
          },
          replyUpdates: [],
        }
      }
      const prepared = this.database.prepare(`UPDATE support_replies SET
        decision='escalate',updated_at=?,error_code=?,decision_reason=?,decision_confidence=0
        WHERE id=? AND thread_id=? AND input_revision=? AND status='generating'
          AND EXISTS(SELECT 1 FROM support_threads current
            WHERE current.id=support_replies.thread_id AND current.status='generating'
              AND current.revision=support_replies.input_revision
              AND current.hard_deadline_at IS NOT NULL AND current.hard_deadline_at<=?)`).run(
        now,
        HARD_DEADLINE_ERROR_CODE,
        "排查超过1小时且已发送进度提示，转技术继续处理\n技术告警：发送中",
        replyId,
        thread.id,
        thread.revision,
        now,
      )
      if (Number(prepared.changes) !== 1) return null
      this.database.prepare(`UPDATE support_reply_payloads SET answer=?,quote_text=NULL WHERE reply_id=?`).run(
        TECHNICAL_AVAILABILITY_REPLY_PENDING,
        replyId,
      )
      this.database.prepare("DELETE FROM reply_memory_refs WHERE reply_id=?").run(replyId)
      this.database.prepare(`UPDATE support_thread_notifications SET
        status='failed',error_message='hard deadline 已复用此前进度提示',updated_at=?
        WHERE thread_id=? AND kind='progress' AND status='pending'`).run(now, thread.id)
      const updated = this.database.prepare(`UPDATE support_threads SET
        progress_due_at=NULL,hard_deadline_at=NULL,updated_at=?
        WHERE id=? AND revision=? AND status='generating'`).run(now, thread.id, thread.revision)
      if (Number(updated.changes) !== 1) throw new Error("hard deadline 技术升级未能保持当前问题版本")
      return {
        claim: {
          threadId: thread.id,
          inputRevision: thread.revision,
          outcome: "prepared_escalation",
          replyId,
          notificationKinds: [],
        },
        replyUpdates: [],
      }
    }

    const closed = this.closeThreadRows(thread.id, "AI 客服", "排查超过1小时", now)
    if (!closed.changed) return null
    const notificationKinds: [] | ["timeout_operator", "timeout_alert"] = thread.answerOperationMode === "learning"
      ? []
      : ["timeout_operator", "timeout_alert"]
    if (notificationKinds.length > 0) {
      const insert = this.database.prepare(`INSERT OR IGNORE INTO support_thread_notifications(
        id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      notificationKinds.forEach((kind) => insert.run(
        randomUUID(), thread.id, thread.revision, kind, "pending", now, null, null, now, now,
      ))
    }
    return {
      claim: {
        threadId: thread.id,
        inputRevision: thread.revision,
        outcome: "closed",
        replyId: null,
        notificationKinds,
      },
      replyUpdates: closed.replyUpdates,
    }
  }

  private closeThreadRows(threadId: string, actor: string, reason: string, now: string): CloseThreadResult {
    const current = this.getThread(threadId)
    if (current.status === "closed") return { changed: false, thread: current, replyUpdates: [] }
    const replies = this.database.prepare(`SELECT id,status FROM support_replies
      WHERE thread_id=? AND status IN ('pending','queued','generating')`).all(threadId) as SqlRow[]
    this.database.prepare(`UPDATE support_replies SET
      status='superseded',updated_at=?,decision_reason=COALESCE(NULLIF(decision_reason,''),?),
      duration_ms=CASE WHEN generation_started_at IS NULL THEN duration_ms
        ELSE CAST(MAX(0,(julianday(?) - julianday(generation_started_at))*86400000) AS INTEGER) END
      WHERE thread_id=? AND status IN ('pending','queued','generating')`).run(now, reason.slice(0, 2000), now, threadId)
    this.database.prepare(`UPDATE support_thread_notifications SET status='failed',error_message=?,updated_at=?
      WHERE thread_id=? AND status='pending' AND kind='progress'`).run(reason.slice(0, 1000), now, threadId)
    this.database.prepare(`UPDATE support_thread_notifications SET status='unknown',error_message=?,updated_at=?
      WHERE thread_id=? AND status='sending' AND kind='progress'`).run(reason.slice(0, 1000), now, threadId)
    const updated = this.database.prepare(`UPDATE support_threads SET
      status='closed',closed_at=?,closed_by=?,closed_reason=?,updated_at=? WHERE id=? AND status<>'closed'`).run(
      now, actor.slice(0, 160), reason.slice(0, 1000), now, threadId,
    )
    const replyUpdates = replies.length === 0 ? [] : this.database.prepare(
      `SELECT id,status,duration_ms FROM support_replies WHERE id IN (${replies.map(() => "?").join(",")})`,
    ).all(...replies.map((reply) => String(reply.id))).map((reply) => ({
      id: String((reply as SqlRow).id),
      status: (reply as SqlRow).status as "superseded" | "failed",
      updatedAt: now,
      durationMs: (reply as SqlRow).duration_ms === null ? null : Number((reply as SqlRow).duration_ms),
    }))
    return { changed: Number(updated.changes) === 1, thread: this.getThread(threadId), replyUpdates }
  }
}
