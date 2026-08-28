import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { CodexExecutionTimeoutError } from "../../src/codex/executor.js"
import type { AnswerDecision } from "../../src/codex/schemas.js"
import { ProjectCodeSyncUnavailableError, type CodeSyncFailure } from "../../src/git-sync/project-errors.js"
import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import { ReplyEventBus } from "../../src/replies/reply-event-bus.js"
import { ReplyService } from "../../src/replies/reply-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"
import { ModelExecutionError } from "../../src/models/errors.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"
import type { ProjectServiceRecord, ReplyStatus, RuntimeGroup, SupportMessageEvent, SupportThread } from "../../src/runtime/types.js"
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
import {
  SupportThreadStore,
  TECHNICAL_AVAILABILITY_REPLY_PENDING,
} from "../../src/support/thread-store.js"
import { TelegramDeliveryError, type TelegramOutputOwnership } from "../../src/telegram/runtime.js"
import {
  SupportCodeSyncRuntimeError,
  SupportModelOutputRejectedError,
  type SupportReplyPipelineAudit,
} from "../../src/support/investigation-service.js"

const temporaryDirectories: string[] = []
const openDatabases: RuntimeDatabase[] = []
const generatedTechnicalAvailabilityReply = "已经通知技术了，等技术上线后会处理"

afterEach(async () => {
  vi.useRealTimers()
  openDatabases.splice(0).forEach((database) => database.close())
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Task 3 handoff 终态所有权", () => {
  it.each([
    "code_defect",
    "technical_change",
    "feature_request",
    "service_handoff",
    "human_operation",
  ] as const)("准备 %s 升级 reply 时在同一提交中领取线程 handoff", async (source) => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, `handoff-source-${source}`)
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)

    expect(harness.replies.prepareTechnicalEscalation(reply.id, {
      answer: "已通知技术接手",
      decisionReason: "已确认需要人工接管",
      decisionConfidence: 1,
    }, source)).not.toBeNull()

    expect(harness.store.handoffSource(thread.id)).toBe(source)
  })

  it("同 reply 崩溃恢复可继续而另一 reply 无法再次准备或领取告警", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "handoff-exactly-once")
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const first = seedGeneratingReply(harness, claimed.thread)
    const second = seedGeneratingReply(harness, claimed.thread)
    const metadata = {
      answer: "已通知技术接手",
      decisionReason: "已确认需要技术修改",
      decisionConfidence: 1,
    }

    expect(harness.replies.prepareTechnicalEscalation(first.id, metadata, "technical_change")).not.toBeNull()
    expect(harness.replies.prepareTechnicalEscalation(first.id, metadata, "technical_change")).not.toBeNull()
    expect(harness.replies.prepareTechnicalEscalation(second.id, metadata, "technical_change")).toBeNull()
    expect(harness.replies.claimTechnicalAlert(first.id, "escalation")).toBe(true)
    expect(harness.replies.claimTechnicalAlert(second.id, "escalation")).toBe(false)
    expect(harness.database.prepare(`SELECT reply_id,source_kind FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='handoff'`).all(thread.id)).toEqual([
      { reply_id: first.id, source_kind: "technical_change" },
    ])
  })
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

function seedConfiguredRole(
  database: RuntimeDatabase,
  telegramUserId: string,
  role: "operator" | "technical" | "reviewer" | "ignored",
  enabled = true,
): void {
  const createdAt = new Date().toISOString()
  database.insertRole({
    id: randomUUID(),
    telegramUserId,
    username: `operator_${telegramUserId}`,
    displayName: "可信客服",
    role,
    canCorrect: false,
    enabled,
    learningSourceEnabled: true,
    createdAt,
    updatedAt: createdAt,
  })
}

function seedRole(database: RuntimeDatabase, telegramUserId = "20001"): void {
  seedConfiguredRole(database, telegramUserId, "operator")
}

type BaseHarness = Awaited<ReturnType<typeof createBaseHarness>>

async function createBaseHarness(onRecoveredReply?: (event: {
  id: string
  status: ReplyStatus
  updatedAt: string
  durationMs: number | null
}) => void) {
  const { database, filePath } = await createDatabase()
  const { group, service } = seedCatalog(database)
  const redactor = new ConfiguredSecretRedactor(database)
  const store = new SupportThreadStore(database, redactor, onRecoveredReply)
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
  const now = new Date().toISOString()
  const notification = harness.store.claimProgressNotification(
    thread.id,
    thread.revision,
    "human_priority",
    now,
    now,
  )!
  harness.database.prepare(`UPDATE support_thread_notifications SET
    status='sent',telegram_message_id='progress-message' WHERE id=?`).run(notification.id)
  harness.database.prepare(`UPDATE support_threads SET
    human_priority_state='claimed',human_priority_user_ids_json='["20001"]',
    human_priority_due_at=?,human_priority_source_event_id=?,human_priority_progress_message_id='progress-message'
    WHERE id=?`).run(now, sourceEventId, thread.id)
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
    humanOperation: null,
    answer: "人工接管前生成的机器人答复",
    quote: null,
    reason: "测试回答",
    confidence: 1,
    usedMemoryVersionIds: [],
    answerClaims: [{
      factId: "F1",
      statement: "人工接管前生成的机器人答复",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "测试问题",
    }],
    responsibility: { party: "unknown", certainty: "unknown", evidenceSources: [], factIds: [] },
    interaction: {
      sentiment: "neutral",
      situation: "new_request",
      underlyingNeed: "验证回复生命周期",
      responseStrategy: "direct_answer",
    },
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
    evidencePacket: {
      version: "2",
      communication: { intent: "direct_answer", recipient: null, desiredOutcome: "完成测试回复" },
      facts: [{
        id: "F1",
        statement: "人工接管前生成的机器人答复",
        provenance: "user_report",
        evidenceSource: "message",
        evidence: "测试问题",
        certainty: "reported",
        outboundSafe: true,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }],
      associations: [],
      requiredAnswerPoints: ["完成测试回复"],
      unknowns: [],
      handlingNotes: [],
      reviewLevel: "standard",
    },
  }
}

function rejectedPipelineAudit(secret: string): SupportReplyPipelineAudit {
  const evidencePacket = answerDecision().evidencePacket!
  return {
    version: "evidence-binding-review-v2",
    mode: "multi_stage",
    evidencePacket: {
      ...evidencePacket,
      communication: {
        ...evidencePacket.communication,
        desiredOutcome: `password=${secret}`,
      },
    },
    baselineAnswer: `password=${secret}`,
    firstCandidateAnswer: null,
    revisedCandidateAnswer: null,
    reviews: [],
    finalSource: "baseline",
    fallbackReason: `password=${secret}`,
  }
}

function withPipelineAudit<T extends Error>(error: T, audit: SupportReplyPipelineAudit): T {
  return Object.assign(error, { pipelineAudit: audit })
}

function seedProgressDelivery(
  harness: BaseHarness,
  thread: SupportThread,
  status: "pending" | "sending" | "sent" | "failed" | "unknown",
): string {
  const now = new Date().toISOString()
  const notification = harness.store.claimProgressNotification(
    thread.id,
    thread.revision,
    "scheduled_progress",
    now,
    now,
  )!
  harness.database.prepare(`UPDATE support_thread_notifications SET
    status=?,telegram_message_id=?,error_message=? WHERE id=?`).run(
    status,
    status === "sent" || status === "failed" ? `progress-${thread.anchorMessageId}` : null,
    status === "unknown" ? "发送状态未知" : null,
    notification.id,
  )
  return notification.id
}

function seedFailedProgressOwnership(harness: BaseHarness, thread: SupportThread): void {
  const now = new Date().toISOString()
  const notification = harness.store.claimProgressNotification(
    thread.id,
    thread.revision,
    "scheduled_progress",
    now,
    now,
  )!
  harness.database.prepare(`UPDATE support_thread_notifications SET status='failed' WHERE id=?`).run(notification.id)
  harness.database.prepare(`INSERT INTO telegram_output_ownership(
    id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
    notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), null, harness.group.id, harness.group.telegramChatId, `owned-progress-${thread.anchorMessageId}`,
    thread.id, thread.serviceId, null, notification.id, "progress", "failed", randomUUID(), "f".repeat(64),
    thread.anchorMessageId, now, now,
  )
}

function seedReplyOutputOwnership(
  harness: BaseHarness,
  thread: SupportThread,
  replyId: string,
  outputKind: "support_reply" | "technical_alert:feature_request" | "technical_alert:support_delivery_failure",
  status: "sending" | "sent" | "unknown" | "failed",
): void {
  const now = new Date().toISOString()
  harness.database.prepare(`INSERT INTO telegram_output_ownership(
    id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
    notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), null, harness.group.id, harness.group.telegramChatId,
    status === "sent" ? `${outputKind}-${thread.anchorMessageId}` : null,
    thread.id, thread.serviceId, replyId, null, outputKind, status, randomUUID(), "9".repeat(64),
    thread.anchorMessageId, now, now,
  )
}

