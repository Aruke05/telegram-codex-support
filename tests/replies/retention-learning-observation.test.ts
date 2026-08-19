import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import type { ReferenceProposalResult } from "../../src/codex/schemas.js"
import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import type { ReferenceAgentInput } from "../../src/learning/reference-agent.js"
import { OperatorStyleService } from "../../src/learning/operator-style-service.js"
import { ReferenceLearningWorker } from "../../src/learning/reference-worker.js"
import { RetentionService } from "../../src/replies/retention-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"
import type { RuntimeGroup } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import { LearningSourceObserver } from "../../src/support/learning-source-observer.js"
import { LearningSourceStore } from "../../src/support/learning-source-store.js"
import { SupportThreadLifecycleService } from "../../src/support/thread-lifecycle-service.js"
import { SupportThreadStore } from "../../src/support/thread-store.js"

const oldAt = "2026-01-01T00:00:00.000Z"
const recentAt = "2026-08-10T00:00:00.000Z"
const retentionNow = new Date("2026-08-11T00:00:00.000Z")

function seedCatalog(database: RuntimeDatabase): {
  projectId: string
  serviceId: string
  associatedGroup: RuntimeGroup
  unlinkedGroup: RuntimeGroup
} {
  const projectId = randomUUID()
  const serviceId = randomUUID()
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "retention-project", "项目", "", 1, "default", oldAt, oldAt)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "retention-service", "服务", "", "Asia/Shanghai", null, "main", 1, oldAt, oldAt,
  )
  const insertGroup = database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const associatedGroupId = randomUUID()
  const unlinkedGroupId = randomUUID()
  insertGroup.run(
    associatedGroupId, "associated-group", "关联群", "-10001", null, projectId, serviceId, 1, "bot", "all",
    "telegram", "[]", null, null, "database", "default", "support", oldAt, oldAt,
  )
  insertGroup.run(
    unlinkedGroupId, "unlinked-group", "未关联群", "-10002", null, projectId, serviceId, 1, "bot", "all",
    "telegram", "[]", null, null, "database", "default", "support", oldAt, oldAt,
  )
  database.insertRole({
    id: randomUUID(),
    telegramUserId: "20001",
    username: "trusted_operator",
    displayName: "可信运营",
    role: "operator",
    canCorrect: false,
    enabled: true,
    learningSourceEnabled: true,
    createdAt: oldAt,
    updatedAt: oldAt,
  })
  const groups = database.readGroups()
  return {
    projectId,
    serviceId,
    associatedGroup: groups.find((group) => group.id === associatedGroupId)!,
    unlinkedGroup: groups.find((group) => group.id === unlinkedGroupId)!,
  }
}

function createQuestionThread(input: {
  store: SupportThreadStore
  group: RuntimeGroup
  projectId: string
  serviceId: string
  messageId: string
  eventCreatedAt?: string
  latestMessageAt?: string
}): { eventId: string; threadId: string } {
  const eventCreatedAt = input.eventCreatedAt ?? oldAt
  const latestMessageAt = input.latestMessageAt ?? eventCreatedAt
  const event = input.store.recordEvent({
    groupId: input.group.id,
    accountId: input.group.accountId,
    telegramMessageId: input.messageId,
    replyToMessageId: null,
    messageThreadId: null,
    senderUserId: `30${input.messageId}`,
    senderUsername: null,
    senderDisplayName: "用户",
    senderRole: null,
    text: `用户问题 ${input.messageId}`,
    attachmentSummary: "",
    routeStatus: "received",
    skipReason: null,
    createdAt: eventCreatedAt,
  }).event
  const batchId = randomUUID()
  input.store.assignEventBatch(event.id, batchId)
  const thread = input.store.createThread({
    groupId: input.group.id,
    projectId: input.projectId,
    serviceId: input.serviceId,
    originBatchId: batchId,
    settleAt: latestMessageAt,
    anchorMessageId: input.messageId,
    latestMessageAt,
    summary: event.safeText,
    originEventId: event.id,
    questionFragment: event.safeText,
  }).thread
  return { eventId: event.id, threadId: thread.id }
}

