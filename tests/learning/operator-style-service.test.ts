import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { OperatorStyleService } from "../../src/learning/operator-style-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { operatorStyleProfileSchema, operatorStylePrompt } from "../../src/support/operator-style.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "operator-style-service-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const now = "2026-08-11T00:00:00.000Z"
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("00000000-0000-4000-8000-000000000301", "project", "项目", "", 1, "default", now, now)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    "00000000-0000-4000-8000-000000000302", "00000000-0000-4000-8000-000000000301", "service", "服务", "", "Asia/Shanghai",
    null, "main", 1, now, now,
  )
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "00000000-0000-4000-8000-000000000303", "group", "群", null, null,
    "00000000-0000-4000-8000-000000000301", "00000000-0000-4000-8000-000000000302", 0,
    "bot", "all", "telegram", "[]", null, null, "database", "default", "support", now, now,
  )
  for (const [index, userId, enabled] of [[1, "10001", 1], [2, "10002", 1], [3, "10003", 0]] as const) {
    database.prepare(`INSERT INTO telegram_roles(
      id,telegram_user_id,username,display_name,role,can_correct,enabled,learning_source_enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      `00000000-0000-4000-8000-${String(310 + index).padStart(12, "0")}`, userId, null, `用户${index}`, "operator", 0, 1, enabled, now, now,
    )
  }
  return database
}

function seedStyleObservation(database: RuntimeDatabase, input: {
  index: number
  sourceUserId: "10001" | "10002" | "10003"
  threadIndex: number
  safeText: string
}): string {
  const now = `2026-08-11T00:00:${String(input.index).padStart(2, "0")}.000Z`
  const suffix = String(1_000 + input.index).padStart(12, "0")
  const eventId = `00000000-0000-4000-8000-${suffix}`
  const observationId = `00000000-0000-4000-9000-${suffix}`
  const threadId = `00000000-0000-4000-a000-${String(2_000 + input.threadIndex).padStart(12, "0")}`
  database.prepare(`INSERT OR IGNORE INTO support_threads(
    id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
    origin_batch_id,generation_started_at,progress_due_at,hard_deadline_at,closed_at,closed_by,closed_reason,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    threadId, "00000000-0000-4000-8000-000000000303", "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302", "answered", 1, now, String(input.index), now, "不得进入风格 profile 的自由总结",
    null, null, null, null, null, null, null, now, now,
  )
  database.prepare(`INSERT INTO support_message_events(
    id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
    sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    eventId, "00000000-0000-4000-8000-000000000303", null, String(input.index), null, null, input.sourceUserId, null,
    "学习用户", "operator", input.safeText, "不得进入风格 profile 的附件原文", null, "role_skipped", null, now,
  )
  database.prepare(`INSERT INTO support_thread_messages(thread_id,message_event_id,relation,question_fragment,position,created_at)
    VALUES (?,?,?,?,?,?)`).run(threadId, eventId, "supplement", "安全上下文", input.index, now)
  database.prepare(`INSERT INTO learning_source_observations(
    id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
    takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    observationId, eventId, input.sourceUserId, "operator", threadId, "00000000-0000-4000-8000-000000000302",
    "direct_question", 1, "cancelled", "reference_reply", "low", "running", 1, `lock-${input.index}`, now, now, now,
  )
  return observationId
}

function seedBatch(database: RuntimeDatabase, count: number, options: { users?: 1 | 2; threads?: number } = {}): string[] {
  const users = options.users ?? 2
  const threads = options.threads ?? 5
  return Array.from({ length: count }, (_, index) => seedStyleObservation(database, {
    index: index + 1,
    sourceUserId: users === 1 || index % 2 === 0 ? "10001" : "10002",
    threadIndex: index % threads,
    safeText: index % 2 === 0 ? "这个就行" : "发一下\n找对方看下",
  }))
}

describe("运营风格聚合与版本切换", () => {
  it("忽略未授权人工观察且不创建空版本", async () => {
    const database = await openDatabase()
    try {
      const observationId = seedStyleObservation(database, {
        index: 1, sourceUserId: "10003", threadIndex: 0, safeText: "这个不应进入风格",
      })
      const service = new OperatorStyleService(database)

      expect(service.updateFromObservations([observationId])).toBeNull()
      expect(database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("空白安全文本不计入样本且不能凑够 active 门槛", async () => {
    const database = await openDatabase()
    try {
      const observationIds = Array.from({ length: 20 }, (_, index) => seedStyleObservation(database, {
        index: index + 1,
        sourceUserId: index % 2 === 0 ? "10001" : "10002",
        threadIndex: index % 5,
        safeText: "   \n  ",
      }))

      expect(new OperatorStyleService(database).updateFromObservations(observationIds)).toBeNull()
      expect(database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("未达 20 samples 时保存 candidate 且 profile 只有聚合统计和白名单短语", async () => {
    const database = await openDatabase()
    try {
      const observationIds = seedBatch(database, 19)
      const version = new OperatorStyleService(database).updateFromObservations(observationIds)

      expect(version).toEqual(expect.objectContaining({ status: "candidate", sampleCount: 19, sourceUserCount: 2, threadCount: 5 }))
      expect(version?.profile.statistics).toEqual({
        sampleCount: 19,
        sourceUserCount: 2,
        threadCount: 5,
        medianTextChars: 4,
        p90TextChars: 9,
        singleMessageRatio: 0.53,
        segmentedMessageRatio: 0.47,
      })
      expect(version?.profile.allowedPhrases).toEqual(["就行", "这个", "发一下", "找对方看下"])
      expect(operatorStyleProfileSchema.safeParse(version?.profile).success).toBe(true)
      const serialized = JSON.stringify(version?.profile)
      expect(serialized).not.toContain("不得进入风格 profile")
      expect(serialized).not.toContain("这个就行")
      expect(serialized).not.toContain("发一下\\n找对方看下")
      expect(operatorStylePrompt(version?.profile)).not.toContain("不得进入风格 profile")
    } finally {
      database.close()
    }
  })

  it("第 20 条满足 2 个数字来源用户和 5 个线程后直接 active 并 supersede candidate", async () => {
    const database = await openDatabase()
    try {
      const observationIds = seedBatch(database, 20)
      const service = new OperatorStyleService(database)
      const candidate = service.updateFromObservations(observationIds.slice(0, 19))
      const active = service.updateFromObservations([observationIds[19]!])

      expect(candidate?.status).toBe("candidate")
      expect(active).toEqual(expect.objectContaining({ version: 2, status: "active", sampleCount: 20, sourceUserCount: 2, threadCount: 5 }))
      expect(database.prepare("SELECT version_number,status FROM operator_style_versions ORDER BY version_number").all()).toEqual([
        { version_number: 1, status: "superseded" },
        { version_number: 2, status: "active" },
      ])
      expect(database.prepare("SELECT COUNT(*) AS count FROM operator_style_version_evidence WHERE operator_style_version_id=?").get(active?.id ?? "")).toEqual({ count: 20 })
      expect(service.activeProfile()).toEqual(active?.profile)
    } finally {
      database.close()
    }
  })

  it.each([
    { users: 1 as const, threads: 5, missing: "source users" },
    { users: 2 as const, threads: 4, missing: "threads" },
  ])("达到 20 samples 但缺少 $missing 时仍为 candidate", async ({ users, threads }) => {
    const database = await openDatabase()
    try {
      const version = new OperatorStyleService(database).updateFromObservations(seedBatch(database, 20, { users, threads }))
      expect(version?.status).toBe("candidate")
    } finally {
      database.close()
    }
  })

  it("后续 active 版本原子切换且任意时刻最多一个 active", async () => {
    const database = await openDatabase()
    try {
      const ids = seedBatch(database, 21)
      const service = new OperatorStyleService(database)
      const first = service.updateFromObservations(ids.slice(0, 20))
      const second = service.updateFromObservations([ids[20]!])

      expect(first?.status).toBe("active")
      expect(second).toEqual(expect.objectContaining({ version: 2, status: "active", sampleCount: 21 }))
      expect(database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions WHERE status='active'").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT status FROM operator_style_versions WHERE id=?").get(first?.id ?? "")).toEqual({ status: "superseded" })
    } finally {
      database.close()
    }
  })

  it("重复提交同一批观察不新增风格版本", async () => {
    const database = await openDatabase()
    try {
      const ids = seedBatch(database, 20)
      const service = new OperatorStyleService(database)
      const first = service.updateFromObservations(ids)
      const duplicate = service.updateFromObservations([...ids].reverse())

      expect(duplicate).toEqual(first)
      expect(database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM operator_style_version_evidence").get()).toEqual({ count: 20 })
    } finally {
      database.close()
    }
  })

  it.each(["operator_style_versions", "operator_style_version_evidence"] as const)(
    "%s insert 失败时旧 active 与 evidence 原子不变",
    async (failedTable) => {
      const database = await openDatabase()
      try {
        const ids = seedBatch(database, 21)
        const service = new OperatorStyleService(database)
        const active = service.updateFromObservations(ids.slice(0, 20))!
        const beforeEvidence = database.prepare(`SELECT observation_id FROM operator_style_version_evidence
          WHERE operator_style_version_id=? ORDER BY observation_id`).all(active.id)
        database.connection.exec(`CREATE TRIGGER simulate_style_insert_failure BEFORE INSERT ON ${failedTable}
          BEGIN SELECT RAISE(ABORT, 'simulated style insert failure'); END;`)

        expect(() => service.updateFromObservations([ids[20]!])).toThrow(/simulated style insert failure/)
        expect(database.prepare("SELECT id,status,superseded_at FROM operator_style_versions ORDER BY version_number").all()).toEqual([{
          id: active.id,
          status: "active",
          superseded_at: null,
        }])
        expect(database.prepare(`SELECT observation_id FROM operator_style_version_evidence
          WHERE operator_style_version_id=? ORDER BY observation_id`).all(active.id)).toEqual(beforeEvidence)
      } finally {
        database.close()
      }
    },
  )
})
