import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import routingReplayJson from "../fixtures/chat-export-2026-08-14-routing-replay.json" with { type: "json" }
import { threadRouteResultSchema, type ThreadRouteResult } from "../../src/codex/schemas.js"
import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import type { ProjectServiceRecord, RuntimeGroup } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { SupportThreadCoordinator } from "../../src/support/thread-coordinator.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"
import { validateRouteClarificationReply, type ThreadRouteInput } from "../../src/support/thread-router.js"

const openDatabases: RuntimeDatabase[] = []
const temporaryDirectories: string[] = []

const routingReplay = routingReplayJson as {
  cases: Array<{
    name: string
    steps: Array<{
      id: string
      sender: string
      text: string
      action: "new_thread" | "follow_up"
      threadKey: string
    }>
  }>
}

afterEach(async () => {
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function seedCatalog(database: RuntimeDatabase): { group: RuntimeGroup; service: ProjectServiceRecord } {
  const now = new Date().toISOString()
  const projectId = randomUUID()
  const serviceId = randomUUID()
  const groupId = randomUUID()
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", now, now)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "group", "客服群", "-10001", null, projectId, serviceId, 1, "bot", "all",
    "telegram", "[]", null, null, "database", "default", "support", now, now,
  )
  return {
    group: database.readGroups().find((item) => item.id === groupId)!,
    service: database.readProjectServices("WHERE id=?", [serviceId])[0]!,
  }
}

async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "sender-focus-routing-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  openDatabases.push(database)
  const { group, service } = seedCatalog(database)
  const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
  return { database, group, service, store }
}

function recordQuestion(
  harness: Awaited<ReturnType<typeof createHarness>>,
  input: { messageId: string; senderUserId: string; text: string; createdAt?: string },
) {
  const event = harness.store.recordEvent({
    groupId: harness.group.id,
    accountId: null,
    telegramMessageId: input.messageId,
    replyToMessageId: null,
    messageThreadId: null,
    senderUserId: input.senderUserId,
    senderUsername: `operator_${input.senderUserId}`,
    senderDisplayName: "运营",
    senderRole: null,
    text: input.text,
    attachmentSummary: "",
    routeStatus: "received",
    skipReason: null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }).event
  const batchId = randomUUID()
  harness.store.assignEventBatch(event.id, batchId)
  return { event, batchId }
}

function createFocusedQuestion(
  harness: Awaited<ReturnType<typeof createHarness>>,
  input: { messageId: string; senderUserId: string; text: string; createdAt?: string },
) {
  const recorded = recordQuestion(harness, input)
  const thread = harness.store.createThreadWithSenderFocus({
    groupId: harness.group.id,
    projectId: harness.service.projectId,
    serviceId: harness.service.id,
    originBatchId: recorded.batchId,
    settleAt: new Date(Date.now() + 30_000).toISOString(),
    anchorMessageId: recorded.event.telegramMessageId,
    latestMessageAt: recorded.event.createdAt,
    summary: recorded.event.safeText,
    originEventId: recorded.event.id,
    questionFragment: recorded.event.safeText,
  }, {
    senderUserId: input.senderUserId,
    source: "new_thread",
    operatorMessageId: input.messageId,
  }).thread
  return { ...recorded, thread }
}

