import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { ThreadRouteResult } from "../../src/codex/schemas.js"
import { ReplyEventBus } from "../../src/replies/reply-event-bus.js"
import { ReplyService } from "../../src/replies/reply-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import type { LearningSourceObservation, ProjectServiceRecord, RuntimeGroup } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { LearningSourceObserver } from "../../src/support/learning-source-observer.js"
import { LearningSourceStore } from "../../src/support/learning-source-store.js"
import { SupportThreadCoordinator } from "../../src/support/thread-coordinator.js"
import { SupportThreadLifecycleService } from "../../src/support/thread-lifecycle-service.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"
import type { SupportThreadRouterPort } from "../../src/support/thread-router.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const now = () => new Date().toISOString()

async function createDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-source-observer-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  openDatabases.push(database)
  return database
}

function seedCatalog(database: RuntimeDatabase): { group: RuntimeGroup; service: ProjectServiceRecord } {
  const createdAt = now()
  const projectId = randomUUID()
  const serviceId = randomUUID()
  const groupId = randomUUID()
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", createdAt, createdAt)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, createdAt, createdAt,
  )
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "group", "客服群", "-10001", null, projectId, serviceId, 1, "bot", "all",
    "telegram", "[]", null, null, "database", "default", "support", createdAt, createdAt,
  )
  return {
    group: database.readGroups().find((item) => item.id === groupId)!,
    service: database.readProjectServices("WHERE id=?", [serviceId])[0]!,
  }
}

function seedRole(
  database: RuntimeDatabase,
  telegramUserId: string,
  learningSourceEnabled: boolean,
  username = `role_${telegramUserId}`,
): void {
  const createdAt = now()
  database.insertRole({
    id: randomUUID(),
    telegramUserId,
    username,
    displayName: `角色 ${telegramUserId}`,
    role: "operator",
    canCorrect: false,
    enabled: true,
    learningSourceEnabled,
    createdAt,
    updatedAt: createdAt,
  })
}

class NewThreadRouter implements SupportThreadRouterPort {
  async route(input: Parameters<SupportThreadRouterPort["route"]>[0]): Promise<ThreadRouteResult> {
    return {
      action: "new_thread",
      questionFragment: input.messages.map((message) => message.safeText).join("\n"),
      reason: "测试新问题",
      confidence: 1,
      clarificationReply: null,
    }
  }
}

function incoming(input: {
  groupId: string
  messageId: string
  senderId: string
  text: string
  replyToMessageId?: string | null
  senderUsername?: string | null
  accountOwnerOutgoing?: boolean
}) {
  return {
    groupId: input.groupId,
    messageId: input.messageId,
    senderId: input.senderId,
    senderUsername: input.senderUsername ?? null,
    senderDisplayName: null,
    fromBot: false,
    ...(input.accountOwnerOutgoing === undefined ? {} : { accountOwnerOutgoing: input.accountOwnerOutgoing }),
    replyToMessageId: input.replyToMessageId ?? null,
    messageThreadId: null,
    replyTargetIsBot: false,
    text: input.text,
    attachments: [],
  }
}

async function createHarness(input: {
  batchWindowMs?: number
  router?: SupportThreadRouterPort
  wake?: () => void
} = {}) {
  const database = await createDatabase()
  const { group, service } = seedCatalog(database)
  const redactor = new ConfiguredSecretRedactor(database)
  const threadStore = new SupportThreadStore(database, redactor)
  const learningStore = new LearningSourceStore(database)
  const lifecycle = new SupportThreadLifecycleService(threadStore, {
    cancel: () => false,
    cancelClosed: () => 0,
  })
  let coordinator!: SupportThreadCoordinator
  const observer = new LearningSourceObserver({
    database,
    threads: threadStore,
    observations: learningStore,
    materializePendingBatch: (eventId) => coordinator.materializePendingBatchForEvent(eventId),
    lifecycle,
  })
  coordinator = new SupportThreadCoordinator({
    database,
    store: threadStore,
    router: input.router ?? new NewThreadRouter(),
    batchWindowMs: input.batchWindowMs ?? 30_000,
    wake: input.wake ?? (() => undefined),
    learningSourceObserver: observer,
  })
  return { database, group, service, threadStore, learningStore, observer, coordinator, redactor }
}

