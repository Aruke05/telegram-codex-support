import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ShadowReportStore } from "../../src/learning/shadow-report-store.js"
import { ShadowReportWorker } from "../../src/learning/shadow-report-worker.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const databases: RuntimeDatabase[] = []
const directories: string[] = []

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "shadow-report-"))
  directories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  databases.push(database)
  return database
}

describe("影子学习报告调度", () => {
  it("首份报告只在 2026-08-20 23:00 Asia/Shanghai 到期一次", async () => {
    const database = await openDatabase()
    const store = new ShadowReportStore(database)
    const generate = vi.fn(async () => ({
      summary: {
        headline: "当前没有可比较样本",
        strengths: [],
        gaps: [],
        recommendations: [],
      },
      comparisons: [],
    }))
    const worker = new ShadowReportWorker(store, { generate })

    expect(await worker.runDue(new Date("2026-08-20T14:59:59.999Z"))).toBe(false)
    expect(generate).not.toHaveBeenCalled()
    expect(await worker.runDue(new Date("2026-08-20T15:00:00.000Z"))).toBe(true)
    expect(await worker.runDue(new Date("2026-08-21T15:00:00.000Z"))).toBe(false)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(store.list()[0]).toMatchObject({
      triggerType: "scheduled",
      dueAt: "2026-08-20T15:00:00.000Z",
      cutoffAt: "2026-08-20T15:00:00.000Z",
      status: "completed",
    })
  })

  it("手动生成另建报告且不修改固定计划", async () => {
    const database = await openDatabase()
    const store = new ShadowReportStore(database)
    const worker = new ShadowReportWorker(store, {
      generate: async () => ({
        summary: { headline: "手动报告", strengths: [], gaps: [], recommendations: [] },
        comparisons: [],
      }),
    })
    const at = new Date("2026-08-19T10:00:00.000Z")

    const report = await worker.runNow(at)

    expect(report.status).toBe("completed")
    expect(store.list().map((item) => item.triggerType).sort()).toEqual(["manual", "scheduled"])
    expect(store.list().find((item) => item.triggerType === "scheduled")).toMatchObject({ status: "pending" })
  })

  it("报告完成时间使用生成结束时钟而不是领取时间", async () => {
    const database = await openDatabase()
    const store = new ShadowReportStore(database)
    const startedAt = new Date("2026-08-19T10:00:00.000Z")
    const completedAt = new Date("2026-08-19T10:05:00.000Z")
    const worker = new ShadowReportWorker(store, {
      generate: async () => ({
        summary: { headline: "完成", strengths: [], gaps: [], recommendations: [] },
        comparisons: [],
      }),
    }, () => completedAt)

    const report = await worker.runNow(startedAt)

    expect(report.updatedAt).toBe(completedAt.toISOString())
    expect(database.prepare("SELECT started_at,completed_at FROM shadow_learning_reports WHERE id=?").get(report.id))
      .toEqual({ started_at: startedAt.toISOString(), completed_at: completedAt.toISOString() })
  })
})
