import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { AdminChatStore } from "../../src/admin-chat/store.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openStore(): Promise<{ database: RuntimeDatabase; store: AdminChatStore; serviceId: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "admin-chat-interrupt-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const now = "2026-08-17T12:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000101"
  const serviceId = "00000000-0000-4000-8000-000000000102"
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "global", now, now)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  return { database, store: new AdminChatStore(database), serviceId }
}

describe("后台 AI 对话生成中补充消息", () => {
  it("在同一事务中作废排队轮次并创建最新轮次", async () => {
    const { database, store, serviceId } = await openStore()
    try {
      const session = store.createSession(serviceId)
      const first = store.createTurn(session.id, "先查这批订单")

      const created = store.createTurnSupersedingActive(session.id, "补充：上游后台都显示成功")
      const detail = store.getSession(session.id)

      expect(created.supersededTurnIds).toEqual([first.id])
      expect(detail.turns).toMatchObject([{
        id: first.id,
        status: "cancelled",
        errorCode: "admin_chat_superseded",
        decisionReason: "已有新消息 本轮结果已作废并按最新内容重新排查",
      }, {
        id: created.turn.id,
        position: 2,
        status: "pending",
        question: "补充：上游后台都显示成功",
      }])
      expect(database.prepare(`SELECT COUNT(*) AS count FROM admin_chat_turns
        WHERE session_id=? AND status IN ('pending','generating')`).get(session.id)).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it("生成中的旧轮次被替代后不能再写入完成结果且新轮次可立即领取", async () => {
    const { database, store, serviceId } = await openStore()
    try {
      const session = store.createSession(serviceId)
      const first = store.createTurn(session.id, "为什么后台还是打款中")
      expect(store.claimNext("2026-08-17T12:01:00.000Z")?.id).toBe(first.id)

      const created = store.createTurnSupersedingActive(session.id, "补充：26笔在上游后台都是成功")

      expect(store.getTurn(first.id)).toMatchObject({
        status: "cancelled",
        errorCode: "admin_chat_superseded",
      })
      expect(() => store.completeTurn(first.id, {
        answer: "这条旧结果不能落库",
        decision: "reply",
        investigation: {},
        decisionReason: null,
        decisionConfidence: 0.8,
        codeRevision: null,
        codeSnapshotId: null,
        codeSyncBatchId: null,
        memoryVersionRefs: [],
      })).toThrow("后台对话轮次状态无效")
      expect(store.claimNext("2026-08-17T12:02:00.000Z")?.id).toBe(created.turn.id)
    } finally {
      database.close()
    }
  })
})
