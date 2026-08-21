import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { buildApp } from "../../src/app.js"
import { ShadowReportStore } from "../../src/learning/shadow-report-store.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const databases: RuntimeDatabase[] = []
const directories: string[] = []
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("学习报告 API", () => {
  it("列出固定计划并允许手动生成独立报告", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-report-api-"))
    directories.push(directory)
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    databases.push(database)
    const store = new ShadowReportStore(database)
    const failedPending = store.createManual(new Date("2026-08-19T09:00:00.000Z"))
    const failedClaim = store.claimDue(new Date("2026-08-19T09:00:00.000Z"), failedPending.id)!
    store.fail(failedClaim, new Error("批次超时"), new Date("2026-08-19T09:05:00.000Z"))
    const app = buildApp({
      shadowReportStore: store,
      shadowReportWorker: {
        runNow: async (at = new Date()) => {
          const pending = store.createManual(at)
          return pending
        },
        retry: async (id, at = new Date()) => {
          const claim = store.retryFailed(id, at)
          if (!claim) throw new Error("学习报告不能重试")
          store.complete(claim, [], {
            summary: { headline: "重试完成", strengths: [], gaps: [], recommendations: [] },
            comparisons: [],
          }, at)
          return store.get(id)
        },
      },
    })

    const listed = await app.inject({ method: "GET", url: "/api/learning-reports" })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items.find((item: { triggerType: string }) => item.triggerType === "scheduled")).toMatchObject({
      triggerType: "scheduled",
      dueAt: "2026-08-20T15:00:00.000Z",
    })
    expect(JSON.stringify(listed.json())).not.toContain("shadowAnswer")

    const created = await app.inject({ method: "POST", url: "/api/learning-reports" })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ triggerType: "manual", status: "pending" })

    const retried = await app.inject({ method: "POST", url: `/api/learning-reports/${failedPending.id}/retry` })
    expect(retried.statusCode).toBe(200)
    expect(retried.json()).toMatchObject({ id: failedPending.id, status: "completed", errorMessage: null })

    const retriedAgain = await app.inject({ method: "POST", url: `/api/learning-reports/${failedPending.id}/retry` })
    expect(retriedAgain.statusCode).toBe(400)
    expect(retriedAgain.json()).toEqual({ error: "学习报告不能重试" })
    await app.close()
  })
})