describe("线程语义输出所有权", () => {
  it("三个进度来源竞争时只保留一个 notification owner", async () => {
    const harness = await createBaseHarness()
    const competitor = await createCompetingHarness(harness)
    const { thread } = createQuestion(harness, "claim-progress-1")
    const dueAt = "2026-08-28T01:00:00.000Z"
    const claimedAt = "2026-08-28T00:00:00.000Z"

    const scheduled = harness.store.claimProgressNotification(
      thread.id, thread.revision, "scheduled_progress", dueAt, claimedAt,
    )
    const status = competitor.store.claimProgressNotification(
      thread.id, thread.revision, "status_request", dueAt, claimedAt,
    )
    const human = harness.store.claimProgressNotification(
      thread.id, thread.revision, "human_priority", dueAt, claimedAt,
    )

    expect(scheduled).toMatchObject({
      threadId: thread.id,
      inputRevision: thread.revision,
      kind: "progress",
      status: "pending",
      dueAt,
    })
    expect(status).toBeNull()
    expect(human).toBeNull()
    expect(harness.database.prepare(`SELECT thread_id,claim_kind,source_kind,notification_id
      FROM support_thread_output_claims WHERE thread_id=?`).all(thread.id)).toEqual([{
      thread_id: thread.id,
      claim_kind: "progress",
      source_kind: "scheduled_progress",
      notification_id: scheduled!.id,
    }])
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications
      WHERE thread_id=? AND kind='progress'`).get(thread.id)).toEqual({ count: 1 })
    expect(harness.store.hasStartedProgress(thread.id)).toBe(true)
  })

  it("handoff 同 reply 可恢复而不同 reply 无法取得 owner", async () => {
    const harness = await createBaseHarness()
    const competitor = await createCompetingHarness(harness)
    const { thread } = createQuestion(harness, "claim-handoff-1")
    const firstReply = seedGeneratingReply(harness, thread)
    const secondReply = seedGeneratingReply(harness, thread)
    const claimedAt = "2026-08-28T00:00:00.000Z"

    expect(harness.store.claimHandoff(firstReply.id, "technical_change", claimedAt)).toBe(true)
    expect(competitor.store.claimHandoff(firstReply.id, "technical_change", claimedAt)).toBe(true)
    expect(harness.store.claimHandoff(secondReply.id, "hard_deadline", claimedAt)).toBe(false)
    expect(harness.store.hasHandoffClaim(thread.id)).toBe(true)
    expect(harness.store.handoffSource(thread.id)).toBe("technical_change")
    expect(harness.database.prepare(`SELECT reply_id,source_kind FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='handoff'`).all(thread.id)).toEqual([{
      reply_id: firstReply.id,
      source_kind: "technical_change",
    }])
  })

  it("明确失败且 RPC 未开始时只释放匹配的 progress owner", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-release-1")
    const notification = harness.store.claimProgressNotification(
      thread.id, thread.revision, "status_request", new Date().toISOString(), new Date().toISOString(),
    )!
    harness.database.prepare("UPDATE support_thread_notifications SET status='failed' WHERE id=?").run(notification.id)

    expect(harness.store.releaseFailedProgressClaim(randomUUID())).toBe(false)
    expect(harness.store.releaseFailedProgressClaim(notification.id)).toBe(true)
    expect(harness.store.releaseFailedProgressClaim(notification.id)).toBe(false)
    expect(harness.store.hasStartedProgress(thread.id)).toBe(false)
    expect(harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "scheduled_progress",
      "2026-08-28T02:00:00.000Z",
      "2026-08-28T01:00:00.000Z",
    )).toMatchObject({
      id: notification.id,
      status: "pending",
      dueAt: "2026-08-28T02:00:00.000Z",
    })
  })

  it("failed owner 释放后旧 revision 不能复用而当前 revision 可以领取", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "claim-release-revision-1")
    const first = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "scheduled_progress",
      "2026-08-28T01:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
    )!
    harness.database.prepare("UPDATE support_thread_notifications SET status='failed' WHERE id=?").run(first.id)
    expect(harness.store.releaseFailedProgressClaim(first.id)).toBe(true)
    const supplement = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "claim-release-revision-2",
      replyToMessageId: event.telegramMessageId,
      messageThreadId: null,
      senderUserId: event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "补充新的排查证据",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    expect(harness.store.appendMessage({
      threadId: thread.id,
      eventId: supplement.id,
      relation: "supplement",
      questionFragment: supplement.safeText,
      settleAt: "2026-08-28T01:30:00.000Z",
    })?.revision).toBe(2)

    expect(harness.store.claimProgressNotification(
      thread.id,
      1,
      "status_request",
      "2026-08-28T02:00:00.000Z",
      "2026-08-28T01:00:00.000Z",
    )).toBeNull()
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(thread.id)).toEqual({ count: 0 })
    expect(harness.database.prepare(`SELECT status,input_revision FROM support_thread_notifications WHERE id=?`)
      .get(first.id)).toEqual({ status: "failed", input_revision: 1 })

    expect(harness.store.claimProgressNotification(
      thread.id,
      2,
      "human_priority",
      "2026-08-28T02:00:00.000Z",
      "2026-08-28T01:00:00.000Z",
    )).toMatchObject({
      inputRevision: 2,
      status: "pending",
    })
  })

  it.each(["sending", "sent", "unknown"] as const)(
    "%s Telegram ownership 存在时不释放 progress owner",
    async (deliveryStatus) => {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `claim-protected-${deliveryStatus}`)
      const notification = harness.store.claimProgressNotification(
        thread.id, thread.revision, "human_priority", new Date().toISOString(), new Date().toISOString(),
      )!
      harness.database.prepare("UPDATE support_thread_notifications SET status='failed' WHERE id=?").run(notification.id)
      seedOwnershipForNotification(harness, thread, notification.id, deliveryStatus)

      expect(harness.store.releaseFailedProgressClaim(notification.id)).toBe(false)
      expect(harness.store.hasStartedProgress(thread.id)).toBe(true)
    },
  )

  it("scheduled 入口领取后 status request 与 human priority 不能创建第二个 notification owner", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-progress-producers-scheduled")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)

    const scheduled = harness.store.claimPendingProgressNotification(now)
    const status = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      now,
      now,
    )
    harness.database.prepare(`UPDATE support_threads SET
      status='collecting',human_priority_state='waiting',human_priority_due_at=?,settle_at=?
      WHERE id=?`).run(now, now, thread.id)
    const human = harness.store.claimDueHumanPriority(now)

    expect(scheduled).toMatchObject({ threadId: thread.id, inputRevision: 1, status: "sending" })
    expect(status).toBeNull()
    expect(human).toBeNull()
    expect(harness.database.prepare(`SELECT source_kind,notification_id FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).all(thread.id)).toEqual([{
      source_kind: "scheduled_progress",
      notification_id: scheduled!.id,
    }])
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications
      WHERE thread_id=? AND kind='progress'`).get(thread.id)).toEqual({ count: 1 })
  })

  it("human priority 入口把人工等待与唯一 progress notification 绑定", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:00:00.000Z"))
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(
      harness,
      "claim-progress-producers-human",
      "@windpayDR 帮忙看看",
      ["20001"],
    )
    const dueAt = String((harness.database.prepare(
      "SELECT human_priority_due_at FROM support_threads WHERE id=?",
    ).get(thread.id) as { human_priority_due_at: string }).human_priority_due_at)

    expect(dueAt).toBe(event.createdAt)
    const human = harness.store.claimDueHumanPriority(event.createdAt)
    const status = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      event.createdAt,
      event.createdAt,
    )

    expect(human).toMatchObject({ threadId: thread.id, inputRevision: 1 })
    expect(human?.notificationId).toEqual(expect.any(String))
    expect(status).toBeNull()
    expect(harness.database.prepare(`SELECT source_kind,notification_id FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(thread.id)).toEqual({
      source_kind: "human_priority",
      notification_id: human!.notificationId,
    })
    expect(harness.database.prepare(`SELECT status FROM support_thread_notifications WHERE id=?`)
      .get(human!.notificationId)).toEqual({ status: "pending" })
  })

  it("human priority 实际发送复用统一 notification 与短进度文案", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:10:00.000Z"))
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(
      harness,
      "claim-progress-producers-human-send",
      "@windpayDR 帮忙看看",
      ["20001"],
    )
    const sendMessage = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-08-28T01:10:10.000Z"))
      return "human-priority-progress"
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(event.createdAt))

    const claim = harness.database.prepare(`SELECT notification_id FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(thread.id) as { notification_id: string }
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "稍等",
      thread.anchorMessageId,
      undefined,
      expect.objectContaining({ notificationId: claim.notification_id, kind: "mention_claim_progress" }),
    )
    expect(harness.database.prepare(`SELECT status,telegram_message_id FROM support_thread_notifications WHERE id=?`)
      .get(claim.notification_id)).toEqual({ status: "sent", telegram_message_id: "human-priority-progress" })
    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_progress_message_id
      FROM support_threads WHERE id=?`).get(thread.id)).toEqual({
      human_priority_state: "waiting",
      human_priority_progress_message_id: "human-priority-progress",
    })
    const waitingUntil = "2026-08-28T01:13:10.000Z"
    expect(harness.database.prepare(`SELECT human_priority_due_at,settle_at FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_due_at: waitingUntil, settle_at: waitingUntil })
    expect(harness.store.claimDueHumanPriority(new Date(Date.parse(waitingUntil) - 1).toISOString())).toBeNull()
    await deadline.runOnce(new Date(waitingUntil))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.database.prepare(`SELECT human_priority_state,settle_at FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "claimed", settle_at: waitingUntil })
    expect(harness.store.claimDue(waitingUntil, 0)?.thread.id).toBe(thread.id)
  })

  it("@技术后任意启用技术角色都能接管，普通角色和停用技术不能接管", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:20:00.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "20001", "technical")
    seedConfiguredRole(harness.database, "20002", "technical")
    seedConfiguredRole(harness.database, "20003", "operator")
    seedConfiguredRole(harness.database, "20004", "technical", false)
    const { event, thread } = createQuestion(harness, "priority-any-tech", "@target_tech 看下", ["20001"])
    const claim = harness.store.claimDueHumanPriority(event.createdAt)!
    harness.store.claimNotificationSending(claim.notificationId, event.createdAt)
    harness.store.completeNotification(claim.notificationId, "priority-any-tech-progress", "稍等", event.createdAt)
    expect(harness.store.completeHumanPriorityClaim(claim, "priority-any-tech-progress", null, event.createdAt)).toBe(true)
    const respondedAt = new Date(Date.parse(event.createdAt) + 30_000).toISOString()

    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "20003", randomUUID(), respondedAt,
    )).toBe(0)
    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "20004", randomUUID(), respondedAt,
    )).toBe(0)
    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "20002", randomUUID(), respondedAt,
    )).toBe(1)
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "closed" })
    expect(harness.database.prepare(`SELECT human_priority_state,closed_by FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "answered", closed_by: "群内人工" })
  })

  it("仅@忽略用户时不把任意技术扩大为接管者，仍只接受原目标", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:22:00.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "21001", "ignored")
    seedConfiguredRole(harness.database, "21002", "technical")
    const { event, thread } = createQuestion(harness, "priority-ignored-target", "@ignored_user 看下", ["21001"])
    const claim = harness.store.claimDueHumanPriority(event.createdAt)!
    harness.store.claimNotificationSending(claim.notificationId, event.createdAt)
    harness.store.completeNotification(claim.notificationId, "priority-ignored-progress", "稍等", event.createdAt)
    harness.store.completeHumanPriorityClaim(claim, "priority-ignored-progress", null, event.createdAt)
    const respondedAt = new Date(Date.parse(event.createdAt) + 30_000).toISOString()

    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "21002", randomUUID(), respondedAt,
    )).toBe(0)
    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "21001", randomUUID(), respondedAt,
    )).toBe(1)
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "closed" })
  })

  it("同一消息同时@技术和忽略用户时，任意技术与被点名忽略用户取并集", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:22:30.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "21501", "technical")
    seedConfiguredRole(harness.database, "21502", "technical")
    seedConfiguredRole(harness.database, "21503", "ignored")
    const first = createQuestion(harness, "priority-mixed-tech", "@tech @ignored 看下", ["21501", "21503"])
    const second = createQuestion(harness, "priority-mixed-ignored", "@tech @ignored 再看下", ["21501", "21503"])
    const respondedAt = new Date(Date.parse(first.event.createdAt) + 30_000).toISOString()

    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "21502", randomUUID(), respondedAt,
    )).toBe(2)
    expect(harness.store.getThread(first.thread.id)).toMatchObject({ status: "closed" })
    expect(harness.store.getThread(second.thread.id)).toMatchObject({ status: "closed" })

    const third = createQuestion(harness, "priority-mixed-ignored-exact", "@tech @ignored 还有一笔", ["21501", "21503"])
    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "21503", randomUUID(), respondedAt,
    )).toBe(1)
    expect(harness.store.getThread(third.thread.id)).toMatchObject({ status: "closed" })
  })

  it("被@技术在等待中被停用后不能降格成精确目标继续接管", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:23:00.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "22001", "technical")
    seedConfiguredRole(harness.database, "22002", "technical")
    const { event, thread } = createQuestion(harness, "priority-disabled-target", "@target_tech 看下", ["22001"])
    const claim = harness.store.claimDueHumanPriority(event.createdAt)!
    harness.store.claimNotificationSending(claim.notificationId, event.createdAt)
    harness.store.completeNotification(claim.notificationId, "priority-disabled-progress", "稍等", event.createdAt)
    harness.store.completeHumanPriorityClaim(claim, "priority-disabled-progress", null, event.createdAt)
    harness.database.prepare("UPDATE telegram_roles SET enabled=0 WHERE telegram_user_id='22001'").run()
    const respondedAt = new Date(Date.parse(event.createdAt) + 30_000).toISOString()

    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "22001", randomUUID(), respondedAt,
    )).toBe(0)
    expect(harness.store.resolveHumanPriorityByResponder(
      harness.group.id, "22002", randomUUID(), respondedAt,
    )).toBe(1)
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "closed" })
  })

  it("协调器按 Telegram 数字身份把另一位技术的普通回复转为人工接管", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:25:00.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "20001", "technical")
    seedConfiguredRole(harness.database, "20002", "technical")
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route: async () => ({
        action: "new_thread" as const,
        messageIntent: "actionable" as const,
        questionFragment: "请技术处理",
        issues: null,
        investigationEffect: "changes_input" as const,
        reason: "新问题",
        confidence: 1,
        clarificationReply: null,
      }) },
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const operatorEvent = coordinator.accept({
      groupId: harness.group.id,
      messageId: "priority-coordinator-question",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "@operator_20001 请技术处理",
      attachments: [],
      createdAt: "2026-08-28T01:25:00.000Z",
    })!
    await coordinator.drain()
    const thread = harness.store.findThreadByEvent(operatorEvent.id)!
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage: async () => "priority-coordinator-progress" },
    })
    await deadline.runOnce(new Date(operatorEvent.createdAt))

    coordinator.accept({
      groupId: harness.group.id,
      messageId: "priority-coordinator-tech",
      senderId: "20002",
      senderUsername: "operator_20002",
      senderDisplayName: "另一位技术",
      fromBot: false,
      replyToMessageId: operatorEvent.telegramMessageId,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "我来处理",
      attachments: [],
      createdAt: "2026-08-28T01:25:30.000Z",
    })

    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "closed" })
    expect(harness.database.prepare(`SELECT human_priority_state,closed_by FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "answered", closed_by: "群内人工" })
    await coordinator.stop()
  })

  it("线程尚在路由时另一位技术已经回复，建线程时仍直接收口为人工接管", async () => {
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "20001", "technical")
    seedConfiguredRole(harness.database, "20002", "technical")
    const decision = {
      action: "new_thread" as const,
      messageIntent: "actionable" as const,
      questionFragment: "请技术处理",
      issues: null,
      investigationEffect: "changes_input" as const,
      reason: "新问题",
      confidence: 1,
      clarificationReply: null,
    }
    let releaseRoute: ((value: typeof decision) => void) | null = null
    const route = vi.fn(() => new Promise<typeof decision>((resolve) => { releaseRoute = resolve }))
    const coordinator = new SupportThreadCoordinator({
      database: harness.database,
      store: harness.store,
      router: { route },
      batchWindowMs: 30_000,
      wake: () => undefined,
    })
    const operatorEvent = coordinator.accept({
      groupId: harness.group.id,
      messageId: "priority-routing-question",
      senderId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      fromBot: false,
      replyToMessageId: null,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "@operator_20001 请技术处理",
      attachments: [],
      createdAt: "2026-08-28T02:00:00.000Z",
    })!
    await Promise.resolve()
    await Promise.resolve()
    expect(route).toHaveBeenCalledTimes(1)
    coordinator.accept({
      groupId: harness.group.id,
      messageId: "priority-routing-tech",
      senderId: "20002",
      senderUsername: "operator_20002",
      senderDisplayName: "另一位技术",
      fromBot: false,
      replyToMessageId: operatorEvent.telegramMessageId,
      messageThreadId: null,
      replyTargetIsBot: false,
      text: "我来处理",
      attachments: [],
      createdAt: "2026-08-28T02:00:01.000Z",
    })
    releaseRoute!(decision)
    await coordinator.drain()

    const thread = harness.store.findThreadByEvent(operatorEvent.id)!
    expect(thread).toMatchObject({ status: "closed" })
    expect(harness.database.prepare(`SELECT human_priority_state,closed_by FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "answered", closed_by: "群内人工" })
    await coordinator.stop()
  })

  it("建线程前不会把同秒更早消息或技术命令误算为普通人工回复", async () => {
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "23001", "technical")
    harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-earlier-tech",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId: "23001",
      senderUsername: "operator_23001",
      senderDisplayName: "技术",
      senderRole: "technical",
      text: "之前的普通回复",
      attachmentSummary: "",
      routeStatus: "role_skipped",
      skipReason: "角色用户普通消息不进入客服问题",
      createdAt: "2026-08-28T02:10:00.000Z",
    })
    const source = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-source-after-earlier",
      replyToMessageId: null,
      messageThreadId: null,
      senderUserId: "33001",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "@operator_23001 看下",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      humanPriorityUserIds: ["23001"],
      humanPriorityTechnicalMention: true,
      createdAt: "2026-08-28T02:10:00.000Z",
    }).event
    harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-tech-command",
      replyToMessageId: source.telegramMessageId,
      messageThreadId: null,
      senderUserId: "23001",
      senderUsername: "operator_23001",
      senderDisplayName: "技术",
      senderRole: "technical",
      text: "/ai 另一个问题",
      attachmentSummary: "",
      routeStatus: "command",
      skipReason: null,
      createdAt: "2026-08-28T02:10:01.000Z",
    })
    const batchId = randomUUID()
    harness.store.assignEventBatch(source.id, batchId)
    const thread = harness.store.createThread({
      groupId: harness.group.id,
      projectId: harness.service.projectId,
      serviceId: harness.service.id,
      originBatchId: batchId,
      settleAt: source.createdAt,
      anchorMessageId: source.telegramMessageId,
      latestMessageAt: source.createdAt,
      summary: source.safeText,
      originEventId: source.id,
      questionFragment: source.safeText,
    }).thread

    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "collecting" })
    expect(harness.database.prepare(`SELECT human_priority_state FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "waiting" })
  })

  it.each([
    { state: "uncertain" as const, expectedThreadState: "waiting", expectedClaimable: false },
    { state: "failed" as const, expectedThreadState: "claimed", expectedClaimable: true },
  ])("稍等发送结果为 $state 时按持久结果决定等待或恢复 AI", async ({ state, expectedThreadState, expectedClaimable }) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:30:00.000Z"))
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, `priority-send-${state}`, "@target_tech 看下", ["20001"])
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: {
        sendMessage: async () => { throw new TelegramDeliveryError("network", state) },
      },
    })

    await deadline.runOnce(new Date(event.createdAt))

    expect(harness.database.prepare(`SELECT human_priority_state FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: expectedThreadState })
    expect(Boolean(harness.store.claimDue(event.createdAt, 0))).toBe(expectedClaimable)
    const ownership = harness.database.prepare(`SELECT status FROM support_thread_notifications
      WHERE thread_id=? AND kind='progress'`).get(thread.id)
    expect(ownership).toEqual({ status: state === "uncertain" ? "unknown" : "failed" })
  })

  it("重启后已开始发送的稍等进入剩余人工窗口，未开始 RPC 的原 notification 立即重试", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:40:00.000Z"))
    const harness = await createBaseHarness()
    const started = createQuestion(harness, "priority-recover-started", "@target_tech 看下", ["20001"])
    const startedClaim = harness.store.claimDueHumanPriority(started.event.createdAt)!
    harness.store.claimNotificationSending(startedClaim.notificationId, started.event.createdAt)
    seedOwnershipForNotification(
      harness,
      started.thread,
      startedClaim.notificationId,
      "sending",
      "mention_claim_progress",
      started.event.createdAt,
    )
    const unstarted = createQuestion(harness, "priority-recover-unstarted", "@target_tech 再看下", ["20001"])
    const unstartedClaim = harness.store.claimDueHumanPriority(unstarted.event.createdAt)!
    const recoveredAt = "2026-08-28T01:40:30.000Z"

    expect(harness.store.recoverInterruptedHumanPriorityClaims(recoveredAt)).toEqual({ resumed: 1, retried: 1 })
    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_due_at FROM support_threads WHERE id=?`)
      .get(started.thread.id)).toEqual({
      human_priority_state: "waiting",
      human_priority_due_at: "2026-08-28T01:43:00.000Z",
    })
    expect(harness.store.claimDueHumanPriority(recoveredAt)).toEqual({
      threadId: unstarted.thread.id,
      inputRevision: unstarted.thread.revision,
      notificationId: unstartedClaim.notificationId,
    })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications WHERE thread_id=?`)
      .get(unstarted.thread.id)).toEqual({ count: 1 })
  })

  it("deadline 启动恢复不会用重启时间重置已开始发送的剩余人工窗口", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:45:30.000Z"))
    const harness = await createBaseHarness()
    const started = createQuestion(harness, "priority-start-order", "@target_tech 看下", ["20001"])
    const claim = harness.store.claimDueHumanPriority(started.event.createdAt)!
    harness.store.claimNotificationSending(claim.notificationId, started.event.createdAt)
    seedOwnershipForNotification(
      harness,
      started.thread,
      claim.notificationId,
      "sending",
      "mention_claim_progress",
      "2026-08-28T01:45:00.000Z",
    )
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage: async () => "must-not-send" },
    })

    deadline.start(60_000)
    await Promise.resolve()

    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_due_at FROM support_threads WHERE id=?`)
      .get(started.thread.id)).toEqual({
      human_priority_state: "waiting",
      human_priority_due_at: "2026-08-28T01:48:00.000Z",
    })
    expect(harness.database.prepare(`SELECT delivery_status,updated_at FROM telegram_output_ownership
      WHERE notification_id=?`).get(claim.notificationId)).toEqual({
      delivery_status: "unknown",
      updated_at: "2026-08-28T01:45:30.000Z",
    })
    await deadline.stop()
  })

  it("deadline 正忙时收到的新 wake 会在当前轮结束后立即补跑", async () => {
    const harness = await createBaseHarness()
    const first = createQuestion(harness, "priority-busy-first", "@target_tech 看下", ["20001"])
    let releaseFirst: ((messageId: string) => void) | null = null
    const sendMessage = vi.fn(() => {
      if (sendMessage.mock.calls.length === 1) {
        return new Promise<string>((resolve) => { releaseFirst = resolve })
      }
      return Promise.resolve("priority-busy-second-progress")
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage },
    })
    deadline.start(60_000)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const second = createQuestion(harness, "priority-busy-second", "@target_tech 再看下", ["20001"])

    deadline.wake()
    releaseFirst!("priority-busy-first-progress")
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))

    expect(harness.store.getThread(first.thread.id)).toMatchObject({ status: "collecting" })
    expect(harness.store.getThread(second.thread.id)).toMatchObject({ status: "collecting" })
    await deadline.stop()
  })

  it("首次稍等后的补充或重复@不把三分钟人工窗口向后顺延", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:50:00.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "24001", "technical")
    const first = createQuestion(harness, "priority-repeat-at", "@operator_24001 看下", ["24001"])
    const claim = harness.store.claimDueHumanPriority(first.event.createdAt)!
    harness.store.claimNotificationSending(claim.notificationId, first.event.createdAt)
    harness.store.completeNotification(claim.notificationId, "priority-repeat-progress", "稍等", first.event.createdAt)
    harness.store.completeHumanPriorityClaim(claim, "priority-repeat-progress", null, first.event.createdAt)
    const originalDueAt = "2026-08-28T01:53:00.000Z"
    const repeatedAt = "2026-08-28T01:52:00.000Z"
    const repeated = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-repeat-at-followup",
      replyToMessageId: first.event.telegramMessageId,
      messageThreadId: null,
      senderUserId: first.event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "@operator_24001 再看一下",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      humanPriorityUserIds: ["24001"],
      humanPriorityTechnicalMention: true,
      createdAt: repeatedAt,
    }).event
    harness.store.appendMessage({
      threadId: first.thread.id,
      eventId: repeated.id,
      relation: "supplement",
      questionFragment: repeated.safeText,
      settleAt: repeatedAt,
    })

    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_due_at,settle_at
      FROM support_threads WHERE id=?`).get(first.thread.id)).toEqual({
      human_priority_state: "waiting",
      human_priority_due_at: originalDueAt,
      settle_at: originalDueAt,
    })
    expect(harness.store.claimDueHumanPriority(originalDueAt)).toBeNull()
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications WHERE thread_id=?`)
      .get(first.thread.id)).toEqual({ count: 1 })
  })

  it("稍等 RPC 发送中收到重复@时保持 sending，完成后才建立三分钟窗口", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T01:55:00.000Z"))
    const harness = await createBaseHarness()
    seedConfiguredRole(harness.database, "25001", "technical")
    const first = createQuestion(harness, "priority-inflight-repeat", "@operator_25001 看下", ["25001"])
    const claim = harness.store.claimDueHumanPriority(first.event.createdAt)!
    harness.store.claimNotificationSending(claim.notificationId, first.event.createdAt)
    seedOwnershipForNotification(
      harness,
      first.thread,
      claim.notificationId,
      "sending",
      "mention_claim_progress",
      first.event.createdAt,
    )
    const repeatedAt = "2026-08-28T01:55:10.000Z"
    const repeated = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-inflight-repeat-followup",
      replyToMessageId: first.event.telegramMessageId,
      messageThreadId: null,
      senderUserId: first.event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "@operator_25001 再看一下",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      humanPriorityUserIds: ["25001"],
      humanPriorityTechnicalMention: true,
      createdAt: repeatedAt,
    }).event
    harness.store.appendMessage({
      threadId: first.thread.id,
      eventId: repeated.id,
      relation: "supplement",
      questionFragment: repeated.safeText,
      settleAt: repeatedAt,
    })

    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_due_at FROM support_threads WHERE id=?`)
      .get(first.thread.id)).toEqual({
      human_priority_state: "sending",
      human_priority_due_at: first.event.createdAt,
    })
    const completedAt = "2026-08-28T01:55:20.000Z"
    harness.store.completeNotification(claim.notificationId, "priority-inflight-progress", "稍等", completedAt)
    expect(harness.store.completeHumanPriorityClaim(
      claim,
      "priority-inflight-progress",
      null,
      completedAt,
    )).toBe(true)
    expect(harness.database.prepare(`SELECT human_priority_state,human_priority_due_at FROM support_threads WHERE id=?`)
      .get(first.thread.id)).toEqual({
      human_priority_state: "waiting",
      human_priority_due_at: "2026-08-28T01:58:20.000Z",
    })
  })

  it("pending progress 重启后沿原 notification 恢复发送且不会创建新 owner", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-progress-recover-pending")
    const now = new Date().toISOString()
    const notification = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      now,
      now,
    )!

    const recovered = harness.store.claimPendingProgressNotification(now)

    expect(recovered).toEqual({ ...notification, status: "sending", updatedAt: now })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications
      WHERE thread_id=? AND kind='progress'`).get(thread.id)).toEqual({ count: 1 })
    expect(harness.database.prepare(`SELECT notification_id FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(thread.id)).toEqual({ notification_id: notification.id })
  })

  it("collecting 阶段遗留的 status request pending notification 重启后沿原 owner 发送", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-progress-recover-status-request")
    const now = new Date().toISOString()
    const notification = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      now,
      now,
    )!
    const sendMessage = vi.fn(async () => "status-request-recovered")
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(now))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      "稍等",
      thread.anchorMessageId,
      undefined,
      expect.objectContaining({ notificationId: notification.id, kind: "progress" }),
    )
    expect(harness.database.prepare(`SELECT status,telegram_message_id FROM support_thread_notifications WHERE id=?`)
      .get(notification.id)).toEqual({ status: "sent", telegram_message_id: "status-request-recovered" })
  })

  it("status-only 原子提交后的路由状态不会阻塞原 revision answer worker 完成", async () => {
    const harness = await createBaseHarness()
    const question = createQuestion(harness, "status-worker-resume", "帮我查这笔订单为什么一直处理中")
    const snapshot = seedCodeSnapshot(harness)
    let signalAgentStarted!: () => void
    let finishGeneration!: (decision: AnswerDecision) => void
    const agentStarted = new Promise<void>((resolve) => { signalAgentStarted = resolve })
    const generated = new Promise<AnswerDecision>((resolve) => { finishGeneration = resolve })
    const sendMessage = vi.fn(async () => "status-worker-final-answer")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        signalAgentStarted()
        return generated
      },
      sendMessage,
    })

    const running = worker.runDueOnce(new Date())
    await agentStarted
    const active = harness.store.getThread(question.thread.id)
    const reminder = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "status-worker-reminder",
      replyToMessageId: question.event.telegramMessageId,
      messageThreadId: null,
      senderUserId: question.event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "现在查得怎么样了",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
      createdAt: new Date(Date.parse(question.event.createdAt) + 1_000).toISOString(),
    }).event
    harness.store.assignEventBatch(reminder.id, randomUUID())
    const committed = harness.store.appendStatusOnlyBatchAndClaimProgress([{
      message: {
        threadId: active.id,
        eventId: reminder.id,
        relation: "supplement",
        questionFragment: reminder.safeText,
        settleAt: active.settleAt,
        expectedRevision: active.revision,
      },
      focus: {
        senderUserId: reminder.senderUserId,
        source: "explicit_reply",
        operatorMessageId: reminder.telegramMessageId,
      },
    }], reminder.createdAt)
    const pendingRouting = harness.store.hasPendingRoutingEventForThread(active.id)

    finishGeneration(answerDecision())
    if (pendingRouting) worker.cancel(active.id, active.revision)
    await running

    expect(committed?.thread).toMatchObject({ id: active.id, revision: active.revision })
    expect(harness.store.getEvent(reminder.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "status_only:progress_claim_persisted",
    })
    expect(pendingRouting).toBe(false)
    expect(sendMessage).toHaveBeenCalledWith(
      harness.group.accountId,
      harness.group.telegramChatId,
      answerDecision().answer,
      reminder.telegramMessageId,
      null,
      expect.objectContaining({ threadId: active.id, kind: "support_reply" }),
    )
    expect(harness.store.getThread(active.id).status).toBe("answered")
  })

  it("重启时 progress sending 仅在 RPC 未开始时恢复 pending，已有 ownership 时恢复 unknown", async () => {
    const harness = await createBaseHarness()
    const first = createQuestion(harness, "claim-progress-recover-unstarted").thread
    const second = createQuestion(harness, "claim-progress-recover-started").thread
    const now = "2026-08-28T02:00:00.000Z"
    const unstarted = harness.store.claimProgressNotification(first.id, first.revision, "status_request", now, now)!
    const started = harness.store.claimProgressNotification(second.id, second.revision, "status_request", now, now)!
    harness.database.prepare("UPDATE support_thread_notifications SET status='sending' WHERE id IN (?,?)")
      .run(unstarted.id, started.id)
    seedOwnershipForNotification(harness, second, started.id, "sending")

    harness.store.recoverInterruptedNotifications(now)

    const state = harness.database.prepare(`SELECT status,error_message FROM support_thread_notifications WHERE id=?`)
    expect(state.get(unstarted.id)).toEqual({
      status: "pending",
      error_message: "服务重启前发送尚未开始，重新发送",
    })
    expect(state.get(started.id)).toEqual({
      status: "unknown",
      error_message: "服务重启前发送状态未知",
    })
    expect(harness.database.prepare(`SELECT delivery_status FROM telegram_output_ownership
      WHERE notification_id=?`).get(started.id)).toEqual({ delivery_status: "unknown" })
  })

  it("progress 明确发送失败后释放 owner，最新有效版本可以重新领取", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-progress-explicit-failure")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const notification = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      now,
      now,
    )!
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage: async () => { throw new TelegramDeliveryError("forbidden", "failed") } },
    })

    await deadline.runOnce(new Date(now))

    expect(harness.database.prepare("SELECT status FROM support_thread_notifications WHERE id=?")
      .get(notification.id)).toEqual({ status: "failed" })
    expect(harness.store.hasStartedProgress(thread.id)).toBe(false)
    expect(harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "scheduled_progress",
      now,
      now,
    )).toMatchObject({ id: notification.id, status: "pending" })
  })

  it("progress 发送结果未知时保留 owner 且不会重新发送", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-progress-unknown")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const notification = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      now,
      now,
    )!
    const sendMessage = vi.fn(async () => { throw new TelegramDeliveryError("network", "uncertain") })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(now))
    await deadline.runOnce(new Date(now))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.database.prepare("SELECT status FROM support_thread_notifications WHERE id=?")
      .get(notification.id)).toEqual({ status: "unknown" })
    expect(harness.store.hasStartedProgress(thread.id)).toBe(true)
  })

  it("新 revision 替代尚未开始 RPC 的 pending progress 时失败并释放旧 claim", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "claim-progress-superseded")
    const now = new Date().toISOString()
    const notification = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "status_request",
      now,
      now,
    )!
    const supplement = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "claim-progress-superseded-2",
      replyToMessageId: event.telegramMessageId,
      messageThreadId: null,
      senderUserId: event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "补充新的排查信息",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event

    expect(harness.store.appendMessage({
      threadId: thread.id,
      eventId: supplement.id,
      relation: "supplement",
      questionFragment: supplement.safeText,
      settleAt: now,
    })?.revision).toBe(2)

    expect(harness.database.prepare("SELECT status FROM support_thread_notifications WHERE id=?")
      .get(notification.id)).toEqual({ status: "failed" })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_output_claims
      WHERE thread_id=? AND claim_kind='progress'`).get(thread.id)).toEqual({ count: 0 })
  })

  it("附件提取生成新 revision 时同样失败并释放尚未开始 RPC 的 progress", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "claim-progress-attachment-superseded")
    const now = new Date().toISOString()
    harness.store.claimDue(now, 0)
    const notification = harness.store.claimProgressNotification(
      thread.id,
      thread.revision,
      "scheduled_progress",
      now,
      now,
    )!

    harness.store.replaceEventAttachments(event.id, [{
      name: "evidence.txt",
      mimeType: "text/plain",
      size: 8,
      kind: "text",
      localPath: null,
      extractedText: "新证据",
    }], "新证据")

    expect(harness.store.getThread(thread.id).revision).toBe(2)
    expect(harness.database.prepare("SELECT status FROM support_thread_notifications WHERE id=?")
      .get(notification.id)).toEqual({ status: "failed" })
    expect(harness.store.hasStartedProgress(thread.id)).toBe(false)
  })

  it("hasStartedProgress 最终只读取 thread-level claim，不保留 legacy 双真相源", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "claim-progress-claim-only")
    const now = new Date().toISOString()
    harness.database.prepare(`INSERT INTO support_thread_notifications(
      id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), thread.id, thread.revision, "progress", "sent", now, "legacy-progress", null, now, now,
    )

    expect(harness.store.hasStartedProgress(thread.id)).toBe(false)
  })
})

function seedOwnershipForNotification(
  harness: BaseHarness,
  thread: SupportThread,
  notificationId: string,
  deliveryStatus: "sending" | "sent" | "unknown",
  outputKind = "progress",
  createdAt = new Date().toISOString(),
): void {
  harness.database.prepare(`INSERT INTO telegram_output_ownership(
    id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
    notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), null, harness.group.id, harness.group.telegramChatId,
    deliveryStatus === "sent" ? `claimed-${thread.anchorMessageId}` : null,
    thread.id, thread.serviceId, null, notificationId, outputKind, deliveryStatus, randomUUID(), "b".repeat(64),
    thread.anchorMessageId, createdAt, createdAt,
  )
}

