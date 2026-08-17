import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { AdminChatStore } from "../../src/admin-chat/store.js"
import { RuntimeAdminService } from "../../src/runtime/admin-service.js"
import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { LocalSecretVault } from "../../src/runtime/secret-vault.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDatabase(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-source-schema-"))
  temporaryDirectories.push(directory)
  return path.join(directory, name)
}

function seedObservationReferences(database: RuntimeDatabase): { eventId: string; groupId: string; projectId: string; serviceId: string } {
  const now = "2026-08-11T00:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000001"
  const serviceId = "00000000-0000-4000-8000-000000000002"
  const groupId = "00000000-0000-4000-8000-000000000003"
  const eventId = "00000000-0000-4000-8000-000000000004"
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", now, now)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, now, now)
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "group", "群", null, null, projectId, serviceId, 0, "bot", "all", "telegram", "[]", null, null, "database", "default", "support", now, now,
  )
  database.prepare(`INSERT INTO support_message_events(
    id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
    sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    eventId, groupId, null, "1", null, null, "10001", null, "学习用户", "operator", "安全文本", "", null, "role_skipped", null, now,
  )
  return { eventId, groupId, projectId, serviceId }
}

type ObservationSchemaMalformation = "extra_column" | "missing_risk_check" | "extra_classification_check"
  | "missing_queue_index" | "extra_index" | "inert_update_trigger" | "inert_delete_trigger" | "rewritten_fence"

const observationEvidenceColumns = `message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,
  association_confidence,takeover_status,classification,risk,created_at`

function rebuildEmptyObservationTable(database: DatabaseSync, transform: (sql: string) => string): void {
  const observationCount = Number((database.prepare("SELECT COUNT(*) AS count FROM learning_source_observations").get() as { count: number }).count)
  const resultCount = Number((database.prepare("SELECT COUNT(*) AS count FROM reference_learning_results").get() as { count: number }).count)
  if (observationCount !== 0 || resultCount !== 0) throw new Error("结构反例只能重建空观察审计表")
  const observationSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='learning_source_observations'",
  ).get() as { sql: string }).sql
  const nextObservationSql = transform(observationSql)
  if (nextObservationSql === observationSql) throw new Error("测试未能改写 learning_source_observations DDL")
  const observationDependants = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE tbl_name='learning_source_observations' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`)
    .all() as Array<{ sql: string }>
  const resultSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='reference_learning_results'",
  ).get() as { sql: string }).sql
  const resultDependants = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE tbl_name='reference_learning_results' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`)
    .all() as Array<{ sql: string }>
  database.exec("PRAGMA foreign_keys=OFF")
  try {
    database.exec(`BEGIN IMMEDIATE;
      DROP TABLE reference_learning_results;
      DROP TABLE learning_source_observations;
      ${nextObservationSql};
      ${observationDependants.map((row) => `${row.sql};`).join("\n")}
      ${resultSql};
      ${resultDependants.map((row) => `${row.sql};`).join("\n")}
      COMMIT;`)
  } catch (error) {
    try { database.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    database.exec("PRAGMA foreign_keys=ON")
  }
}

function malformObservationSchema(filePath: string, malformed: ObservationSchemaMalformation): void {
  const database = new DatabaseSync(filePath)
  try {
    if (malformed === "extra_column") {
      database.exec("ALTER TABLE learning_source_observations ADD COLUMN forged TEXT")
    } else if (malformed === "missing_risk_check") {
      rebuildEmptyObservationTable(database, (sql) => sql.replace(
        "risk TEXT NOT NULL CHECK (risk IN ('low','medium','high'))",
        "risk TEXT NOT NULL",
      ))
    } else if (malformed === "extra_classification_check") {
      rebuildEmptyObservationTable(database, (sql) => sql.replace(
        "classification TEXT NOT NULL,",
        "classification TEXT NOT NULL CHECK(length(classification)>0),",
      ))
    } else if (malformed === "missing_queue_index") {
      database.exec("DROP INDEX learning_source_observations_queue_idx")
    } else if (malformed === "extra_index") {
      database.exec("CREATE INDEX forged_observation_idx ON learning_source_observations(risk,id)")
    } else if (malformed === "inert_update_trigger") {
      database.exec(`DROP TRIGGER learning_source_observations_no_evidence_update;
        CREATE TRIGGER learning_source_observations_no_evidence_update
        BEFORE UPDATE OF ${observationEvidenceColumns} ON learning_source_observations
        WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1' AND 0
        BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END;`)
    } else if (malformed === "inert_delete_trigger") {
      database.exec(`DROP TRIGGER learning_source_observations_no_delete;
        CREATE TRIGGER learning_source_observations_no_delete
        BEFORE DELETE ON learning_source_observations
        WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1' AND 0
        BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END;`)
    } else {
      database.exec(`DROP TRIGGER learning_source_observations_no_evidence_update;
        CREATE TRIGGER learning_source_observations_no_evidence_update
        BEFORE UPDATE OF ${observationEvidenceColumns} ON learning_source_observations
        WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_wrong_delete'), '0') != '1'
        BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END;`)
    }
  } finally {
    database.close()
  }
}

function insertObservationWithThread(database: RuntimeDatabase): string {
  const now = "2026-08-11T00:00:00.000Z"
  const { eventId, groupId, projectId, serviceId } = seedObservationReferences(database)
  const threadId = "00000000-0000-4000-8000-000000000030"
  const observationId = "00000000-0000-4000-8000-000000000031"
  database.prepare(`INSERT INTO support_threads(
    id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
    origin_batch_id,generation_started_at,progress_due_at,hard_deadline_at,closed_at,closed_by,closed_reason,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    threadId, groupId, projectId, serviceId, "answered", 1, now, "1", now, "问题", null, null, null, null,
    null, null, null, now, now,
  )
  database.prepare(`INSERT INTO learning_source_observations(
    id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
    takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,current_run_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    observationId, eventId, "10001", "operator", threadId, serviceId, "direct_question", 1,
    "cancelled", "reference_reply", "low", "pending", 0, null, null, null, now, now,
  )
  return observationId
}

async function captureRuntimeOpen(filePath: string): Promise<unknown> {
  try {
    const database = await RuntimeDatabase.open(filePath)
    database.close()
    return undefined
  } catch (error) {
    return error
  }
}

function capturePortableOpen(filePath: string, readOnly: boolean): unknown {
  try {
    const database = RuntimeDatabase.openPortable(filePath, readOnly)
    database.close()
    return undefined
  } catch (error) {
    return error
  }
}

function downgradeToRemoteV13(filePath: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`DROP TABLE reference_learning_results;
    DROP TABLE learning_source_observations;
    DROP TABLE support_reply_alert_deliveries;
    ALTER TABLE telegram_roles DROP COLUMN learning_source_enabled;
    ALTER TABLE support_replies DROP COLUMN operator_delivery_status;
    ALTER TABLE support_replies DROP COLUMN technical_alert_status;
    UPDATE metadata SET value='13' WHERE key='schema_version';`)
  legacy.close()
}

function downgradeAdminChatToOursV15(filePath: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE admin_chat_turns_ours_v15 (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES admin_chat_sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position>=1),
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      decision TEXT CHECK(decision IS NULL OR decision IN ('reply','ignore','escalate')),
      status TEXT NOT NULL CHECK(status IN ('pending','generating','completed','failed')),
      investigation_json TEXT NOT NULL,
      decision_reason TEXT,
      decision_confidence REAL CHECK(decision_confidence IS NULL OR decision_confidence BETWEEN 0 AND 1),
      code_revision TEXT,
      code_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
      code_sync_batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE SET NULL,
      memory_version_refs_json TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generation_started_at TEXT,
      completed_at TEXT,
      UNIQUE(session_id,position)
    );
    INSERT INTO admin_chat_turns_ours_v15 SELECT * FROM admin_chat_turns;
    DROP TABLE admin_chat_turns;
    ALTER TABLE admin_chat_turns_ours_v15 RENAME TO admin_chat_turns;
    CREATE INDEX admin_chat_turns_work_idx ON admin_chat_turns(status,created_at,id);
    CREATE UNIQUE INDEX admin_chat_turns_one_active_idx
      ON admin_chat_turns(session_id) WHERE status IN ('pending','generating');
    UPDATE metadata SET value='15' WHERE key='schema_version';
    COMMIT;
    PRAGMA foreign_keys=ON;`)
  legacy.close()
}

