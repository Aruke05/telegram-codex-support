import { afterEach, describe, expect, it } from "vitest"

import {
  cleanupReferenceHarnesses,
  createReferenceHarness,
  proposal,
  seedObservation,
} from "./reference-worker-fixture.js"

afterEach(cleanupReferenceHarnesses)

describe("人工参考规则确定性 promotion", () => {
  it("同一规范化规则具备两个不同线程和当前精确代码证据时直接 active", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      content: "处理中   表示系统仍在等待上游结果",
    })] }))

    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(harness.database.prepare("SELECT status,risk FROM memory_versions").get()).toEqual({ status: "active", risk: "low" })
    expect(harness.database.prepare(`SELECT COUNT(DISTINCT observation.thread_id) AS count
      FROM memory_version_evidence evidence
      JOIN memory_events event ON event.id=evidence.event_id
      JOIN learning_source_observations observation ON observation.id=event.source_ref
      WHERE event.type='ai_observation'`).get()).toEqual({ count: 2 })
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({
      current_version_id: expect.any(String),
    })
  })

  it("跨批次内容空白差异会归一为同一规则并在第二个不同线程后 promotion", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId],
      content: "处理中 表示系统仍在等待上游结果",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "candidate" })

    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [second.observationId],
      content: "  处理中   表示系统仍在等待上游结果  ",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 1 })
    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "active" })
  })

  it("第二个线程可复用同一当前 snapshot 已验证的精确代码证据", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    harness.setHandler(async () => ({ proposals: [proposal({ observationIds: [first.observationId] })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "candidate" })

    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [second.observationId],
      codeEvidencePaths: [],
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    expect(harness.database.prepare("SELECT status FROM memory_versions").get()).toEqual({ status: "active" })
  })

  it("持久化后队列重试同一规则会复用 observation 与 snapshot 证据", async () => {
    const harness = await createReferenceHarness()
    const observed = seedObservation(harness, { index: 1 })
    harness.setHandler(async () => ({ proposals: [proposal({ observationIds: [observed.observationId] })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
    expect(harness.database.prepare("SELECT type,COUNT(*) AS count FROM memory_events GROUP BY type ORDER BY type").all()).toEqual([
      { type: "ai_observation", count: 1 },
      { type: "code", count: 1 },
    ])

    harness.database.prepare(`UPDATE learning_source_observations SET processing_status='failed',lock_token=NULL,
      locked_at=NULL WHERE id=?`).run(observed.observationId)
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    expect(harness.database.prepare("SELECT type,COUNT(*) AS count FROM memory_events GROUP BY type ORDER BY type").all()).toEqual([
      { type: "ai_observation", count: 1 },
      { type: "code", count: 1 },
    ])
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toEqual({ count: 1 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM memory_version_evidence").get()).toEqual({ count: 2 })
  })

  it("后续更高风险证据产生新的高风险候选并永久阻止 low 自动降级", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    harness.setHandler(async () => ({ proposals: [proposal({ observationIds: [first.observationId] })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [second.observationId],
      risk: "high",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    expect(harness.database.prepare("SELECT version_number,status,risk FROM memory_versions ORDER BY version_number").all()).toEqual([
      { version_number: 1, status: "superseded", risk: "low" },
      { version_number: 2, status: "candidate", risk: "high" },
    ])
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
  })

  it.each(["medium", "high"] as const)(
    "已 active low 收到可信 %s evidence 时立即退出回答可见状态",
    async (risk) => {
      const harness = await createReferenceHarness()
      const first = seedObservation(harness, { index: 1 })
      const second = seedObservation(harness, { index: 2 })
      harness.setHandler(async () => ({ proposals: [proposal({
        observationIds: [first.observationId, second.observationId],
      })] }))
      await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
      const active = harness.database.prepare("SELECT id FROM memory_versions WHERE status='active'").get() as { id: string }
      expect(harness.knowledge.listAnswerMemories({ scope: "scope", region: "印度", branch: "main" })
        .map((memory) => memory.id)).toEqual([active.id])

      const risky = seedObservation(harness, { index: 3, risk })
      harness.setHandler(async () => ({ proposals: [proposal({
        observationIds: [risky.observationId],
        risk: "low",
      })] }))
      await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

      expect(harness.database.prepare("SELECT version_number,status,risk FROM memory_versions ORDER BY version_number").all()).toEqual([
        { version_number: 1, status: "superseded", risk: "low" },
        { version_number: 2, status: "conflict", risk },
      ])
      expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
      expect(harness.knowledge.listAnswerMemories({ scope: "scope", region: "印度", branch: "main" })).toEqual([])
    },
  )

  it("同风险 conflict 保留 active 后再出现 high evidence 仍会下线旧 active", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    const sameRiskConflict = seedObservation(harness, { index: 3 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [sameRiskConflict.observationId],
      action: "conflict",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))
    expect(harness.database.prepare("SELECT status FROM memory_versions ORDER BY version_number").all()).toEqual([
      { status: "active" },
      { status: "conflict" },
    ])

    const risky = seedObservation(harness, { index: 4, risk: "high" })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [risky.observationId],
      risk: "low",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:02:00.000Z"))

    expect(harness.database.prepare("SELECT status,risk FROM memory_versions ORDER BY version_number").all()).toEqual([
      { status: "superseded", risk: "low" },
      { status: "superseded", risk: "low" },
      { status: "conflict", risk: "high" },
    ])
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
    expect(harness.knowledge.listAnswerMemories({ scope: "scope", region: "印度", branch: "main" })).toEqual([])
  })

  it("同一 fact 的不同结论带来 high evidence 时也会下线旧 active low", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    const riskyConclusion = seedObservation(harness, { index: 3, risk: "high" })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [riskyConclusion.observationId],
      content: "处理中表示必须人工修改订单状态",
      risk: "low",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    expect(harness.database.prepare("SELECT status,risk FROM memory_versions ORDER BY version_number").all()).toEqual([
      { status: "superseded", risk: "low" },
      { status: "conflict", risk: "high" },
    ])
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
    expect(harness.knowledge.listAnswerMemories({ scope: "scope", region: "印度", branch: "main" })).toEqual([])
  })

  it("legacy active low 与同内容 conflict high 并存时后续 high evidence 仍下线 active", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    const initialRisk = seedObservation(harness, { index: 3, risk: "high" })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [initialRisk.observationId],
      risk: "low",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))
    const versions = harness.database.prepare(`SELECT id,status,risk FROM memory_versions
      ORDER BY version_number`).all() as Array<{ id: string; status: string; risk: string }>
    const low = versions[0]!
    const high = versions[1]!
    harness.database.transaction(() => {
      harness.database.prepare("UPDATE memory_versions SET status='active',valid_to=NULL WHERE id=?").run(low.id)
      harness.database.prepare("UPDATE memory_versions SET status='conflict',valid_to=NULL WHERE id=?").run(high.id)
      const fact = harness.database.prepare("SELECT id FROM memory_facts").get() as { id: string }
      harness.database.setCurrentVersion(fact.id, low.id)
    })
    expect(harness.knowledge.listAnswerMemories({ scope: "scope", region: "印度", branch: "main" })
      .map((memory) => memory.id)).toEqual([low.id])
    const generationBeforeRetirement = harness.database.memoryGeneration()

    const subsequentRisk = seedObservation(harness, { index: 4, risk: "high" })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [subsequentRisk.observationId],
      risk: "low",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:02:00.000Z"))

    expect(harness.database.prepare("SELECT id,status,risk FROM memory_versions ORDER BY version_number").all()).toEqual([
      { id: low.id, status: "superseded", risk: "low" },
      { id: high.id, status: "conflict", risk: "high" },
    ])
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
    expect(harness.knowledge.listAnswerMemories({ scope: "scope", region: "印度", branch: "main" })).toEqual([])
    expect(harness.database.memoryGeneration()).toBe(generationBeforeRetirement + 1)
  })

  it.each([
    ["只有一个线程", { sameThread: true, risk: "low" as const, code: true }],
    ["缺少精确代码证据", { sameThread: false, risk: "low" as const, code: false }],
    ["高风险", { sameThread: false, risk: "high" as const, code: true }],
  ] as const)("%s 时保持 candidate 供人工审核", async (_label, options) => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2, ...(options.sameThread ? { threadId: first.threadId } : {}) })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      risk: options.risk,
      codeEvidencePaths: options.code ? ["java-project/src/OrderRule.ts"] : [],
    })] }))

    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(harness.database.prepare("SELECT status,risk FROM memory_versions").get()).toEqual({
      status: "candidate",
      risk: options.risk,
    })
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
  })

  it("现有 active 同主题不同结论形成 conflict 且绝不覆盖 active", async () => {
    const harness = await createReferenceHarness()
    const active = await harness.knowledge.createMemory({
      title: "订单处理中含义",
      content: "处理中表示订单已经成功",
      scope: "scope",
      region: "印度",
      branch: "main",
      source: "human_rule",
      risk: "low",
      confidence: 1,
      actor: "人工审核",
    })
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      content: "处理中表示系统仍在等待上游结果",
    })] }))

    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(harness.database.prepare("SELECT id,status FROM memory_versions ORDER BY version_number").all()).toEqual([
      { id: active.id, status: "active" },
      { id: expect.any(String), status: "conflict" },
    ])
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: active.id })
  })

  it("同主题存在尚未人工解决的 conflict 时不自动 promotion", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId],
      content: "处理中表示系统仍在等待上游结果",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    const conflicting = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [conflicting.observationId],
      content: "处理中表示订单已经成功",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    const reinforcing = seedObservation(harness, { index: 3 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [reinforcing.observationId],
      content: "处理中表示系统仍在等待上游结果",
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:02:00.000Z"))

    expect(harness.database.prepare("SELECT status FROM memory_versions ORDER BY version_number").all()).toEqual([
      { status: "candidate" },
      { status: "conflict" },
    ])
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
  })

  it("模型明确 conflict 时即使证据门槛满足也不自动 active", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
      action: "conflict",
    })] }))

    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    expect(harness.database.prepare("SELECT status,conflict_reason FROM memory_versions").get()).toEqual({
      status: "conflict",
      conflict_reason: expect.any(String),
    })
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: null })
  })

  it("已 active 的同一规则收到显式 conflict 时保留 active 并建立未决冲突版本", async () => {
    const harness = await createReferenceHarness()
    const first = seedObservation(harness, { index: 1 })
    const second = seedObservation(harness, { index: 2 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [first.observationId, second.observationId],
    })] }))
    await harness.worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))

    const conflicting = seedObservation(harness, { index: 3 })
    harness.setHandler(async () => ({ proposals: [proposal({
      observationIds: [conflicting.observationId],
      action: "conflict",
    })] }))
    const result = await harness.worker.runOnce(new Date("2026-08-11T01:01:00.000Z"))

    expect(result.conflicts).toBe(1)
    expect(harness.database.prepare("SELECT version_number,status FROM memory_versions ORDER BY version_number").all()).toEqual([
      { version_number: 1, status: "active" },
      { version_number: 2, status: "conflict" },
    ])
    const active = harness.database.prepare("SELECT id FROM memory_versions WHERE status='active'").get() as { id: string }
    expect(harness.database.prepare("SELECT current_version_id FROM memory_facts").get()).toEqual({ current_version_id: active.id })
  })
})
