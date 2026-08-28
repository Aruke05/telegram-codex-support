import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []
const now = "2026-08-28T00:00:00.000Z"

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function databasePath(prefix: string, fileName = "runtime.sqlite"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return path.join(directory, fileName)
}

function seedCatalog(database: RuntimeDatabase): { projectId: string; serviceId: string; groupId: string } {
  const projectId = randomUUID()
  const serviceId = randomUUID()
  const groupId = randomUUID()
  database.prepare(`INSERT INTO projects(
    id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(projectId, `project-${projectId}`, "项目", "", 1, "default", now, now)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, `service-${serviceId}`, "服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, `group-${groupId}`, "客服群", `-${Date.now()}${Math.floor(Math.random() * 1000)}`, null,
    projectId, serviceId, 1, "bot", "all", "telegram", "[]", null, null, "database", "default", "support", now, now,
  )
  return { projectId, serviceId, groupId }
}

function seedThread(
  database: RuntimeDatabase,
  catalog: { projectId: string; serviceId: string; groupId: string },
  overrides: { humanPriorityMessageId?: string | null; revision?: number } = {},
): string {
  const id = randomUUID()
  const revision = overrides.revision ?? 1
  database.prepare(`INSERT INTO support_threads(
    id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
    human_priority_state,human_priority_progress_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, catalog.groupId, catalog.projectId, catalog.serviceId, "generating", revision, now, randomUUID(), now, "问题",
    overrides.humanPriorityMessageId ? "claimed" : "none", overrides.humanPriorityMessageId ?? null, now, now,
  )
  return id
}

function seedNotification(database: RuntimeDatabase, threadId: string, status: "pending" | "sending" | "sent" | "failed" | "unknown"): string {
  const id = randomUUID()
  database.prepare(`INSERT INTO support_thread_notifications(
    id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, threadId, 1, "progress", status, now, status === "sent" ? randomUUID() : null, null, now, now,
  )
  return id
}

function seedProgressNotification(
  database: RuntimeDatabase,
  threadId: string,
  input: {
    inputRevision: number
    status: "pending" | "sending" | "sent" | "failed" | "unknown"
    telegramMessageId?: string | null
    createdAt?: string
  },
): string {
  const id = randomUUID()
  const createdAt = input.createdAt ?? now
  database.prepare(`INSERT INTO support_thread_notifications(
    id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    threadId,
    input.inputRevision,
    "progress",
    input.status,
    createdAt,
    input.telegramMessageId ?? null,
    null,
    createdAt,
    createdAt,
  )
  return id
}

function seedReply(
  database: RuntimeDatabase,
  catalog: { projectId: string; serviceId: string; groupId: string },
  threadId: string,
  input: { createdAt: string; errorCode?: string | null; status?: string },
): string {
  const id = randomUUID()
  database.prepare(`INSERT INTO support_replies(
    id,thread_id,input_revision,group_id,project_id,service_id,telegram_message_id,service,decision,status,
    operator_delivery_status,created_at,updated_at,generation_started_at,error_code,decision_reason,decision_confidence
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, threadId, 1, catalog.groupId, catalog.projectId, catalog.serviceId, randomUUID(), "service", "escalate",
    input.status ?? "generating", null, input.createdAt, input.createdAt, input.createdAt,
    input.errorCode ?? null, "结构化历史状态", 1,
  )
  database.prepare(`INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text,has_attachment)
    VALUES (?,?,?,?,0)`).run(id, "问题", "已准备升级回复", null)
  return id
}

function seedOwnership(
  database: RuntimeDatabase,
  catalog: { serviceId: string; groupId: string },
  input: {
    threadId: string
    outputKind: string
    status: "sending" | "sent" | "failed" | "unknown"
    replyId?: string | null
    notificationId?: string | null
    telegramMessageId?: string | null
  },
): string {
  const id = randomUUID()
  const group = database.prepare("SELECT telegram_chat_id FROM telegram_groups WHERE id=?").get(catalog.groupId) as {
    telegram_chat_id: string
  }
  database.prepare(`INSERT INTO telegram_output_ownership(
    id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
    notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, null, catalog.groupId, group.telegram_chat_id, input.telegramMessageId ?? null, input.threadId, catalog.serviceId,
    input.replyId ?? null, input.notificationId ?? null, input.outputKind, input.status, randomUUID(), "a".repeat(64),
    null, now, now,
  )
  return id
}

function downgradeToV32(filePath: string): void {
  downgradeNotificationsToV33(filePath)
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`DROP TABLE IF EXISTS support_thread_output_claims;
    UPDATE metadata SET value='32' WHERE key='schema_version';`)
  legacy.close()
}

function downgradeNotificationsToConstraintlessV32(filePath: string, orphanThreadId?: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE support_thread_output_claims;
    CREATE TABLE support_thread_notifications_v32_partial (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      input_revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      due_at TEXT NOT NULL,
      telegram_message_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO support_thread_notifications_v32_partial(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
    ) SELECT id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
      FROM support_thread_notifications;
    DROP TABLE support_thread_notifications;
    ALTER TABLE support_thread_notifications_v32_partial RENAME TO support_thread_notifications;
    CREATE INDEX support_thread_notifications_due_idx
      ON support_thread_notifications(status,due_at,id);`)
  if (orphanThreadId) {
    legacy.prepare(`INSERT INTO support_thread_notifications(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), orphanThreadId, 1, "progress", "sent", now, "orphan-message", null, now, now,
    )
  }
  legacy.prepare("UPDATE metadata SET value='32' WHERE key='schema_version'").run()
  legacy.exec("PRAGMA foreign_keys=ON")
  legacy.close()
}