async function createReferenceEvent(input: {
  store: SupportThreadStore
  observer: LearningSourceObserver
  group: RuntimeGroup
  attachmentRoot: string
  messageId: string
  text: string
  createdAt: string
  replyToMessageId?: string
}): Promise<{ eventId: string; observationId: string; attachmentPath: string }> {
  const attachmentPath = path.join(input.attachmentRoot, `${input.messageId}.txt`)
  await writeFile(attachmentPath, `附件原文 ${input.messageId}`, "utf8")
  const event = input.store.recordEvent({
    groupId: input.group.id,
    accountId: input.group.accountId,
    telegramMessageId: input.messageId,
    replyToMessageId: input.replyToMessageId ?? null,
    messageThreadId: null,
    senderUserId: "20001",
    senderUsername: "trusted_operator",
    senderDisplayName: "可信运营",
    senderRole: "operator",
    text: input.text,
    attachmentSummary: `附件 ${input.messageId}`,
    routeStatus: "role_skipped",
    skipReason: "已配置角色普通消息只留审计",
    createdAt: input.createdAt,
  }).event
  input.store.recordAttachments(event.id, [{
    name: `${input.messageId}.txt`,
    mimeType: "text/plain",
    size: 32,
    kind: "text",
    localPath: attachmentPath,
    extractedText: `附件原文 ${input.messageId}`,
  }])
  const observation = input.observer.observe(event)
  if (!observation) throw new Error("真实人工参考消息未形成观察")
  return { eventId: event.id, observationId: observation.id, attachmentPath }
}

function noopReferenceProposals(input: ReferenceAgentInput): ReferenceProposalResult {
  return {
    proposals: input.threadContexts.map((context) => ({
      classification: "general",
      action: "noop",
      title: "保留期竞态测试",
      content: "只验证运行中的参考分类不会被保留期清理打断",
      scope: input.target.scope,
      region: input.target.region,
      branch: input.target.branch,
      risk: "low",
      confidence: 0.95,
      evidenceObservationIds: [context.observationId],
      codeEvidencePaths: [],
      reason: "真实人工参考观察的保留期竞态回归",
    })),
  }
}