describe("sender conversation focus store", () => {
  it("creates a new thread and sender focus atomically", async () => {
    const harness = await createHarness()
    const { event, batchId } = recordQuestion(harness, {
      messageId: "101", senderUserId: "30001", text: "新建 kakaxi 账号",
    })

    const created = harness.store.createThreadWithSenderFocus({
      groupId: harness.group.id,
      projectId: harness.service.projectId,
      serviceId: harness.service.id,
      originBatchId: batchId,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
      anchorMessageId: event.telegramMessageId,
      latestMessageAt: event.createdAt,
      summary: event.safeText,
      originEventId: event.id,
      questionFragment: event.safeText,
    }, {
      senderUserId: event.senderUserId,
      source: "new_thread",
      operatorMessageId: event.telegramMessageId,
    })

    expect(created.created).toBe(true)
    expect(harness.store.getSenderFocus(
      harness.group.id,
      harness.service.id,
      event.senderUserId,
      event.createdAt,
    )).toMatchObject({
      threadId: created.thread.id,
      source: "new_thread",
      lastOperatorMessageId: "101",
    })
    expect(harness.store.getSenderFocus(
      harness.group.id,
      harness.service.id,
      "30002",
      event.createdAt,
    )).toBeNull()
  })

  it("moves only the same sender focus when an explicit reply appends another thread", async () => {
    const harness = await createHarness()
    const original = recordQuestion(harness, {
      messageId: "201", senderUserId: "30001", text: "PopPay 订单延迟",
    })
    const first = harness.store.createThreadWithSenderFocus({
      groupId: harness.group.id,
      projectId: harness.service.projectId,
      serviceId: harness.service.id,
      originBatchId: original.batchId,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
      anchorMessageId: original.event.telegramMessageId,
      latestMessageAt: original.event.createdAt,
      summary: original.event.safeText,
      originEventId: original.event.id,
      questionFragment: original.event.safeText,
    }, {
      senderUserId: "30001", source: "new_thread", operatorMessageId: "201",
    }).thread
    const other = recordQuestion(harness, {
      messageId: "202", senderUserId: "30002", text: "创建 Aropay 账号",
    })
    const target = harness.store.createThreadWithSenderFocus({
      groupId: harness.group.id,
      projectId: harness.service.projectId,
      serviceId: harness.service.id,
      originBatchId: other.batchId,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
      anchorMessageId: other.event.telegramMessageId,
      latestMessageAt: other.event.createdAt,
      summary: other.event.safeText,
      originEventId: other.event.id,
      questionFragment: other.event.safeText,
    }, {
      senderUserId: "30002", source: "new_thread", operatorMessageId: "202",
    }).thread
    const supplement = recordQuestion(harness, {
      messageId: "203", senderUserId: "30001", text: "这个加急一下",
    }).event

    const appended = harness.store.appendMessageWithSenderFocus({
      threadId: target.id,
      eventId: supplement.id,
      relation: "supplement",
      questionFragment: supplement.safeText,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
      expectedRevision: target.revision,
    }, {
      senderUserId: "30001", source: "explicit_reply", operatorMessageId: "203",
    })

    expect(appended?.id).toBe(target.id)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", supplement.createdAt,
    )?.threadId).toBe(target.id)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30002", supplement.createdAt,
    )?.threadId).toBe(target.id)
    expect(first.id).not.toBe(target.id)
  })

  it("preserves cancelled ambiguity records and resolves only a persisted candidate", async () => {
    const harness = await createHarness()
    const account = createFocusedQuestion(harness, {
      messageId: "301", senderUserId: "30001", text: "创建 Aropay 新账号",
    })
    const reset = createFocusedQuestion(harness, {
      messageId: "302", senderUserId: "30001", text: "重置 Aropay 登录密码",
    })
    const ambiguousOne = recordQuestion(harness, {
      messageId: "303", senderUserId: "30001", text: "这个好了没",
    }).event
    const first = harness.store.createRouteClarification({
      groupId: harness.group.id,
      serviceId: harness.service.id,
      senderUserId: "30001",
      messageEventId: ambiguousOne.id,
      candidates: [
        { threadId: account.thread.id, label: "Aropay 新账号" },
        { threadId: reset.thread.id, label: "Aropay 密码重置" },
      ],
      createdAt: ambiguousOne.createdAt,
    })
    const ambiguousTwo = recordQuestion(harness, {
      messageId: "304", senderUserId: "30001", text: "我说上面那个",
    }).event
    const second = harness.store.createRouteClarification({
      groupId: harness.group.id,
      serviceId: harness.service.id,
      senderUserId: "30001",
      messageEventId: ambiguousTwo.id,
      candidates: [
        { threadId: account.thread.id, label: "Aropay 新账号" },
        { threadId: reset.thread.id, label: "Aropay 密码重置" },
      ],
      createdAt: ambiguousTwo.createdAt,
    })

    expect(harness.database.prepare("SELECT status FROM support_route_clarifications WHERE id=?").get(first.id))
      .toEqual({ status: "cancelled" })
    expect(harness.store.getEvent(ambiguousOne.id)).toMatchObject({
      routeStatus: "ignored",
      skipReason: "新的待归属问题取代了旧确认",
    })
    expect(harness.store.getPendingRouteClarification(
      harness.group.id, harness.service.id, "30001", ambiguousTwo.createdAt,
    )?.id).toBe(second.id)

    const answer = recordQuestion(harness, {
      messageId: "305", senderUserId: "30001", text: "密码重置那个",
    }).event
    expect(() => harness.store.resolveRouteClarification({
      clarificationId: second.id,
      answerEventId: answer.id,
      selectedCandidate: 3,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })).toThrow(/候选/u)

    const resolved = harness.store.resolveRouteClarification({
      clarificationId: second.id,
      answerEventId: answer.id,
      selectedCandidate: 2,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })
    expect(resolved?.id).toBe(reset.thread.id)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", answer.createdAt,
    )).toMatchObject({ threadId: reset.thread.id, source: "clarification_answer" })
    expect(harness.database.prepare(`SELECT message_event_id FROM support_thread_messages
      WHERE thread_id=? ORDER BY position`).all(reset.thread.id)).toEqual([
      { message_event_id: reset.event.id },
      { message_event_id: ambiguousTwo.id },
      { message_event_id: answer.id },
    ])
  })

  it("archives expired focus projections and pending clarifications without deleting audit rows", async () => {
    const harness = await createHarness()
    const account = createFocusedQuestion(harness, {
      messageId: "401", senderUserId: "30001", text: "创建 Aropay 新账号",
    })
    const reset = createFocusedQuestion(harness, {
      messageId: "402", senderUserId: "30001", text: "重置 Aropay 登录密码",
    })
    const ambiguous = recordQuestion(harness, {
      messageId: "403", senderUserId: "30001", text: "这个处理了吗",
    }).event
    const clarification = harness.store.createRouteClarification({
      groupId: harness.group.id,
      serviceId: harness.service.id,
      senderUserId: "30001",
      messageEventId: ambiguous.id,
      candidates: [
        { threadId: account.thread.id, label: "Aropay 新账号" },
        { threadId: reset.thread.id, label: "Aropay 密码重置" },
      ],
      createdAt: ambiguous.createdAt,
    })
    const expiredAt = new Date(Date.parse(ambiguous.createdAt) + 31 * 60 * 1000)

    harness.store.archiveExpired(expiredAt)

    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", expiredAt,
    )).toBeNull()
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_sender_focus").get())
      .toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT status FROM support_route_clarifications WHERE id=?").get(clarification.id))
      .toEqual({ status: "expired" })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_message_events WHERE id=?").get(ambiguous.id))
      .toEqual({ count: 1 })
  })

  it("moves focus after a final bot reply only for a sender already in that thread", async () => {
    const harness = await createHarness()
    const question = createFocusedQuestion(harness, {
      messageId: "501", senderUserId: "30001", text: "PopPay 订单延迟",
    })
    const deliveredAt = new Date(Date.parse(question.event.createdAt) + 5_000).toISOString()

    expect(harness.store.setSenderFocusAfterDeliveredReply(
      question.thread.id, "30001", "901", deliveredAt,
    )).toBe(true)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", deliveredAt,
    )).toMatchObject({
      threadId: question.thread.id,
      source: "operator_reply",
      lastOperatorMessageId: "501",
      lastBotMessageId: "901",
    })
    expect(harness.store.setSenderFocusAfterDeliveredReply(
      question.thread.id, "30002", "902", deliveredAt,
    )).toBe(false)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30002", deliveredAt,
    )).toBeNull()
  })

  it("does not let a delayed reply on an older thread steal a newer sender focus", async () => {
    const harness = await createHarness()
    const base = Date.now()
    const older = createFocusedQuestion(harness, {
      messageId: "521", senderUserId: "30001", text: "旧订单", createdAt: new Date(base).toISOString(),
    })
    const newer = createFocusedQuestion(harness, {
      messageId: "522", senderUserId: "30001", text: "新订单", createdAt: new Date(base + 1_000).toISOString(),
    })

    expect(harness.store.setSenderFocusAfterDeliveredReply(
      older.thread.id, "30001", "921", new Date(base + 2_000).toISOString(),
    )).toBe(false)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", new Date(base + 2_000),
    )?.threadId).toBe(newer.thread.id)
  })

  it("rejects a focus when the thread's latest operator message is already older than 30 minutes", async () => {
    const harness = await createHarness()
    const base = Date.now()
    const question = createFocusedQuestion(harness, {
      messageId: "531", senderUserId: "30001", text: "过期订单", createdAt: new Date(base).toISOString(),
    })
    harness.database.prepare("UPDATE support_sender_focus SET expires_at=? WHERE thread_id=?").run(
      new Date(base + 2 * 60 * 60 * 1000).toISOString(), question.thread.id,
    )

    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", new Date(base + 31 * 60 * 1000),
    )).toBeNull()
  })

  it("round-trips sender focus and pending clarification through portable SQLite", async () => {
    const harness = await createHarness()
    const account = createFocusedQuestion(harness, {
      messageId: "551", senderUserId: "30001", text: "创建 Aropay 新账号",
    })
    const reset = createFocusedQuestion(harness, {
      messageId: "552", senderUserId: "30001", text: "重置 Aropay 登录密码",
    })
    const ambiguous = recordQuestion(harness, {
      messageId: "553", senderUserId: "30001", text: "这个好了没",
    }).event
    const clarification = harness.store.createRouteClarification({
      groupId: harness.group.id,
      serviceId: harness.service.id,
      senderUserId: "30001",
      messageEventId: ambiguous.id,
      candidates: [
        { threadId: account.thread.id, label: "Aropay 新账号" },
        { threadId: reset.thread.id, label: "Aropay 密码重置" },
      ],
      createdAt: ambiguous.createdAt,
    })
    const portablePath = path.join(temporaryDirectories.at(-1)!, "portable.sqlite")
    await new BackupService(harness.database).export(portablePath)
    const targetPath = path.join(temporaryDirectories.at(-1)!, "restored.sqlite")
    const target = await RuntimeDatabase.open(targetPath)
    openDatabases.push(target)

    await new BackupService(target).import(portablePath)

    expect(target.prepare("SELECT thread_id,source FROM support_sender_focus WHERE sender_user_id='30001'").get())
      .toEqual({ thread_id: reset.thread.id, source: "new_thread" })
    expect(target.prepare(`SELECT id,status,candidate_thread_ids_json,candidate_labels_json
      FROM support_route_clarifications WHERE id=?`).get(clarification.id)).toEqual({
      id: clarification.id,
      status: "pending",
      candidate_thread_ids_json: JSON.stringify([account.thread.id, reset.thread.id]),
      candidate_labels_json: JSON.stringify(["Aropay 新账号", "Aropay 密码重置"]),
    })
  })
})

