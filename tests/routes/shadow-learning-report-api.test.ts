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
    const app = buildApp({
      shadowReportStore: store,
      shadowReportWorker: {
        runNow: async (at = new Date()) => {
          const pending = store.createManual(at)
          return pending
        },
      },
    })

    const listed = await app.inject({ method: "GET", url: "/api/learning-reports" })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items[0]).toMatchObject({
      triggerType: "scheduled",
      dueAt: "2026-08-20T15:00:00.000Z",
    })
    expect(JSON.stringify(listed.json())).not.toContain("shadowAnswer")

    const created = await app.inject({ method: "POST", url: "/api/learning-reports" })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ triggerType: "manual", status: "pending" })
    await app.close()
  })
})
