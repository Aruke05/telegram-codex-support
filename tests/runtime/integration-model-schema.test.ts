import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []
const answerModelId = "00000000-0000-4000-8000-000000000001"
const memoryModelId = "00000000-0000-4000-8000-000000000002"
const customModelId = "00000000-0000-4000-8000-000000000020"
const projectId = "00000000-0000-4000-8000-000000000021"
const serviceId = "00000000-0000-4000-8000-000000000022"
const groupId = "00000000-0000-4000-8000-000000000023"
const threadId = "00000000-0000-4000-8000-000000000024"

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDatabase(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "integration-model-schema-"))
  temporaryDirectories.push(directory)
  return path.join(directory, name)
}

function tableNames(database: RuntimeDatabase): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name)
}

function columnNames(database: RuntimeDatabase, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

function expectCombinedCapabilities(database: RuntimeDatabase): void {
  expect(database.schemaVersion()).toBe(32)
  expect(tableNames(database)).toEqual(expect.arrayContaining([
    "model_instances",
    "reply_generation_audits",
    "model_catalog_entries",
    "runtime_model_bindings",
    "learning_source_observations",
    "operator_style_versions",
    "operator_style_version_evidence",
    "support_reply_alert_deliveries",
    "telegram_output_ownership",
    "telegram_outgoing_candidates",
  ]))
  expect(columnNames(database, "telegram_groups")).toEqual(expect.arrayContaining([
    "ai_model_instance_id", "reply_style",
  ]))
  expect(columnNames(database, "support_threads")).toEqual(expect.arrayContaining([
    "operator_style_version_id", "operator_style_profile_json",
    "answer_model_instance_id", "answer_reply_style", "answer_timeout_seconds", "answer_max_concurrency",
    "answer_binding_enabled", "answer_include_ai_memory", "answer_include_interface_docs", "answer_include_magic_book",
  ]))
  expect(columnNames(database, "telegram_roles")).toContain("learning_source_enabled")
  expect(columnNames(database, "support_replies")).toEqual(expect.arrayContaining([
    "technical_alert_status", "operator_delivery_status",
  ]))
}

function seedRemoteModelConfiguration(database: RuntimeDatabase): void {
  const now = "2026-08-11T00:00:00.000Z"
  database.prepare(`INSERT INTO model_instances(
    id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
    enabled,health_status,health_message,last_checked_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    customModelId, "远端自定义回答模型", "openai", "codex_cli", "gpt-5.6-sol", "xhigh", "fast", "{}", null,
    1, "ready", "可用", now, now, now,
  )
  database.prepare(`UPDATE runtime_model_bindings SET model_instance_id=?,timeout_seconds=900,max_concurrency=3,
    enabled=1,updated_at=? WHERE purpose='answer'`).run(customModelId, now)
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "integration-project", "集成项目", "", 1, "default", now, now)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "integration-service", "集成服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,
    ai_model_instance_id,reply_style,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "integration-group", "集成群", null, null, projectId, serviceId, 0, "bot", "all",
    "telegram", "[]", null, null, "database", "default", "support",
    customModelId, "human", now, now,
  )
}

function downgradeToOursV19(filePath: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    DROP TABLE reference_learning_results;
    ALTER TABLE learning_source_observations DROP COLUMN current_run_id;
    ALTER TABLE support_threads DROP COLUMN answer_include_magic_book;
    ALTER TABLE support_threads DROP COLUMN answer_include_interface_docs;
    ALTER TABLE support_threads DROP COLUMN answer_include_ai_memory;
    ALTER TABLE support_threads DROP COLUMN answer_binding_enabled;
    ALTER TABLE support_threads DROP COLUMN answer_max_concurrency;
    ALTER TABLE support_threads DROP COLUMN answer_timeout_seconds;
    ALTER TABLE support_threads DROP COLUMN answer_reply_style;
    ALTER TABLE support_threads DROP COLUMN answer_model_instance_id;
    CREATE TABLE model_profiles (
      purpose TEXT PRIMARY KEY CHECK (purpose IN ('answer', 'memory')),
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('minimal','low','medium','high','xhigh')),
      timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 3600),
      max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 8),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    INSERT INTO model_profiles VALUES
      ('answer','gpt-5.4-sol','high',777,4,1,'2026-08-11T01:00:00.000Z'),
      ('memory','gpt-5.4-mini','minimal',88,2,0,'2026-08-11T01:00:00.000Z');
    ALTER TABLE telegram_groups DROP COLUMN reply_style;
    ALTER TABLE telegram_groups DROP COLUMN ai_model_instance_id;
    DROP TABLE runtime_model_bindings;
    DROP TABLE model_catalog_entries;
    DROP TABLE model_instances;
    UPDATE metadata SET value='19' WHERE key='schema_version';
    COMMIT;
    PRAGMA foreign_keys=ON;`)
  legacy.close()
}

function downgradeToRemoteV14(filePath: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    DROP TABLE reference_learning_results;
    ALTER TABLE support_threads DROP COLUMN answer_include_magic_book;
    ALTER TABLE support_threads DROP COLUMN answer_include_interface_docs;
    ALTER TABLE support_threads DROP COLUMN answer_include_ai_memory;
    ALTER TABLE support_threads DROP COLUMN answer_binding_enabled;
    ALTER TABLE support_threads DROP COLUMN answer_max_concurrency;
    ALTER TABLE support_threads DROP COLUMN answer_timeout_seconds;
    ALTER TABLE support_threads DROP COLUMN answer_reply_style;
    ALTER TABLE support_threads DROP COLUMN answer_model_instance_id;
    ALTER TABLE support_threads DROP COLUMN operator_style_profile_json;
    ALTER TABLE support_threads DROP COLUMN operator_style_version_id;
    DROP TABLE operator_style_version_evidence;
    DROP TABLE operator_style_versions;
    DROP TABLE learning_source_observations;
    ALTER TABLE telegram_roles DROP COLUMN learning_source_enabled;
    DROP TABLE support_reply_alert_deliveries;
    ALTER TABLE support_replies DROP COLUMN operator_delivery_status;
    ALTER TABLE support_replies DROP COLUMN technical_alert_status;
    UPDATE metadata SET value='14' WHERE key='schema_version';
    COMMIT;
    PRAGMA foreign_keys=ON;`)
  legacy.close()
}

function downgradeThreadPolicyToV20(filePath: string): void {
  const legacy = new DatabaseSync(filePath)
  legacy.exec(`BEGIN IMMEDIATE;
    DROP TABLE reference_learning_results;
    ALTER TABLE learning_source_observations DROP COLUMN current_run_id;
    ALTER TABLE support_threads DROP COLUMN answer_include_magic_book;
    ALTER TABLE support_threads DROP COLUMN answer_include_interface_docs;
    ALTER TABLE support_threads DROP COLUMN answer_include_ai_memory;
    ALTER TABLE support_threads DROP COLUMN answer_binding_enabled;
    ALTER TABLE support_threads DROP COLUMN answer_max_concurrency;
    ALTER TABLE support_threads DROP COLUMN answer_timeout_seconds;
    ALTER TABLE support_threads DROP COLUMN answer_reply_style;
    ALTER TABLE support_threads DROP COLUMN answer_model_instance_id;
    UPDATE metadata SET value='20' WHERE key='schema_version';
    COMMIT;`)
  legacy.close()
}

function expectLegacyProfilesMigrated(database: RuntimeDatabase): void {
  expect(database.prepare(`SELECT model_id,reasoning_effort,enabled FROM model_instances
    WHERE id=?`).get(answerModelId)).toEqual({ model_id: "gpt-5.4-sol", reasoning_effort: "high", enabled: 1 })
  expect(database.prepare(`SELECT model_id,reasoning_effort,enabled FROM model_instances
    WHERE id=?`).get(memoryModelId)).toEqual({ model_id: "gpt-5.4-mini", reasoning_effort: "minimal", enabled: 0 })
  expect(database.prepare(`SELECT model_instance_id,timeout_seconds,max_concurrency,enabled
    FROM runtime_model_bindings WHERE purpose='answer'`).get()).toEqual({
    model_instance_id: answerModelId, timeout_seconds: 777, max_concurrency: 4, enabled: 1,
  })
  expect(database.prepare(`SELECT model_instance_id,timeout_seconds,max_concurrency,enabled
    FROM runtime_model_bindings WHERE purpose='memory'`).get()).toEqual({
    model_instance_id: memoryModelId, timeout_seconds: 88, max_concurrency: 2, enabled: 0,
  })
  expect(tableNames(database)).not.toContain("model_profiles")
}

function expectRemoteConfigurationPreserved(database: RuntimeDatabase): void {
  expect(database.prepare(`SELECT alias,model_id,reasoning_effort,service_tier,enabled
    FROM model_instances WHERE id=?`).get(customModelId)).toEqual({
    alias: "远端自定义回答模型", model_id: "gpt-5.6-sol", reasoning_effort: "xhigh", service_tier: "fast", enabled: 1,
  })
  expect(database.prepare(`SELECT model_instance_id,timeout_seconds,max_concurrency,enabled
    FROM runtime_model_bindings WHERE purpose='answer'`).get()).toEqual({
    model_instance_id: customModelId, timeout_seconds: 900, max_concurrency: 3, enabled: 1,
  })
  expect(database.prepare(`SELECT ai_model_instance_id,reply_style FROM telegram_groups WHERE id=?`).get(groupId)).toEqual({
    ai_model_instance_id: customModelId, reply_style: "human",
  })
}

describe("合并后的模型与参考学习 v22 schema", () => {
  it("新库同时具备模型管理、可信参考学习和线程固定风格能力", async () => {
    const database = await RuntimeDatabase.open(await temporaryDatabase("fresh.sqlite"))
    try {
      expectCombinedCapabilities(database)
      expect(database.prepare("SELECT purpose FROM runtime_model_bindings ORDER BY purpose").all()).toEqual([
        { purpose: "answer" }, { purpose: "memory" },
      ])
    } finally {
      database.close()
    }
  })

  it("本地 v19 谱系按结构升级并无损转换旧模型 profile", async () => {
    const filePath = await temporaryDatabase("ours-v19.sqlite")
    const source = await RuntimeDatabase.open(filePath)
    source.close()
    downgradeToOursV19(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    try {
      expectCombinedCapabilities(migrated)
      expectLegacyProfilesMigrated(migrated)
    } finally {
      migrated.close()
    }
  })

  it("远端 v14 谱系保留模型、绑定和群策略并补齐可信学习能力", async () => {
    const filePath = await temporaryDatabase("remote-v14.sqlite")
    const source = await RuntimeDatabase.open(filePath)
    seedRemoteModelConfiguration(source)
    source.close()
    downgradeToRemoteV14(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    try {
      expectCombinedCapabilities(migrated)
      expectRemoteConfigurationPreserved(migrated)
    } finally {
      migrated.close()
    }
  })

  it("v20 已有线程按当时群策略与回答绑定补齐不可变回答快照", async () => {
    const filePath = await temporaryDatabase("thread-policy-v20.sqlite")
    const source = await RuntimeDatabase.open(filePath)
    seedRemoteModelConfiguration(source)
    source.prepare(`INSERT INTO support_threads(
      id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
      origin_batch_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      threadId, groupId, projectId, serviceId, "collecting", 1, "2026-08-11T00:00:30.000Z", "42",
      "2026-08-11T00:00:00.000Z", "旧线程", null, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
    )
    source.close()
    downgradeThreadPolicyToV20(filePath)

    const migrated = await RuntimeDatabase.open(filePath)
    try {
      expectCombinedCapabilities(migrated)
      expect(migrated.prepare(`SELECT answer_model_instance_id,answer_reply_style,answer_timeout_seconds,
        answer_max_concurrency,answer_binding_enabled,answer_include_ai_memory,answer_include_interface_docs,
        answer_include_magic_book FROM support_threads WHERE id=?`).get(threadId)).toEqual({
        answer_model_instance_id: customModelId,
        answer_reply_style: "human",
        answer_timeout_seconds: 900,
        answer_max_concurrency: 3,
        answer_binding_enabled: 1,
        answer_include_ai_memory: 1,
        answer_include_interface_docs: 1,
        answer_include_magic_book: 1,
      })
    } finally {
      migrated.close()
    }
  })

  it("v21 同号线程回答策略快照缺列时拒绝作为完整结构打开", async () => {
    const filePath = await temporaryDatabase("invalid-thread-policy-v21.sqlite")
    const source = await RuntimeDatabase.open(filePath)
    source.close()
    const invalid = new DatabaseSync(filePath)
    invalid.exec("ALTER TABLE support_threads DROP COLUMN answer_include_magic_book")
    invalid.close()

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/线程回答策略结构不完整/)
  })

  it("同号 modern 谱系缺少模型约束时拒绝升级而不只检查列名", async () => {
    const filePath = await temporaryDatabase("invalid-modern-v19.sqlite")
    const invalid = new DatabaseSync(filePath)
    invalid.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO metadata VALUES ('schema_version','19');
      CREATE TABLE model_instances (
        id TEXT PRIMARY KEY, alias TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('openai','deepseek','anthropic','glm')),
        transport TEXT NOT NULL CHECK (transport IN ('codex_cli','direct_api')),
        model_id TEXT NOT NULL,
        reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra')),
        service_tier TEXT CHECK (service_tier IS NULL OR service_tier IN ('standard','fast','priority')),
        parameters_json TEXT NOT NULL DEFAULT '{}', credentials TEXT,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        health_status TEXT NOT NULL CHECK (health_status IN ('not_tested','ready','error')),
        health_message TEXT NOT NULL, last_checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE model_catalog_entries (
        provider TEXT NOT NULL, transport TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, hidden INTEGER NOT NULL, deprecated INTEGER NOT NULL,
        upgrade_model_id TEXT, refreshed_at TEXT NOT NULL, PRIMARY KEY(provider,transport,model_id)
      );
      CREATE TABLE runtime_model_bindings (
        purpose TEXT PRIMARY KEY CHECK (purpose IN ('answer','memory')),
        model_instance_id TEXT NOT NULL REFERENCES model_instances(id),
        timeout_seconds INTEGER NOT NULL, max_concurrency INTEGER NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE telegram_groups (
        id TEXT PRIMARY KEY, purpose TEXT NOT NULL,
        ai_model_instance_id TEXT REFERENCES model_instances(id),
        reply_style TEXT NOT NULL DEFAULT 'unrestricted' CHECK (reply_style IN ('human','unrestricted'))
      );
      INSERT INTO model_instances VALUES
        ('${answerModelId}','answer','openai','codex_cli','gpt-5.6-terra','medium','standard','{}',NULL,1,'not_tested','',NULL,'2026-08-11','2026-08-11'),
        ('${memoryModelId}','memory','openai','codex_cli','gpt-5.6-luna','low','standard','{}',NULL,1,'not_tested','',NULL,'2026-08-11','2026-08-11');
      INSERT INTO runtime_model_bindings VALUES
        ('answer','${answerModelId}',3600,2,1,'2026-08-11'),
        ('memory','${memoryModelId}',120,1,1,'2026-08-11');`)
    invalid.close()

    await expect(RuntimeDatabase.open(filePath)).rejects.toThrow(/模型配置结构不完整/)
  })

  it("导入本地 v19 portable 时转换旧模型 profile 并保留最终结构", async () => {
    const sourcePath = await temporaryDatabase("ours-source.sqlite")
    const portablePath = await temporaryDatabase("ours-v19-portable.sqlite")
    const source = await RuntimeDatabase.open(sourcePath)
    try {
      await new BackupService(source).export(portablePath)
    } finally {
      source.close()
    }
    downgradeToOursV19(portablePath)

    const restored = await RuntimeDatabase.open(await temporaryDatabase("ours-restored.sqlite"))
    try {
      await new BackupService(restored).import(portablePath)
      expectCombinedCapabilities(restored)
      expectLegacyProfilesMigrated(restored)
    } finally {
      restored.close()
    }
  })

  it("导入远端 v14 portable 时保留模型与群策略并补齐最终结构", async () => {
    const sourcePath = await temporaryDatabase("remote-source.sqlite")
    const portablePath = await temporaryDatabase("remote-v14-portable.sqlite")
    const source = await RuntimeDatabase.open(sourcePath)
    try {
      seedRemoteModelConfiguration(source)
      await new BackupService(source).export(portablePath)
    } finally {
      source.close()
    }
    downgradeToRemoteV14(portablePath)

    const restored = await RuntimeDatabase.open(await temporaryDatabase("remote-restored.sqlite"))
    try {
      await new BackupService(restored).import(portablePath)
      expectCombinedCapabilities(restored)
      expectRemoteConfigurationPreserved(restored)
    } finally {
      restored.close()
    }
  })
})
