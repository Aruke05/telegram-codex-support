import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { HourlyCodeSyncWorker } from "../../src/git-sync/hourly-worker.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "hourly-code-sync-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const syncService = vi.fn(async (serviceId: string) => ({
    projectId: "00000000-0000-4000-8000-000000000801",
    serviceId,
    service: "configured-service",
    branch: "main",
    commit: "a".repeat(40),
    snapshotId: "00000000-0000-4000-8000-000000000809",
    syncBatchId: "00000000-0000-4000-8000-000000000810",
    configurationFingerprint: "configured-service-main",
    syncState: "fresh" as const,
    failure: null,
    publishedAt: "2026-08-11T00:00:00.000Z",
    workspacePath: directory,
    repositories: [],
  }))
  const worker = new HourlyCodeSyncWorker({
    database,
    codeSync: { syncService },
    alerts: {
      sendHourlyCodeSyncFailure: vi.fn(),
      sendCodeSyncRecovery: vi.fn(),
    } as never,
  })
  return { database, syncService, worker }
}

function seedService(
  database: RuntimeDatabase,
  input: { index: number; projectEnabled?: boolean; serviceEnabled?: boolean; serviceKey?: string },
): string {
  const suffix = String(input.index).padStart(12, "0")
  const projectId = `00000000-0000-4000-8001-${suffix}`
  const serviceId = `00000000-0000-4000-8002-${suffix}`
  const now = "2026-08-11T00:00:00.000Z"
  database.prepare(`INSERT INTO projects(
    id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    projectId, `project-${input.index}`, `项目 ${input.index}`, "", Number(input.projectEnabled ?? true), "default", now, now,
  )
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, input.serviceKey ?? `service-${input.index}`, `服务 ${input.index}`, "", "Asia/Shanghai",
    null, "main", Number(input.serviceEnabled ?? true), now, now,
  )
  database.prepare(`INSERT INTO service_code_sync_schedule(
    service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,failure_count,
    last_alert_fingerprint,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(serviceId, now, "never", null, null, 0, null, now, now)
  return serviceId
}

describe("项目配置驱动的定时代码同步", () => {
  it("启用项目和服务即使没有 Telegram 群也会领取到期同步", async () => {
    const { database, syncService, worker } = await fixture()
    try {
      const serviceId = seedService(database, { index: 1 })

      expect(await worker.runDueOnce(new Date("2026-08-11T00:01:00.000Z"))).toBe(1)
      expect(syncService).toHaveBeenCalledWith(serviceId, { trigger: "hourly" })
    } finally {
      database.close()
    }
  })

  it("停用项目、停用服务和 Peakpay 仍不会进入同步队列", async () => {
    const { database, syncService, worker } = await fixture()
    try {
      seedService(database, { index: 1, projectEnabled: false })
      seedService(database, { index: 2, serviceEnabled: false })
      seedService(database, { index: 3, serviceKey: "PeAkPaY" })

      expect(await worker.runDueOnce(new Date("2026-08-11T00:01:00.000Z"))).toBe(0)
      expect(syncService).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})
