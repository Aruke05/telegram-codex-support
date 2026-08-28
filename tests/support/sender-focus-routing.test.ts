import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import routingReplayJson from "../fixtures/chat-export-2026-08-14-routing-replay.json" with { type: "json" }
import { threadRouteResultSchema, type ThreadRouteResult } from "../../src/codex/schemas.js"
import { ReplyEventBus } from "../../src/replies/reply-event-bus.js"
import { ReplyService } from "../../src/replies/reply-service.js"
import { BackupService } from "../../src/runtime/backup-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import type { ProjectServiceRecord, RuntimeGroup, SupportMessageEvent } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { SupportDeadlineService } from "../../src/support/deadline-service.js"
import { systemDirectivesPrompt } from "../../src/support/system-directives.js"
import { SupportThreadCoordinator } from "../../src/support/thread-coordinator.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"
import { CodexSupportThreadRouter, type ThreadRouteInput } from "../../src/support/thread-router.js"

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
  const filePath = path.join(directory, "runtime.sqlite")
  const database = await RuntimeDatabase.open(filePath)
  openDatabases.push(database)
  const { group, service } = seedCatalog(database)
  const redactor = new ConfiguredSecretRedactor(database)
  const store = new SupportThreadStore(database, redactor)
  const replies = new ReplyService(database, new ReplyEventBus(), redactor)
  return { database, filePath, group, service, store, replies }
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
    settleAt: new Date(Date.parse(recorded.event.createdAt) + 30_000).toISOString(),
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

function startGenerating(
  harness: Awaited<ReturnType<typeof createHarness>>,
  question: ReturnType<typeof createFocusedQuestion>,
) {
  const claimed = harness.store.claimDue(new Date(Date.parse(question.event.createdAt) + 31_000).toISOString())!
  const pending = harness.replies.createPending({
    threadId: claimed.thread.id,
    inputRevision: claimed.inputRevision,
    groupId: harness.group.id,
    accountId: harness.group.accountId,
    projectId: harness.service.projectId,
    serviceId: harness.service.id,
    telegramMessageId: question.event.telegramMessageId,
    senderUserId: question.event.senderUserId,
    senderUsername: question.event.senderUsername,
    senderDisplayName: question.event.senderDisplayName,
    senderRole: question.event.senderRole,
    service: harness.service.key,
    serviceSource: "group_binding",
    question: question.event.safeText,
  })
  const reply = harness.replies.transition(pending.id, "generating")
  return { claim: claimed, reply }
}

function createUnthreadedReply(
  harness: Awaited<ReturnType<typeof createHarness>>,
  event: SupportMessageEvent,
) {
  return harness.replies.createPending({
    threadId: null,
    inputRevision: null,
    groupId: harness.group.id,
    accountId: harness.group.accountId,
    projectId: harness.service.projectId,
    serviceId: harness.service.id,
    telegramMessageId: event.telegramMessageId,
    senderUserId: event.senderUserId,
    senderUsername: event.senderUsername,
    senderDisplayName: event.senderDisplayName,
    senderRole: event.senderRole,
    service: harness.service.key,
    serviceSource: "group_binding",
    question: event.safeText || event.attachmentSummary,
  })
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

  it("原子提交 status-only 关联与进度 claim 后可由重启 deadline 沿同一 notification 发送", async () => {
    const harness = await createHarness()
    const question = createFocusedQuestion(harness, {
      messageId: "status-crash-1", senderUserId: "30001", text: "帮我查这笔订单为什么一直处理中",
    })
    startGenerating(harness, question)
    const current = harness.store.getThread(question.thread.id)
    const reminder = recordQuestion(harness, {
      messageId: "status-crash-2",
      senderUserId: "30001",
      text: "现在查得怎么样了",
      createdAt: new Date(Date.parse(question.event.createdAt) + 32_000).toISOString(),
    }).event

    const committed = harness.store.appendStatusOnlyBatchAndClaimProgress([{
      message: {
        threadId: current.id,
        eventId: reminder.id,
        relation: "supplement",
        questionFragment: reminder.safeText,
        settleAt: current.settleAt,
        expectedRevision: current.revision,
      },
      focus: {
        senderUserId: reminder.senderUserId,
        source: "operator_reply",
        operatorMessageId: reminder.telegramMessageId,
      },
    }], reminder.createdAt)

    expect(committed?.notification).toMatchObject({
      threadId: current.id,
      inputRevision: current.revision,
      kind: "progress",
      status: "pending",
    })
    expect(harness.store.findThreadByEvent(reminder.id)?.id).toBe(current.id)
    expect(harness.store.getEvent(reminder.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "status_only:progress_claim_persisted",
    })

    const competingReminder = recordQuestion(harness, {
      messageId: "status-crash-3",
      senderUserId: "30001",
      text: "还没好吗",
      createdAt: new Date(Date.parse(question.event.createdAt) + 33_000).toISOString(),
    }).event
    const conflicted = harness.store.appendStatusOnlyBatchAndClaimProgress([{
      message: {
        threadId: current.id,
        eventId: competingReminder.id,
        relation: "supplement",
        questionFragment: competingReminder.safeText,
        settleAt: current.settleAt,
        expectedRevision: current.revision,
      },
      focus: {
        senderUserId: competingReminder.senderUserId,
        source: "operator_reply",
        operatorMessageId: competingReminder.telegramMessageId,
      },
    }], competingReminder.createdAt)

    expect(conflicted).toMatchObject({ thread: { id: current.id }, notification: null })
    expect(harness.store.getEvent(competingReminder.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "status_only:progress_claim_already_owned",
    })
    expect(harness.store.hasPendingRoutingEventForThread(current.id)).toBe(false)

    const restartedDatabase = await RuntimeDatabase.open(harness.filePath)
    openDatabases.push(restartedDatabase)
    const restartedStore = new SupportThreadStore(
      restartedDatabase,
      new ConfiguredSecretRedactor(restartedDatabase),
    )
    const sentNotificationIds: string[] = []
    const deadline = new SupportDeadlineService({
      database: restartedDatabase,
      store: restartedStore,
      redactor: new ConfiguredSecretRedactor(restartedDatabase),
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: {
        sendMessage: async (_accountId, _chatId, _text, _replyTo, _quote, ownership) => {
          sentNotificationIds.push(ownership!.notificationId!)
          return "status-progress-message"
        },
      },
    })

    await deadline.runOnce(new Date(Date.parse(competingReminder.createdAt) + 1))

    expect(sentNotificationIds).toEqual([committed!.notification!.id])
    expect(restartedStore.getEvent(reminder.id).routeStatus).toBe("routed")
    expect(restartedStore.getEvent(competingReminder.id).routeStatus).toBe("routed")
    expect(restartedStore.hasPendingRoutingEventForThread(current.id)).toBe(false)
    expect(restartedDatabase.prepare(`SELECT status,telegram_message_id FROM support_thread_notifications
      WHERE id=?`).get(committed!.notification!.id)).toEqual({
      status: "sent",
      telegram_message_id: "status-progress-message",
    })
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
      answerEventIds: [answer.id],
      selectedCandidate: 3,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })).toThrow(/候选/u)

    const resolved = harness.store.resolveRouteClarification({
      clarificationId: second.id,
      answerEventIds: [answer.id],
      selectedCandidate: 2,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })
    expect(resolved).toMatchObject({ thread: { id: reset.thread.id }, mode: "active" })
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

  it("claims a clarification prompt exactly once before delivery and keeps the source event routed", async () => {
    const harness = await createHarness()
    const account = createFocusedQuestion(harness, {
      messageId: "561", senderUserId: "30001", text: "创建 Aropay 新账号",
    })
    const reset = createFocusedQuestion(harness, {
      messageId: "562", senderUserId: "30001", text: "重置 Aropay 登录密码",
    })
    const ambiguous = recordQuestion(harness, {
      messageId: "563", senderUserId: "30001", text: "这个好了没",
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
    const firstReplyId = createUnthreadedReply(harness, ambiguous).id

    expect(harness.store.claimRouteClarificationPrompt(
      clarification.id, firstReplyId, ambiguous.id, ambiguous.createdAt,
    )).toEqual({ claimed: true, promptReplyId: firstReplyId })

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(harness.store.claimRouteClarificationPrompt(
        clarification.id, randomUUID(), ambiguous.id, ambiguous.createdAt,
      )).toEqual({ claimed: false, promptReplyId: firstReplyId })
    }

    expect(harness.database.prepare(`SELECT prompt_reply_id,status
      FROM support_route_clarifications WHERE id=?`).get(clarification.id)).toEqual({
      prompt_reply_id: firstReplyId,
      status: "pending",
    })
    expect(harness.store.getEvent(ambiguous.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "待归属确认已进入发送链路",
    })
    expect(harness.store.listUnroutedEvents()).not.toContainEqual(expect.objectContaining({ id: ambiguous.id }))
  })
})

