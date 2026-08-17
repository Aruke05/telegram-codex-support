import type { RuntimeDatabase } from "../runtime/database.js"
import {
  learningAssociationReasonSchema,
  learningObservationProcessingStatusSchema,
  learningSourceObservationSchema,
  learningTakeoverStatusSchema,
  referenceLearningTerminalResultSchema,
  supportThreadStatusSchema,
  type LearningSourceObservation,
  type ReferenceLearningTerminalResult,
  type ReplyRecord,
  type SupportThreadStatus,
} from "../runtime/types.js"
import type { SupportThreadStore } from "./thread-store.js"
import type { SupportThreadLifecycleService } from "./thread-lifecycle-service.js"

type SqlRow = Record<string, unknown>

const learningObservationAuditSchema = learningSourceObservationSchema.pick({
  id: true, sourceTelegramUserId: true, sourceRole: true, threadId: true, createdAt: true,
}).extend({
  associationReason: learningAssociationReasonSchema,
  takeoverStatus: learningTakeoverStatusSchema,
  processingStatus: learningObservationProcessingStatusSchema,
  terminalResult: referenceLearningTerminalResultSchema.nullable(),
}).strict()

export type LearningObservationAudit = Pick<LearningSourceObservation,
  "id" | "sourceTelegramUserId" | "sourceRole" | "threadId" | "associationReason" |
  "takeoverStatus" | "processingStatus" | "createdAt"> & {
  terminalResult: ReferenceLearningTerminalResult | null
}

export type SupportThreadListItem = {
  id: string
  groupId: string
  groupName: string
  projectId: string
  projectName: string
  serviceId: string
  service: string
  serviceName: string
  status: SupportThreadStatus
  revision: number
  settleAt: string
  latestMessageAt: string
  summary: string
  senderUserId: string | null
  senderUsername: string | null
  senderDisplayName: string | null
  latestReplyStatus: ReplyRecord["status"] | null
  hasSuperseded: boolean
  createdAt: string
  updatedAt: string
}

export type SupportThreadCursorPage = {
  items: SupportThreadListItem[]
  nextCursor: string | null
}

export type SupportThreadFilters = {
  projectId?: string
  serviceId?: string
  groupId?: string
  status?: SupportThreadStatus
  hasSuperseded?: boolean
  excludeActive?: boolean
  senderQ?: string
  from?: string
  to?: string
  q?: string
  cursor?: string
  limit?: number
}

const baseSelect = `SELECT t.*,g.name AS group_name,p.name AS project_name,
  s.service_key AS service_key,s.name AS service_name,
  origin.sender_user_id AS sender_user_id,origin.sender_username AS sender_username,
  origin.sender_display_name AS sender_display_name,
  (SELECT r.status FROM support_replies r WHERE r.thread_id=t.id ORDER BY r.input_revision DESC,r.created_at DESC LIMIT 1) AS latest_reply_status,
  EXISTS(SELECT 1 FROM support_replies old_result WHERE old_result.thread_id=t.id AND old_result.status='superseded') AS has_superseded
  FROM support_threads t
  JOIN telegram_groups g ON g.id=t.group_id
  JOIN projects p ON p.id=t.project_id
  JOIN project_services s ON s.id=t.service_id
  LEFT JOIN support_thread_messages origin_link ON origin_link.thread_id=t.id AND origin_link.position=0
  LEFT JOIN support_message_events origin ON origin.id=origin_link.message_event_id`

function item(row: SqlRow): SupportThreadListItem {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    groupName: String(row.group_name),
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    serviceId: String(row.service_id),
    service: String(row.service_key),
    serviceName: String(row.service_name),
    status: supportThreadStatusSchema.parse(row.status),
    revision: Number(row.revision),
    settleAt: String(row.settle_at),
    latestMessageAt: String(row.latest_message_at),
    summary: String(row.summary),
    senderUserId: row.sender_user_id == null ? null : String(row.sender_user_id),
    senderUsername: row.sender_username == null ? null : String(row.sender_username),
    senderDisplayName: row.sender_display_name == null ? null : String(row.sender_display_name),
    latestReplyStatus: row.latest_reply_status == null ? null : row.latest_reply_status as ReplyRecord["status"],
    hasSuperseded: Boolean(row.has_superseded),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function learningObservationAudit(row: SqlRow): LearningObservationAudit {
  return learningObservationAuditSchema.parse({
    id: row.id,
    sourceTelegramUserId: row.source_telegram_user_id,
    sourceRole: row.source_role,
    threadId: row.thread_id,
    associationReason: row.association_reason,
    takeoverStatus: row.takeover_status,
    processingStatus: row.processing_status,
    createdAt: row.created_at,
    terminalResult: row.terminal_classification == null ? null : {
      classification: row.terminal_classification,
      action: row.terminal_action,
      risk: row.terminal_risk,
      outcome: row.terminal_outcome,
      reasonCode: row.terminal_reason_code,
      memoryVersionId: row.terminal_memory_version_id,
      operatorStyleVersionId: row.terminal_operator_style_version_id,
      createdAt: row.terminal_created_at,
    },
  })
}

function encodeCursor(value: SupportThreadListItem): string {
  return Buffer.from(JSON.stringify({ latestMessageAt: value.latestMessageAt, id: value.id }), "utf8").toString("base64url")
}

function decodeCursor(value: string): { latestMessageAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>
    if (typeof parsed.latestMessageAt !== "string" || typeof parsed.id !== "string") throw new Error()
    return { latestMessageAt: parsed.latestMessageAt, id: parsed.id }
  } catch {
    throw new Error("客服线程游标无效")
  }
}

