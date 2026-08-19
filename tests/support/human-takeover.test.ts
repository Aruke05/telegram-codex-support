import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { AnswerDecision } from "../../src/codex/schemas.js"
import { ProjectCodeSyncUnavailableError, type CodeSyncFailure } from "../../src/git-sync/project-errors.js"
import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import { ReplyEventBus } from "../../src/replies/reply-event-bus.js"
import { ReplyService } from "../../src/replies/reply-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"
import { ModelExecutionError } from "../../src/models/errors.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"
import type { ProjectServiceRecord, RuntimeGroup, SupportMessageEvent, SupportThread } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import type { SupportDecisionInput } from "../../src/support/agent.js"
import { SupportAnswerWorker } from "../../src/support/answer-worker.js"
import { SupportCorrectionService } from "../../src/support/correction-service.js"
import { SupportDeadlineService } from "../../src/support/deadline-service.js"
import { LearningSourceObserver } from "../../src/support/learning-source-observer.js"
import { LearningSourceStore } from "../../src/support/learning-source-store.js"
import { baselineOperatorStyleProfile, operatorStyleProfileSchema } from "../../src/support/operator-style.js"
import { ResourceWorkspace } from "../../src/support/resource-workspace.js"
import { TechnicalAlertService } from "../../src/support/technical-alert-service.js"
import { SupportThreadCoordinator } from "../../src/support/thread-coordinator.js"
import { SupportThreadLifecycleService } from "../../src/support/thread-lifecycle-service.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"
import { TelegramDeliveryError, type TelegramOutputOwnership } from "../../src/telegram/runtime.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []

afterEach(async () => {
  vi.useRealTimers()
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createDatabase(): Promise<{ database: RuntimeDatabase; filePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "human-takeover-"))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, "support.sqlite")
  const database = await RuntimeDatabase.open(filePath)
  openDatabases.push(database)
  return { database, filePath }
}

