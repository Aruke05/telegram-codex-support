import { randomUUID } from "node:crypto"

import { z } from "zod"

import type { RuntimeDatabase } from "../runtime/database.js"
import type { ReplyRecord, ReplyStatus } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { ReplyEventBus } from "./reply-event-bus.js"

const pendingInputSchema = z.object({
  threadId: z.string().uuid().nullable().default(null),
  inputRevision: z.number().int().positive().nullable().default(null),
  groupId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  serviceId: z.string().uuid().nullable(),
  telegramMessageId: z.string().trim().max(80).nullable(),
  senderUserId: z.string().trim().max(80).nullable(),
  senderUsername: z.string().trim().max(120).nullable(),
  senderDisplayName: z.string().trim().max(240).nullable(),
  senderRole: z.enum(["operator", "technical", "reviewer", "ignored"]).nullable(),
  service: z.string().trim().max(120),
  serviceSource: z.enum(["group_binding", "technical_command"]).nullable(),
  question: z.string().trim().min(1).max(12000),
}).strict()

const workStatuses: ReplyStatus[] = ["pending", "queued", "generating", "sending", "failed"]
const terminalStatuses = new Set<ReplyStatus>(["replied", "ignored", "escalated", "failed", "corrected", "superseded"])
const allowedTransitions: Record<ReplyStatus, ReplyStatus[]> = {
  pending: ["queued", "generating", "ignored", "escalated", "failed"],
  queued: ["generating", "ignored", "escalated", "failed"],
  generating: ["sending", "ignored", "escalated", "failed", "superseded"],
  sending: ["replied", "escalated", "failed"],
  replied: ["correcting"],
  ignored: ["correcting"],
  escalated: ["correcting"],
  failed: ["queued", "generating", "escalated"],
  correcting: ["corrected", "failed"],
  corrected: ["correcting"],
  superseded: [],
}

type ReplyTransitionMetadata = {
  telegramReplyMessageId?: string | null
  answer?: string
  quote?: string | null
  codeRevision?: string | null
  codeSnapshotId?: string | null
  codeSyncBatchId?: string | null
  errorCode?: string | null
  memoryVersionRefs?: string[]
  decisionReason?: string | null
  decisionConfidence?: number | null
  operatorDeliveryStatus?: ReplyRecord["operatorDeliveryStatus"]
}
type TechnicalAlertDeliveryStatus = "sent" | "not_configured" | "failed" | "uncertain"
export type TechnicalAlertKind =
  | "legacy_code_sync"
  | "code_sync_fallback"
  | "code_sync_message_evidence"
  | "support_delivery_failure"
  | "escalation"
  | "code_sync_unavailable"
  | "investigation_runtime_failure"

export type ReplyListItem = Omit<ReplyRecord, "question" | "answer" | "quote" | "memoryVersionRefs"> & {
  questionPreview: string
  answerPreview: string
}

export type ReplyCursorPage = { items: ReplyListItem[]; nextCursor: string | null }

function listItem(record: ReplyRecord): ReplyListItem {
  const { question, answer, quote: _quote, memoryVersionRefs: _refs, ...item } = record
  return { ...item, questionPreview: question.slice(0, 240), answerPreview: answer.slice(0, 240) }
}

function encodeCursor(record: ReplyRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: record.createdAt, id: record.id }), "utf8").toString("base64url")
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown }
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error()
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    throw new Error("客服记录游标无效")
  }
}