export class SupportThreadQueryService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly store: SupportThreadStore,
    private readonly lifecycle: SupportThreadLifecycleService,
  ) {}

  closeManually(id: string) {
    this.lifecycle.closeManually(id)
    return this.getDetail(id)
  }

  listWork(limit = 100): { items: SupportThreadListItem[] } {
    const bounded = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 100
    const rows = this.database.prepare(`${baseSelect}
      WHERE t.status IN ('collecting','generating')
      ORDER BY CASE t.status WHEN 'generating' THEN 0 ELSE 1 END,
        t.settle_at,t.latest_message_at DESC,t.id DESC
      LIMIT ${bounded}`).all() as SqlRow[]
    return { items: rows.map(item) }
  }

  listRecent(filters: SupportThreadFilters = {}): SupportThreadCursorPage {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (filters.projectId) { clauses.push("t.project_id=?"); parameters.push(filters.projectId) }
    if (filters.serviceId) { clauses.push("t.service_id=?"); parameters.push(filters.serviceId) }
    if (filters.groupId) { clauses.push("t.group_id=?"); parameters.push(filters.groupId) }
    if (filters.status) { clauses.push("t.status=?"); parameters.push(supportThreadStatusSchema.parse(filters.status)) }
    if (filters.excludeActive) clauses.push("t.status NOT IN ('collecting','generating')")
    if (filters.hasSuperseded) {
      clauses.push("EXISTS (SELECT 1 FROM support_replies rs WHERE rs.thread_id=t.id AND rs.status='superseded')")
    }
    if (filters.senderQ?.trim()) {
      clauses.push(`EXISTS (SELECT 1 FROM support_thread_messages sm
        JOIN support_message_events se ON se.id=sm.message_event_id WHERE sm.thread_id=t.id
        AND (se.sender_user_id LIKE ? OR se.sender_username LIKE ? OR se.sender_display_name LIKE ?))`)
      parameters.push(...Array(3).fill(`%${filters.senderQ.trim()}%`))
    }
    if (filters.from) { clauses.push("t.latest_message_at>=?"); parameters.push(filters.from) }
    if (filters.to) { clauses.push("t.latest_message_at<=?"); parameters.push(filters.to) }
    if (filters.q?.trim()) {
      clauses.push(`(t.summary LIKE ? OR EXISTS (SELECT 1 FROM support_thread_messages qm
        JOIN support_message_events qe ON qe.id=qm.message_event_id WHERE qm.thread_id=t.id
        AND (qe.safe_text LIKE ? OR qe.attachment_summary LIKE ?)))`)
      parameters.push(...Array(3).fill(`%${filters.q.trim()}%`))
    }
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor)
      clauses.push("(t.latest_message_at<? OR (t.latest_message_at=? AND t.id<?))")
      parameters.push(cursor.latestMessageAt, cursor.latestMessageAt, cursor.id)
    }
    const requestedLimit = filters.limit ?? 50
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50
    const rows = this.database.prepare(`${baseSelect}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY t.latest_message_at DESC,t.id DESC LIMIT ${limit + 1}`).all(...parameters) as SqlRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(item)
    return { items, nextCursor: hasMore && items.length > 0 ? encodeCursor(items.at(-1)!) : null }
  }

  getDetail(id: string) {
    const detail = this.store.getThreadDetail(id)
    const group = this.database.readGroups().find((value) => value.id === detail.thread.groupId)
    const project = this.database.readProjects("WHERE id=?", [detail.thread.projectId])[0]
    const service = this.database.readProjectServices("WHERE id=?", [detail.thread.serviceId])[0]
    const replies = this.database.readReplies("WHERE r.thread_id=? ORDER BY r.input_revision,r.created_at,r.id", [id])
    const learningObservations = (this.database.prepare(`SELECT observation.id,observation.source_telegram_user_id,
      observation.source_role,observation.thread_id,observation.association_reason,observation.takeover_status,
      observation.processing_status,observation.created_at,
      result.classification AS terminal_classification,result.action AS terminal_action,result.risk AS terminal_risk,
      result.outcome AS terminal_outcome,result.reason_code AS terminal_reason_code,
      result.memory_version_id AS terminal_memory_version_id,
      result.operator_style_version_id AS terminal_operator_style_version_id,result.created_at AS terminal_created_at
      FROM learning_source_observations observation
      LEFT JOIN reference_learning_results result ON result.id=(
        SELECT latest.id FROM reference_learning_results latest WHERE latest.observation_id=observation.id
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
      )
      WHERE observation.thread_id=? ORDER BY observation.created_at,observation.id`).all(id) as SqlRow[])
      .map(learningObservationAudit)
    return {
      ...detail,
      context: {
        groupName: group?.name ?? "",
        projectName: project?.name ?? "",
        service: service?.key ?? "",
        serviceName: service?.name ?? "",
        knowledgeScope: group?.knowledgeScope ?? "global",
        region: service?.region ?? "",
        branch: service?.branch ?? "",
      },
      replies,
      learningObservations,
    }
  }
}
