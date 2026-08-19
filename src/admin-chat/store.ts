import { randomUUID } from "node:crypto"

import { z } from "zod"

import type { RuntimeDatabase } from "../runtime/database.js"
import {
  adminChatAttachmentSchema,
  adminChatCorrectionSchema,
  adminChatSessionDetailSchema,
  adminChatSessionSchema,
  adminChatTurnStatusSchema,
  adminChatTurnSchema,
  type AdminChatAttachment,
  type AdminChatCorrection,
  type AdminChatSession,
  type AdminChatSessionDetail,
  type AdminChatTurn,
} from "../runtime/types.js"
import type { SupportAttachmentContext } from "../support/agent.js"

type SqlRow = Record<string, unknown>

const idSchema = z.string().uuid()
const createTurnInputSchema = z.object({
  sessionId: idSchema,
  question: z.string().max(12000),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(240),
    kind: z.enum(["text", "image", "video", "archive", "pdf", "other"]),
    mimeType: z.string().max(160),
    size: z.number().int().nonnegative(),
    extractedText: z.string().max(30000),
    localPath: z.string().nullable(),
  }).strict()).max(8),
}).strict()
const createSessionWithTurnInputSchema = z.object({
  serviceId: idSchema,
  question: z.string().max(12000),
  attachments: createTurnInputSchema.shape.attachments,
}).strict()
const correctionInputSchema = z.object({
  turnId: idSchema,
  correctedAnswer: z.string().trim().min(1).max(12000),
  reason: z.string().trim().min(1).max(1000),
  correctedBy: z.string().trim().min(1).max(160),
}).strict()
const completeTurnInputSchema = z.object({
  turnId: idSchema,
  result: z.object({
    answer: z.string().max(12000),
    decision: z.enum(["reply", "ignore", "escalate"]),
    investigation: z.record(z.string(), z.json()),
    decisionReason: z.string().max(2000).nullable().default(null),
    decisionConfidence: z.number().min(0).max(1).nullable().default(null),
    codeRevision: z.string().max(160).nullable().default(null),
    codeSnapshotId: idSchema.nullable().default(null),
    codeSyncBatchId: idSchema.nullable().default(null),
    memoryVersionRefs: z.array(idSchema).default([]),
  }).strict(),
}).strict()
const failTurnInputSchema = z.object({
  turnId: idSchema,
  errorCode: z.string().trim().min(1).max(120),
  decisionReason: z.string().trim().min(1).max(2000).nullable().default(null),
}).strict()
const progressInputSchema = z.object({
  turnId: idSchema,
  progress: z.object({
    investigation: z.record(z.string(), z.json()),
    codeRevision: z.string().max(160),
    codeSnapshotId: idSchema,
    codeSyncBatchId: idSchema,
  }).strict(),
}).strict()
const timestampSchema = z.string().datetime()

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value)) as unknown
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("后台对话数据格式错误")
  return parsed as Record<string, unknown>
}

function jsonStringArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("后台对话数据格式错误")
  return parsed
}

function sessionFromRow(row: SqlRow): AdminChatSession {
  return adminChatSessionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    serviceId: row.service_id,
    createdByUserId: row.created_by_user_id ?? null,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function turnFromRow(row: SqlRow): AdminChatTurn {
  return adminChatTurnSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    position: Number(row.position),
    question: row.question,
    answer: row.answer,
    decision: row.decision,
    status: row.status,
    investigation: jsonObject(row.investigation_json),
    decisionReason: row.decision_reason,
    decisionConfidence: row.decision_confidence === null ? null : Number(row.decision_confidence),
    codeRevision: row.code_revision,
    codeSnapshotId: row.code_snapshot_id,
    codeSyncBatchId: row.code_sync_batch_id,
    memoryVersionRefs: jsonStringArray(row.memory_version_refs_json),
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    generationStartedAt: row.generation_started_at,
    completedAt: row.completed_at,
    attachments: [],
    corrections: [],
  })
}