function escalationDecision(): AnswerDecision {
  return {
    decision: "escalate",
    escalationType: "technical_change",
    humanOperation: null,
    answer: "已确认通道银行映射缺失 需要技术补上",
    quote: null,
    reason: "[已确认技术处理] 类型=后台映射 代码与运行数据均已确认",
    confidence: 1,
    usedMemoryVersionIds: [],
    answerClaims: [{
      factId: "F1",
      statement: "已确认通道银行映射缺失 需要技术补上",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "运营要求处理映射",
    }],
    responsibility: { party: "unknown", certainty: "unknown", evidenceSources: [], factIds: [] },
    interaction: {
      sentiment: "neutral",
      situation: "new_request",
      underlyingNeed: "处理已确认的内部映射问题",
      responseStrategy: "direct_answer",
    },
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
    evidencePacket: {
      version: "2",
      communication: { intent: "handoff", recipient: null, desiredOutcome: "通知技术处理映射" },
      facts: [{
        id: "F1",
        statement: "已确认通道银行映射缺失 需要技术补上",
        provenance: "user_report",
        evidenceSource: "message",
        evidence: "运营要求处理映射",
        certainty: "reported",
        outboundSafe: true,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }],
      associations: [],
      requiredAnswerPoints: ["说明映射缺失和技术处理"],
      unknowns: [],
      handlingNotes: [],
      reviewLevel: "standard",
    },
  }
}

