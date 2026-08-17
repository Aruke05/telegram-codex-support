import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildApp } from "../../src/app.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "directive-delete-"))
  cleanup.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  const knowledge = new RuntimeKnowledgeService(database)
  knowledge.ensureSystemDirectives()
  const app = buildApp({ runtimeKnowledgeService: knowledge, backupService: {} as never })
  await app.ready()
  return { app, database, knowledge }
}

describe("人工固定规则删除 API", () => {
  it("永久删除人工规则并保留撤回审计", async () => {
    const { app, database, knowledge } = await harness()
    try {
      const directive = await knowledge.createDirective({
        title: "临时规则",
        content: "临时处理内容",
        scope: "tatapay",
        source: "human",
        priority: 80,
        actor: "创建人",
      })
      const generation = database.memoryGeneration()

      const response = await app.inject({
        method: "DELETE",
        url: `/api/directives/${directive.id}`,
        payload: { actor: "后台管理员" },
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(knowledge.listDirectives().some((item) => item.id === directive.id)).toBe(false)
      expect(database.memoryGeneration()).toBe(generation + 1)
      expect(knowledge.listEvents({ type: "retraction" })[0]).toMatchObject({
        content: "删除固定规则：临时规则",
        scope: "tatapay",
        actor: "后台管理员",
      })
    } finally {
      await app.close()
      database.close()
    }
  })

  it("拒绝删除系统固定规则", async () => {
    const { app, database, knowledge } = await harness()
    try {
      const system = knowledge.listDirectives().find((item) => item.source === "system")!
      const response = await app.inject({
        method: "DELETE",
        url: `/api/directives/${system.id}`,
        payload: { actor: "后台管理员" },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: "系统固定规则不能删除" })
      expect(knowledge.listDirectives().some((item) => item.id === system.id)).toBe(true)
    } finally {
      await app.close()
      database.close()
    }
  })

  it("不存在的规则返回安全中文错误", async () => {
    const { app, database } = await harness()
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/directives/00000000-0000-4000-8000-000000000099",
        payload: { actor: "后台管理员" },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: "固定规则不存在" })
    } finally {
      await app.close()
      database.close()
    }
  })

  it("缺少操作者时拒绝删除", async () => {
    const { app, database, knowledge } = await harness()
    try {
      const directive = await knowledge.createDirective({
        title: "保留规则",
        content: "不能被无操作者请求删除",
        scope: "global",
        source: "human",
        priority: 80,
        actor: "创建人",
      })
      const response = await app.inject({
        method: "DELETE",
        url: `/api/directives/${directive.id}`,
        payload: {},
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: "固定规则删除格式错误" })
      expect(knowledge.listDirectives().some((item) => item.id === directive.id)).toBe(true)
    } finally {
      await app.close()
      database.close()
    }
  })
})
