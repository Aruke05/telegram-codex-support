import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { ThreadRouteResult } from "../../src/codex/schemas.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { SupportThreadCoordinator } from "../../src/support/thread-coordinator.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"
import type { SupportThreadRouterPort } from "../../src/support/thread-router.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "raw-message-preservation-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  openDatabases.push(database)
  const timestamp = "2026-08-11T00:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000301"
  const serviceId = "00000000-0000-4000-8000-000000000302"
  const groupId = "00000000-0000-4000-8000-000000000303"
  database.prepare(`INSERT INTO projects(
    id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", timestamp, timestamp)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
  )
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "group", "客服群", "-10001", null, projectId, serviceId, 1, "bot", "all",
    "telegram", "[]", "main", null, "database", "default", "support", timestamp, timestamp,
  )
  return database
}

class CapturingRouter implements SupportThreadRouterPort {
  readonly inputs: string[][] = []

  async route(input: Parameters<SupportThreadRouterPort["route"]>[0]): Promise<ThreadRouteResult> {
    this.inputs.push(input.messages.map((message) => message.safeText))
    return {
      action: "new_thread",
      questionFragment: input.messages.map((message) => message.safeText).join("\n"),
      reason: "测试原文与路由副本分离",
      confidence: 1,
      clarificationReply: null,
    }
  }
}

class SequencedRouter implements SupportThreadRouterPort {
  calls = 0

  async route(input: Parameters<SupportThreadRouterPort["route"]>[0]): Promise<ThreadRouteResult> {
    this.calls += 1
    if (this.calls === 1) return {
      action: "idle",
      questionFragment: input.messages[0]?.safeText ?? "",
      reason: "原操作由专人处理",
      confidence: 1,
      clarificationReply: null,
    }
    return {
      action: "new_thread",
      questionFragment: input.messages.map((message) => message.safeText).join("\n"),
      reason: "独立产品需求",
      confidence: 1,
      clarificationReply: null,
    }
  }
}

class SplitRouter implements SupportThreadRouterPort {
  async route(input: Parameters<SupportThreadRouterPort["route"]>[0]): Promise<ThreadRouteResult> {
    const eventId = input.messages[0]!.id
    return {
      action: "split",
      questionFragment: "",
      issues: [
        { eventIds: [eventId], questionFragment: "查询订单当前状态和处理结果" },
        { eventIds: [eventId], questionFragment: "确认首次第三方响应应由哪一方负责" },
      ],
      reason: "同一条消息包含两个需要分别排查和答复的事项",
      confidence: 1,
      clarificationReply: null,
    }
  }
}

describe("Telegram 原始消息保真", () => {
  it("同一群的一条消息可由模型拆成多个独立问题并分条处理", async () => {
    const database = await createDatabase()
    const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
    const coordinator = new SupportThreadCoordinator({
      database,
      store,
      router: new SplitRouter(),
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const event = coordinator.accept({
      groupId: "00000000-0000-4000-8000-000000000303",
      messageId: "multi-1",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "这笔最后成功了吗，首次返回错误到底是哪边原因？",
      attachments: [],
      createdAt: "2026-08-11T00:00:00.000Z",
    })!

    await coordinator.drain()

    const links = database.prepare(`SELECT thread_id,question_fragment FROM support_thread_messages
      WHERE message_event_id=? ORDER BY question_fragment`).all(event.id) as Array<{
        thread_id: string
        question_fragment: string
      }>
    expect(links.map((link) => link.question_fragment)).toEqual([
      "查询订单当前状态和处理结果",
      "确认首次第三方响应应由哪一方负责",
    ])
    expect(new Set(links.map((link) => link.thread_id)).size).toBe(2)
    expect(database.prepare(`SELECT relation,COUNT(*) AS count FROM support_thread_links GROUP BY relation`).get())
      .toEqual({ relation: "split_from", count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 2 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM support_message_events").get()).toEqual({ count: 1 })
  })

  it("回复此前未建档的原消息时携带原文新建问题而不是并入最近线程", async () => {
    const database = await createDatabase()
    const router = new SequencedRouter()
    const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
    const coordinator = new SupportThreadCoordinator({
      database,
      store,
      router,
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const base = Date.now()
    const accept = (messageId: string, text: string, offset: number, replyToMessageId: string | null = null) => coordinator.accept({
      groupId: "00000000-0000-4000-8000-000000000303",
      messageId,
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId,
      messageThreadId: null,
      replyTargetIsBot: false,
      text,
      attachments: [],
      createdAt: new Date(base + offset).toISOString(),
    })!

    const reset = accept("3133", "Aropay otp和密码都重置一下", 0)
    await coordinator.drain()
    expect(store.findThreadByEvent(reset.id)).toBeNull()

    const page = accept("3135", "然后加一个页面 我要看用户的密码页面", 20_000)
    await coordinator.drain()
    const pageThread = store.findThreadByEvent(page.id)!

    const followup = accept("3138", "这个呢 麻烦处理一下", 40_000, "3133")
    await coordinator.drain()
    const resetThread = store.findThreadByEvent(reset.id)!

    expect(router.calls).toBe(2)
    expect(resetThread.id).not.toBe(pageThread.id)
    expect(store.findThreadByEvent(followup.id)?.id).toBe(resetThread.id)
    expect(store.getThreadDetail(pageThread.id).messages.map((message) => message.event.safeText)).toEqual([
      "然后加一个页面 我要看用户的密码页面",
    ])
    expect(store.getThreadDetail(resetThread.id).messages.map((message) => message.event.safeText)).toEqual([
      "Aropay otp和密码都重置一下",
      "这个呢 麻烦处理一下",
    ])
    expect(resetThread.summary).toBe("Aropay otp和密码都重置一下\n这个呢 麻烦处理一下")
  })

  it("safe_text 与 question_fragment 逐字保存 14 字原文而路由和线程摘要只用 11 字规范化副本", async () => {
    const database = await createDatabase()
    const router = new CapturingRouter()
    const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
    const coordinator = new SupportThreadCoordinator({
      database,
      store,
      router,
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const rawText = "  {\n  \"a\":1\n}\n"
    const normalizedText = rawText.trim()
    expect(rawText).toHaveLength(14)
    expect(normalizedText).toHaveLength(11)

    const event = coordinator.accept({
      groupId: "00000000-0000-4000-8000-000000000303",
      messageId: "raw-1",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: rawText,
      attachments: [],
      createdAt: "2026-08-11T00:01:00.000Z",
    })
    expect(event?.safeText).toBe(rawText)

    await coordinator.drain()

    expect(router.inputs).toEqual([[normalizedText]])
    expect(database.prepare("SELECT safe_text FROM support_message_events WHERE telegram_message_id='raw-1'").get())
      .toEqual({ safe_text: rawText })
    expect(database.prepare(`SELECT message.question_fragment,thread.summary
      FROM support_thread_messages message JOIN support_threads thread ON thread.id=message.thread_id
      WHERE message.message_event_id=?`).get(event!.id)).toEqual({
      question_fragment: rawText,
      summary: normalizedText,
    })
  })

  it("纯空白 Telegram 输入仍逐字存储但路由与线程摘要按规范化空值处理", async () => {
    const database = await createDatabase()
    const router = new CapturingRouter()
    const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
    const coordinator = new SupportThreadCoordinator({
      database,
      store,
      router,
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const rawText = "  \n"

    const event = coordinator.accept({
      groupId: "00000000-0000-4000-8000-000000000303",
      messageId: "raw-blank-1",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: rawText,
      attachments: [],
      createdAt: "2026-08-11T00:02:00.000Z",
    })

    await coordinator.drain()

    expect(router.inputs).toEqual([[""]])
    expect(database.prepare("SELECT safe_text FROM support_message_events WHERE id=?").get(event!.id))
      .toEqual({ safe_text: rawText })
    expect(database.prepare(`SELECT message.question_fragment,thread.summary
      FROM support_thread_messages message JOIN support_threads thread ON thread.id=message.thread_id
      WHERE message.message_event_id=?`).get(event!.id)).toEqual({
      question_fragment: rawText,
      summary: "",
    })
  })
})