function featureRequestDecision(): AnswerDecision {
  const decision = escalationDecision()
  return {
    ...decision,
    escalationType: "feature_request",
    answer: "已经通知技术排期了",
    reason: "运营明确提出新增功能",
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
  sendMessage?(
    accountId: string | null,
    chatId: string,
    text: string,
    replyToMessageId?: string,
    quote?: string | null,
    ownership?: TelegramOutputOwnership,
  ): Promise<string>
  sendSupportAlert?(): Promise<{ status: "sent"; summary: string; errorType: null }>
  sendCodeSyncFailure?(): Promise<{ status: "sent"; summary: string; errorType: null }>
  sendTransientFeatureRequest?(
    group: RuntimeGroup,
    replyId: string,
    reason: string,
    answer: string,
  ): Promise<{ status: "sent"; summary: string; errorType: null }>
}): SupportAnswerWorker {
  let latestDecision: AnswerDecision | null = null
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
        const generated = typeof input.decision === "function"
          ? await input.decision(agentInput)
          : input.decision ?? answerDecision()
        const decision = structuredClone(generated)
        const messageEvidence = agentInput.question.slice(0, 1000)
        decision.answerClaims = decision.answerClaims.map((claim) => (
          claim.provenance === "user_report" && claim.evidenceSource === "message"
            ? { ...claim, evidence: messageEvidence }
            : claim
        ))
        decision.evidencePacket = {
          ...decision.evidencePacket,
          facts: decision.evidencePacket.facts.map((fact) => (
            fact.provenance === "user_report" && fact.evidenceSource === "message"
              ? { ...fact, evidence: messageEvidence }
              : fact
          )),
        }
        latestDecision = decision
        return decision
      },
      composeTechnicalAvailabilityReply: async () => ({ answer: generatedTechnicalAvailabilityReply }),
      composeReply: async () => {
        if (!latestDecision) throw new Error("测试成稿端口缺少基线决策")
        const fact = latestDecision.evidencePacket?.facts.find((item) => item.outboundSafe)
        return {
          answer: latestDecision.answer,
          quote: latestDecision.quote,
          claims: fact && latestDecision.answer
            ? [{ factId: fact.id, statement: latestDecision.answer.slice(0, 1000) }]
            : [],
          usedMemoryVersionIds: latestDecision.usedMemoryVersionIds,
        }
      },
      reviewReply: async () => ({
        outcome: "approve",
        issues: [],
        reason: "生命周期测试审核通过",
      }),
    },
    transport: { sendMessage: input.sendMessage ?? (async () => "robot-message") },
    technicalAlerts: {
      sendSupportAlert: input.sendSupportAlert ?? (async () => ({ status: "sent", summary: "sent", errorType: null })),
      sendCodeSyncFailure: input.sendCodeSyncFailure ?? (async () => ({ status: "sent", summary: "sent", errorType: null })),
      ...(input.sendTransientFeatureRequest
        ? { sendTransientFeatureRequest: input.sendTransientFeatureRequest }
        : {}),
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
    const cancellation = {
      cancel: vi.fn(() => false),
      cancelClosed: vi.fn(() => 0),
      resumeHardDeadline: vi.fn(async () => undefined),
    }
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

  it("hard deadline 先 claim 且已有 progress 时原 reply 原子进入 prepared escalation，不创建第二条 progress", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-store-first")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)

    const timeout = harness.store.claimDueTimeout(now)

    expect(timeout).toMatchObject({
      threadId: thread.id,
      inputRevision: thread.revision,
      outcome: "prepared_escalation",
      replyId: reply.id,
      notificationKinds: [],
    })
    expect(harness.store.getThread(thread.id).status).toBe("generating")
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "generating",
      decision: "escalate",
      errorCode: "answer_hard_deadline",
      answer: TECHNICAL_AVAILABILITY_REPLY_PENDING,
    })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications
      WHERE thread_id=? AND kind IN ('timeout_operator','timeout_alert')`).get(thread.id)).toEqual({ count: 0 })
  })

  it("最终回复已进入 sending 窄窗时 hard deadline 不改写为升级且不会永久残留", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-final-send")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    expect(harness.replies.claimSending(reply.id, {
      answer: "原最终回复",
      decisionReason: "原回答已取得发送权",
      decisionConfidence: 1,
    })).not.toBeNull()
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)

    expect(harness.store.claimDueTimeout(now)).toMatchObject({
      threadId: thread.id,
      inputRevision: thread.revision,
      outcome: "delivery_in_flight",
      replyId: reply.id,
      notificationKinds: [],
    })
    expect(harness.store.claimDueTimeout(new Date(Date.parse(now) + 1_000).toISOString())).toBeNull()
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "generating", hardDeadlineAt: null })
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "sending",
      decision: "pending",
      answer: "原最终回复",
    })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications
      WHERE thread_id=? AND kind IN ('timeout_operator','timeout_alert')`).get(thread.id)).toEqual({ count: 0 })
  })

  it("普通最终回复 RPC 跨过 hard deadline 后明确失败时继续原发送失败收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-final-send-failed")
    seedProgressDelivery(harness, thread, "sent")
    const sendSupportAlert = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const sendMessage = vi.fn(async () => {
      const dueAt = new Date().toISOString()
      harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(dueAt, thread.id)
      throw new TelegramDeliveryError("forbidden", "failed")
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      decision: answerDecision(),
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    const reply = harness.database.readReplies("WHERE r.thread_id=?", [thread.id])[0]!
    expect(reply).toMatchObject({
      status: "failed",
      decision: "pending",
      errorCode: "support_delivery_failed",
      operatorDeliveryStatus: "failed",
      answer: answerDecision().answer,
    })
    expect(reply.answer).not.toBe(generatedTechnicalAvailabilityReply)
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "escalated", hardDeadlineAt: null })
    expect(harness.database.prepare(`SELECT alert_kind,status FROM support_reply_alert_deliveries
      WHERE reply_id=?`).all(reply.id)).toEqual([
      { alert_kind: "support_delivery_failure", status: "sent" },
    ])
  })

  it("deadline service 先 claim 已有 progress 的 hard deadline 时真实转技术并 exactly-once AI 自然收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-service-first")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)
    const order: string[] = []
    const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
      order.push(`operator:${text}`)
      return "hard-deadline-fixed"
    })
    const sendSupportAlert = vi.fn(async () => {
      order.push("technical")
      return { status: "sent" as const, summary: "sent", errorType: null }
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendMessage, sendSupportAlert,
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: worker,
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(now))
    await deadline.runOnce(new Date(Date.parse(now) + 1_000))

    expect(order).toEqual([
      "technical",
      `operator:${generatedTechnicalAvailabilityReply}`,
    ])
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "escalated",
      decision: "escalate",
      answer: generatedTechnicalAvailabilityReply,
    })
    expect(harness.store.handoffSource(thread.id)).toBe("hard_deadline")
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_thread_notifications
      WHERE thread_id=? AND kind IN ('timeout_operator','timeout_alert')`).get(thread.id)).toEqual({ count: 0 })
  })

  it("worker 失败与 deadline service 同时触发时也只执行一次技术告警和一次固定运营收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-concurrent")
    seedProgressDelivery(harness, thread, "sent")
    const now = new Date().toISOString()
    let signalStarted!: () => void
    let rejectGeneration!: (error: unknown) => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const generation = new Promise<AnswerDecision>((_resolve, reject) => { rejectGeneration = reject })
    const order: string[] = []
    const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
      order.push(`operator:${text}`)
      return "hard-deadline-concurrent-fixed"
    })
    const sendSupportAlert = vi.fn(async () => {
      order.push("technical")
      return { status: "sent" as const, summary: "sent", errorType: null }
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      decision: async () => {
        harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)
        signalStarted()
        return generation
      },
      sendMessage,
      sendSupportAlert,
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: worker,
      transport: { sendMessage },
    })

    const workerRunning = worker.runDueOnce(new Date(now))
    await started
    const deadlineRunning = deadline.runOnce(new Date(now))
    rejectGeneration(new ModelExecutionError("provider_timeout", "并发 provider timeout"))
    await Promise.all([workerRunning, deadlineRunning])
    await deadline.runOnce(new Date(Date.parse(now) + 1_000))

    expect(order).toEqual([
      "technical",
      `operator:${generatedTechnicalAvailabilityReply}`,
    ])
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
  })

  it.each<{ label: string; decision: AnswerDecision }>([
    { label: "reply", decision: answerDecision() },
    { label: "feature_request", decision: featureRequestDecision() },
    { label: "technical_escalation", decision: escalationDecision() },
  ])("deadline 先持久化 marker 时 $label 不能覆盖持久升级且两段投递 exactly-once", async ({ label, decision }) => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, `hard-deadline-first-${label}`)
    seedProgressDelivery(harness, thread, "sent")
    const snapshot = seedCodeSnapshot(harness)
    const order: string[] = []
    const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
      order.push(`operator:${text}`)
      return `hard-deadline-first-${label}`
    })
    const sendSupportAlert = vi.fn(async () => {
      order.push("technical")
      return { status: "sent" as const, summary: "sent", errorType: null }
    })
    const sendTransientFeatureRequest = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const originalFind = harness.store.findPreparedHardDeadlineReplyId.bind(harness.store)
    let hardDeadlineLookups = 0
    vi.spyOn(harness.store, "findPreparedHardDeadlineReplyId").mockImplementation((threadId, revision) => {
      const existing = originalFind(threadId, revision)
      hardDeadlineLookups += 1
      if (hardDeadlineLookups === 2 && existing === null) {
        const dueAt = new Date().toISOString()
        harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(dueAt, thread.id)
        expect(harness.store.claimDueTimeout(dueAt)).toMatchObject({
          outcome: "prepared_escalation",
          threadId: thread.id,
        })
      }
      return existing
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision,
      sendMessage,
      sendSupportAlert,
      sendTransientFeatureRequest,
    })

    await worker.runDueOnce(new Date())

    expect(order).toEqual([
      "technical",
      `operator:${generatedTechnicalAvailabilityReply}`,
    ])
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendTransientFeatureRequest).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "escalated",
        decision: "escalate",
        errorCode: "answer_hard_deadline",
        answer: generatedTechnicalAvailabilityReply,
      }),
    ])
  })

  it.each<{
    label: string
    decision: AnswerDecision
    expectedThreadStatus: "answered" | "escalated"
    supportAlerts: number
    featureAlerts: number
  }>([
    {
      label: "reply",
      decision: answerDecision(),
      expectedThreadStatus: "answered",
      supportAlerts: 0,
      featureAlerts: 0,
    },
    {
      label: "feature_request",
      decision: featureRequestDecision(),
      expectedThreadStatus: "escalated",
      supportAlerts: 0,
      featureAlerts: 1,
    },
    {
      label: "technical_escalation",
      decision: escalationDecision(),
      expectedThreadStatus: "escalated",
      supportAlerts: 1,
      featureAlerts: 0,
    },
  ])("$label 先取得 final sending 时 deadline 不改写赢家且保持 exactly-once", async (scenario) => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, `final-send-first-${scenario.label}`)
    seedProgressDelivery(harness, thread, "sent")
    let signalSending!: () => void
    let finishSending!: (messageId: string) => void
    const sendingStarted = new Promise<void>((resolve) => { signalSending = resolve })
    const sendingResult = new Promise<string>((resolve) => { finishSending = resolve })
    const sendMessage = vi.fn(async () => {
      signalSending()
      return sendingResult
    })
    const sendSupportAlert = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const sendTransientFeatureRequest = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      decision: scenario.decision,
      sendMessage,
      sendSupportAlert,
      sendTransientFeatureRequest,
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: worker,
      transport: { sendMessage },
    })

    const running = worker.runDueOnce(new Date())
    await sendingStarted
    const dueAt = new Date().toISOString()
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(dueAt, thread.id)
    await deadline.runOnce(new Date(dueAt))
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "generating", hardDeadlineAt: null })
    finishSending(`final-send-first-${scenario.label}`)
    await running
    await deadline.runOnce(new Date(Date.parse(dueAt) + 1_000))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendSupportAlert).toHaveBeenCalledTimes(scenario.supportAlerts)
    expect(sendTransientFeatureRequest).toHaveBeenCalledTimes(scenario.featureAlerts)
    expect(harness.store.getThread(thread.id).status).toBe(scenario.expectedThreadStatus)
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: scenario.expectedThreadStatus === "answered" ? "replied" : "escalated",
        answer: scenario.decision.answer,
        errorCode: null,
      }),
    ])
  })

  it("普通技术升级已 prepared 并开始告警 RPC 时 deadline 不改写原两段投递", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "technical-prepared-before-deadline")
    seedProgressDelivery(harness, thread, "sent")
    let signalAlert!: () => void
    let finishAlert!: () => void
    const alertStarted = new Promise<void>((resolve) => { signalAlert = resolve })
    const alertResult = new Promise<void>((resolve) => { finishAlert = resolve })
    const sendSupportAlert = vi.fn(async () => {
      signalAlert()
      await alertResult
      return { status: "sent" as const, summary: "sent", errorType: null }
    })
    const sendMessage = vi.fn(async () => "technical-prepared-operator")
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      decision: escalationDecision(),
      sendMessage,
      sendSupportAlert,
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: worker,
      transport: { sendMessage },
    })

    const running = worker.runDueOnce(new Date())
    await alertStarted
    const dueAt = new Date().toISOString()
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(dueAt, thread.id)
    await deadline.runOnce(new Date(dueAt))
    const prepared = harness.database.readReplies("WHERE r.thread_id=?", [thread.id])[0]!
    expect(prepared).toMatchObject({
      status: "generating",
      decision: "escalate",
      answer: escalationDecision().answer,
      errorCode: null,
    })
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "generating", hardDeadlineAt: null })
    finishAlert()
    await running

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(escalationDecision().answer)
    expect(harness.replies.getDetail(prepared.id)).toMatchObject({
      status: "escalated",
      answer: escalationDecision().answer,
      errorCode: null,
    })
  })

  it("ReplyService CAS 拒绝普通 claim/prepare 覆写已持久化的 hard deadline marker", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-reply-cas")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)
    expect(harness.store.claimDueTimeout(now)).toMatchObject({
      outcome: "prepared_escalation",
      replyId: reply.id,
    })

    expect(harness.replies.claimSending(reply.id, {
      answer: "不应覆盖 持久 marker 的普通回答",
      errorCode: null,
      decisionReason: "普通回答",
      decisionConfidence: 1,
    })).toBeNull()
    expect(harness.replies.prepareTechnicalEscalation(reply.id, {
      answer: "不应覆盖 持久 marker 的普通升级",
      errorCode: null,
      decisionReason: "普通升级",
      decisionConfidence: 1,
    }, "technical_change")).toBeNull()
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "generating",
      decision: "escalate",
      errorCode: "answer_hard_deadline",
      answer: TECHNICAL_AVAILABILITY_REPLY_PENDING,
    })
  })

  it("feature transient alert RPC 已开始时 deadline 不覆写且两类输出各 exactly-once", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "feature-alert-in-flight-before-deadline")
    seedProgressDelivery(harness, thread, "sent")
    let signalTransient!: () => void
    let finishTransient!: () => void
    const transientStarted = new Promise<void>((resolve) => { signalTransient = resolve })
    const transientResult = new Promise<void>((resolve) => { finishTransient = resolve })
    const sendMessage = vi.fn(async () => "feature-operator-reply")
    const sendSupportAlert = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const sendTransientFeatureRequest = vi.fn(async (_group: RuntimeGroup, replyId: string) => {
      seedReplyOutputOwnership(harness, thread, replyId, "technical_alert:feature_request", "sending")
      signalTransient()
      await transientResult
      harness.database.prepare(`UPDATE telegram_output_ownership SET delivery_status='sent',
        telegram_message_id=?,updated_at=? WHERE reply_id=? AND output_kind='technical_alert:feature_request'`
      ).run("feature-forwarded", new Date().toISOString(), replyId)
      return { status: "sent" as const, summary: "sent", errorType: null }
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      decision: featureRequestDecision(),
      sendMessage,
      sendSupportAlert,
      sendTransientFeatureRequest,
    })
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: worker,
      transport: { sendMessage },
    })

    const running = worker.runDueOnce(new Date())
    await transientStarted
    const prepared = harness.database.readReplies("WHERE r.thread_id=?", [thread.id])[0]!
    const dueAt = new Date().toISOString()
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(dueAt, thread.id)

    await deadline.runOnce(new Date(dueAt))

    expect(harness.replies.getDetail(prepared.id)).toMatchObject({
      status: "generating",
      decision: "escalate",
      errorCode: "feature_request_prepared",
      answer: featureRequestDecision().answer,
    })
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "generating", hardDeadlineAt: null })
    finishTransient()
    await running

    expect(sendTransientFeatureRequest).toHaveBeenCalledTimes(1)
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.replies.getDetail(prepared.id)).toMatchObject({
      status: "escalated",
      errorCode: null,
      telegramReplyMessageId: "feature-operator-reply",
    })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_reply_alert_deliveries
      WHERE reply_id=?`).get(prepared.id)).toEqual({ count: 0 })
  })

  it.each<{
    kind: "reply" | "feature"
    ownership: "none" | "sending" | "unknown" | "sent" | "failed"
  }>([
    { kind: "reply", ownership: "none" },
    { kind: "reply", ownership: "sending" },
    { kind: "reply", ownership: "unknown" },
    { kind: "reply", ownership: "sent" },
    { kind: "reply", ownership: "failed" },
    { kind: "feature", ownership: "none" },
    { kind: "feature", ownership: "sending" },
    { kind: "feature", ownership: "unknown" },
    { kind: "feature", ownership: "sent" },
    { kind: "feature", ownership: "failed" },
  ])("$kind final claim 后崩溃按 support ownership=$ownership 精确恢复", async ({ kind, ownership }) => {
    const recoveredStatuses: ReplyStatus[] = []
    const harness = await createBaseHarness((event) => { recoveredStatuses.push(event.status) })
    const { thread } = createQuestion(harness, `final-recovery-${kind}-${ownership}`)
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const decision = kind === "feature" ? featureRequestDecision() : answerDecision()
    if (kind === "feature") {
      expect(harness.replies.prepareTechnicalEscalation(reply.id, {
        answer: decision.answer,
        errorCode: "feature_request_prepared",
        decisionReason: decision.reason,
        decisionConfidence: decision.confidence,
      }, "feature_request")).not.toBeNull()
      seedReplyOutputOwnership(harness, thread, reply.id, "technical_alert:feature_request", "sent")
    }
    expect(harness.replies.claimSending(reply.id, {
      answer: decision.answer,
      errorCode: kind === "feature" ? "feature_request_prepared" : null,
      decisionReason: decision.reason,
      decisionConfidence: decision.confidence,
    })).not.toBeNull()
    if (ownership !== "none") seedReplyOutputOwnership(harness, thread, reply.id, "support_reply", ownership)
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    const recovered = harness.replies.getDetail(reply.id)
    expect(recoveredStatuses).toContain(recovered.status)
    if (ownership === "none") {
      expect(recovered.status).toBe(kind === "feature" ? "generating" : "superseded")
      expect(recovered.errorCode).not.toBe("delivery_state_unknown")
      expect(harness.store.getThread(thread.id).status).toBe("collecting")
    } else if (ownership === "sent") {
      expect(recovered).toMatchObject({
        status: kind === "feature" ? "escalated" : "replied",
        decision: kind === "feature" ? "escalate" : "reply",
        operatorDeliveryStatus: "sent",
        errorCode: null,
      })
      expect(harness.store.getThread(thread.id).status).toBe(kind === "feature" ? "escalated" : "answered")
    } else {
      expect(recovered).toMatchObject({
        status: "failed",
        operatorDeliveryStatus: ownership === "failed" ? "failed" : "uncertain",
        errorCode: ownership === "failed" ? "support_delivery_failed" : "delivery_state_unknown",
      })
      expect(harness.store.getThread(thread.id).status).toBe("escalated")
    }

    const sendMessage = vi.fn(async () => `${kind}-recovered-operator`)
    const sendSupportAlert = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const sendTransientFeatureRequest = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      decision,
      sendMessage,
      sendSupportAlert,
      sendTransientFeatureRequest,
    })
    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

    expect(sendMessage).toHaveBeenCalledTimes(ownership === "none" ? 1 : 0)
    expect(sendTransientFeatureRequest).not.toHaveBeenCalled()
    expect(sendSupportAlert).toHaveBeenCalledTimes(
      ownership === "sending" || ownership === "unknown" || ownership === "failed" ? 1 : 0,
    )
    const finalReply = harness.replies.getDetail(reply.id)
    if (ownership === "none" && kind === "feature") {
      expect(finalReply).toMatchObject({ status: "escalated", errorCode: null })
    }
    if (ownership === "none" && kind === "reply") {
      expect(finalReply.status).toBe("superseded")
      expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toContainEqual(
        expect.objectContaining({ status: "replied", answer: decision.answer }),
      )
    }
  })

  it.each(["none", "sending", "unknown", "sent", "failed"] as const)(
    "启动先恢复 rev2 collecting 时旧 rev1 sending reply 按 ownership=%s 收口且不终止新输入",
    async (ownership) => {
      const recoveredStatuses: ReplyStatus[] = []
      const harness = await createBaseHarness((event) => { recoveredStatuses.push(event.status) })
      const { event, thread } = createQuestion(harness, `old-revision-${ownership}`)
      const firstClaim = harness.store.claimDue(new Date().toISOString())!
      const oldReply = seedGeneratingReply(harness, firstClaim.thread)
      expect(harness.replies.claimSending(oldReply.id, {
        answer: "旧版本最终回复",
        decisionReason: "旧版本发送中",
      })).not.toBeNull()
      if (ownership !== "none") seedReplyOutputOwnership(harness, thread, oldReply.id, "support_reply", ownership)
      const followup = harness.store.recordEvent({
        groupId: harness.group.id,
        accountId: harness.group.accountId,
        telegramMessageId: `old-revision-${ownership}-followup`,
        replyToMessageId: event.telegramMessageId,
        messageThreadId: null,
        senderUserId: event.senderUserId,
        senderUsername: null,
        senderDisplayName: "运营",
        senderRole: null,
        text: "补充当前版本的新信息",
        attachmentSummary: "",
        routeStatus: "received",
        skipReason: null,
      }).event
      const recoveredAt = new Date()
      harness.store.appendMessage({
        threadId: thread.id,
        eventId: followup.id,
        relation: "supplement",
        questionFragment: followup.safeText,
        settleAt: new Date(recoveredAt.getTime() - 10_000).toISOString(),
      })
      const staleAt = new Date(recoveredAt.getTime() - 2 * 60 * 60_000).toISOString()
      const staleBefore = new Date(recoveredAt.getTime() - 60 * 60_000).toISOString()
      harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, oldReply.id)
      harness.database.prepare(`UPDATE telegram_output_ownership SET updated_at=?
        WHERE reply_id=? AND output_kind='support_reply'`).run(staleAt, oldReply.id)

      harness.store.recoverStaleGenerating(recoveredAt.toISOString(), staleBefore)

      const recovered = harness.replies.getDetail(oldReply.id)
      const expectedStatus = ownership === "none" ? "superseded"
        : ownership === "sent" ? "replied" : "failed"
      expect(recoveredStatuses).toEqual([expectedStatus])
      expect(recovered).toMatchObject(ownership === "none"
        ? { status: "superseded", operatorDeliveryStatus: null, errorCode: null }
        : ownership === "sent"
          ? {
              status: "replied",
              decision: "reply",
              operatorDeliveryStatus: "sent",
              telegramReplyMessageId: `support_reply-${thread.anchorMessageId}`,
              errorCode: null,
            }
          : {
              status: "failed",
              operatorDeliveryStatus: ownership === "failed" ? "failed" : "uncertain",
              errorCode: ownership === "failed" ? "support_delivery_failed" : "delivery_state_unknown",
            })
      expect(harness.store.getThread(thread.id)).toMatchObject({ status: "collecting", revision: 2 })
      const followupDecision = answerDecision()
      followupDecision.answerClaims[0]!.evidence = followup.safeText
      followupDecision.evidencePacket!.facts[0]!.evidence = followup.safeText
      const sendMessage = vi.fn(async () => "new-revision-reply")
      const sendSupportAlert = vi.fn(async () => ({
        status: "sent" as const, summary: "sent", errorType: null,
      }))
      const agentInputs: SupportDecisionInput[] = []
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => seedCodeSnapshot(harness),
        decision: followupDecision,
        onAgentInput: (input) => { agentInputs.push(input) },
        sendMessage,
        sendSupportAlert,
      })

      expect(await worker.runDueOnce(new Date(recoveredAt.getTime() + 1_000))).toBe(true)

      expect(agentInputs).toHaveLength(1)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendSupportAlert).not.toHaveBeenCalled()
      expect(harness.replies.getDetail(oldReply.id).status).toBe(expectedStatus)
      expect(harness.store.getThread(thread.id)).toMatchObject({ status: "answered", revision: 2 })
      expect(await worker.runDueOnce(new Date(recoveredAt.getTime() + 2_000))).toBe(false)
      expect(sendMessage).toHaveBeenCalledTimes(1)
    },
  )

  it.each([false, true])(
    "普通回复失败告警崩溃恢复按 alert ownership 分流（inFlight=%s）",
    async (inFlight) => {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `normal-failure-alert-recovery-${inFlight}`)
      const claimed = harness.store.claimDue(new Date().toISOString())!
      const reply = seedGeneratingReply(harness, claimed.thread)
      expect(harness.replies.claimSending(reply.id, { answer: answerDecision().answer })).not.toBeNull()
      harness.replies.transition(reply.id, "failed", {
        errorCode: "support_delivery_failed",
        operatorDeliveryStatus: "failed",
      })
      expect(harness.store.finishGeneration(thread.id, thread.revision, "escalated")).toBe(true)
      expect(harness.replies.claimTechnicalAlert(reply.id, "support_delivery_failure")).toBe(true)
      if (inFlight) {
        seedReplyOutputOwnership(
          harness,
          thread,
          reply.id,
          "technical_alert:support_delivery_failure",
          "sending",
        )
      }
      const staleAt = "2026-08-10T00:00:00.000Z"
      harness.database.prepare(`UPDATE support_reply_alert_deliveries SET updated_at=?
        WHERE reply_id=? AND alert_kind='support_delivery_failure'`).run(staleAt, reply.id)

      harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

      const sendSupportAlert = vi.fn(async () => ({
        status: "sent" as const, summary: "sent", errorType: null,
      }))
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => seedCodeSnapshot(harness),
        sendMessage: async () => "must-not-send",
        sendSupportAlert,
      })
      await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

      expect(sendSupportAlert).toHaveBeenCalledTimes(inFlight ? 0 : 1)
      expect(harness.database.prepare(`SELECT status FROM support_reply_alert_deliveries
        WHERE reply_id=? AND alert_kind='support_delivery_failure'`).get(reply.id)).toEqual({
        status: inFlight ? "uncertain" : "sent",
      })
    },
  )

  it("没有任何 started progress 的 hard deadline 延续旧 timeout 安全收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-without-progress")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)
    const sendMessage = vi.fn(async () => "legacy-timeout-progress")
    const deadline = new SupportDeadlineService({
      database: harness.database,
      store: harness.store,
      redactor: harness.redactor,
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
      transport: { sendMessage },
    })

    await deadline.runOnce(new Date(now))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe("稍等")
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(harness.replies.getDetail(reply.id).status).toBe("superseded")
    expect(harness.database.prepare(`SELECT kind,status FROM support_thread_notifications
      WHERE thread_id=? ORDER BY kind`).all(thread.id)).toEqual([
      { kind: "timeout_alert", status: "sent" },
      { kind: "timeout_operator", status: "sent" },
    ])
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
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
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
    }, "technical_change")).not.toBeNull()
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
        messageIntent: "progress_request",
        questionFragment: "这个问题现在排查得怎么样了",
        issues: null,
        investigationEffect: "status_only",
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

  it("人工优先已发稍等后模型失败会转技术并发送AI 终态", async () => {
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
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(generatedTechnicalAvailabilityReply)
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "escalated",
        decision: "escalate",
        answer: generatedTechnicalAvailabilityReply,
        errorCode: "answer_model_failed",
      }),
    ])
  })

  it("人工优先已发稍等后模型选择 ignore 会转技术并发送AI 终态", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-ignore")
    markHumanPriorityClaimed(harness, thread, event.id)
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "handoff-message")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: { ...answerDecision(), decision: "ignore", answer: "", reason: "判断为无需回复" },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(generatedTechnicalAvailabilityReply)
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "escalated",
        decision: "escalate",
        answer: generatedTechnicalAvailabilityReply,
        errorCode: "answer_ignored_after_human_priority",
      }),
    ])
  })

  it("人工优先已发稍等后代码资源不可用会转技术并发送AI 终态", async () => {
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
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(generatedTechnicalAvailabilityReply)
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "escalated",
        decision: "escalate",
        answer: generatedTechnicalAvailabilityReply,
        errorCode: "investigation_runtime_failed",
      }),
    ])
  })

  it("人工优先 progress 已有持久消息后即使正常答复过，后续 ignore 仍固定转技术收口", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-replied-thanks")
    markHumanPriorityClaimed(harness, thread, event.id)
    const snapshot = seedCodeSnapshot(harness)
    const firstSendMessage = vi.fn(async () => "answer-message")
    const firstWorker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: answerDecision(),
      sendMessage: firstSendMessage,
    })

    await firstWorker.runDueOnce(new Date())

    expect(firstSendMessage).toHaveBeenCalledTimes(1)
    expect(harness.database.prepare(`SELECT status,human_priority_state FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ status: "answered", human_priority_state: "none" })

    const thanks = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "priority-replied-thanks-followup",
      replyToMessageId: "answer-message",
      messageThreadId: null,
      senderUserId: event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "好的 谢谢",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    const reopened = harness.store.appendMessage({
      threadId: thread.id,
      eventId: thanks.id,
      relation: "reopen",
      questionFragment: thanks.safeText,
      settleAt: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(reopened).toMatchObject({ status: "collecting" })
    expect(harness.database.prepare(`SELECT human_priority_state FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "none" })

    const followupSendMessage = vi.fn(async () => "priority-ignore-handoff")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const followupWorker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: { ...answerDecision(), decision: "ignore", answer: "", reason: "运营仅确认收到并致谢" },
      sendMessage: followupSendMessage,
      sendSupportAlert,
    })

    await followupWorker.runDueOnce(new Date())

    expect(followupSendMessage).toHaveBeenCalledTimes(1)
    expect(String((followupSendMessage.mock.calls as unknown[][])[0]?.[2]))
      .toBe(generatedTechnicalAvailabilityReply)
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "escalated" })
    expect(harness.database.prepare(`SELECT human_priority_state FROM support_threads WHERE id=?`)
      .get(thread.id)).toEqual({ human_priority_state: "none" })
    expect(harness.database.readReplies("WHERE r.thread_id=? ORDER BY r.created_at", [thread.id])).toEqual([
      expect.objectContaining({ status: "replied", decision: "reply" }),
      expect.objectContaining({
        status: "escalated",
        decision: "escalate",
        answer: generatedTechnicalAvailabilityReply,
        errorCode: "answer_ignored_after_human_priority",
      }),
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

  it("progress 已发送但严格拒绝到达前版本被 supersede 时仍保持零发送", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "strict-reject-superseded")
    seedProgressDelivery(harness, thread, "sent")
    const snapshot = seedCodeSnapshot(harness)
    let signalAgentStarted!: () => void
    let rejectGeneration!: (error: unknown) => void
    const agentStarted = new Promise<void>((resolve) => { signalAgentStarted = resolve })
    const generated = new Promise<AnswerDecision>((_resolve, reject) => { rejectGeneration = reject })
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        signalAgentStarted()
        return generated
      },
      sendMessage,
      sendSupportAlert,
    })

    const running = worker.runDueOnce(new Date())
    await Promise.race([
      agentStarted,
      running.then(() => { throw new Error("worker 在 agent 启动前结束") }),
    ])
    const followup = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "strict-reject-superseded-followup",
      replyToMessageId: thread.anchorMessageId,
      messageThreadId: null,
      senderUserId: "30001",
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "补充新的订单信息",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    harness.store.appendMessage({
      threadId: thread.id,
      eventId: followup.id,
      relation: "supplement",
      questionFragment: followup.safeText,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })
    worker.cancelClosed()
    rejectGeneration(withPipelineAudit(
      new SupportModelOutputRejectedError(["严格审核拒绝发送"]),
      rejectedPipelineAudit("superseded-audit-secret"),
    ))
    await running

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "superseded" }),
    ])
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "collecting", revision: 2 })
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

  it("通用 progress 已发送后所有非正常终态都复用持久升级并 exactly-once AI 自然收口", async () => {
    const scenarios: Array<{
      label: string
      errorCode: string
      decision: AnswerDecision | (() => Promise<AnswerDecision>)
    }> = [
      {
        label: "ignore",
        errorCode: "answer_ignored_after_human_priority",
        decision: { ...answerDecision(), decision: "ignore", answer: "", reason: "无需回复" },
      },
      {
        label: "timeout",
        errorCode: "answer_model_timeout",
        decision: async () => { throw new CodexExecutionTimeoutError() },
      },
      {
        label: "ordinary-model-failure",
        errorCode: "answer_model_failed",
        decision: async () => { throw new Error("模型连接失败") },
      },
      {
        label: "code-snapshot-unavailable",
        errorCode: "code_snapshot_unavailable",
        decision: async () => { throw new ProjectCodeSyncUnavailableError(randomUUID(), codeSyncFailure()) },
      },
      {
        label: "investigation-runtime-failure",
        errorCode: "investigation_runtime_failed",
        decision: async () => { throw new SupportCodeSyncRuntimeError(new Error("只读排查失败")) },
      },
    ]

    for (const scenario of scenarios) {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `progress-terminal-${scenario.label}`)
      seedProgressDelivery(harness, thread, "sent")
      const snapshot = seedCodeSnapshot(harness)
      const order: string[] = []
      const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
        order.push(`operator:${text}`)
        return `terminal-${scenario.label}`
      })
      const sendSupportAlert = vi.fn(async () => {
        order.push("technical")
        return { status: "sent" as const, summary: "sent", errorType: null }
      })
      const sendCodeSyncFailure = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => snapshot,
        decision: scenario.decision,
        sendMessage,
        sendSupportAlert,
        sendCodeSyncFailure,
      })

      await worker.runDueOnce(new Date())
      await worker.runDueOnce(new Date(Date.now() + 1_000))

      expect(order, scenario.label).toEqual([
        "technical",
        `operator:${generatedTechnicalAvailabilityReply}`,
      ])
      expect(sendSupportAlert, scenario.label).toHaveBeenCalledTimes(1)
      expect(sendMessage, scenario.label).toHaveBeenCalledTimes(1)
      expect(sendCodeSyncFailure, scenario.label).not.toHaveBeenCalled()
      expect(harness.store.getThread(thread.id).status, scenario.label).toBe("escalated")
      expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id]), scenario.label).toEqual([
        expect.objectContaining({
          status: "escalated",
          decision: "escalate",
          answer: generatedTechnicalAvailabilityReply,
          errorCode: scenario.errorCode,
        }),
      ])
    }
  })

  it("worker 先捕获 hard deadline 上的 provider/snapshot/runtime/DLP 失败时统一沿原 reply AI 自然收口", async () => {
    const scenarios: Array<{ label: string; error: () => Error }> = [
      {
        label: "provider-timeout",
        error: () => new ModelExecutionError("provider_timeout", "模型厂商超时"),
      },
      {
        label: "snapshot-unavailable",
        error: () => new ProjectCodeSyncUnavailableError(randomUUID(), codeSyncFailure()),
      },
      {
        label: "investigation-runtime",
        error: () => new SupportCodeSyncRuntimeError(new Error("只读排查运行失败")),
      },
      {
        label: "dlp-rejected",
        error: () => new SupportModelOutputRejectedError(["出站安全校验阻断"]),
      },
    ]

    for (const scenario of scenarios) {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `hard-deadline-worker-${scenario.label}`)
      seedProgressDelivery(harness, thread, "sent")
      const snapshot = seedCodeSnapshot(harness)
      const order: string[] = []
      const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
        order.push(`operator:${text}`)
        return `hard-deadline-${scenario.label}`
      })
      const sendSupportAlert = vi.fn(async () => {
        order.push("technical")
        return { status: "sent" as const, summary: "sent", errorType: null }
      })
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => snapshot,
        decision: async () => {
          harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?")
            .run("2000-01-01T00:00:00.000Z", thread.id)
          throw scenario.error()
        },
        sendMessage,
        sendSupportAlert,
      })

      await worker.runDueOnce(new Date())
      await worker.runDueOnce(new Date(Date.now() + 1_000))

      expect(order, scenario.label).toEqual([
        "technical",
        `operator:${generatedTechnicalAvailabilityReply}`,
      ])
      expect(sendSupportAlert, scenario.label).toHaveBeenCalledTimes(1)
      expect(sendMessage, scenario.label).toHaveBeenCalledTimes(1)
      expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id]), scenario.label).toEqual([
        expect.objectContaining({
          status: "escalated",
          decision: "escalate",
          errorCode: "answer_hard_deadline",
          answer: generatedTechnicalAvailabilityReply,
        }),
      ])
    }
  })

  it.each<[string, () => Error]>([
    ["严格审核拒绝", () => new SupportModelOutputRejectedError(["第二轮审核仍未通过"])],
    ["结构化输出无效", () => new ModelExecutionError("structured_output_invalid", "回答结构无效")],
  ])("%s 携带流水线审计时即使 investigate 抛错也持久化脱敏审计", async (_label, createError) => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, `audit-error-${randomUUID()}`)
    const snapshot = seedCodeSnapshot(harness)
    const secret = "audit-worker-secret"
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        throw withPipelineAudit(createError(), rejectedPipelineAudit(secret))
      },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    const row = harness.database.prepare(`SELECT audit.evidence_packet_json,audit.baseline_answer,audit.fallback_reason
      FROM reply_generation_audits audit
      JOIN support_replies reply ON reply.id=audit.support_reply_id
      WHERE reply.thread_id=?`).get(thread.id)
    expect(row).toBeTruthy()
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(JSON.stringify(row)).toContain("[已脱敏]")
  })

  it("错误携带畸形 pipelineAudit 时忽略审计并保留原拒绝错误收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "malformed-pipeline-audit")
    const snapshot = seedCodeSnapshot(harness)
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        throw Object.assign(new SupportModelOutputRejectedError(["原始严格审核拒绝"]), {
          pipelineAudit: { version: "unexpected-version" },
        })
      },
    })

    await worker.runDueOnce(new Date())

    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM reply_generation_audits audit
      JOIN support_replies reply ON reply.id=audit.support_reply_id
      WHERE reply.thread_id=?`).get(thread.id)).toEqual({ count: 0 })
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "answer_model_failed",
        decisionReason: expect.stringContaining("SupportModelOutputRejectedError"),
      }),
    ])
  })

  it.each(["sending", "sent", "unknown", "failed"] as const)(
    "普通 progress 已为 %s 后严格拒绝会各一次转技术并发送AI 失败收口",
    async (progressStatus) => {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `progress-rejected-${progressStatus}`)
      seedProgressDelivery(harness, thread, progressStatus)
      const snapshot = seedCodeSnapshot(harness)
      const order: string[] = []
      const sentTexts: string[] = []
      const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
        order.push("operator")
        sentTexts.push(text)
        return `closeout-${progressStatus}`
      })
      const sendSupportAlert = vi.fn(async () => {
        order.push("technical")
        return { status: "sent" as const, summary: "sent", errorType: null }
      })
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => snapshot,
        decision: async () => {
          throw withPipelineAudit(
            new SupportModelOutputRejectedError(["严格审核拒绝发送"]),
            rejectedPipelineAudit("progress-audit-secret"),
          )
        },
        sendMessage,
        sendSupportAlert,
      })

      await worker.runDueOnce(new Date())
      await worker.runDueOnce(new Date(Date.now() + 1_000))

      expect(order).toEqual(["technical", "operator"])
      expect(sendSupportAlert).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sentTexts).toEqual([generatedTechnicalAvailabilityReply])
      expect(harness.store.getThread(thread.id).status).toBe("escalated")
      expect(harness.store.handoffSource(thread.id)).toBe("failure_after_progress")
      expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
        expect.objectContaining({
          status: "escalated",
          decision: "escalate",
          answer: generatedTechnicalAvailabilityReply,
          errorCode: "answer_model_failed",
        }),
      ])
      expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_reply_alert_deliveries delivery
        JOIN support_replies reply ON reply.id=delivery.reply_id
        WHERE reply.thread_id=? AND delivery.alert_kind='escalation'`).get(thread.id)).toEqual({ count: 1 })
    },
  )

  it("普通 progress 已发送时结构化错误仍先重试一次，第二次失败才AI 自然收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "progress-structured-retry")
    seedProgressDelivery(harness, thread, "sent")
    const snapshot = seedCodeSnapshot(harness)
    let attempts = 0
    const sendMessage = vi.fn(async () => "structured-closeout")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        attempts += 1
        throw withPipelineAudit(
          new ModelExecutionError("structured_output_invalid", "回答结构无效"),
          rejectedPipelineAudit(`structured-retry-secret-${attempts}`),
        )
      },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())
    expect(harness.store.getThread(thread.id).status).toBe("collecting")
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()

    await worker.runDueOnce(new Date(Date.now() + 1_000))

    expect(attempts).toBe(2)
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", errorCode: "structured_output_invalid" }),
      expect.objectContaining({ status: "escalated", errorCode: "structured_output_invalid" }),
    ]))
  })

  it("人工优先 progress 已发送时结构化错误也先重试一次且仅第二次AI 自然收口", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "priority-structured-retry")
    markHumanPriorityClaimed(harness, thread, event.id)
    const snapshot = seedCodeSnapshot(harness)
    let attempts = 0
    const sendMessage = vi.fn(async () => "priority-structured-closeout")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        attempts += 1
        throw withPipelineAudit(
          new ModelExecutionError("structured_output_invalid", "回答结构无效"),
          rejectedPipelineAudit(`priority-structured-secret-${attempts}`),
        )
      },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(attempts).toBe(1)
    expect(harness.store.getThread(thread.id).status).toBe("collecting")
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()

    await worker.runDueOnce(new Date(Date.now() + 1_000))

    expect(attempts).toBe(2)
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(generatedTechnicalAvailabilityReply)
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
  })

  it("finalizer 事务返回时崩溃也已持久化 prepared escalation 并在恢复后 exactly-once 收口", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "progress-finalizer-crash")
    const notificationId = seedProgressDelivery(harness, thread, "pending")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "fixed-closeout")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        throw withPipelineAudit(
          new SupportModelOutputRejectedError(["严格审核拒绝发送"]),
          rejectedPipelineAudit("progress-race-secret"),
        )
      },
      sendMessage,
      sendSupportAlert,
    })
    const internals = worker as unknown as {
      hasStartedProgress(threadId: string): boolean
      finalizeRejectedGeneration(...args: unknown[]): "failed" | "progress" | "stale"
    }
    const hasStartedProgress = internals.hasStartedProgress.bind(worker)
    let progressInjected = false
    internals.hasStartedProgress = (threadId: string) => {
      if (!progressInjected) {
        progressInjected = true
        expect(harness.store.claimNotificationSending(notificationId)?.status).toBe("sending")
      }
      return hasStartedProgress(threadId)
    }
    const finalize = internals.finalizeRejectedGeneration.bind(worker)
    internals.finalizeRejectedGeneration = (...args: unknown[]) => {
      const outcome = finalize(...args)
      if (outcome === "progress") throw new Error("模拟 finalizer 事务提交后进程中断")
      return outcome
    }

    await expect(worker.runDueOnce(new Date())).rejects.toThrow("模拟 finalizer 事务提交后进程中断")

    const prepared = harness.replies.findPreparedTechnicalEscalation(thread.id, thread.revision)
    expect(prepared).toMatchObject({
      status: "generating",
      decision: "escalate",
      answer: TECHNICAL_AVAILABILITY_REPLY_PENDING,
    })
    expect(harness.database.prepare(`SELECT status FROM support_thread_notifications WHERE id=?`)
      .get(notificationId)).toEqual({ status: "sending" })
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()

    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, prepared!.id)
    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    const recovery = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      sendMessage,
      sendSupportAlert,
    })
    await recovery.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))
    await recovery.runDueOnce(new Date("2026-08-11T00:00:02.000Z"))

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String((sendMessage.mock.calls as unknown[][])[0]?.[2])).toBe(generatedTechnicalAvailabilityReply)
    expect(harness.store.getThread(thread.id).status).toBe("escalated")
  })

  it("hard deadline prepared 后进程崩溃可由 stale recovery 沿原 reply exactly-once 完成两段发送", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-recovery")
    const claimAt = new Date().toISOString()
    const claimed = harness.store.claimDue(claimAt)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(claimAt, thread.id)

    expect(harness.store.claimDueTimeout(claimAt)).toMatchObject({
      outcome: "prepared_escalation",
      replyId: reply.id,
    })
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM support_reply_alert_deliveries
      WHERE reply_id=?`).get(reply.id)).toEqual({ count: 0 })
    const staleAt = new Date(Date.parse(claimAt) - 2 * 60 * 60_000).toISOString()
    const staleBefore = new Date(Date.parse(claimAt) - 60 * 60_000).toISOString()
    const recoveredAt = new Date(Date.parse(claimAt) + 1_000).toISOString()
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)
    harness.store.recoverStaleGenerating(recoveredAt, staleBefore)

    const order: string[] = []
    const sendMessage = vi.fn(async (_accountId: string | null, _chatId: string, text: string) => {
      order.push(`operator:${text}`)
      return "hard-deadline-recovered"
    })
    const sendSupportAlert = vi.fn(async () => {
      order.push("technical")
      return { status: "sent" as const, summary: "sent", errorType: null }
    })
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendMessage, sendSupportAlert,
    })

    await worker.runDueOnce(new Date(Date.parse(recoveredAt) + 1_000))
    await worker.runDueOnce(new Date(Date.parse(recoveredAt) + 2_000))

    expect(order).toEqual([
      "technical",
      `operator:${generatedTechnicalAvailabilityReply}`,
    ])
    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.replies.getDetail(reply.id)).toMatchObject({ status: "escalated" })
  })

  it("hard deadline prepared 后补充仅审计且同 reply 恢复 exactly-once 两段发送", async () => {
    const harness = await createBaseHarness()
    const { event, thread } = createQuestion(harness, "hard-deadline-superseded")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)
    expect(harness.store.claimDueTimeout(now)).toMatchObject({ outcome: "prepared_escalation", replyId: reply.id })

    const followup = harness.store.recordEvent({
      groupId: harness.group.id,
      accountId: harness.group.accountId,
      telegramMessageId: "hard-deadline-superseded-followup",
      replyToMessageId: event.telegramMessageId,
      messageThreadId: null,
      senderUserId: event.senderUserId,
      senderUsername: null,
      senderDisplayName: "运营",
      senderRole: null,
      text: "补充新的有效订单信息",
      attachmentSummary: "",
      routeStatus: "received",
      skipReason: null,
    }).event
    expect(harness.store.appendMessage({
      threadId: thread.id,
      eventId: followup.id,
      relation: "supplement",
      questionFragment: followup.safeText,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })).toBeNull()
    expect(harness.store.appendAuditMessage({
      threadId: thread.id,
      eventId: followup.id,
      relation: "supplement",
      questionFragment: followup.safeText,
      settleAt: new Date(Date.now() + 30_000).toISOString(),
    })).toMatchObject({ status: "generating", revision: thread.revision })
    const sendMessage = vi.fn(async () => "hard-deadline-terminal-reply")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendMessage, sendSupportAlert,
    }) as SupportAnswerWorker & { resumeHardDeadline(threadId: string, inputRevision: number): Promise<void> }

    await worker.resumeHardDeadline(thread.id, thread.revision)

    expect(sendSupportAlert).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(harness.replies.getDetail(reply.id).status).toBe("escalated")
    expect(harness.store.getThread(thread.id)).toMatchObject({ status: "escalated", revision: thread.revision })
    expect(harness.store.getEvent(followup.id)).toMatchObject({
      routeStatus: "routed",
      skipReason: "handoff_terminal:audit_only",
    })
  })

  it("hard deadline prepared 后来源群被禁用时确定性失败关闭且保持零 Telegram", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-disabled-group")
    const now = new Date().toISOString()
    const claimed = harness.store.claimDue(now)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(now, thread.id)
    expect(harness.store.claimDueTimeout(now)).toMatchObject({ outcome: "prepared_escalation", replyId: reply.id })
    harness.database.prepare("UPDATE telegram_groups SET enabled=0 WHERE id=?").run(harness.group.id)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness), sendMessage, sendSupportAlert,
    })

    await worker.resumeHardDeadline(thread.id, thread.revision)
    await worker.resumeHardDeadline(thread.id, thread.revision)

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "failed",
      decision: "escalate",
      errorCode: "answer_hard_deadline",
    })
  })

  it("hard deadline prepared 崩溃恢复后即使来源群禁用也关闭 reply 与 thread", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "hard-deadline-recovered-disabled-group")
    const claimAt = new Date().toISOString()
    const claimed = harness.store.claimDue(claimAt)!
    const reply = seedGeneratingReply(harness, claimed.thread)
    seedProgressDelivery(harness, thread, "sent")
    harness.database.prepare("UPDATE support_threads SET hard_deadline_at=? WHERE id=?").run(claimAt, thread.id)
    expect(harness.store.claimDueTimeout(claimAt)).toMatchObject({ outcome: "prepared_escalation", replyId: reply.id })
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)
    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")
    harness.database.prepare("UPDATE telegram_groups SET enabled=0 WHERE id=?").run(harness.group.id)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({
      status: "sent" as const, summary: "sent", errorType: null,
    }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => seedCodeSnapshot(harness),
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date("2026-08-11T00:00:01.000Z"))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.replies.getDetail(reply.id)).toMatchObject({
      status: "failed",
      decision: "escalate",
      errorCode: "answer_hard_deadline",
    })
    expect(harness.store.getThread(thread.id).status).toBe("closed")
  })

  it.each(["technical", "feature"] as const)(
    "%s prepared 崩溃恢复后来源群禁用会显式失败且不留下 generating reply",
    async (kind) => {
      const harness = await createBaseHarness()
      const { thread } = createQuestion(harness, `prepared-disabled-${kind}`)
      const claimed = harness.store.claimDue(new Date().toISOString())!
      const reply = seedGeneratingReply(harness, claimed.thread)
      const decision = kind === "feature" ? featureRequestDecision() : escalationDecision()
      expect(harness.replies.prepareTechnicalEscalation(reply.id, {
        answer: decision.answer,
        errorCode: kind === "feature" ? "feature_request_prepared" : null,
        decisionReason: decision.reason,
        decisionConfidence: decision.confidence,
      }, kind === "feature" ? "feature_request" : "technical_change")).not.toBeNull()
      const recoveredAt = new Date()
      const staleAt = new Date(recoveredAt.getTime() - 2 * 60 * 60_000).toISOString()
      const staleBefore = new Date(recoveredAt.getTime() - 60 * 60_000).toISOString()
      harness.database.prepare("UPDATE support_threads SET updated_at=? WHERE id=?").run(staleAt, thread.id)
      harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)
      harness.store.recoverStaleGenerating(recoveredAt.toISOString(), staleBefore)
      harness.database.prepare("UPDATE telegram_groups SET enabled=0 WHERE id=?").run(harness.group.id)
      const sendMessage = vi.fn(async () => "must-not-send")
      const sendSupportAlert = vi.fn(async () => ({
        status: "sent" as const, summary: "sent", errorType: null,
      }))
      const sendTransientFeatureRequest = vi.fn(async () => ({
        status: "sent" as const, summary: "sent", errorType: null,
      }))
      const worker = createWorker(harness, {
        readCurrentSnapshot: () => seedCodeSnapshot(harness),
        sendMessage,
        sendSupportAlert,
        sendTransientFeatureRequest,
      })

      await worker.runDueOnce(new Date(recoveredAt.getTime() + 1_000))

      expect(sendMessage).not.toHaveBeenCalled()
      expect(sendSupportAlert).not.toHaveBeenCalled()
      expect(sendTransientFeatureRequest).not.toHaveBeenCalled()
      expect(harness.replies.getDetail(reply.id)).toMatchObject({
        status: "failed",
        decision: "escalate",
        errorCode: "prepared_delivery_source_unavailable",
      })
      expect(harness.store.getThread(thread.id).status).toBe("closed")
    },
  )

  it("没有 progress 的严格拒绝只保存失败与审计，不伪装发送或升级", async () => {
    const harness = await createBaseHarness()
    const { thread } = createQuestion(harness, "rejected-without-progress")
    const snapshot = seedCodeSnapshot(harness)
    const sendMessage = vi.fn(async () => "must-not-send")
    const sendSupportAlert = vi.fn(async () => ({ status: "sent" as const, summary: "sent", errorType: null }))
    const worker = createWorker(harness, {
      readCurrentSnapshot: () => snapshot,
      decision: async () => {
        throw withPipelineAudit(
          new SupportModelOutputRejectedError(["严格审核拒绝发送"]),
          rejectedPipelineAudit("no-progress-secret"),
        )
      },
      sendMessage,
      sendSupportAlert,
    })

    await worker.runDueOnce(new Date())

    expect(sendMessage).not.toHaveBeenCalled()
    expect(sendSupportAlert).not.toHaveBeenCalled()
    expect(harness.database.readReplies("WHERE r.thread_id=?", [thread.id])).toEqual([
      expect.objectContaining({ status: "failed", decision: "pending", answer: "" }),
    ])
    expect(harness.database.prepare(`SELECT COUNT(*) AS count FROM telegram_output_ownership
      WHERE thread_id=?`).get(thread.id)).toEqual({ count: 0 })
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
      messageIntent: "non_actionable" as const,
      questionFragment: "有人在处理吗",
      issues: null,
      investigationEffect: null,
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
    harness.store.completeNotification(first.id, "progress-3302", "稍等", now)
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

  it.each(["notification", "ownership"] as const)(
    "旧版本 %s 状态虽为 failed 但已有持久消息 ID 时，新版本通用 progress 仍被抑制",
    async (source) => {
      const harness = await createBaseHarness()
      const { event, thread } = createQuestion(harness, `failed-progress-id-${source}`)
      const now = new Date().toISOString()
      harness.store.claimDue(now, 0)
      if (source === "notification") seedProgressDelivery(harness, thread, "failed")
      else seedFailedProgressOwnership(harness, thread)
      const supplement = harness.store.recordEvent({
        groupId: harness.group.id,
        accountId: harness.group.accountId,
        telegramMessageId: `failed-progress-id-${source}-followup`,
        replyToMessageId: event.telegramMessageId,
        messageThreadId: null,
        senderUserId: event.senderUserId,
        senderUsername: null,
        senderDisplayName: "运营",
        senderRole: null,
        text: "补充新的排查信息",
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
      expect(harness.store.claimDue(now, 0)?.inputRevision).toBe(2)

      expect(harness.store.claimDueProgress(now)).toBeNull()
    },
  )

  it.each(["notification", "ownership"] as const)(
    "旧版本 %s 状态虽为 failed 但已有持久消息 ID 时，新版本人工优先 progress 仍被抑制",
    async (source) => {
      const harness = await createBaseHarness()
      const { event, thread } = createQuestion(harness, `failed-priority-id-${source}`)
      if (source === "notification") seedProgressDelivery(harness, thread, "failed")
      else seedFailedProgressOwnership(harness, thread)
      const supplementAt = new Date().toISOString()
      const supplement = harness.store.recordEvent({
        groupId: harness.group.id,
        accountId: harness.group.accountId,
        telegramMessageId: `failed-priority-id-${source}-followup`,
        replyToMessageId: event.telegramMessageId,
        messageThreadId: null,
        senderUserId: event.senderUserId,
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
    },
  )

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
    harness.store.completeNotification(progress.id, "progress-3306", "稍等", firstAt)
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
      cancellation: { cancel: () => false, cancelClosed: () => 0, resumeHardDeadline: async () => undefined },
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
          expect(harness.store.claimHandoff(id, "technical_change")).toBe(true)
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
    expect(harness.store.claimHandoff(reply.id, "technical_change")).toBe(true)
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
    expect(harness.store.claimHandoff(reply.id, "technical_change")).toBe(true)
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
    }, "technical_change")).not.toBeNull()
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
    }, "technical_change")).not.toBeNull()
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
    expect(harness.store.claimHandoff(reply.id, "technical_change")).toBe(true)
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
    expect(harness.store.claimHandoff(reply.id, "technical_change")).toBe(true)
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
      }, "technical_change")).not.toBeNull()
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
    expect(harness.store.claimHandoff(reply.id, "technical_change")).toBe(true)
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
      }, "technical_change")).not.toBeNull()
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

  it.each<{
    kind: "reply" | "feature"
    ownership: "none" | "sending" | "unknown" | "sent" | "failed"
  }>([
    { kind: "reply", ownership: "none" },
    { kind: "reply", ownership: "sending" },
    { kind: "reply", ownership: "unknown" },
    { kind: "reply", ownership: "sent" },
    { kind: "reply", ownership: "failed" },
    { kind: "feature", ownership: "none" },
    { kind: "feature", ownership: "sending" },
    { kind: "feature", ownership: "unknown" },
    { kind: "feature", ownership: "sent" },
    { kind: "feature", ownership: "failed" },
  ])("closed thread 的 $kind sending reply 按 ownership=$ownership 保留确定结果", async ({ kind, ownership }) => {
    const recoveredStatuses: ReplyStatus[] = []
    const harness = await createBaseHarness((event) => { recoveredStatuses.push(event.status) })
    const { thread } = createQuestion(harness, `closed-final-recovery-${kind}-${ownership}`)
    const claimed = harness.store.claimDue(new Date().toISOString())!
    const reply = seedGeneratingReply(harness, claimed.thread)
    const decision = kind === "feature" ? featureRequestDecision() : answerDecision()
    if (kind === "feature") {
      expect(harness.replies.prepareTechnicalEscalation(reply.id, {
        answer: decision.answer,
        errorCode: "feature_request_prepared",
        decisionReason: decision.reason,
        decisionConfidence: decision.confidence,
      }, "feature_request")).not.toBeNull()
      seedReplyOutputOwnership(harness, thread, reply.id, "technical_alert:feature_request", "sent")
    }
    expect(harness.replies.claimSending(reply.id, {
      answer: decision.answer,
      errorCode: kind === "feature" ? "feature_request_prepared" : null,
      decisionReason: decision.reason,
      decisionConfidence: decision.confidence,
    })).not.toBeNull()
    if (ownership !== "none") seedReplyOutputOwnership(harness, thread, reply.id, "support_reply", ownership)
    expect(harness.store.closeThread(thread.id, "人工客服", "人工已接管").changed).toBe(true)
    const staleAt = "2026-08-10T00:00:00.000Z"
    harness.database.prepare("UPDATE support_replies SET updated_at=? WHERE id=?").run(staleAt, reply.id)
    harness.database.prepare(`UPDATE telegram_output_ownership SET updated_at=?
      WHERE reply_id=?`).run(staleAt, reply.id)

    harness.store.recoverStaleGenerating("2026-08-11T00:00:00.000Z", "2026-08-10T01:00:00.000Z")

    const recovered = harness.replies.getDetail(reply.id)
    expect(recoveredStatuses).toContain(recovered.status)
    expect(harness.store.getThread(thread.id).status).toBe("closed")
    if (ownership === "none") {
      expect(recovered).toMatchObject({ status: "superseded", operatorDeliveryStatus: null })
      expect(recovered.errorCode).not.toBe("delivery_state_unknown")
    } else if (ownership === "sent") {
      expect(recovered).toMatchObject({
        status: kind === "feature" ? "escalated" : "replied",
        decision: kind === "feature" ? "escalate" : "reply",
        operatorDeliveryStatus: "sent",
        errorCode: null,
      })
    } else {
      expect(recovered).toMatchObject({
        status: "failed",
        operatorDeliveryStatus: ownership === "failed" ? "failed" : "uncertain",
        errorCode: ownership === "failed" ? "support_delivery_failed" : "delivery_state_unknown",
      })
    }
  })

  it("普通回复 claim 后 ownership 尚未创建即人工接管时安全 supersede 且保留 observation", async () => {
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
      status: "superseded",
      error_code: null,
      operator_delivery_status: null,
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
