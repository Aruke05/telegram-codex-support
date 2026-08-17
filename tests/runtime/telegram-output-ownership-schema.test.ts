import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const directories: string[] = []
const databases: RuntimeDatabase[] = []

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function databasePath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-output-schema-"))
  directories.push(directory)
  return path.join(directory, name)
}

async function open(filePath: string): Promise<RuntimeDatabase> {
  const database = await RuntimeDatabase.open(filePath)
  databases.push(database)
  return database
}

function seedAccount(database: RuntimeDatabase, id = randomUUID()): string {
  const timestamp = "2026-08-12T00:00:00.000Z"
  database.insertAccount({
    id,
    name: `账号 ${id.slice(0, 4)}`,
    type: "user",
    enabled: true,
    status: "ready",
    statusMessage: "",
    credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
    botUsername: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  return id
}

function insertOwnership(database: RuntimeDatabase, input: {
  id?: string
  accountId: string
  chatId: string
  messageId?: string | null
  requestKey?: string
}): void {
  const timestamp = "2026-08-12T00:00:00.000Z"
  database.prepare(`INSERT INTO telegram_output_ownership(
    id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
    notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.id ?? randomUUID(), input.accountId, null, input.chatId, input.messageId ?? null, null, null, null,
    null, "other", input.messageId ? "sent" : "sending", input.requestKey ?? randomUUID(), "a".repeat(64),
    null, timestamp, timestamp,
  )
}

type RegistryMutation = {
  ownershipSql?: (sql: string) => string
  candidateSql?: (sql: string) => string
  omitIndex?: string
  indexSql?: (name: string, sql: string) => string
}

function downgradeTerminalAuditToV22(filePath: string): void {
  const database = new DatabaseSync(filePath)
  database.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    DROP TABLE reference_learning_results;
    ALTER TABLE learning_source_observations DROP COLUMN current_run_id;
    UPDATE metadata SET value='22' WHERE key='schema_version';
    COMMIT;
    PRAGMA foreign_keys=ON;`)
  database.close()
}

function rebuildRegistry(filePath: string, mutation: RegistryMutation): void {
  const database = new DatabaseSync(filePath)
  const ownershipSql = String((database.prepare(`SELECT sql FROM sqlite_master
    WHERE type='table' AND name='telegram_output_ownership'`).get() as { sql: string }).sql)
  const candidateSql = String((database.prepare(`SELECT sql FROM sqlite_master
    WHERE type='table' AND name='telegram_outgoing_candidates'`).get() as { sql: string }).sql)
  const indexes = (database.prepare(`SELECT name,sql FROM sqlite_master WHERE type='index'
    AND tbl_name IN ('telegram_output_ownership','telegram_outgoing_candidates') AND sql IS NOT NULL
    ORDER BY tbl_name,name`).all() as Array<{ name: string; sql: string }>)
    .filter((index) => index.name !== mutation.omitIndex)
  database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; DROP TABLE telegram_outgoing_candidates; DROP TABLE telegram_output_ownership;")
  database.exec(mutation.ownershipSql?.(ownershipSql) ?? ownershipSql)
  indexes.filter((index) => index.sql.includes("telegram_output_ownership"))
    .forEach((index) => database.exec(mutation.indexSql?.(index.name, index.sql) ?? index.sql))
  database.exec(mutation.candidateSql?.(candidateSql) ?? candidateSql)
  indexes.filter((index) => index.sql.includes("telegram_outgoing_candidates"))
    .forEach((index) => database.exec(mutation.indexSql?.(index.name, index.sql) ?? index.sql))
  database.exec("COMMIT; PRAGMA foreign_keys=ON;")
  database.close()
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

describe("Telegram 输出所有权 v22 能力", () => {
  it("fresh 数据库建立持久 ownership 状态机、反向索引与精确 message-id 唯一约束", async () => {
    const database = await open(await databasePath("fresh.sqlite"))

    expect(database.schemaVersion()).toBe(27)
    const columns = database.prepare("PRAGMA table_info(telegram_output_ownership)").all() as Array<{
      name: string
      notnull: number
    }>
    expect(columns.map((column) => column.name)).toEqual([
      "id", "account_id", "delivery_group_id", "telegram_chat_id", "telegram_message_id", "thread_id",
      "service_id", "reply_id", "notification_id", "output_kind", "delivery_status", "request_key",
      "content_sha256", "reply_to_message_id", "created_at", "updated_at",
    ])
    expect(columns.find((column) => column.name === "account_id")?.notnull).toBe(0)
    expect(columns.find((column) => column.name === "telegram_chat_id")?.notnull).toBe(1)
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE type='index'
      AND tbl_name='telegram_output_ownership' ORDER BY name`).all()).toEqual(expect.arrayContaining([
      { name: "telegram_output_ownership_message_unique_idx" },
      { name: "telegram_output_ownership_group_message_unique_idx" },
      { name: "telegram_output_ownership_pending_idx" },
      { name: "telegram_output_ownership_retention_idx" },
      { name: "telegram_output_ownership_thread_status_idx" },
    ]))
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE type='index'
      AND tbl_name='telegram_outgoing_candidates' ORDER BY name`).all()).toEqual(expect.arrayContaining([
      { name: "telegram_outgoing_candidates_owner_message_unique_idx" },
      { name: "telegram_outgoing_candidates_resolution_idx" },
    ]))
    expect(database.prepare("PRAGMA foreign_key_list(telegram_outgoing_candidates)").all()).toEqual([
      expect.objectContaining({
        table: "telegram_output_ownership",
        from: "ownership_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    ])

    const firstAccount = seedAccount(database)
    const secondAccount = seedAccount(database)
    insertOwnership(database, { accountId: firstAccount, chatId: "-10001", messageId: "51" })
    expect(() => insertOwnership(database, { accountId: firstAccount, chatId: "-10001", messageId: "51" }))
      .toThrow(/UNIQUE/u)
    expect(() => insertOwnership(database, { accountId: firstAccount, chatId: "-10002", messageId: "51" }))
      .not.toThrow()
    expect(() => insertOwnership(database, { accountId: secondAccount, chatId: "-10001", messageId: "51" }))
      .not.toThrow()
  })

  it("真实 v21 能力经 v22 升级到 v23，普通与 portable 打开路径都补齐 registry", async () => {
    const runtimePath = await databasePath("runtime-v21.sqlite")
    const runtimeV21 = await open(runtimePath)
    runtimeV21.prepare("DROP TABLE reference_learning_results").run()
    runtimeV21.prepare("ALTER TABLE learning_source_observations DROP COLUMN current_run_id").run()
    runtimeV21.prepare("DROP TABLE IF EXISTS telegram_outgoing_candidates").run()
    runtimeV21.prepare("DROP TABLE IF EXISTS telegram_output_ownership").run()
    runtimeV21.prepare("UPDATE metadata SET value='21' WHERE key='schema_version'").run()
    runtimeV21.close()
    databases.splice(databases.indexOf(runtimeV21), 1)

    const migrated = await open(runtimePath)
    expect(migrated.schemaVersion()).toBe(27)
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership").get()).toEqual({ count: 0 })
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM telegram_outgoing_candidates").get()).toEqual({ count: 0 })

    const portablePath = await databasePath("portable-v21.sqlite")
    const portableV21 = await open(portablePath)
    portableV21.prepare("DROP TABLE reference_learning_results").run()
    portableV21.prepare("ALTER TABLE learning_source_observations DROP COLUMN current_run_id").run()
    portableV21.prepare("DROP TABLE IF EXISTS telegram_outgoing_candidates").run()
    portableV21.prepare("DROP TABLE IF EXISTS telegram_output_ownership").run()
    portableV21.prepare("UPDATE metadata SET value='21' WHERE key='schema_version'").run()
    portableV21.close()
    databases.splice(databases.indexOf(portableV21), 1)

    const portable = RuntimeDatabase.openPortable(portablePath)
    databases.push(portable)
    expect(portable.schemaVersion()).toBe(27)
    expect(portable.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership").get()).toEqual({ count: 0 })
    expect(portable.prepare("SELECT COUNT(*) AS count FROM telegram_outgoing_candidates").get()).toEqual({ count: 0 })
  })

  it("同号 v23 缺 registry 时 fail closed 而不是静默当成完整结构", async () => {
    const filePath = await databasePath("invalid-v23.sqlite")
    const database = await open(filePath)
    database.prepare("DROP TABLE IF EXISTS telegram_outgoing_candidates").run()
    database.prepare("DROP TABLE IF EXISTS telegram_output_ownership").run()
    database.prepare("UPDATE metadata SET value='23' WHERE key='schema_version'").run()
    database.close()
    databases.splice(databases.indexOf(database), 1)

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/Telegram 输出所有权结构不完整/u)
  })

  it("同号 v23 的同名错误唯一索引 fail closed", async () => {
    const filePath = await databasePath("invalid-v22-index.sqlite")
    const database = await open(filePath)
    database.prepare("DROP INDEX telegram_output_ownership_message_unique_idx").run()
    database.prepare(`CREATE INDEX telegram_output_ownership_message_unique_idx
      ON telegram_output_ownership(created_at) WHERE telegram_message_id IS NOT NULL`).run()
    database.close()
    databases.splice(databases.indexOf(database), 1)

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/Telegram 输出所有权结构不完整/u)
  })

  it("同号 v23 的 request_key partial unique 不能冒充全表唯一约束", async () => {
    const filePath = await databasePath("invalid-v22-request-key.sqlite")
    const database = await open(filePath)
    const tableSql = String((database.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='telegram_output_ownership'`).get() as { sql: string }).sql)
      .replace("request_key TEXT NOT NULL UNIQUE", "request_key TEXT NOT NULL")
    const indexSql = (database.prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND tbl_name='telegram_output_ownership' AND sql IS NOT NULL`).all() as Array<{ sql: string }>)
      .map((row) => row.sql)
    database.connection.exec("PRAGMA foreign_keys=OFF; DROP TABLE telegram_output_ownership;")
    database.connection.exec(tableSql)
    indexSql.forEach((sql) => database.connection.exec(sql))
    database.connection.exec(`CREATE UNIQUE INDEX telegram_output_ownership_request_key_partial_idx
      ON telegram_output_ownership(request_key) WHERE delivery_status='sent'; PRAGMA foreign_keys=ON;`)
    database.close()
    databases.splice(databases.indexOf(database), 1)

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/Telegram 输出所有权结构不完整/u)
  })

  it("同号 v22 缺 ownership 外键时 fail closed", async () => {
    const filePath = await databasePath("invalid-v22-fk.sqlite")
    const database = await open(filePath)
    const tableSql = String((database.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='telegram_output_ownership'`).get() as { sql: string }).sql)
      .replace(" REFERENCES telegram_accounts(id) ON DELETE SET NULL", "")
      .replace(" REFERENCES telegram_groups(id) ON DELETE CASCADE", "")
      .replace(" REFERENCES support_threads(id) ON DELETE CASCADE", "")
      .replace(" REFERENCES project_services(id) ON DELETE SET NULL", "")
      .replace(" REFERENCES support_replies(id) ON DELETE CASCADE", "")
      .replace(" REFERENCES support_thread_notifications(id) ON DELETE CASCADE", "")
    const indexSql = (database.prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND tbl_name='telegram_output_ownership' AND sql IS NOT NULL`).all() as Array<{ sql: string }>)
      .map((row) => row.sql)
    database.connection.exec("PRAGMA foreign_keys=OFF; DROP TABLE telegram_output_ownership;")
    database.connection.exec(tableSql)
    indexSql.forEach((sql) => database.connection.exec(sql))
    database.connection.exec("PRAGMA foreign_keys=ON")
    database.close()
    databases.splice(databases.indexOf(database), 1)

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/Telegram 输出所有权结构不完整/u)
  })

  it.each([
    {
      label: "缺 ownership/candidate 表",
      mutate: (filePath: string) => {
        const database = new DatabaseSync(filePath)
        database.exec("PRAGMA foreign_keys=OFF; DROP TABLE telegram_outgoing_candidates; DROP TABLE telegram_output_ownership; PRAGMA foreign_keys=ON;")
        database.close()
      },
    },
    {
      label: "缺 candidate 表",
      mutate: (filePath: string) => {
        const database = new DatabaseSync(filePath)
        database.exec("DROP TABLE telegram_outgoing_candidates")
        database.close()
      },
    },
    {
      label: "弱化 delivery status CHECK",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace(
          "CHECK(delivery_status IN ('sending','sent','failed','unknown'))",
          "CHECK(delivery_status IN ('sending','sent','failed','unknown') OR delivery_status='forged')",
        ),
      }),
    },
    {
      label: "用注释伪造 delivery status CHECK",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace(
          "CHECK(delivery_status IN ('sending','sent','failed','unknown'))",
          "/* CHECK(delivery_status IN ('sending','sent','failed','unknown')) */",
        ),
      }),
    },
    {
      label: "篡改 delivery status 字面量空格",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace("'sending','sent'", "'send ing','sent'"),
      }),
    },
    {
      label: "弱化 candidate resolution CHECK",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        candidateSql: (sql) => sql.replace(
          "CHECK(resolution_status IN ('pending','application','manual','unknown'))",
          "CHECK(resolution_status IN ('pending','application','manual','unknown') OR resolution_status='forged')",
        ),
      }),
    },
    {
      label: "缺 output_kind 列",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace(
          "  output_kind TEXT NOT NULL CHECK(length(output_kind) BETWEEN 1 AND 80),\n",
          "",
        ),
      }),
    },
    {
      label: "缺 account 外键",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace(" REFERENCES telegram_accounts(id) ON DELETE SET NULL", ""),
      }),
    },
    {
      label: "缺 candidate 外键",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        candidateSql: (sql) => sql.replace(" REFERENCES telegram_output_ownership(id) ON DELETE CASCADE", ""),
      }),
    },
    {
      label: "缺 pending 索引",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        omitIndex: "telegram_output_ownership_pending_idx",
      }),
    },
    {
      label: "惰化 pending 索引谓词",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        indexSql: (name, sql) => name === "telegram_output_ownership_pending_idx"
          ? sql.replace(
            "WHERE telegram_message_id IS NULL AND delivery_status IN ('sending','unknown')",
            "WHERE 0 AND telegram_message_id IS NULL AND delivery_status IN ('sending','unknown')",
          )
          : sql,
      }),
    },
    {
      label: "篡改 pending 索引排序",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        indexSql: (name, sql) => name === "telegram_output_ownership_pending_idx"
          ? sql.replace("reply_to_message_id,created_at,id", "reply_to_message_id,created_at DESC,id")
          : sql,
      }),
    },
    {
      label: "缺 candidate resolution 索引",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        omitIndex: "telegram_outgoing_candidates_resolution_idx",
      }),
    },
    {
      label: "额外 ownership UNIQUE 索引",
      mutate: (filePath: string) => {
        const database = new DatabaseSync(filePath)
        database.exec("CREATE UNIQUE INDEX forged_extra_idx ON telegram_output_ownership(telegram_chat_id)")
        database.close()
      },
    },
  ])("metadata=v22 但 registry $label 时在首条 v23 DDL 前 fail closed", async ({ mutate }) => {
    const filePath = await databasePath("malformed-v22-before-migration.sqlite")
    const source = await open(filePath)
    source.close()
    databases.splice(databases.indexOf(source), 1)
    downgradeTerminalAuditToV22(filePath)
    mutate(filePath)

    const error = await captureRuntimeOpen(filePath)
    const unchanged = new DatabaseSync(filePath)
    const version = unchanged.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()
    const observationColumns = unchanged.prepare("PRAGMA table_info(learning_source_observations)").all() as Array<{ name: string }>
    const resultTable = unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_learning_results'").get()
    unchanged.close()

    expect(error).toEqual(expect.objectContaining({ message: expect.stringMatching(/Telegram 输出所有权结构不完整/u) }))
    expect(version).toEqual({ value: "22" })
    expect(observationColumns.some((column) => column.name === "current_run_id")).toBe(false)
    expect(resultTable).toBeUndefined()
  })

  it.each([
    {
      label: "ownership output_kind CHECK",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace(
          "CHECK(length(output_kind) BETWEEN 1 AND 80)",
          "CHECK(length(output_kind) BETWEEN 1 AND 80 OR output_kind='')",
        ),
      }),
    },
    {
      label: "ownership delivery_status CHECK",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace(
          "CHECK(delivery_status IN ('sending','sent','failed','unknown'))",
          "CHECK(delivery_status IN ('sending','sent','failed','unknown') OR delivery_status='forged')",
        ),
      }),
    },
    {
      label: "candidate resolution_status CHECK",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        candidateSql: (sql) => sql.replace(
          "CHECK(resolution_status IN ('pending','application','manual','unknown'))",
          "CHECK(resolution_status IN ('pending','application','manual','unknown') OR resolution_status='forged')",
        ),
      }),
    },
    {
      label: "ownership 列类型",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace("telegram_chat_id TEXT NOT NULL", "telegram_chat_id BLOB NOT NULL"),
      }),
    },
    {
      label: "ownership 主键",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        ownershipSql: (sql) => sql.replace("id TEXT PRIMARY KEY", "id TEXT"),
      }),
    },
    {
      label: "candidate NOT NULL",
      mutate: (filePath: string) => rebuildRegistry(filePath, {
        candidateSql: (sql) => sql.replace("telegram_message_id TEXT NOT NULL", "telegram_message_id TEXT"),
      }),
    },
  ])("同号 v23 拒绝扩张的 $label，且 portable 共用同一结构门", async ({ mutate }) => {
    const runtimePath = await databasePath("forged-v23-runtime.sqlite")
    const runtime = await open(runtimePath)
    runtime.close()
    databases.splice(databases.indexOf(runtime), 1)
    mutate(runtimePath)
    expect(await captureRuntimeOpen(runtimePath)).toEqual(expect.objectContaining({
      message: expect.stringMatching(/Telegram 输出所有权结构不完整/u),
    }))

    const portablePath = await databasePath("forged-v23-portable.sqlite")
    const portable = await open(portablePath)
    portable.close()
    databases.splice(databases.indexOf(portable), 1)
    mutate(portablePath)
    const restored = await open(await databasePath("forged-v23-restored.sqlite"))
    restored.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      randomUUID(), "keep", "保留", "", 1, "default", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    await expect(new BackupService(restored).import(portablePath)).rejects.toThrow(/Telegram 输出所有权结构不完整/u)
    expect(restored.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }])
  })

  it.each([
    { table: "telegram_output_ownership", column: "delivery_status" },
    { table: "telegram_outgoing_candidates", column: "resolution_status" },
  ])("同号 v23 即使绕过 CHECK 写入 $table forged 状态也 fail closed", async ({ table, column }) => {
    const filePath = await databasePath("forged-row-v23.sqlite")
    const source = await open(filePath)
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(
      randomUUID(), ownershipId, "802", "pending", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    source.close()
    databases.splice(databases.indexOf(source), 1)
    const malformed = new DatabaseSync(filePath)
    malformed.exec("PRAGMA ignore_check_constraints=ON")
    malformed.prepare(`UPDATE ${table} SET ${column}='forged'`).run()
    malformed.exec("PRAGMA ignore_check_constraints=OFF")
    malformed.close()

    expect(await captureRuntimeOpen(filePath)).toEqual(expect.objectContaining({
      message: expect.stringMatching(/Telegram 输出所有权行格式错误/u),
    }))
  })

  it("合法有行 v22 registry 在首 DDL 门后迁移到 v23 并保留 ownership/candidate", async () => {
    const filePath = await databasePath("valid-v22-with-rows.sqlite")
    const source = await open(filePath)
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    const candidateId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(
      candidateId, ownershipId, "802", "pending", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    source.close()
    databases.splice(databases.indexOf(source), 1)
    downgradeTerminalAuditToV22(filePath)

    const migrated = await open(filePath)
    expect(migrated.schemaVersion()).toBe(27)
    expect(migrated.prepare("SELECT delivery_status FROM telegram_output_ownership WHERE id=?").get(ownershipId))
      .toEqual({ delivery_status: "sending" })
    expect(migrated.prepare("SELECT resolution_status FROM telegram_outgoing_candidates WHERE id=?").get(candidateId))
      .toEqual({ resolution_status: "pending" })
  })

  it("portable export 克隆后拒绝 ownership/candidate 非法 datetime", async () => {
    const source = await open(await databasePath("invalid-row-export-source.sqlite"))
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(randomUUID(), ownershipId, "802", "pending", "zzzz", "zzzz")
    source.prepare("UPDATE telegram_output_ownership SET created_at='zzzz',updated_at='zzzz' WHERE id=?").run(ownershipId)

    await expect(new BackupService(source).export(await databasePath("invalid-row-export.sqlite")))
      .rejects.toThrow(/Telegram 输出所有权行格式错误/u)
  })

  it("portable export 拒绝会被毫秒解析截断的反序纳秒时间", async () => {
    const source = await open(await databasePath("sub-millisecond-order-export-source.sqlite"))
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.prepare(`UPDATE telegram_output_ownership SET created_at=?,updated_at=? WHERE id=?`).run(
      "2026-08-12T00:00:00.000000001Z",
      "2026-08-12T00:00:00.000000000Z",
      ownershipId,
    )

    await expect(new BackupService(source).export(await databasePath("sub-millisecond-order-export.sqlite")))
      .rejects.toThrow(/Telegram 输出所有权行格式错误/u)
  })

  it("portable export 克隆后拒绝被 foreign_keys=OFF 注入的孤儿 candidate", async () => {
    const source = await open(await databasePath("orphan-candidate-export-source.sqlite"))
    source.connection.exec("PRAGMA foreign_keys=OFF")
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(
      randomUUID(), randomUUID(), "802", "unknown",
      "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    source.connection.exec("PRAGMA foreign_keys=ON")
    expect(source.prepare("PRAGMA foreign_key_check").all()).not.toEqual([])

    await expect(new BackupService(source).export(await databasePath("orphan-candidate-export.sqlite")))
      .rejects.toThrow(/Telegram 输出所有权候选关系损坏/u)
  })

  it("portable export 克隆归一化后拒绝 ownership 父表外键损坏", async () => {
    const source = await open(await databasePath("orphan-ownership-export-source.sqlite"))
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.connection.exec("PRAGMA foreign_keys=OFF")
    source.prepare("UPDATE telegram_output_ownership SET delivery_group_id=? WHERE id=?")
      .run(randomUUID(), ownershipId)
    source.connection.exec("PRAGMA foreign_keys=ON")
    expect(source.prepare("PRAGMA foreign_key_check").all()).not.toEqual([])

    await expect(new BackupService(source).export(await databasePath("orphan-ownership-export.sqlite")))
      .rejects.toThrow(/迁移数据库外键关系损坏/u)
  })

  it("portable import 在清空目标库前拒绝 zzzz ownership/candidate，不能绕过 90 天 retention", async () => {
    const source = await open(await databasePath("invalid-row-import-source.sqlite"))
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(
      randomUUID(), ownershipId, "802", "pending",
      "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    const portablePath = await databasePath("invalid-row-import.sqlite")
    await new BackupService(source).export(portablePath)
    const malformed = new DatabaseSync(portablePath)
    malformed.prepare("UPDATE telegram_output_ownership SET created_at='zzzz',updated_at='zzzz' WHERE id=?").run(ownershipId)
    malformed.prepare("UPDATE telegram_outgoing_candidates SET created_at='zzzz',updated_at='zzzz' WHERE ownership_id=?").run(ownershipId)
    malformed.close()

    const restored = await open(await databasePath("invalid-row-import-restored.sqlite"))
    restored.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      randomUUID(), "keep", "保留", "", 1, "default", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    await expect(new BackupService(restored).import(portablePath)).rejects.toThrow(/Telegram 输出所有权行格式错误/u)
    expect(restored.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }])
    expect(restored.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership").get()).toEqual({ count: 0 })
  })

  const invalidPortableRows: Array<{
    label: string
    mutate: (database: DatabaseSync, ownershipId: string, candidateId: string) => void
  }> = [
    {
      label: "ownership UUID",
      mutate: (database, ownershipId) => database.exec(`PRAGMA foreign_keys=OFF;
        UPDATE telegram_outgoing_candidates SET ownership_id='not-a-uuid' WHERE ownership_id='${ownershipId}';
        UPDATE telegram_output_ownership SET id='not-a-uuid' WHERE id='${ownershipId}';
        PRAGMA foreign_keys=ON;`),
    },
    {
      label: "request key UUID",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET request_key='not-a-uuid' WHERE id=?").run(ownershipId) },
    },
    {
      label: "digest",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET content_sha256=? WHERE id=?").run("g".repeat(64), ownershipId) },
    },
    {
      label: "output kind",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET output_kind='bad kind' WHERE id=?").run(ownershipId) },
    },
    {
      label: "delivery status",
      mutate: (database, ownershipId) => database.exec(`PRAGMA ignore_check_constraints=ON;
        UPDATE telegram_output_ownership SET delivery_status='forged' WHERE id='${ownershipId}';
        PRAGMA ignore_check_constraints=OFF;`),
    },
    {
      label: "chat ID",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET telegram_chat_id='0' WHERE id=?").run(ownershipId) },
    },
    {
      label: "message ID",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET delivery_status='sent',telegram_message_id='0' WHERE id=?").run(ownershipId) },
    },
    {
      label: "reply message ID",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET reply_to_message_id='0' WHERE id=?").run(ownershipId) },
    },
    {
      label: "ownership time order",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_output_ownership SET created_at='2026-08-13T00:00:00.000Z' WHERE id=?").run(ownershipId) },
    },
    {
      label: "candidate UUID",
      mutate: (database, _ownershipId, candidateId) => { database.prepare("UPDATE telegram_outgoing_candidates SET id='not-a-uuid' WHERE id=?").run(candidateId) },
    },
    {
      label: "candidate message ID",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_outgoing_candidates SET telegram_message_id='0' WHERE ownership_id=?").run(ownershipId) },
    },
    {
      label: "candidate resolution status",
      mutate: (database, ownershipId) => database.exec(`PRAGMA ignore_check_constraints=ON;
        UPDATE telegram_outgoing_candidates SET resolution_status='forged' WHERE ownership_id='${ownershipId}';
        PRAGMA ignore_check_constraints=OFF;`),
    },
    {
      label: "candidate time order",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_outgoing_candidates SET created_at='2026-08-13T00:00:00.000Z' WHERE ownership_id=?").run(ownershipId) },
    },
    {
      label: "candidate foreign key",
      mutate: (database, ownershipId) => database.exec(`PRAGMA foreign_keys=OFF;
        UPDATE telegram_outgoing_candidates SET ownership_id='00000000-0000-4000-8000-999999999999'
          WHERE ownership_id='${ownershipId}';
        PRAGMA foreign_keys=ON;`),
    },
    {
      label: "candidate resolution semantics",
      mutate: (database, ownershipId) => { database.prepare("UPDATE telegram_outgoing_candidates SET resolution_status='application' WHERE ownership_id=?").run(ownershipId) },
    },
  ]

  it.each(invalidPortableRows)("portable import 清库前批量拒绝非法 $label 行", async ({ mutate }) => {
    const source = await open(await databasePath("row-matrix-source.sqlite"))
    const accountId = seedAccount(source)
    const ownershipId = randomUUID()
    const candidateId = randomUUID()
    insertOwnership(source, { id: ownershipId, accountId, chatId: "-10001", requestKey: randomUUID() })
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(
      candidateId, ownershipId, "802", "pending",
      "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    const portablePath = await databasePath("row-matrix-portable.sqlite")
    await new BackupService(source).export(portablePath)
    const malformed = new DatabaseSync(portablePath)
    mutate(malformed, ownershipId, candidateId)
    malformed.close()

    const restored = await open(await databasePath("row-matrix-restored.sqlite"))
    restored.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      randomUUID(), "keep", "保留", "", 1, "default", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z",
    )
    await expect(new BackupService(restored).import(portablePath)).rejects.toThrow(
      /Telegram 输出所有权行格式错误|Telegram 输出所有权候选关系损坏|迁移数据库外键关系损坏/u,
    )
    expect(restored.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }])
    expect(restored.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership").get()).toEqual({ count: 0 })
  })

  it("portable 保留反向 linkage，把 sending 恢复为 unknown 并在导入时重绑本地账号", async () => {
    const source = await open(await databasePath("portable-source.sqlite"))
    const timestamp = "2026-08-12T00:00:00.000Z"
    const sourceAccountId = seedAccount(source)
    const projectId = randomUUID()
    const serviceId = randomUUID()
    const groupId = randomUUID()
    const threadId = randomUUID()
    source.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "portable", "迁移项目", "", 1, "default", timestamp, timestamp)
    source.prepare(`INSERT INTO project_services(
      id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      serviceId, projectId, "portable-service", "迁移服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
    )
    source.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      groupId, "portable-group", "迁移群", "-10001", sourceAccountId, projectId, serviceId, 1, "user", "all",
      "telegram", "[]", null, null, "database", "default", "support", timestamp, timestamp,
    )
    source.prepare(`INSERT INTO support_threads(
      id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      threadId, groupId, projectId, serviceId, "answered", 1, timestamp, "question-1", timestamp, "迁移线程", timestamp, timestamp,
    )
    const sentId = randomUUID()
    const sendingId = randomUUID()
    const candidateId = randomUUID()
    const insert = source.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    insert.run(
      sentId, sourceAccountId, groupId, "-10001", "801", threadId, serviceId, null, null,
      "support_reply", "sent", randomUUID(), "a".repeat(64), "800", timestamp, timestamp,
    )
    insert.run(
      sendingId, sourceAccountId, groupId, "-10001", null, threadId, serviceId, null, null,
      "progress", "sending", randomUUID(), "b".repeat(64), "800", timestamp, timestamp,
    )
    source.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(candidateId, sendingId, "802", "pending", timestamp, timestamp)
    const portablePath = await databasePath("portable.sqlite")

    await new BackupService(source).export(portablePath)

    const portable = RuntimeDatabase.openPortable(portablePath, true)
    databases.push(portable)
    expect(portable.prepare(`SELECT id,account_id,telegram_message_id,thread_id,service_id,delivery_status
      FROM telegram_output_ownership ORDER BY id`).all()).toEqual([
      { id: sentId, account_id: null, telegram_message_id: "801", thread_id: threadId, service_id: serviceId, delivery_status: "sent" },
      { id: sendingId, account_id: null, telegram_message_id: null, thread_id: threadId, service_id: serviceId, delivery_status: "unknown" },
    ].sort((left, right) => left.id.localeCompare(right.id)))
    expect(portable.prepare(`SELECT id,ownership_id,telegram_message_id,resolution_status
      FROM telegram_outgoing_candidates`).get()).toEqual({
      id: candidateId,
      ownership_id: sendingId,
      telegram_message_id: "802",
      resolution_status: "unknown",
    })

    const restored = await open(await databasePath("restored.sqlite"))
    const localAccountId = seedAccount(restored)
    await new BackupService(restored).import(portablePath)
    expect(restored.prepare(`SELECT id,account_id,delivery_group_id,telegram_message_id,thread_id,service_id,delivery_status
      FROM telegram_output_ownership ORDER BY id`).all()).toEqual([
      { id: sentId, account_id: localAccountId, delivery_group_id: groupId, telegram_message_id: "801", thread_id: threadId, service_id: serviceId, delivery_status: "sent" },
      { id: sendingId, account_id: localAccountId, delivery_group_id: groupId, telegram_message_id: null, thread_id: threadId, service_id: serviceId, delivery_status: "unknown" },
    ].sort((left, right) => left.id.localeCompare(right.id)))
    expect(restored.prepare(`SELECT id,ownership_id,telegram_message_id,resolution_status
      FROM telegram_outgoing_candidates`).get()).toEqual({
      id: candidateId,
      ownership_id: sendingId,
      telegram_message_id: "802",
      resolution_status: "unknown",
    })
  })

  it.each([20, 21] as const)("真实 v%s portable 无 registry 时按能力导入到 v22", async (version) => {
    const source = await open(await databasePath(`portable-v${version}-source.sqlite`))
    const portablePath = await databasePath(`portable-v${version}.sqlite`)
    await new BackupService(source).export(portablePath)
    const legacy = new DatabaseSync(portablePath)
    if (version === 20) {
      legacy.exec(`ALTER TABLE support_threads DROP COLUMN answer_include_magic_book;
        ALTER TABLE support_threads DROP COLUMN answer_include_interface_docs;
        ALTER TABLE support_threads DROP COLUMN answer_include_ai_memory;
        ALTER TABLE support_threads DROP COLUMN answer_binding_enabled;
        ALTER TABLE support_threads DROP COLUMN answer_max_concurrency;
        ALTER TABLE support_threads DROP COLUMN answer_timeout_seconds;
        ALTER TABLE support_threads DROP COLUMN answer_reply_style;
        ALTER TABLE support_threads DROP COLUMN answer_model_instance_id;`)
    }
    legacy.exec(`DROP TABLE reference_learning_results;
      ALTER TABLE learning_source_observations DROP COLUMN current_run_id;
      DROP TABLE telegram_outgoing_candidates;
      DROP TABLE telegram_output_ownership;
      UPDATE metadata SET value='${version}' WHERE key='schema_version';`)
    legacy.close()

    const restored = await open(await databasePath(`portable-v${version}-restored.sqlite`))
    await new BackupService(restored).import(portablePath)

    expect(restored.schemaVersion()).toBe(27)
    expect(restored.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership").get()).toEqual({ count: 0 })
    expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  })
})