function downgradeNotificationsToV33(filePath: string): void {
  const legacy = new DatabaseSync(filePath)
  const hasOutboundText = (legacy.prepare("PRAGMA table_info(support_thread_notifications)").all() as Array<{ name: string }>)
    .some((column) => column.name === "outbound_text")
  if (hasOutboundText) {
    legacy.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE support_thread_notifications_v33 (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        input_revision INTEGER NOT NULL CHECK(input_revision >= 1),
        kind TEXT NOT NULL CHECK(kind IN ('progress','timeout_operator','timeout_alert')),
        status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')),
        due_at TEXT NOT NULL,
        telegram_message_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id,input_revision,kind)
      );
      INSERT INTO support_thread_notifications_v33(
        id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
      ) SELECT id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
        FROM support_thread_notifications;
      DROP TABLE support_thread_notifications;
      CREATE TABLE support_thread_notifications (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        input_revision INTEGER NOT NULL CHECK(input_revision >= 1),
        kind TEXT NOT NULL CHECK(kind IN ('progress','timeout_operator','timeout_alert')),
        status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')),
        due_at TEXT NOT NULL,
        telegram_message_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id,input_revision,kind)
      );
      INSERT INTO support_thread_notifications(
        id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
      ) SELECT id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
        FROM support_thread_notifications_v33;
      DROP TABLE support_thread_notifications_v33;
      CREATE INDEX support_thread_notifications_due_idx
        ON support_thread_notifications(status,due_at,id);
      PRAGMA foreign_keys=ON;`)
  }
  legacy.prepare("UPDATE metadata SET value='33' WHERE key='schema_version'").run()
  legacy.close()
}

function replaceClaimsWithMalformedV33Table(filePath: string, threadId: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`DROP TABLE support_thread_output_claims;
    CREATE TABLE support_thread_output_claims(
      thread_id TEXT NOT NULL,
      claim_kind TEXT NOT NULL
    );`)
  legacy.prepare("INSERT INTO support_thread_output_claims(thread_id,claim_kind) VALUES (?,?)")
    .run(threadId, "progress")
  legacy.close()
}

function tableSnapshot(connection: DatabaseSync, table: string): { sql: string; rows: unknown[] } {
  const schema = connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql: string }
  return {
    sql: schema.sql,
    rows: connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }
}

describe("线程语义输出所有权 schema", () => {
  it("v33 notification 无损升级到 v34 并为历史真实出站文本保留 null", async () => {
    const filePath = await databasePath("thread-output-v33-runtime-")
    const source = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(source)
    const threadId = seedThread(source, catalog)
    const notificationId = seedNotification(source, threadId, "sent")
    source.close()
    downgradeNotificationsToV33(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)

    expect(migrated.schemaVersion()).toBe(34)
    expect(migrated.prepare("PRAGMA table_info(support_thread_notifications)").all()).toContainEqual(
      expect.objectContaining({ name: "outbound_text", type: "TEXT", notnull: 0 }),
    )
    expect(migrated.prepare(`SELECT status,telegram_message_id,outbound_text
      FROM support_thread_notifications WHERE id=?`).get(notificationId)).toEqual({
      status: "sent",
      telegram_message_id: expect.any(String),
      outbound_text: null,
    })
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  })

  it("同号 v33 notification 结构损坏时事务回滚并 fail closed", async () => {
    const filePath = await databasePath("thread-output-v33-malformed-")
    const source = await RuntimeDatabase.open(filePath)
    source.close()
    downgradeNotificationsToV33(filePath)
    const malformed = new DatabaseSync(filePath)
    malformed.prepare("ALTER TABLE support_thread_notifications ADD COLUMN forged TEXT").run()
    malformed.close()

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/线程进度通知结构不完整/)

    const rolledBack = new DatabaseSync(filePath)
    expect(rolledBack.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: "33" })
    expect(rolledBack.prepare("PRAGMA table_info(support_thread_notifications)").all())
      .toContainEqual(expect.objectContaining({ name: "forged" }))
    rolledBack.close()
  })

  it.each([
    { label: "runtime", portable: false },
    { label: "writable portable", portable: true },
  ])("$label 的 v33 notification 合法但 claims 残缺时整次 v34 迁移回滚", async ({ portable }) => {
    const filePath = await databasePath(
      portable ? "thread-output-v33-claim-portable-" : "thread-output-v33-claim-runtime-",
      portable ? "portable.sqlite" : "runtime.sqlite",
    )
    const source = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(source)
    const threadId = seedThread(source, catalog)
    const notificationId = seedNotification(source, threadId, "sent")
    source.close()
    downgradeNotificationsToV33(filePath)
    replaceClaimsWithMalformedV33Table(filePath, threadId)

    const before = new DatabaseSync(filePath)
    const notificationBefore = tableSnapshot(before, "support_thread_notifications")
    const claimsBefore = tableSnapshot(before, "support_thread_output_claims")
    before.close()

    if (portable) {
      expect(() => RuntimeDatabase.openPortable(filePath)).toThrow(/线程语义输出所有权结构不完整/)
    } else {
      await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/线程语义输出所有权结构不完整/)
    }

    const rolledBack = new DatabaseSync(filePath)
    expect(rolledBack.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: "33" })
    expect(tableSnapshot(rolledBack, "support_thread_notifications")).toEqual(notificationBefore)
    expect(tableSnapshot(rolledBack, "support_thread_output_claims")).toEqual(claimsBefore)
    expect(rolledBack.prepare("SELECT id FROM support_thread_notifications WHERE id=?").get(notificationId))
      .toEqual({ id: notificationId })
    rolledBack.close()
  })

  it("新库使用 v34 且完整约束两类线程级 owner 与真实通知出站文本", async () => {
    const database = await RuntimeDatabase.open(await databasePath("thread-output-fresh-"))
    openDatabases.push(database)

    expect(database.schemaVersion()).toBe(34)
    expect(database.prepare("PRAGMA table_info(support_thread_output_claims)").all()).toEqual([
      expect.objectContaining({ name: "thread_id", type: "TEXT", notnull: 1, pk: 1 }),
      expect.objectContaining({ name: "claim_kind", type: "TEXT", notnull: 1, pk: 2 }),
      expect.objectContaining({ name: "source_kind", type: "TEXT", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "reply_id", type: "TEXT", notnull: 0, pk: 0 }),
      expect.objectContaining({ name: "notification_id", type: "TEXT", notnull: 0, pk: 0 }),
      expect.objectContaining({ name: "created_at", type: "TEXT", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "updated_at", type: "TEXT", notnull: 1, pk: 0 }),
    ])
    const indexes = database.prepare("PRAGMA index_list(support_thread_output_claims)").all() as Array<{
      unique: number
      origin: string
    }>
    expect(indexes.filter((index) => index.unique === 1 && index.origin === "u")).toHaveLength(2)
    expect(indexes.filter((index) => index.unique === 1 && index.origin === "pk")).toHaveLength(1)
    expect(database.prepare("PRAGMA foreign_key_list(support_thread_output_claims)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "thread_id", table: "support_threads", to: "id", on_delete: "CASCADE" }),
      expect.objectContaining({ from: "reply_id", table: "support_replies", to: "id", on_delete: "CASCADE" }),
      expect.objectContaining({ from: "notification_id", table: "support_thread_notifications", to: "id", on_delete: "CASCADE" }),
    ]))

    const catalog = seedCatalog(database)
    const firstThread = seedThread(database, catalog)
    const secondThread = seedThread(database, catalog)
    const firstNotification = seedNotification(database, firstThread, "pending")
    const secondNotification = seedNotification(database, secondThread, "pending")
    const firstReply = seedReply(database, catalog, firstThread, { createdAt: now })
    const secondReply = seedReply(database, catalog, secondThread, { createdAt: now })
    database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(firstThread, "progress", "scheduled_progress", null, firstNotification, now, now)
    expect(() => database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(firstThread, "progress", "human_priority", null, secondNotification, now, now)).toThrow()
    expect(() => database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(secondThread, "progress", "status_request", null, firstNotification, now, now)).toThrow()
    expect(() => database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(secondThread, "handoff", "technical_change", null, secondNotification, now, now)).toThrow()
    database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(firstThread, "handoff", "technical_change", firstReply, null, now, now)
    expect(() => database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(secondThread, "handoff", "technical_change", firstReply, null, now, now)).toThrow()
    expect(() => database.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(firstThread, "handoff", "technical_change", secondReply, null, now, now)).toThrow()
  })

  it("v32 运行库按结构化发送事实回填 progress 和最早 handoff owner", async () => {
    const filePath = await databasePath("thread-output-v32-runtime-")
    const current = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(current)
    const notificationThread = seedThread(current, catalog)
    const notificationId = seedNotification(current, notificationThread, "sent")
    seedOwnership(current, catalog, {
      threadId: notificationThread,
      outputKind: "progress",
      status: "sent",
      notificationId,
      telegramMessageId: "101",
    })
    const humanThread = seedThread(current, catalog, { humanPriorityMessageId: "102" })
    const humanOwnershipId = seedOwnership(current, catalog, {
      threadId: humanThread,
      outputKind: "mention_claim_progress",
      status: "sent",
      telegramMessageId: "102",
    })
    const statusThread = seedThread(current, catalog)
    const statusReplyId = seedReply(current, catalog, statusThread, { createdAt: "2026-08-28T00:01:00.000Z", status: "replied" })
    current.prepare("UPDATE support_replies SET decision='reply' WHERE id=?").run(statusReplyId)
    const statusOwnershipId = seedOwnership(current, catalog, {
      threadId: statusThread,
      outputKind: "progress",
      status: "unknown",
      replyId: statusReplyId,
    })
    const duplicateHandoffThread = seedThread(current, catalog)
    const earliestReply = seedReply(current, catalog, duplicateHandoffThread, {
      createdAt: "2026-08-28T00:02:00.000Z",
      errorCode: "feature_request_prepared",
    })
    const laterReply = seedReply(current, catalog, duplicateHandoffThread, {
      createdAt: "2026-08-28T00:03:00.000Z",
      errorCode: "answer_hard_deadline",
      status: "escalated",
    })
    current.prepare(`INSERT INTO support_reply_alert_deliveries(reply_id,alert_kind,status,created_at,updated_at)
      VALUES (?,?,?,?,?)`).run(laterReply, "escalation", "sent", now, now)
    const ordinaryHandoffThread = seedThread(current, catalog)
    const ordinaryReply = seedReply(current, catalog, ordinaryHandoffThread, {
      createdAt: "2026-08-28T00:04:00.000Z",
      status: "failed",
    })
    current.close()
    downgradeToV32(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)
    expect(migrated.schemaVersion()).toBe(34)
    expect(migrated.prepare(`SELECT thread_id,claim_kind,source_kind,reply_id,notification_id
      FROM support_thread_output_claims ORDER BY thread_id,claim_kind`).all()).toEqual(expect.arrayContaining([
      { thread_id: notificationThread, claim_kind: "progress", source_kind: "scheduled_progress", reply_id: null, notification_id: notificationId },
      { thread_id: humanThread, claim_kind: "progress", source_kind: "human_priority", reply_id: null, notification_id: expect.any(String) },
      { thread_id: statusThread, claim_kind: "progress", source_kind: "status_request", reply_id: null, notification_id: expect.any(String) },
      { thread_id: duplicateHandoffThread, claim_kind: "handoff", source_kind: "feature_request", reply_id: earliestReply, notification_id: null },
      { thread_id: ordinaryHandoffThread, claim_kind: "handoff", source_kind: "technical_change", reply_id: ordinaryReply, notification_id: null },
    ]))
    expect(migrated.prepare(`SELECT notification_id FROM telegram_output_ownership WHERE id=?`).get(humanOwnershipId))
      .toEqual({ notification_id: expect.any(String) })
    expect(migrated.prepare(`SELECT notification_id FROM telegram_output_ownership WHERE id=?`).get(statusOwnershipId))
      .toEqual({ notification_id: expect.any(String) })
    expect(migrated.prepare(`SELECT status FROM support_thread_notifications
      WHERE id=(SELECT notification_id FROM telegram_output_ownership WHERE id=?)`).get(humanOwnershipId)).toEqual({ status: "sent" })
    expect(migrated.prepare(`SELECT status FROM support_thread_notifications
      WHERE id=(SELECT notification_id FROM telegram_output_ownership WHERE id=?)`).get(statusOwnershipId)).toEqual({ status: "unknown" })
  })

  it("v32 progress 回填只让当前可恢复或已有发送事实的 notification 占有 claim", async () => {
    const filePath = await databasePath("thread-output-v32-progress-matrix-")
    const current = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(current)

    const failedBeforeRpcThread = seedThread(current, catalog)
    const failedBeforeRpc = seedProgressNotification(current, failedBeforeRpcThread, {
      inputRevision: 1,
      status: "failed",
    })

    const oldFailedBeforeRpcThread = seedThread(current, catalog, { revision: 2 })
    seedProgressNotification(current, oldFailedBeforeRpcThread, {
      inputRevision: 1,
      status: "failed",
    })

    const currentPendingThread = seedThread(current, catalog, { revision: 2 })
    seedProgressNotification(current, currentPendingThread, {
      inputRevision: 1,
      status: "pending",
      createdAt: "2026-08-27T23:58:00.000Z",
    })
    const currentPending = seedProgressNotification(current, currentPendingThread, {
      inputRevision: 2,
      status: "pending",
      createdAt: "2026-08-28T00:01:00.000Z",
    })

    const currentSendingThread = seedThread(current, catalog)
    const currentSending = seedProgressNotification(current, currentSendingThread, {
      inputRevision: 1,
      status: "sending",
    })

    const oldSendingWithOwnershipThread = seedThread(current, catalog, { revision: 2 })
    const oldSendingWithOwnership = seedProgressNotification(current, oldSendingWithOwnershipThread, {
      inputRevision: 1,
      status: "sending",
    })
    seedOwnership(current, catalog, {
      threadId: oldSendingWithOwnershipThread,
      outputKind: "progress",
      status: "sending",
      notificationId: oldSendingWithOwnership,
    })
    seedProgressNotification(current, oldSendingWithOwnershipThread, {
      inputRevision: 2,
      status: "pending",
      createdAt: "2026-08-28T00:02:00.000Z",
    })

    const sentThread = seedThread(current, catalog)
    const sent = seedProgressNotification(current, sentThread, {
      inputRevision: 1,
      status: "sent",
    })

    const unknownThread = seedThread(current, catalog)
    const unknown = seedProgressNotification(current, unknownThread, {
      inputRevision: 1,
      status: "unknown",
    })

    const failedWithStartedOwnershipThread = seedThread(current, catalog)
    const failedWithStartedOwnership = seedProgressNotification(current, failedWithStartedOwnershipThread, {
      inputRevision: 1,
      status: "failed",
    })
    seedOwnership(current, catalog, {
      threadId: failedWithStartedOwnershipThread,
      outputKind: "progress",
      status: "unknown",
      notificationId: failedWithStartedOwnership,
    })

    const failedWithMessageThread = seedThread(current, catalog)
    const failedWithMessage = seedProgressNotification(current, failedWithMessageThread, {
      inputRevision: 1,
      status: "failed",
      telegramMessageId: "matrix-message",
    })
    current.close()
    downgradeToV32(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)
    const claims = migrated.prepare(`SELECT thread_id,notification_id FROM support_thread_output_claims
      WHERE claim_kind='progress' ORDER BY thread_id`).all() as Array<{
        thread_id: string
        notification_id: string
      }>
    const claimedByThread = new Map(claims.map((claim) => [claim.thread_id, claim.notification_id]))

    expect(claimedByThread.has(failedBeforeRpcThread)).toBe(false)
    expect(claimedByThread.has(oldFailedBeforeRpcThread)).toBe(false)
    expect(claimedByThread.get(currentPendingThread)).toBe(currentPending)
    expect(claimedByThread.get(currentSendingThread)).toBe(currentSending)
    expect(claimedByThread.get(oldSendingWithOwnershipThread)).toBe(oldSendingWithOwnership)
    expect(claimedByThread.get(sentThread)).toBe(sent)
    expect(claimedByThread.get(unknownThread)).toBe(unknown)
    expect(claimedByThread.get(failedWithStartedOwnershipThread)).toBe(failedWithStartedOwnership)
    expect(claimedByThread.get(failedWithMessageThread)).toBe(failedWithMessage)

    const store = new SupportThreadStore(migrated, new ConfiguredSecretRedactor(migrated))
    expect(store.hasStartedProgress(failedBeforeRpcThread)).toBe(false)
    expect(store.claimProgressNotification(
      failedBeforeRpcThread,
      1,
      "status_request",
      now,
      now,
    )?.id).toBe(failedBeforeRpc)
  })

  it("v32 迁移库可升级，已知缺表谱系可迁移而伪造残缺同名表被拒绝", async () => {
    const portablePath = await databasePath("thread-output-v32-portable-", "portable.sqlite")
    const current = await RuntimeDatabase.open(portablePath)
    current.close()
    downgradeToV32(portablePath)
    const migratedPortable = RuntimeDatabase.openPortable(portablePath)
    openDatabases.push(migratedPortable)
    expect(migratedPortable.schemaVersion()).toBe(34)
    expect(migratedPortable.prepare("SELECT COUNT(*) AS count FROM support_thread_output_claims").get()).toEqual({ count: 0 })

    const forgedPath = await databasePath("thread-output-v32-forged-")
    const forgedCurrent = await RuntimeDatabase.open(forgedPath)
    forgedCurrent.close()
    const forged = new DatabaseSync(forgedPath)
    forged.exec(`DROP TABLE IF EXISTS support_thread_output_claims;
      CREATE TABLE support_thread_output_claims(thread_id TEXT PRIMARY KEY, claim_kind TEXT NOT NULL);
      UPDATE metadata SET value='32' WHERE key='schema_version';`)
    forged.close()
    await expect(RuntimeDatabase.open(forgedPath)).rejects.toThrow(/线程语义输出所有权结构不完整/)
  })

  it("v32 部分 support 表列缺失时跳过对应回填并建立空 claims", async () => {
    const filePath = await databasePath("thread-output-v32-partial-support-")
    const source = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(source)
    const threadId = seedThread(source, catalog)
    source.close()
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE support_thread_output_claims;
      DROP TABLE support_thread_notifications;
      CREATE TABLE support_thread_notifications (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        input_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT NOT NULL,
        telegram_message_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id,input_revision)
      );
      CREATE INDEX support_thread_notifications_due_idx
        ON support_thread_notifications(status,due_at,id);
      DROP TABLE support_reply_payloads;
      UPDATE metadata SET value='32' WHERE key='schema_version';
      PRAGMA foreign_keys=ON;`)
    legacy.close()

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)
    expect(migrated.schemaVersion()).toBe(34)
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM support_thread_output_claims").get())
      .toEqual({ count: 0 })
    expect(migrated.prepare("PRAGMA table_info(support_thread_notifications)").all()).toEqual([
      expect.objectContaining({ name: "id", type: "TEXT", pk: 1 }),
      expect.objectContaining({ name: "thread_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "input_revision", type: "INTEGER", notnull: 1 }),
      expect.objectContaining({ name: "kind", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "status", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "due_at", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "telegram_message_id", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "outbound_text", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "error_message", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "created_at", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "updated_at", type: "TEXT", notnull: 1 }),
    ])
    const tableSql = String((migrated.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='support_thread_notifications'`).get() as { sql: string }).sql)
    expect(tableSql).toMatch(/CHECK\s*\(\s*input_revision\s*>=\s*1\s*\)/u)
    expect(tableSql).toMatch(/CHECK\s*\(\s*kind\s+IN\s*\('progress','timeout_operator','timeout_alert'\)\s*\)/u)
    expect(tableSql).toMatch(/CHECK\s*\(\s*status\s+IN\s*\('pending','sending','sent','failed','unknown'\)\s*\)/u)
    const indexes = migrated.prepare("PRAGMA index_list(support_thread_notifications)").all() as Array<{
      name: string; unique: number
    }>
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "support_thread_notifications_due_idx", unique: 0 }),
    ]))
    expect(indexes.some((index) => index.unique === 1 && JSON.stringify(
      (migrated.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{ name: string }>).map((column) => column.name),
    ) === JSON.stringify(["thread_id", "input_revision", "kind"]))).toBe(true)
    expect(migrated.prepare("PRAGMA foreign_key_list(support_thread_notifications)").all()).toEqual([
      expect.objectContaining({ from: "thread_id", table: "support_threads", to: "id", on_delete: "CASCADE" }),
    ])

    const notification = new SupportThreadStore(migrated, new ConfiguredSecretRedactor(migrated))
      .claimProgressNotification(threadId, 1, "scheduled_progress", now, now)
    expect(notification).toMatchObject({ threadId, inputRevision: 1, kind: "progress", status: "pending" })
    expect(() => migrated.prepare(`INSERT INTO support_thread_notifications(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), threadId, 1, "progress", "pending", now, null, null, now, now,
    )).toThrow(/UNIQUE/u)
  })

  it("v32 notification 缺必填语义列且已有历史行时事务回滚并 fail closed", async () => {
    const filePath = await databasePath("thread-output-v32-unsafe-notification-")
    const source = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(source)
    const threadId = seedThread(source, catalog)
    const notificationId = seedNotification(source, threadId, "sent")
    source.close()
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE support_thread_output_claims;
      CREATE TABLE support_thread_notifications_v32_partial (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        input_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT NOT NULL,
        telegram_message_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id,input_revision)
      );
      INSERT INTO support_thread_notifications_v32_partial(
        id,thread_id,input_revision,status,due_at,telegram_message_id,error_message,created_at,updated_at
      ) SELECT id,thread_id,input_revision,status,due_at,telegram_message_id,error_message,created_at,updated_at
        FROM support_thread_notifications;
      DROP TABLE support_thread_notifications;
      ALTER TABLE support_thread_notifications_v32_partial RENAME TO support_thread_notifications;
      CREATE INDEX support_thread_notifications_due_idx
        ON support_thread_notifications(status,due_at,id);
      UPDATE metadata SET value='32' WHERE key='schema_version';
      PRAGMA foreign_keys=ON;`)
    legacy.close()

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/历史数据无法无损升级/u)
    const rolledBack = new DatabaseSync(filePath, { readOnly: true })
    expect(rolledBack.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: "32" })
    expect(rolledBack.prepare("SELECT id FROM support_thread_notifications").all()).toEqual([{ id: notificationId }])
    expect(rolledBack.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='support_thread_output_claims'`).get()).toBeUndefined()
    rolledBack.close()
  })

  it("v32 notification 孤儿行在定向外键检查失败后完整回滚", async () => {
    const filePath = await databasePath("thread-output-v32-orphan-notification-")
    const source = await RuntimeDatabase.open(filePath)
    source.close()
    downgradeNotificationsToConstraintlessV32(filePath, "missing-thread")
    const before = new DatabaseSync(filePath, { readOnly: true })
    const tableSql = before.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='support_thread_notifications'`).get()
    const orphanRows = before.prepare("SELECT * FROM support_thread_notifications").all()
    before.close()

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/线程语义输出所有权外键关系损坏/u)
    const rolledBack = new DatabaseSync(filePath, { readOnly: true })
    expect(rolledBack.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: "32" })
    expect(rolledBack.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='support_thread_notifications'`).get()).toEqual(tableSql)
    expect(rolledBack.prepare("SELECT * FROM support_thread_notifications").all()).toEqual(orphanRows)
    expect(rolledBack.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='support_thread_output_claims'`).get()).toBeUndefined()
    rolledBack.close()
  })

  it("v32 合法历史 notification 无损重建后仍可领取新线程 progress", async () => {
    const filePath = await databasePath("thread-output-v32-valid-notification-")
    const source = await RuntimeDatabase.open(filePath)
    const catalog = seedCatalog(source)
    const historicalThreadId = seedThread(source, catalog)
    const notificationId = seedNotification(source, historicalThreadId, "sent")
    const claimableThreadId = seedThread(source, catalog)
    const historicalRow = source.prepare("SELECT * FROM support_thread_notifications WHERE id=?").get(notificationId)
    source.close()
    downgradeNotificationsToConstraintlessV32(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)
    expect(migrated.schemaVersion()).toBe(34)
    expect(migrated.prepare("SELECT * FROM support_thread_notifications WHERE id=?").get(notificationId))
      .toEqual(historicalRow)
    expect(migrated.prepare("PRAGMA foreign_key_check(support_thread_notifications)").all()).toEqual([])
    expect(new SupportThreadStore(migrated, new ConfiguredSecretRedactor(migrated)).claimProgressNotification(
      claimableThreadId,
      1,
      "scheduled_progress",
      now,
      now,
    )).toMatchObject({ threadId: claimableThreadId, inputRevision: 1, status: "pending" })
  })

  it("BackupService.import 将缺 claims 的 v32 portable 历史完整回填", async () => {
    const portablePath = await databasePath("thread-output-v32-import-source-", "portable.sqlite")
    const source = await RuntimeDatabase.open(portablePath)
    const catalog = seedCatalog(source)
    const notificationThread = seedThread(source, catalog)
    const notificationId = seedNotification(source, notificationThread, "sent")
    const humanThread = seedThread(source, catalog, { humanPriorityMessageId: "102" })
    const humanOwnershipId = seedOwnership(source, catalog, {
      threadId: humanThread,
      outputKind: "mention_claim_progress",
      status: "sent",
      telegramMessageId: "102",
    })
    const statusThread = seedThread(source, catalog)
    const statusReply = seedReply(source, catalog, statusThread, {
      createdAt: "2026-08-28T00:01:00.000Z",
      status: "replied",
    })
    source.prepare("UPDATE support_replies SET decision='reply' WHERE id=?").run(statusReply)
    const statusOwnershipId = seedOwnership(source, catalog, {
      threadId: statusThread,
      outputKind: "progress",
      status: "unknown",
      replyId: statusReply,
    })
    const singleHandoffThread = seedThread(source, catalog)
    const singleHandoffReply = seedReply(source, catalog, singleHandoffThread, {
      createdAt: "2026-08-28T00:02:00.000Z",
      errorCode: "answer_hard_deadline",
    })
    const duplicateHandoffThread = seedThread(source, catalog)
    const earliestReply = seedReply(source, catalog, duplicateHandoffThread, {
      createdAt: "2026-08-28T00:03:00.000Z",
      errorCode: "feature_request_prepared",
    })
    seedReply(source, catalog, duplicateHandoffThread, {
      createdAt: "2026-08-28T00:04:00.000Z",
      status: "escalated",
    })
    source.close()
    downgradeToV32(portablePath)

    const restored = await RuntimeDatabase.open(await databasePath("thread-output-v32-import-target-"))
    openDatabases.push(restored)
    await new BackupService(restored).import(portablePath)

    expect(restored.prepare(`SELECT thread_id,claim_kind,source_kind,reply_id,notification_id
      FROM support_thread_output_claims ORDER BY thread_id,claim_kind`).all()).toEqual(expect.arrayContaining([
      { thread_id: notificationThread, claim_kind: "progress", source_kind: "scheduled_progress", reply_id: null, notification_id: notificationId },
      { thread_id: humanThread, claim_kind: "progress", source_kind: "human_priority", reply_id: null, notification_id: expect.any(String) },
      { thread_id: statusThread, claim_kind: "progress", source_kind: "status_request", reply_id: null, notification_id: expect.any(String) },
      { thread_id: singleHandoffThread, claim_kind: "handoff", source_kind: "hard_deadline", reply_id: singleHandoffReply, notification_id: null },
      { thread_id: duplicateHandoffThread, claim_kind: "handoff", source_kind: "feature_request", reply_id: earliestReply, notification_id: null },
    ]))
    expect(restored.prepare("SELECT notification_id FROM telegram_output_ownership WHERE id=?").get(humanOwnershipId))
      .toEqual({ notification_id: expect.any(String) })
    expect(restored.prepare("SELECT notification_id FROM telegram_output_ownership WHERE id=?").get(statusOwnershipId))
      .toEqual({ notification_id: expect.any(String) })
  })

  it("BackupService.import 按完整约束接受 schema_version 32 的 claims 并行谱系", async () => {
    const portablePath = await databasePath("thread-output-v32-complete-lineage-", "portable.sqlite")
    const source = await RuntimeDatabase.open(portablePath)
    const catalog = seedCatalog(source)
    const threadId = seedThread(source, catalog)
    const notificationId = seedNotification(source, threadId, "sent")
    source.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(threadId, "progress", "scheduled_progress", null, notificationId, now, now)
    source.close()
    downgradeNotificationsToV33(portablePath)
    const legacy = new DatabaseSync(portablePath)
    legacy.prepare("UPDATE metadata SET value='32' WHERE key='schema_version'").run()
    legacy.close()

    const restored = await RuntimeDatabase.open(await databasePath("thread-output-v32-complete-target-"))
    openDatabases.push(restored)
    await new BackupService(restored).import(portablePath)

    expect(restored.prepare(`SELECT thread_id,source_kind,notification_id
      FROM support_thread_output_claims`).all()).toEqual([{
      thread_id: threadId,
      source_kind: "scheduled_progress",
      notification_id: notificationId,
    }])
  })

  it("BackupService.import 拒绝 schema_version 32 的残缺 claims 同名表", async () => {
    const portablePath = await databasePath("thread-output-v32-partial-lineage-", "portable.sqlite")
    const source = await RuntimeDatabase.open(portablePath)
    source.close()
    const forged = new DatabaseSync(portablePath)
    forged.exec(`DROP TABLE support_thread_output_claims;
      CREATE TABLE support_thread_output_claims(thread_id TEXT PRIMARY KEY, claim_kind TEXT NOT NULL);
      UPDATE metadata SET value='32' WHERE key='schema_version';`)
    forged.close()
    const restored = await RuntimeDatabase.open(await databasePath("thread-output-v32-partial-target-"))
    openDatabases.push(restored)

    await expect(new BackupService(restored).import(portablePath))
      .rejects.toThrow(/线程语义输出所有权结构不完整/)
  })

  it("portable export/import 保留 progress 与 handoff claim", async () => {
    const source = await RuntimeDatabase.open(await databasePath("thread-output-export-source-"))
    const restored = await RuntimeDatabase.open(await databasePath("thread-output-export-target-"))
    openDatabases.push(source, restored)
    const catalog = seedCatalog(source)
    const progressThread = seedThread(source, catalog)
    const handoffThread = seedThread(source, catalog)
    const notificationId = seedNotification(source, progressThread, "sent")
    source.prepare("UPDATE support_thread_notifications SET outbound_text=? WHERE id=?").run("稍等", notificationId)
    const replyId = seedReply(source, catalog, handoffThread, { createdAt: now, status: "escalated" })
    source.prepare(`INSERT INTO support_thread_output_claims(
      thread_id,claim_kind,source_kind,reply_id,notification_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?)`).run(
      progressThread, "progress", "scheduled_progress", null, notificationId, now, now,
      handoffThread, "handoff", "technical_change", replyId, null, now, now,
    )
    const portablePath = await databasePath("thread-output-export-file-", "portable.sqlite")
    await new BackupService(source).export(portablePath)
    await new BackupService(restored).import(portablePath)

    expect(restored.prepare(`SELECT thread_id,claim_kind,source_kind,reply_id,notification_id
      FROM support_thread_output_claims ORDER BY claim_kind`).all()).toEqual([
      { thread_id: handoffThread, claim_kind: "handoff", source_kind: "technical_change", reply_id: replyId, notification_id: null },
      { thread_id: progressThread, claim_kind: "progress", source_kind: "scheduled_progress", reply_id: null, notification_id: notificationId },
    ])
    expect(restored.prepare("SELECT outbound_text FROM support_thread_notifications WHERE id=?").get(notificationId))
      .toEqual({ outbound_text: "稍等" })
  })

  it("portable export 扫描 notification 的真实出站文本并拒绝敏感值", async () => {
    const source = await RuntimeDatabase.open(await databasePath("thread-output-sensitive-source-"))
    openDatabases.push(source)
    const catalog = seedCatalog(source)
    const threadId = seedThread(source, catalog)
    const notificationId = seedNotification(source, threadId, "sent")
    source.prepare("UPDATE support_thread_notifications SET outbound_text=? WHERE id=?")
      .run("password=do-not-export", notificationId)

    await expect(new BackupService(source).export(
      await databasePath("thread-output-sensitive-export-", "portable.sqlite"),
    )).rejects.toThrow(/迁移数据库包含敏感信息/)
  })
})