describe("bounded sender route model contract", () => {
  it("催促路由只要求模型判断语义且实际文案由宿主统一生成", async () => {
    const harness = await createHarness()
    const { event } = recordQuestion(harness, {
      messageId: "570", senderUserId: "30001", text: "现在查得怎么样了",
    })
    let prompt = ""
    const router = new CodexSupportThreadRouter({
      execute: async (_purpose: unknown, input: { prompt: string }) => {
        prompt = input.prompt
        return {
          action: "follow_up",
          messageIntent: "progress_request",
          questionFragment: event.safeText,
          issues: null,
          investigationEffect: "status_only",
          reason: "只询问进度",
          confidence: 1,
          clarificationReply: null,
        }
      },
    } as never)

    await router.route({
      mode: "classify",
      group: harness.group,
      service: harness.service,
      messages: [event],
      focus: { summary: "查询订单", status: "generating", handoffSource: null, recentMessages: [] },
      pending: null,
      ambiguity: null,
      timeline: [],
    })

    expect(prompt).toContain("路由模型只判断是不是状态催促")
    expect(prompt).toContain("不生成任何进度文案")
    expect(prompt).toContain("宿主统一发送")
    expect(prompt).toContain("不得仅因为它出现在排查期间就臆测成催促进度")
    expect(prompt).toContain("无法确认对方意图时也不得使用 status_only")
    expect(prompt).not.toContain("‘1’等短追问")
  })

  it("把图片作为真实视觉输入并要求可并列回答的歧义直接全部回答", async () => {
    const harness = await createHarness()
    const { event } = recordQuestion(harness, {
      messageId: "571", senderUserId: "30001", text: "我们服务区用的哪个国家",
    })
    const imagePath = path.join(temporaryDirectories.at(-1)!, "region.png")
    const executions: Array<{
      prompt: string
      images?: Array<{ path: string; mimeType: string; name: string }>
    }> = []
    const executableRouter = new CodexSupportThreadRouter({
      execute: async (_purpose: unknown, input: {
        prompt: string
        images?: Array<{ path: string; mimeType: string; name: string }>
      }) => {
        executions.push(input)
        return {
          action: "new_thread",
          messageIntent: "actionable",
          questionFragment: event.safeText,
          issues: null,
          investigationEffect: "changes_input",
          reason: "服务器所在地和业务地区都有可靠答案，应一次说明",
          confidence: 1,
          clarificationReply: null,
        }
      },
    } as never)

    await executableRouter.route({
      mode: "classify",
      group: harness.group,
      service: harness.service,
      messages: [event],
      attachments: [{
        eventId: event.id,
        name: "region.png",
        kind: "image",
        mimeType: "image/png",
        size: 123,
        extractedText: "截图显示服务器区域",
        localPath: imagePath,
      }],
      focus: null,
      pending: null,
      ambiguity: {
        latestQuestion: event.safeText,
        candidateLabels: ["服务器所在地", "业务地区"],
      },
      timeline: [],
    })

    expect(executions).toHaveLength(1)
    expect(executions[0]?.images).toEqual([{
      path: imagePath,
      mimeType: "image/png",
      name: "region.png",
    }])
    expect(executions[0]?.prompt).toContain('"visualInputAttached":true')
    expect(executions[0]?.prompt).toContain("只要各候选都有答案")
    expect(executions[0]?.prompt).toContain("就不要 uncertain，不要让运营二选一")
    expect(executions[0]?.prompt).toContain("一次说明各候选分别对应的答案")
  })

  it("accepts only bounded classifications without a target thread id", () => {
    expect(threadRouteResultSchema.parse({
      action: "follow_up",
      messageIntent: "actionable",
      questionFragment: "这个加急一下",
      issues: null,
      investigationEffect: "changes_input",
      reason: "承接发送人的当前事项",
      confidence: 0.98,
      clarificationReply: null,
    })).toMatchObject({ action: "follow_up" })
    expect(() => threadRouteResultSchema.parse({
      action: "follow_up",
      messageIntent: "actionable",
      targetThreadId: randomUUID(),
      questionFragment: "这个加急一下",
      issues: null,
      investigationEffect: "changes_input",
      reason: "尝试直接选择线程",
      confidence: 0.98,
      clarificationReply: null,
    })).toThrow()
    expect(() => threadRouteResultSchema.parse({
      action: "append",
      messageIntent: "actionable",
      questionFragment: "这个加急一下",
      issues: null,
      investigationEffect: "changes_input",
      reason: "旧协议",
      confidence: 0.98,
      clarificationReply: null,
    })).toThrow()
  })

  it("只允许后续追问声明为不改变排查输入", () => {
    expect(threadRouteResultSchema.safeParse({
      action: "follow_up",
      messageIntent: "progress_request",
      questionFragment: "现在查得怎么样了",
      issues: null,
      investigationEffect: "status_only",
      reason: "只询问当前进度",
      confidence: 1,
      clarificationReply: null,
    }).success).toBe(true)
    expect(threadRouteResultSchema.safeParse({
      action: "new_thread",
      messageIntent: "progress_request",
      questionFragment: "现在查得怎么样了",
      issues: null,
      investigationEffect: "status_only",
      reason: "非法组合",
      confidence: 1,
      clarificationReply: null,
    }).success).toBe(false)
  })

  it("待归属文案只校验结构 不按句式做业务门禁", () => {
    expect(threadRouteResultSchema.safeParse({
      action: "uncertain",
      messageIntent: "unclear",
      questionFragment: "这个呢",
      issues: null,
      investigationEffect: null,
      reason: "当前存在两个可能事项",
      confidence: 0.5,
      clarificationReply: "Aropay 是要开账号，还是重置密码？",
    }).success).toBe(true)
  })

  it("最终回答模型被明确要求把所有可可靠回答的解释一次说全", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("存在多个合理指代或解释")
    expect(prompt).toContain("一次把各候选是什么和各自答案都说清楚")
    expect(prompt).toContain("不得让运营先二选一")
    expect(prompt).toContain("并列回答可能误导时，才追问当前最少需要的一项")
  })
})

