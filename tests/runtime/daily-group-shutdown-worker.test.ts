import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DailyGroupShutdownWorker } from "../../src/runtime/daily-group-shutdown-worker.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

let directory: string
let database: RuntimeDatabase
let worker: DailyGroupShutdownWorker

function insertGroup(id: string, key: string, purpose: "support" | "technical_alert"): void {
  const timestamp = "2026-08-15T00:00:00.000Z"
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,ai_model_instance_id,
    reply_style,created_at,updated_at
  ) VALUES (?,?,?,?,NULL,NULL,NULL,1,'bot',?,'test','[]',NULL,NULL,'none','default',?,NULL,'unrestricted',?,?)`).run(
    id,
    key,
    key,
    `-${id.replaceAll("-", "").slice(-12)}`,
    purpose === "support" ? "all" : "command",
    purpose,
    timestamp,
    timestamp,
  )
}

function enableSchedule(time = "23:00"): void {
  database.prepare(`UPDATE daily_group_shutdown_schedule
    SET enabled=1,local_time=?,last_run_local_date=NULL,last_run_at=NULL,last_disabled_count=0 WHERE id=1`).run(time)
}

function enableGroup(id: string): void {
  database.prepare("UPDATE telegram_groups SET enabled=1 WHERE id=?").run(id)
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "daily-group-shutdown-worker-"))
  database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  insertGroup("00000000-0000-4000-8000-000000000001", "support-a", "support")
  insertGroup("00000000-0000-4000-8000-000000000002", "support-b", "support")
  insertGroup("00000000-0000-4000-8000-000000000003", "technical", "technical_alert")
  worker = new DailyGroupShutdownWorker(database)
})

afterEach(async () => {
  worker?.stop()
  database?.close()
  await rm(directory, { recursive: true, force: true })
})

describe("每日自动关闭全部群 worker", () => {
  it("到点后原子停用客服群和技术告警群", () => {
    enableSchedule()

    expect(worker.runDue(new Date("2026-08-15T15:00:10.000Z"))).toEqual({ executed: true, disabledCount: 3 })
    expect(database.prepare("SELECT DISTINCT enabled FROM telegram_groups").all()).toEqual([{ enabled: 0 }])
    expect(database.prepare(`SELECT last_run_local_date,last_run_at,last_disabled_count
      FROM daily_group_shutdown_schedule WHERE id=1`).get()).toEqual({
      last_run_local_date: "2026-08-15",
      last_run_at: "2026-08-15T15:00:10.000Z",
      last_disabled_count: 3,
    })
  })

  it("到点前不执行且同一上海日期只执行一次", () => {
    enableSchedule()

    expect(worker.runDue(new Date("2026-08-15T14:59:59.000Z"))).toEqual({ executed: false, disabledCount: 0 })
    expect(worker.runDue(new Date("2026-08-15T15:00:00.000Z"))).toEqual({ executed: true, disabledCount: 3 })
    enableGroup("00000000-0000-4000-8000-000000000001")
    expect(worker.runDue(new Date("2026-08-15T16:00:00.000Z"))).toEqual({ executed: false, disabledCount: 0 })
    expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id=?").get(
      "00000000-0000-4000-8000-000000000001",
    )).toEqual({ enabled: 1 })
  })

  it("当天晚启动补执行且次日到点可以再次执行", () => {
    enableSchedule()

    expect(worker.runDue(new Date("2026-08-15T15:30:00.000Z"))).toEqual({ executed: true, disabledCount: 3 })
    enableGroup("00000000-0000-4000-8000-000000000002")
    expect(worker.runDue(new Date("2026-08-16T15:00:00.000Z"))).toEqual({ executed: true, disabledCount: 1 })
  })

  it("上海午夜前后使用不同本地日期", () => {
    enableSchedule("00:00")

    expect(worker.runDue(new Date("2026-08-15T15:59:59.000Z"))).toEqual({ executed: true, disabledCount: 3 })
    enableGroup("00000000-0000-4000-8000-000000000003")
    expect(worker.runDue(new Date("2026-08-15T16:00:00.000Z"))).toEqual({ executed: true, disabledCount: 1 })
    expect(database.prepare("SELECT last_run_local_date FROM daily_group_shutdown_schedule WHERE id=1").get())
      .toEqual({ last_run_local_date: "2026-08-16" })
  })

  it("计划停用时不关闭群", () => {
    expect(worker.runDue(new Date("2026-08-15T16:00:00.000Z"))).toEqual({ executed: false, disabledCount: 0 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM telegram_groups WHERE enabled=1").get()).toEqual({ count: 3 })
  })

  it("没有启用群时仍记录当天成功并保持幂等", () => {
    enableSchedule()
    database.prepare("UPDATE telegram_groups SET enabled=0").run()

    expect(worker.runDue(new Date("2026-08-15T15:00:00.000Z"))).toEqual({ executed: true, disabledCount: 0 })
    expect(worker.runDue(new Date("2026-08-15T15:01:00.000Z"))).toEqual({ executed: false, disabledCount: 0 })
  })
})