function attachmentFromRow(row: SqlRow): AdminChatAttachment {
  return adminChatAttachmentSchema.parse({
    id: row.id,
    turnId: row.turn_id,
    name: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.file_size),
    kind: row.kind,
    storagePath: row.storage_path,
    extractedText: row.extracted_text,
    createdAt: row.created_at,
  })
}

function correctionFromRow(row: SqlRow): AdminChatCorrection {
  return adminChatCorrectionSchema.parse({
    id: row.id,
    turnId: row.turn_id,
    correctedAnswer: row.corrected_answer,
    reason: row.reason,
    correctedBy: row.corrected_by,
    createdAt: row.created_at,
  })
}

function sessionTitle(question: string, attachments: SupportAttachmentContext[]): string {
  const source = question.trim() || attachments.map((attachment) => attachment.name).join(" ") || "新对话"
  return Array.from(source).slice(0, 36).join("")
}

export class AdminChatStore {
  constructor(private readonly database: RuntimeDatabase) {}

  createSession(serviceId: unknown, createdByUserId: string | null = null): AdminChatSession {
    const parsedServiceId = idSchema.parse(serviceId)
    const parsedUserId = createdByUserId === null ? null : idSchema.parse(createdByUserId)
    const service = this.database.prepare(`SELECT service.id,service.project_id FROM project_services service
      JOIN projects project ON project.id=service.project_id
      WHERE service.id=? AND service.enabled=1 AND project.enabled=1`).get(parsedServiceId) as SqlRow | undefined
    if (!service) throw new Error("服务不存在或未启用")
    const now = new Date().toISOString()
    const session: AdminChatSession = {
      id: randomUUID(),
      projectId: String(service.project_id),
      serviceId: parsedServiceId,
      createdByUserId: parsedUserId,
      title: "新对话",
      createdAt: now,
      updatedAt: now,
    }
    this.database.prepare(`INSERT INTO admin_chat_sessions(id,project_id,service_id,created_by_user_id,title,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(
      session.id, session.projectId, session.serviceId, session.createdByUserId, session.title, session.createdAt, session.updatedAt,
    )
    return session
  }

  createSessionWithTurn(
    serviceId: unknown,
    question: unknown,
    attachments: SupportAttachmentContext[] = [],
    createdByUserId: string | null = null,
  ): { session: AdminChatSession; turn: AdminChatTurn } {
    const input = createSessionWithTurnInputSchema.parse({ serviceId, question, attachments })
    this.assertMessageContent(input.question, input.attachments)
    return this.database.transaction(() => {
      const session = this.createSession(input.serviceId, createdByUserId)
      const turn = this.createTurnForSession(session, input.question.trim(), input.attachments)
      return { session: this.readSession(session.id), turn }
    })
  }

  listSessions(serviceId?: unknown, viewer?: { userId: string; isSuperAdmin: boolean }): Array<AdminChatSession & {
    latestTurnStatus: AdminChatTurn["status"] | null
    latestTurnUpdatedAt: string | null
  }> {
    const parsedServiceId = serviceId === undefined ? undefined : idSchema.parse(serviceId)
    const conditions: string[] = []
    const parameters: string[] = []
    if (parsedServiceId) { conditions.push("session.service_id=?"); parameters.push(parsedServiceId) }
    if (viewer && !viewer.isSuperAdmin) { conditions.push("session.created_by_user_id=?"); parameters.push(viewer.userId) }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    const rows = this.database.prepare(`SELECT session.*,
        (SELECT turn.status FROM admin_chat_turns turn WHERE turn.session_id=session.id
          ORDER BY turn.position DESC,turn.id DESC LIMIT 1) AS latest_turn_status,
        (SELECT turn.updated_at FROM admin_chat_turns turn WHERE turn.session_id=session.id
          ORDER BY turn.position DESC,turn.id DESC LIMIT 1) AS latest_turn_updated_at
      FROM admin_chat_sessions session ${where}
      ORDER BY session.updated_at DESC,session.id DESC LIMIT 200`).all(...parameters) as SqlRow[]
    return rows.map((row) => ({
      ...sessionFromRow(row),
      latestTurnStatus: row.latest_turn_status === null ? null : adminChatTurnStatusSchema.parse(row.latest_turn_status),
      latestTurnUpdatedAt: row.latest_turn_updated_at === null ? null : timestampSchema.parse(row.latest_turn_updated_at),
    }))
  }

  getSession(id: unknown, viewer?: { userId: string; isSuperAdmin: boolean }): AdminChatSessionDetail {
    const sessionId = idSchema.parse(id)
    const session = this.readSession(sessionId)
    this.assertViewer(session, viewer)
    const turns = (this.database.prepare(`SELECT * FROM admin_chat_turns WHERE session_id=?
      ORDER BY position,id`).all(sessionId) as SqlRow[]).map((row) => this.hydrateTurn(turnFromRow(row)))
    return adminChatSessionDetailSchema.parse({ session, turns })
  }

  createTurn(sessionId: unknown, question: unknown, attachments: SupportAttachmentContext[] = []): AdminChatTurn {
    return this.createTurnSupersedingActive(sessionId, question, attachments).turn
  }

  createTurnSupersedingActive(
    sessionId: unknown,
    question: unknown,
    attachments: SupportAttachmentContext[] = [],
    viewer?: { userId: string; isSuperAdmin: boolean },
  ): { turn: AdminChatTurn; supersededTurnIds: string[] } {
    const input = createTurnInputSchema.parse({ sessionId, question, attachments })
    this.assertMessageContent(input.question, input.attachments)
    return this.database.transaction(() => {
      const session = this.readEnabledSession(input.sessionId)
      this.assertViewer(session, viewer)
      const active = this.database.prepare(`SELECT id FROM admin_chat_turns
        WHERE session_id=? AND status IN ('pending','generating') ORDER BY position,id`).all(session.id) as SqlRow[]
      const supersededTurnIds = active.map((row) => String(row.id))
      if (supersededTurnIds.length > 0) {
        const now = new Date().toISOString()
        this.database.prepare(`UPDATE admin_chat_turns SET status='cancelled',error_code='admin_chat_superseded',
          decision_reason='已有新消息 本轮结果已作废并按最新内容重新排查',updated_at=?,completed_at=?
          WHERE session_id=? AND status IN ('pending','generating')`).run(now, now, session.id)
      }
      const turn = this.createTurnForSession(session, input.question.trim(), input.attachments)
      return { turn, supersededTurnIds }
    })
  }

  claimNext(now = new Date().toISOString()): AdminChatTurn | null {
    const claimedAt = timestampSchema.parse(now)
    return this.database.transaction(() => {
      const candidate = this.database.prepare(`SELECT pending.id FROM admin_chat_turns pending
        WHERE pending.status='pending'
        AND NOT EXISTS (
          SELECT 1 FROM admin_chat_turns active
          WHERE active.session_id=pending.session_id AND active.status='generating'
        )
        AND NOT EXISTS (
          SELECT 1 FROM admin_chat_turns earlier
          WHERE earlier.session_id=pending.session_id AND earlier.position<pending.position
            AND earlier.status IN ('pending','generating')
        )
        ORDER BY pending.created_at,pending.id LIMIT 1`).get() as SqlRow | undefined
      if (!candidate) return null
      const result = this.database.prepare(`UPDATE admin_chat_turns SET status='generating',generation_started_at=?,updated_at=?
        WHERE id=? AND status='pending'`).run(claimedAt, claimedAt, String(candidate.id))
      if (Number(result.changes) !== 1) return null
      this.touchSessionForTurn(String(candidate.id), claimedAt)
      return this.readTurn(String(candidate.id))
    })
  }

  completeTurn(turnId: unknown, result: unknown): AdminChatTurn {
    const input = completeTurnInputSchema.parse({ turnId, result })
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      const updated = this.database.prepare(`UPDATE admin_chat_turns SET answer=?,decision=?,status='completed',investigation_json=?,
        decision_reason=?,decision_confidence=?,code_revision=?,code_snapshot_id=?,code_sync_batch_id=?,memory_version_refs_json=?,
        error_code=NULL,updated_at=?,completed_at=? WHERE id=? AND status='generating'`).run(
        input.result.answer, input.result.decision, JSON.stringify(input.result.investigation), input.result.decisionReason,
        input.result.decisionConfidence, input.result.codeRevision, input.result.codeSnapshotId, input.result.codeSyncBatchId,
        JSON.stringify(input.result.memoryVersionRefs), now, now, input.turnId,
      )
      if (Number(updated.changes) !== 1) throw new Error("后台对话轮次状态无效")
      this.touchSessionForTurn(input.turnId, now)
      return this.readTurn(input.turnId)
    })
  }

  updateInvestigationProgress(turnId: unknown, progress: unknown): AdminChatTurn {
    const input = progressInputSchema.parse({ turnId, progress })
    const found = this.readTurn(input.turnId)
    if (found.status !== "generating") return found
    const now = new Date().toISOString()
    this.database.prepare(`UPDATE admin_chat_turns SET investigation_json=?,code_revision=?,code_snapshot_id=?,
      code_sync_batch_id=?,updated_at=? WHERE id=? AND status='generating'`).run(
      JSON.stringify(input.progress.investigation), input.progress.codeRevision, input.progress.codeSnapshotId,
      input.progress.codeSyncBatchId, now, input.turnId,
    )
    this.touchSessionForTurn(input.turnId, now)
    return this.readTurn(input.turnId)
  }

  failTurn(turnId: unknown, errorCode: unknown, decisionReason: unknown = null): AdminChatTurn {
    const input = failTurnInputSchema.parse({ turnId, errorCode, decisionReason })
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      const updated = this.database.prepare(`UPDATE admin_chat_turns SET status='failed',error_code=?,decision_reason=?,
        updated_at=?,completed_at=? WHERE id=? AND status='generating'`).run(
        input.errorCode, input.decisionReason, now, now, input.turnId,
      )
      if (Number(updated.changes) !== 1) throw new Error("后台对话轮次状态无效")
      this.touchSessionForTurn(input.turnId, now)
      return this.readTurn(input.turnId)
    })
  }

  cancelTurn(turnId: unknown, viewer?: { userId: string; isSuperAdmin: boolean }): AdminChatTurn {
    const parsedTurnId = idSchema.parse(turnId)
    return this.database.transaction(() => {
      const found = this.readTurn(parsedTurnId)
      this.assertViewer(this.readSession(found.sessionId), viewer)
      if (found.status !== "pending" && found.status !== "generating") return found
      const now = new Date().toISOString()
      const updated = this.database.prepare(`UPDATE admin_chat_turns SET status='cancelled',
        error_code='admin_chat_cancelled',decision_reason='本轮已由用户终止',updated_at=?,completed_at=?
        WHERE id=? AND status IN ('pending','generating')`).run(now, now, parsedTurnId)
      if (Number(updated.changes) === 1) this.touchSessionForTurn(parsedTurnId, now)
      return this.readTurn(parsedTurnId)
    })
  }

  retryTurn(turnId: unknown): AdminChatTurn {
    return this.retryTurnSupersedingActive(turnId).turn
  }

  retryTurnSupersedingActive(turnId: unknown, viewer?: { userId: string; isSuperAdmin: boolean }): { turn: AdminChatTurn; supersededTurnIds: string[] } {
    const parsedTurnId = idSchema.parse(turnId)
    const failed = this.readTurn(parsedTurnId)
    this.assertViewer(this.readSession(failed.sessionId), viewer)
    if (failed.status !== "failed" && failed.status !== "cancelled") {
      throw new Error("只有失败或已终止的后台对话轮次可以重试")
    }
    return this.createTurnSupersedingActive(
      failed.sessionId,
      failed.question,
      failed.attachments.map((attachment) => ({
        name: attachment.name,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        size: attachment.size,
        extractedText: attachment.extractedText,
        localPath: attachment.storagePath || null,
      })),
      viewer,
    )
  }

  correctTurn(turnId: unknown, correctedAnswer: unknown, reason: unknown, correctedBy: unknown): AdminChatTurn {
    const input = correctionInputSchema.parse({ turnId, correctedAnswer, reason, correctedBy })
    return this.database.transaction(() => {
      const turn = this.readTurn(input.turnId)
      if (turn.status !== "completed") throw new Error("只有已完成的回答可以纠正")
      const now = new Date().toISOString()
      this.database.prepare(`INSERT INTO admin_chat_corrections(
        id,turn_id,corrected_answer,reason,corrected_by,created_at
      ) VALUES(?,?,?,?,?,?)`).run(
        randomUUID(), input.turnId, input.correctedAnswer, input.reason, input.correctedBy, now,
      )
      this.touchSessionForTurn(input.turnId, now)
      return this.readTurn(input.turnId)
    })
  }

  getAttachment(id: unknown, viewer?: { userId: string; isSuperAdmin: boolean }): AdminChatAttachment {
    const attachmentId = idSchema.parse(id)
    const row = this.database.prepare("SELECT * FROM admin_chat_attachments WHERE id=?").get(attachmentId) as SqlRow | undefined
    if (!row) throw new Error("后台对话附件不存在")
    const turn = this.readTurn(String(row.turn_id))
    this.assertViewer(this.readSession(turn.sessionId), viewer)
    return attachmentFromRow(row)
  }

  getTurn(id: unknown, viewer?: { userId: string; isSuperAdmin: boolean }): AdminChatTurn {
    const turn = this.readTurn(idSchema.parse(id))
    this.assertViewer(this.readSession(turn.sessionId), viewer)
    return turn
  }

  recoverInterrupted(now = new Date().toISOString()): number {
    const recoveredAt = timestampSchema.parse(now)
    return this.database.transaction(() => {
      this.database.prepare(`UPDATE admin_chat_sessions SET updated_at=? WHERE id IN (
        SELECT DISTINCT session_id FROM admin_chat_turns WHERE status='generating'
      )`).run(recoveredAt)
      const result = this.database.prepare(`UPDATE admin_chat_turns SET status='pending',generation_started_at=NULL,updated_at=?
        WHERE status='generating'`).run(recoveredAt)
      return Number(result.changes)
    })
  }

  private createTurnForSession(
    session: AdminChatSession,
    question: string,
    attachments: SupportAttachmentContext[] = [],
  ): AdminChatTurn {
    const now = new Date().toISOString()
    const position = Number((this.database.prepare(`SELECT COALESCE(MAX(position),0)+1 AS position
      FROM admin_chat_turns WHERE session_id=?`).get(session.id) as SqlRow).position)
    const turn: AdminChatTurn = {
      id: randomUUID(),
      sessionId: session.id,
      position,
      question,
      answer: "",
      decision: null,
      status: "pending",
      investigation: {},
      decisionReason: null,
      decisionConfidence: null,
      codeRevision: null,
      codeSnapshotId: null,
      codeSyncBatchId: null,
      memoryVersionRefs: [],
      errorCode: null,
      createdAt: now,
      updatedAt: now,
      generationStartedAt: null,
      completedAt: null,
      attachments: [],
      corrections: [],
    }
    this.database.prepare(`INSERT INTO admin_chat_turns(
        id,session_id,position,question,answer,decision,status,investigation_json,decision_reason,decision_confidence,
        code_revision,code_snapshot_id,code_sync_batch_id,memory_version_refs_json,error_code,created_at,updated_at,
        generation_started_at,completed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        turn.id, turn.sessionId, turn.position, turn.question, turn.answer, turn.decision, turn.status,
        JSON.stringify(turn.investigation), turn.decisionReason, turn.decisionConfidence, turn.codeRevision,
        turn.codeSnapshotId, turn.codeSyncBatchId, JSON.stringify(turn.memoryVersionRefs), turn.errorCode,
        turn.createdAt, turn.updatedAt, turn.generationStartedAt, turn.completedAt,
      )
    const insertAttachment = this.database.prepare(`INSERT INTO admin_chat_attachments(
      id,turn_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`)
    attachments.forEach((attachment) => insertAttachment.run(
      randomUUID(), turn.id, attachment.name, attachment.mimeType, attachment.size, attachment.kind,
      attachment.localPath ?? "", attachment.extractedText, now,
    ))
    if (position === 1) {
      const title = sessionTitle(question, attachments)
      this.database.prepare("UPDATE admin_chat_sessions SET title=?,updated_at=? WHERE id=?").run(title, now, session.id)
    } else {
      this.database.prepare("UPDATE admin_chat_sessions SET updated_at=? WHERE id=?").run(now, session.id)
    }
    return this.readTurn(turn.id)
  }

  private readSession(id: string): AdminChatSession {
    const row = this.database.prepare("SELECT * FROM admin_chat_sessions WHERE id=?").get(id) as SqlRow | undefined
    if (!row) throw new Error("后台对话会话不存在")
    return sessionFromRow(row)
  }

  private readEnabledSession(id: string): AdminChatSession {
    const session = this.readSession(id)
    const enabled = this.database.prepare(`SELECT 1 FROM project_services service
      JOIN projects project ON project.id=service.project_id
      WHERE service.id=? AND service.project_id=? AND service.enabled=1 AND project.enabled=1`).get(
      session.serviceId,
      session.projectId,
    )
    if (!enabled) throw new Error("服务不存在或未启用")
    return session
  }

  private assertViewer(session: AdminChatSession, viewer?: { userId: string; isSuperAdmin: boolean }): void {
    if (!viewer || viewer.isSuperAdmin) return
    if (!session.createdByUserId || session.createdByUserId !== viewer.userId) throw new Error("后台对话会话不存在")
  }

  private readTurn(id: string): AdminChatTurn {
    const row = this.database.prepare("SELECT * FROM admin_chat_turns WHERE id=?").get(id) as SqlRow | undefined
    if (!row) throw new Error("后台对话轮次不存在")
    return this.hydrateTurn(turnFromRow(row))
  }

  private hydrateTurn(turn: AdminChatTurn): AdminChatTurn {
    const attachments = (this.database.prepare(`SELECT * FROM admin_chat_attachments
      WHERE turn_id=? ORDER BY created_at,id`).all(turn.id) as SqlRow[]).map(attachmentFromRow)
    const corrections = (this.database.prepare(`SELECT * FROM admin_chat_corrections
      WHERE turn_id=? ORDER BY created_at,id`).all(turn.id) as SqlRow[]).map(correctionFromRow)
    return adminChatTurnSchema.parse({ ...turn, attachments, corrections })
  }

  private assertMessageContent(question: string, attachments: SupportAttachmentContext[]): void {
    if (!question.trim() && attachments.length === 0) throw new Error("请输入问题或添加附件")
  }

  private touchSessionForTurn(turnId: string, updatedAt: string): void {
    this.database.prepare(`UPDATE admin_chat_sessions SET updated_at=? WHERE id=(
      SELECT session_id FROM admin_chat_turns WHERE id=?
    )`).run(updatedAt, turnId)
  }
}
