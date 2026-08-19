import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { RuntimeDatabase } from "../../src/runtime/database.js"

const openDatabases: RuntimeDatabase[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openTemporaryDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "sender-focus-schema-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  openDatabases.push(database)
  return database
}

async function createTemporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sender-focus-migration-"))
  temporaryDirectories.push(directory)
  return path.join(directory, "runtime.sqlite")
}

describe("sender focus schema v24", () => {
  it("creates the v24 sender focus and route clarification tables", async () => {
    const database = await openTemporaryDatabase()

    expect(database.schemaVersion()).toBe(31)
    expect(database.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('support_sender_focus','support_route_clarifications')
      ORDER BY name`).all()).toEqual([
      { name: "support_route_clarifications" },
      { name: "support_sender_focus" },
    ])
  })

  it("migrates an existing v23 lineage to v24", async () => {
    const filePath = await createTemporaryDatabasePath()
    const legacy = await RuntimeDatabase.open(filePath)
    legacy.prepare("DROP TABLE support_route_clarifications").run()
    legacy.prepare("DROP TABLE support_sender_focus").run()
    legacy.prepare("UPDATE metadata SET value='23' WHERE key='schema_version'").run()
    legacy.close()

    const migrated = await RuntimeDatabase.open(filePath)
    openDatabases.push(migrated)

    expect(migrated.schemaVersion()).toBe(31)
    expect(migrated.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('support_sender_focus','support_route_clarifications')
      ORDER BY name`).all()).toHaveLength(2)
  })

  it("migrates a writable v23 portable database and keeps strict pending uniqueness", async () => {
    const filePath = await createTemporaryDatabasePath()
    const legacy = await RuntimeDatabase.open(filePath)
    legacy.prepare("DROP TABLE support_route_clarifications").run()
    legacy.prepare("DROP TABLE support_sender_focus").run()
    legacy.prepare("UPDATE metadata SET value='23' WHERE key='schema_version'").run()
    legacy.close()

    const portable = RuntimeDatabase.openPortable(filePath)
    openDatabases.push(portable)

    expect(portable.schemaVersion()).toBe(31)
    expect(portable.prepare(`SELECT name,sql FROM sqlite_master
      WHERE type='index' AND name IN (
        'support_sender_focus_expiry_idx',
        'support_route_clarifications_one_pending_idx'
      ) ORDER BY name`).all()).toEqual([
      expect.objectContaining({ name: "support_route_clarifications_one_pending_idx" }),
      expect.objectContaining({ name: "support_sender_focus_expiry_idx" }),
    ])
    const definition = portable.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='support_route_clarifications'`).get() as { sql: string }
    expect(definition.sql).toContain("json_array_length(candidate_thread_ids_json) BETWEEN 1 AND 2")
    expect(definition.sql).toContain("status IN ('pending','resolved','expired','cancelled')")
  })
})
