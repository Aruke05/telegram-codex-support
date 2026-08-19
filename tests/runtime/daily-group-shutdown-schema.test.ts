import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { RuntimeDatabase } from "../../src/runtime/database.js"
import { BackupService } from "../../src/runtime/backup-service.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"
import { LocalSecretVault } from "../../src/runtime/secret-vault.js"

const directories: string[] = []

async function createServices() {
  const directory = await mkdtemp(path.join(tmpdir(), "daily-group-shutdown-schema-"))
  directories.push(directory)
  const databasePath = path.join(directory, "support.sqlite")
  const database = await RuntimeDatabase.open(databasePath)
  const vault = await LocalSecretVault.open(path.join(directory, "master.key"))
  return { directory, databasePath, database, service: new ModelConfigService(database, vault) }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("每日自动关闭全部群 schema", () => {
  it("把 v25 运行库升级为默认停用的每日计划", async () => {
    const harness = await createServices()
    harness.database.prepare("DROP TABLE IF EXISTS daily_group_shutdown_schedule").run()
    harness.database.prepare("UPDATE metadata SET value='25' WHERE key='schema_version'").run()
    harness.database.close()

    const migrated = await RuntimeDatabase.open(harness.databasePath)
    try {
      expect(migrated.schemaVersion()).toBe(31)
      expect(migrated.prepare("SELECT * FROM daily_group_shutdown_schedule WHERE id=1").get()).toMatchObject({
        enabled: 0,
        local_time: "23:00",
        timezone: "Asia/Shanghai",
        last_run_local_date: null,
        last_run_at: null,
        last_disabled_count: 0,
      })
    } finally {
      migrated.close()
    }
  })

  it("保存合法每日关闭时间并返回只读运行状态", async () => {
    const { database, service } = await createServices()
    try {
      expect(service.updateSettings({
        dailyGroupShutdownEnabled: true,
        dailyGroupShutdownTime: "22:35",
      })).toMatchObject({
        dailyGroupShutdownEnabled: true,
        dailyGroupShutdownTime: "22:35",
        dailyGroupShutdownTimezone: "Asia/Shanghai",
        dailyGroupShutdownLastRunAt: null,
        dailyGroupShutdownLastDisabledCount: 0,
      })
      expect(database.prepare("SELECT enabled,local_time FROM daily_group_shutdown_schedule WHERE id=1").get()).toEqual({
        enabled: 1,
        local_time: "22:35",
      })
    } finally {
      database.close()
    }
  })

  it("修改每日关闭时间时清除旧计划的当天执行日期", async () => {
    const { database, service } = await createServices()
    try {
      database.prepare(`UPDATE daily_group_shutdown_schedule SET enabled=1,local_time='03:49',
        last_run_local_date='2026-08-17',last_run_at='2026-08-16T19:49:41.932Z',
        last_disabled_count=14 WHERE id=1`).run()

      service.updateSettings({ dailyGroupShutdownTime: "03:53" })

      expect(database.prepare(`SELECT local_time,last_run_local_date,last_run_at,last_disabled_count
        FROM daily_group_shutdown_schedule WHERE id=1`).get()).toEqual({
        local_time: "03:53",
        last_run_local_date: null,
        last_run_at: "2026-08-16T19:49:41.932Z",
        last_disabled_count: 14,
      })
    } finally {
      database.close()
    }
  })

  it("保存相同每日关闭时间时保留当天执行日期", async () => {
    const { database, service } = await createServices()
    try {
      database.prepare(`UPDATE daily_group_shutdown_schedule SET enabled=1,local_time='03:53',
        last_run_local_date='2026-08-17',last_run_at='2026-08-16T19:49:41.932Z',
        last_disabled_count=14 WHERE id=1`).run()

      service.updateSettings({ dailyGroupShutdownTime: "03:53" })

      expect(database.prepare("SELECT last_run_local_date FROM daily_group_shutdown_schedule WHERE id=1").get())
        .toEqual({ last_run_local_date: "2026-08-17" })
    } finally {
      database.close()
    }
  })

  it.each(["24:00", "9:30", "12:60", "12:30:00"])("拒绝非法每日关闭时间 %s", async (time) => {
    const { database, service } = await createServices()
    try {
      expect(() => service.updateSettings({ dailyGroupShutdownTime: time })).toThrow()
    } finally {
      database.close()
    }
  })

  it("拒绝客户端修改调度运行状态", async () => {
    const { database, service } = await createServices()
    try {
      expect(() => service.updateSettings({
        dailyGroupShutdownLastRunAt: "2026-08-15T15:00:00.000Z",
      })).toThrow()
    } finally {
      database.close()
    }
  })

  it("SQLite 导出导入保留每日关闭计划和运行状态", async () => {
    const source = await createServices()
    const portablePath = path.join(source.directory, "portable.sqlite")
    source.database.prepare(`UPDATE daily_group_shutdown_schedule SET enabled=1,local_time='21:45',
      last_run_local_date='2026-08-14',last_run_at='2026-08-14T13:45:00.000Z',last_disabled_count=7 WHERE id=1`).run()
    await new BackupService(source.database).export(portablePath)
    source.database.close()

    const restoredPath = path.join(source.directory, "restored.sqlite")
    const restored = await RuntimeDatabase.open(restoredPath)
    try {
      await new BackupService(restored).import(portablePath)
      expect(restored.prepare(`SELECT enabled,local_time,timezone,last_run_local_date,last_run_at,last_disabled_count
        FROM daily_group_shutdown_schedule WHERE id=1`).get()).toEqual({
        enabled: 1,
        local_time: "21:45",
        timezone: "Asia/Shanghai",
        last_run_local_date: "2026-08-14",
        last_run_at: "2026-08-14T13:45:00.000Z",
        last_disabled_count: 7,
      })
    } finally {
      restored.close()
    }
  })
})