describe("bounded sender route model contract", () => {
  it("accepts only bounded classifications without a target thread id", () => {
    expect(threadRouteResultSchema.parse({
      action: "follow_up",
      questionFragment: "这个加急一下",
      reason: "承接发送人的当前事项",
      confidence: 0.98,
      clarificationReply: null,
    })).toMatchObject({ action: "follow_up" })
    expect(() => threadRouteResultSchema.parse({
      action: "follow_up",
      targetThreadId: randomUUID(),
      questionFragment: "这个加急一下",
      reason: "尝试直接选择线程",
      confidence: 0.98,
      clarificationReply: null,
    })).toThrow()
    expect(() => threadRouteResultSchema.parse({
      action: "append",
      questionFragment: "这个加急一下",
      reason: "旧协议",
      confidence: 0.98,
      clarificationReply: null,
    })).toThrow()
  })

  it("rejects automation identity and generic lost-context clarification copy", () => {
    expect(validateRouteClarificationReply("你问的是 Aropay 新账号，还是密码重置？", [
      "Aropay 新账号", "Aropay 密码重置",
    ])).toBe("你问的是 Aropay 新账号，还是密码重置？")
    expect(validateRouteClarificationReply("Aropay 是要开账号，还是重置密码？", [
      "创建 Aropay 新账号", "重置 Aropay 登录密码",
    ])).toBe("Aropay 是要开账号，还是重置密码？")
    expect(() => validateRouteClarificationReply("你问的是哪项", ["新账号", "密码重置"])).toThrow(/自然确认/u)
    expect(() => validateRouteClarificationReply("我是 AI 客服，请说具体事项", ["新账号", "密码重置"])).toThrow(/自然确认/u)
    expect(() => validateRouteClarificationReply("这个还是那个？", ["新账号", "密码重置"])).toThrow(/候选/u)
  })
})