describe("人工参考消息保留期", () => {
  it("分页删除真实关联、歧义和未关联观察的旧原文与附件，并保留近期或线程关联事件", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "retention-learning-observation-"))
    const attachmentRoot = path.join(directory, "attachments")
    await mkdir(attachmentRoot)
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    try {
      const catalog = seedCatalog(database)
      const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
      const observations = new LearningSourceStore(database)
      const observer = new LearningSourceObserver({
        database,
        threads: store,
        observations,
        materializePendingBatch: () => null,
        lifecycle: new SupportThreadLifecycleService(store, {
          cancel: () => false,
          cancelClosed: () => 0,
        }),
      })

      createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-associated",
      })
      const associated = await createReferenceEvent({
        store,
        observer,
        group: catalog.associatedGroup,
        attachmentRoot,
        messageId: "reference-associated",
        text: "关联人工参考原文",
        createdAt: "2026-01-01T00:01:00.000Z",
        replyToMessageId: "question-associated",
      })
      store.recordAttachments(associated.eventId, [{
        name: "reference-associated-metadata.txt",
        mimeType: "text/plain",
        size: 16,
        kind: "text",
        localPath: null,
        extractedText: "仅有附件元数据的原文",
      }])

      createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-ambiguous-a",
        eventCreatedAt: "2026-01-01T00:02:00.000Z",
      })
      createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-ambiguous-b",
        eventCreatedAt: "2026-01-01T00:03:00.000Z",
      })
      const ambiguous = await createReferenceEvent({
        store,
        observer,
        group: catalog.associatedGroup,
        attachmentRoot,
        messageId: "reference-ambiguous",
        text: "歧义人工参考原文",
        createdAt: "2026-01-01T00:04:00.000Z",
      })
      const unlinked = await createReferenceEvent({
        store,
        observer,
        group: catalog.unlinkedGroup,
        attachmentRoot,
        messageId: "reference-unlinked",
        text: "未关联人工参考原文",
        createdAt: "2026-01-01T00:05:00.000Z",
      })
      const recent = await createReferenceEvent({
        store,
        observer,
        group: catalog.unlinkedGroup,
        attachmentRoot,
        messageId: "reference-recent",
        text: "保留期内人工参考原文",
        createdAt: recentAt,
      })
      const retainedThreadEvent = createQuestionThread({
        store,
        group: catalog.unlinkedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "old-event-retained-thread",
        eventCreatedAt: "2026-01-01T00:06:00.000Z",
        latestMessageAt: recentAt,
      })
      const retainedThreadAttachment = path.join(attachmentRoot, "retained-thread.txt")
      await writeFile(retainedThreadAttachment, "线程仍引用的旧附件", "utf8")
      store.recordAttachments(retainedThreadEvent.eventId, [{
        name: "retained-thread.txt",
        mimeType: "text/plain",
        size: 24,
        kind: "text",
        localPath: retainedThreadAttachment,
        extractedText: "线程仍引用的旧附件",
      }])

      expect(observations.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: associated.observationId, associationReason: "direct_question", threadId: expect.any(String) }),
        expect.objectContaining({ id: ambiguous.observationId, associationReason: "ambiguous", threadId: null }),
        expect.objectContaining({ id: unlinked.observationId, associationReason: "none", threadId: null }),
      ]))
      expect(database.prepare(`SELECT COUNT(*) AS count FROM support_thread_messages
        WHERE message_event_id IN (?,?,?)`).get(associated.eventId, ambiguous.eventId, unlinked.eventId)).toEqual({ count: 0 })
      const auditRunId = randomUUID()
      database.prepare(`INSERT INTO memory_maintenance_runs(
        id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        auditRunId, "completed", 4, 0, 0, "保留期终态级联测试", oldAt, recentAt,
      )
      const insertTerminalResult = database.prepare(`INSERT INTO reference_learning_results(
        id,run_id,observation_id,classification,action,risk,outcome,reason_code,
        memory_version_id,operator_style_version_id,created_at
      ) VALUES (?,?,?,'general','noop','low','noop','non_learnable_classification',NULL,NULL,?)`)
      ;[associated, ambiguous, unlinked].forEach((reference) => insertTerminalResult.run(
        randomUUID(), auditRunId, reference.observationId, oldAt,
      ))
      insertTerminalResult.run(randomUUID(), auditRunId, recent.observationId, recentAt)

      const result = new RetentionService(database, attachmentRoot).run(retentionNow, 1)

      expect(result).toEqual(expect.objectContaining({
        deletedThreads: 3,
        deletedMessageEvents: 6,
        deletedAttachments: 4,
        deletedAttachmentFiles: 3,
      }))
      expect(database.prepare(`SELECT id,safe_text FROM support_message_events WHERE id IN (?,?,?)`)
        .all(associated.eventId, ambiguous.eventId, unlinked.eventId)).toEqual([])
      expect(database.prepare(`SELECT id FROM support_message_attachments WHERE message_event_id IN (?,?,?)`)
        .all(associated.eventId, ambiguous.eventId, unlinked.eventId)).toEqual([])
      expect(database.prepare(`SELECT id FROM learning_source_observations WHERE id IN (?,?,?)`)
        .all(associated.observationId, ambiguous.observationId, unlinked.observationId)).toEqual([])
      expect(database.prepare("SELECT observation_id FROM reference_learning_results ORDER BY observation_id").all()).toEqual([
        { observation_id: recent.observationId },
      ])
      await Promise.all([associated, ambiguous, unlinked].map(async (reference) => {
        await expect(access(reference.attachmentPath)).rejects.toThrow()
      }))

      expect(database.prepare("SELECT safe_text FROM support_message_events WHERE id=?").get(recent.eventId))
        .toEqual({ safe_text: "保留期内人工参考原文" })
      expect(database.prepare("SELECT id FROM learning_source_observations WHERE id=?").get(recent.observationId))
        .toEqual({ id: recent.observationId })
      expect(database.prepare("SELECT id FROM support_message_events WHERE id=?").get(retainedThreadEvent.eventId))
        .toEqual({ id: retainedThreadEvent.eventId })
      await expect(access(recent.attachmentPath)).resolves.toBeUndefined()
      await expect(access(retainedThreadAttachment)).resolves.toBeUndefined()

      const repeated = new RetentionService(database, attachmentRoot).run(retentionNow, 1)
      expect(repeated).toEqual(expect.objectContaining({
        deletedThreads: 0,
        deletedMessageEvents: 0,
        deletedAttachments: 0,
        deletedAttachmentFiles: 0,
      }))

      const queryPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT event.id FROM support_message_events event
        WHERE event.created_at<? AND NOT EXISTS (
          SELECT 1 FROM support_thread_messages linked WHERE linked.message_event_id=event.id
        ) AND NOT EXISTS (
          SELECT 1 FROM learning_source_observations observation
          WHERE observation.message_event_id=event.id AND (
            observation.processing_status='running'
            OR observation.current_run_id IS NOT NULL
            OR observation.lock_token IS NOT NULL
            OR observation.locked_at IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM reference_learning_results result
              JOIN memory_maintenance_runs run ON run.id=result.run_id
              WHERE result.observation_id=observation.id AND run.status='running'
            )
          )
        ) ORDER BY event.created_at,event.id LIMIT 1`).all("2026-05-13T00:00:00.000Z") as Array<{ detail: string }>
      const queryDetails = queryPlan.map((step) => step.detail).join("\n")
      expect(queryDetails).toContain("support_message_events_retention_idx")
      expect(queryDetails).toContain("sqlite_autoindex_learning_source_observations_2")
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("classifier 阻塞时保留 running run 全部观察，终态后清理且后续 claim 正常", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "retention-running-reference-"))
    const attachmentRoot = path.join(directory, "attachments")
    const workspacePath = path.join(directory, "current-snapshot")
    const backendPath = path.join(workspacePath, "java-project")
    await mkdir(path.join(backendPath, "src"), { recursive: true })
    await mkdir(attachmentRoot)
    await writeFile(path.join(backendPath, "src", "OrderRule.ts"), "export const pending = true\n", "utf8")
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    let releaseClassifier: (() => void) | undefined
    try {
      const catalog = seedCatalog(database)
      const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
      const observations = new LearningSourceStore(database)
      const observer = new LearningSourceObserver({
        database,
        threads: store,
        observations,
        materializePendingBatch: () => null,
        lifecycle: new SupportThreadLifecycleService(store, {
          cancel: () => false,
          cancelClosed: () => 0,
        }),
      })
      const secretThread = createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-secret-running",
        eventCreatedAt: oldAt,
        latestMessageAt: oldAt,
      })
      const secret = await createReferenceEvent({
        store,
        observer,
        group: catalog.associatedGroup,
        attachmentRoot,
        messageId: "reference-secret-running",
        text: `password=${"p".repeat(2_000)}\ntoken=${"t".repeat(2_000)}`,
        createdAt: "2026-01-01T00:01:00.000Z",
        replyToMessageId: "question-secret-running",
      })
      const safeThread = createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-safe-running",
        eventCreatedAt: oldAt,
        latestMessageAt: oldAt,
      })
      const safe = await createReferenceEvent({
        store,
        observer,
        group: catalog.associatedGroup,
        attachmentRoot,
        messageId: "reference-safe-running",
        text: "订单处理中表示仍在等待上游结果",
        createdAt: "2026-01-01T00:02:00.000Z",
        replyToMessageId: "question-safe-running",
      })
      expect(database.prepare(`SELECT COUNT(*) AS count FROM support_thread_messages
        WHERE message_event_id IN (?,?)`).get(secret.eventId, safe.eventId)).toEqual({ count: 0 })
      expect(database.prepare(`SELECT id,thread_id FROM learning_source_observations WHERE id IN (?,?) ORDER BY id`)
        .all(secret.observationId, safe.observationId)).toEqual([
        { id: secret.observationId, thread_id: secretThread.threadId },
        { id: safe.observationId, thread_id: safeThread.threadId },
      ].sort((left, right) => left.id.localeCompare(right.id)))

      const snapshot: ProjectCodeSnapshot = {
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        service: "retention-service",
        branch: "main",
        commit: "java-project@aaaaaaaa",
        snapshotId: randomUUID(),
        syncBatchId: randomUUID(),
        configurationFingerprint: "c".repeat(64),
        syncState: "fresh",
        failure: null,
        publishedAt: recentAt,
        workspacePath,
        repositories: [{
          role: "backend",
          repositoryId: randomUUID(),
          name: "java-project",
          branch: "main",
          commit: "a".repeat(40),
          snapshotPath: backendPath,
        }],
      }
      let classifyHandler = (input: ReferenceAgentInput): Promise<ReferenceProposalResult> => new Promise((resolve) => {
        releaseClassifier = () => resolve(noopReferenceProposals(input))
      })
      const classify = vi.fn((input: ReferenceAgentInput) => classifyHandler(input))
      const worker = new ReferenceLearningWorker(
        database,
        new ModelConfigService(database),
        new RuntimeKnowledgeService(database),
        { classify },
        { readCurrentSnapshot: () => snapshot },
        new OperatorStyleService(database),
        new ConfiguredSecretRedactor(database),
      )

      const running = worker.runOnce(new Date("2026-08-11T01:00:00.000Z"))
      await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1))
      const runBeforeRetention = database.prepare(`SELECT id,status,scanned_events FROM memory_maintenance_runs
        WHERE status='running'`).get() as { id: string; status: string; scanned_events: number }
      expect(database.prepare(`SELECT processing_status,current_run_id,lock_token,locked_at
        FROM learning_source_observations WHERE id=?`).get(secret.observationId)).toEqual({
        processing_status: "ignored", current_run_id: null, lock_token: null, locked_at: null,
      })
      expect(database.prepare(`SELECT processing_status,current_run_id,lock_token IS NOT NULL AS has_lock,
        locked_at IS NOT NULL AS has_locked_at FROM learning_source_observations WHERE id=?`).get(safe.observationId)).toEqual({
        processing_status: "running", current_run_id: runBeforeRetention.id, has_lock: 1, has_locked_at: 1,
      })
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results WHERE run_id=?`)
        .get(runBeforeRetention.id)).toEqual({ count: 1 })

      const blockedRetention = new RetentionService(database, attachmentRoot).run(retentionNow, 1)
      const blockedState = {
        threads: database.prepare(`SELECT id FROM support_threads WHERE id IN (?,?) ORDER BY id`)
          .all(secretThread.threadId, safeThread.threadId),
        events: database.prepare(`SELECT id FROM support_message_events WHERE id IN (?,?) ORDER BY id`)
          .all(secret.eventId, safe.eventId),
        observations: database.prepare(`SELECT id FROM learning_source_observations WHERE id IN (?,?) ORDER BY id`)
          .all(secret.observationId, safe.observationId),
        run: database.prepare(`SELECT status,scanned_events FROM memory_maintenance_runs WHERE id=?`).get(runBeforeRetention.id),
        terminalCount: database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results WHERE run_id=?`)
          .get(runBeforeRetention.id),
      }
      if (!releaseClassifier) throw new Error("分类器阻塞钩子未建立")
      releaseClassifier()
      releaseClassifier = undefined
      const firstRunResult = await running.catch((error: unknown) => error)

      expect(blockedRetention).toEqual(expect.objectContaining({ deletedThreads: 0, deletedMessageEvents: 0 }))
      expect(blockedState.threads).toHaveLength(2)
      expect(blockedState.events).toHaveLength(2)
      expect(blockedState.observations).toHaveLength(2)
      expect(blockedState.run).toEqual({ status: "running", scanned_events: 2 })
      expect(blockedState.terminalCount).toEqual({ count: 1 })
      expect(firstRunResult).toEqual({ processed: 1, createdVersions: 0, conflicts: 0, styleVersions: 0 })
      expect(database.prepare(`SELECT processing_status,current_run_id,lock_token,locked_at
        FROM learning_source_observations WHERE id IN (?,?) ORDER BY processing_status`).all(
        secret.observationId,
        safe.observationId,
      )).toEqual([
        { processing_status: "completed", current_run_id: null, lock_token: null, locked_at: null },
        { processing_status: "ignored", current_run_id: null, lock_token: null, locked_at: null },
      ])
      expect(database.prepare(`SELECT status,scanned_events FROM memory_maintenance_runs WHERE id=?`)
        .get(runBeforeRetention.id)).toEqual({ status: "completed", scanned_events: 2 })
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results WHERE run_id=?`)
        .get(runBeforeRetention.id)).toEqual({ count: 2 })

      const terminalRetention = new RetentionService(database, attachmentRoot).run(retentionNow, 1)
      expect(terminalRetention).toEqual(expect.objectContaining({ deletedThreads: 2, deletedMessageEvents: 4 }))
      expect(database.prepare(`SELECT id FROM support_threads WHERE id IN (?,?)`)
        .all(secretThread.threadId, safeThread.threadId)).toEqual([])
      expect(database.prepare(`SELECT id FROM learning_source_observations WHERE id IN (?,?)`)
        .all(secret.observationId, safe.observationId)).toEqual([])
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results WHERE run_id=?`)
        .get(runBeforeRetention.id)).toEqual({ count: 0 })
      expect(worker.recoverInterrupted(new Date("2026-08-11T02:00:00.000Z"))).toBe(0)

      createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-after-retention",
        eventCreatedAt: recentAt,
        latestMessageAt: recentAt,
      })
      const afterRetention = await createReferenceEvent({
        store,
        observer,
        group: catalog.associatedGroup,
        attachmentRoot,
        messageId: "reference-after-retention",
        text: "后续参考观察仍可正常处理",
        createdAt: recentAt,
        replyToMessageId: "question-after-retention",
      })
      classifyHandler = async (input) => noopReferenceProposals(input)
      expect(await worker.runOnce(new Date("2026-08-11T02:01:00.000Z"))).toEqual({
        processed: 1, createdVersions: 0, conflicts: 0, styleVersions: 0,
      })
      expect(database.prepare(`SELECT processing_status FROM learning_source_observations WHERE id=?`)
        .get(afterRetention.observationId)).toEqual({ processing_status: "completed" })
    } finally {
      releaseClassifier?.()
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("候选选择后 observation 被 claim 时最终 DELETE 再次保护旧 thread", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "retention-final-thread-fence-"))
    const attachmentRoot = path.join(directory, "attachments")
    await mkdir(attachmentRoot)
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    try {
      const catalog = seedCatalog(database)
      const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
      const observer = new LearningSourceObserver({
        database,
        threads: store,
        observations: new LearningSourceStore(database),
        materializePendingBatch: () => null,
        lifecycle: new SupportThreadLifecycleService(store, {
          cancel: () => false,
          cancelClosed: () => 0,
        }),
      })
      const thread = createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "question-final-fence",
        eventCreatedAt: oldAt,
        latestMessageAt: oldAt,
      })
      const reference = await createReferenceEvent({
        store,
        observer,
        group: catalog.associatedGroup,
        attachmentRoot,
        messageId: "reference-final-fence",
        text: "候选选择后才被 worker claim 的人工参考",
        createdAt: "2026-01-01T00:01:00.000Z",
        replyToMessageId: "question-final-fence",
      })
      const replyId = randomUUID()
      const replyMemoryEventId = randomUUID()
      const replyAttachmentId = randomUUID()
      const replyAttachmentPath = path.join(attachmentRoot, "reply-final-fence.txt")
      await writeFile(replyAttachmentPath, "待保留的回复附件", "utf8")
      database.prepare(`INSERT INTO support_replies(
        id,thread_id,service,decision,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?)`).run(replyId, thread.threadId, "retention-service", "reply", "replied", oldAt, oldAt)
      database.prepare(`INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text,has_attachment)
        VALUES (?,?,?,?,1)`).run(replyId, "待保留问题", "待保留回复", null)
      database.prepare(`INSERT INTO support_attachments(
        id,reply_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        replyAttachmentId, replyId, "reply-final-fence.txt", "text/plain", 18, "text",
        replyAttachmentPath, "待保留的回复附件", oldAt,
      )
      database.prepare(`INSERT INTO memory_events(
        id,type,source_ref,fact_id,reply_record_id,content,scope,region,branch,code_revision,risk,confidence,actor,occurred_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        replyMemoryEventId, "reply", null, null, replyId, "待保留回复", "retention-service",
        null, null, null, "low", 1, "codex", oldAt,
      )
      const runId = randomUUID()
      database.prepare(`INSERT INTO memory_maintenance_runs(
        id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(runId, "running", 1, 0, 0, "处理中", oldAt, null)
      database.connection.exec(`CREATE TRIGGER claim_observation_after_retention_fence
        AFTER UPDATE OF value ON metadata
        WHEN NEW.key='allow_maintenance_delete' AND NEW.value='1'
        BEGIN
          UPDATE learning_source_observations SET processing_status='running',current_run_id='${runId}',
            lock_token='claim-after-candidate',locked_at='2026-08-11T00:00:00.000Z'
          WHERE id='${reference.observationId}';
        END;`)

      const blocked = new RetentionService(database, attachmentRoot).run(retentionNow, 1)

      expect(blocked).toEqual(expect.objectContaining({
        deletedThreads: 0,
        deletedMessageEvents: 0,
        deletedReplies: 0,
        deletedTransientEvents: 0,
        deletedAttachments: 0,
      }))
      expect(database.prepare("SELECT id FROM support_threads WHERE id=?").get(thread.threadId)).toEqual({ id: thread.threadId })
      expect(database.prepare("SELECT id FROM support_replies WHERE id=?").get(replyId)).toEqual({ id: replyId })
      expect(database.prepare("SELECT id FROM memory_events WHERE id=?").get(replyMemoryEventId)).toEqual({ id: replyMemoryEventId })
      expect(database.prepare("SELECT id FROM support_attachments WHERE id=?").get(replyAttachmentId)).toEqual({ id: replyAttachmentId })
      await expect(access(replyAttachmentPath)).resolves.toBeUndefined()
      expect(database.prepare(`SELECT processing_status,current_run_id,lock_token FROM learning_source_observations WHERE id=?`)
        .get(reference.observationId)).toEqual({
        processing_status: "running", current_run_id: runId, lock_token: "claim-after-candidate",
      })

      database.connection.exec("DROP TRIGGER claim_observation_after_retention_fence")
      database.prepare(`UPDATE learning_source_observations SET processing_status='completed',current_run_id=NULL,
        lock_token=NULL,locked_at=NULL WHERE id=?`).run(reference.observationId)
      database.prepare(`INSERT INTO reference_learning_results(
        id,run_id,observation_id,classification,action,risk,outcome,reason_code,
        memory_version_id,operator_style_version_id,created_at
      ) VALUES (?,?,?,'general','noop','low','noop','proposal_noop',NULL,NULL,?)`).run(
        randomUUID(), runId, reference.observationId, recentAt,
      )
      database.prepare(`UPDATE memory_maintenance_runs SET status='completed',summary='完成',finished_at=? WHERE id=?`)
        .run(recentAt, runId)

      const released = new RetentionService(database, attachmentRoot).run(retentionNow, 1)
      expect(released).toEqual(expect.objectContaining({ deletedThreads: 1, deletedMessageEvents: 2 }))
      expect(database.prepare("SELECT id FROM learning_source_observations WHERE id=?").get(reference.observationId)).toBeUndefined()
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("随旧 thread 级联清理 ownership，并分页删除无宿主的 90 天旧输出", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "retention-telegram-output-"))
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    try {
      const catalog = seedCatalog(database)
      const store = new SupportThreadStore(database, new ConfiguredSecretRedactor(database))
      const linked = createQuestionThread({
        store,
        group: catalog.associatedGroup,
        projectId: catalog.projectId,
        serviceId: catalog.serviceId,
        messageId: "old-owned-thread",
      })
      const linkedOwnershipId = randomUUID()
      const oldGlobalId = randomUUID()
      const recentGlobalId = randomUUID()
      const insert = database.prepare(`INSERT INTO telegram_output_ownership(
        id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
        notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      insert.run(
        linkedOwnershipId, null, catalog.associatedGroup.id, "-10001", "output-linked", linked.threadId,
        catalog.serviceId, null, null, "support_reply", "sent", randomUUID(), "a".repeat(64), null, oldAt, oldAt,
      )
      insert.run(
        oldGlobalId, null, catalog.unlinkedGroup.id, "-10002", "output-old-global", null,
        catalog.serviceId, null, null, "identity", "sent", randomUUID(), "b".repeat(64), null, oldAt, oldAt,
      )
      insert.run(
        recentGlobalId, null, catalog.unlinkedGroup.id, "-10002", "output-recent-global", null,
        catalog.serviceId, null, null, "identity", "sent", randomUUID(), "c".repeat(64), null, recentAt, recentAt,
      )
      const insertCandidate = database.prepare(`INSERT INTO telegram_outgoing_candidates(
        id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?)`)
      insertCandidate.run(randomUUID(), linkedOwnershipId, "candidate-linked", "application", oldAt, oldAt)
      insertCandidate.run(randomUUID(), oldGlobalId, "candidate-old", "unknown", oldAt, oldAt)
      const recentCandidateId = randomUUID()
      insertCandidate.run(recentCandidateId, recentGlobalId, "candidate-recent", "manual", recentAt, recentAt)

      const result = new RetentionService(database).run(retentionNow, 1)

      expect(result).toEqual(expect.objectContaining({ deletedOutputOwnership: 1 }))
      expect(database.prepare("SELECT id FROM telegram_output_ownership ORDER BY id").all()).toEqual([
        { id: recentGlobalId },
      ])
      expect(database.prepare("SELECT id FROM telegram_outgoing_candidates").all()).toEqual([
        { id: recentCandidateId },
      ])
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("v21 经 v22 升级 v23 且可写 portable 打开时补齐保留期索引", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "retention-portable-v21-"))
    const databasePath = path.join(directory, "portable.sqlite")
    let database: RuntimeDatabase | null = await RuntimeDatabase.open(databasePath)
    try {
      expect(database.schemaVersion()).toBe(29)
      database.prepare("DROP INDEX IF EXISTS support_message_events_retention_idx").run()
      database.prepare("DROP TABLE telegram_outgoing_candidates").run()
      database.prepare("DROP TABLE telegram_output_ownership").run()
      database.prepare("UPDATE metadata SET value='21' WHERE key='schema_version'").run()
      database.close()
      database = null
      database = RuntimeDatabase.openPortable(databasePath)

      expect(database.schemaVersion()).toBe(29)
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get("support_message_events_retention_idx")).toEqual({ name: "support_message_events_retention_idx" })
    } finally {
      database?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