describe("sender-focused coordinator routing", () => {
  it("纯进度催促不重启正在进行的排查并把最终回复目标更新到最新消息", async () => {
    const harness = await createHarness()
    const question = createFocusedQuestion(harness, {
      messageId: "580", senderUserId: "30001", text: "帮我查这笔订单为什么一直处理中",
    })
    const running = startGenerating(harness, question)
    const before = harness.store.getThread(question.thread.id)
    const progressNotifications: string[] = []
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "follow_up",
        messageIntent: "progress_request",
        questionFragment: "这个问题现在排查得怎么样了",
        issues: null,
        investigationEffect: "status_only",
        reason: "只询问当前排查进度，没有新增排查事实",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 0,
      wake: () => undefined,
      sendStatusUpdate: async ({ notification }) => {
        progressNotifications.push(notification.id)
      },
    })
    const reminder = coordinator.accept({
      groupId: harness.group.id,
      messageId: "581",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "这个问题现在排查得怎么样了？",
      attachments: [],
      createdAt: new Date(Date.parse(question.event.createdAt) + 32_000).toISOString(),
    })!

    await coordinator.drain()

    const after = harness.store.getThread(question.thread.id)
    expect(harness.store.findThreadByEvent(reminder.id)?.id).toBe(question.thread.id)
    expect(after).toMatchObject({
      status: "generating",
      revision: before.revision,
      generationStartedAt: before.generationStartedAt,
      progressDueAt: before.progressDueAt,
      hardDeadlineAt: before.hardDeadlineAt,
    })
    expect(harness.replies.getDetail(running.reply.id)).toMatchObject({
      status: "generating",
      inputRevision: before.revision,
      telegramMessageId: "581",
    })
    expect(harness.store.getEvent(reminder.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "仅询问当前排查进度，已由当班客服回复且不改变排查输入",
    })
    expect(progressNotifications).toHaveLength(1)
    expect(harness.database.prepare(`SELECT source_kind,notification_id FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(question.thread.id)).toEqual({
      source_kind: "status_request",
      notification_id: progressNotifications[0],
    })
    expect(harness.database.readReplies("WHERE r.thread_id=?", [question.thread.id])).toHaveLength(1)

    const secondReminder = coordinator.accept({
      groupId: harness.group.id,
      messageId: "582",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "还没好吗？",
      attachments: [],
      createdAt: new Date(Date.parse(question.event.createdAt) + 33_000).toISOString(),
    })!
    await coordinator.drain()

    expect(progressNotifications).toHaveLength(1)
    expect(harness.store.findThreadByEvent(secondReminder.id)?.id).toBe(question.thread.id)
    expect(harness.store.getEvent(secondReminder.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "仅询问当前排查进度，同一问题已有进度提示发送资格，不重复发送",
    })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(question.thread.id)).toEqual({ count: 1 })
    expect(harness.database.readReplies("WHERE r.thread_id=?", [question.thread.id])).toHaveLength(1)
  })

  it("单独 1 只有路由模型明确判为 status_only 才能发送进度", async () => {
    const harness = await createHarness()
    const question = createFocusedQuestion(harness, {
      messageId: "583", senderUserId: "30001", text: "帮我查这笔订单为什么一直处理中",
    })
    startGenerating(harness, question)
    let statusUpdates = 0
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "follow_up",
        messageIntent: "actionable",
        questionFragment: "1",
        issues: null,
        investigationEffect: "changes_input",
        reason: "孤立数字不能确定为催促进度",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 0,
      wake: () => undefined,
      sendStatusUpdate: async () => {
        statusUpdates += 1
      },
    })

    coordinator.accept({
      groupId: harness.group.id,
      messageId: "584",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "1",
      attachments: [],
      createdAt: new Date(Date.parse(question.event.createdAt) + 32_000).toISOString(),
    })
    await coordinator.drain()

    expect(statusUpdates).toBe(0)
    expect(harness.store.getThread(question.thread.id).revision).toBe(2)
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(question.thread.id)).toEqual({ count: 0 })
  })

  it("催促中带补充证据时仍使旧版本失效并按新证据重新排查", async () => {
    const harness = await createHarness()
    const question = createFocusedQuestion(harness, {
      messageId: "585", senderUserId: "30001", text: "帮我查这笔订单为什么一直处理中",
    })
    startGenerating(harness, question)
    const before = harness.store.getThread(question.thread.id)
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "follow_up",
        messageIntent: "actionable",
        questionFragment: "怎么还没查完，上游后台刚刚已经显示成功",
        issues: null,
        investigationEffect: "changes_input",
        reason: "催促同时补充了会改变排查结论的新状态证据",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 0,
      wake: () => undefined,
    })
    const evidenceFollowup = coordinator.accept({
      groupId: harness.group.id,
      messageId: "586",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "怎么还没查完，上游后台刚刚已经显示成功",
      attachments: [],
      createdAt: new Date(Date.parse(question.event.createdAt) + 32_000).toISOString(),
    })!

    await coordinator.drain()

    expect(harness.store.findThreadByEvent(evidenceFollowup.id)?.id).toBe(question.thread.id)
    expect(harness.store.getThread(question.thread.id)).toMatchObject({
      status: "collecting",
      revision: before.revision + 1,
      generationStartedAt: null,
      progressDueAt: null,
      hardDeadlineAt: null,
    })
  })

  it("路由模型连续失败时重试一次后忽略且不默认建立问题", async () => {
    const harness = await createHarness()
    const route = vi.fn(async () => { throw new Error("route unavailable") })
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route },
      batchWindowMs: 0,
      wake: () => undefined,
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "590",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "提交通道失败是你原因吗",
      attachments: [],
      createdAt: new Date().toISOString(),
    })!

    await coordinator.drain()

    expect(route).toHaveBeenCalledTimes(2)
    expect(harness.store.findThreadByEvent(event.id)).toBeNull()
    expect(harness.store.getEvent(event.id)).toMatchObject({
      routeStatus: "ignored",
      skipReason: expect.stringContaining("路由连续失败两次"),
    })
  })

  it("分类阶段意外返回候选动作时忽略且不默认建立问题", async () => {
    const harness = await createHarness()
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: {
        route: async () => ({
          action: "candidate_1",
          messageIntent: "actionable",
          questionFragment: "这笔谁的问题",
          issues: null,
          investigationEffect: "changes_input",
          reason: "模拟旧模型非法结果",
          confidence: 1,
          clarificationReply: null,
        }),
      },
      batchWindowMs: 0,
      wake: () => undefined,
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "591",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "这笔谁的问题",
      attachments: [],
      createdAt: new Date().toISOString(),
    })!

    await coordinator.drain()

    expect(harness.store.findThreadByEvent(event.id)).toBeNull()
    expect(harness.store.getEvent(event.id)).toMatchObject({
      routeStatus: "ignored",
      skipReason: expect.stringContaining("路由连续失败两次"),
    })
  })

  it("keeps a short follow-up on the same sender focus across interleaved senders", async () => {
    const harness = await createHarness()
    const decisions: ThreadRouteResult[] = [
      { action: "new_thread", messageIntent: "actionable", questionFragment: "创建 kakaxi 账号", issues: null, investigationEffect: "changes_input", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "new_thread", messageIntent: "actionable", questionFragment: "PopPay 订单延迟", issues: null, investigationEffect: "changes_input", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "follow_up", messageIntent: "actionable", questionFragment: "kakaxi", issues: null, investigationEffect: "changes_input", reason: "承接当前账号创建", confidence: 1, clarificationReply: null },
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

  it("waits for image extraction before routing and passes the persisted image to the route model", async () => {
    const harness = await createHarness()
    const routeInputs: ThreadRouteInput[] = []
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: {
        route: async (input) => {
          routeInputs.push(input)
          return {
            action: "new_thread",
            messageIntent: "actionable",
            questionFragment: "截图中的服务区信息",
            issues: null,
            investigationEffect: "changes_input",
            reason: "图片已经解析完成",
            confidence: 1,
            clarificationReply: null,
          }
        },
      },
      batchWindowMs: 0,
      wake: () => undefined,
    })
    const imagePath = path.join(temporaryDirectories.at(-1)!, "service-region.jpg")
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "681",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "我们服务区用的哪个国家",
      attachments: [{
        name: "service-region.jpg",
        kind: "image",
        mimeType: "image/jpeg",
        size: 456,
        extractedText: "",
        localPath: null,
      }],
      attachmentsPending: true,
      createdAt: new Date().toISOString(),
    })!

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(routeInputs).toHaveLength(0)
    expect(harness.store.findThreadByEvent(event.id)).toBeNull()

    coordinator.enrichAttachments(event.id, [{
      name: "service-region.jpg",
      kind: "image",
      mimeType: "image/jpeg",
      size: 456,
      extractedText: "截图显示服务器部署区域为新加坡",
      localPath: imagePath,
    }])
    await coordinator.drain()

    expect(routeInputs).toHaveLength(1)
    expect(routeInputs[0]?.messages[0]).toMatchObject({
      id: event.id,
      attachmentSummary: "service-region.jpg（image）\n截图显示服务器部署区域为新加坡",
    })
    expect(routeInputs[0]?.attachments).toEqual([{
      eventId: event.id,
      name: "service-region.jpg",
      kind: "image",
      mimeType: "image/jpeg",
      size: 456,
      extractedText: "截图显示服务器部署区域为新加坡",
      localPath: imagePath,
    }])
    expect(harness.store.findThreadByEvent(event.id)).not.toBeNull()
  })

  it("recovers a crash before clarification delivery without self-answering or sending duplicate prompts", async () => {
    const harness = await createHarness()
    const account = createFocusedQuestion(harness, {
      messageId: "691", senderUserId: "30001", text: "创建 Aropay 新账号",
    })
    const reset = createFocusedQuestion(harness, {
      messageId: "692", senderUserId: "30001", text: "重置 Aropay 登录密码",
    })
    const ambiguous = recordQuestion(harness, {
      messageId: "693", senderUserId: "30001", text: "这个好了没",
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
    const routeModes: ThreadRouteInput["mode"][] = []
    const sentReplyIds: string[] = []
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: {
        route: async (input) => {
          routeModes.push(input.mode)
          return {
            action: "uncertain",
            messageIntent: "unclear",
            questionFragment: ambiguous.safeText,
            issues: null,
            investigationEffect: null,
            reason: "两个操作会产生不同结果，必须确认",
            confidence: 0.6,
            clarificationReply: "你问的是 Aropay 新账号，还是 Aropay 密码重置？",
          }
        },
      },
      batchWindowMs: 0,
      wake: () => undefined,
      sendRouteClarification: async ({ clarification: pendingClarification, event }) => {
        const replyId = createUnthreadedReply(harness, event).id
        const claim = harness.store.claimRouteClarificationPrompt(
          pendingClarification.id, replyId, event.id, event.createdAt,
        )
        if (!claim.claimed) return { replyId: claim.promptReplyId }
        sentReplyIds.push(replyId)
        return { replyId }
      },
    })

    for (let attempt = 0; attempt < 100; attempt += 1) coordinator.recover()
    await coordinator.drain()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      coordinator.recover()
      await coordinator.drain()
    }

    expect(routeModes).toEqual(["classify"])
    expect(sentReplyIds).toHaveLength(1)
    expect(harness.database.prepare(`SELECT prompt_reply_id,status
      FROM support_route_clarifications WHERE id=?`).get(clarification.id)).toEqual({
      prompt_reply_id: sentReplyIds[0],
      status: "pending",
    })
    expect(harness.store.getEvent(ambiguous.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "待归属确认已进入发送链路",
    })
    expect(harness.store.findThreadByEvent(ambiguous.id)).toBeNull()
    expect(harness.store.getThreadDetail(account.thread.id).messages).toHaveLength(1)
    expect(harness.store.getThreadDetail(reset.thread.id).messages).toHaveLength(1)
  })

  it("creates one answerable question instead of asking the operator to choose when both meanings have answers", async () => {
    const harness = await createHarness()
    const serverRegion = createFocusedQuestion(harness, {
      messageId: "696", senderUserId: "30001", text: "服务器部署在哪个国家",
    })
    const businessRegion = createFocusedQuestion(harness, {
      messageId: "697", senderUserId: "30001", text: "业务地区是哪个国家",
    })
    let clarificationCount = 0
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "new_thread",
        messageIntent: "actionable",
        questionFragment: "服务区可能指服务器所在地或业务地区，两项都有答案，需一起说明",
        issues: null,
        investigationEffect: "changes_input",
        reason: "并列回答安全且信息完整",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 0,
      wake: () => undefined,
      sendRouteClarification: async () => {
        clarificationCount += 1
        return { replyId: randomUUID() }
      },
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "698",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "我们服务区用的哪个国家",
      attachments: [],
      createdAt: new Date(Date.now() + 2_000).toISOString(),
    })!

    await coordinator.drain()

    const routed = harness.store.findThreadByEvent(event.id)
    expect(clarificationCount).toBe(0)
    expect(routed).not.toBeNull()
    expect(routed?.id).not.toBe(serverRegion.thread.id)
    expect(routed?.id).not.toBe(businessRegion.thread.id)
    expect(routed?.summary).toContain("两项都有答案")
    expect(harness.store.getPendingRouteClarification(
      harness.group.id, harness.service.id, "30001", event.createdAt,
    )).toBeNull()
  })

  it("asks about two concrete same-sender topics and resolves only the selected candidate", async () => {
    const harness = await createHarness()
    const decisions: ThreadRouteResult[] = [
      { action: "new_thread", messageIntent: "actionable", questionFragment: "创建 Aropay 新账号", issues: null, investigationEffect: "changes_input", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "new_thread", messageIntent: "actionable", questionFragment: "重置 Aropay 密码", issues: null, investigationEffect: "changes_input", reason: "独立问题", confidence: 1, clarificationReply: null },
      {
        action: "uncertain",
        messageIntent: "unclear",
        questionFragment: "这个好了没",
        issues: null,
        investigationEffect: null,
        reason: "两个事项同样可能",
        confidence: 0.6,
        clarificationReply: "你问的是 Aropay 新账号，还是 Aropay 密码重置？",
      },
      { action: "candidate_2", messageIntent: "actionable", questionFragment: "新账号那个", issues: null, investigationEffect: "changes_input", reason: "明确选择第二项", confidence: 1, clarificationReply: null },
    ]
    const sent: string[] = []
    const wake = vi.fn()
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
      wake,
      sendRouteClarification: async ({ text, event }) => {
        sent.push(text)
        return { replyId: createUnthreadedReply(harness, event).id }
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

    const wakeBeforeSelection = wake.mock.calls.length
    const selection = coordinator.accept({
      groupId: harness.group.id,
      messageId: "704",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "新账号那个",
      attachments: [],
      createdAt: new Date(base + 3_000).toISOString(),
    })!
    const continuation = coordinator.accept({
      groupId: harness.group.id,
      messageId: "705",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "补充姓名是测试账号",
      attachments: [],
      createdAt: new Date(base + 4_000).toISOString(),
    })!
    await coordinator.drain()
    const accountThread = harness.store.findThreadByEvent(account.id)!
    expect(harness.store.findThreadByEvent(ambiguous.id)?.id).toBe(accountThread.id)
    expect(harness.store.findThreadByEvent(selection.id)?.id).toBe(accountThread.id)
    expect(harness.store.findThreadByEvent(continuation.id)?.id).toBe(accountThread.id)
    expect(harness.store.getSenderFocus(
      harness.group.id, harness.service.id, "30001", continuation.createdAt,
    )).toMatchObject({
      threadId: accountThread.id,
      source: "clarification_answer",
      lastOperatorMessageId: continuation.telegramMessageId,
      focusedAt: continuation.createdAt,
    })
    expect(wake).toHaveBeenCalledTimes(wakeBeforeSelection + 1)
  })

  it("cancels an unseen pending clarification when Telegram delivery fails", async () => {
    const harness = await createHarness()
    const decisions: ThreadRouteResult[] = [
      { action: "new_thread", messageIntent: "actionable", questionFragment: "创建新账号", issues: null, investigationEffect: "changes_input", reason: "独立问题", confidence: 1, clarificationReply: null },
      { action: "new_thread", messageIntent: "actionable", questionFragment: "重置密码", issues: null, investigationEffect: "changes_input", reason: "独立问题", confidence: 1, clarificationReply: null },
      {
        action: "uncertain",
        messageIntent: "unclear",
        questionFragment: "这个好了没",
        issues: null,
        investigationEffect: null,
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
          messageIntent: "actionable",
          questionFragment: step.text,
          issues: null,
          investigationEffect: "changes_input",
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

describe("Task 3 handoff 终态路由", () => {
  it.each([
    { action: "candidate_1" as const, selectedCandidate: 1 as const },
    { action: "candidate_2" as const, selectedCandidate: 2 as const },
  ])("待归属回答选择 $action handoff 候选时原子收口并让同批后续只审计", async ({ action, selectedCandidate }) => {
    const harness = await createHarness()
    const base = Date.now()
    const senderUserId = "33001"
    const terminalQuestion = createFocusedQuestion(harness, {
      messageId: `clarification-terminal-${selectedCandidate}`,
      senderUserId,
      text: "已转技术的原问题",
      createdAt: new Date(base).toISOString(),
    })
    const activeQuestion = createFocusedQuestion(harness, {
      messageId: `clarification-active-${selectedCandidate}`,
      senderUserId,
      text: "仍在处理的另一个问题",
      createdAt: new Date(base + 1_000).toISOString(),
    })
    const candidates = selectedCandidate === 1
      ? [terminalQuestion, activeQuestion]
      : [activeQuestion, terminalQuestion]
    harness.database.prepare("UPDATE support_threads SET settle_at=? WHERE id=?").run(
      new Date(base + 10_000).toISOString(), terminalQuestion.thread.id,
    )
    harness.database.prepare("UPDATE support_threads SET settle_at=? WHERE id=?").run(
      new Date(base + 60_000).toISOString(), activeQuestion.thread.id,
    )
    const running = startGenerating(harness, terminalQuestion)
    expect(harness.store.claimHandoff(running.reply.id, "technical_change")).toBe(true)
    expect(harness.store.finishGeneration(
      terminalQuestion.thread.id,
      running.claim.inputRevision,
      "escalated",
    )).toBe(true)
    const terminalBefore = harness.store.getThread(terminalQuestion.thread.id)
    const ambiguous = recordQuestion(harness, {
      messageId: `clarification-original-${selectedCandidate}`,
      senderUserId,
      text: "这个继续补充",
      createdAt: new Date(base + 32_000).toISOString(),
    }).event
    const clarification = harness.store.createRouteClarification({
      groupId: harness.group.id,
      serviceId: harness.service.id,
      senderUserId,
      messageEventId: ambiguous.id,
      candidates: candidates.map((candidate, index) => ({
        threadId: candidate.thread.id,
        label: `候选 ${index + 1}`,
      })),
      createdAt: ambiguous.createdAt,
    })
    const wake = vi.fn()
    const sendStatusUpdate = vi.fn(async () => undefined)
    const sendRouteClarification = vi.fn(async () => ({ replyId: randomUUID() }))
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action,
        messageIntent: "actionable",
        questionFragment: "选中的已转技术事项补充",
        issues: null,
        investigationEffect: "changes_input",
        reason: "明确选择已转技术候选",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 30_000,
      wake,
      sendStatusUpdate,
      sendRouteClarification,
    })
    const answerOne = coordinator.accept({
      groupId: harness.group.id,
      messageId: `clarification-answer-${selectedCandidate}-1`,
      senderId: senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "选已转技术那个",
      attachments: [],
      createdAt: new Date(base + 33_000).toISOString(),
    })!
    const answerTwo = coordinator.accept({
      groupId: harness.group.id,
      messageId: `clarification-answer-${selectedCandidate}-2`,
      senderId: senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "补充订单时间 14:30",
      attachments: [],
      createdAt: new Date(base + 34_000).toISOString(),
    })!

    await coordinator.drain()

    expect(harness.store.getThread(terminalQuestion.thread.id)).toMatchObject({
      status: terminalBefore.status,
      revision: terminalBefore.revision,
      settleAt: terminalBefore.settleAt,
      generationStartedAt: terminalBefore.generationStartedAt,
      closedAt: terminalBefore.closedAt,
    })
    expect(harness.database.prepare(`SELECT status,selected_thread_id,resolved_at
      FROM support_route_clarifications WHERE id=?`).get(clarification.id)).toEqual({
      status: "resolved",
      selected_thread_id: terminalQuestion.thread.id,
      resolved_at: answerOne.createdAt,
    })
    for (const event of [ambiguous, answerOne, answerTwo]) {
      expect(harness.store.findThreadByEvent(event.id)?.id).toBe(terminalQuestion.thread.id)
      expect(harness.store.getEvent(event.id)).toMatchObject({
        routeStatus: "routed",
        skipReason: "handoff_terminal:audit_only",
      })
    }
    expect(harness.store.getSenderFocus(
      harness.group.id,
      harness.service.id,
      senderUserId,
      answerTwo.createdAt,
    )).toMatchObject({
      threadId: terminalQuestion.thread.id,
      source: "clarification_answer",
      lastOperatorMessageId: answerTwo.telegramMessageId,
      focusedAt: answerTwo.createdAt,
    })
    expect(wake).not.toHaveBeenCalled()
    expect(sendStatusUpdate).not.toHaveBeenCalled()
    expect(sendRouteClarification).not.toHaveBeenCalled()
  })

  it.each([
    { action: "candidate_1" as const, selectedCandidate: 1 as const },
    { action: "candidate_2" as const, selectedCandidate: 2 as const },
  ])("待归属回答选择 $action handoff 候选且第二条写入失败时整批回滚", async ({ action, selectedCandidate }) => {
    const harness = await createHarness()
    const base = Date.now()
    const senderUserId = "33002"
    const terminalQuestion = createFocusedQuestion(harness, {
      messageId: `rollback-terminal-${selectedCandidate}`,
      senderUserId,
      text: "已转技术的原问题",
      createdAt: new Date(base).toISOString(),
    })
    const activeQuestion = createFocusedQuestion(harness, {
      messageId: `rollback-active-${selectedCandidate}`,
      senderUserId,
      text: "仍在处理的另一个问题",
      createdAt: new Date(base + 1_000).toISOString(),
    })
    const candidates = selectedCandidate === 1
      ? [terminalQuestion, activeQuestion]
      : [activeQuestion, terminalQuestion]
    harness.database.prepare("UPDATE support_threads SET settle_at=? WHERE id=?").run(
      new Date(base + 10_000).toISOString(), terminalQuestion.thread.id,
    )
    harness.database.prepare("UPDATE support_threads SET settle_at=? WHERE id=?").run(
      new Date(base + 60_000).toISOString(), activeQuestion.thread.id,
    )
    const running = startGenerating(harness, terminalQuestion)
    expect(harness.store.claimHandoff(running.reply.id, "technical_change")).toBe(true)
    expect(harness.store.finishGeneration(
      terminalQuestion.thread.id,
      running.claim.inputRevision,
      "escalated",
    )).toBe(true)
    const terminalBefore = harness.store.getThread(terminalQuestion.thread.id)
    const ambiguous = recordQuestion(harness, {
      messageId: `rollback-original-${selectedCandidate}`,
      senderUserId,
      text: "这个继续补充",
      createdAt: new Date(base + 2_000).toISOString(),
    }).event
    const clarification = harness.store.createRouteClarification({
      groupId: harness.group.id,
      serviceId: harness.service.id,
      senderUserId,
      messageEventId: ambiguous.id,
      candidates: candidates.map((candidate, index) => ({
        threadId: candidate.thread.id,
        label: `候选 ${index + 1}`,
      })),
      createdAt: ambiguous.createdAt,
    })
    const focusBefore = harness.database.prepare(`SELECT thread_id,source,last_operator_message_id,
      focused_at,expires_at FROM support_sender_focus
      WHERE group_id=? AND service_id=? AND sender_user_id=?`).get(
      harness.group.id,
      harness.service.id,
      senderUserId,
    )
    const wake = vi.fn()
    const sendStatusUpdate = vi.fn(async () => undefined)
    const sendRouteClarification = vi.fn(async () => ({ replyId: randomUUID() }))
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action,
        messageIntent: "actionable",
        questionFragment: "选中的已转技术事项补充",
        issues: null,
        investigationEffect: "changes_input",
        reason: "明确选择已转技术候选",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 30_000,
      wake,
      sendStatusUpdate,
      sendRouteClarification,
    })
    const answerOne = coordinator.accept({
      groupId: harness.group.id,
      messageId: `rollback-answer-${selectedCandidate}-1`,
      senderId: senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "选已转技术那个",
      attachments: [],
      createdAt: new Date(base + 3_000).toISOString(),
    })!
    const answerTwo = coordinator.accept({
      groupId: harness.group.id,
      messageId: `rollback-answer-${selectedCandidate}-2`,
      senderId: senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "补充订单时间 14:30",
      attachments: [],
      createdAt: new Date(base + 4_000).toISOString(),
    })!
    harness.database.prepare(`CREATE TRIGGER fail_second_clarification_answer_${selectedCandidate}
      BEFORE INSERT ON support_thread_messages
      WHEN NEW.message_event_id='${answerTwo.id}'
      BEGIN SELECT RAISE(ABORT,'second clarification answer rejected'); END;`).run()

    await coordinator.drain()

    expect(harness.database.prepare(`SELECT status,selected_thread_id,resolved_at
      FROM support_route_clarifications WHERE id=?`).get(clarification.id)).toEqual({
      status: "pending",
      selected_thread_id: null,
      resolved_at: null,
    })
    for (const event of [ambiguous, answerOne, answerTwo]) {
      expect(harness.store.findThreadByEvent(event.id)).toBeNull()
      expect(harness.store.getEvent(event.id).routeStatus).not.toBe("routed")
    }
    expect(harness.database.prepare(`SELECT thread_id,source,last_operator_message_id,
      focused_at,expires_at FROM support_sender_focus
      WHERE group_id=? AND service_id=? AND sender_user_id=?`).get(
      harness.group.id,
      harness.service.id,
      senderUserId,
    )).toEqual(focusBefore)
    expect(harness.store.getThread(terminalQuestion.thread.id)).toMatchObject({
      status: terminalBefore.status,
      revision: terminalBefore.revision,
      settleAt: terminalBefore.settleAt,
      generationStartedAt: terminalBefore.generationStartedAt,
      closedAt: terminalBefore.closedAt,
    })
    expect(wake).not.toHaveBeenCalled()
    expect(sendStatusUpdate).not.toHaveBeenCalled()
    expect(sendRouteClarification).not.toHaveBeenCalled()
  })

  it("handoff audit 整批任一事件写入失败时关联、路由和 sender focus 全部回滚", async () => {
    const harness = await createHarness()
    const base = Date.now()
    const senderUserId = "34001"
    const question = createFocusedQuestion(harness, {
      messageId: "audit-batch-rollback-origin",
      senderUserId,
      text: "已转技术的原问题",
      createdAt: new Date(base).toISOString(),
    })
    const running = startGenerating(harness, question)
    expect(harness.store.claimHandoff(running.reply.id, "technical_change")).toBe(true)
    expect(harness.store.finishGeneration(question.thread.id, running.claim.inputRevision, "escalated")).toBe(true)
    const terminalBefore = harness.store.getThread(question.thread.id)
    const focusBefore = harness.database.prepare(`SELECT thread_id,source,last_operator_message_id,
      focused_at,expires_at FROM support_sender_focus
      WHERE group_id=? AND service_id=? AND sender_user_id=?`).get(
      harness.group.id,
      harness.service.id,
      senderUserId,
    )
    const first = recordQuestion(harness, {
      messageId: "audit-batch-rollback-1",
      senderUserId,
      text: "第一条补充",
      createdAt: new Date(base + 1_000).toISOString(),
    }).event
    const second = recordQuestion(harness, {
      messageId: "audit-batch-rollback-2",
      senderUserId,
      text: "第二条补充",
      createdAt: new Date(base + 2_000).toISOString(),
    }).event
    harness.database.prepare(`CREATE TRIGGER fail_second_audit_batch_event
      BEFORE INSERT ON support_thread_messages
      WHEN NEW.message_event_id='${second.id}'
      BEGIN SELECT RAISE(ABORT,'second audit event rejected'); END;`).run()

    expect(() => harness.store.appendAuditBatchWithSenderFocus([
      {
        message: {
          threadId: question.thread.id,
          eventId: first.id,
          relation: "supplement",
          questionFragment: first.safeText,
          settleAt: terminalBefore.settleAt,
          expectedRevision: terminalBefore.revision,
        },
        focus: {
          senderUserId: first.senderUserId,
          source: "operator_reply",
          operatorMessageId: first.telegramMessageId,
        },
      },
      {
        message: {
          threadId: question.thread.id,
          eventId: second.id,
          relation: "supplement",
          questionFragment: second.safeText,
          settleAt: terminalBefore.settleAt,
        },
        focus: {
          senderUserId: second.senderUserId,
          source: "operator_reply",
          operatorMessageId: second.telegramMessageId,
        },
      },
    ])).toThrow(/second audit event rejected/)

    expect(harness.store.findThreadByEvent(first.id)).toBeNull()
    expect(harness.store.findThreadByEvent(second.id)).toBeNull()
    expect(harness.store.getEvent(first.id).routeStatus).not.toBe("routed")
    expect(harness.store.getEvent(second.id).routeStatus).not.toBe("routed")
    expect(harness.database.prepare(`SELECT thread_id,source,last_operator_message_id,
      focused_at,expires_at FROM support_sender_focus
      WHERE group_id=? AND service_id=? AND sender_user_id=?`).get(
      harness.group.id,
      harness.service.id,
      senderUserId,
    )).toEqual(focusBefore)
    expect(harness.store.getThread(question.thread.id)).toMatchObject({
      status: terminalBefore.status,
      revision: terminalBefore.revision,
      latestMessageAt: terminalBefore.latestMessageAt,
      generationStartedAt: terminalBefore.generationStartedAt,
      closedAt: terminalBefore.closedAt,
    })
  })

  it("handoff audit 批次首条已关联后重启一次补齐余下事件且二次恢复 no-op", async () => {
    const harness = await createHarness()
    const base = Date.now()
    const senderUserId = "34002"
    const question = createFocusedQuestion(harness, {
      messageId: "audit-batch-recovery-origin",
      senderUserId,
      text: "已转技术的原问题",
      createdAt: new Date(base).toISOString(),
    })
    const running = startGenerating(harness, question)
    expect(harness.store.claimHandoff(running.reply.id, "service_handoff")).toBe(true)
    expect(harness.store.finishGeneration(question.thread.id, running.claim.inputRevision, "escalated")).toBe(true)
    const terminalBefore = harness.store.getThread(question.thread.id)
    const batchId = randomUUID()
    const first = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: null,
      telegramMessageId: "audit-batch-recovery-1",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "第一条补充",
      attachmentSummary: "",
      routeStatus: "batched",
      skipReason: null,
      createdAt: new Date(base + 1_000).toISOString(),
    }).event
    const second = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: null,
      telegramMessageId: "audit-batch-recovery-2",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "第二条补充",
      attachmentSummary: "",
      routeStatus: "batched",
      skipReason: null,
      createdAt: new Date(base + 2_000).toISOString(),
    }).event
    harness.store.assignEventBatch(first.id, batchId)
    harness.store.assignEventBatch(second.id, batchId)
    expect(harness.store.appendAuditMessageWithSenderFocus({
      threadId: question.thread.id,
      eventId: first.id,
      relation: "supplement",
      questionFragment: first.safeText,
      settleAt: terminalBefore.settleAt,
      expectedRevision: terminalBefore.revision,
    }, {
      senderUserId: first.senderUserId,
      source: "operator_reply",
      operatorMessageId: first.telegramMessageId,
    })).not.toBeNull()
    expect(harness.store.findThreadByEvent(second.id)).toBeNull()

    harness.database.close()
    openDatabases.splice(openDatabases.indexOf(harness.database), 1)
    const restartedDatabase = await RuntimeDatabase.open(harness.filePath)
    openDatabases.push(restartedDatabase)
    const restartedStore = new SupportThreadStore(restartedDatabase, new ConfiguredSecretRedactor(restartedDatabase))
    const wake = vi.fn()
    const route = vi.fn(async () => { throw new Error("handoff batch 恢复不应重新路由") })
    const coordinator = new SupportThreadCoordinator({
      database: restartedDatabase,
      store: restartedStore,
      router: { route },
      batchWindowMs: 0,
      wake,
    })

    expect(coordinator.recover()).toBe(1)
    await coordinator.drain()

    for (const event of [first, second]) {
      expect(restartedStore.findThreadByEvent(event.id)?.id).toBe(question.thread.id)
      expect(restartedStore.getEvent(event.id)).toMatchObject({
        routeStatus: "routed",
        skipReason: "handoff_terminal:audit_only",
      })
    }
    expect(restartedStore.getSenderFocus(
      harness.group.id,
      harness.service.id,
      senderUserId,
      second.createdAt,
    )).toMatchObject({
      threadId: question.thread.id,
      lastOperatorMessageId: second.telegramMessageId,
      focusedAt: second.createdAt,
    })
    expect(restartedStore.getThread(question.thread.id)).toMatchObject({
      status: terminalBefore.status,
      revision: terminalBefore.revision,
      generationStartedAt: terminalBefore.generationStartedAt,
      closedAt: terminalBefore.closedAt,
    })
    const messageCountAfterRecovery = restartedStore.getThreadDetail(question.thread.id).messages.length
    expect(coordinator.recover()).toBe(0)
    await coordinator.drain()
    expect(restartedStore.getThreadDetail(question.thread.id).messages).toHaveLength(messageCountAfterRecovery)
    expect(route).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
  })

  it("handoff 后业务补充和连续两个 1 只追加审计且完整独立问题仍可新建", async () => {
    const harness = await createHarness()
    const question = createFocusedQuestion(harness, {
      messageId: "handoff-origin",
      senderUserId: "task3-operator",
      text: "原订单一直处理中",
    })
    const running = startGenerating(harness, question)
    expect(harness.store.claimHandoff(running.reply.id, "technical_change")).toBe(true)
    expect(harness.store.finishGeneration(question.thread.id, running.claim.inputRevision, "escalated")).toBe(true)
    const terminal = harness.store.getThread(question.thread.id)
    const wake = vi.fn()
    const sendStatusUpdate = vi.fn(async () => undefined)
    const sendRouteClarification = vi.fn(async () => ({ replyId: randomUUID() }))
    const decisions: ThreadRouteResult[] = [
      { action: "follow_up", messageIntent: "actionable", investigationEffect: "changes_input", questionFragment: "补充订单时间", issues: null, reason: "同一事项补充", confidence: 1, clarificationReply: null },
      { action: "follow_up", messageIntent: "actionable", investigationEffect: "changes_input", questionFragment: "1", issues: null, reason: "已接管事项的后续审计", confidence: 1, clarificationReply: null },
      { action: "follow_up", messageIntent: "actionable", investigationEffect: "changes_input", questionFragment: "1", issues: null, reason: "已接管事项的后续审计", confidence: 1, clarificationReply: null },
      { action: "new_thread", messageIntent: "actionable", investigationEffect: "changes_input", questionFragment: "另一个商户创建账号", issues: null, reason: "完整独立新问题", confidence: 1, clarificationReply: null },
    ]
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => decisions.shift()! },
      batchWindowMs: 0,
      wake,
      sendStatusUpdate,
      sendRouteClarification,
    })
    const base = Date.parse(question.event.createdAt) + 1_000
    const accept = async (messageId: string, text: string, offset: number) => {
      const event = coordinator.accept({
        groupId: harness.group.id,
        messageId,
        senderId: "task3-operator",
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

    const supplement = await accept("handoff-followup", "补充订单时间 14:30", 0)
    const firstOne = await accept("handoff-one-1", "1", 1_000)
    const secondOne = await accept("handoff-one-2", "1", 2_000)

    for (const event of [supplement, firstOne, secondOne]) {
      expect(harness.store.findThreadByEvent(event.id)?.id).toBe(question.thread.id)
      expect(harness.store.getEvent(event.id).routeStatus).toBe("routed")
    }
    expect(harness.store.getThread(question.thread.id)).toMatchObject({
      status: terminal.status,
      revision: terminal.revision,
      generationStartedAt: terminal.generationStartedAt,
      closedAt: terminal.closedAt,
    })
    expect(harness.store.getThreadDetail(question.thread.id).messages).toHaveLength(4)
    expect(wake).not.toHaveBeenCalled()
    expect(sendStatusUpdate).not.toHaveBeenCalled()
    expect(sendRouteClarification).not.toHaveBeenCalled()

    const independent = await accept("handoff-independent", "另一个商户需要创建新账号", 3_000)
    expect(harness.store.findThreadByEvent(independent.id)?.id).not.toBe(question.thread.id)
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it("路由输入包含最近 30 条混合时间线、角色和 handoff 焦点终态", async () => {
    const harness = await createHarness()
    const base = Date.now()
    const question = createFocusedQuestion(harness, {
      messageId: "timeline-origin",
      senderUserId: "timeline-operator",
      text: "原问题",
      createdAt: new Date(base).toISOString(),
    })
    const running = startGenerating(harness, question)
    const progressSentAt = new Date(base + 29_500).toISOString()
    const progress = harness.store.claimProgressNotification(
      question.thread.id,
      running.claim.inputRevision,
      "scheduled_progress",
      new Date(base + 1_000).toISOString(),
      new Date(base + 1_000).toISOString(),
    )!
    expect(harness.store.claimNotificationSending(progress.id, new Date(base + 1_000).toISOString())).not.toBeNull()
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, harness.group.telegramChatId, "timeline-progress",
      question.thread.id, harness.service.id, null, progress.id, "progress", "sent", randomUUID(),
      "a".repeat(64), question.event.telegramMessageId, progressSentAt, progressSentAt,
    )
    harness.store.completeNotification(progress.id, "timeline-progress", "稍等", progressSentAt)
    const unknownQuestion = createFocusedQuestion(harness, {
      messageId: "timeline-unknown-origin",
      senderUserId: "timeline-unknown-operator",
      text: "另一问题",
      createdAt: new Date(base + 500).toISOString(),
    })
    const unknownNotificationId = randomUUID()
    const unknownAt = new Date(base + 29_700).toISOString()
    harness.database.prepare(`INSERT INTO support_thread_notifications(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,outbound_text,error_message,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      unknownNotificationId, unknownQuestion.thread.id, unknownQuestion.thread.revision, "progress", "unknown",
      unknownAt, "timeline-unknown-progress", "未确认送达的稍等", "发送结果未知", unknownAt, unknownAt,
    )
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, harness.group.telegramChatId, "timeline-unknown-progress",
      unknownQuestion.thread.id, harness.service.id, null, unknownNotificationId, "progress", "unknown", randomUUID(),
      "b".repeat(64), unknownQuestion.event.telegramMessageId, unknownAt, unknownAt,
    )
    expect(harness.store.claimHandoff(running.reply.id, "service_handoff")).toBe(true)
    expect(harness.replies.prepareTechnicalEscalation(running.reply.id, {
      answer: "已经通知技术接手",
      decisionReason: "服务接管",
    }, "service_handoff")).not.toBeNull()
    expect(harness.replies.claimSending(running.reply.id, {
      answer: "已经通知技术接手",
      decisionReason: "服务接管",
    })).not.toBeNull()
    harness.replies.transition(running.reply.id, "escalated", { telegramReplyMessageId: "timeline-outbound" })
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(
      new Date(base + 29_000).toISOString(),
      running.reply.id,
    )
    expect(harness.store.finishGeneration(question.thread.id, running.claim.inputRevision, "escalated")).toBe(true)
    for (let index = 0; index < 28; index += 1) {
      harness.store.recordEvent({
        groupId: harness.group.id,
        accountId: null,
        telegramMessageId: `timeline-${index}`,
        replyToMessageId: null,
        messageThreadId: null,
        senderUserId: index === 27 ? "20001" : `timeline-observer-${index}`,
        senderUsername: null,
        senderDisplayName: index === 27 ? "技术" : "运营",
        senderRole: index === 27 ? "technical" : null,
        text: `时间线消息 ${index}`,
        attachmentSummary: "",
        routeStatus: index === 27 ? "role_skipped" : "ignored",
        skipReason: null,
        createdAt: new Date(base + (index + 1) * 1_000).toISOString(),
      })
    }
    let routeInput: ThreadRouteInput | null = null
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async (input) => {
        routeInput = input
        return {
          action: "idle",
          messageIntent: "non_actionable",
          investigationEffect: null,
          questionFragment: "收到",
          issues: null,
          reason: "无需客服介入",
          confidence: 1,
          clarificationReply: null,
        }
      } },
      batchWindowMs: 0,
      wake: () => undefined,
    })
    coordinator.accept({
      groupId: harness.group.id,
      messageId: "timeline-latest",
      senderId: "timeline-operator",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "收到",
      attachments: [],
      createdAt: new Date(base + 30_000).toISOString(),
    })
    await coordinator.drain()

    const captured = routeInput as ThreadRouteInput | null
    const timeline = captured?.timeline
    expect(timeline).toHaveLength(30)
    expect(new Set(timeline?.map((entry) => entry.direction))).toEqual(new Set(["inbound", "outbound"]))
    expect(timeline).toContainEqual(expect.objectContaining({
      direction: "inbound",
      senderRole: "technical",
      text: "时间线消息 27",
    }))
    expect(timeline).toContainEqual(expect.objectContaining({
      direction: "outbound",
      messageId: "timeline-outbound",
      text: "已经通知技术接手",
    }))
    expect(timeline).toContainEqual(expect.objectContaining({
      direction: "outbound",
      messageId: "timeline-progress",
      replyToMessageId: "timeline-origin",
      text: "稍等",
      threadIds: [question.thread.id],
    }))
    expect(timeline).not.toContainEqual(expect.objectContaining({ messageId: "timeline-unknown-progress" }))
    expect(captured?.focus).toMatchObject({ status: "escalated", handoffSource: "service_handoff" })
  })

  it("内部 router 返回缺少必填语义字段时重试一次后 ignored", async () => {
    const harness = await createHarness()
    const route = vi.fn(async () => ({
      action: "new_thread",
      questionFragment: "完整业务问题",
      reason: "旧内部端口结果",
      confidence: 1,
      clarificationReply: null,
    }) as never)
    const wake = vi.fn()
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route },
      batchWindowMs: 0,
      wake,
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "invalid-internal-route",
      senderId: "invalid-internal-route-operator",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "完整业务问题",
      attachments: [],
    })!

    await coordinator.drain()

    expect(route).toHaveBeenCalledTimes(2)
    expect(harness.store.findThreadByEvent(event.id)).toBeNull()
    expect(harness.store.getEvent(event.id)).toMatchObject({
      routeStatus: "ignored",
      skipReason: expect.stringContaining("路由连续失败两次"),
    })
    expect(wake).not.toHaveBeenCalled()
  })

  it("handoff audit 在原 focus 临界过期前按最新发送人消息原子续期", async () => {
    const harness = await createHarness()
    const base = Date.now()
    const atMinute = (minute: number) => new Date(base + minute * 60_000).toISOString()
    const originAt = atMinute(0)
    const question = createFocusedQuestion(harness, {
      messageId: "focus-renew-origin",
      senderUserId: "focus-renew-operator",
      text: "原问题",
      createdAt: originAt,
    })
    const running = startGenerating(harness, question)
    expect(harness.store.claimHandoff(running.reply.id, "service_handoff", originAt)).toBe(true)
    expect(harness.store.finishGeneration(question.thread.id, running.claim.inputRevision, "escalated")).toBe(true)
    const terminal = harness.store.getThread(question.thread.id)
    const decisions: ThreadRouteResult[] = [
      { action: "follow_up", messageIntent: "actionable", investigationEffect: "changes_input", questionFragment: "第一次补充", issues: null, reason: "同一事项", confidence: 1, clarificationReply: null },
      { action: "follow_up", messageIntent: "actionable", investigationEffect: "changes_input", questionFragment: "第二次补充", issues: null, reason: "同一事项", confidence: 1, clarificationReply: null },
    ]
    const wake = vi.fn()
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => decisions.shift()! },
      batchWindowMs: 0,
      wake,
    })
    const accept = async (messageId: string, text: string, createdAt: string) => {
      const event = coordinator.accept({
        groupId: harness.group.id,
        messageId,
        senderId: "focus-renew-operator",
        senderUsername: null,
        senderDisplayName: "运营",
        fromBot: false,
        replyToMessageId: null,
        messageThreadId: null,
        replyTargetIsBot: false,
        text,
        attachments: [],
        createdAt,
      })!
      await coordinator.drain()
      return event
    }

    const first = await accept("focus-renew-first", "第一次补充", atMinute(29))
    const renewed = harness.store.getSenderFocus(
      harness.group.id,
      harness.service.id,
      "focus-renew-operator",
      atMinute(31),
    )
    expect(renewed).toMatchObject({
      threadId: question.thread.id,
      lastOperatorMessageId: "focus-renew-first",
      focusedAt: atMinute(29),
      expiresAt: atMinute(59),
    })
    const second = await accept("focus-renew-second", "第二次补充", atMinute(31))

    expect(harness.store.findThreadByEvent(first.id)?.id).toBe(question.thread.id)
    expect(harness.store.findThreadByEvent(second.id)?.id).toBe(question.thread.id)
    expect(harness.store.getThread(question.thread.id)).toMatchObject({
      status: terminal.status,
      revision: terminal.revision,
      settleAt: terminal.settleAt,
      generationStartedAt: terminal.generationStartedAt,
      closedAt: terminal.closedAt,
    })
    expect(harness.store.getSenderFocus(
      harness.group.id,
      harness.service.id,
      "focus-renew-operator",
      atMinute(31),
    )).toMatchObject({
      lastOperatorMessageId: "focus-renew-second",
      focusedAt: atMinute(31),
      expiresAt: atMinute(61),
    })
    expect(wake).not.toHaveBeenCalled()
  })

  it("路由连续失败两次后 ignored 且绝不默认新建线程", async () => {
    const harness = await createHarness()
    const route = vi.fn(async () => { throw new Error("router unavailable") })
    const wake = vi.fn()
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route },
      batchWindowMs: 0,
      wake,
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "route-failure",
      senderId: "route-failure-operator",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "完整问题但路由暂不可用",
      attachments: [],
    })!
    await coordinator.drain()

    expect(route).toHaveBeenCalledTimes(2)
    expect(harness.store.getEvent(event.id).routeStatus).toBe("ignored")
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 0 })
    expect(wake).not.toHaveBeenCalled()
  })

  it("uncertain 没有两个有效候选时静默 ignored 且不建线程", async () => {
    const harness = await createHarness()
    const sendRouteClarification = vi.fn(async () => ({ replyId: randomUUID() }))
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "uncertain",
        messageIntent: "unclear",
        investigationEffect: null,
        questionFragment: "1",
        issues: null,
        reason: "无法可靠读出完整意图",
        confidence: 0.1,
        clarificationReply: "你是问哪个事项？",
      }) },
      batchWindowMs: 0,
      wake: () => undefined,
      sendRouteClarification,
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "uncertain-without-candidates",
      senderId: "uncertain-operator",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "1",
      attachments: [],
    })!
    await coordinator.drain()

    expect(harness.store.getEvent(event.id).routeStatus).toBe("ignored")
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_threads").get()).toEqual({ count: 0 })
    expect(sendRouteClarification).not.toHaveBeenCalled()
  })
})