async function createQuestionThread(
  harness: Awaited<ReturnType<typeof createHarness>>,
  messageId: string,
  senderId = `30${messageId}`,
): Promise<string> {
  harness.coordinator.accept(incoming({
    groupId: harness.group.id,
    messageId,
    senderId,
    text: `用户问题 ${messageId}`,
  }))
  await harness.coordinator.drain()
  const rows = harness.database.prepare("SELECT id FROM support_threads ORDER BY created_at,id").all() as Array<{ id: string }>
  return rows.at(-1)!.id
}

function observations(database: RuntimeDatabase): LearningSourceObservation[] {
  return new LearningSourceStore(database).list()
}

function seedBotReply(
  database: RuntimeDatabase,
  redactor: ConfiguredSecretRedactor,
  input: { threadId: string; group: RuntimeGroup; service: ProjectServiceRecord; telegramMessageId: string },
): void {
  const replies = new ReplyService(database, new ReplyEventBus(), redactor)
  const pending = replies.createPending({
    threadId: input.threadId,
    inputRevision: 1,
    groupId: input.group.id,
    accountId: input.group.accountId,
    projectId: input.service.projectId,
    serviceId: input.service.id,
    telegramMessageId: input.telegramMessageId,
    senderUserId: "30001",
    senderUsername: null,
    senderDisplayName: null,
    senderRole: null,
    service: input.service.name,
    serviceSource: "group_binding",
    question: "用户问题",
  })
  replies.transition(pending.id, "generating")
  replies.transition(pending.id, "sending", { answer: "机器人答复" })
  replies.transition(pending.id, "replied", { telegramReplyMessageId: input.telegramMessageId })
}

