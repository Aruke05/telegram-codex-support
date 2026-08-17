import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { MemoryLearningWorker } from "../../src/learning/worker.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "memory-worker-source-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  openDatabases.push(database)
  const knowledge = new RuntimeKnowledgeService(database)
  const learn = vi.fn(async () => ({ proposals: [], summary: "不应调用旧模型" }))
  const worker = new MemoryLearningWorker(
    database,
    new ModelConfigService(database),
    knowledge,
    { learn },
    { readCurrentSnapshot: () => { throw new Error("不应读取代码快照") } },
  )
  return { database, knowledge, learn, worker }
}

async function recordBotResult(
  knowledge: RuntimeKnowledgeService,
  status: "replied" | "ignored" | "escalated",
  index: number,
) {
  return knowledge.recordReply({
    groupId: null,
    accountId: null,
    projectId: null,
    serviceId: null,
    telegramMessageId: `question-${index}`,
    telegramReplyMessageId: status === "replied" ? `answer-${index}` : null,
    service: "service",
    question: `机器人问题 ${index}`,
    answer: status === "replied" ? `机器人回答 ${index}` : "",
    quote: null,
    decision: status === "ignored" ? "ignore" : status === "escalated" ? "escalate" : "reply",
    memoryVersionRefs: [],
    codeRevision: null,
  })
}

describe("旧机器人自学习退役", () => {
  it("机器人 replied ignored escalated 结果不再进入旧学习队列", async () => {
    const { database, knowledge, worker } = await createHarness()
    for (const [index, status] of (["replied", "ignored", "escalated"] as const).entries()) {
      const reply = await recordBotResult(knowledge, status, index)
      worker.enqueue(reply.id)
    }

    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_learning_queue").get()).toEqual({ count: 0 })
  })

  it("遗留队列安全排空为 retired completed 且永不调用模型或代码快照", async () => {
    const { database, knowledge, learn, worker } = await createHarness()
    const first = await recordBotResult(knowledge, "replied", 1)
    const second = await recordBotResult(knowledge, "ignored", 2)
    const timestamp = "2026-08-11T00:00:00.000Z"
    const insert = database.prepare(`INSERT INTO memory_learning_queue(
      reply_id,status,attempts,next_attempt_at,locked_at,last_error,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)`)
    insert.run(first.id, "pending", 0, timestamp, null, null, timestamp, timestamp)
    insert.run(second.id, "running", 1, timestamp, "2026-08-10T23:40:00.000Z", null, timestamp, timestamp)

    const result = await worker.runOnce(new Date("2026-08-11T00:00:00.000Z"))

    expect(result).toEqual({ processed: 2, createdVersions: 0, conflicts: 0 })
    expect(learn).not.toHaveBeenCalled()
    expect(database.prepare(`SELECT status,last_error FROM memory_learning_queue ORDER BY created_at,reply_id`).all()).toEqual([
      { status: "completed", last_error: "legacy_learning_retired" },
      { status: "completed", last_error: "legacy_learning_retired" },
    ])
  })

  it("人工 correction 仍通过确定性入口直接产生 active 记忆", async () => {
    const { knowledge, learn } = await createHarness()
    const reply = await recordBotResult(knowledge, "replied", 1)

    const corrected = await knowledge.correctReply(reply.id, {
      correctedAnswer: "正确答案",
      reason: "人工明确纠正",
      scope: "service",
      region: null,
      branch: "main",
      correctedBy: "人工审核",
    })

    expect(corrected.memory).toEqual(expect.objectContaining({ status: "active", source: "correction" }))
    expect(learn).not.toHaveBeenCalled()
  })
})
