import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { vi } from "vitest"

import type { ReferenceAgentInput, ReferenceAgentPort } from "../../src/learning/reference-agent.js"
import { OperatorStyleService } from "../../src/learning/operator-style-service.js"
import { ReferenceLearningWorker } from "../../src/learning/reference-worker.js"
import type { ReferenceProposalResult } from "../../src/codex/schemas.js"
import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { RuntimeKnowledgeService } from "../../src/runtime/knowledge-service.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"

const directories: string[] = []
const databases: RuntimeDatabase[] = []

export async function cleanupReferenceHarnesses(): Promise<void> {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
}

export type ReferenceHarness = Awaited<ReturnType<typeof createReferenceHarness>>

export async function createReferenceHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "reference-worker-"))
  directories.push(directory)
  const databasePath = path.join(directory, "support.sqlite")
  const database = await RuntimeDatabase.open(databasePath)
  databases.push(database)
  const timestamp = "2026-08-11T00:00:00.000Z"
  const projectId = randomUUID()
  const serviceId = randomUUID()
  const groupId = randomUUID()
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "scope", timestamp, timestamp)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, projectId, "service", "服务", "印度", "Asia/Shanghai", null, "main", 1, timestamp, timestamp)
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "group", "客服群", null, null, projectId, serviceId, 1, "bot", "all", "telegram", "[]", "main",
    null, "database", "scope", "support", timestamp, timestamp,
  )

  const workspacePath = path.join(directory, "current-snapshot")
  const backendPath = path.join(workspacePath, "java-project")
  const frontendPath = path.join(workspacePath, "sfzf-web")
  await mkdir(path.join(backendPath, "src"), { recursive: true })
  await mkdir(path.join(frontendPath, "src"), { recursive: true })
  await writeFile(path.join(backendPath, "src", "OrderRule.ts"), "export const pending = true\n", "utf8")
  await writeFile(path.join(frontendPath, "src", "order-rule.ts"), "export const label = 'pending'\n", "utf8")
  let snapshot: ProjectCodeSnapshot = {
    projectId,
    serviceId,
    service: "service",
    branch: "main",
    commit: "java-project@aaaaaaaa, sfzf-web@bbbbbbbb",
    snapshotId: randomUUID(),
    syncBatchId: randomUUID(),
    configurationFingerprint: "c".repeat(64),
    syncState: "fresh",
    failure: null,
    publishedAt: timestamp,
    workspacePath,
    repositories: [
      {
        role: "backend", repositoryId: randomUUID(), name: "java-project", branch: "main",
        commit: "a".repeat(40), snapshotPath: backendPath,
      },
      {
        role: "frontend", repositoryId: randomUUID(), name: "sfzf-web", branch: "main",
        commit: "b".repeat(40), snapshotPath: frontendPath,
      },
    ],
  }
  let handler: (input: ReferenceAgentInput) => Promise<ReferenceProposalResult> = async (input) => ({
    proposals: input.threadContexts.map((context) => proposal({
      observationIds: [context.observationId],
      classification: "general",
      action: "noop",
      codeEvidencePaths: [],
    })),
  })
  let snapshotReadHook: ((current: ProjectCodeSnapshot) => void) | null = null
  const classify = vi.fn((input: ReferenceAgentInput) => handler(input))

  const workerFor = (targetDatabase: RuntimeDatabase, agent: ReferenceAgentPort = { classify }) => {
    const knowledge = new RuntimeKnowledgeService(targetDatabase)
    return new ReferenceLearningWorker(
      targetDatabase,
      new ModelConfigService(targetDatabase),
      knowledge,
      agent,
      {
        readCurrentSnapshot: () => {
          const current = snapshot
          snapshotReadHook?.(current)
          return current
        },
      },
      new OperatorStyleService(targetDatabase),
      new ConfiguredSecretRedactor(targetDatabase),
    )
  }

  return {
    directory,
    databasePath,
    database,
    projectId,
    serviceId,
    groupId,
    workspacePath,
    knowledge: new RuntimeKnowledgeService(database),
    config: new ModelConfigService(database),
    classify,
    worker: workerFor(database),
    workerFor,
    registerDatabase(target: RuntimeDatabase) { databases.push(target) },
    setHandler(next: typeof handler) { handler = next },
    setSnapshotReadHook(next: typeof snapshotReadHook) { snapshotReadHook = next },
    setSnapshot(next: ProjectCodeSnapshot) { snapshot = next },
    getSnapshot() { return snapshot },
  }
}