function seedApplicationOutput(
  database: RuntimeDatabase,
  input: { group: RuntimeGroup; service: ProjectServiceRecord; threadId: string; telegramMessageId: string; kind: string },
): void {
  const timestamp = now()
  const accountId = randomUUID()
  database.insertAccount({
    id: accountId,
    name: "测试发送账号",
    type: "user",
    enabled: true,
    status: "ready",
    statusMessage: "",
    credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
    botUsername: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  database.prepare(`INSERT INTO telegram_output_ownership(
    id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
    notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), accountId, input.group.id, input.group.telegramChatId!, input.telegramMessageId, input.threadId,
    input.service.id, null, null, input.kind, "sent", randomUUID(), "c".repeat(64), null, timestamp, timestamp,
  )
}

describe("可信人工回复观察", () => {
  it("个人客服账号手工发言无需配置角色也只作为人工接管，不创建客服问题", async () => {
    const harness = await createHarness()
    const threadId = await createQuestionThread(harness, "91")

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "92",
      senderId: "20009",
      senderUsername: "current_support_account",
      text: "这条是当前客服账号手工回复",
      replyToMessageId: "91",
      accountOwnerOutgoing: true,
    }))!
    await harness.coordinator.drain()

    expect(answer).toMatchObject({ senderRole: "operator", routeStatus: "role_skipped" })
    expect(observations(harness.database)).toEqual([
      expect.objectContaining({
        messageEventId: answer.id,
        threadId,
        associationReason: "direct_question",
        takeoverStatus: "cancelled",
      }),
    ])
    expect(harness.threadStore.getThread(threadId).status).toBe("closed")
    expect(harness.threadStore.getThreadDetail(threadId).messages.map((message) => message.event.telegramMessageId)).toEqual(["91"])
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 1 })
  })

  it("普通入群消息不能伪装成当前客服账号手工发言", async () => {
    const harness = await createHarness({ batchWindowMs: 0 })

    const event = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "93",
      senderId: "20009",
      senderUsername: "current_support_account",
      text: "没有可信 outgoing 标记的消息",
    }))!
    await harness.coordinator.drain()

    expect(event).toMatchObject({ senderRole: null })
    expect(observations(harness.database)).toEqual([])
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 1 })
  })

  it("只按已启用角色的数字 ID 授权，不接受用户名冒充或未授权角色", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true, "trusted_operator")
    seedRole(harness.database, "20002", false, "disabled_source")
    const threadId = await createQuestionThread(harness, "101")

    harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "201",
      senderId: "29999",
      senderUsername: "trusted_operator",
      text: "用户名相同但数字 ID 不同",
      replyToMessageId: "101",
    }))
    harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "202",
      senderId: "20002",
      senderUsername: "disabled_source",
      text: "未授权角色回复",
      replyToMessageId: "101",
    }))
    harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "203",
      senderId: "20001",
      senderUsername: "renamed_operator",
      text: "已授权数字 ID 回复",
      replyToMessageId: "101",
    }))

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({ messageEventId: harness.threadStore.getEventByTelegramMessage(harness.group.id, "203")!.id, threadId }),
    ])
    expect(harness.threadStore.getEventByTelegramMessage(harness.group.id, "202")?.routeStatus).toBe("role_skipped")
  })

  it("优先关联直接回复的原始问题，且不把角色消息写入问题线程", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const threadId = await createQuestionThread(harness, "301")
    seedBotReply(harness.database, harness.redactor, {
      threadId,
      group: harness.group,
      service: harness.service,
      telegramMessageId: "robot-301",
    })

    const event = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "302",
      senderId: "20001",
      text: "可信人工答复",
      replyToMessageId: "301",
    }))!

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({
        messageEventId: event.id,
        threadId,
        associationReason: "direct_question",
        processingStatus: "pending",
      }),
    ])
    expect(event.routeStatus).toBe("role_skipped")
    expect(harness.threadStore.getThreadDetail(threadId).messages.map((message) => message.event.telegramMessageId)).toEqual(["301"])
  })

  it("按直接机器人答复和回复链的固定优先级关联同一线程", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const threadId = await createQuestionThread(harness, "401")
    seedBotReply(harness.database, harness.redactor, {
      threadId,
      group: harness.group,
      service: harness.service,
      telegramMessageId: "robot-401",
    })

    const directBot = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "402",
      senderId: "20001",
      text: "直接回复机器人",
      replyToMessageId: "robot-401",
    }))!
    const chained = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "403",
      senderId: "20001",
      text: "沿人工回复链补充",
      replyToMessageId: "402",
    }))!

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({ messageEventId: directBot.id, threadId, associationReason: "direct_bot_reply" }),
      expect.objectContaining({ messageEventId: chained.id, threadId, associationReason: "reply_chain" }),
    ])
  })

  it("多活跃线程时直接回复 progress 通过统一 ownership 精确关联原 thread", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const targetThreadId = await createQuestionThread(harness, "451")
    const otherThreadId = await createQuestionThread(harness, "452")
    seedApplicationOutput(harness.database, {
      group: harness.group,
      service: harness.service,
      threadId: targetThreadId,
      telegramMessageId: "progress-451",
      kind: "progress",
    })

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "453",
      senderId: "20001",
      text: "人工接手这条正在排查的问题",
      replyToMessageId: "progress-451",
    }))!

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({
        messageEventId: answer.id,
        threadId: targetThreadId,
        associationReason: "direct_bot_reply",
        takeoverStatus: "cancelled",
      }),
    ])
    expect(harness.threadStore.getThread(targetThreadId).status).toBe("closed")
    expect(harness.threadStore.getThread(otherThreadId).status).toBe("collecting")
  })

  it("异常绑定业务服务的技术告警群也不形成学习观察或接管来源 thread", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const sourceThreadId = await createQuestionThread(harness, "461")
    const timestamp = now()
    const alertGroupId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      alertGroupId, "alert-group", "技术告警群", "-10002", null, harness.service.projectId, harness.service.id, 1, "bot", "all",
      "telegram", "[]", null, null, "database", "technical", "technical_alert", timestamp, timestamp,
    )
    const alertGroup = harness.database.readGroups().find((group) => group.id === alertGroupId)!
    seedApplicationOutput(harness.database, {
      group: alertGroup,
      service: harness.service,
      threadId: sourceThreadId,
      telegramMessageId: "alert-461",
      kind: "technical_alert",
    })

    const answer = harness.coordinator.accept(incoming({
      groupId: alertGroup.id,
      messageId: "462",
      senderId: "20001",
      text: "技术群人工已接手来源问题",
      replyToMessageId: "alert-461",
    }))!

    expect(answer.routeStatus).toBe("role_skipped")
    expect(observations(harness.database)).toEqual([])
    expect(harness.threadStore.getThread(sourceThreadId).status).toBe("collecting")
  })

  it("拒绝 reply 行群与目标 thread 群不一致的机器人回复关联", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const timestamp = now()
    const otherGroupId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      otherGroupId, "other-group", "其他客服群", "-10002", null, harness.service.projectId, harness.service.id, 1, "bot", "all",
      "telegram", "[]", null, null, "database", "default", "support", timestamp, timestamp,
    )
    const otherQuestion = harness.threadStore.recordEvent({
      groupId: otherGroupId,
      accountId: null,
      telegramMessageId: "other-question",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId: "39999",
      senderUsername: null,
      senderDisplayName: "其他群用户",
      senderRole: null,
      text: "其他群问题",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    const otherBatchId = randomUUID()
    harness.threadStore.assignEventBatch(otherQuestion.id, otherBatchId)
    const otherThread = harness.threadStore.createThread({
      groupId: otherGroupId,
      projectId: harness.service.projectId,
      serviceId: harness.service.id,
      originBatchId: otherBatchId,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
      anchorMessageId: otherQuestion.telegramMessageId,
      latestMessageAt: otherQuestion.createdAt,
      summary: otherQuestion.safeText,
      originEventId: otherQuestion.id,
      questionFragment: otherQuestion.safeText,
    }).thread
    seedBotReply(harness.database, harness.redactor, {
      threadId: otherThread.id,
      group: harness.group,
      service: harness.service,
      telegramMessageId: "cross-group-bot-reply",
    })

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "404",
      senderId: "20001",
      text: "不能串到其他群",
      replyToMessageId: "cross-group-bot-reply",
    }))!

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({
        messageEventId: answer.id,
        threadId: null,
        associationReason: "none",
        processingStatus: "ignored",
      }),
    ])
  })

  it("机器人回复关联使用群和消息 ID 部分复合索引", async () => {
    const harness = await createHarness()
    const indexes = harness.database.prepare("PRAGMA index_list('support_replies')").all() as Array<{
      name: string
      partial: number
    }>
    expect(indexes).toContainEqual(expect.objectContaining({
      name: "support_replies_group_message_idx",
      partial: 1,
    }))

    const plan = harness.database.prepare(`EXPLAIN QUERY PLAN SELECT t.* FROM support_replies r
      JOIN support_threads t ON t.id=r.thread_id
      WHERE r.group_id=? AND r.telegram_reply_message_id=? AND t.group_id=r.group_id
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`).all(harness.group.id, "bot-message") as Array<{ detail: string }>
    expect(plan.map((step) => step.detail).join("\n")).toContain("support_replies_group_message_idx")
  })

  it("没有回复目标时只关联唯一近期同群同服务活跃线程", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const threadId = await createQuestionThread(harness, "501")

    const event = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "502",
      senderId: "20001",
      text: "唯一线程的人工答复",
    }))!

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({ messageEventId: event.id, threadId, associationReason: "single_active_thread" }),
    ])
  })

  it("多线程歧义和无法关联只落 ignored 审计，不学习也不接管", async () => {
    const ambiguous = await createHarness()
    seedRole(ambiguous.database, "20001", true)
    await createQuestionThread(ambiguous, "601", "31001")
    await createQuestionThread(ambiguous, "602", "31002")
    const ambiguousEvent = ambiguous.coordinator.accept(incoming({
      groupId: ambiguous.group.id,
      messageId: "603",
      senderId: "20001",
      text: "不知道在回复哪条",
    }))!
    expect(observations(ambiguous.database)).toEqual([
      expect.objectContaining({
        messageEventId: ambiguousEvent.id,
        threadId: null,
        associationReason: "ambiguous",
        takeoverStatus: "ambiguous",
        processingStatus: "ignored",
      }),
    ])

    const unlinked = await createHarness()
    seedRole(unlinked.database, "20002", true)
    const unlinkedEvent = unlinked.coordinator.accept(incoming({
      groupId: unlinked.group.id,
      messageId: "604",
      senderId: "20002",
      text: "没有可关联问题",
    }))!
    expect(observations(unlinked.database)).toEqual([
      expect.objectContaining({
        messageEventId: unlinkedEvent.id,
        threadId: null,
        associationReason: "none",
        takeoverStatus: "not_linked",
        processingStatus: "ignored",
      }),
    ])
  })

  it("同一 Telegram 消息重复投递只产生一个事件和一条观察", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    await createQuestionThread(harness, "701")
    const message = incoming({
      groupId: harness.group.id,
      messageId: "702",
      senderId: "20001",
      text: "重复投递的人工答复",
      replyToMessageId: "701",
    })

    harness.coordinator.accept(message)
    harness.coordinator.accept(message)

    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_message_events WHERE group_id=? AND telegram_message_id=?")
      .get(harness.group.id, "702")).toEqual({ count: 1 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM learning_source_observations").get()).toEqual({ count: 1 })
  })

  it("事件已落库但观察缺失时由重复投递幂等补齐观察", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const threadId = await createQuestionThread(harness, "751")
    const existing = harness.threadStore.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "752",
      replyToMessageId: "751",
      messageThreadId: null,
      senderUserId: "20001",
      senderUsername: null,
      senderDisplayName: "可信角色",
      senderRole: "operator",
      text: "已落事件但观察中断",
      attachmentSummary: "",
      routeStatus: "role_skipped",
      skipReason: "已配置角色普通消息只留审计",
    }).event
    expect(observations(harness.database)).toEqual([])

    harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "752",
      senderId: "20001",
      text: "已落事件但观察中断",
      replyToMessageId: "751",
    }))

    expect(observations(harness.database)).toEqual([
      expect.objectContaining({ messageEventId: existing.id, threadId, associationReason: "direct_question" }),
    ])
  })

  it("不把已经 ignored 的旧批次重新物化为问题线程", async () => {
    const harness = await createHarness()
    seedRole(harness.database, "20001", true)
    const oldEvent = harness.threadStore.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "761",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId: "35001",
      senderUsername: null,
      senderDisplayName: "用户",
      senderRole: null,
      text: "已经明确忽略的旧消息",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }).event
    harness.threadStore.assignEventBatch(oldEvent.id, randomUUID())
    harness.threadStore.updateEventRoute(oldEvent.id, "ignored", "明确无需处理")

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "762",
      senderId: "20001",
      text: "回复旧消息",
      replyToMessageId: "761",
    }))!

    expect(harness.threadStore.findThreadByEvent(oldEvent.id)).toBeNull()
    expect(observations(harness.database)).toEqual([
      expect.objectContaining({
        messageEventId: answer.id,
        threadId: null,
        associationReason: "none",
        processingStatus: "ignored",
      }),
    ])
  })

  it("人工回复 30 秒窗口内的问题时立即物化原批次且角色消息仍不进入线程", async () => {
    const harness = await createHarness({ batchWindowMs: 30_000 })
    seedRole(harness.database, "20001", true)
    const question = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "801",
      senderId: "32001",
      text: "仍在等待窗口的问题",
    }))!
    expect(harness.threadStore.findThreadByEvent(question.id)).toBeNull()

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "802",
      senderId: "20001",
      text: "窗口内人工已回答",
      replyToMessageId: "801",
    }))!

    const materialized = harness.threadStore.findThreadByEvent(question.id)
    expect(materialized).not.toBeNull()
    expect(observations(harness.database)).toEqual([
      expect.objectContaining({ messageEventId: answer.id, threadId: materialized!.id, associationReason: "direct_question" }),
    ])
    expect(harness.threadStore.findThreadByEvent(answer.id)).toBeNull()
    expect(harness.threadStore.getThreadDetail(materialized!.id).messages.map((message) => message.event.safeText)).toEqual([
      "仍在等待窗口的问题",
    ])
  })

  it("异步路由期间物化后先记录关联再唤醒答题 worker", async () => {
    let resolveRoute!: (result: ThreadRouteResult) => void
    let markRouteStarted!: () => void
    const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve })
    const routeResult = new Promise<ThreadRouteResult>((resolve) => { resolveRoute = resolve })
    const router: SupportThreadRouterPort = {
      route: async () => {
        markRouteStarted()
        return routeResult
      },
    }
    let database!: RuntimeDatabase
    const linkedAtWake: boolean[] = []
    const harness = await createHarness({
      batchWindowMs: 30_000,
      router,
      wake: () => {
        linkedAtWake.push(Boolean(database.prepare("SELECT 1 FROM learning_source_observations WHERE thread_id IS NOT NULL LIMIT 1").get()))
      },
    })
    database = harness.database
    seedRole(database, "20001", true)
    const question = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "901",
      senderId: "33001",
      text: "正在异步路由的问题",
    }))!
    const draining = harness.coordinator.drain()
    await routeStarted

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "902",
      senderId: "20001",
      text: "路由过程中人工回复",
      replyToMessageId: "901",
    }))!
    const materialized = harness.threadStore.findThreadByEvent(question.id)
    expect(materialized).not.toBeNull()
    expect(observations(database)).toEqual([
      expect.objectContaining({ messageEventId: answer.id, threadId: materialized!.id }),
    ])

    resolveRoute({
      action: "new_thread",
      questionFragment: "正在异步路由的问题",
      reason: "测试新问题",
      confidence: 1,
      clarificationReply: null,
    })
    await draining

    expect(database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 1 })
    expect(linkedAtWake).toEqual([true])
  })

  it("异步路由期间群改绑服务仍按批次接收时的服务物化", async () => {
    let resolveRoute!: (result: ThreadRouteResult) => void
    let markRouteStarted!: () => void
    const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve })
    const routeResult = new Promise<ThreadRouteResult>((resolve) => { resolveRoute = resolve })
    const harness = await createHarness({
      batchWindowMs: 30_000,
      router: {
        route: async () => {
          markRouteStarted()
          return routeResult
        },
      },
    })
    seedRole(harness.database, "20001", true)
    const question = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "951",
      senderId: "36001",
      text: "服务改绑期间的问题",
    }))!
    const draining = harness.coordinator.drain()
    await routeStarted

    const timestamp = now()
    const reboundServiceId = randomUUID()
    harness.database.prepare(`INSERT INTO project_services(
      id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      reboundServiceId, harness.service.projectId, "rebound", "改绑服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
    )
    harness.database.prepare("UPDATE telegram_groups SET service_id=?,updated_at=? WHERE id=?")
      .run(reboundServiceId, timestamp, harness.group.id)

    const answer = harness.coordinator.accept(incoming({
      groupId: harness.group.id,
      messageId: "952",
      senderId: "20001",
      text: "人工在路由期间回复",
      replyToMessageId: "951",
    }))!
    const materialized = harness.threadStore.findThreadByEvent(question.id)
    expect(materialized).toEqual(expect.objectContaining({ serviceId: harness.service.id }))
    expect(observations(harness.database)).toEqual([
      expect.objectContaining({ messageEventId: answer.id, threadId: materialized!.id, serviceId: harness.service.id }),
    ])

    resolveRoute({
      action: "new_thread",
      questionFragment: "服务改绑期间的问题",
      reason: "测试新问题",
      confidence: 1,
      clarificationReply: null,
    })
    await draining
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 1 })
  })
})
