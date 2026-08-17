import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeControlService } from "../../src/runtime/control-service.js"
import {
  cleanupReferenceHarnesses,
  createReferenceHarness,
  proposal,
  seedObservation,
} from "./reference-worker-fixture.js"

afterEach(async () => {
  vi.useRealTimers()
  await cleanupReferenceHarnesses()
})

describe("人工参考学习 worker", () => {
  it.each([
    ["空 proposals", "empty", 2],
    ["部分遗漏 observation", "partial", 2],
    ["重复 observation ID", "duplicate", 1],
    ["非法 proposal", "invalid", 1],
  ] as const)("%s 会整批失败并为每条 claimed observation 留下唯一失败终态", async (_label, mode, count) => {
    const harness = await createReferenceHarness()
    const observations = Array.from({ length: count }, (_, index) => seedObservation(harness, { index: index + 1 }))
    harness.setHandler(async () => {
      if (mode === "empty") return { proposals: [] }
      if (mode === "partial") {
        return { proposals: [proposal({ observationIds: [observations[0]!.observationId] })] }
      }
      if (mode === "invalid") {
        return { proposals: [{
          ...proposal({ observationIds: [observations[0]!.observationId] }),
          classification: "invented",
        }] } as never
      }
      return { proposals: [proposal({
        observationIds: [observations[0]!.observationId, observations[0]!.observationId],
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare(`SELECT processing_status FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual(observations.map(() => ({ processing_status: "failed" })))
    expect(harness.database.prepare(`SELECT observation_id,classification,action,risk,outcome,reason_code,
      memory_version_id,operator_style_version_id FROM reference_learning_results ORDER BY observation_id`).all()).toEqual(
      [...observations].sort((left, right) => left.observationId.localeCompare(right.observationId)).map((observation) => ({
        observation_id: observation.observationId,
        classification: "unclassified",
        action: "noop",
        risk: "low",
        outcome: "failed",
        reason_code: "invalid_proposal_batch",
        memory_version_id: null,
        operator_style_version_id: null,
      })),
    )
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results
      GROUP BY run_id,observation_id HAVING COUNT(*)<>1`).all()).toEqual([])
  })

  it("autoLearningEnabled=false 时不 claim 任何观察", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    harness.config.updateSettings({ autoLearningEnabled: false })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT processing_status,attempt_count,lock_token FROM learning_source_observations
      WHERE id=?`).get(observed.observationId)).toEqual({ processing_status: "pending", attempt_count: 0, lock_token: null })
  })

  it("learningBatchSize=50 时每次最多 claim classifier 支持的 30 条", async () => {
    const harness = await createReferenceHarness()
    harness.config.updateSettings({ learningBatchSize: 50 })
    Array.from({ length: 31 }, (_, index) => seedObservation(harness, { index: index + 1 }))
    let receivedObservationIds: string[] = []
    harness.setHandler(async (input) => {
      receivedObservationIds = input.threadContexts.map((context) => context.observationId)
      return { proposals: input.threadContexts.map((context) => proposal({
        observationIds: [context.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })) }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 30, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(receivedObservationIds).toHaveLength(30)
    expect(new Set(receivedObservationIds).size).toBe(30)
    expect(harness.database.prepare(`SELECT processing_status,COUNT(*) AS count FROM learning_source_observations
      GROUP BY processing_status ORDER BY processing_status`).all()).toEqual([
      { processing_status: "completed", count: 30 },
      { processing_status: "pending", count: 1 },
    ])
  })

  it("二次核验数字 ID 授权，只把仍启用的学习来源交给模型", async () => {
    const harness = await createReferenceHarness()
    const authorized = seedObservation(harness, { index: 1, sourceUserId: "20001" })
    const revoked = seedObservation(harness, { index: 2, sourceUserId: "20002", authorized: false })
    harness.setHandler(async (input) => {
      expect(input.target).toEqual({ scope: "scope", region: "印度", branch: "main" })
      expect(input.threadContexts).toEqual([
        expect.objectContaining({ observationId: authorized.observationId, threadId: authorized.threadId }),
      ])
      expect(input.threadContexts[0]?.messages).toEqual([
        { role: "question", safeText: "订单为什么还在处理中" },
        { role: "reference", safeText: "处理中表示还在等待上游结果" },
      ])
      return { proposals: [proposal({
        observationIds: [authorized.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 1, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).toHaveBeenCalledTimes(1)
    expect(harness.database.prepare(`SELECT id,processing_status,attempt_count FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([
      { id: authorized.observationId, processing_status: "completed", attempt_count: 1 },
      { id: revoked.observationId, processing_status: "ignored", attempt_count: 0 },
    ])
  })

  it("超长 question/context 仍为每个 observation 保留非空 reference 预算", async () => {
    const harness = await createReferenceHarness()
    const long = seedObservation(harness, { index: 1, referenceText: "人工参考必须保留" })
    const normal = seedObservation(harness, { index: 2, referenceText: "普通人工参考" })
    const insertEvent = harness.database.prepare(`INSERT INTO support_message_events(
      id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
      sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insertMessage = harness.database.prepare(`INSERT INTO support_thread_messages(
      thread_id,message_event_id,relation,question_fragment,position,created_at
    ) VALUES (?,?,?,?,?,?)`)
    for (let index = 1; index <= 6; index += 1) {
      const eventId = crypto.randomUUID()
      const safeText = `上下文${index}`.repeat(1_500)
      const createdAt = `2026-08-11T00:01:${String(index).padStart(2, "0")}.000Z`
      insertEvent.run(
        eventId, harness.groupId, null, `context-${index}`, null, null, "30001", null,
        "提问人", "operator", safeText, "", null, "routed", null, createdAt,
      )
      insertMessage.run(long.threadId, eventId, "supplement", safeText, index, createdAt)
    }
    let receivedObservationIds: string[] = []
    let longReference = ""
    let longTotalChars = 0
    harness.setHandler(async (input) => {
      receivedObservationIds = input.threadContexts.map((context) => context.observationId)
      const longContext = input.threadContexts.find((context) => context.observationId === long.observationId)
      longReference = longContext?.messages.find((message) => message.role === "reference")?.safeText ?? ""
      longTotalChars = longContext?.messages.reduce((sum, message) => sum + message.safeText.length, 0) ?? 0
      return { proposals: input.threadContexts.map((context) => proposal({
        observationIds: [context.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })) }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(receivedObservationIds).toEqual([long.observationId, normal.observationId])
    expect(longReference).toBe("人工参考必须保留")
    expect(longTotalChars).toBeLessThanOrEqual(24_000)
    expect(harness.database.prepare(`SELECT processing_status FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([{ processing_status: "completed" }, { processing_status: "completed" }])
  })

  it("空白 reference 在 claim 授权阶段明确 ignored 且绝不 completed", async () => {
    const harness = await createReferenceHarness()
    const blank = seedObservation(harness, { index: 1, referenceText: "   " })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT processing_status,attempt_count FROM learning_source_observations
      WHERE id=?`).get(blank.observationId)).toEqual({ processing_status: "ignored", attempt_count: 0 })
  })

  it("只在二次学习模型边界逐条脱敏并保留数据库诊断原文", async () => {
    const harness = await createReferenceHarness()
    const configuredPassword = "ConfiguredDbPassword-Task9"
    const timestamp = "2026-08-11T00:00:00.000Z"
    harness.database.insertDatabaseResource({
      id: crypto.randomUUID(),
      projectId: harness.projectId,
      serviceId: harness.serviceId,
      alias: "learning-redaction",
      engine: "mysql",
      host: "database.internal.example",
      port: 3306,
      database: "support_production",
      username: "support_operator",
      password: configuredPassword,
      timezone: "Asia/Shanghai",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const rawReference = [
      "长期有效规则是回调异常时先核对当前发布代码与业务入口再判断原因".repeat(20),
      `未标注的数据库配置值 ${configuredPassword}`,
      "password=plain-password-value",
      `token=${"t".repeat(96)}`,
      `-----BEGIN PRIVATE KEY-----\n${"A".repeat(128)}\n-----END PRIVATE KEY-----`,
      "签名地址 https://merchant.example/callback?sign=temporary-signature&token=temporary-token",
      "merchantId=merchant-task-9,merchantCode=merchant-code-task-9",
    ].join("\n")
    const observed = seedObservation(harness, { index: 1, referenceText: rawReference })
    let modelReference = ""
    harness.setHandler(async (input) => {
      modelReference = input.threadContexts[0]?.messages.find((message) => message.role === "reference")?.safeText ?? ""
      return { proposals: [proposal({
        observationIds: [observed.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 1, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(modelReference).toContain("长期有效规则")
    expect(modelReference).toContain("◼")
    expect(modelReference).toContain("◈")
    expect(modelReference).not.toContain(configuredPassword)
    expect(modelReference).not.toContain("plain-password-value")
    expect(modelReference).not.toContain("t".repeat(96))
    expect(modelReference).not.toContain("BEGIN PRIVATE KEY")
    expect(modelReference).not.toContain("temporary-signature")
    expect(modelReference).not.toContain("merchant-task-9")
    expect(harness.database.prepare("SELECT safe_text FROM support_message_events WHERE id=(SELECT message_event_id FROM learning_source_observations WHERE id=?)")
      .get(observed.observationId)).toEqual({ safe_text: rawReference })
  })

  it("整批 30 条 reference 全部为高秘密密度时 fail closed 且不进入分类器", async () => {
    const harness = await createReferenceHarness()
    harness.config.updateSettings({ learningBatchSize: 30 })
    Array.from({ length: 30 }, (_, index) => seedObservation(harness, {
      index: index + 1,
      referenceText: `password=${"p".repeat(2_000)}\ntoken=${"t".repeat(2_000)}`,
    }))

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT processing_status,COUNT(*) AS count FROM learning_source_observations
      GROUP BY processing_status`).all()).toEqual([{ processing_status: "ignored", count: 30 }])
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT status,scanned_events FROM memory_maintenance_runs").all()).toEqual([
      { status: "completed", scanned_events: 30 },
    ])
    expect(harness.database.prepare(`SELECT outcome,reason_code,COUNT(*) AS count FROM reference_learning_results
      GROUP BY outcome,reason_code`).all()).toEqual([{
      outcome: "ignored", reason_code: "unsafe_learning_material", count: 30,
    }])
  })

  it.each(["password=short-value", "token=abc123"])(
    "短秘密 reference %s 不会被长安全 question 稀释，仍 fail closed",
    async (referenceText) => {
      const harness = await createReferenceHarness()
      const observed = seedObservation(harness, {
        index: 1,
        referenceText,
        questionText: "长期安全问题描述应结合当前发布代码理解通用处理方式".repeat(80),
      })

      expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
        processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
      })
      expect(harness.classify).not.toHaveBeenCalled()
      expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
        .get(observed.observationId)).toEqual({ processing_status: "ignored" })
    },
  )

  it.each([
    "backupCredential=abcd",
    "backup credential=abcd",
    "备用 凭据=abcd",
  ])("未知字段标签 %s 只剩脱敏标记时也按无可学习语义 fail closed", async (referenceText) => {
    const harness = await createReferenceHarness()
    const timestamp = "2026-08-11T00:00:00.000Z"
    harness.database.insertDatabaseResource({
      id: crypto.randomUUID(),
      projectId: harness.projectId,
      serviceId: harness.serviceId,
      alias: "short-secret",
      engine: "mysql",
      host: "short-secret.internal.example",
      port: 3306,
      database: "short_secret_database",
      username: "short_secret_operator",
      password: "abcd",
      timezone: "Asia/Shanghai",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const observed = seedObservation(harness, {
      index: 1,
      referenceText,
      questionText: "长期安全问题描述应结合当前发布代码理解通用处理方式".repeat(80),
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(observed.observationId)).toEqual({ processing_status: "ignored" })
  })

  it("安全 context 构造失败时 observation 保持 failed 供重试而不 completed", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    const malformedId = "not-a-valid-observation-uuid"
    harness.database.prepare("UPDATE learning_source_observations SET id=? WHERE id=?")
      .run(malformedId, observed.observationId)

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT processing_status,attempt_count,lock_token FROM learning_source_observations
      WHERE id=?`).get(malformedId)).toEqual({ processing_status: "failed", attempt_count: 1, lock_token: null })
  })

  it("失败释放锁并可重试，陈旧 running 锁会回收到 failed", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, {
      index: 1,
      processingStatus: "running",
      lockedAt: "2026-08-11T00:30:00.000Z",
      attemptCount: 1,
    })
    expect(harness.worker.recoverInterrupted(new Date("2026-08-11T01:00:00.000Z"))).toBe(1)
    expect(harness.database.prepare(`SELECT processing_status,lock_token,locked_at FROM learning_source_observations
      WHERE id=?`).get(observed.observationId)).toEqual({ processing_status: "failed", lock_token: null, locked_at: null })

    let attempts = 0
    harness.setHandler(async (input) => {
      attempts += 1
      if (attempts === 1) throw new Error("temporary model failure")
      return { proposals: input.threadContexts.map((context) => proposal({
        observationIds: [context.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })) }
    })
    expect(await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare(`SELECT processing_status,attempt_count,lock_token,locked_at FROM learning_source_observations
      WHERE id=?`).get(observed.observationId)).toEqual({ processing_status: "failed", attempt_count: 2, lock_token: null, locked_at: null })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:02:00.000Z"))).toEqual({
      processed: 1, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare(`SELECT processing_status,attempt_count,lock_token,locked_at FROM learning_source_observations
      WHERE id=?`).get(observed.observationId)).toEqual({ processing_status: "completed", attempt_count: 3, lock_token: null, locked_at: null })
  })

  it("恢复会终结终态已齐但没有 active claim 的孤儿 running run", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    const runId = crypto.randomUUID()
    harness.database.prepare("UPDATE learning_source_observations SET processing_status='ignored' WHERE id=?")
      .run(observed.observationId)
    harness.database.prepare(`INSERT INTO memory_maintenance_runs(
      id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      runId, "running", 1, 0, 0, "终态已写等待完成", "2026-08-11T00:00:00.000Z", null,
    )
    harness.database.prepare(`INSERT INTO reference_learning_results(
      id,run_id,observation_id,classification,action,risk,outcome,reason_code,
      memory_version_id,operator_style_version_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), runId, observed.observationId, "unclassified", "noop", "low", "ignored",
      "unsafe_learning_material", null, null, "2026-08-11T00:00:01.000Z",
    )

    expect(harness.worker.recoverInterrupted(new Date("2026-08-11T01:00:00.000Z"))).toBe(0)
    expect(harness.database.prepare("SELECT status,summary,finished_at FROM memory_maintenance_runs WHERE id=?")
      .get(runId)).toEqual({
      status: "failed", summary: "人工参考学习中断，终态已保留", finished_at: "2026-08-11T01:00:00.000Z",
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM reference_learning_results WHERE run_id=?")
      .get(runId)).toEqual({ count: 1 })
  })

  it("同一 run 只要一个 claim stale 就会原子终结该 run 的全部 active claims", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, {
      index: 1, processingStatus: "running", lockedAt: "2026-08-11T00:30:00.000Z", attemptCount: 1,
    })
    const second = seedObservation(harness, {
      index: 2, processingStatus: "running", lockedAt: "2026-08-11T00:59:00.000Z", attemptCount: 1,
    })
    const runId = crypto.randomUUID()
    harness.database.prepare(`INSERT INTO memory_maintenance_runs(
      id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      runId, "running", 2, 0, 0, "处理中", "2026-08-11T00:30:00.000Z", null,
    )
    harness.database.prepare(`UPDATE learning_source_observations SET current_run_id=?,lock_token='same-run-lock'
      WHERE id IN (?,?)`).run(runId, first.observationId, second.observationId)

    expect(harness.worker.recoverInterrupted(new Date("2026-08-11T01:00:00.000Z"))).toBe(2)
    expect(harness.database.prepare(`SELECT processing_status,current_run_id FROM learning_source_observations
      WHERE id IN (?,?) ORDER BY id`).all(first.observationId, second.observationId)).toEqual([
      { processing_status: "failed", current_run_id: null },
      { processing_status: "failed", current_run_id: null },
    ])
    expect(harness.database.prepare("SELECT status FROM memory_maintenance_runs WHERE id=?").get(runId)).toEqual({
      status: "failed",
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM reference_learning_results WHERE run_id=?")
      .get(runId)).toEqual({ count: 2 })
  })

  it("stale lease 覆盖最长模型超时并保留安全余量", async () => {
    const harness = await createReferenceHarness()
    harness.config.updateProfile("memory", { timeoutSeconds: 3_600 })
    const observed = seedObservation(harness, {
      index: 1,
      processingStatus: "running",
      lockedAt: "2026-08-11T00:30:00.000Z",
      attemptCount: 1,
    })

    expect(harness.worker.recoverInterrupted(new Date("2026-08-11T01:00:00.000Z"))).toBe(0)
    expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(observed.observationId)).toEqual({ processing_status: "running" })

    expect(harness.worker.recoverInterrupted(new Date("2026-08-11T01:36:00.000Z"))).toBe(1)
  })

  it("classifier 长时间等待时 heartbeat 阻止第二 worker stale reclaim", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-11T01:00:00.000Z") })
    const harness = await createReferenceHarness()
    harness.config.updateProfile("memory", { timeoutSeconds: 3_600 })
    const observed = seedObservation(harness, { index: 1 })
    let release: (() => void) | undefined
    harness.setHandler(() => new Promise((resolve) => {
      release = () => resolve({ proposals: [proposal({
        observationIds: [observed.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })] })
    }))
    const firstRun = harness.worker.runOnce(new Date())
    expect(harness.classify).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    harness.config.updateProfile("memory", { timeoutSeconds: 30 })
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
    const otherDatabase = await RuntimeDatabase.open(harness.databasePath)
    harness.registerDatabase(otherDatabase)
    const otherClassify = vi.fn(async () => ({ proposals: [] }))
    const otherWorker = harness.workerFor(otherDatabase, { classify: otherClassify })

    expect(await otherWorker.runOnce(new Date())).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(otherClassify).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT processing_status,lock_token FROM learning_source_observations WHERE id=?")
      .get(observed.observationId)).toEqual({ processing_status: "running", lock_token: expect.any(String) })

    release?.()
    expect(await firstRun).toEqual({ processed: 1, createdVersions: 0, conflicts: 0, styleVersions: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("两个 worker 并发时 SQLite 原子 claim 保证观察只处理一次", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    const otherDatabase = await RuntimeDatabase.open(harness.databasePath)
    harness.registerDatabase(otherDatabase)
    const otherWorker = harness.workerFor(otherDatabase)

    const results = await Promise.all([
      harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z")),
      otherWorker.runOnce(new Date("2026-08-11T01:00:00.000Z")),
    ])

    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(2)
    expect(harness.classify).toHaveBeenCalledTimes(1)
    expect(harness.database.prepare(`SELECT id,processing_status,attempt_count FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([
      { id: first.observationId, processing_status: "completed", attempt_count: 1 },
      { id: second.observationId, processing_status: "completed", attempt_count: 1 },
    ])
  })

  it("六类提议分流：style 只聚合，临时/动作/general/noop 不建业务记忆", async () => {
    const harness = await createReferenceHarness()
    const observations = Array.from({ length: 7 }, (_, index) => seedObservation(harness, { index: index + 1 }))
    harness.setHandler(async () => ({
      proposals: [
        proposal({ observationIds: [observations[0]!.observationId], classification: "style", codeEvidencePaths: [] }),
        proposal({ observationIds: [observations[1]!.observationId], classification: "correction", title: "纠正规则", codeEvidencePaths: [] }),
        proposal({ observationIds: [observations[2]!.observationId], classification: "business_rule", title: "业务规则", codeEvidencePaths: [] }),
        proposal({ observationIds: [observations[3]!.observationId], classification: "ephemeral" }),
        proposal({ observationIds: [observations[4]!.observationId], classification: "action_result" }),
        proposal({ observationIds: [observations[5]!.observationId], classification: "general" }),
        proposal({ observationIds: [observations[6]!.observationId], classification: "business_rule", action: "noop" }),
      ],
    }))

    const result = await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(result).toEqual({ processed: 7, createdVersions: 2, conflicts: 0, styleVersions: 1 })
    expect(harness.database.prepare("SELECT title,status FROM memory_versions ORDER BY title").all()).toEqual([
      { title: "业务规则", status: "candidate" },
      { title: "纠正规则", status: "candidate" },
    ])
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 1 })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM learning_source_observations
      WHERE processing_status='completed'`).get()).toEqual({ count: 7 })
    const terminalRows = harness.database.prepare(`SELECT observation_id,classification,action,risk,outcome,reason_code,
      memory_version_id,operator_style_version_id FROM reference_learning_results`).all() as Array<Record<string, unknown>>
    const terminalByObservation = new Map(terminalRows.map((row) => [row.observation_id, row]))
    expect(terminalRows).toHaveLength(7)
    expect(terminalByObservation.get(observations[0]!.observationId)).toEqual({
      observation_id: observations[0]!.observationId,
      classification: "style", action: "add", risk: "low", outcome: "style_candidate", reason_code: "style_candidate",
      memory_version_id: null, operator_style_version_id: expect.any(String),
    })
    ;[1, 2].forEach((index) => expect(terminalByObservation.get(observations[index]!.observationId)).toEqual({
      observation_id: observations[index]!.observationId,
      classification: index === 1 ? "correction" : "business_rule",
      action: "add", risk: "low", outcome: "candidate", reason_code: "memory_candidate",
      memory_version_id: expect.any(String), operator_style_version_id: null,
    }))
    ;[3, 4, 5].forEach((index) => expect(terminalByObservation.get(observations[index]!.observationId)).toEqual({
      observation_id: observations[index]!.observationId,
      classification: ["ephemeral", "action_result", "general"][index - 3],
      action: "add", risk: "low", outcome: "noop", reason_code: "non_learnable_classification",
      memory_version_id: null, operator_style_version_id: null,
    }))
    expect(terminalByObservation.get(observations[6]!.observationId)).toEqual({
      observation_id: observations[6]!.observationId,
      classification: "business_rule", action: "noop", risk: "low", outcome: "noop", reason_code: "proposal_noop",
      memory_version_id: null, operator_style_version_id: null,
    })
  })

  it.each([
    ["evidence 中的订单号", "订单号 SF202608110001 只代表这一次查询结果", {}],
    ["proposal title 中的时间戳", "长期规则说明".repeat(20), { title: "2026-08-11 10:30:45 的处理结论" }],
    ["proposal content 中的实时状态", "长期规则说明".repeat(20), { content: "这笔订单当前状态为成功" }],
    ["evidence 中的临时 URL 和 IP", `长期规则说明${"应依据当前代码理解通用行为".repeat(20)} 临时签名地址 https://temporary.example/callback?sign=once 当前出口 IP 10.20.30.40`, {}],
    ["evidence 中的单次故障", `长期规则说明${"应依据当前代码理解通用行为".repeat(20)} 本次请求刚才偶发 timeout`, {}],
    ["proposal reason 中的动作结果", "长期规则说明".repeat(20), { reason: "这个已经处理并发给运营了" }],
    ["evidence 中的一次性短回复", `长期规则说明${"应依据当前代码理解通用行为".repeat(20)} 已处理 已发 已加 已改 稍等 好的`, {}],
  ] as const)("确定性禁学门拒绝%s，即使模型恶意标成 business_rule/correction + low", async (_label, evidence, overrides) => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1, referenceText: evidence })
    const second = seedObservation(harness, { index: 2, referenceText: evidence })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      classification: _label.includes("proposal") ? "correction" : "business_rule",
      title: "长期通用规则",
      content: "相同业务条件应遵循当前发布代码中的固定处理方式",
      risk: "low",
      ...overrides,
    })] }))

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare(`SELECT processing_status FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([{ processing_status: "completed" }, { processing_status: "completed" }])
  })

  it("确定性禁学门也检查同一 observation 中交给模型的 question/context evidence", async () => {
    const harness = await createReferenceHarness()
    const questionText = "订单号 SF202608119999 当前状态为失败 只代表这一次查询"
    const referenceText = "长期通用规则应结合当前发布代码理解".repeat(20)
    const first = seedObservation(harness, { index: 1, questionText, referenceText })
    const second = seedObservation(harness, { index: 2, questionText, referenceText })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      classification: "business_rule",
      title: "长期通用规则",
      content: "相同业务条件应遵循当前发布代码中的固定处理方式",
      risk: "low",
    })] }))

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
  })

  it.each([
    ["仅时间", "本次结果记录于 10:30:45"],
    ["Unix 时间戳", "本次结果时间戳 1723343445"],
    ["常见单号", "单号 SF202608118888 当前只代表这一笔"],
    ["英文实时状态", "订单状态 SUCCESS"],
    ["全英文实时状态", "status=SUCCESS"],
    ["伪长期前缀实时状态", "长期规则 status=SUCCESS"],
    ["裸 IPv6 临时地址", "临时出口地址 2001:db8::1"],
    ["动作完成表达", "处理完成"],
    ["英文短回复", "OK"],
    ["中文短回复", "等下"],
  ] as const)("确定性禁学门补齐%s反例", async (_label, evidence) => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1, referenceText: evidence })
    const second = seedObservation(harness, { index: 2, referenceText: evidence })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      classification: "correction",
      title: "长期通用规则",
      content: "相同业务条件应遵循当前发布代码中的固定处理方式",
      risk: "low",
    })] }))

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
  })

  it("脱敏后的无提示签名 URL 仍携带预算内临时类别并触发禁学", async () => {
    const harness = await createReferenceHarness()
    const evidence = `${"长期通用规则应结合当前发布代码理解".repeat(40)} https://temporary.example/callback?sign=once`
    const first = seedObservation(harness, { index: 1, referenceText: evidence })
    const second = seedObservation(harness, { index: 2, referenceText: evidence })
    harness.setHandler(async (input) => {
      const modelReference = input.threadContexts[0]?.messages.find((message) => message.role === "reference")?.safeText ?? ""
      expect(modelReference).toContain("◈")
      expect(modelReference).not.toContain("sign=once")
      return { proposals: [proposal({
        observationIds: [first.observationId, second.observationId],
        classification: "correction",
        title: "长期通用规则",
        content: "相同业务条件应遵循当前发布代码中的固定处理方式",
        risk: "low",
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
  })

  it("原始菱形项目符号不会冒充系统临时 URL 类别而误触禁学", async () => {
    const harness = await createReferenceHarness()
    const evidence = "◈ 固定回调规则应长期使用"
    const first = seedObservation(harness, { index: 1, referenceText: evidence })
    const second = seedObservation(harness, { index: 2, referenceText: evidence })
    harness.setHandler(async (input) => {
      const modelReferences = input.threadContexts.map((context) => (
        context.messages.find((message) => message.role === "reference")?.safeText ?? ""
      ))
      expect(modelReferences.every((safeText) => safeText.includes("原文菱形符号"))).toBe(true)
      expect(modelReferences.every((safeText) => !safeText.includes("◈"))).toBe(true)
      return { proposals: [proposal({
        observationIds: [first.observationId, second.observationId],
        title: "固定回调规则",
        content: "固定回调规则应长期使用",
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 1, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "active" })
  })

  it.each([
    ["黑方块", "ab◼cd"],
    ["菱形", "ab◈cd"],
    ["legacy marker", "ab[已脱敏]cd"],
  ])("配置 secret 自身含%s literal 时整条 fail closed", async (_label, configuredSecret) => {
    const harness = await createReferenceHarness()
    const timestamp = "2026-08-11T00:00:00.000Z"
    harness.database.insertDatabaseResource({
      id: crypto.randomUUID(),
      projectId: harness.projectId,
      serviceId: harness.serviceId,
      alias: "marker-secret",
      engine: "mysql",
      host: "marker-secret.internal.example",
      port: 3306,
      database: "marker_secret_database",
      username: "marker_secret_operator",
      password: configuredSecret,
      timezone: "Asia/Shanghai",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const observed = seedObservation(harness, {
      index: 1,
      referenceText: `customCredential=${configuredSecret}`,
      questionText: "长期安全问题描述应结合当前发布代码理解通用处理方式".repeat(80),
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(observed.observationId)).toEqual({ processing_status: "ignored" })
  })

  it("worker 4k 切点完整保留单字符临时 URL 类别标记", async () => {
    const harness = await createReferenceHarness()
    const evidence = `${"安".repeat(3_999)}https://temporary.example/callback?sign=once`
    const first = seedObservation(harness, { index: 1, referenceText: evidence })
    const second = seedObservation(harness, { index: 2, referenceText: evidence })
    harness.setHandler(async (input) => {
      const modelReferences = input.threadContexts.map((context) => (
        context.messages.find((message) => message.role === "reference")?.safeText ?? ""
      ))
      expect(modelReferences).toEqual([
        `${"安".repeat(3_999)}◈`,
        `${"安".repeat(3_999)}◈`,
      ])
      return { proposals: [proposal({
        observationIds: [first.observationId, second.observationId],
        title: "长期通用规则",
        content: "相同业务条件应遵循当前发布代码中的固定处理方式",
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
  })

  it("固定 URL/IP、固定配置与周期时间长期规则不被一次性禁学门误杀", async () => {
    const harness = await createReferenceHarness()
    const observations = Array.from({ length: 10 }, (_, index) => seedObservation(harness, {
      index: index + 1,
      referenceText: "长期通用规则应结合当前发布代码理解",
    }))
    harness.setHandler(async () => ({ proposals: [
      proposal({
        observationIds: observations.slice(0, 2).map((observation) => observation.observationId),
        title: "固定回调地址规则",
        content: "固定回调地址 https://api.example/callback 应长期使用",
      }),
      proposal({
        observationIds: observations.slice(2, 4).map((observation) => observation.observationId),
        title: "固定白名单规则",
        content: "固定白名单 IP 203.0.113.10 应长期使用",
      }),
      proposal({
        observationIds: observations.slice(4, 6).map((observation) => observation.observationId),
        title: "固定重试规则",
        content: "系统已配置固定重试规则",
      }),
      proposal({
        observationIds: observations.slice(6, 8).map((observation) => observation.observationId),
        title: "固定每日对账时间",
        content: "每日 10:30 执行对账",
      }),
      proposal({
        observationIds: observations.slice(8, 10).map((observation) => observation.observationId),
        title: "状态枚举含义",
        content: "status=SUCCESS 表示成功终态",
      }),
    ] }))

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 10, createdVersions: 5, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT status,COUNT(*) AS count FROM memory_versions GROUP BY status").all())
      .toEqual([{ status: "active", count: 5 }])
  })

  it("整批预算截掉的 evidence 尾部不参与禁学，模型只基于最终可见片段提议", async () => {
    const harness = await createReferenceHarness()
    harness.config.updateSettings({ learningBatchSize: 30 })
    const visiblePrefix = "长期通用规则应结合当前发布代码理解".repeat(180)
    const observations = Array.from({ length: 30 }, (_, index) => seedObservation(harness, {
      index: index + 1,
      referenceText: `${visiblePrefix} 订单号 SF20260811${String(index).padStart(4, "0")} https://temporary.example/callback?sign=once`,
    }))
    harness.setHandler(async (input) => {
      expect(input.threadContexts).toHaveLength(30)
      expect(input.threadContexts[0]?.messages.find((message) => message.role === "reference")?.safeText)
        .not.toContain("订单号")
      expect(input.threadContexts[0]?.messages.find((message) => message.role === "reference")?.safeText)
        .not.toMatch(/[◼◈]/u)
      return { proposals: [proposal({
        observationIds: observations.map((observation) => observation.observationId),
        title: "长期通用规则",
        content: "相同业务条件应遵循当前发布代码中的固定处理方式",
      })] }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 30, createdVersions: 1, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "active" })
  })

  it("观察自身风险参与确定性下限且 high 永不自动 active", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1, risk: "high" })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      title: "订单状态说明",
      content: "处理中表示还在等待上游结果",
      risk: "low",
    })] }))

    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(harness.database.prepare("SELECT risk,status FROM memory_versions").get()).toEqual({
      risk: "high",
      status: "candidate",
    })
  })

  it("群停用或重绑到其他服务后旧观察失去 claim 授权", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    const otherServiceId = crypto.randomUUID()
    const timestamp = "2026-08-11T00:10:00.000Z"
    harness.database.prepare(`INSERT INTO project_services(
      id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      otherServiceId, harness.projectId, "other", "其他服务", "印度", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
    )
    harness.database.prepare("UPDATE telegram_groups SET service_id=?,updated_at=? WHERE id=?")
      .run(otherServiceId, timestamp, harness.groupId)

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(observed.observationId)).toEqual({ processing_status: "ignored" })
  })

  it("异常绑定项目服务的技术告警群观察在 claim 前忽略且分类器调用为零", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    harness.database.prepare("UPDATE telegram_groups SET purpose='technical_alert',updated_at=? WHERE id=?")
      .run("2026-08-11T00:30:00.000Z", harness.groupId)

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.classify).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT processing_status,attempt_count,lock_token,current_run_id
      FROM learning_source_observations WHERE id=?`).get(observed.observationId)).toEqual({
      processing_status: "ignored", attempt_count: 0, lock_token: null, current_run_id: null,
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_maintenance_runs").get()).toEqual({ count: 0 })
  })

  it.each([
    ["batch 外 observation", (_id: string) => proposal({ observationIds: ["00000000-0000-4000-8000-000000009999"] })],
    ["scope 不一致", (id: string) => proposal({ observationIds: [id], scope: "other" })],
    ["region 不一致", (id: string) => proposal({ observationIds: [id], region: "巴基斯坦" })],
    ["branch 不一致", (id: string) => proposal({ observationIds: [id], branch: "dev" })],
    ["路径不存在", (id: string) => proposal({ observationIds: [id], codeEvidencePaths: ["java-project/src/Missing.ts"] })],
  ] as const)("拒绝模型的%s证据并在写记忆前让批次失败", async (_label, makeProposal) => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    harness.setHandler(async () => ({ proposals: [makeProposal(observed.observationId)] }))

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT processing_status,lock_token FROM learning_source_observations WHERE id=?")
      .get(observed.observationId)).toEqual({ processing_status: "failed", lock_token: null })
  })

  it.each([
    ["snapshotId", (snapshot: ProjectCodeSnapshot) => ({ ...snapshot, snapshotId: crypto.randomUUID() })],
    ["syncBatchId", (snapshot: ProjectCodeSnapshot) => ({ ...snapshot, syncBatchId: crypto.randomUUID() })],
    ["configurationFingerprint", (snapshot: ProjectCodeSnapshot) => ({ ...snapshot, configurationFingerprint: "d".repeat(64) })],
    ["commit", (snapshot: ProjectCodeSnapshot) => ({ ...snapshot, commit: "java-project@cccccccc, sfzf-web@dddddddd" })],
    ["repository 集合", (snapshot: ProjectCodeSnapshot) => ({
      ...snapshot,
      repositories: snapshot.repositories.map((repository, index) => index === 0
        ? { ...repository, commit: "c".repeat(40) }
        : repository),
    })],
  ] as const)("classifier 返回后 current snapshot 的%s变化会整批失败且不写旧提议", async (_label, mutate) => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    let release: (() => void) | undefined
    harness.setHandler(() => new Promise((resolve) => {
      release = () => resolve({ proposals: [proposal({
        observationIds: [first.observationId, second.observationId],
      })] })
    }))

    const original = harness.getSnapshot()
    const running = harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    expect(harness.classify).toHaveBeenCalledTimes(1)
    harness.setSnapshot(mutate(original))
    release?.()

    expect(await running).toEqual({ processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare(`SELECT processing_status FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([{ processing_status: "failed" }, { processing_status: "failed" }])
  })

  it.each([
    ["撤销数字角色", (database: RuntimeDatabase, context: { sourceUserId: string }) => {
      database.prepare("UPDATE telegram_roles SET telegram_user_id='299999',updated_at=? WHERE telegram_user_id=?")
        .run("2026-08-11T00:30:00.000Z", context.sourceUserId)
    }],
    ["停用角色", (database: RuntimeDatabase, context: { sourceUserId: string }) => {
      database.prepare("UPDATE telegram_roles SET enabled=0,updated_at=? WHERE telegram_user_id=?")
        .run("2026-08-11T00:30:00.000Z", context.sourceUserId)
    }],
    ["关闭角色学习授权", (database: RuntimeDatabase, context: { sourceUserId: string }) => {
      database.prepare("UPDATE telegram_roles SET learning_source_enabled=0,updated_at=? WHERE telegram_user_id=?")
        .run("2026-08-11T00:30:00.000Z", context.sourceUserId)
    }],
    ["停用来源群", (database: RuntimeDatabase, context: { groupId: string }) => {
      database.prepare("UPDATE telegram_groups SET enabled=0,updated_at=? WHERE id=?")
        .run("2026-08-11T00:30:00.000Z", context.groupId)
    }],
    ["改绑服务", (database: RuntimeDatabase, context: { groupId: string; projectId: string }) => {
      const serviceId = crypto.randomUUID()
      const timestamp = "2026-08-11T00:30:00.000Z"
      database.prepare(`INSERT INTO project_services(
        id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        serviceId, context.projectId, "rebound", "改绑服务", "印度", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
      )
      database.prepare("UPDATE telegram_groups SET service_id=?,updated_at=? WHERE id=?").run(serviceId, timestamp, context.groupId)
    }],
    ["改绑项目", (database: RuntimeDatabase, context: { groupId: string }) => {
      const projectId = crypto.randomUUID()
      const timestamp = "2026-08-11T00:30:00.000Z"
      database.prepare(`INSERT INTO projects(
        id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "rebound", "改绑项目", "", 1, "scope", timestamp, timestamp)
      database.prepare("UPDATE telegram_groups SET project_id=?,updated_at=? WHERE id=?").run(projectId, timestamp, context.groupId)
    }],
    ["修改 scope", (database: RuntimeDatabase, context: { groupId: string }) => {
      database.prepare("UPDATE telegram_groups SET knowledge_scope='other',updated_at=? WHERE id=?")
        .run("2026-08-11T00:30:00.000Z", context.groupId)
    }],
    ["修改 region", (database: RuntimeDatabase, context: { serviceId: string }) => {
      database.prepare("UPDATE project_services SET region='巴基斯坦',updated_at=? WHERE id=?")
        .run("2026-08-11T00:30:00.000Z", context.serviceId)
    }],
    ["修改 branch", (database: RuntimeDatabase, context: { serviceId: string }) => {
      database.prepare("UPDATE project_services SET branch='release',updated_at=? WHERE id=?")
        .run("2026-08-11T00:30:00.000Z", context.serviceId)
    }],
    ["停用服务", (database: RuntimeDatabase, context: { serviceId: string }) => {
      database.prepare("UPDATE project_services SET enabled=0,updated_at=? WHERE id=?")
        .run("2026-08-11T00:30:00.000Z", context.serviceId)
    }],
    ["停用项目", (database: RuntimeDatabase, context: { projectId: string }) => {
      database.prepare("UPDATE projects SET enabled=0,updated_at=? WHERE id=?")
        .run("2026-08-11T00:30:00.000Z", context.projectId)
    }],
  ] as const)("classifier 阻塞期间%s后最终授权逐条 fail closed 且无部分写", async (_label, mutate) => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    let release: (() => void) | undefined
    harness.setHandler(() => new Promise((resolve) => {
      release = () => resolve({
        proposals: [
          proposal({ observationIds: [first.observationId], classification: "style", codeEvidencePaths: [] }),
          proposal({ observationIds: [first.observationId, second.observationId] }),
        ],
      })
    }))

    const running = harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    expect(harness.classify).toHaveBeenCalledTimes(1)
    mutate(harness.database, {
      sourceUserId: first.sourceUserId,
      groupId: harness.groupId,
      projectId: harness.projectId,
      serviceId: harness.serviceId,
    })
    release?.()

    expect(await running).toEqual({ processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_version_evidence").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_style_version_evidence").get()).toEqual({ count: 0 })
    expect(harness.database.prepare(`SELECT processing_status,lock_token FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([
      { processing_status: "failed", lock_token: null },
      { processing_status: "failed", lock_token: null },
    ])
  })

  it("classifier 阻塞期间来源群改为技术告警用途时 final auth fail closed", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    let release: (() => void) | undefined
    harness.setHandler(() => new Promise((resolve) => {
      release = () => resolve({ proposals: [proposal({
        observationIds: [first.observationId, second.observationId],
      })] })
    }))

    const running = harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    expect(harness.classify).toHaveBeenCalledTimes(1)
    harness.database.prepare("UPDATE telegram_groups SET purpose='technical_alert',updated_at=? WHERE id=?")
      .run("2026-08-11T00:30:00.000Z", harness.groupId)
    release?.()

    expect(await running).toEqual({ processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 0 })
    expect(harness.database.prepare(`SELECT processing_status,lock_token FROM learning_source_observations
      ORDER BY created_at,id`).all()).toEqual([
      { processing_status: "failed", lock_token: null },
      { processing_status: "failed", lock_token: null },
    ])
  })

  it("current snapshot 二次读取与提议写入共享 SQLite 写栅栏", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
    })] }))
    const publisher = await RuntimeDatabase.open(harness.databasePath)
    harness.registerDatabase(publisher)
    publisher.prepare("PRAGMA busy_timeout=0").run()
    let snapshotReads = 0
    let publicationBlocked = false
    let publicationSucceeded = false
    harness.setSnapshotReadHook((current) => {
      snapshotReads += 1
      if (snapshotReads !== 2) return
      try {
        publisher.prepare("UPDATE runtime_settings SET updated_at=? WHERE id=1")
          .run("2026-08-11T01:00:00.001Z")
        publicationSucceeded = true
        harness.setSnapshot({ ...current, snapshotId: crypto.randomUUID() })
      } catch (error) {
        publicationBlocked = String(error).includes("database is locked")
      }
    })

    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 2, createdVersions: 1, conflicts: 0, styleVersions: 0,
    })
    expect(snapshotReads).toBe(2)
    expect(publicationSucceeded).toBe(false)
    expect(publicationBlocked).toBe(true)
    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "active" })
  })

  it("fallback 快照不交给模型且危险主题即使模型报 low 也强制 high", async () => {
    const fallbackHarness = await createReferenceHarness()
    const fallbackObservation = seedObservation(fallbackHarness, { index: 1 })
    fallbackHarness.setSnapshot({ ...fallbackHarness.getSnapshot(), syncState: "fallback" })
    expect(await fallbackHarness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(fallbackHarness.classify).not.toHaveBeenCalled()
    expect(fallbackHarness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(fallbackObservation.observationId)).toEqual({ processing_status: "failed" })

    await cleanupReferenceHarnesses()
    const riskHarness = await createReferenceHarness()
    const risky = seedObservation(riskHarness, { index: 1 })
    riskHarness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [risky.observationId],
      title: "生产数据库密码修改规则",
      content: "修改生产数据库密码后重启服务",
      risk: "low",
      codeEvidencePaths: [],
    })] }))
    await riskHarness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(riskHarness.database.prepare("SELECT risk,status FROM memory_versions").get()).toEqual({ risk: "high", status: "candidate" })
  })

  it("start 按现有学习间隔启动，stop 等待当前任务并阻止后续 claim，status 展示 reference 队列", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-11T01:00:00.000Z") })
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })

    harness.worker.start()
    expect(harness.worker.status()).toEqual(expect.objectContaining({ running: true, pending: 1, completed: 0 }))
    await vi.advanceTimersByTimeAsync(5_001)
    expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(first.observationId)).toEqual({ processing_status: "completed" })

    await harness.worker.stop()
    const second = seedObservation(harness, { index: 2 })
    await vi.advanceTimersByTimeAsync(65_000)
    expect(harness.worker.status()).toEqual(expect.objectContaining({ running: false, pending: 1, completed: 1 }))
    expect(harness.database.prepare("SELECT processing_status FROM learning_source_observations WHERE id=?")
      .get(second.observationId)).toEqual({ processing_status: "pending" })
  })

  it("定时运行的瞬时拒绝会被吸收并在下个学习间隔继续运行", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-11T01:00:00.000Z") })
    const harness = await createReferenceHarness()
    const runOnce = vi.spyOn(harness.worker, "runOnce")
      .mockRejectedValueOnce(new Error("temporary worker failure"))
      .mockResolvedValue({ processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0 })

    harness.worker.start()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(harness.worker.status().busy).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(runOnce).toHaveBeenCalledTimes(2)
    await harness.worker.stop()
  })

  it("claim 后维护记录创建失败会释放 token 并标记观察可重试", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-11T01:00:00.000Z") })
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    vi.spyOn(harness.database, "insertMaintenanceRun").mockImplementationOnce(() => {
      throw new Error("maintenance insert failure")
    })

    await expect(harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))).resolves.toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })
    expect(harness.database.prepare(`SELECT processing_status,attempt_count,lock_token,locked_at FROM learning_source_observations
      WHERE id=?`).get(observed.observationId)).toEqual({
      processing_status: "pending", attempt_count: 0, lock_token: null, locked_at: null,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("手工触发与 timer/stop 共享同一个 activeRun 且 stop 后拒绝新批次", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    let release: (() => void) | undefined
    harness.setHandler(() => new Promise((resolve) => {
      release = () => resolve({ proposals: [proposal({
        observationIds: [observed.observationId], classification: "general", action: "noop", codeEvidencePaths: [],
      })] })
    }))

    const manual = harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    await vi.waitFor(() => expect(harness.worker.status().busy).toBe(true))
    const duplicate = harness.worker.runOnce(new Date("2026-08-11T01:00:01.000Z"))
    const stopping = harness.worker.stop()
    expect(await harness.worker.runOnce(new Date("2026-08-11T01:00:02.000Z"))).toEqual({
      processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0,
    })

    release?.()
    expect(await duplicate).toEqual(await manual)
    await stopping
    expect(harness.classify).toHaveBeenCalledTimes(1)
  })

  it("control 状态和手动运行以 reference worker 为主，同时安全排空 legacy", async () => {
    const harness = await createReferenceHarness()
    const legacy = {
      runOnce: vi.fn(async () => ({ processed: 3, createdVersions: 0, conflicts: 0 })),
    }
    const reference = {
      status: vi.fn(() => ({ running: true, busy: false, pending: 2, processing: 1, failed: 1, completed: 9 })),
      runOnce: vi.fn(async () => ({ processed: 2, createdVersions: 1, conflicts: 0, styleVersions: 0 })),
    }
    const ControlWithReference = RuntimeControlService as unknown as new (...args: unknown[]) => RuntimeControlService
    const control = new ControlWithReference(
      harness.database,
      { status: async () => ({ available: true, authenticated: true, version: "test", message: "ok" }) },
      { status: () => ({ running: true, botLoops: 1, userConnections: 0, lastUpdateAt: null, lastErrorAt: null, lastErrorCode: null }) },
      {},
      legacy,
      reference,
    )

    expect((await control.status()).learning).toEqual(expect.objectContaining({
      pending: 4,
      completed: 9,
      activeStyle: null,
      reference: { running: true, busy: false, pending: 2, processing: 1, failed: 1, completed: 9, lastRun: null },
      legacy: { pending: 0, processing: 0, failed: 0, completed: 0 },
    }))
    expect(await control.runLearning()).toEqual({ processed: 2, createdVersions: 1, conflicts: 0, styleVersions: 0 })
    expect(legacy.runOnce).toHaveBeenCalledTimes(1)
    expect(reference.runOnce).toHaveBeenCalledTimes(1)
  })
})
