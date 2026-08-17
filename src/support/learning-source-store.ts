import { randomUUID } from "node:crypto"

import type { RuntimeDatabase } from "../runtime/database.js"
import { learningSourceObservationSchema, type LearningSourceObservation } from "../runtime/types.js"

type SqlRow = Record<string, unknown>

function observationFromRow(row: SqlRow): LearningSourceObservation {
  return learningSourceObservationSchema.parse({
    id: row.id,
    messageEventId: row.message_event_id,
    sourceTelegramUserId: row.source_telegram_user_id,
    sourceRole: row.source_role,
    threadId: row.thread_id,
    serviceId: row.service_id,
    associationReason: row.association_reason,
    associationConfidence: Number(row.association_confidence),
    takeoverStatus: row.takeover_status,
    classification: row.classification,
    risk: row.risk,
    processingStatus: row.processing_status,
    attemptCount: Number(row.attempt_count),
    lockToken: row.lock_token,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export class LearningSourceStore {
  constructor(private readonly database: RuntimeDatabase) {}

  list(): LearningSourceObservation[] {
    return (this.database.prepare("SELECT * FROM learning_source_observations ORDER BY created_at,id").all() as SqlRow[])
      .map(observationFromRow)
  }

  findByMessageEvent(messageEventId: string): LearningSourceObservation | null {
    const row = this.database.prepare("SELECT * FROM learning_source_observations WHERE message_event_id=?")
      .get(messageEventId) as SqlRow | undefined
    return row ? observationFromRow(row) : null
  }

  record(input: Omit<LearningSourceObservation, "id" | "attemptCount" | "lockToken" | "lockedAt" | "createdAt" | "updatedAt">): LearningSourceObservation {
    const existing = this.findByMessageEvent(input.messageEventId)
    if (existing) return existing
    const timestamp = new Date().toISOString()
    const observation = learningSourceObservationSchema.parse({
      ...input,
      id: randomUUID(),
      attemptCount: 0,
      lockToken: null,
      lockedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    this.database.prepare(`INSERT OR IGNORE INTO learning_source_observations(
      id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,
      association_confidence,takeover_status,classification,risk,processing_status,attempt_count,
      lock_token,locked_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      observation.id,
      observation.messageEventId,
      observation.sourceTelegramUserId,
      observation.sourceRole,
      observation.threadId,
      observation.serviceId,
      observation.associationReason,
      observation.associationConfidence,
      observation.takeoverStatus,
      observation.classification,
      observation.risk,
      observation.processingStatus,
      observation.attemptCount,
      observation.lockToken,
      observation.lockedAt,
      observation.createdAt,
      observation.updatedAt,
    )
    const recorded = this.findByMessageEvent(input.messageEventId)
    if (!recorded) throw new Error("可信人工回复观察保存失败")
    return recorded
  }
}