function expectAdminChatCancellation(database: RuntimeDatabase): void {
  const { serviceId } = seedObservationReferences(database)
  const store = new AdminChatStore(database)
  const session = store.createSession(serviceId)
  const turn = store.createTurn(session.id, "需要终止的测试对话")
  expect(store.cancelTurn(turn.id)).toEqual(expect.objectContaining({ status: "cancelled" }))
}

describe("可信回复观察审计 schema", () => {
  const malformedObservationCases: Array<{ label: string; malformed: ObservationSchemaMalformation }> = [
    { label: "额外列", malformed: "extra_column" },
    { label: "缺少 risk CHECK", malformed: "missing_risk_check" },
    { label: "额外 classification CHECK", malformed: "extra_classification_check" },
    { label: "缺少 queue 索引", malformed: "missing_queue_index" },
    { label: "额外索引", malformed: "extra_index" },
    { label: "惰化 UPDATE trigger", malformed: "inert_update_trigger" },
    { label: "惰化 DELETE trigger", malformed: "inert_delete_trigger" },
    { label: "改写 maintenance fence", malformed: "rewritten_fence" },
  ]

  it.each(malformedObservationCases)("同号 v23 运行库拒绝 observation $label", async ({ malformed }) => {
    const filePath = await temporaryDatabase(`malformed-observation-runtime-${malformed}.sqlite`)
    const source = await RuntimeDatabase.open(filePath)
    source.close()
    malformObservationSchema(filePath, malformed)

    expect(await captureRuntimeOpen(filePath)).toEqual(expect.objectContaining({
      message: expect.stringMatching(/终态审计结构不完整/u),
    }))
  })

  it.each(malformedObservationCases)("同号 v23 openPortable/export 拒绝 observation $label", async ({ malformed }) => {
    const filePath = await temporaryDatabase(`malformed-observation-export-${malformed}.sqlite`)
    const destination = await temporaryDatabase(`malformed-observation-exported-${malformed}.sqlite`)
    const source = await RuntimeDatabase.open(filePath)
    malformObservationSchema(filePath, malformed)
    try {
      expect(capturePortableOpen(filePath, false)).toEqual(expect.objectContaining({
        message: expect.stringMatching(/终态审计结构不完整/u),
      }))
      expect(capturePortableOpen(filePath, true)).toEqual(expect.objectContaining({
        message: expect.stringMatching(/终态审计结构不完整/u),
      }))
      await expect(new BackupService(source).export(destination)).rejects.toThrow(/终态审计结构不完整/u)
      await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      source.close()
    }
  })

  it.each(malformedObservationCases)("同号 v23 import 拒绝 observation $label 且不清空目标", async ({ malformed }) => {
    const portablePath = await temporaryDatabase(`malformed-observation-import-${malformed}.sqlite`)
    const source = await RuntimeDatabase.open(portablePath)
    source.close()
    malformObservationSchema(portablePath, malformed)
    const restored = await RuntimeDatabase.open(await temporaryDatabase(`malformed-observation-target-${malformed}.sqlite`))
    try {
      restored.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000032", "keep", "保留", "", 1, "default",
        "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
      )
      await expect(new BackupService(restored).import(portablePath)).rejects.toThrow(/终态审计结构不完整/u)
      expect(restored.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }])
    } finally {
      restored.close()
    }
  })

  it("同名惰化 UPDATE trigger 真实放行 source/thread/classification/risk 后仍必须拒绝打开", async () => {
    const filePath = await temporaryDatabase("inert-observation-update.sqlite")
    const source = await RuntimeDatabase.open(filePath)
    const observationId = insertObservationWithThread(source)
    malformObservationSchema(filePath, "inert_update_trigger")
    expect(source.prepare(`UPDATE learning_source_observations
      SET source_telegram_user_id='20002',thread_id=NULL,classification='FORGED',risk='high' WHERE id=?`)
      .run(observationId).changes).toBe(1)
    expect(source.prepare(`SELECT source_telegram_user_id,thread_id,classification,risk
      FROM learning_source_observations WHERE id=?`).get(observationId)).toEqual({
      source_telegram_user_id: "20002", thread_id: null, classification: "FORGED", risk: "high",
    })
    source.close()

    expect(await captureRuntimeOpen(filePath)).toEqual(expect.objectContaining({
      message: expect.stringMatching(/终态审计结构不完整/u),
    }))
  })

  it("同名惰化 DELETE trigger 真实删除 observation 后仍必须拒绝打开", async () => {
    const filePath = await temporaryDatabase("inert-observation-delete.sqlite")
    const source = await RuntimeDatabase.open(filePath)
    const observationId = insertObservationWithThread(source)
    malformObservationSchema(filePath, "inert_delete_trigger")
    expect(source.prepare("DELETE FROM learning_source_observations WHERE id=?").run(observationId).changes).toBe(1)
    source.close()

    expect(await captureRuntimeOpen(filePath)).toEqual(expect.objectContaining({
      message: expect.stringMatching(/终态审计结构不完整/u),
    }))
  })

  it("新数据库默认关闭学习来源角色并为观察消息建立唯一审计", async () => {
    const database = await RuntimeDatabase.open(await temporaryDatabase("fresh.sqlite"))
    try {
      const { eventId, serviceId } = seedObservationReferences(database)
      expect(database.schemaVersion()).toBe(27)
      const columns = database.prepare("PRAGMA table_info(telegram_roles)").all() as Array<{ name: string; dflt_value: string | null }>
      const column = columns.find((row) => row.name === "learning_source_enabled")
      expect(column?.dflt_value).toBe("0")
      const replyColumns = database.prepare("PRAGMA table_info(support_replies)").all() as Array<{ name: string; dflt_value: string | null }>
      expect(replyColumns).toContainEqual(expect.objectContaining({ name: "technical_alert_status", dflt_value: null }))
      expect(replyColumns).toContainEqual(expect.objectContaining({ name: "operator_delivery_status", dflt_value: null }))
      expect(database.prepare("PRAGMA table_info(support_reply_alert_deliveries)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "reply_id" }),
        expect.objectContaining({ name: "alert_kind" }),
        expect.objectContaining({ name: "status" }),
      ]))

      const insert = database.prepare(`INSERT INTO learning_source_observations(
        id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
        takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      const values = [
        "00000000-0000-4000-8000-000000000005", eventId, "10001", "operator", null, serviceId, "direct_question", 1,
        "not_linked", "reference_reply", "low", "pending", 0, null, null, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
      ]
      insert.run(...values)
      expect(() => insert.run("00000000-0000-4000-8000-000000000006", ...values.slice(1))).toThrow(/UNIQUE/i)
      expect(() => database.prepare("UPDATE learning_source_observations SET association_reason='none' WHERE message_event_id=?").run(eventId)).toThrow(/append only/i)
      expect(() => database.prepare("DELETE FROM learning_source_observations WHERE message_event_id=?").run(eventId)).toThrow(/append only/i)
      expect(() => database.prepare(`INSERT INTO learning_source_observations(
        id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
        takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000007", "missing-event", "10002", "operator", null, serviceId, "invalid", 1,
        "not_linked", "reference_reply", "low", "pending", 0, null, null, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
      )).toThrow()
    } finally {
      database.close()
    }
  })

  it("v12 角色迁移默认关闭学习来源", async () => {
    const filePath = await temporaryDatabase("v12.sqlite")
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO metadata(key,value) VALUES ('schema_version','12');
      CREATE TABLE telegram_roles (
        id TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL UNIQUE, username TEXT, display_name TEXT NOT NULL,
        role TEXT NOT NULL, can_correct INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO telegram_roles VALUES (
        '00000000-0000-4000-8000-000000000008','10003',NULL,'旧角色','reviewer',1,1,
        '2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z'
      );`)
    legacy.close()

    const database = await RuntimeDatabase.open(filePath)
    try {
      expect(database.schemaVersion()).toBe(27)
      expect(database.readRoles()).toEqual([expect.objectContaining({ telegramUserId: "10003", learningSourceEnabled: false })])
    } finally {
      database.close()
    }
  })

  it("远端 v13 对话终止谱系按结构补齐学习来源和逐项投递能力", async () => {
    const filePath = await temporaryDatabase("remote-v13.sqlite")
    const fresh = await RuntimeDatabase.open(filePath)
    fresh.close()
    downgradeToRemoteV13(filePath)

    const database = await RuntimeDatabase.open(filePath)
    try {
      expect(database.schemaVersion()).toBe(27)
      expect(database.prepare("PRAGMA table_info(telegram_roles)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "learning_source_enabled" }),
      ]))
      expect(database.prepare("PRAGMA table_info(support_replies)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "technical_alert_status" }),
        expect.objectContaining({ name: "operator_delivery_status" }),
      ]))
      expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_source_observations'").get()).toBeTruthy()
      expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_reply_alert_deliveries'").get()).toBeTruthy()
      expectAdminChatCancellation(database)
    } finally {
      database.close()
    }
  })

  it("ours v15 学习与投递谱系按结构补齐对话终止能力", async () => {
    const filePath = await temporaryDatabase("ours-v15.sqlite")
    const fresh = await RuntimeDatabase.open(filePath)
    fresh.close()
    downgradeAdminChatToOursV15(filePath)

    const database = await RuntimeDatabase.open(filePath)
    try {
      expect(database.schemaVersion()).toBe(27)
      expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_source_observations'").get()).toBeTruthy()
      expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_reply_alert_deliveries'").get()).toBeTruthy()
      expectAdminChatCancellation(database)
    } finally {
      database.close()
    }
  })

  it("角色 CRUD 和便携备份保留授权并重置运行中的观察锁", async () => {
    const sourcePath = await temporaryDatabase("source.sqlite")
    const source = await RuntimeDatabase.open(sourcePath)
    const vault = await LocalSecretVault.open(await temporaryDatabase("master.key"))
    const admin = new RuntimeAdminService(source, vault)
    try {
      const created = await admin.createRole({
        telegramUserId: "10004", username: null, displayName: "授权用户", role: "reviewer", canCorrect: true, enabled: true, learningSourceEnabled: true,
      })
      const updated = await admin.updateRole(created.id, { learningSourceEnabled: false })
      expect(updated.learningSourceEnabled).toBe(false)
      await admin.updateRole(created.id, { learningSourceEnabled: true })

      const { eventId, serviceId } = seedObservationReferences(source)
      const runId = "00000000-0000-4000-8000-000000000010"
      source.prepare(`INSERT INTO memory_maintenance_runs(
        id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        runId, "running", 1, 0, 0, "处理中", "2026-08-11T00:00:00.000Z", null,
      )
      source.prepare(`INSERT INTO learning_source_observations(
        id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
        takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,current_run_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000009", eventId, "10004", "reviewer", null, serviceId, "direct_bot_reply", 0.9,
        "delivery_in_flight", "reference_reply", "medium", "running", 2, "worker-lock", "2026-08-11T00:00:00.000Z",
        runId, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
      )
      const exportPath = await temporaryDatabase("portable.sqlite")
      await new BackupService(source).export(exportPath)
      const portable = RuntimeDatabase.openPortable(exportPath, true)
      try {
        expect(portable.schemaVersion()).toBe(27)
        expect(portable.readRoles()).toEqual([expect.objectContaining({ telegramUserId: "10004", learningSourceEnabled: true })])
        expect(portable.prepare("SELECT 1 FROM learning_source_observations WHERE message_event_id=?").get(eventId)).toBeTruthy()
        expect(portable.prepare("SELECT status FROM memory_maintenance_runs WHERE id=?").get(runId)).toEqual({ status: "failed" })
        expect(portable.prepare("SELECT outcome,reason_code FROM reference_learning_results WHERE run_id=?").get(runId)).toEqual({
          outcome: "failed", reason_code: "interrupted_run",
        })
      } finally {
        portable.close()
      }

      const restored = await RuntimeDatabase.open(await temporaryDatabase("restored.sqlite"))
      try {
        await new BackupService(restored).import(exportPath)
        expect(restored.schemaVersion()).toBe(27)
        expect(restored.readRoles()).toEqual([expect.objectContaining({ telegramUserId: "10004", learningSourceEnabled: true })])
        expect(restored.prepare("SELECT processing_status,lock_token,locked_at FROM learning_source_observations WHERE message_event_id=?").get(eventId)).toEqual({
          processing_status: "pending", lock_token: null, locked_at: null,
        })
      } finally {
        restored.close()
      }
    } finally {
      source.close()
    }
  })

  it("v23 portable 导入拒绝技术告警群业务绑定且清库前保留目标 marker", async () => {
    const portablePath = await temporaryDatabase("technical-binding-v23.sqlite")
    const source = await RuntimeDatabase.open(portablePath)
    try {
      seedObservationReferences(source)
      source.prepare("UPDATE telegram_groups SET purpose='technical_alert'").run()
    } finally {
      source.close()
    }
    const restored = await RuntimeDatabase.open(await temporaryDatabase("technical-binding-v23-restored.sqlite"))
    try {
      restored.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        "00000000-0000-4000-8000-000000000020", "keep", "保留", "", 1, "default",
        "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
      )
      await expect(new BackupService(restored).import(portablePath)).rejects.toThrow(/技术告警群.*绑定/u)
      expect(restored.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }])
    } finally {
      restored.close()
    }
  })

  it("v23 export 不复制技术告警群业务绑定", async () => {
    const source = await RuntimeDatabase.open(await temporaryDatabase("technical-binding-export-source.sqlite"))
    const portablePath = await temporaryDatabase("technical-binding-export.sqlite")
    try {
      seedObservationReferences(source)
      source.prepare("UPDATE telegram_groups SET purpose='technical_alert'").run()
      await expect(new BackupService(source).export(portablePath)).rejects.toThrow(/技术告警群.*绑定/u)
    } finally {
      source.close()
    }
  })

  it("v22 portable 导入时把技术告警群异常业务绑定安全归一化为空", async () => {
    const portablePath = await temporaryDatabase("technical-binding-v22.sqlite")
    const source = await RuntimeDatabase.open(portablePath)
    try {
      seedObservationReferences(source)
      source.prepare("UPDATE telegram_groups SET purpose='technical_alert'").run()
    } finally {
      source.close()
    }
    const legacy = new DatabaseSync(portablePath)
    legacy.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE reference_learning_results;
      ALTER TABLE learning_source_observations DROP COLUMN current_run_id;
      UPDATE metadata SET value='22' WHERE key='schema_version';
      PRAGMA foreign_keys=ON;`)
    legacy.close()

    const restored = await RuntimeDatabase.open(await temporaryDatabase("technical-binding-v22-restored.sqlite"))
    try {
      await new BackupService(restored).import(portablePath)
      expect(restored.prepare("SELECT purpose,project_id,service_id FROM telegram_groups").all()).toEqual([{
        purpose: "technical_alert", project_id: null, service_id: null,
      }])
    } finally {
      restored.close()
    }
  })

  it("远端 v13 portable 缺少学习与投递结构时保留已终止对话并可导入", async () => {
    const source = await RuntimeDatabase.open(await temporaryDatabase("remote-v13-portable-source.sqlite"))
    const exportPath = await temporaryDatabase("remote-v13-portable.sqlite")
    let cancelledTurnId = ""
    try {
      const { serviceId } = seedObservationReferences(source)
      const store = new AdminChatStore(source)
      const session = store.createSession(serviceId)
      cancelledTurnId = store.cancelTurn(store.createTurn(session.id, "便携迁移终止对话").id).id
      await new BackupService(source).export(exportPath)
    } finally {
      source.close()
    }
    downgradeToRemoteV13(exportPath)

    const restored = await RuntimeDatabase.open(await temporaryDatabase("remote-v13-portable-restored.sqlite"))
    try {
      await new BackupService(restored).import(exportPath)
      expect(restored.schemaVersion()).toBe(27)
      expect(restored.prepare("SELECT status FROM admin_chat_turns WHERE id=?").get(cancelledTurnId)).toEqual({ status: "cancelled" })
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      restored.close()
    }
  })

  it("v14 portable 缺少逐项投递表列时仍可导入并使用 NULL 默认值", async () => {
    const source = await RuntimeDatabase.open(await temporaryDatabase("v14-source.sqlite"))
    const exportPath = await temporaryDatabase("v14-portable.sqlite")
    const replyId = "00000000-0000-4000-8000-000000000010"
    try {
      source.prepare(`INSERT INTO support_replies(
        id,service,decision,status,operator_delivery_status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?)`).run(
        replyId, "service", "reply", "failed", "uncertain",
        "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
      )
      source.prepare(`INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text,has_attachment)
        VALUES (?,?,?,?,0)`).run(replyId, "旧迁移问题", "旧迁移答案", null)
      await new BackupService(source).export(exportPath)
    } finally {
      source.close()
    }
    const legacy = new DatabaseSync(exportPath)
    legacy.exec(`DROP TABLE reference_learning_results;
      ALTER TABLE learning_source_observations DROP COLUMN current_run_id;
      DROP TABLE support_reply_alert_deliveries;
      ALTER TABLE support_replies DROP COLUMN operator_delivery_status;
      UPDATE metadata SET value='14' WHERE key='schema_version';`)
    legacy.close()

    const restored = await RuntimeDatabase.open(await temporaryDatabase("v14-restored.sqlite"))
    try {
      await new BackupService(restored).import(exportPath)
      expect(restored.schemaVersion()).toBe(27)
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      expect(restored.readReplies("WHERE r.id=?", [replyId])).toEqual([
        expect.objectContaining({ id: replyId, operatorDeliveryStatus: null }),
      ])
    } finally {
      restored.close()
    }
  })
})
