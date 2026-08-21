import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { RuntimeDatabase } from "../../src/runtime/database.js"
import { BackupService } from "../../src/runtime/backup-service.js"
import type { RuntimeGroup } from "../../src/runtime/types.js"
import { ShadowReportStore } from "../../src/learning/shadow-report-store.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("影子学习模式数据库结构", () => {
  it("新库为群和客服线程提供默认正式模式列", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-schema-"))
    directories.push(directory)
    const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
    try {
      const groupColumns = (database.prepare("PRAGMA table_info(telegram_groups)").all() as Array<{ name: string }>).map((row) => row.name)
      const threadColumns = (database.prepare("PRAGMA table_info(support_threads)").all() as Array<{ name: string }>).map((row) => row.name)

      expect(groupColumns).toContain("operation_mode")
      expect(threadColumns).toContain("answer_operation_mode")
    } finally {
      database.close()
    }
  })

  it("读写客服群时保留学习模式", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-group-"))
    directories.push(directory)
    const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
    const now = "2026-08-19T00:00:00.000Z"
    const group = {
      id: "00000000-0000-4000-8000-000000000101",
      key: "learning-group",
      name: "学习群",
      telegramChatId: null,
      accountId: null,
      projectId: null,
      serviceId: null,
      enabled: false,
      accessMode: "bot",
      triggerMode: "all",
      platform: "internal",
      repositories: [],
      branch: null,
      serverAlias: null,
      databaseAlias: "none",
      knowledgeScope: "default",
      purpose: "support",
      aiModelInstanceId: null,
      replyStyle: "human",
      operationMode: "learning",
      createdAt: now,
      updatedAt: now,
    } as unknown as RuntimeGroup
    try {
      database.insertGroup(group)
      expect(database.readGroups()).toEqual([
        expect.objectContaining({ id: group.id, operationMode: "learning" }),
      ])
    } finally {
      database.close()
    }
  })

  it("将没有影子表的合法 v28 数据库按能力迁移到 v29", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-v28-"))
    directories.push(directory)
    const file = path.join(directory, "support.sqlite")
    const legacy = await RuntimeDatabase.open(file)
    legacy.connection.exec("PRAGMA foreign_keys=OFF")
    legacy.connection.exec(`
      DROP TABLE shadow_comparisons;
      DROP TABLE shadow_human_answer_links;
      DROP TABLE shadow_answer_results;
      DROP TABLE shadow_learning_reports;
      UPDATE metadata SET value='28' WHERE key='schema_version';
    `)
    legacy.close()

    const migrated = await RuntimeDatabase.open(file)
    try {
      expect(migrated.schemaVersion()).toBe(32)
      const tables = new Set((migrated.prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'shadow_%'`).all() as Array<{ name: string }>).map((row) => row.name))
      expect(tables).toEqual(new Set([
        "shadow_answer_results", "shadow_human_answer_links", "shadow_learning_reports", "shadow_comparisons",
      ]))
      expect(new ShadowReportStore(migrated).list()).toEqual([
        expect.objectContaining({ triggerType: "scheduled", dueAt: "2026-08-20T15:00:00.000Z" }),
      ])
    } finally {
      migrated.close()
    }
  })

  it("拒绝同名但缺少约束的 v28 影子表谱系", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-bad-v28-"))
    directories.push(directory)
    const file = path.join(directory, "support.sqlite")
    const legacy = await RuntimeDatabase.open(file)
    legacy.connection.exec("PRAGMA foreign_keys=OFF")
    legacy.connection.exec(`
      DROP TABLE shadow_comparisons;
      CREATE TABLE shadow_comparisons(id TEXT PRIMARY KEY);
      UPDATE metadata SET value='28' WHERE key='schema_version';
    `)
    legacy.close()

    await expect(RuntimeDatabase.open(file)).rejects.toThrow("影子学习结构不兼容")
  })

  it("兼容已带影子表的 v28 分支且不重复创建固定报告", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-feature-v28-"))
    directories.push(directory)
    const file = path.join(directory, "support.sqlite")
    const legacy = await RuntimeDatabase.open(file)
    legacy.prepare(`UPDATE shadow_learning_reports SET id='00000000-0000-4000-8000-000000000028'
      WHERE trigger_type='scheduled'`).run()
    legacy.prepare("UPDATE metadata SET value='28' WHERE key='schema_version'").run()
    legacy.close()

    const migrated = await RuntimeDatabase.open(file)
    try {
      expect(migrated.schemaVersion()).toBe(32)
      expect(migrated.prepare(`SELECT id,status FROM shadow_learning_reports
        WHERE trigger_type='scheduled'`).all()).toEqual([
        { id: "00000000-0000-4000-8000-000000000028", status: "pending" },
      ])
    } finally {
      migrated.close()
    }
  })

  it("迁移数据库保留已完成报告且不覆盖固定计划", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-portable-"))
    directories.push(directory)
    const source = await RuntimeDatabase.open(path.join(directory, "source.sqlite"))
    const at = new Date("2026-08-19T10:00:00.000Z")
    const store = new ShadowReportStore(source)
    const pending = store.createManual(at)
    const claim = store.claimDue(at, pending.id)!
    store.complete(claim, [], {
      summary: { headline: "人工审核报告", strengths: [], gaps: [], recommendations: [] },
      comparisons: [],
    }, at)
    const portable = path.join(directory, "portable.sqlite")
    await new BackupService(source).export(portable)
    source.close()

    const target = await RuntimeDatabase.open(path.join(directory, "target.sqlite"))
    try {
      await new BackupService(target).import(portable)
      expect(new ShadowReportStore(target).list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: pending.id, triggerType: "manual", status: "completed" }),
        expect.objectContaining({ triggerType: "scheduled", dueAt: "2026-08-20T15:00:00.000Z" }),
      ]))
    } finally {
      target.close()
    }
  })

  it("接受基线生成且尚无影子表的合法 v28 迁移库", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-portable-v28-"))
    directories.push(directory)
    const source = await RuntimeDatabase.open(path.join(directory, "source.sqlite"))
    const portable = path.join(directory, "portable.sqlite")
    await new BackupService(source).export(portable)
    source.close()
    const legacy = new DatabaseSync(portable)
    legacy.exec("PRAGMA foreign_keys=OFF")
    legacy.exec(`
      DROP TABLE shadow_comparisons;
      DROP TABLE shadow_human_answer_links;
      DROP TABLE shadow_answer_results;
      DROP TABLE shadow_learning_reports;
      UPDATE metadata SET value='28' WHERE key='schema_version';
    `)
    legacy.close()

    const target = await RuntimeDatabase.open(path.join(directory, "target.sqlite"))
    try {
      await new BackupService(target).import(portable)
      expect(new ShadowReportStore(target).list()).toEqual([
        expect.objectContaining({ triggerType: "scheduled", status: "pending" }),
      ])
    } finally {
      target.close()
    }
  })

  it("拒绝只含部分影子表的 v28 迁移库以避免静默丢数据", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-partial-portable-v28-"))
    directories.push(directory)
    const source = await RuntimeDatabase.open(path.join(directory, "source.sqlite"))
    const portable = path.join(directory, "portable.sqlite")
    await new BackupService(source).export(portable)
    source.close()
    const legacy = new DatabaseSync(portable)
    legacy.exec("PRAGMA foreign_keys=OFF")
    legacy.exec(`
      DROP TABLE shadow_comparisons;
      DROP TABLE shadow_human_answer_links;
      DROP TABLE shadow_answer_results;
      UPDATE metadata SET value='28' WHERE key='schema_version';
    `)
    legacy.close()

    const target = await RuntimeDatabase.open(path.join(directory, "target.sqlite"))
    try {
      await expect(new BackupService(target).import(portable)).rejects.toThrow("影子学习结构")
    } finally {
      target.close()
    }
  })

  it("迁移时把生成中的报告重新排队而不是永久失败", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-running-portable-"))
    directories.push(directory)
    const source = await RuntimeDatabase.open(path.join(directory, "source.sqlite"))
    const store = new ShadowReportStore(source)
    const pending = store.createManual(new Date("2026-08-19T10:00:00.000Z"))
    expect(store.claimDue(new Date("2026-08-19T10:00:00.000Z"), pending.id)).not.toBeNull()
    const portable = path.join(directory, "portable.sqlite")
    await new BackupService(source).export(portable)
    source.close()

    const target = await RuntimeDatabase.open(path.join(directory, "target.sqlite"))
    try {
      await new BackupService(target).import(portable)
      expect(new ShadowReportStore(target).get(pending.id)).toMatchObject({
        status: "pending",
        errorMessage: "迁移时报告生成中断，已重新排队",
      })
    } finally {
      target.close()
    }
  })
})