function seedCatalog(database: RuntimeDatabase): { group: RuntimeGroup; service: ProjectServiceRecord } {
  const createdAt = new Date().toISOString()
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

function seedRole(database: RuntimeDatabase, telegramUserId = "20001"): void {
  const createdAt = new Date().toISOString()
  database.insertRole({
    id: randomUUID(),
    telegramUserId,
    username: `operator_${telegramUserId}`,
    displayName: "可信客服",
    role: "operator",
    canCorrect: false,
    enabled: true,
    learningSourceEnabled: true,
    createdAt,
    updatedAt: createdAt,
  })
}

type BaseHarness = Awaited<ReturnType<typeof createBaseHarness>>

async function createBaseHarness() {
  const { database, filePath } = await createDatabase()
  const { group, service } = seedCatalog(database)
  const redactor = new ConfiguredSecretRedactor(database)
  const store = new SupportThreadStore(database, redactor)
  const replies = new ReplyService(database, new ReplyEventBus(), redactor)
  return { database, filePath, group, service, redactor, store, replies }
}

async function createCompetingHarness(harness: BaseHarness): Promise<BaseHarness> {
  const database = await RuntimeDatabase.open(harness.filePath)
  openDatabases.push(database)
  const redactor = new ConfiguredSecretRedactor(database)
  return {
    ...harness,
    database,
    redactor,
    store: new SupportThreadStore(database, redactor),
    replies: new ReplyService(database, new ReplyEventBus(), redactor),
  }
}

function createQuestion(
  harness: BaseHarness,
  messageId: string,
  text = `用户问题 ${messageId}`,
  humanPriorityUserIds: string[] = [],
): { event: SupportMessageEvent; thread: SupportThread } {
  const event = harness.store.recordEvent({
    groupId: harness.group.id,
    accountId: harness.group.accountId,
    telegramMessageId: messageId,
    replyToMessageId: null,
    messageThreadId: null,
    senderUserId: `30${messageId}`,
    senderUsername: null,
    senderDisplayName: "运营",
    senderRole: null,
    text,
    attachmentSummary: "",
    routeStatus: "received",
    skipReason: null,
    humanPriorityUserIds,
  }).event
  const batchId = randomUUID()
  harness.store.assignEventBatch(event.id, batchId)
  const thread = harness.store.createThread({
    groupId: harness.group.id,
    projectId: harness.service.projectId,
    serviceId: harness.service.id,
    originBatchId: batchId,
    settleAt: new Date(Date.now() - 1_000).toISOString(),
    anchorMessageId: event.telegramMessageId,
    latestMessageAt: event.createdAt,
    summary: event.safeText,
    originEventId: event.id,
    questionFragment: event.safeText,
  }).thread
  return { event, thread }
}

function markHumanPriorityClaimed(harness: BaseHarness, thread: SupportThread, sourceEventId: string): void {
  harness.database.prepare(`UPDATE support_threads SET
    human_priority_state='claimed',human_priority_user_ids_json='["20001"]',
    human_priority_due_at=?,human_priority_source_event_id=?,human_priority_progress_message_id='progress-message'
    WHERE id=?`).run(new Date().toISOString(), sourceEventId, thread.id)
}

function createObserver(
  harness: BaseHarness,
  cancellation: { cancel(threadId: string, revision?: number): boolean; cancelClosed(): number } = {
    cancel: () => false,
    cancelClosed: () => 0,
  },
): LearningSourceObserver {
  const lifecycle = new SupportThreadLifecycleService(harness.store, cancellation)
  return new LearningSourceObserver({
    database: harness.database,
    threads: harness.store,
    observations: new LearningSourceStore(harness.database),
    materializePendingBatch: () => null,
    lifecycle,
  })
}

function observeHuman(
  harness: BaseHarness,
  observer: LearningSourceObserver,
  input: { messageId: string; replyToMessageId: string | null; senderUserId?: string },
) {
  const event = harness.store.recordEvent({
    groupId: harness.group.id,
    accountId: harness.group.accountId,
    telegramMessageId: input.messageId,
    replyToMessageId: input.replyToMessageId,
    messageThreadId: null,
    senderUserId: input.senderUserId ?? "20001",
    senderUsername: "trusted_operator",
    senderDisplayName: "可信客服",
    senderRole: "operator",
    text: `人工答复 ${input.messageId}`,
    attachmentSummary: "",
    routeStatus: "role_skipped",
    skipReason: "角色消息不进入问题线程",
  }).event
  return { event, observation: observer.observe(event) }
}

function seedGeneratingReply(harness: BaseHarness, thread: SupportThread) {
  const pending = harness.replies.createPending({
    threadId: thread.id,
    inputRevision: thread.revision,
    groupId: harness.group.id,
    accountId: harness.group.accountId,
    projectId: harness.service.projectId,
    serviceId: harness.service.id,
    telegramMessageId: thread.anchorMessageId,
    senderUserId: "30001",
    senderUsername: null,
    senderDisplayName: null,
    senderRole: null,
    service: harness.service.key,
    serviceSource: "group_binding",
    question: "用户问题",
  })
  return harness.replies.transition(pending.id, "generating")
}

function answerDecision(): AnswerDecision {
  return {
    decision: "reply",
    escalationType: "none",
    answer: "人工接管前生成的机器人答复",
    quote: null,
    reason: "测试回答",
    confidence: 1,
    usedMemoryVersionIds: [],
    investigation: {
      summary: "测试回答生成完成",
      steps: [{
        source: "message",
        title: "读取问题",
        status: "confirmed",
        evidence: "用户问题",
        conclusion: "形成测试回答",
      }],
    },
  }
}

function escalationDecision(): AnswerDecision {
  return {
    decision: "escalate",
    escalationType: "technical_change",
    answer: "已确认通道银行映射缺失 需要技术补上",
    quote: null,
    reason: "[已确认技术处理] 类型=后台映射 代码与运行数据均已确认",
    confidence: 1,
    usedMemoryVersionIds: [],
    investigation: {
      summary: "已确认需要技术处理",
      steps: [{
        source: "database",
        title: "父进程复核数据库只读查询",
        status: "confirmed",
        evidence: "映射记录缺失",
        conclusion: "需要技术补齐映射",
      }],
    },
  }
}

function codeSyncFailure(): CodeSyncFailure {
  return {
    repositoryRole: "backend",
    repositoryName: "backend",
    stage: "fetch",
    errorType: "network_unreachable",
    exitCode: 1,
    safeSummary: "测试代码同步失败",
  }
}

function seedCodeSnapshot(
  harness: BaseHarness,
  syncState: ProjectCodeSnapshot["syncState"] = "fresh",
): ProjectCodeSnapshot {
  const publishedAt = new Date().toISOString()
  const snapshot: ProjectCodeSnapshot = {
    projectId: harness.service.projectId,
    serviceId: harness.service.id,
    service: harness.service.key,
    branch: harness.service.branch,
    commit: "a".repeat(40),
    snapshotId: randomUUID(),
    syncBatchId: randomUUID(),
    configurationFingerprint: randomUUID(),
    syncState,
    failure: syncState === "fallback" ? codeSyncFailure() : null,
    publishedAt,
    workspacePath: temporaryDirectories.at(-1)!,
    repositories: [],
  }
  harness.database.prepare(`INSERT INTO service_code_snapshots(
    id,project_id,service_id,branch,repository_pair_fingerprint,commit_pair_fingerprint,status,created_at,published_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    snapshot.snapshotId, snapshot.projectId, snapshot.serviceId, snapshot.branch,
    snapshot.configurationFingerprint, snapshot.commit, "published", publishedAt, publishedAt,
  )
  harness.database.prepare(`INSERT INTO service_code_sync_batches(
    id,project_id,service_id,trigger_source,branch,repository_pair_fingerprint,status,snapshot_id,fallback_snapshot_id,
    started_at,finished_at,duration_ms
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    snapshot.syncBatchId, snapshot.projectId, snapshot.serviceId, "answer", snapshot.branch,
    snapshot.configurationFingerprint, syncState === "fresh" ? "published" : "fallback",
    syncState === "fresh" ? snapshot.snapshotId : null,
    syncState === "fallback" ? snapshot.snapshotId : null,
    publishedAt, publishedAt, 0,
  )
  return snapshot
}

function createWorker(harness: BaseHarness, input: {
  readCurrentSnapshot(): ProjectCodeSnapshot
  decision?: AnswerDecision | ((input: SupportDecisionInput) => AnswerDecision | Promise<AnswerDecision>)
  onAgentInput?(input: SupportDecisionInput): void
  sendMessage?(): Promise<string>
  sendSupportAlert?(): Promise<{ status: "sent"; summary: string; errorType: null }>
  sendCodeSyncFailure?(): Promise<{ status: "sent"; summary: string; errorType: null }>
}): SupportAnswerWorker {
  return new SupportAnswerWorker({
    database: harness.database,
    store: harness.store,
    replies: harness.replies,
    config: new ModelConfigService(harness.database),
    knowledge: new RuntimeKnowledgeService(harness.database, harness.redactor),
    redactor: harness.redactor,
    codeSync: {
      readCurrentSnapshot: input.readCurrentSnapshot,
      currentServiceForSnapshot: () => harness.service,
    },
    agent: {
      decide: async (agentInput) => {
        input.onAgentInput?.(agentInput)
        return typeof input.decision === "function"
          ? await input.decision(agentInput)
          : input.decision ?? answerDecision()
      },
    },
    transport: { sendMessage: input.sendMessage ?? (async () => "robot-message") },
    technicalAlerts: {
      sendSupportAlert: input.sendSupportAlert ?? (async () => ({ status: "sent", summary: "sent", errorType: null })),
      sendCodeSyncFailure: input.sendCodeSyncFailure ?? (async () => ({ status: "sent", summary: "sent", errorType: null })),
    },
    learning: { enqueue: () => undefined },
    resourceWorkspace: new ResourceWorkspace(harness.database),
  })
}

describe("人工接管与发送边界", () => {
  it("学习线程固定使用创建时模式并只保存影子回答", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-101", "这笔订单为什么一直处理中")
    expect(thread.answerOperationMode).toBe("learning")

    harness.database.prepare("UPDATE telegram_groups SET operation_mode='live' WHERE id=?")
      .run(harness.group.id)
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: answerDecision(),
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    const result = harness.database.prepare(`SELECT outcome_status,decision,answer,simulated_action
      FROM shadow_answer_results WHERE thread_id=? AND input_revision=?`).get(thread.id, thread.revision)
    expect(result).toEqual({
      outcome_status: "completed",
      decision: "reply",
      answer: answerDecision().answer,
      simulated_action: "reply",
    })
    const reply = harness.database.readReplies("WHERE r.thread_id=?", [thread.id])[0]
    expect(reply).toMatchObject({ status: "ignored", operatorDeliveryStatus: null })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership WHERE thread_id=?")
      .get(thread.id)).toEqual({ count: 0 })
    expect(harness.store.getThread(thread.id).status).toBe("answered")
  })

  it("学习线程模拟技术升级但不发送运营回复或技术告警", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-102", "这个映射缺失帮忙处理")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: escalationDecision(),
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT outcome_status,decision,answer,simulated_action
      FROM shadow_answer_results WHERE thread_id=?`).get(thread.id)).toEqual({
      outcome_status: "completed",
      decision: "escalate",
      answer: escalationDecision().answer,
      simulated_action: "technical_alert_and_reply",
    })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_reply_alert_deliveries")
      .get()).toEqual({ count: 0 })
  })

  it("学习线程不创建或发送进度与超时通知", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-103", "帮忙查一下订单")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const sendMessage = vi.fn(async () => "must-not-send")
    const cancellation = { cancel: vi.fn(() => false), cancelClosed: vi.fn(() => 0) }
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation,
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(now))
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?")
      .run(now, thread.id)
    await deadline.runOnce(new Date(now))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM support_thread_notifications WHERE thread_id=?")
      .get(thread.id)).toEqual({ count: 0 })
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM telegram_output_ownership WHERE thread_id=?")
      .get(thread.id)).toEqual({ count: 0 })
  })

  it("学习线程会终止升级前遗留的待发送超时通知", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-timeout-legacy", "帮忙查一下订单")
    const timestamp = new Date().toISOString()
    harness.database.prepare(`INSERT INTO support_thread_notifications(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), thread.id, thread.revision, "timeout_operator", "pending", timestamp,
      null, null, timestamp, timestamp,
    )
    const sendMessage = vi.fn(async () => "must-not-send")
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0 },
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(timestamp))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT status,error_message FROM support_thread_notifications").get())
      .toEqual({ status: "failed", error_message: "学习模式禁止 Telegram 输出" })
  })

  it("学习线程会收口升级前准备好的技术升级且不发送任何消息", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-prepared-legacy", "这个映射缺失帮忙处理")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    expect(harness.replies.prepareTechnicalEscalation(reply.id, {
      answer: "已经通知技术处理",
      decisionReason: "[已确认技术处理] 技术告警：发送中",
      decisionConfidence: 1,
    })).not.toBeNull()
    harness.store.retryGeneration(thread.id, thread.revision)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendMessage, sendSupportAlert,
    })

    await worker.runDueOnce(new Date(Date.now() + 1_000))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "failed", errorCode: "shadow_legacy_delivery_suppressed",
    })
    expect(harness.database.prepare("SELECT error_code FROM shadow_answer_results WHERE reply_id=?").get(reply.id))
      .toEqual({ error_code: "shadow_legacy_delivery_suppressed" })
  })

  it("学习线程的代码快照失败只记录影子失败且不通知技术群", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-104", "帮忙查一下订单")
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendCodeSyncFailure = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => { throw new ProjectCodeSyncUnavailableError(randomUUID(), codeSyncFailure()) },
      sendMessage,
      sendCodeSyncFailure,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendCodeSyncFailure).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT outcome_status,error_code,simulated_action
      FROM shadow_answer_results WHERE thread_id=?`).get(thread.id)).toEqual({
      outcome_status: "failed",
      error_code: "investigation_runtime_failure",
      simulated_action: "none",
    })
  })

  it("学习线程的回答模型失败只记录影子失败且不发送任何消息", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-105", "帮忙查一下订单")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => { throw new Error("model unavailable") },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT outcome_status,error_code,simulated_action
      FROM shadow_answer_results WHERE thread_id=?`).get(thread.id)).toEqual({
      outcome_status: "failed",
      error_code: "answer_model_failed",
      simulated_action: "none",
    })
  })

  it("收集期催促进度回复独立持久化且不改变原线程版本和计时", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "9001", "帮我查这笔订单")
    const before = harness.store.getThread(thread.id)
    const pending = harness.replies.createPending({
      threadId: thread.id,
      inputRevision: thread.revision,
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
      question: "现在查得怎么样了",
    })
    harness.replies.transition(pending.id, "generating")

    expect(harness.replies.claimSideMessageSending(pending.id, {
      answer: "稍等一下，这笔还要把数据库、服务器记录和应用后端日志一起核对完。",
    })?.status).toBe("sending")
    harness.replies.transition(pending.id, "replied", { telegramReplyMessageId: "9002" })

    expect(harness.replies.getDetail(pending.id)).toMatchObject({
      status: "replied",
      threadId: thread.id,
      inputRevision: thread.revision,
    })
    expect(harness.store.getThread(thread.id)).toMatchObject({
      status: before.status,
      revision: before.revision,
      settleAt: before.settleAt,
      generationStartedAt: before.generationStartedAt,
      progressDueAt: before.progressDueAt,
      hardDeadlineAt: before.hardDeadlineAt,
    })
  })

  it("回答完成时先等同线程催促路由落定并把最终回答回复到最新催促消息", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "9011", "帮我查这笔订单为什么一直处理中")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "robot-9013")
    const deliveryOrder: string[] = []
    let coordinator: SupportThreadCoordinator
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        coordinator.accept({
          groupId: harness.group.id,
          messageId: "9012",
          senderId: event.senderUserId,
          senderUsername: null,
          senderDisplayName: "运营",
          fromBot: false,
          replyToMessageId: event.telegramMessageId,
          messageThreadId: null,
          replyTargetIsBot: false,
          text: "这个问题现在排查得怎么样了？",
          attachments: [],
          createdAt: new Date().toISOString(),
        })
        return answerDecision()
      },
      sendMessage,
    })
    coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "follow_up",
        questionFragment: "这个问题现在排查得怎么样了",
        investigationEffect: "status_only",
        progressReply: "稍等一下，这笔还要把数据库、服务器记录和应用后端日志一起核对完，确认准确需要一点时间。",
        reason: "只询问当前排查进度，没有新增排查事实",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 20,
      wake: () => undefined,
      cancelStale: () => worker.cancelClosed(),
      sendStatusUpdate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        deliveryOrder.push("progress")
        return { replyId: null }
      },
    })

    await worker.runDueOnce(new Date())
    deliveryOrder.push("answer")
    await coordinator.drain()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(deliveryOrder).toEqual(["progress", "answer"])
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      answerDecision().answer,
      "9012",
      null,
      expect.objectContaining({ threadId: thread.id, kind: "support_reply" }),
    )
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "answered", revision: 1 })
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "replied", telegramMessageId: "9012", inputRevision: 1 }),
    ])
  })

  it("稍等发送中收到普通补充消息后按当前版本收口并继续 AI", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "priority-race", "帮忙看下 @technical_user", ["20001"])
    const dueAt = String((harness.database.prepare(
      "SELECT human_priority_due_at FROM support_threads WHERE id=?",
    ).get(thread.id) as { human_priority_due_at: string }).human_priority_due_at)
    const claim = harness.store.claimDueHumanPriority(dueAt)!
    const followup = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-race-followup",
      replyToMessageId: thread.anchorMessageId,
      messageThreadId: null,
      senderUserId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "补充一下 是今天的订单",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    harness.store.appendMessage({
      threadId: thread.id,
      eventId: followup.id,
      relation: "supplement",
      questionFragment: followup.safeText,
      settleAt: new Date(Date.parse(dueAt) + 30_000).toISOString(),
    })

    expect(harness.store.completeHumanPriorityClaim(claim, "progress-race", null, dueAt)).toBe(true)
    const current = harness.store.getThread(thread.id)
    expect(current.revision).toBe(2)
    expect(harness.database.prepare(`SELECT human_priority_state FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "claimed" })
    expect(harness.store.claimDue(dueAt)?.thread.id).toBe(thread.id)
  })

  it("人工优先已发稍等后模型失败会真实转人工并发送终态", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-model-failure")
    markHumanPriorityClaimed(harness, thread, event.id)
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "handoff-message")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => { throw new Error("模型连接失败") },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "这边没处理完，我帮你转给技术继续跟进",
      thread.anchorMessageId,
      undefined,
      expect.objectContaining({ threadId: thread.id, kind: "support_reply" }),
    )
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "escalated", decision: "escalate", errorCode: "answer_model_failed" }),
    ])
  })

  it("人工优先已发稍等后模型选择 ignore 也转人工而不静默关闭", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-ignore")
    markHumanPriorityClaimed(harness, thread, event.id)
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "handoff-message")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: { ...answerDecision(), decision: "ignore", answer: "", reason: "判断为无需回复" },
      sendMessage,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "这边没处理完，我帮你转给技术继续跟进",
      thread.anchorMessageId,
      undefined,
      expect.objectContaining({ threadId: thread.id, kind: "support_reply" }),
    )
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "escalated",
        decision: "escalate",
        errorCode: "answer_ignored_after_human_priority",
      }),
    ])
  })

  it("人工优先已发稍等后代码资源不可用会转人工而不静默关闭", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-snapshot-failure")
    markHumanPriorityClaimed(harness, thread, event.id)
    const sendMessage = vi.fn(async () => "handoff-message")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const sendCodeSyncFailure = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => { throw new ProjectCodeSyncUnavailableError(randomUUID(), codeSyncFailure()) },
      sendMessage,
      sendSupportAlert,
      sendCodeSyncFailure,
    })

    await worker.runDueOnce(new Date())

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendCodeSyncFailure).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "这边没处理完，我帮你转给技术继续跟进",
      thread.anchorMessageId,
      undefined,
      expect.objectContaining({ threadId: thread.id, kind: "support_reply" }),
    )
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "escalated", decision: "escalate", errorCode: "investigation_runtime_failed" }),
    ])
  })

  it("人工优先已发稍等后业务语义不再触发硬拦截", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-output-rejected", "你是不是机器人")
    markHumanPriorityClaimed(harness, thread, event.id)
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "handoff-message")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: { ...answerDecision(), answer: "我是 AI 自动客服 现在帮你看" },
      sendMessage,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "我是 AI 自动客服 现在帮你看",
      thread.anchorMessageId,
      null,
      expect.objectContaining({ threadId: thread.id, kind: "support_reply" }),
    )
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "replied", decision: "reply", errorCode: null }),
    ])
  })

  it("人工在发送 CAS 前接管时 Telegram sender 绝不调用", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "101")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    expect(claimed.thread.id).toBe(thread.id)
    const reply = seedGeneratingReply(harness, claimed.thread)

    const competingDatabase = await RuntimeDatabase.open(harness.filePath)
    openDatabases.push(competingDatabase)
    const competingHarness = {
      ...harness,
      database: competingDatabase,
      redactor: new ConfiguredSecretRedactor(competingDatabase),
    }
    competingHarness.store = new SupportThreadStore(competingDatabase, competingHarness.redactor)
    competingHarness.replies = new ReplyService(competingDatabase, new ReplyEventBus(), competingHarness.redactor)
    const observer = createObserver(competingHarness)
    const takeover: { value: ReturnType<typeof observeHuman> | null } = { value: null }
    const getDetail = harness.replies.getDetail.bind(harness.replies)
    let interleaveTakeover = true
    harness.replies.getDetail = ((id: string) => {
      const found = getDetail(id)
      if (interleaveTakeover && id === reply.id) {
        interleaveTakeover = false
        takeover.value = observeHuman(competingHarness, observer, { messageId: "102", replyToMessageId: "101" })
      }
      return found
    })

    let telegramSendCount = 0
    const sending = harness.replies.claimSending(reply.id, {
      answer: "已经生成但尚未取得发送所有权",
      decisionReason: "测试发送边界",
    })
    if (sending) telegramSendCount += 1

    expect(takeover.value?.observation?.takeoverStatus).toBe("cancelled")
    expect(sending).toBeNull()
    expect(telegramSendCount).toBe(0)
    expect(harness.replies.getDetail(reply.id).status).toBe("superseded")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it("worker 生成后发送前重新确认人工接管状态", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "201")
    let signalAgentStarted!: () => void
    let finishGeneration!: (decision: AnswerDecision) => void
    const agentStarted = new Promise<void>((resolve) => { signalAgentStarted = resolve })
    const generated = new Promise<AnswerDecision>((resolve) => { finishGeneration = resolve })
    const snapshot = seedCodeSnapshot(harness)
    let telegramSendCount = 0
    const worker = new SupportAnswerWorker({
      database: harness.database,
      store: harness.store,
      replies: harness.replies,
      config: new ModelConfigService(harness.database),
      knowledge: new RuntimeKnowledgeService(harness.database, harness.redactor),
      redactor: harness.redactor,
      codeSync: {
        readCurrentSnapshot: () => snapshot,
        currentServiceForSnapshot: () => harness.service,
      },
      agent: {
        decide: async () => {
          signalAgentStarted()
          return generated
        },
      },
      transport: {
        sendMessage: async () => {
          telegramSendCount += 1
          return "robot-201"
        },
      },
      technicalAlerts: {
        sendSupportAlert: async () => ({ status: "sent", summary: "sent", errorType: null }),
        sendCodeSyncFailure: async () => ({ status: "sent", summary: "sent", errorType: null }),
      },
      learning: { enqueue: () => undefined },
      resourceWorkspace: new ResourceWorkspace(harness.database),
    })
    const observer = createObserver(harness, worker)

    const running = worker.runDueOnce(new Date())
    await Promise.race([
      agentStarted,
      running.then(() => { throw new Error("worker 在 agent 启动前结束") }),
    ])
    const takeover = observeHuman(harness, observer, { messageId: "202", replyToMessageId: "201" })
    finishGeneration(answerDecision())
    await running

    expect(takeover.observation?.takeoverStatus).toBe("cancelled")
    expect(telegramSendCount).toBe(0)
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "superseded" }),
    ])
  })

  it("进入 sending 后人工接管记录 delivery_in_flight 且不伪称 cancelled", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "301")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    expect(harness.replies.claimSending(reply.id, { answer: "已取得发送所有权" })?.status).toBe("sending")
    const observer = createObserver(harness)

    const takeover = observeHuman(harness, observer, { messageId: "302", replyToMessageId: "301" })

    expect(takeover.observation?.takeoverStatus).toBe("delivery_in_flight")
    expect(harness.replies.getDetail(reply.id).status).toBe("sending")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it("普通回复实际发送携带统一 thread reply ownership", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "321")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "robot-321")
    const worker = createWorker(harness, { readCurrentSnapshot: () => snapshot, sendMessage })

    await worker.runDueOnce(new Date())

    const reply = harness.database.readReplies("WHERE r.thread_id=?", [thread.id])[0]!
    const calls = sendMessage.mock.calls as unknown[][]
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[5]).toEqual({
      groupId: harness.group.id,
      threadId: thread.id,
      serviceId: thread.serviceId,
      replyId: reply.id,
      kind: "support_reply",
    })
  })

  it("连续追问始终回复最新消息并按真实时间交错提供上下文", async () => {
    const harness = await createBaseHarness()
    const createdAt = new Date().toISOString()
    harness.database.prepare(`INSERT INTO project_services(
      id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), harness.service.projectId, "mcbpay", "MCBPay", "", "Asia/Shanghai", null, "main", 1, createdAt, createdAt,
    )
    const { thread } = createQuestion(harness, "3211", "mcbpay今天营收怎么样")
    const snapshot = seedCodeSnapshot(harness)
    const answers = [
      "mcbpay这边的数据要在对应服务查\n你到mcbpay群发一下",
      "是同一个团队\n你到mcbpay群发一下 我们接着查",
    ]
    const agentInputs: SupportDecisionInput[] = []
    const sendMessage = vi.fn()
      .mockResolvedValueOnce("robot-3211")
      .mockResolvedValueOnce("robot-3212")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: () => ({ ...answerDecision(), answer: answers[agentInputs.length - 1] ?? answers.at(-1)! }),
      onAgentInput: (input) => { agentInputs.push(input) },
      sendMessage,
    })

    await worker.runDueOnce(new Date())

    const followupAt = new Date(Date.now() + 1_000).toISOString()
    const followup = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "3212",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId: "303212",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "mcbpay的团队不也是你们吗",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      createdAt: followupAt,
    }).event
    expect(harness.store.appendMessage({
      threadId: thread.id,
      eventId: followup.id,
      relation: "reopen",
      questionFragment: followup.safeText,
      settleAt: new Date(Date.now() - 1_000).toISOString(),
    })).not.toBeNull()

    expect(await worker.runDueOnce(new Date(Date.now() + 2_000))).toBe(true)

    const calls = sendMessage.mock.calls as unknown[][]
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[2]).toBe(answers[0])
    expect(calls[1]?.[2]).toBe(answers[1])
    expect(calls[0]?.[3]).toBe("3211")
    expect(calls[1]?.[3]).toBe("3212")
    const replies = harness.database.readReplies("WHERE r.thread_id=? ORDER BY r.input_revision", [thread.id])
    expect(replies.map((reply) => reply.telegramMessageId)).toEqual(["3211", "3212"])
    expect(agentInputs[1]?.latestMessage).toBe("mcbpay的团队不也是你们吗")
    expect(agentInputs[1]).not.toHaveProperty("projectServices")
    const context = agentInputs[1]?.conversationContext ?? ""
    const firstUserAt = context.indexOf("[运营 ")
    const firstAnswerAt = context.indexOf("[客服 ")
    const latestUserAt = context.lastIndexOf("message_id=3212")
    expect(firstUserAt).toBeGreaterThanOrEqual(0)
    expect(firstAnswerAt).toBeGreaterThan(firstUserAt)
    expect(latestUserAt).toBeGreaterThan(firstAnswerAt)
  })

  it("模型生成的时间 金额 百分比和URL逐字发送", async () => {
    const harness = await createBaseHarness()
    createQuestion(harness, "3213", "今天营收怎么样")
    const snapshot = seedCodeSnapshot(harness)
    const answer = "截至21:00代收成功1,097,127.00 共2,176笔 成功率36.09%\n明细 https://pay.example.com/report/2026-08-14"
    const sendMessage = vi.fn().mockResolvedValue("robot-3213")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: { ...answerDecision(), answer },
      sendMessage,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[2]).toBe(answer)
    expect(harness.database.readReplies("ORDER BY r.created_at DESC LIMIT 1")[0]?.answer).toBe(answer)
  })

  it("回答模型业务措辞不再由确定性代码静默阻断或改写", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "3213-identity", "你是不是机器人")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn()
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: { ...answerDecision(), answer: "我是 AI 自动客服 现在帮你看" },
      sendMessage,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[2]).toBe("我是 AI 自动客服 现在帮你看")
    expect(harness.store.getThread(thread.id).status).toBe("answered")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "replied",
        errorCode: null,
      }),
    ])
  })

  it("回答模型失败时不发送任何代码兜底消息", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "3214", "mcbpay营收呢")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn()
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => { throw new Error("模型连接失败") },
      sendMessage,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(harness.store.getThread(thread.id).status).toBe("answered")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "answer_model_failed",
        answer: "",
      }),
    ])
  })

  it("回答模型结构错误时自动重试一次并保留首轮真实失败记录", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "3214-structured", "帮我查这笔初始化订单")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "robot-3214-structured")
    let attempts = 0
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        attempts += 1
        if (attempts === 1) throw new ModelExecutionError("structured_output_invalid", "answerClaims 字段无效")
        return answerDecision()
      },
      sendMessage,
    })

    await worker.runDueOnce(new Date())
    expect(harness.store.getThread(thread.id).status).toBe("collecting")
    await worker.runDueOnce(new Date(Date.now() + 1_000))

    expect(attempts).toBe(2)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.store.getThread(thread.id).status).toBe("answered")
    expect(harness.database.readReplies("WHERE r.thread_id=? ORDER BY r.created_at,r.id", [thread.id])).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "structured_output_invalid" }),
      expect.objectContaining({ status: "replied", errorCode: null }),
    ])
  })

  it("学习线程的结构化输出错误同样自动重试一次再保存影子结果", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare("UPDATE telegram_groups SET operation_mode='learning' WHERE id=?")
      .run(harness.group.id)
    const { thread } = createQuestion(harness, "shadow-structured", "帮我查这笔初始化订单")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "must-not-send")
    let attempts = 0
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        attempts += 1
        if (attempts === 1) throw new ModelExecutionError("structured_output_invalid", "answerClaims 字段无效")
        return answerDecision()
      },
      sendMessage,
    })

    await worker.runDueOnce(new Date())
    expect(harness.store.getThread(thread.id).status).toBe("collecting")
    await worker.runDueOnce(new Date(Date.now() + 1_000))

    expect(attempts).toBe(2)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT outcome_status FROM shadow_answer_results WHERE thread_id=?").get(thread.id))
      .toEqual({ outcome_status: "completed" })
  })

  it("回答 prompt 使用规范化副本而事件与 question_fragment 保留原始空白", async () => {
    const harness = await createBaseHarness()
    const rawText = "  {\n  \"a\":1\n}\n"
    const normalizedText = rawText.trim()
    const { event, thread } = createQuestion(harness, "323", rawText)
    const snapshot = seedCodeSnapshot(harness)
    const agentInputs: SupportDecisionInput[] = []
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      onAgentInput: (input) => { agentInputs.push(input) },
    })

    await worker.runDueOnce(new Date())

    expect(rawText).toHaveLength(14)
    expect(normalizedText).toHaveLength(11)
    expect(harness.store.getEvent(event.id).safeText).toBe(rawText)
    expect(harness.store.getThreadDetail(thread.id).messages[0]?.questionFragment).toBe(rawText)
    expect(agentInputs[0]?.question).toContain(`]\n${normalizedText}`)
    expect(agentInputs[0]?.question).not.toContain(`]\n${rawText}`)
  })

  it("有人在吗精确短句等待5秒后直接回复在的不调用路由模型", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T02:00:00.000Z"))
    const harness = await createBaseHarness()
    const route = vi.fn(async () => { throw new Error("在线确认不应调用线程路由模型") })
    const sendPresenceReply = vi.fn(async () => "presence-1")
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route },
      batchWindowMs: 30_000,
      wake: () => undefined,
      sendPresenceReply,
    })

    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: "presence-1",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: " 有 人 在 吗？ ",
      attachments: [],
      createdAt: "2026-08-18T02:00:00.000Z",
    })!

    await vi.advanceTimersByTimeAsync(4_999)
    expect(sendPresenceReply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sendPresenceReply).toHaveBeenCalledWith({
      group: expect.objectContaining({ id: harness.group.id }),
      event: expect.objectContaining({ id: event.id, telegramMessageId: "presence-1" }),
      text: "在的",
    })
    expect(route).not.toHaveBeenCalled()
    expect(harness.store.findThreadByEvent(event.id)).toBeNull()
    expect(harness.store.getEvent(event.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "已发送在线确认快捷回复",
    })
    await coordinator.stop()
  })

  it("5秒内已有配置人工回应时取消在的快捷回复", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T02:10:00.000Z"))
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const sendPresenceReply = vi.fn(async () => "presence-2")
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => { throw new Error("在线确认不应调用线程路由模型") } },
      wake: () => undefined,
      sendPresenceReply,
    })
    const presence = coordinator.accept({
      groupId: harness.group.id,
      messageId: "presence-2",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "有人在吗",
      attachments: [],
      createdAt: "2026-08-18T02:10:00.000Z",
    })!
    await vi.advanceTimersByTimeAsync(2_000)
    coordinator.accept({
      groupId: harness.group.id,
      messageId: "presence-human-2",
      senderId: "20001",
      senderUsername: "operator_20001",
      senderDisplayName: "可信客服",
      fromBot: false,
      replyToMessageId: "presence-2",
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "在",
      attachments: [],
      createdAt: "2026-08-18T02:10:02.000Z",
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sendPresenceReply).not.toHaveBeenCalled()
    expect(harness.store.getEvent(presence.id)).toMatchObject({
      routeStatus: "ignored",
      skipReason: "群内人工已回应在线确认",
    })
    await coordinator.stop()
  })

  it("服务重启后恢复未到期在线确认且相似业务问句不走快捷回复", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T02:20:00.000Z"))
    const harness = await createBaseHarness()
    const first = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => { throw new Error("在线确认不应调用线程路由模型") } },
      wake: () => undefined,
    })
    first.accept({
      groupId: harness.group.id,
      messageId: "presence-restart",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "有人在吗！",
      attachments: [],
      createdAt: "2026-08-18T02:20:00.000Z",
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await first.stop()

    const route = vi.fn(async () => ({
      action: "idle" as const,
      questionFragment: "有人在处理吗",
      reason: "测试普通路由",
      confidence: 1,
      clarificationReply: null,
    }))
    const sendPresenceReply = vi.fn(async () => "presence-restart-reply")
    const recovered = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route },
      batchWindowMs: 30_000,
      wake: () => undefined,
      sendPresenceReply,
    })
    recovered.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sendPresenceReply).toHaveBeenCalledTimes(1)

    recovered.accept({
      groupId: harness.group.id,
      messageId: "presence-business",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "有人在处理吗",
      attachments: [],
      createdAt: "2026-08-18T02:20:05.000Z",
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendPresenceReply).toHaveBeenCalledTimes(1)
    expect(harness.store.listUnroutedEvents()).toEqual([
      expect.objectContaining({ telegramMessageId: "presence-business" }),
    ])
    await recovered.stop()
  })

  const jsonBody = "{\n  \"a\":1\n}"
  const boundaryBody = `${"x".repeat(3_999)} y`

  it.each([
    { scenario: "短 support 稳定", ingestPurpose: "support" as const, answerPurpose: "support" as const, rawText: `  /ai   ${jsonBody}\n`, expectedBody: jsonBody },
    { scenario: "4000 边界空白 support 稳定", ingestPurpose: "support" as const, answerPurpose: "support" as const, rawText: `/ai ${boundaryBody}`, expectedBody: boundaryBody },
  ])("$scenario 的 immediate /ai 原文完整落库但 prompt 固定接收时正文", async ({
    ingestPurpose,
    answerPurpose,
    rawText,
    expectedBody,
  }) => {
    const harness = await createBaseHarness()
    const setGroupPurpose = (purpose: "support" | "technical_alert"): void => {
      const answerModelId = String((harness.database.prepare(
        "SELECT model_instance_id FROM runtime_model_bindings WHERE purpose='answer'",
      ).get() as { model_instance_id: string }).model_instance_id)
      if (purpose === "technical_alert") {
        harness.database.prepare(`UPDATE telegram_groups SET purpose='technical_alert',project_id=NULL,service_id=NULL,
          trigger_mode='command',ai_model_instance_id=?,updated_at=? WHERE id=?`).run(
          answerModelId, "2026-08-11T00:00:00.000Z", harness.group.id,
        )
      } else {
        harness.database.prepare(`UPDATE telegram_groups SET purpose='support',project_id=?,service_id=?,
          trigger_mode='all',ai_model_instance_id=NULL,updated_at=? WHERE id=?`).run(
          harness.service.projectId, harness.service.id, "2026-08-11T00:00:00.000Z", harness.group.id,
        )
      }
    }
    setGroupPurpose(ingestPurpose)
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => { throw new Error("immediate /ai 不应调用线程路由模型") } },
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const event = coordinator.accept({
      groupId: harness.group.id,
      messageId: `${ingestPurpose === "support" ? "323" : "324"}-${answerPurpose}`,
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: rawText,
      attachments: [],
      createdAt: "2026-08-11T00:00:00.000Z",
    })
    const detail = harness.store.getThreadDetail(harness.store.findThreadByEvent(event!.id)!.id)
    setGroupPurpose(answerPurpose)
    const agentInputs: SupportDecisionInput[] = []
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      onAgentInput: (input) => { agentInputs.push(input) },
    })

    await worker.runDueOnce(new Date("2026-08-11T00:01:00.000Z"))

    expect(event?.safeText).toBe(rawText)
    expect(detail.messages[0]?.questionFragment).toBe(rawText)
    expect(agentInputs[0]?.question).toContain(`]\n${expectedBody}`)
    expect(agentInputs[0]?.question).not.toContain("/ai")
    expect(detail.thread.summary).toBe(expectedBody)
  })

  it("技术群 /ai 和普通消息都只留审计且不创建问题线程或回复", async () => {
    const harness = await createBaseHarness()
    harness.database.prepare(`UPDATE telegram_groups SET purpose='technical_alert',project_id=NULL,service_id=NULL,
      trigger_mode='command',updated_at=? WHERE id=?`).run("2026-08-11T00:00:00.000Z", harness.group.id)
    const sendHelp = vi.fn(async () => undefined)
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => { throw new Error("技术群消息不应进入路由模型") } },
      batchWindowMs: 30_000,
      wake: () => undefined,
      sendHelp,
    })

    for (const [messageId, text] of [["3241", "/ai lakpay 查一下"], ["3242", "普通技术群消息"]] as const) {
      const event = coordinator.accept({
        groupId: harness.group.id,
        messageId,
        senderId: "30001",
        senderUsername: null,
        senderDisplayName: "技术",
        fromBot: false,
        replyToMessageId: null,
        messageThreadId: null,
        replyTargetIsBot: false,
        text,
        attachments: [],
      })
      expect(event).toMatchObject({ routeStatus: "ignored", skipReason: "技术群只接收运营问题原消息转发" })
      expect(harness.store.findThreadByEvent(event!.id)).toBeNull()
    }
    expect(sendHelp).not.toHaveBeenCalled()
  })

  it("升级先持久取得技术告警发送权 再只发一条携带 ownership 的运营回复", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "325")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const order: string[] = []
    const sendMessage = vi.fn(async () => {
      order.push("operator")
      return "robot-325"
    })
    const sendSupportAlert = vi.fn(async () => {
      order.push("alert")
      return { status: "sent" as const, summary: "已发送", errorType: null }
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage,
      sendSupportAlert,
    })
    const internal = worker as unknown as {
      escalate(
        replyId: string,
        currentThread: SupportThread,
        inputRevision: number,
        group: RuntimeGroup,
        decision: AnswerDecision,
        latestMessage: string,
        codeRevision: string | null,
        allowedMemoryIds: Set<string>,
      ): Promise<void>
    }

    await internal.escalate(
      reply.id, claimed.thread, claimed.inputRevision, harness.group, escalationDecision(),
      "银行编码为空", "a".repeat(40), new Set(),
    )

    expect(order).toEqual(["alert", "operator"])
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect((sendMessage.mock.calls as unknown[][])[0]?.[5]).toEqual({
      groupId: harness.group.id,
      threadId: thread.id,
      serviceId: thread.serviceId,
      replyId: reply.id,
      kind: "support_reply",
    })
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(escalationDecision().answer)
    expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='escalation'`).get(reply.id)).toEqual({ status: "sent" })
  })

  it("技术告警 sender 抛异常时持久失败且仍只发一条已通知运营回复", async () => {
    const harness = await createBaseHarness()
    createQuestion(harness, "327")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const sendMessage = vi.fn(async () => "robot-327")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage,
      sendSupportAlert: async () => { throw new Error("测试告警 sender 异常") },
    })
    const internal = worker as unknown as {
      escalate(
        replyId: string,
        currentThread: SupportThread,
        inputRevision: number,
        group: RuntimeGroup,
        decision: AnswerDecision,
        latestMessage: string,
        codeRevision: string | null,
        allowedMemoryIds: Set<string>,
      ): Promise<void>
    }

    await expect(internal.escalate(
      reply.id, claimed.thread, claimed.inputRevision, harness.group, escalationDecision(),
      "银行编码为空", "a".repeat(40), new Set(),
    )).resolves.toBeUndefined()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(escalationDecision().answer)
    expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='escalation'`).get(reply.id)).toEqual({ status: "failed" })
    expect(harness.replies.getDetail(reply.id)).toMatchObject({ status: "escalated" })
  })

  it("升级最终发送逐字使用模型生成文案 不再由代码套固定风格", async () => {
    const harness = await createBaseHarness()
    createQuestion(harness, "329")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const pinned = operatorStyleProfileSchema.parse({
      ...baselineOperatorStyleProfile,
      serviceTone: "concise_businesslike",
      languageRegister: "direct_business_chat",
      ordinaryPunctuation: "standard",
      simpleReply: { maxMessages: 1, maxLines: 1 },
      allowedPhrases: ["补一下"],
      forbiddenPhrases: ["您好", "根据排查", "请提供"],
      clarification: { requestMaterial: "补一下" },
    })
    const sendMessage = vi.fn(async () => "robot-329")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage,
    })
    const internal = worker as unknown as {
      escalate(
        replyId: string,
        currentThread: SupportThread,
        inputRevision: number,
        group: RuntimeGroup,
        decision: AnswerDecision,
        latestMessage: string,
        codeRevision: string | null,
        allowedMemoryIds: Set<string>,
      ): Promise<void>
    }

    await internal.escalate(
      reply.id,
      { ...claimed.thread, answerReplyStyle: "human", operatorStyleProfile: pinned },
      claimed.inputRevision,
      harness.group,
      { ...escalationDecision(), answer: "根据排查 maya银行映射没配上\n需要补齐映射" },
      "银行编码为空",
      "a".repeat(40),
      new Set(),
    )

    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe("根据排查 maya银行映射没配上\n需要补齐映射")
  })

  it("progress 真正发送 CAS 前人工接管为 cancelled，之后不能取得发送权", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "331")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const notification = harness.store.claimDueProgress(now)!
    expect(notification.status).toBe("pending")
    const observer = createObserver(harness)

    const takeover = observeHuman(harness, observer, { messageId: "332", replyToMessageId: "331" })
    const claimed = (harness.store as unknown as {
      claimNotificationSending(id: string): unknown
    }).claimNotificationSending(notification.id)

    expect(takeover.observation?.takeoverStatus).toBe("cancelled")
    expect(claimed).toBeNull()
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it("人工优先已经发送稍等后补充版本不再发送通用 progress", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "3301", "@windpayDR 帮忙看看回调地址为空", ["20001"])
    markHumanPriorityClaimed(harness, thread, event.id)
    const now = new Date().toISOString()
    harness.database.prepare("UPDATE support_threads SET settle_at=? WHERE id=?").run(now, thread.id)

    const claimed = harness.store.claimDue(now, 0)

    expect(claimed?.thread.id).toBe(thread.id)
    expect(harness.store.claimDueProgress(now)).toBeNull()
  })

  it("旧版本通用 progress 已发送后新补充版本不重复发送稍等", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "3302")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const first = harness.store.claimDueProgress(now)!
    harness.store.claimNotificationSending(first.id, now)
    harness.store.completeNotification(first.id, "progress-3302", now)
    const supplement = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "3303",
      replyToMessageId: "3302",
      messageThreadId: null,
      senderUserId: "303302",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "测试代收的",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    harness.store.appendMessage({
      threadId: thread.id,
      eventId: supplement.id,
      relation: "supplement",
      questionFragment: supplement.safeText,
      settleAt: now,
    })
    const next = harness.store.claimDue(now, 0)

    expect(next?.inputRevision).toBe(2)
    expect(harness.store.claimDueProgress(now)).toBeNull()
  })

  it("旧版本 progress 尚未开始发送时补充版本仍保留一次提示机会", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "3304")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const unsent = harness.store.claimDueProgress(now)!
    const supplement = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "3305",
      replyToMessageId: "3304",
      messageThreadId: null,
      senderUserId: "303304",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "补充信息",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    harness.store.appendMessage({
      threadId: thread.id,
      eventId: supplement.id,
      relation: "supplement",
      questionFragment: supplement.safeText,
      settleAt: now,
    })
    harness.store.claimDue(now, 0)
    const current = harness.store.claimDueProgress(now)

    expect(unsent.inputRevision).toBe(1)
    expect(current?.inputRevision).toBe(2)
  })

  it("通用 progress 已发送后同一线程再次进入人工优先也不重复发送稍等", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "3306")
    const firstAt = new Date().toISOString()
    harness.store.claimDue(firstAt, 0)
    const progress = harness.store.claimDueProgress(firstAt)!
    harness.store.claimNotificationSending(progress.id, firstAt)
    harness.store.completeNotification(progress.id, "progress-3306", firstAt)
    const supplementAt = new Date(Date.parse(firstAt) + 1_000).toISOString()
    const supplement = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "3307",
      replyToMessageId: "3306",
      messageThreadId: null,
      senderUserId: "303306",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "@windpayDR 再看一下",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      humanPriorityUserIds: ["20001"],
      createdAt: supplementAt,
    }).event
    harness.store.appendMessage({
      threadId: thread.id,
      eventId: supplement.id,
      relation: "supplement",
      questionFragment: supplement.safeText,
      settleAt: supplementAt,
    })
    const dueAt = new Date(Date.parse(supplementAt) + 3 * 60_000).toISOString()

    expect(harness.store.claimDueHumanPriority(dueAt)).toBeNull()
    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_error FROM support_threads
      WHERE id=?`).get(thread.id)).toEqual({
      human_priority_state: "claimed",
      human_priority_error: "同一问题此前已发送稍等，不重复发送",
    })
  })

  it("progress 发送 CAS 后人工接管记录 delivery_in_flight", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "341")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const notification = harness.store.claimDueProgress(now)!
    const claimed = (harness.store as unknown as {
      claimNotificationSending(id: string): { status: string } | null
    }).claimNotificationSending(notification.id)
    expect(claimed?.status).toBe("sending")
    const observer = createObserver(harness)

    const takeover = observeHuman(harness, observer, { messageId: "342", replyToMessageId: "341" })

    expect(takeover.observation?.takeoverStatus).toBe("delivery_in_flight")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it("progress 实际发送携带统一 thread ownership，发送中接管不伪称 cancelled", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "345")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    let markSending!: () => void
    let completeSend!: (messageId: string) => void
    const sendingStarted = new Promise<void>((resolve) => { markSending = resolve })
    const sendResult = new Promise<string>((resolve) => { completeSend = resolve })
    const sendMessage = vi.fn(async () => {
      markSending()
      return sendResult
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0 },
      transport: { sendMessage },
    })
    const observer = createObserver(harness)

    const running = deadline.runOnce(new Date(now))
    await sendingStarted
    const notification = harness.database.prepare(`SELECT id FROM support_thread_notifications
      WHERE thread_id=? AND kind='progress'`).get(thread.id) as { id: string }
    const takeover = observeHuman(harness, observer, { messageId: "346", replyToMessageId: "345" })
    completeSend("progress-345")
    await running

    expect(takeover.observation?.takeoverStatus).toBe("delivery_in_flight")
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "稍等",
      thread.anchorMessageId,
      undefined,
      {
        groupId: harness.group.id,
        threadId: thread.id,
        serviceId: thread.serviceId,
        notificationId: notification.id,
        kind: "progress",
      },
    )
  })

  it("技术告警 claim 先提交时人工接管记录 delivery_in_flight", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "351")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    expect(harness.replies.claimTechnicalAlert(reply.id, "code_sync_fallback")).toBe(true)
    const observer = createObserver(harness)

    const takeover = observeHuman(harness, observer, { messageId: "352", replyToMessageId: "351" })

    expect(takeover.observation?.takeoverStatus).toBe("delivery_in_flight")
    expect(harness.replies.getDetail(reply.id).status).toBe("superseded")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it("非客服升级类系统告警不向技术群发送任何消息", async () => {
    const harness = await createBaseHarness()
    const normalizedQuestion = "超长问题".repeat(1_500)
    const rawQuestion = `  ${normalizedQuestion}\n`
    const { event, thread } = createQuestion(harness, "355", rawQuestion)
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    const timestamp = new Date().toISOString()
    const accountId = randomUUID()
    harness.database.insertAccount({
      id: accountId,
      name: "技术告警机器人",
      type: "bot",
      enabled: true,
      status: "ready",
      statusMessage: "",
      credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
      botUsername: "alert_bot",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const targetGroupId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      targetGroupId, "technical-alert", "技术告警群", "-10002", accountId, harness.service.projectId, harness.service.id,
      1, "bot", "all", "telegram", "[]", null, null, "database", "technical", "technical_alert", timestamp, timestamp,
    )
    const sendMessage = vi.fn(async () => "alert-message")
    const alerts = new TechnicalAlertService(
      harness.database,
      harness.store,
      harness.replies,
      harness.redactor,
      { sendMessage },
    )

    expect(await alerts.sendSupportAlert(harness.group, reply.id, "系统运行异常")).toEqual({
      status: "not_configured", summary: "技术群系统消息已停用", errorType: null,
    })
    expect(harness.store.getEvent(event.id).safeText).toBe(rawQuestion)
    expect(normalizedQuestion.length).toBeGreaterThan(4_000)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("问题升级和产品需求补齐被引用原消息并逐条确认转发且不发送说明话术", async () => {
    const harness = await createBaseHarness()
    harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "3550",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId: "303550",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "这是需要一起看的原始文件",
      attachmentSummary: "orders.xlsx",
      routeStatus: "ignored",
      skipReason: "此前未建立问题线程",
    })
    const { thread } = createQuestion(harness, "3551", "poppay这笔失败了 帮忙查下")
    harness.database.prepare("UPDATE support_message_events SET reply_to_message_id='3550' WHERE telegram_message_id='3551'").run()
    const followup = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "3552",
      replyToMessageId: "3551",
      messageThreadId: null,
      senderUserId: "303552",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "麻烦加急一下",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    expect(harness.store.appendMessage({
      threadId: thread.id,
      eventId: followup.id,
      relation: "supplement",
      questionFragment: followup.safeText,
      settleAt: new Date(Date.now() - 1_000).toISOString(),
    })).not.toBeNull()
    harness.store.claimDue(new Date().toISOString())
    const currentThread = harness.store.getThread(thread.id)
    const reply = seedGeneratingReply(harness, currentThread)
    const timestamp = new Date().toISOString()
    const accountId = randomUUID()
    harness.database.insertAccount({
      id: accountId,
      name: "技术告警机器人",
      type: "bot",
      enabled: true,
      status: "ready",
      statusMessage: "",
      credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
      botUsername: "alert_bot",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const targetGroupId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      targetGroupId, "technical-forward", "技术告警群", "-10005", accountId, harness.service.projectId, harness.service.id,
      1, "bot", "all", "telegram", "[]", null, null, "database", "technical", "technical_alert", timestamp, timestamp,
    )
    const sendMessage = vi.fn(async () => "不应发送")
    const forwardMessages = vi.fn(async (
      _accountId: string | null,
      _targetChatId: string,
      _sourceChatId: string,
      _messageIds: string[],
      _ownership?: TelegramOutputOwnership,
    ) => _messageIds.map((messageId) => `5${messageId}`))
    const alerts = new TechnicalAlertService(
      harness.database,
      harness.store,
      harness.replies,
      harness.redactor,
      { sendMessage, forwardMessages },
    )

    await expect(alerts.sendSupportAlert(
      harness.group,
      reply.id,
      "内部分类器原因不应出现在技术群",
      "运营回复不应出现在技术群",
      "escalation",
    )).resolves.toEqual({ status: "sent", summary: "已转发 3 条", errorType: null })
    await expect(alerts.sendTransientFeatureRequest(
      harness.group,
      reply.id,
      "产品改动分析不应出现在技术群",
      "已通知技术",
    )).resolves.toEqual({ status: "sent", summary: "已转发 3 条", errorType: null })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(forwardMessages).toHaveBeenCalledTimes(2)
    expect(forwardMessages.mock.calls.map((call) => call[3])).toEqual([
      ["3550", "3551", "3552"], ["3550", "3551", "3552"],
    ])
    expect(forwardMessages.mock.calls[0]?.[4]).toEqual({
      groupId: targetGroupId,
      threadId: currentThread.id,
      serviceId: currentThread.serviceId,
      replyId: reply.id,
      kind: "technical_alert:escalation",
    })
    expect(forwardMessages.mock.calls[1]?.[4]).toEqual(expect.objectContaining({
      kind: "technical_alert:feature_request",
    }))
  })

  it("系统告警即使含敏感内容也保持静默且不生成技术群文本", async () => {
    const harness = await createBaseHarness()
    const configuredSecret = "prod-secret-value"
    const botToken = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"
    const password = "password=plain-text-secret"
    const boundaryCredential = "0123456789abcdef0123456789abcdef"
    const { thread, event } = createQuestion(
      harness,
      "357",
      `${configuredSecret} ${botToken} ${password} ${"x".repeat(2790)}${boundaryCredential}`,
    )
    harness.database.prepare(`UPDATE support_message_events SET sender_display_name=?,safe_text=?,attachment_summary=? WHERE id=?`).run(
      `运营 ${configuredSecret}`, `${"x".repeat(2760)}${boundaryCredential}`, `附件 ${botToken}`, event.id,
    )
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    const timestamp = new Date().toISOString()
    const accountId = randomUUID()
    harness.database.insertAccount({
      id: accountId,
      name: "技术告警机器人",
      type: "bot",
      enabled: true,
      status: "ready",
      statusMessage: "",
      credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
      botUsername: "alert_bot",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const targetGroupId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      targetGroupId, "technical-alert-dlp", "技术告警群", "-10004", accountId, harness.service.projectId, harness.service.id,
      1, "bot", "all", "telegram", "[]", null, null, "database", "technical", "technical_alert", timestamp, timestamp,
    )
    const sendMessage = vi.fn(async () => "alert-message")
    const redactor = new ConfiguredSecretRedactor(harness.database, () => [configuredSecret])
    const alerts = new TechnicalAlertService(harness.database, harness.store, harness.replies, redactor, { sendMessage })

    await expect(alerts.sendSupportAlert(
      { ...harness.group, name: `客服群 ${configuredSecret}` },
      reply.id,
      `根因 ${configuredSecret} ${password}`,
      `运营结论 ${botToken}`,
    )).resolves.toEqual({ status: "not_configured", summary: "技术群系统消息已停用", errorType: null })
    expect(boundaryCredential).toHaveLength(32)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("定时代码同步状态不再发送技术群", async () => {
    const harness = await createBaseHarness()
    const timestamp = new Date().toISOString()
    const accountId = randomUUID()
    harness.database.insertAccount({
      id: accountId,
      name: "技术告警机器人",
      type: "bot",
      enabled: true,
      status: "ready",
      statusMessage: "",
      credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
      botUsername: "alert_bot",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const targetGroupId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_groups(
      id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
      platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      targetGroupId, "hourly-alert", "定时技术告警群", "-10003", accountId, harness.service.projectId, harness.service.id,
      1, "bot", "all", "telegram", "[]", null, null, "database", "technical", "technical_alert", timestamp, timestamp,
    )
    const sendMessage = vi.fn(async () => "hourly-alert-message")
    const alerts = new TechnicalAlertService(
      harness.database,
      harness.store,
      harness.replies,
      harness.redactor,
      { sendMessage },
    )

    await alerts.sendHourlyCodeSyncFailure({
      serviceId: harness.service.id,
      service: harness.service.key,
      branch: harness.service.branch,
      batchId: randomUUID(),
      failure: codeSyncFailure(),
      snapshot: null,
    })

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("技术告警 claim 后进程中断恢复不会永久误报 delivery_in_flight", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "361")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    expect(harness.replies.claimTechnicalAlert(reply.id, "code_sync_fallback")).toBe(true)
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?")
      .run("2026-08-10T00:00:00.000Z", thread.id)

    expect(harness.store.recoverStaleGenerating(
      "2026-08-11T00:00:00.000Z",
      "2026-08-10T01:00:00.000Z",
    )).toBe(1)

    expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='code_sync_fallback'`).get(reply.id)).toEqual({ status: "uncertain" })
    const observer = createObserver(harness)
    const takeover = observeHuman(harness, observer, { messageId: "362", replyToMessageId: "361" })
    expect(takeover.observation?.takeoverStatus).toBe("cancelled")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it("thread 恢复把统一 ownership 遗留 sending 改为 unknown", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "365")
    harness.store.claimDue(new Date().toISOString())
    const timestamp = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(timestamp, thread.id)
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, harness.group.telegramChatId, null, thread.id, thread.serviceId, null, null,
      "progress", "sending", randomUUID(), "d".repeat(64), thread.anchorMessageId, timestamp, timestamp,
    )

    expect(harness.store.recoverStaleGenerating(
      "2026-08-11T00:00:00.000Z",
      "2026-08-10T01:00:00.000Z",
    )).toBe(1)

    expect(harness.database.prepare("SELECT delivery_status FROM telegram_output_ownership").get())
      .toEqual({ delivery_status: "unknown" })
  })

  it("timeout 已进入统一 sender 后崩溃恢复为 unknown 且不从首段重复发送", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "366")
    const timestamp = "2026-08-10T00:00:00.000Z"
    const sentNotificationId = randomUUID()
    const retryableNotificationId = randomUUID()
    const insertNotification = harness.database.prepare(`INSERT INTO support_thread_notifications(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    insertNotification.run(
      sentNotificationId, thread.id, thread.revision, "timeout_alert", "sending", timestamp, null, null, timestamp, timestamp,
    )
    insertNotification.run(
      retryableNotificationId, thread.id, thread.revision, "timeout_operator", "sending", timestamp, null, null, timestamp, timestamp,
    )
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, harness.group.telegramChatId, "901", thread.id, thread.serviceId, null,
      sentNotificationId, "timeout_alert", "sent", randomUUID(), "e".repeat(64), null, timestamp, timestamp,
    )

    expect(harness.store.recoverInterruptedNotifications("2026-08-11T00:00:00.000Z")).toEqual({
      unknownProgress: 0,
      retriedTimeouts: 1,
    })
    const notificationState = harness.database.prepare(`SELECT status,error_message
      FROM support_thread_notifications WHERE id=?`)
    expect(notificationState.get(sentNotificationId)).toEqual({
      status: "unknown",
      error_message: "服务重启前 timeout 发送状态未知",
    })
    expect(notificationState.get(retryableNotificationId)).toEqual({
      status: "pending",
      error_message: "服务重启前发送状态未知，重新发送",
    })
  })

  it("correction 的三条输出都携带 group/service，成功确认还关联原 thread/reply", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "367")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    harness.replies.claimSending(reply.id, { answer: "旧回答" })
    harness.replies.transition(reply.id, "replied", { telegramReplyMessageId: "bot-367" })
    const sendMessage = vi.fn(async () => "confirmation")
    const correctReply = vi.fn(async () => undefined)
    const correction = new SupportCorrectionService(
      harness.database,
      { correctReply } as never,
      { sendMessage },
    )
    const role = {
      id: randomUUID(), telegramUserId: "20001", username: "operator", displayName: "可信客服",
      role: "operator", canCorrect: true, enabled: true, learningSourceEnabled: true,
      createdAt: event.createdAt, updatedAt: event.createdAt,
    } as const

    await correction.handle({
      group: harness.group, role, event, correctionText: "正确答案", replyToMessageId: null, replyTargetIsBot: false,
    })
    await correction.handle({
      group: harness.group, role, event, correctionText: "正确答案", replyToMessageId: "missing", replyTargetIsBot: true,
    })
    await correction.handle({
      group: harness.group, role, event, correctionText: "正确答案", replyToMessageId: "bot-367", replyTargetIsBot: true,
    })

    expect((sendMessage.mock.calls as unknown[][]).map((call) => call[5])).toEqual([
      { groupId: harness.group.id, serviceId: harness.service.id, kind: "correction" },
      { groupId: harness.group.id, serviceId: harness.service.id, kind: "correction" },
      {
        groupId: harness.group.id,
        serviceId: harness.service.id,
        threadId: thread.id,
        replyId: reply.id,
        kind: "correction",
      },
    ])
  })

  it("运营群发送失败后人工先接管时错误告警 sender 不调用", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "371")
    const snapshot = seedCodeSnapshot(harness)
    let alertSendCount = 0
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      sendMessage: async () => { throw new TelegramDeliveryError("forbidden", "failed") },
      sendSupportAlert: async () => {
        alertSendCount += 1
        return { status: "sent", summary: "sent", errorType: null }
      },
    })
    const competingHarness = await createCompetingHarness(harness)
    const observer = createObserver(competingHarness, worker)
    const takeover: { value: ReturnType<typeof observeHuman> | null } = { value: null }
    const transition = harness.replies.transition.bind(harness.replies)
    harness.replies.transition = ((...args: Parameters<ReplyService["transition"]>) => {
      const updated = transition(...args)
      if (updated.status === "failed") {
        takeover.value = observeHuman(competingHarness, observer, { messageId: "372", replyToMessageId: "371" })
      }
      return updated
    })

    await worker.runDueOnce(new Date())

    expect(takeover.value?.observation?.takeoverStatus).toBe("cancelled")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(alertSendCount).toBe(0)
  })

  it("普通决策原因中的技术告警文字不能伪造已持久告警状态", async () => {
    const harness = await createBaseHarness()
    createQuestion(harness, "375")
    const snapshot = seedCodeSnapshot(harness)
    let alertSendCount = 0
    const decision = {
      ...answerDecision(),
      reason: "用户原文包含技术告警：但本轮没有执行过升级告警",
    }
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision,
      sendMessage: async () => { throw new TelegramDeliveryError("forbidden", "failed") },
      sendSupportAlert: async () => {
        alertSendCount += 1
        return { status: "sent", summary: "sent", errorType: null }
      },
    })

    await worker.runDueOnce(new Date())

    const reply = harness.database.readReplies("ORDER BY r.created_at DESC LIMIT 1")[0]!
    expect(alertSendCount).toBe(1)
    expect(harness.database.prepare(`SELECT alert_kind,status FROM support_reply_alert_deliveries
      WHERE reply_id=?`).all(reply.id)).toEqual([{ alert_kind: "support_delivery_failure", status: "sent" }])
  })

  it("普通回复失败且补充告警 sender 抛异常时仍持久失败并收口 thread", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "376")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage: async () => { throw new TelegramDeliveryError("forbidden", "failed") },
      sendSupportAlert: async () => { throw new Error("补充告警 sender 异常") },
    })

    await expect(worker.runDueOnce(new Date())).resolves.toBe(true)

    const reply = harness.database.readReplies("WHERE r.thread_id=?", [thread.id])[0]!
    expect(harness.replies.getDetail(reply.id)).toMatchObject({ status: "failed", operatorDeliveryStatus: "failed" })
    expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='support_delivery_failure'`).get(reply.id)).toEqual({ status: "failed" })
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
  })

  it.each(["sent", "failed", "not_configured", "uncertain"] as const)(
    "升级告警状态为 %s 后运营群回复失败仍补充发送失败告警",
    async (escalationStatus) => {
      const harness = await createBaseHarness()
      createQuestion(harness, `377-${escalationStatus}`)
      const snapshot = seedCodeSnapshot(harness)
      const transition = harness.replies.transition.bind(harness.replies)
      harness.replies.transition = ((id, status, metadata) => {
        const updated = transition(id, status, metadata)
        if (status === "generating") {
          expect(harness.replies.claimTechnicalAlert(id, "escalation")).toBe(true)
          expect(harness.replies.completeTechnicalAlert(id, "escalation", escalationStatus)).toBe(true)
        }
        return updated
      }) as ReplyService["transition"]
      const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => snapshot,
        sendMessage: async () => { throw new TelegramDeliveryError("forbidden", "failed") },
        sendSupportAlert,
      })

      await worker.runDueOnce(new Date())

      expect(sendSupportAlert).toHaveBeenCalledTimes(1)
      const reply = harness.database.readReplies("ORDER BY r.created_at DESC LIMIT 1")[0]!
      expect(harness.database.prepare(`SELECT alert_kind,status FROM support_reply_alert_deliveries
        WHERE reply_id=? ORDER BY alert_kind`).all(reply.id)).toEqual([
        { alert_kind: "escalation", status: escalationStatus },
        { alert_kind: "support_delivery_failure", status: "sent" },
      ])
    },
  )

  it.each(["sent", "failed", "not_configured", "uncertain", "sending"] as const)(
    "技术告警状态为 %s 且运营发送尚未开始时重启沿用同一 reply 且不重复告警",
    async (alertStatus) => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, `379-${alertStatus}`)
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "https://merchant.example/pay 的通道银行映射没配上 203.0.113.7 需要补齐\n我已经通知技术同事处理了"
    harness.database.prepare("UPDATE support_reply_payloads SET answer=? WHERE reply_id=?").run(answer, reply.id)
    harness.database.prepare("UPDATE support_replies SET decision='escalate',decision_reason=? WHERE id=?")
      .run(`[已确认技术处理] 类型=后台映射\n技术告警：${alertStatus === "sending" ? "发送中" : "已发送"}`, reply.id)
    expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
    if (alertStatus !== "sending") {
      expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", alertStatus)).toBe(true)
    }
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?")
      .run("2026-08-10T00:00:00.000Z", thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?")
      .run("2026-08-10T00:00:00.000Z", reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.replies.getDetail(reply.id).status).toBe("generating")
    expect(harness.store.getThread(thread.id).status).toBe("collecting")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const sendMessage = vi.fn(async () => "operator-379")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

    expect(sendSupportAlert).toHaveBeenCalledTimes(alertStatus === "sending" ? 1 : 0)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(answer)
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toHaveLength(1)
    expect(harness.replies.getDetail(reply.id).status).toBe("escalated")
    },
  )

  it("技术告警已有 in-flight ownership 时重启隔离为 uncertain 且不重复告警", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "379-alert-unknown")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "MAYA银行映射没配上 需要补齐\n我已经通知技术同事处理了"
    harness.database.prepare("UPDATE support_reply_payloads SET answer=? WHERE reply_id=?").run(answer, reply.id)
    harness.database.prepare("UPDATE support_replies SET decision='escalate',decision_reason=? WHERE id=?")
      .run("[已确认技术处理] 类型=后台映射 bank_mapping 缺失\n技术告警：发送中", reply.id)
    expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, "-10002", null, thread.id, thread.serviceId, reply.id,
      null, "technical_alert", "sending", randomUUID(), "c".repeat(64), null, staleAt, staleAt,
    )
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='escalation'`).get(reply.id)).toEqual({ status: "uncertain" })
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const sendMessage = vi.fn(async () => "operator-alert-unknown")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendSupportAlert, sendMessage,
    })
    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("升级 answer 已准备但尚未 claim 告警时重启沿用同一 reply 完成两段发送", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "379-prepared")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "https://merchant.example/pay 的通道银行映射没配上 203.0.113.7 需要补齐\n我已经通知技术同事处理了"
    expect(harness.replies.prepareTechnicalEscalation(reply.id, {
      answer,
      decisionReason: "[已确认技术处理] 类型=后台映射 bank_mapping 缺失\n技术告警：发送中",
      decisionConfidence: 1,
    })).not.toBeNull()
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.replies.getDetail(reply.id).status).toBe("generating")
    expect(harness.store.getThread(thread.id).status).toBe("collecting")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const sendMessage = vi.fn(async () => "operator-prepared")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(answer)
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toHaveLength(1)
    expect(harness.replies.getDetail(reply.id).status).toBe("escalated")
  })

  it("运营 claim 后 transport 前重启仍逐字保留业务 URL 和 IP", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "379-operator-pre-rpc")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "https://merchant.example/pay 的MAYA映射没配上 203.0.113.7 需要补齐\n我已经通知技术同事处理了"
    expect(harness.replies.prepareTechnicalEscalation(reply.id, {
      answer,
      decisionReason: "[已确认技术处理] 类型=后台映射 bank_mapping 缺失\n技术告警：已发送",
    })).not.toBeNull()
    expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
    expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", "sent")).toBe(true)
    expect(harness.replies.claimSending(reply.id, { answer })).not.toBeNull()
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    const sendMessage = vi.fn(async () => "operator-pre-rpc")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendMessage, sendSupportAlert,
    })
    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(answer)
  })

  it("运营回复已有 exact sent ownership 时重启只收口状态且绝不重发", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "380")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "已确认通道银行映射缺失 需要技术补上\n我已经通知技术同事处理了"
    expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
    expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", "sent")).toBe(true)
    expect(harness.replies.claimSending(reply.id, { answer, decisionReason: "技术告警：已发送" })).not.toBeNull()
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, harness.group.telegramChatId, "operator-380", thread.id,
      thread.serviceId, reply.id, null, "support_reply", "sent", randomUUID(), "a".repeat(64),
      thread.anchorMessageId, staleAt, staleAt,
    )
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "escalated",
      telegramReplyMessageId: "operator-380",
      operatorDeliveryStatus: "sent",
    })
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
  })

  it("运营回复 ownership 明确 failed 时重启不重发运营且只补失败告警", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "380-failed-ownership")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "MAYA银行映射没配上 需要补齐\n我已经通知技术同事处理了"
    expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
    expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", "sent")).toBe(true)
    expect(harness.replies.claimSending(reply.id, { answer, decisionReason: "技术告警：已发送" })).not.toBeNull()
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), null, harness.group.id, harness.group.telegramChatId, null, thread.id,
      thread.serviceId, reply.id, null, "support_reply", "failed", randomUUID(), "d".repeat(64),
      thread.anchorMessageId, staleAt, staleAt,
    )
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "failed", operatorDeliveryStatus: "failed", errorCode: "support_delivery_failed",
    })
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const sendMessage = vi.fn(async () => "must-not-send")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendSupportAlert, sendMessage,
    })
    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    "补充失败告警 claim 后 RPC 前再次重启按 ownership 分流（inFlight=%s）",
    async (inFlight) => {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `380-supplemental-restart-${inFlight}`)
      const claimed = harness.store.claimDue(new Date().toISOString())!
      const reply = seedGeneratingReply(harness, claimed.thread)
      const answer = "MAYA银行映射没配上 需要补齐\n我已经通知技术同事处理了"
      expect(harness.replies.prepareTechnicalEscalation(reply.id, {
        answer,
        decisionReason: "[已确认技术处理] 类型=后台映射 bank_mapping 缺失\n技术告警：已发送",
      })).not.toBeNull()
      expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
      expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", "sent")).toBe(true)
      expect(harness.replies.claimSending(reply.id, { answer })).not.toBeNull()
      harness.replies.transition(reply.id, "failed", {
        operatorDeliveryStatus: "failed",
        errorCode: "support_delivery_failed",
      })
      expect(harness.store.finishGeneration(thread.id, claimed.thread.revision, "escalated")).toBe(true)
      expect(harness.replies.claimTechnicalAlert(reply.id, "support_delivery_failure")).toBe(true)
      const staleAt = "2026-08-10T00:00:00.000Z"
      harness.database.prepare(`UPDATE support_reply_alert_deliveries SET updated_at=?
        WHERE reply_id=? AND alert_kind='support_delivery_failure'`).run(staleAt, reply.id)
      if (inFlight) {
        harness.database.prepare(`INSERT INTO telegram_output_ownership(
          id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
          notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          randomUUID(), null, harness.group.id, "-10002", null, thread.id, thread.serviceId, reply.id,
          null, "technical_alert:support_delivery_failure", "sending", randomUUID(), "e".repeat(64),
          null, staleAt, staleAt,
        )
      }

      harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

      const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => seedCodeSnapshot(harness),
        sendSupportAlert,
        sendMessage: async () => "must-not-send",
      })
      await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

      expect(sendSupportAlert).toHaveBeenCalledTimes(inFlight ? 0 : 1)
      expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
        WHERE reply_id=? AND alert_kind='support_delivery_failure'`).get(reply.id)).toEqual({
        status: inFlight ? "uncertain" : "sent",
      })
      if (inFlight) {
        expect(harness.database.prepare(`SELECT delivery_status FROM telegram_output_ownership
          WHERE reply_id=? AND output_kind='technical_alert:support_delivery_failure'`).get(reply.id))
          .toEqual({ delivery_status: "unknown" })
      }
    },
  )

  it("运营回复 ownership 为 sending 时重启隔离为 unknown 且 thread 不重开", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "380-unknown")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const answer = "已确认通道银行映射缺失 需要技术补上\n我已经通知技术同事处理了"
    expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
    expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", "sent")).toBe(true)
    expect(harness.replies.claimSending(reply.id, { answer, decisionReason: "技术告警：已发送" })).not.toBeNull()
    const staleAt = "2026-08-10T00:00:00.000Z"
    const ownershipId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ownershipId, null, harness.group.id, harness.group.telegramChatId, null, thread.id,
      thread.serviceId, reply.id, null, "support_reply", "sending", randomUUID(), "b".repeat(64),
      thread.anchorMessageId, staleAt, staleAt,
    )
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.database.prepare("SELECT delivery_status FROM telegram_output_ownership WHERE id=?")
      .get(ownershipId)).toEqual({ delivery_status: "unknown" })
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "failed",
      operatorDeliveryStatus: "uncertain",
      errorCode: "delivery_state_unknown",
    })
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const sendMessage = vi.fn(async () => "must-not-send")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendSupportAlert, sendMessage,
    })
    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
  })

  it.each(["escalated", "failed"] as const)(
    "升级 reply 已变为 %s 但 thread 尚未 finish 时重启只收口 thread",
    async (replyStatus) => {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `380-${replyStatus}`)
      const claimed = harness.store.claimDue(new Date().toISOString())!
      const reply = seedGeneratingReply(harness, claimed.thread)
      expect(harness.replies.prepareTechnicalEscalation(reply.id, {
        answer: "MAYA银行映射缺失\n我已经通知技术同事处理了",
        decisionReason: "[已确认技术处理] 类型=后台映射 bank_mapping 缺失\n技术告警：发送中",
      })).not.toBeNull()
      expect(harness.replies.claimTechnicalAlert(reply.id, "escalation")).toBe(true)
      expect(harness.replies.completeTechnicalAlert(reply.id, "escalation", "sent")).toBe(true)
      expect(harness.replies.claimSending(reply.id, {
        answer: "已确认银行映射缺失\n我已经通知技术同事处理了",
        decisionReason: "技术告警：已发送",
      })).not.toBeNull()
      harness.replies.transition(reply.id, replyStatus, replyStatus === "escalated"
        ? { telegramReplyMessageId: "operator-terminal" }
        : { errorCode: "support_delivery_failed", operatorDeliveryStatus: "failed" })
      const staleAt = "2026-08-10T00:00:00.000Z"
      harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
      harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

      harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

      expect(harness.replies.getDetail(reply.id).status).toBe(replyStatus)
      expect(harness.store.getThread(thread.id).status).toBe("escalated")
      if (replyStatus === "failed") {
        const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
        const sendMessage = vi.fn(async () => "must-not-send")
        const worker = createWorker(harness, {
          readCurrentSnapshot: () => seedCodeSnapshot(harness), sendSupportAlert, sendMessage,
        })
        await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))
        expect(sendMessage).not.toHaveBeenCalled()
        expect(sendSupportAlert).toHaveBeenCalledTimes(1)
      }
    },
  )

  it("错误告警 claim 先提交时人工接管记录 delivery_in_flight", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    createQuestion(harness, "381")
    const snapshot = seedCodeSnapshot(harness)
    let signalAlertStarted!: () => void
    let releaseAlert!: () => void
    const alertStarted = new Promise<void>((resolve) => { signalAlertStarted = resolve })
    const alertReleased = new Promise<void>((resolve) => { releaseAlert = resolve })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      sendMessage: async () => { throw new TelegramDeliveryError("forbidden", "failed") },
      sendSupportAlert: async () => {
        signalAlertStarted()
        await alertReleased
        return { status: "sent", summary: "sent", errorType: null }
      },
    })
    const competingHarness = await createCompetingHarness(harness)
    const observer = createObserver(competingHarness, worker)

    const running = worker.runDueOnce(new Date())
    await Promise.race([
      alertStarted,
      running.then(() => { throw new Error("worker 在错误告警 sender 启动前结束") }),
    ])
    const takeover = observeHuman(competingHarness, observer, { messageId: "382", replyToMessageId: "381" })
    releaseAlert()
    await running

    expect(takeover.observation?.takeoverStatus).toBe("delivery_in_flight")
  })

  it("普通回复发送 claim 后人工接管并崩溃时恢复为未知投递且不重开 thread", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "391")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    expect(harness.replies.claimSending(reply.id, { answer: "已取得发送所有权" })?.status).toBe("sending")
    const observer = createObserver(harness)
    const takeover = observeHuman(harness, observer, { messageId: "392", replyToMessageId: "391" })
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?")
      .run("2026-08-10T00:00:00.000Z", reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.database.prepare(`SELECT status,error_code,operator_delivery_status
      FROM support_replies WHERE id=?`).get(reply.id)).toEqual({
      status: "failed",
      error_code: "delivery_state_unknown",
      operator_delivery_status: "uncertain",
    })
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(new LearningSourceStore(harness.database).findByMessageEvent(takeover.event.id)).toEqual(takeover.observation)
  })

  it("技术告警 claim 后人工接管并崩溃时恢复为 uncertain 且保留 observation", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "395")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    expect(harness.replies.claimTechnicalAlert(reply.id, "code_sync_fallback")).toBe(true)
    const observer = createObserver(harness)
    const takeover = observeHuman(harness, observer, { messageId: "396", replyToMessageId: "395" })
    harness.database.prepare(`UPDATE support_reply_alert_deliveries SET updated_at=?
      WHERE reply_id=? AND alert_kind='code_sync_fallback'`).run("2026-08-10T00:00:00.000Z", reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
      WHERE reply_id=? AND alert_kind='code_sync_fallback'`).get(reply.id)).toEqual({ status: "uncertain" })
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(new LearningSourceStore(harness.database).findByMessageEvent(takeover.event.id)).toEqual(takeover.observation)
  })

  it("终态 thread 只记录 thread_already_terminal", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "401")
    harness.store.claimDue(new Date().toISOString())
    harness.store.finishGeneration(thread.id, thread.revision, "answered")
    const terminalBefore = harness.store.getThread(thread.id)
    const observer = createObserver(harness)

    const takeover = observeHuman(harness, observer, { messageId: "402", replyToMessageId: "401" })

    expect(takeover.observation?.takeoverStatus).toBe("thread_already_terminal")
    expect(harness.store.getThread(thread.id)).toEqual(terminalBefore)
  })

  it("歧义关联不改变任何 thread", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const first = createQuestion(harness, "501").thread
    const second = createQuestion(harness, "502").thread
    const observer = createObserver(harness)

    const takeover = observeHuman(harness, observer, { messageId: "503", replyToMessageId: null })

    expect(takeover.observation?.takeoverStatus).toBe("ambiguous")
    expect(harness.store.getThread(first.id).status).toBe("collecting")
    expect(harness.store.getThread(second.id).status).toBe("collecting")
  })

  it("重复接管幂等且人工 role message 永不写入 thread_messages", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "601")
    const observer = createObserver(harness)

    const first = observeHuman(harness, observer, { messageId: "602", replyToMessageId: "601" })
    const closed = harness.store.getThread(thread.id)
    const repeated = observer.observe(first.event)

    expect(first.observation?.takeoverStatus).toBe("cancelled")
    expect(repeated).toEqual(first.observation)
    expect(harness.store.getThread(thread.id)).toEqual(closed)
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM learning_source_observations WHERE message_event_id=?")
      .get(first.event.id)).toEqual({ count: 1 })
    expect(harness.store.getThreadDetail(thread.id).messages.map((message) => message.event.telegramMessageId)).toEqual(["601"])
  })

  it("观察写入失败时接管和回复取消整体回滚", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "701")
    harness.store.claimDue(new Date().toISOString())
    const reply = seedGeneratingReply(harness, harness.store.getThread(thread.id))
    const observer = createObserver(harness)
    harness.database.prepare(`CREATE TRIGGER reject_test_observation
      BEFORE INSERT ON learning_source_observations
      BEGIN SELECT RAISE(ABORT, 'test observation failure'); END`).run()

    expect(() => observeHuman(harness, observer, { messageId: "702", replyToMessageId: "701" }))
      .toThrow("test observation failure")

    expect(harness.store.getThread(thread.id).status).toBe("generating")
    expect(harness.replies.getDetail(reply.id).status).toBe("generating")
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM learning_source_observations").get()).toEqual({ count: 0 })
  })

  it("人工接管后不再发送 fallback 快照衍生技术告警", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const { thread } = createQuestion(harness, "801")
    const snapshot = seedCodeSnapshot(harness, "fallback")
    let alertSendCount = 0
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      sendCodeSyncFailure: async () => {
        alertSendCount += 1
        return { status: "sent", summary: "sent", errorType: null }
      },
    })
    const competingHarness = await createCompetingHarness(harness)
    const observer = createObserver(competingHarness)
    const takeover: { value: ReturnType<typeof observeHuman> | null } = { value: null }
    const isCurrentRevision = harness.store.isCurrentRevision.bind(harness.store)
    let currentChecks = 0
    harness.store.isCurrentRevision = ((...args: Parameters<SupportThreadStore["isCurrentRevision"]>) => {
      const current = isCurrentRevision(...args)
      currentChecks += 1
      if (current && currentChecks === 2) {
        takeover.value = observeHuman(competingHarness, observer, { messageId: "802", replyToMessageId: "801" })
      }
      return current
    })

    await worker.runDueOnce(new Date())

    expect(takeover.value?.observation?.takeoverStatus).toBe("cancelled")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(alertSendCount).toBe(0)
  })

  it("人工接管后不再发送无可用快照分支的技术告警", async () => {
    const harness = await createBaseHarness()
    seedRole(harness.database)
    const question = createQuestion(
      harness,
      "901",
      "订单下单 金流API Url: https://pay.example.com/ 返回 405 Method Not Allowed nginx",
    )
    let alertSendCount = 0
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => {
        throw new ProjectCodeSyncUnavailableError(randomUUID(), codeSyncFailure())
      },
      sendCodeSyncFailure: async () => {
        alertSendCount += 1
        return { status: "sent", summary: "sent", errorType: null }
      },
    })
    const competingHarness = await createCompetingHarness(harness)
    const observer = createObserver(competingHarness)
    const takeover: { value: ReturnType<typeof observeHuman> | null } = { value: null }
    const isCurrentRevision = harness.store.isCurrentRevision.bind(harness.store)
    let currentChecks = 0
    harness.store.isCurrentRevision = ((...args: Parameters<SupportThreadStore["isCurrentRevision"]>) => {
      const current = isCurrentRevision(...args)
      currentChecks += 1
      if (current && currentChecks === 2) {
        takeover.value = observeHuman(competingHarness, observer, { messageId: "902", replyToMessageId: "901" })
      }
      return current
    })

    await worker.runDueOnce(new Date())

    expect(takeover.value?.observation?.takeoverStatus).toBe("cancelled")
    expect(harness.store.getThread(question.thread.id).status).toBe("closed")
    expect(alertSendCount).toBe(0)
  })
})