describe("sender-focused coordinator routing", () => {
  it("keeps a short follow-up on the same sender focus across interleaved senders", async () => {
    const harness = await createHarness()
    const decisions: ThreadRouteResult[] = [
      { action: "new_thread", questionFragment: "创建 kakaxi 账号", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "new_thread", questionFragment: "PopPay 订单延迟", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "follow_up", questionFragment: "kakaxi", reason: "承接当前账号创建", confidence: 1, clarificationReply: null },
    ]
    const routeInputs: ThreadRouteInput[] = []
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: {
        route: async (input) => {
          routeInputs.push(input)
          const decision = decisions.shift()
          if (!decision) throw new Error("没有测试路由结果")
          return decision
        },
      },
      batchWindowMs: 0,
      wake: () => undefined,
    })
    const base = Date.now()
    const accept = async (messageId: string, senderId: string, text: string, offset: number) => {
      const event = coordinator.accept({
        groupId: harness.group.id,
        messageId,
        senderId,
        senderUsername: null,
        senderDisplayName: "运营",
        fromBot: false,
        replyToMessageId: null,
        messageThreadId: null,
        replyTargetIsBot: false,
        text,
        attachments: [],
        createdAt: new Date(base + offset).toISOString(),
      })!
      await coordinator.drain()
      return event
    }

    const account = await accept("601", "30001", "创建 kakaxi 账号", 0)
    const popPay = await accept("602", "30002", "PopPay 订单延迟", 1_000)
    const accountName = await accept("603", "30001", "kakaxi", 2_000)

    const accountThread = harness.store.findThreadByEvent(account.id)!
    const popPayThread = harness.store.findThreadByEvent(popPay.id)!
    expect(harness.store.findThreadByEvent(accountName.id)?.id).toBe(accountThread.id)
    expect(accountThread.id).not.toBe(popPayThread.id)
    expect(routeInputs[2]?.focus?.summary).toContain("kakaxi")
    expect(routeInputs[2]?.focus?.summary).not.toContain("PopPay")
  })

  it("asks about two concrete same-sender topics and resolves only the selected candidate", async () => {
    const harness = await createHarness()
    const decisions: ThreadRouteResult[] = [
      { action: "new_thread", questionFragment: "创建 Aropay 新账号", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "new_thread", questionFragment: "重置 Aropay 密码", reason: "独立问题", confidence: 1, clarificationReply: null },
      {
        action: "uncertain",
        questionFragment: "这个好了没",
        reason: "两个事项同样可能",
        confidence: 0.6,
        clarificationReply: "你问的是 Aropay 新账号，还是 Aropay 密码重置？",
      },
      { action: "candidate_2", questionFragment: "新账号那个", reason: "明确选择第二项", confidence: 1, clarificationReply: null },
    ]
    const sent: string[] = []
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: {
        route: async () => {
          const decision = decisions.shift()
          if (!decision) throw new Error("没有测试路由结果")
          return decision
        },
      },
      batchWindowMs: 0,
      wake: () => undefined,
      sendRouteClarification: async ({ text }) => {
        sent.push(text)
        return { replyId: null }
      },
    })
    const base = Date.now()
    const accept = async (messageId: string, text: string, offset: number) => {
      const event = coordinator.accept({
        groupId: harness.group.id,
        messageId,
        senderId: "30001",
        senderUsername: null,
        senderDisplayName: "运营",
        fromBot: false,
        replyToMessageId: null,
        messageThreadId: null,
        replyTargetIsBot: false,
        text,
        attachments: [],
        createdAt: new Date(base + offset).toISOString(),
      })!
      await coordinator.drain()
      return event
    }

    const account = await accept("701", "创建 Aropay 新账号", 0)
    await accept("702", "重置 Aropay 密码", 1_000)
    const ambiguous = await accept("703", "这个好了没", 2_000)
    expect(harness.store.findThreadByEvent(ambiguous.id)).toBeNull()
    expect(sent).toEqual(["你问的是 Aropay 新账号，还是 Aropay 密码重置？"])

    const selection = await accept("704", "新账号那个", 3_000)
    const accountThread = harness.store.findThreadByEvent(account.id)!
    expect(harness.store.findThreadByEvent(ambiguous.id)?.id).toBe(accountThread.id)
    expect(harness.store.findThreadByEvent(selection.id)?.id).toBe(accountThread.id)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", selection.createdAt,
    )).toMatchObject({ threadId: accountThread.id, source: "clarification_answer" })
  })

  it("cancels an unseen pending clarification when Telegram delivery fails", async () => {
    const harness = await createHarness()
    const decisions: ThreadRouteResult[] = [
      { action: "new_thread", questionFragment: "创建新账号", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "new_thread", questionFragment: "重置密码", reason: "独立问题", confidence: 1, clarificationReply: null },
      {
        action: "uncertain",
        questionFragment: "这个好了没",
        reason: "两个事项同样可能",
        confidence: 0.6,
        clarificationReply: "你问的是创建新账号，还是重置密码？",
      },
    ]
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => decisions.shift()! },
      batchWindowMs: 0,
      wake: () => undefined,
      sendRouteClarification: async () => { throw new Error("Telegram failed") },
    })
    const base = Date.now()
    const accept = async (id: string, text: string, offset: number) => {
      const event = coordinator.accept({
        groupId: harness.group.id,
        messageId: id,
        senderId: "39001",
        senderUsername: null,
        senderDisplayName: "运营",
        fromBot: false,
        replyToMessageId: null,
        messageThreadId: null,
        replyTargetIsBot: false,
        text,
        attachments: [],
        createdAt: new Date(base + offset).toISOString(),
      })!
      await coordinator.drain()
      return event
    }
    await accept("751", "创建新账号", 0)
    await accept("752", "重置密码", 1_000)
    const ambiguous = await accept("753", "这个好了没", 2_000)

    expect(harness.store.getPendingRouteClarification(
      harness.group.id, harness.service.id, "39001", ambiguous.createdAt,
    )).toBeNull()
    expect(harness.store.getEvent(ambiguous.id)).toMatchObject({
      routeStatus: "ignored",
      skipReason: "待归属确认发送失败",
    })
  })

  it("replays the anonymized 2026-08-14 cross-thread incidents three times with zero wrong ownership", async () => {
    for (let repetition = 0; repetition < 3; repetition += 1) {
      for (const replayCase of routingReplay.cases) {
        const harness = await createHarness()
        const decisions = replayCase.steps.map((step): ThreadRouteResult => ({
          action: step.action,
          questionFragment: step.text,
          reason: `脱敏回放：${replayCase.name}`,
          confidence: 1,
          clarificationReply: null,
        }))
        const coordinator = new SupportThreadCoordinator({
          database: harness.database,
          store: harness.store,
          router: {
            route: async () => {
              const decision = decisions.shift()
              if (!decision) throw new Error("脱敏回放缺少路由结果")
              return decision
            },
          },
          batchWindowMs: 0,
          wake: () => undefined,
        })
        const threadIds = new Map<string, string>()
        const base = Date.now()
        for (const [index, step] of replayCase.steps.entries()) {
          const event = coordinator.accept({
            groupId: harness.group.id,
            messageId: `${repetition}-${step.id}`,
            senderId: step.sender,
            senderUsername: null,
            senderDisplayName: "运营",
            fromBot: false,
            replyToMessageId: null,
            messageThreadId: null,
            replyTargetIsBot: false,
            text: step.text,
            attachments: [],
            createdAt: new Date(base + index * 1_000).toISOString(),
          })!
          await coordinator.drain()
          const routed = harness.store.findThreadByEvent(event.id)
          expect(routed, `${replayCase.name}: ${step.text}`).not.toBeNull()
          const expected = threadIds.get(step.threadKey)
          if (expected) expect(routed!.id, `${replayCase.name}: ${step.text}`).toBe(expected)
          else threadIds.set(step.threadKey, routed!.id)
          expect(harness.store.getSenderFocus(
            harness.group.id, harness.service.id, step.sender, event.createdAt,
          )?.threadId).toBe(routed!.id)
        }
      }
    }
  })
})