export function seedObservation(harness: ReferenceHarness, input: {
  index: number
  sourceUserId?: string
  authorized?: boolean
  threadId?: string
  referenceText?: string
  questionText?: string
  processingStatus?: "pending" | "running" | "failed"
  lockedAt?: string | null
  attemptCount?: number
  risk?: "low" | "medium" | "high"
}): { observationId: string; threadId: string; sourceUserId: string } {
  const sourceUserId = input.sourceUserId ?? `20${String(input.index).padStart(3, "0")}`
  const authorized = input.authorized ?? true
  const timestamp = `2026-08-11T00:${String(input.index).padStart(2, "0")}:00.000Z`
  const existingRole = harness.database.prepare("SELECT id FROM telegram_roles WHERE telegram_user_id=?").get(sourceUserId)
  if (!existingRole) {
    harness.database.prepare(`INSERT INTO telegram_roles(
      id,telegram_user_id,username,display_name,role,can_correct,enabled,learning_source_enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), sourceUserId, null, `来源 ${sourceUserId}`, "operator", 0, 1, Number(authorized), timestamp, timestamp,
    )
  }
  const threadId = input.threadId ?? randomUUID()
  const existingThread = harness.database.prepare("SELECT id FROM support_threads WHERE id=?").get(threadId)
  if (!existingThread) {
    harness.database.prepare(`INSERT INTO support_threads(
      id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
      origin_batch_id,generation_started_at,progress_due_at,hard_deadline_at,closed_at,closed_by,closed_reason,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      threadId, harness.groupId, harness.projectId, harness.serviceId, "answered", 1, timestamp, `question-${input.index}`,
      timestamp, "安全摘要", null, null, null, null, null, null, null, timestamp, timestamp,
    )
    const questionId = randomUUID()
    harness.database.prepare(`INSERT INTO support_message_events(
      id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
      sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      questionId, harness.groupId, null, `question-${input.index}`, null, null, `30${input.index}`, null, "提问人", "operator",
      input.questionText ?? "订单为什么还在处理中", "", null, "routed", null, timestamp,
    )
    harness.database.prepare(`INSERT INTO support_thread_messages(
      thread_id,message_event_id,relation,question_fragment,position,created_at
    ) VALUES (?,?,?,?,?,?)`).run(threadId, questionId, "origin", input.questionText ?? "订单为什么还在处理中", 0, timestamp)
  }
  const referenceEventId = randomUUID()
  const observationId = randomUUID()
  harness.database.prepare(`INSERT INTO support_message_events(
    id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,sender_user_id,sender_username,
    sender_display_name,sender_role,safe_text,attachment_summary,ingest_batch_id,route_status,skip_reason,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    referenceEventId, harness.groupId, null, `reference-${input.index}`, `question-${input.index}`, null, sourceUserId, null,
    `来源 ${sourceUserId}`, "operator", input.referenceText ?? "处理中表示还在等待上游结果", "", null, "role_skipped", null, timestamp,
  )
  const processingStatus = input.processingStatus ?? "pending"
  harness.database.prepare(`INSERT INTO learning_source_observations(
    id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,association_confidence,
    takeover_status,classification,risk,processing_status,attempt_count,lock_token,locked_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    observationId, referenceEventId, sourceUserId, "operator", threadId, harness.serviceId, "direct_question", 1,
    "thread_already_terminal", "reference_reply", input.risk ?? "low", processingStatus, input.attemptCount ?? 0,
    processingStatus === "running" ? "old-lock" : null, input.lockedAt ?? (processingStatus === "running" ? timestamp : null),
    timestamp, timestamp,
  )
  return { observationId, threadId, sourceUserId }
}

export function proposal(input: {
  observationIds: string[]
  classification?: "style" | "correction" | "business_rule" | "ephemeral" | "action_result" | "general"
  action?: "add" | "reinforce" | "conflict" | "noop"
  title?: string
  content?: string
  scope?: string
  region?: string | null
  branch?: string | null
  risk?: "low" | "medium" | "high"
  codeEvidencePaths?: string[]
  reason?: string
}) {
  return {
    classification: input.classification ?? "business_rule" as const,
    action: input.action ?? "add" as const,
    title: input.title ?? "订单处理中含义",
    content: input.content ?? "处理中表示系统仍在等待上游结果",
    scope: input.scope ?? "scope",
    region: input.region === undefined ? "印度" : input.region,
    branch: input.branch === undefined ? "main" : input.branch,
    risk: input.risk ?? "low" as const,
    confidence: 0.95,
    evidenceObservationIds: input.observationIds,
    codeEvidencePaths: input.codeEvidencePaths ?? ["java-project/src/OrderRule.ts"],
    reason: input.reason ?? "人工参考回复与当前代码一致",
  }
}
