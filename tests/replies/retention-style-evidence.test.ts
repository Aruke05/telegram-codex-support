import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { OperatorStyleService } from "../../src/learning/operator-style-service.js"
import { RetentionService } from "../../src/replies/retention-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "retention-style-evidence-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const oldAt = "2026-01-01T00:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000401"
  const serviceId = "00000000-0000-4000-8000-000000000402"
  const groupId = "00000000-0000-4000-8000-000000000403"
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", oldAt, oldAt)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, oldAt, oldAt)
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "group", "群", null, null, projectId, serviceId, 0, "bot", "all", "telegram", "[]", null, null,
    "database", "default", "support", oldAt, oldAt,
  )
  const insertRole = database.prepare(`INSERT INTO telegram_roles(
    id,telegram_user_id,username,display_name,role,can_correct,enabled,learning_source_enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  insertRole.run("00000000-0000-4000-8000-000000000404", "10001", null, "运营一", "operator", 0, 1, 1, oldAt, oldAt)
  insertRole.run("00000000-0000-4000-8000-000000000408", "10002", null, "运营二", "operator", 0, 1, 1, oldAt, oldAt)
  return database
}

function seedOldStyleObservations(database: RuntimeDatabase): {
  eventIds: string[]
  observationIds: string[]
  threadIds: string[]
} {
  const oldAt = "2026-01-01T00:00:00.000Z"
  const groupId = "00000000-0000-4000-8000-000000000403"
  const projectId = "00000000-0000-4000-8000-000000000401"
  const serviceId = "00000000-0000-4000-8000-000000000402"
  const eventIds: string[] = []
  const observationIds: string[] = []
  const threadIds = Array.from({ length: 5 }, (_, index) => (
    `00000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}`
  ))
  const insertThread = database.prepare(`INSERT OR IGNORE INTO support_threads(
    id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
    origin_batch_id,generation_started_at,progress_due_at,hard_deadline_at,closed_at,closed_by,closed_reason,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertEvent = database.prepare(`INSERT INTO support_message_events(
    id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
    sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertObservation = database.prepare(`INSERT INTO learning_source_observations(
    id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
    takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (let index = 0; index < 20; index += 1) {
    const threadId = threadIds[index % threadIds.length]!
    const eventId = `00000000-0000-4000-8000-${String(600 + index).padStart(12, "0")}`
    const observationId = `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`
    const sourceUserId = index % 2 === 0 ? "10001" : "10002"
    insertThread.run(
      threadId, groupId, projectId, serviceId, "answered", 1, oldAt, String(index), oldAt, "保留期后应删除的线程摘要",
      null, null, null, null, null, null, null, oldAt, oldAt,
    )
    insertEvent.run(
      eventId, groupId, null, String(index), null, null, sourceUserId, null, "运营", "operator",
      `保留期后必须删除的 safe_text 原文 ${index}`, "", null, "role_skipped", null, oldAt,
    )
    insertObservation.run(
      observationId, eventId, sourceUserId, "operator", threadId, serviceId, "direct_question", 1,
      "cancelled", "reference_reply", "low", "completed", 1, null, null, oldAt, oldAt,
    )
    eventIds.push(eventId)
    observationIds.push(observationId)
  }
  return { eventIds, observationIds, threadIds }
}

describe("保留期删除与运营风格证据", () => {
  it("删除被风格版本引用的旧线程、事件和观察，但保留无正文的证据快照统计", async () => {
    const database = await openDatabase()
    try {
      const ids = seedOldStyleObservations(database)
      const version = new OperatorStyleService(database).updateFromObservations(ids.observationIds)
      expect(version).not.toBeNull()
      expect(version).toEqual(expect.objectContaining({ status: "active", sampleCount: 20, sourceUserCount: 2, threadCount: 5 }))
      expect(database.prepare("SELECT COUNT(*) AS count FROM support_thread_messages").get()).toEqual({ count: 0 })
      const versionRow = database.prepare("SELECT * FROM operator_style_versions WHERE id=?").get(version!.id)

      const result = new RetentionService(database).run(new Date("2026-08-11T00:00:00.000Z"))

      expect(result).toEqual(expect.objectContaining({ deletedThreads: 5, deletedMessageEvents: 20 }))
      expect(database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM support_message_events").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM learning_source_observations").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT * FROM operator_style_versions WHERE id=?").get(version!.id)).toEqual(versionRow)
      expect(database.prepare(`SELECT COUNT(*) AS count FROM operator_style_version_evidence
        WHERE operator_style_version_id=? AND observation_id IS NOT NULL`).get(version!.id)).toEqual({ count: 0 })
      expect(database.prepare(`SELECT COUNT(*) AS sample_count,COUNT(DISTINCT source_telegram_user_id) AS source_user_count,
        COUNT(DISTINCT thread_id) AS thread_count FROM operator_style_version_evidence
        WHERE operator_style_version_id=?`).get(version!.id)).toEqual({ sample_count: 20, source_user_count: 2, thread_count: 5 })
      expect((database.prepare("PRAGMA table_info(operator_style_version_evidence)").all() as Array<{ name: string }>)
        .map((column) => column.name)).not.toEqual(expect.arrayContaining(["safe_text", "summary", "profile_json"]))
    } finally {
      database.close()
    }
  })
})
