import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function databasePath(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return path.join(directory, "support.sqlite")
}

function tableNames(database: RuntimeDatabase): string[] {
  return (database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
    'support_thread_links','support_sender_focus','support_route_clarifications'
  ) ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name)
}

describe("统一问题路由 schema 谱系", () => {
  it("新数据库同时具备多问题关联和发送人会话焦点", async () => {
    const database = await RuntimeDatabase.open(await databasePath("unified-routing-fresh-"))
    openDatabases.push(database)

    expect(database.schemaVersion()).toBe(27)
    expect(tableNames(database)).toEqual([
      "support_route_clarifications",
      "support_sender_focus",
      "support_thread_links",
    ])
    expect(database.prepare("PRAGMA table_info(support_message_events)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "media_group_id" }),
    ]))
  })

  it("从线上多问题 v24 谱系升级时补齐发送人焦点", async () => {
    const filePath = await databasePath("unified-routing-production-v24-")
    const current = await RuntimeDatabase.open(filePath)
    current.close()
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      DROP TABLE support_route_clarifications;
      DROP TABLE support_sender_focus;
      UPDATE metadata SET value='24' WHERE key='schema_version';
    `)
    legacy.close()

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)
    expect(migrated.schemaVersion()).toBe(27)
    expect(tableNames(migrated)).toEqual([
      "support_route_clarifications",
      "support_sender_focus",
      "support_thread_links",
    ])
  })

  it("从发送人焦点 v24 谱系升级时补齐多问题关联和附件组字段", async () => {
    const filePath = await databasePath("unified-routing-focus-v24-")
    const current = await RuntimeDatabase.open(filePath)
    current.close()
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      DROP TABLE support_thread_links;
      DROP INDEX support_message_events_media_group_idx;
      ALTER TABLE support_message_events DROP COLUMN media_group_id;
      CREATE TRIGGER support_thread_messages_single_thread_insert
      BEFORE INSERT ON support_thread_messages BEGIN SELECT 1; END;
      CREATE TRIGGER support_thread_messages_single_thread_update
      BEFORE UPDATE ON support_thread_messages BEGIN SELECT 1; END;
      CREATE TRIGGER support_message_events_batch_link_update
      BEFORE UPDATE ON support_message_events BEGIN SELECT 1; END;
      UPDATE metadata SET value='24' WHERE key='schema_version';
    `)
    legacy.close()

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)
    expect(migrated.schemaVersion()).toBe(27)
    expect(tableNames(migrated)).toEqual([
      "support_route_clarifications",
      "support_sender_focus",
      "support_thread_links",
    ])
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
      'support_thread_messages_single_thread_insert',
      'support_thread_messages_single_thread_update',
      'support_message_events_batch_link_update'
    )`).all()).toEqual([])
    expect(migrated.prepare("PRAGMA table_info(support_message_events)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "media_group_id" }),
    ]))
  })
})