export class ReplyService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly events: ReplyEventBus,
    private readonly redactor: ConfiguredSecretRedactor,
  ) {}

  createPending(input: unknown): ReplyRecord {
    const parsed = pendingInputSchema.parse(input)
    const question = parsed.question.trim()
    if (!question) throw new Error("问题内容为空")
    const now = new Date().toISOString()
    const record: ReplyRecord = {
      ...parsed, question,
      id: randomUUID(), telegramReplyMessageId: null, answer: "", quote: null,
      decision: "pending", status: "pending", memoryVersionRefs: [], codeRevision: null,
      codeSnapshotId: null, codeSyncBatchId: null,
      operatorDeliveryStatus: null,
      createdAt: now, updatedAt: now, generationStartedAt: null, heartbeatAt: null,
      durationMs: null, errorCode: null, correctedAt: null,
      decisionReason: null, decisionConfidence: null,
    }
    this.database.insertReply(record)
    this.events.publish({ id: record.id, status: record.status, updatedAt: now, durationMs: null })
    return record
  }

  transition(id: string, status: ReplyStatus, metadata: ReplyTransitionMetadata = {}): ReplyRecord {
    const found = this.getDetail(id)
    if (!allowedTransitions[found.status].includes(status)) throw new Error("客服记录状态流转无效")
    const now = new Date().toISOString()
    const generationStartedAt = status === "generating" ? (found.generationStartedAt ?? now) : found.generationStartedAt
    const heartbeatAt = status === "generating" ? now : found.heartbeatAt
    const durationMs = terminalStatuses.has(status) && generationStartedAt
      ? Math.max(0, Date.parse(now) - Date.parse(generationStartedAt))
      : found.durationMs
    const decision = status === "ignored" ? "ignore" : status === "escalated" ? "escalate"
      : status === "replied" || status === "corrected" ? "reply" : found.decision
    const operatorDeliveryStatus = metadata.operatorDeliveryStatus !== undefined
      ? metadata.operatorDeliveryStatus
      : (["replied", "escalated"].includes(status) && found.operatorDeliveryStatus === "sending")
        ? "sent"
        : found.operatorDeliveryStatus
    this.database.transaction(() => {
      this.database.prepare(`UPDATE support_replies SET status=?,decision=?,telegram_reply_message_id=?,code_revision=?,
        code_snapshot_id=?,code_sync_batch_id=?,operator_delivery_status=?,updated_at=?,generation_started_at=?,heartbeat_at=?,duration_ms=?,error_code=?,decision_reason=?,decision_confidence=? WHERE id=?`).run(
        status, decision, metadata.telegramReplyMessageId === undefined ? found.telegramReplyMessageId : metadata.telegramReplyMessageId,
        metadata.codeRevision === undefined ? found.codeRevision : metadata.codeRevision,
        metadata.codeSnapshotId === undefined ? found.codeSnapshotId : metadata.codeSnapshotId,
        metadata.codeSyncBatchId === undefined ? found.codeSyncBatchId : metadata.codeSyncBatchId,
        operatorDeliveryStatus, now, generationStartedAt,
        heartbeatAt, durationMs, metadata.errorCode === undefined ? found.errorCode : metadata.errorCode,
        metadata.decisionReason === undefined ? found.decisionReason : metadata.decisionReason,
        metadata.decisionConfidence === undefined ? found.decisionConfidence : metadata.decisionConfidence, id,
      )
      if (metadata.answer !== undefined || metadata.quote !== undefined) {
        const answer = metadata.answer === undefined ? found.answer : this.redactor.assertSafeOutbound(metadata.answer).safeText
        const quote = metadata.quote === undefined || metadata.quote === null
          ? metadata.quote === undefined ? found.quote : null
          : this.redactor.redact(metadata.quote).text
        this.database.prepare(`UPDATE support_reply_payloads SET answer=?,quote_text=? WHERE reply_id=?`).run(
          answer, quote, id,
        )
      }
      if (metadata.memoryVersionRefs !== undefined) {
        this.database.prepare("DELETE FROM reply_memory_refs WHERE reply_id=?").run(id)
        const insert = this.database.prepare("INSERT OR IGNORE INTO reply_memory_refs(reply_id,memory_version_id) VALUES (?,?)")
        metadata.memoryVersionRefs.forEach((versionId) => insert.run(id, versionId))
      }
    })
    const updated = this.getDetail(id)
    this.events.publish({ id, status, updatedAt: updated.updatedAt, durationMs: updated.durationMs })
    return updated
  }

  claimSending(id: string, metadata: ReplyTransitionMetadata = {}): ReplyRecord | null {
    const found = this.getDetail(id)
    if (found.status !== "generating") return null
    const now = new Date().toISOString()
    let claimed = false
    this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE support_replies SET
        status='sending',telegram_reply_message_id=?,code_revision=?,code_snapshot_id=?,code_sync_batch_id=?,
        operator_delivery_status='sending',updated_at=?,error_code=?,decision_reason=?,decision_confidence=?
        WHERE id=? AND status='generating' AND EXISTS (
          SELECT 1 FROM support_threads t
          WHERE t.id=support_replies.thread_id AND t.status='generating' AND t.revision=support_replies.input_revision
        )`).run(
        metadata.telegramReplyMessageId === undefined ? found.telegramReplyMessageId : metadata.telegramReplyMessageId,
        metadata.codeRevision === undefined ? found.codeRevision : metadata.codeRevision,
        metadata.codeSnapshotId === undefined ? found.codeSnapshotId : metadata.codeSnapshotId,
        metadata.codeSyncBatchId === undefined ? found.codeSyncBatchId : metadata.codeSyncBatchId,
        now,
        metadata.errorCode === undefined ? found.errorCode : metadata.errorCode,
        metadata.decisionReason === undefined ? found.decisionReason : metadata.decisionReason,
        metadata.decisionConfidence === undefined ? found.decisionConfidence : metadata.decisionConfidence,
        id,
      )
      if (Number(result.changes) !== 1) return
      claimed = true
      if (metadata.answer !== undefined || metadata.quote !== undefined) {
        const answer = metadata.answer === undefined ? found.answer : this.redactor.assertSafeOutbound(metadata.answer).safeText
        const quote = metadata.quote === undefined || metadata.quote === null
          ? metadata.quote === undefined ? found.quote : null
          : this.redactor.redact(metadata.quote).text
        this.database.prepare("UPDATE support_reply_payloads SET answer=?,quote_text=? WHERE reply_id=?").run(
          answer, quote, id,
        )
      }
      if (metadata.memoryVersionRefs !== undefined) {
        this.database.prepare("DELETE FROM reply_memory_refs WHERE reply_id=?").run(id)
        const insert = this.database.prepare("INSERT OR IGNORE INTO reply_memory_refs(reply_id,memory_version_id) VALUES (?,?)")
        metadata.memoryVersionRefs.forEach((versionId) => insert.run(id, versionId))
      }
    })
    if (!claimed) return null
    const updated = this.getDetail(id)
    this.events.publish({ id, status: updated.status, updatedAt: updated.updatedAt, durationMs: updated.durationMs })
    return updated
  }

  claimUnthreadedSending(id: string, metadata: ReplyTransitionMetadata = {}): ReplyRecord | null {
    const found = this.getDetail(id)
    if (found.status !== "generating" || found.threadId !== null) return null
    const now = new Date().toISOString()
    let claimed = false
    this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE support_replies SET
        status='sending',operator_delivery_status='sending',updated_at=?,error_code=?,decision_reason=?,decision_confidence=?
        WHERE id=? AND status='generating' AND thread_id IS NULL`).run(
        now,
        metadata.errorCode === undefined ? found.errorCode : metadata.errorCode,
        metadata.decisionReason === undefined ? found.decisionReason : metadata.decisionReason,
        metadata.decisionConfidence === undefined ? found.decisionConfidence : metadata.decisionConfidence,
        id,
      )
      if (Number(result.changes) !== 1) return
      claimed = true
      if (metadata.answer !== undefined || metadata.quote !== undefined) {
        const answer = metadata.answer === undefined ? found.answer : this.redactor.assertSafeOutbound(metadata.answer).safeText
        const quote = metadata.quote === undefined || metadata.quote === null
          ? metadata.quote === undefined ? found.quote : null
          : this.redactor.redact(metadata.quote).text
        this.database.prepare("UPDATE support_reply_payloads SET answer=?,quote_text=? WHERE reply_id=?").run(answer, quote, id)
      }
    })
    if (!claimed) return null
    const updated = this.getDetail(id)
    this.events.publish({ id, status: updated.status, updatedAt: updated.updatedAt, durationMs: updated.durationMs })
    return updated
  }

  claimTechnicalAlert(id: string, kind: TechnicalAlertKind): boolean {
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      const result = this.database.prepare(`INSERT OR IGNORE INTO support_reply_alert_deliveries(
        reply_id,alert_kind,status,created_at,updated_at
      ) SELECT r.id,?,'sending',?,? FROM support_replies r
        JOIN support_threads t ON t.id=r.thread_id
        WHERE r.id=? AND r.status IN ('generating','sending','replied','escalated','failed')
          AND (
            (t.status='generating' AND t.revision=r.input_revision)
            OR (?='support_delivery_failure' AND r.status='failed' AND r.decision='escalate'
              AND t.status='escalated' AND t.revision=r.input_revision)
          )`).run(kind, now, now, id, kind)
      return Number(result.changes) === 1
    })
  }

  completeTechnicalAlert(id: string, kind: TechnicalAlertKind, status: TechnicalAlertDeliveryStatus): boolean {
    const result = this.database.prepare(`UPDATE support_reply_alert_deliveries SET status=?,updated_at=?
      WHERE reply_id=? AND alert_kind=? AND status='sending'`).run(status, new Date().toISOString(), id, kind)
    return Number(result.changes) === 1
  }

  prepareTechnicalEscalation(id: string, metadata: ReplyTransitionMetadata): ReplyRecord | null {
    const found = this.getDetail(id)
    const answer = metadata.answer
    const decisionReason = metadata.decisionReason
    if (found.status !== "generating" || !answer?.trim() || !decisionReason?.trim()) return null
    const now = new Date().toISOString()
    let prepared = false
    this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE support_replies SET
        decision='escalate',code_revision=?,updated_at=?,error_code=?,decision_reason=?,decision_confidence=?
        WHERE id=? AND status='generating' AND EXISTS (
          SELECT 1 FROM support_threads t WHERE t.id=support_replies.thread_id
            AND t.status='generating' AND t.revision=support_replies.input_revision
        )`).run(
        metadata.codeRevision === undefined ? found.codeRevision : metadata.codeRevision,
        now,
        metadata.errorCode === undefined ? found.errorCode : metadata.errorCode,
        decisionReason,
        metadata.decisionConfidence === undefined ? found.decisionConfidence : metadata.decisionConfidence,
        id,
      )
      if (Number(result.changes) !== 1) return
      prepared = true
      this.database.prepare("UPDATE support_reply_payloads SET answer=?,quote_text=NULL WHERE reply_id=?").run(
        this.redactor.assertSafeOutbound(answer).safeText,
        id,
      )
      if (metadata.memoryVersionRefs !== undefined) {
        this.database.prepare("DELETE FROM reply_memory_refs WHERE reply_id=?").run(id)
        const insert = this.database.prepare("INSERT OR IGNORE INTO reply_memory_refs(reply_id,memory_version_id) VALUES (?,?)")
        metadata.memoryVersionRefs.forEach((versionId) => insert.run(id, versionId))
      }
    })
    return prepared ? this.getDetail(id) : null
  }

  findPreparedTechnicalEscalation(threadId: string, inputRevision: number): ReplyRecord | null {
    const row = this.database.prepare(`SELECT r.id FROM support_replies r
      JOIN support_reply_payloads payload ON payload.reply_id=r.id
      WHERE r.thread_id=? AND r.input_revision=? AND r.status='generating' AND r.decision='escalate'
        AND length(trim(payload.answer))>0
        AND (
          r.decision_reason LIKE '%技术告警：发送中'
          OR EXISTS(SELECT 1 FROM support_reply_alert_deliveries delivery
            WHERE delivery.reply_id=r.id AND delivery.alert_kind='escalation'
              AND delivery.status IN ('sent','not_configured','failed','uncertain'))
        )
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`).get(threadId, inputRevision) as { id?: unknown } | undefined
    return typeof row?.id === "string" ? this.getDetail(row.id) : null
  }

  findPendingEscalationDeliveryFailure(): ReplyRecord | null {
    const row = this.database.prepare(`SELECT r.id FROM support_replies r
      JOIN support_threads thread ON thread.id=r.thread_id
      WHERE r.status='failed' AND r.decision='escalate' AND thread.status='escalated'
        AND r.operator_delivery_status IN ('failed','uncertain')
        AND EXISTS(SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=r.id AND delivery.alert_kind='escalation')
        AND NOT EXISTS(SELECT 1 FROM support_reply_alert_deliveries delivery
          WHERE delivery.reply_id=r.id AND delivery.alert_kind='support_delivery_failure')
      ORDER BY r.updated_at,r.id LIMIT 1`).get() as { id?: unknown } | undefined
    return typeof row?.id === "string" ? this.getDetail(row.id) : null
  }

  heartbeat(id: string): void {
    const found = this.getDetail(id)
    if (found.status !== "generating") return
    const now = new Date().toISOString()
    this.database.prepare("UPDATE support_replies SET heartbeat_at=?,updated_at=? WHERE id=?").run(now, now, id)
    this.events.publish({ id, status: found.status, updatedAt: now, durationMs: found.durationMs })
  }

  updateInvestigationProgress(id: string, input: {
    codeRevision: string
    codeSnapshotId?: string | null
    codeSyncBatchId?: string | null
    summary: string
  }): ReplyRecord {
    const found = this.getDetail(id)
    if (found.status !== "generating") return found
    const now = new Date().toISOString()
    const summary = this.redactor.redact(input.summary).text.slice(0, 1000)
    this.database.prepare(`UPDATE support_replies SET
      code_revision=?,code_snapshot_id=?,code_sync_batch_id=?,decision_reason=?,heartbeat_at=?,updated_at=?
      WHERE id=? AND status='generating'`).run(
      input.codeRevision.slice(0, 160), input.codeSnapshotId ?? found.codeSnapshotId,
      input.codeSyncBatchId ?? found.codeSyncBatchId, summary, now, now, id,
    )
    const updated = this.getDetail(id)
    this.events.publish({ id, status: updated.status, updatedAt: updated.updatedAt, durationMs: updated.durationMs })
    return updated
  }

  listWorkQueue(limit = 100): { items: ReplyListItem[] } {
    const bounded = Math.min(Math.max(limit, 1), 200)
    const placeholders = workStatuses.map(() => "?").join(",")
    const records = this.database.readReplies(`WHERE r.status IN (${placeholders})
      ORDER BY CASE r.status WHEN 'generating' THEN 1 WHEN 'sending' THEN 2 WHEN 'queued' THEN 3
      WHEN 'pending' THEN 4 ELSE 5 END, r.updated_at DESC, r.id DESC LIMIT ${bounded}`, workStatuses)
    return { items: records.map(listItem) }
  }

  listRecent(filters: {
    projectId?: string
    serviceId?: string
    groupId?: string
    status?: ReplyStatus
    role?: ReplyRecord["senderRole"]
    decision?: ReplyRecord["decision"]
    senderQ?: string
    from?: string
    to?: string
    q?: string
    cursor?: string
    limit?: number
  } = {}): ReplyCursorPage {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (filters.projectId) { clauses.push("r.project_id=?"); parameters.push(filters.projectId) }
    if (filters.serviceId) { clauses.push("r.service_id=?"); parameters.push(filters.serviceId) }
    if (filters.groupId) { clauses.push("r.group_id=?"); parameters.push(filters.groupId) }
    if (filters.status) { clauses.push("r.status=?"); parameters.push(filters.status) }
    if (filters.role) { clauses.push("r.sender_role=?"); parameters.push(filters.role) }
    if (filters.decision) { clauses.push("r.decision=?"); parameters.push(filters.decision) }
    if (filters.senderQ?.trim()) {
      clauses.push("(r.sender_user_id LIKE ? OR r.sender_username LIKE ? OR r.sender_display_name LIKE ?)")
      parameters.push(...Array(3).fill(`%${filters.senderQ.trim()}%`))
    }
    if (filters.from) { clauses.push("r.created_at>=?"); parameters.push(filters.from) }
    if (filters.to) { clauses.push("r.created_at<=?"); parameters.push(filters.to) }
    if (filters.q?.trim()) {
      const search = filters.q.trim()
      if ([...search].length >= 3) {
        clauses.push("r.id IN (SELECT reply_id FROM support_reply_fts WHERE support_reply_fts MATCH ?)")
        parameters.push(`"${search.replaceAll('"', '""')}"`)
      } else {
        const recentBoundary = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
        const candidateClauses = ["rr.created_at>=?"]
        const candidateParameters: Array<string | number> = [recentBoundary]
        if (filters.projectId) { candidateClauses.push("rr.project_id=?"); candidateParameters.push(filters.projectId) }
        if (filters.serviceId) { candidateClauses.push("rr.service_id=?"); candidateParameters.push(filters.serviceId) }
        if (filters.groupId) { candidateClauses.push("rr.group_id=?"); candidateParameters.push(filters.groupId) }
        if (filters.status) { candidateClauses.push("rr.status=?"); candidateParameters.push(filters.status) }
        clauses.push(`r.id IN (
          SELECT recent.id FROM (
            SELECT rr.id,rr.service FROM support_replies rr
            WHERE ${candidateClauses.join(" AND ")}
            ORDER BY rr.created_at DESC,rr.id DESC LIMIT 10000
          ) recent JOIN support_reply_payloads search_payload ON search_payload.reply_id=recent.id
          WHERE recent.service LIKE ? OR search_payload.question LIKE ? OR search_payload.answer LIKE ?
        )`)
        parameters.push(...candidateParameters, ...Array(3).fill(`%${search}%`))
      }
    }
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor)
      clauses.push("(r.created_at<? OR (r.created_at=? AND r.id<?))")
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
    const records = this.database.readReplies(`${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`, parameters)
    const hasMore = records.length > limit
    const items = records.slice(0, limit)
    return { items: items.map(listItem), nextCursor: hasMore && items.length ? encodeCursor(items.at(-1)!) : null }
  }

  getDetail(id: string): ReplyRecord {
    const record = this.database.readReplies("WHERE r.id=?", [id])[0]
    if (!record) throw new Error("回复记录不存在")
    return record
  }
}
