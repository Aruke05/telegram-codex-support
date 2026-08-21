import { createHash, randomUUID } from "node:crypto"
import { chmod, unlink } from "node:fs/promises"
import path from "node:path"
import { backup } from "node:sqlite"
import { z } from "zod"

import { redactText } from "../security/dlp.js"
import { baselineOperatorStyleProfile, operatorStyleProfileSchema } from "../support/operator-style.js"
import {
  assertReferenceLearningAuditStructure,
  assertTelegramOutputOwnershipRows,
  RuntimeDatabase,
} from "./database.js"
import { operatorStyleVersionSchema } from "./types.js"

const portableTables = [
  "projects",
  "project_repositories",
  "project_services",
  "project_service_repositories",
  "service_code_sync_batches",
  "service_code_snapshots",
  "service_code_snapshot_items",
  "service_code_sync_schedule",
  "project_servers",
  "project_databases",
  "admin_users",
  "admin_roles",
  "admin_user_roles",
  "admin_role_menus",
  "telegram_groups",
  "telegram_roles",
  "learning_source_observations",
  "reference_learning_results",
  "operator_style_versions",
  "operator_style_version_evidence",
  "directives",
  "memory_events",
  "memory_facts",
  "memory_versions",
  "memory_version_evidence",
  "support_threads",
  "support_thread_notifications",
  "telegram_output_ownership",
  "telegram_outgoing_candidates",
  "support_message_events",
  "support_thread_messages",
  "support_thread_links",
  "support_sender_focus",
  "support_route_clarifications",
  "support_message_attachments",
  "support_replies",
  "support_reply_alert_deliveries",
  "support_reply_payloads",
  "shadow_answer_results",
  "shadow_human_answer_links",
  "shadow_learning_reports",
  "shadow_comparisons",
  "reply_memory_refs",
  "admin_chat_sessions",
  "admin_chat_turns",
  "admin_chat_attachments",
  "admin_chat_corrections",
  "reply_generation_audits",
  "memory_maintenance_runs",
  "model_instances",
  "model_catalog_entries",
  "runtime_model_bindings",
  "runtime_settings",
  "daily_group_shutdown_schedule",
] as const
const portableModelTables = ["model_instances", "model_catalog_entries", "runtime_model_bindings"] as const
const sensitiveScanTables = [
  "telegram_groups", "telegram_roles", "learning_source_observations", "directives", "memory_events", "memory_facts", "memory_versions",
  "reference_learning_results",
  "memory_version_evidence", "operator_style_versions", "operator_style_version_evidence",
  "support_threads", "support_thread_notifications", "support_message_events", "support_thread_messages", "support_thread_links",
  "support_sender_focus", "support_route_clarifications",
  "telegram_output_ownership",
  "telegram_outgoing_candidates",
  "support_message_attachments", "support_replies", "support_reply_payloads", "reply_memory_refs",
  "shadow_answer_results", "shadow_human_answer_links", "shadow_learning_reports", "shadow_comparisons",
  "admin_chat_attachments", "admin_chat_corrections", "reply_generation_audits",
  "memory_maintenance_runs", "knowledge_documents",
  "model_profiles", "model_instances", "runtime_model_bindings", "runtime_settings", "daily_group_shutdown_schedule",
] as const
const defaultAnswerModelInstanceId = "00000000-0000-4000-8000-000000000001"
const defaultMemoryModelInstanceId = "00000000-0000-4000-8000-000000000002"

const operatorStyleEvidenceSnapshotSchema = z.object({
  id: z.string().uuid(),
  operatorStyleVersionId: z.string().uuid(),
  observationId: z.string().uuid().nullable(),
  sourceTelegramUserId: z.string().regex(/^\d+$/u),
  threadId: z.string().uuid(),
}).strict()
const referenceLearningResultRowSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  observationId: z.string().uuid(),
  classification: z.enum(["unclassified", "style", "correction", "business_rule", "ephemeral", "action_result", "general"]),
  action: z.enum(["add", "reinforce", "conflict", "noop"]),
  risk: z.enum(["low", "medium", "high"]),
  outcome: z.enum(["noop", "candidate", "conflict", "active", "style_candidate", "style_active", "ignored", "failed"]),
  reasonCode: z.enum([
    "proposal_noop", "deterministic_noop", "non_learnable_classification",
    "memory_candidate", "memory_conflict", "memory_active", "style_candidate", "style_active",
    "unsafe_learning_material", "invalid_proposal_batch", "processing_failed", "interrupted_run",
  ]),
  memoryVersionId: z.string().uuid().nullable(),
  operatorStyleVersionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict().superRefine((row, context) => {
  const memoryOutcome = ["candidate", "conflict", "active"].includes(row.outcome)
  const styleOutcome = ["style_candidate", "style_active"].includes(row.outcome)
  if (memoryOutcome !== Boolean(row.memoryVersionId)
    || styleOutcome !== Boolean(row.operatorStyleVersionId)
    || (row.memoryVersionId && row.operatorStyleVersionId)) {
    context.addIssue({ code: "custom", message: "终态结果与版本 ID 不一致" })
  }
})
const legacyModelProfileSchema = z.object({
  purpose: z.enum(["answer", "memory"]),
  model: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
  reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
  timeout_seconds: z.number().int().min(30).max(3600),
  max_concurrency: z.number().int().min(1).max(8),
  enabled: z.union([z.literal(0), z.literal(1)]),
  updated_at: z.string().min(1),
}).strict()
const baselineOperatorStyleProfileSql = JSON.stringify(baselineOperatorStyleProfile).replaceAll("'", "''")

type PortableModelLineage = "modern" | "legacy"

function portableModelLineage(database: RuntimeDatabase, existing?: Set<string>): PortableModelLineage {
  const tables = existing ?? new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'",
  ).all() as Array<{ name: string }>).map((row) => row.name))
  const modernCount = portableModelTables.filter((table) => tables.has(table)).length
  const hasLegacy = tables.has("model_profiles")
  const groupColumns = new Set((database.prepare("PRAGMA table_info(telegram_groups)").all() as Array<{ name: string }>)
    .map((column) => column.name))
  const hasGroupModel = groupColumns.has("ai_model_instance_id")
  const hasReplyStyle = groupColumns.has("reply_style")
  if (hasGroupModel !== hasReplyStyle) throw new Error("迁移数据库群模型策略结构不完整")
  if (modernCount !== 0 && modernCount !== portableModelTables.length) throw new Error("迁移数据库模型结构不完整")
  if (modernCount === portableModelTables.length && !hasLegacy && hasGroupModel) return "modern"
  if (modernCount === 0 && hasLegacy && !hasGroupModel) return "legacy"
  throw new Error("迁移数据库模型谱系不兼容")
}

async function removeExisting(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function assertPortableSafe(database: RuntimeDatabase): void {
  for (const table of sensitiveScanTables) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue
    let lastRowId = 0
    while (true) {
      const rows = database.prepare(`SELECT rowid AS __rowid,* FROM "${table}" WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastRowId) as Array<Record<string, unknown>>
      if (rows.length === 0) break
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          const structural = key === "__rowid" || key === "id" || key.endsWith("_id") || key.endsWith("_ids")
            || key === "topic_key" || key.endsWith("_hash") || key === "code_revision"
            || key === "telegram_chat_id" || key === "telegram_message_id" || key === "telegram_reply_message_id"
            || key === "reply_to_message_id" || key === "message_thread_id"
          if (!structural && typeof value === "string" && redactText(value).changed) throw new Error("迁移数据库包含敏感信息")
        }
      }
      lastRowId = Number(rows.at(-1)?.__rowid ?? lastRowId)
    }
  }
}

function normalizeRunningReferenceLearningRuns(
  database: RuntimeDatabase,
  summary: string,
  interruptedAt: string,
  hasTerminalAudit: boolean,
): void {
  if (!hasTerminalAudit) {
    database.prepare(`UPDATE memory_maintenance_runs SET status='failed',summary=?,finished_at=?
      WHERE status='running'`).run(summary, interruptedAt)
    database.prepare(`UPDATE learning_source_observations
      SET processing_status=CASE WHEN processing_status='running' THEN 'pending' ELSE processing_status END,
        lock_token=NULL,locked_at=NULL,current_run_id=NULL`).run()
    return
  }
  const invalidOwnership = database.prepare(`SELECT 1 FROM learning_source_observations observation
    LEFT JOIN memory_maintenance_runs run ON run.id=observation.current_run_id
    WHERE (observation.processing_status='running' AND observation.current_run_id IS NULL)
      OR (observation.current_run_id IS NOT NULL AND (
        observation.processing_status!='running' OR observation.lock_token IS NULL OR observation.locked_at IS NULL
        OR run.status IS NOT 'running'
        OR EXISTS (SELECT 1 FROM reference_learning_results result
          WHERE result.run_id=observation.current_run_id AND result.observation_id=observation.id)
      )) LIMIT 1`).get()
  if (invalidOwnership) throw new Error("迁移数据库人工参考运行状态关系损坏")

  const runs = database.prepare(`SELECT run.id,run.scanned_events,
      (SELECT COUNT(*) FROM reference_learning_results result WHERE result.run_id=run.id) AS terminal_count
    FROM memory_maintenance_runs run WHERE run.status='running' ORDER BY run.id`).all() as Array<{
    id: string
    scanned_events: number
    terminal_count: number
  }>
  const insertInterrupted = database.prepare(`INSERT INTO reference_learning_results(
    id,run_id,observation_id,classification,action,risk,outcome,reason_code,
    memory_version_id,operator_style_version_id,created_at
  ) VALUES (?,?,?,'unclassified','noop',?,'failed','interrupted_run',NULL,NULL,?)`)
  for (const run of runs) {
    const active = database.prepare(`SELECT id,risk FROM learning_source_observations
      WHERE processing_status='running' AND current_run_id=? ORDER BY id`).all(run.id) as Array<{
      id: string
      risk: "low" | "medium" | "high"
    }>
    if (Number(run.scanned_events) <= 0 || Number(run.terminal_count) + active.length !== Number(run.scanned_events)) {
      throw new Error("迁移数据库人工参考运行审计数量损坏")
    }
    for (const observation of active) {
      insertInterrupted.run(randomUUID(), run.id, observation.id, observation.risk, interruptedAt)
    }
    const updated = database.prepare(`UPDATE memory_maintenance_runs SET status='failed',summary=?,finished_at=?
      WHERE id=? AND status='running'`).run(summary, interruptedAt, run.id)
    if (Number(updated.changes) !== 1) throw new Error("迁移数据库人工参考运行状态已变化")
  }
  database.prepare(`UPDATE learning_source_observations
    SET processing_status=CASE WHEN processing_status='running' THEN 'pending' ELSE processing_status END,
      lock_token=NULL,locked_at=NULL,current_run_id=NULL`).run()
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function portableRemoteUrl(value: string): string {
  try {
    const remote = new URL(value)
    remote.username = ""
    remote.password = ""
    remote.search = ""
    remote.hash = ""
    return remote.toString()
  } catch {
    return value.replace(/[?#].*$/u, "")
  }
}

export class BackupService {
  constructor(private readonly database: RuntimeDatabase) {}

  async export(destination: string): Promise<string> {
    const target = path.resolve(destination)
    if (target === this.database.filePath) throw new Error("迁移文件不能覆盖运行数据库")
    await removeExisting(target)
    await backup(this.database.connection, target)
    let portable: RuntimeDatabase
    try {
      portable = RuntimeDatabase.openPortable(target)
    } catch (error) {
      await removeExisting(target)
      throw error
    }
    let safe = false
    try {
      portable.transaction(() => {
        portable.prepare("UPDATE telegram_groups SET account_id=NULL").run()
        portable.prepare("UPDATE support_replies SET account_id=NULL").run()
        portable.prepare(`UPDATE telegram_output_ownership SET
          account_id=NULL,
          delivery_status=CASE WHEN delivery_status='sending' THEN 'unknown' ELSE delivery_status END`).run()
        portable.prepare(`UPDATE telegram_outgoing_candidates SET
          resolution_status=CASE WHEN resolution_status='pending' THEN 'unknown' ELSE resolution_status END`).run()
        portable.prepare(`UPDATE support_reply_alert_deliveries SET status='uncertain'
          WHERE status='sending'`).run()
        portable.prepare(`UPDATE support_replies SET operator_delivery_status='uncertain'
          WHERE operator_delivery_status='sending'`).run()
        portable.prepare("UPDATE support_message_events SET account_id=NULL").run()
        portable.prepare("UPDATE support_message_attachments SET storage_path=''").run()
        portable.prepare("UPDATE admin_chat_attachments SET storage_path=''").run()
        portable.prepare("DELETE FROM telegram_accounts").run()
        portable.prepare("DELETE FROM telegram_offsets").run()
        portable.prepare("DELETE FROM code_sync_runs").run()
        portable.prepare("DELETE FROM memory_learning_queue").run()
        portable.prepare("DELETE FROM support_attachments").run()
        normalizeRunningReferenceLearningRuns(
          portable,
          "人工参考学习在迁移导出时中断",
          new Date().toISOString(),
          true,
        )
        portable.prepare("DELETE FROM model_catalog_entries").run()
        portable.prepare(`UPDATE model_instances SET
          credentials=NULL,
          enabled=CASE WHEN transport='direct_api' THEN 0 ELSE enabled END,
          health_status='not_tested',health_message='迁移后需要重新检测',last_checked_at=NULL`).run()
        const repositories = portable.prepare("SELECT id,remote_url FROM project_repositories").all() as Array<{
          id: string
          remote_url: string
        }>
        const updateRepository = portable.prepare(`UPDATE project_repositories
          SET local_path='',branch='main',remote_url=? WHERE id=?`)
        repositories.forEach((repository) => updateRepository.run(portableRemoteUrl(repository.remote_url), repository.id))
      })
      assertTelegramOutputOwnershipRows(portable.connection)
      if ((portable.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
        throw new Error("迁移数据库外键关系损坏")
      }
      assertPortableSafe(portable)
      portable.connection.exec("VACUUM")
      safe = true
    } finally {
      portable.close()
      if (!safe) await removeExisting(target)
    }
    await chmod(target, 0o600)
    return target
  }

  async import(source: string): Promise<void> {
    const portable = RuntimeDatabase.openPortable(source, true)
    try {
      this.validatePortable(portable)
    } finally {
      portable.close()
    }
    const localAccounts = this.database.readAccounts()
    const botAccountId = localAccounts.find((account) => account.type === "bot" && account.enabled)?.id ?? null
    const userAccountId = localAccounts.find((account) => account.type === "user" && account.enabled)?.id ?? null
    const localSystemDirectives = this.database.readDirectives("WHERE source='system' ORDER BY created_at")
    const portableStructure = RuntimeDatabase.openPortable(source, true)
    let portableHasServiceBranch = false
    let portableHasProgressNotificationSeconds = false
    let portableHasIngestBatchId = false
    let portableHasMediaGroupId = false
    let portableHasHumanPriority = false
    let portableHasOriginBatchId = false
    let portableHasServiceCodeTables = false
    let portableHasLearningSourceRoles = false
    let portableHasLearningSourceObservations = false
    let portableHasObservationCurrentRunId = false
    let portableHasReferenceLearningResults = false
    let portableHasOperatorDeliveryStatus = false
    let portableHasReplyAlertDeliveries = false
    let portableHasOperatorStyle = false
    let portableHasOperatorStyleSnapshots = false
    let portableHasThreadStylePin = false
    let portableHasThreadAnswerPolicy = false
    let portableHasTelegramOutputOwnership = false
    let portableHasTelegramOutgoingCandidates = false
    let portableHasAdminChatAttachments = false
    let portableHasAdminChatCorrections = false
    let portableHasReplyGenerationAudits = false
    let portableHasThreadLinks = false
    let portableHasSenderFocus = false
    let portableHasDailyGroupShutdownSchedule = false
    let portableHasGroupOperationMode = false
    let portableHasThreadOperationMode = false
    let portableHasShadowLearning = false
    let portableHasAdminAccess = false
    let portableHasAdminChatOwner = false
    let portableModels: PortableModelLineage = "modern"
    try {
      const portableSchemaVersion = portableStructure.schemaVersion()
      portableHasServiceBranch = (portableStructure.prepare("PRAGMA table_info(project_services)").all() as Array<{ name: string }>).some((column) => column.name === "branch")
      portableHasProgressNotificationSeconds = (portableStructure.prepare("PRAGMA table_info(runtime_settings)").all() as Array<{ name: string }>).some(
        (column) => column.name === "progress_notification_seconds",
      )
      portableHasIngestBatchId = (portableStructure.prepare("PRAGMA table_info(support_message_events)").all() as Array<{ name: string }>).some(
        (column) => column.name === "ingest_batch_id",
      )
      portableHasMediaGroupId = (portableStructure.prepare("PRAGMA table_info(support_message_events)").all() as Array<{ name: string }>).some(
        (column) => column.name === "media_group_id",
      )
      portableHasOriginBatchId = (portableStructure.prepare("PRAGMA table_info(support_threads)").all() as Array<{ name: string }>).some(
        (column) => column.name === "origin_batch_id",
      )
      portableHasServiceCodeTables = portableStructure.schemaVersion() >= 11
      portableHasLearningSourceRoles = (portableStructure.prepare("PRAGMA table_info(telegram_roles)").all() as Array<{ name: string }>).some(
        (column) => column.name === "learning_source_enabled",
      )
      portableHasLearningSourceObservations = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_source_observations'",
      ).get())
      portableHasObservationCurrentRunId = portableHasLearningSourceObservations
        && (portableStructure.prepare("PRAGMA table_info(learning_source_observations)").all() as Array<{ name: string }>)
          .some((column) => column.name === "current_run_id")
      portableHasReferenceLearningResults = portableSchemaVersion >= 23 && Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_learning_results'",
      ).get())
      portableHasOperatorDeliveryStatus = (portableStructure.prepare("PRAGMA table_info(support_replies)").all() as Array<{ name: string }>).some(
        (column) => column.name === "operator_delivery_status",
      )
      portableHasReplyAlertDeliveries = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_reply_alert_deliveries'",
      ).get())
      portableHasOperatorStyle = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_style_versions'",
      ).get()) && Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_style_version_evidence'",
      ).get())
      portableHasOperatorStyleSnapshots = (portableStructure.prepare(
        "PRAGMA table_info(operator_style_version_evidence)",
      ).all() as Array<{ name: string }>).some((column) => column.name === "source_telegram_user_id")
      const portableThreadColumns = (portableStructure.prepare(
        "PRAGMA table_info(support_threads)",
      ).all() as Array<{ name: string }>).map((column) => column.name)
      portableHasGroupOperationMode = (portableStructure.prepare(
        "PRAGMA table_info(telegram_groups)",
      ).all() as Array<{ name: string }>).some((column) => column.name === "operation_mode")
      portableHasThreadOperationMode = portableThreadColumns.includes("answer_operation_mode")
      portableHasShadowLearning = ["shadow_answer_results", "shadow_human_answer_links", "shadow_learning_reports", "shadow_comparisons"]
        .every((table) => Boolean(portableStructure.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        ).get(table)))
      const portableEventColumns = (portableStructure.prepare(
        "PRAGMA table_info(support_message_events)",
      ).all() as Array<{ name: string }>).map((column) => column.name)
      const humanPriorityThreadColumns = [
        "human_priority_state", "human_priority_user_ids_json", "human_priority_due_at",
        "human_priority_source_event_id", "human_priority_progress_message_id", "human_priority_error",
      ]
      const humanPriorityEventColumns = ["human_priority_user_ids_json", "human_priority_due_at"]
      const humanPriorityColumnCount = [
        ...humanPriorityThreadColumns.filter((column) => portableThreadColumns.includes(column)),
        ...humanPriorityEventColumns.filter((column) => portableEventColumns.includes(column)),
      ].length
      if (humanPriorityColumnCount !== 0
        && humanPriorityColumnCount !== humanPriorityThreadColumns.length + humanPriorityEventColumns.length) {
        throw new Error("迁移数据库人工优先等待结构不完整")
      }
      portableHasHumanPriority = humanPriorityColumnCount
        === humanPriorityThreadColumns.length + humanPriorityEventColumns.length
      portableHasThreadStylePin = portableThreadColumns.includes("operator_style_version_id")
        && portableThreadColumns.includes("operator_style_profile_json")
      const threadAnswerPolicyColumns = [
        "answer_model_instance_id", "answer_reply_style", "answer_timeout_seconds", "answer_max_concurrency",
        "answer_binding_enabled", "answer_include_ai_memory", "answer_include_interface_docs", "answer_include_magic_book",
      ]
      const threadAnswerPolicyColumnCount = threadAnswerPolicyColumns.filter((column) => portableThreadColumns.includes(column)).length
      if (threadAnswerPolicyColumnCount !== 0 && threadAnswerPolicyColumnCount !== threadAnswerPolicyColumns.length) {
        throw new Error("迁移数据库线程回答策略快照结构不完整")
      }
      portableHasThreadAnswerPolicy = threadAnswerPolicyColumnCount === threadAnswerPolicyColumns.length
      portableHasTelegramOutputOwnership = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_output_ownership'",
      ).get())
      portableHasTelegramOutgoingCandidates = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_outgoing_candidates'",
      ).get())
      portableHasAdminChatAttachments = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_chat_attachments'",
      ).get())
      portableHasAdminChatCorrections = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_chat_corrections'",
      ).get())
      portableHasReplyGenerationAudits = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_generation_audits'",
      ).get())
      portableHasThreadLinks = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_thread_links'",
      ).get())
      portableHasSenderFocus = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_sender_focus'",
      ).get())
      const portableHasRouteClarifications = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_route_clarifications'",
      ).get())
      if (portableHasSenderFocus !== portableHasRouteClarifications) {
        throw new Error("迁移数据库发送人会话焦点结构不完整")
      }
      portableHasDailyGroupShutdownSchedule = Boolean(portableStructure.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_group_shutdown_schedule'",
      ).get())
      portableHasAdminAccess = ["admin_users", "admin_roles", "admin_user_roles", "admin_role_menus"].every((table) => Boolean(
        portableStructure.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ))
      portableHasAdminChatOwner = (portableStructure.prepare(
        "PRAGMA table_info(admin_chat_sessions)",
      ).all() as Array<{ name: string }>).some((column) => column.name === "created_by_user_id")
      if (portableHasAdminChatAttachments !== portableHasAdminChatCorrections) {
        throw new Error("迁移数据库后台对话扩展结构不完整")
      }
      portableModels = portableModelLineage(portableStructure)
    } finally {
      portableStructure.close()
    }
    this.database.prepare("ATTACH DATABASE ? AS portable").run(path.resolve(source))
    try {
      this.database.transaction(() => {
        this.database.suspendSupportThreadMessageInvariant()
        this.database.clearPortableData()
        const copy = (table: string, columns: string, select = columns, suffix = "") => this.database.connection.exec(
          `INSERT INTO main.${table}(${columns}) SELECT ${select} FROM portable.${table} ${suffix}`,
        )
        if (portableHasAdminAccess) {
          this.database.connection.exec(`
            DELETE FROM main.admin_user_roles;
            DELETE FROM main.admin_role_menus;
            DELETE FROM main.admin_users;
            DELETE FROM main.admin_roles;
          `)
          copy("admin_roles", "id,role_key,name,is_super_admin,created_at,updated_at")
          copy("admin_users", "id,username,password_hash,password_salt,password_cost,enabled,auth_version,created_at,updated_at")
          copy("admin_role_menus", "role_id,menu_key,created_at")
          copy("admin_user_roles", "user_id,role_id,created_at")
          this.database.connection.exec(`INSERT OR IGNORE INTO main.admin_role_menus(role_id,menu_key,created_at)
            SELECT id,'access',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM main.admin_roles WHERE is_super_admin=1`)
        }
        copy("projects", "id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at")
        copy("project_repositories", "id,project_id,name,local_path,remote_url,branch,enabled,created_at,updated_at")
        const importedRepositories = this.database.prepare("SELECT id,remote_url FROM project_repositories").all() as Array<{
          id: string
          remote_url: string
        }>
        const sanitizeRepository = this.database.prepare(`UPDATE project_repositories
          SET local_path='',branch='main',remote_url=? WHERE id=?`)
        importedRepositories.forEach((repository) => sanitizeRepository.run(
          portableRemoteUrl(repository.remote_url), repository.id,
        ))
        const branchExpression = portableHasServiceBranch
          ? "branch"
          : "COALESCE((SELECT branch FROM portable.project_repositories r WHERE r.id=repository_id),'main')"
        copy("project_services", "id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at",
          `id,project_id,service_key,name,region,timezone,repository_id,${branchExpression},enabled,created_at,updated_at`)
        if (portableHasServiceCodeTables) {
          copy("project_service_repositories", "service_id,repository_id,role,created_at,updated_at")
          copy("service_code_snapshots", "id,project_id,service_id,branch,repository_pair_fingerprint,commit_pair_fingerprint,status,created_at,published_at")
          copy("service_code_snapshot_items", "snapshot_id,role,repository_id,repository_name,commit_hash,relative_path")
          copy("service_code_sync_batches", `id,project_id,service_id,trigger_source,branch,repository_pair_fingerprint,status,
            snapshot_id,fallback_snapshot_id,error_repository_role,error_repository_name,error_stage,error_type,exit_code,
            safe_summary,alert_status,alert_error_type,alert_summary,alert_fingerprint,alerted_at,started_at,finished_at,duration_ms`)
          const interruptedAt = new Date().toISOString()
          this.database.prepare(`UPDATE service_code_sync_batches SET status='interrupted',finished_at=?,
            error_stage='prepare_repository',error_type='process_interrupted',safe_summary='同步进程在迁移前尚未结束'
            WHERE status='running'`).run(interruptedAt)
          copy("service_code_sync_schedule", `service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,
            failure_count,last_alert_fingerprint,created_at,updated_at`)
        } else {
          this.database.connection.exec(`INSERT INTO main.project_service_repositories(service_id,repository_id,role,created_at,updated_at)
            SELECT service.id,repository.id,'backend',service.created_at,service.updated_at
            FROM main.project_services service JOIN main.project_repositories repository
              ON repository.project_id=service.project_id AND repository.name='java-project'
            WHERE (SELECT COUNT(*) FROM main.project_repositories candidate
              WHERE candidate.project_id=service.project_id AND candidate.name='java-project')=1;
            INSERT INTO main.project_service_repositories(service_id,repository_id,role,created_at,updated_at)
            SELECT service.id,repository.id,'frontend',service.created_at,service.updated_at
            FROM main.project_services service JOIN main.project_repositories repository
              ON repository.project_id=service.project_id AND repository.name='sfzf-web'
            WHERE (SELECT COUNT(*) FROM main.project_repositories candidate
              WHERE candidate.project_id=service.project_id AND candidate.name='sfzf-web')=1;`)
        }
        copy("project_servers", "id,project_id,service_id,alias,host,port,username,private_key,workdir,enabled,created_at,updated_at")
        copy("project_databases", "id,project_id,service_id,alias,engine,host,port,database_name,username,password,timezone,enabled,created_at,updated_at")
        if (portableModels === "modern") {
          copy("model_instances", `id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
            enabled,health_status,health_message,last_checked_at,created_at,updated_at`,
            `id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,NULL,
            CASE WHEN transport='direct_api' THEN 0 ELSE enabled END,'not_tested','迁移后需要重新检测',NULL,created_at,updated_at`)
          copy("runtime_model_bindings", "purpose,model_instance_id,timeout_seconds,max_concurrency,enabled,updated_at")
        } else {
          const profiles = this.database.prepare(`SELECT purpose,model,reasoning_effort,timeout_seconds,
            max_concurrency,enabled,updated_at FROM portable.model_profiles ORDER BY purpose`).all() as Array<{
            purpose: "answer" | "memory"
            model: string
            reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh"
            timeout_seconds: number
            max_concurrency: number
            enabled: number
            updated_at: string
          }>
          const insertInstance = this.database.prepare(`INSERT INTO main.model_instances(
            id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
            enabled,health_status,health_message,last_checked_at,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,'standard','{}',NULL,?,'not_tested','迁移后需要重新检测',NULL,?,?)`)
          const insertBinding = this.database.prepare(`INSERT INTO main.runtime_model_bindings(
            purpose,model_instance_id,timeout_seconds,max_concurrency,enabled,updated_at
          ) VALUES (?,?,?,?,?,?)`)
          profiles.forEach((profile) => {
            const instanceId = profile.purpose === "answer" ? defaultAnswerModelInstanceId : defaultMemoryModelInstanceId
            insertInstance.run(instanceId, profile.purpose === "answer" ? "默认回答模型" : "默认记忆模型",
              "openai", "codex_cli", profile.model, profile.reasoning_effort, profile.enabled,
              profile.updated_at, profile.updated_at)
            insertBinding.run(profile.purpose, instanceId, profile.timeout_seconds, profile.max_concurrency,
              profile.enabled, profile.updated_at)
          })
        }
        const groupModelExpression = portableModels === "modern"
          ? "ai_model_instance_id"
          : `CASE WHEN purpose='technical_alert' THEN '${defaultAnswerModelInstanceId}' ELSE NULL END`
        const replyStyleExpression = portableModels === "modern" ? "reply_style" : "'unrestricted'"
        this.database.prepare(`INSERT INTO main.telegram_groups(
          id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
          platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,ai_model_instance_id,reply_style,
          operation_mode,created_at,updated_at
        ) SELECT id,group_key,name,telegram_chat_id,
          CASE access_mode WHEN 'bot' THEN ? WHEN 'user' THEN ? ELSE NULL END,
          CASE WHEN purpose='technical_alert' THEN NULL ELSE project_id END,
          CASE WHEN purpose='technical_alert' THEN NULL ELSE service_id END,
          CASE access_mode WHEN 'bot' THEN enabled AND ? IS NOT NULL WHEN 'user' THEN enabled AND ? IS NOT NULL ELSE 0 END,
          access_mode,trigger_mode,platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,
          ${groupModelExpression},${replyStyleExpression},${portableHasGroupOperationMode ? "operation_mode" : "'live'"},created_at,updated_at
          FROM portable.telegram_groups`).run(botAccountId, userAccountId, botAccountId, userAccountId)
        copy("telegram_roles", "id,telegram_user_id,username,display_name,role,can_correct,enabled,learning_source_enabled,created_at,updated_at",
          `id,telegram_user_id,username,display_name,role,can_correct,enabled,${portableHasLearningSourceRoles ? "learning_source_enabled" : "0"},created_at,updated_at`)
        if (portableHasOperatorStyle) {
          copy("operator_style_versions", `id,version_number,profile_json,status,sample_count,source_user_count,
            thread_count,created_at,activated_at,superseded_at`)
        }
        copy("support_message_events", `id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,
          media_group_id,sender_user_id,sender_username,sender_display_name,sender_role,safe_text,attachment_summary,
          ingest_batch_id,human_priority_user_ids_json,human_priority_due_at,route_status,skip_reason,created_at`,
          `id,group_id,(SELECT account_id FROM main.telegram_groups g WHERE g.id=group_id),telegram_message_id,
          reply_to_message_id,message_thread_id,${portableHasMediaGroupId ? "media_group_id" : "NULL"},sender_user_id,
          sender_username,sender_display_name,sender_role,safe_text,attachment_summary,
          ${portableHasIngestBatchId ? "ingest_batch_id" : "NULL"},
          ${portableHasHumanPriority ? "human_priority_user_ids_json,human_priority_due_at" : "'[]',NULL"},
          route_status,skip_reason,created_at`)
        const answerPolicySelect = portableHasThreadAnswerPolicy
          ? `answer_model_instance_id,answer_reply_style,answer_timeout_seconds,answer_max_concurrency,
            answer_binding_enabled,answer_include_ai_memory,answer_include_interface_docs,answer_include_magic_book`
          : `COALESCE(
              (SELECT CASE WHEN groups.purpose='technical_alert' THEN groups.ai_model_instance_id ELSE NULL END
                FROM main.telegram_groups groups WHERE groups.id=group_id),
              (SELECT model_instance_id FROM main.runtime_model_bindings WHERE purpose='answer')
            ),
            COALESCE((SELECT groups.reply_style FROM main.telegram_groups groups WHERE groups.id=group_id),'unrestricted'),
            (SELECT timeout_seconds FROM main.runtime_model_bindings WHERE purpose='answer'),
            (SELECT max_concurrency FROM main.runtime_model_bindings WHERE purpose='answer'),
            (SELECT enabled FROM main.runtime_model_bindings WHERE purpose='answer'),
            CASE WHEN (SELECT groups.purpose FROM main.telegram_groups groups WHERE groups.id=group_id)='technical_alert'
              THEN 0 ELSE 1 END,
            1,1`
        copy("support_threads", `id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,
          latest_message_at,summary,origin_batch_id,operator_style_version_id,operator_style_profile_json,
          answer_model_instance_id,answer_reply_style,answer_timeout_seconds,answer_max_concurrency,
          answer_binding_enabled,answer_include_ai_memory,answer_include_interface_docs,answer_include_magic_book,
          answer_operation_mode,
          generation_started_at,progress_due_at,hard_deadline_at,human_priority_state,human_priority_user_ids_json,
          human_priority_due_at,human_priority_source_event_id,human_priority_progress_message_id,human_priority_error,
          closed_at,closed_by,closed_reason,created_at,updated_at`,
          `id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,summary,
          ${portableHasOriginBatchId ? "origin_batch_id" : "NULL"},
          ${portableHasThreadStylePin ? "operator_style_version_id,operator_style_profile_json" : `NULL,'${baselineOperatorStyleProfileSql}'`},
          ${answerPolicySelect},${portableHasThreadOperationMode ? "answer_operation_mode" : "'live'"},
          generation_started_at,progress_due_at,hard_deadline_at,
          ${portableHasHumanPriority
            ? "human_priority_state,human_priority_user_ids_json,human_priority_due_at,human_priority_source_event_id,human_priority_progress_message_id,human_priority_error"
            : "'none','[]',NULL,NULL,NULL,NULL"},
          closed_at,closed_by,closed_reason,created_at,updated_at`)
        copy("memory_maintenance_runs", "id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at")
        if (portableHasLearningSourceObservations) {
          copy("learning_source_observations", `id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,
            association_reason,association_confidence,takeover_status,classification,risk,processing_status,attempt_count,
            lock_token,locked_at,current_run_id,created_at,updated_at`,
          `id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,
            association_reason,association_confidence,takeover_status,classification,risk,processing_status,attempt_count,
            lock_token,locked_at,${portableHasObservationCurrentRunId ? "current_run_id" : "NULL"},created_at,updated_at`)
        }
        if (portableHasReferenceLearningResults) {
          copy("reference_learning_results", `id,run_id,observation_id,classification,action,risk,outcome,reason_code,
            memory_version_id,operator_style_version_id,created_at`)
        }
        normalizeRunningReferenceLearningRuns(
          this.database,
          "人工参考学习在迁移导入时中断",
          new Date().toISOString(),
          portableHasReferenceLearningResults,
        )
        if (portableHasOperatorStyle) {
          if (portableHasOperatorStyleSnapshots) {
            copy("operator_style_version_evidence", `id,operator_style_version_id,observation_id,
              source_telegram_user_id,thread_id`)
          } else {
            const evidence = this.database.prepare(`SELECT evidence.operator_style_version_id,evidence.observation_id,
              observation.source_telegram_user_id,observation.thread_id
              FROM portable.operator_style_version_evidence evidence
              JOIN portable.learning_source_observations observation ON observation.id=evidence.observation_id
              ORDER BY evidence.operator_style_version_id,evidence.observation_id`).all() as Array<{
              operator_style_version_id: string
              observation_id: string
              source_telegram_user_id: string
              thread_id: string
            }>
            const insertEvidence = this.database.prepare(`INSERT INTO main.operator_style_version_evidence(
              id,operator_style_version_id,observation_id,source_telegram_user_id,thread_id
            ) VALUES (?,?,?,?,?)`)
            evidence.forEach((row) => insertEvidence.run(
              randomUUID(), row.operator_style_version_id, row.observation_id, row.source_telegram_user_id, row.thread_id,
            ))
          }
        }
        copy("support_thread_messages", "thread_id,message_event_id,relation,question_fragment,position,created_at")
        if (portableHasThreadLinks) {
          copy("support_thread_links", "source_thread_id,target_thread_id,relation,reason,created_at")
        }
        if (portableHasSenderFocus) {
          copy("support_sender_focus", `group_id,service_id,sender_user_id,thread_id,source,last_operator_message_id,
            last_bot_message_id,focused_at,expires_at,created_at,updated_at`)
          copy("support_route_clarifications", `id,group_id,service_id,sender_user_id,message_event_id,
            candidate_thread_ids_json,candidate_labels_json,status,prompt_reply_id,selected_thread_id,
            created_at,expires_at,resolved_at,updated_at`)
        }
        copy("support_message_attachments", "id,message_event_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at")
        copy("support_thread_notifications", "id,thread_id,input_revision,kind,status,due_at,telegram_message_id,error_message,created_at,updated_at")
        copy("directives", "id,title,content,scope,source,priority,enabled,created_at,disabled_at", undefined, "WHERE source='human'")
        localSystemDirectives.forEach((directive) => this.database.insertDirective(directive))
        copy("memory_facts", "id,topic_key,title,current_version_id,created_at", "id,topic_key,title,NULL,created_at")
        copy("memory_events", "id,type,source_ref,fact_id,reply_record_id,content,scope,region,branch,code_revision,risk,confidence,actor,occurred_at")
        copy("memory_versions", "id,fact_id,version_number,title,content,content_hash,scope,region,branch,source,risk,confidence,status,conflict_reason,valid_from,valid_to,created_by_event_id,created_at")
        copy("memory_version_evidence", "memory_version_id,event_id")
        this.database.connection.exec(`UPDATE main.memory_facts SET current_version_id=(
          SELECT current_version_id FROM portable.memory_facts source WHERE source.id=main.memory_facts.id
        )`)
        copy("support_replies", "id,thread_id,input_revision,group_id,account_id,project_id,service_id,telegram_message_id,telegram_reply_message_id,service,decision,status,sender_user_id,sender_username,sender_display_name,sender_role,service_source,code_revision,code_snapshot_id,code_sync_batch_id,operator_delivery_status,created_at,updated_at,generation_started_at,heartbeat_at,duration_ms,error_code,decision_reason,decision_confidence,corrected_at",
          `id,thread_id,input_revision,group_id,CASE WHEN group_id IS NULL THEN NULL ELSE (SELECT account_id FROM main.telegram_groups g WHERE g.id=group_id) END,
          project_id,service_id,telegram_message_id,telegram_reply_message_id,service,decision,status,sender_user_id,sender_username,sender_display_name,sender_role,service_source,code_revision,
          ${portableHasServiceCodeTables ? "code_snapshot_id,code_sync_batch_id" : "NULL,NULL"},${portableHasOperatorDeliveryStatus ? "operator_delivery_status" : "NULL"},created_at,updated_at,generation_started_at,heartbeat_at,duration_ms,error_code,decision_reason,decision_confidence,corrected_at`)
        copy("support_reply_payloads", "reply_id,question,answer,quote_text,has_attachment")
        if (portableHasShadowLearning) {
          copy("shadow_answer_results", `id,reply_id,thread_id,input_revision,outcome_status,decision,answer,quote_text,
            reason,confidence,code_revision,memory_version_refs_json,simulated_action,output_redacted,error_code,created_at,updated_at`)
          copy("shadow_human_answer_links", `id,observation_id,human_message_event_id,thread_id,input_revision,
            shadow_result_id,match_reason,match_confidence,created_at`)
          copy("shadow_learning_reports", `id,trigger_type,due_at,cutoff_at,status,claim_token,attempt_count,sample_count,
            summary_json,rendered_markdown,error_message,started_at,completed_at,created_at,updated_at`,
            `id,trigger_type,due_at,cutoff_at,CASE WHEN status='running' THEN 'pending' ELSE status END,NULL,attempt_count,
            sample_count,summary_json,rendered_markdown,
            CASE WHEN status='running' THEN '迁移时报告生成中断，已重新排队' ELSE error_message END,
            CASE WHEN status='running' THEN NULL ELSE started_at END,
            CASE WHEN status='running' THEN NULL ELSE completed_at END,created_at,updated_at`)
          copy("shadow_comparisons", `id,report_id,shadow_result_id,thread_id,input_revision,
            question_snapshot,shadow_answer_snapshot,human_answers_json,
            human_message_event_ids_json,comparison_json,created_at`)
        } else {
          this.database.prepare(`INSERT INTO shadow_learning_reports(
            id,trigger_type,due_at,cutoff_at,status,claim_token,attempt_count,sample_count,
            summary_json,rendered_markdown,error_message,started_at,completed_at,created_at,updated_at
          ) VALUES ('00000000-0000-4000-8000-000000000029','scheduled',
            '2026-08-20T15:00:00.000Z','2026-08-20T15:00:00.000Z','pending',NULL,0,0,
            NULL,NULL,NULL,NULL,NULL,'2026-08-19T00:00:00.000Z','2026-08-19T00:00:00.000Z')`).run()
        }
        if (portableHasReplyAlertDeliveries) {
          copy("support_reply_alert_deliveries", "reply_id,alert_kind,status,created_at,updated_at",
            "reply_id,alert_kind,CASE WHEN status='sending' THEN 'uncertain' ELSE status END,created_at,updated_at")
        }
        if (portableHasTelegramOutputOwnership) {
          copy("telegram_output_ownership", `id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,
            thread_id,service_id,reply_id,notification_id,output_kind,delivery_status,request_key,content_sha256,
            reply_to_message_id,created_at,updated_at`,
          `id,CASE WHEN delivery_group_id IS NULL THEN NULL ELSE
              (SELECT account_id FROM main.telegram_groups groups WHERE groups.id=delivery_group_id) END,
            delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,notification_id,
            output_kind,CASE WHEN delivery_status='sending' THEN 'unknown' ELSE delivery_status END,request_key,
            content_sha256,reply_to_message_id,created_at,updated_at`)
        }
        if (portableHasTelegramOutgoingCandidates) {
          copy("telegram_outgoing_candidates", `id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at`,
            `id,ownership_id,telegram_message_id,
              CASE WHEN resolution_status='pending' THEN 'unknown' ELSE resolution_status END,created_at,updated_at`)
        }
        copy("reply_memory_refs", "reply_id,memory_version_id")
        copy("admin_chat_sessions", "id,project_id,service_id,created_by_user_id,title,created_at,updated_at",
          portableHasAdminChatOwner ? "id,project_id,service_id,created_by_user_id,title,created_at,updated_at" : "id,project_id,service_id,NULL,title,created_at,updated_at")
        copy("admin_chat_turns", "id,session_id,position,question,answer,decision,status,investigation_json,decision_reason,decision_confidence,code_revision,code_snapshot_id,code_sync_batch_id,memory_version_refs_json,error_code,created_at,updated_at,generation_started_at,completed_at")
        if (portableHasAdminChatAttachments && portableHasAdminChatCorrections) {
          copy("admin_chat_attachments", "id,turn_id,file_name,mime_type,file_size,kind,storage_path,extracted_text,created_at")
          copy("admin_chat_corrections", "id,turn_id,corrected_answer,reason,corrected_by,created_at")
        }
        if (portableHasReplyGenerationAudits) {
          copy("reply_generation_audits", `id,support_reply_id,admin_chat_turn_id,pipeline_version,mode,
            evidence_packet_json,baseline_answer,first_candidate_answer,revised_candidate_answer,reviews_json,
            final_source,fallback_reason,created_at`)
        }
        copy(
          "runtime_settings",
          "id,telegram_enabled,code_sync_enabled,auto_learning_enabled,learning_interval_seconds,learning_batch_size,message_debounce_ms,progress_notification_seconds,updated_at",
          portableHasProgressNotificationSeconds
            ? "id,telegram_enabled,code_sync_enabled,auto_learning_enabled,learning_interval_seconds,learning_batch_size,message_debounce_ms,progress_notification_seconds,updated_at"
            : "id,telegram_enabled,code_sync_enabled,auto_learning_enabled,learning_interval_seconds,learning_batch_size,message_debounce_ms,180,updated_at",
        )
        if (portableHasDailyGroupShutdownSchedule) {
          copy("daily_group_shutdown_schedule", `id,enabled,local_time,timezone,last_run_local_date,last_run_at,
            last_disabled_count,updated_at`)
        } else {
          this.database.prepare(`INSERT INTO daily_group_shutdown_schedule(
            id,enabled,local_time,timezone,last_run_local_date,last_run_at,last_disabled_count,updated_at
          ) VALUES (1,0,'23:00','Asia/Shanghai',NULL,NULL,0,?)`).run(new Date().toISOString())
        }
        const importedAt = new Date().toISOString()
        this.database.prepare(`INSERT INTO service_code_sync_schedule(
          service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,failure_count,last_alert_fingerprint,created_at,updated_at
        ) SELECT id,?,'never',NULL,NULL,0,NULL,?,? FROM project_services WHERE 1
        ON CONFLICT(service_id) DO UPDATE SET next_hourly_sync_at=excluded.next_hourly_sync_at,health_status='never',
          last_success_at=NULL,last_failure_at=NULL,failure_count=0,last_alert_fingerprint=NULL,
          updated_at=excluded.updated_at`).run(
          importedAt, importedAt, importedAt,
        )
        this.database.bumpMemoryGeneration()
        this.database.restoreSupportThreadMessageInvariant()
      })
    } finally {
      this.database.connection.exec("DETACH DATABASE portable")
    }
  }

  private validatePortable(portable: RuntimeDatabase): void {
    const integrity = portable.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("迁移数据库完整性检查失败")
    const schemaVersion = portable.schemaVersion()
    if (![12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].includes(schemaVersion)) {
      throw new Error("迁移数据库版本不兼容")
    }
    const existing = new Set((portable.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name))
    const shadowLearningTableCount = [
      "shadow_answer_results", "shadow_human_answer_links", "shadow_learning_reports", "shadow_comparisons",
    ].filter((table) => existing.has(table)).length
    if (shadowLearningTableCount !== 0 && shadowLearningTableCount !== 4) {
      throw new Error("迁移数据库影子学习结构谱系不完整")
    }
    const modelLineage = portableModelLineage(portable, existing)
    if (portableTables.some((table) => (
      table !== "learning_source_observations"
      && !(schemaVersion <= 29 && (
        table === "admin_users" || table === "admin_roles" || table === "admin_user_roles" || table === "admin_role_menus"
      ))
      && !(schemaVersion <= 22 && table === "reference_learning_results")
      && !(table === "admin_chat_attachments" || table === "admin_chat_corrections")
      && table !== "support_reply_alert_deliveries"
      && !(schemaVersion <= 21 && table === "telegram_output_ownership")
      && !(schemaVersion <= 21 && table === "telegram_outgoing_candidates")
      && !(schemaVersion <= 16 && (table === "operator_style_versions" || table === "operator_style_version_evidence"))
      && !(schemaVersion <= 24 && (
        table === "support_thread_links" || table === "support_sender_focus" || table === "support_route_clarifications"
      ))
      && !(schemaVersion <= 25 && table === "daily_group_shutdown_schedule")
      && !(schemaVersion <= 28 && ["shadow_answer_results", "shadow_human_answer_links", "shadow_learning_reports", "shadow_comparisons"].includes(table))
      && !(modelLineage === "legacy" && portableModelTables.includes(table as (typeof portableModelTables)[number]))
      && !existing.has(table)
    ))) throw new Error("迁移数据库结构不完整")
    const hasTelegramOutputOwnership = existing.has("telegram_output_ownership")
    const hasTelegramOutgoingCandidates = existing.has("telegram_outgoing_candidates")
    if (hasTelegramOutputOwnership !== hasTelegramOutgoingCandidates) {
      throw new Error("迁移数据库 Telegram 输出所有权结构不完整")
    }
    if (hasTelegramOutputOwnership) {
      assertTelegramOutputOwnershipRows(portable.connection)
    }
    const hasLearningObservations = existing.has("learning_source_observations")
    const observationColumns = hasLearningObservations
      ? (portable.prepare("PRAGMA table_info(learning_source_observations)").all() as Array<{ name: string }>).map((column) => column.name)
      : []
    const hasObservationCurrentRunId = observationColumns.includes("current_run_id")
    const hasReferenceLearningResults = existing.has("reference_learning_results")
    if (schemaVersion >= 23 && (!hasLearningObservations || !hasObservationCurrentRunId || !hasReferenceLearningResults)) {
      throw new Error("迁移数据库人工参考终态审计结构不完整")
    }
    if (schemaVersion <= 22 && (hasObservationCurrentRunId || hasReferenceLearningResults)) {
      throw new Error("迁移数据库人工参考终态审计谱系冲突")
    }
    if (schemaVersion >= 23) assertReferenceLearningAuditStructure(portable.connection)
    if ((portable.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
      throw new Error("迁移数据库外键关系损坏")
    }
    if (schemaVersion >= 23) {
      let lastResultRowId = 0
      while (true) {
        const results = portable.prepare(`SELECT rowid AS row_id,* FROM reference_learning_results
          WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastResultRowId) as Array<Record<string, unknown> & { row_id: number }>
        try {
          results.forEach((row) => referenceLearningResultRowSchema.parse({
            id: row.id,
            runId: row.run_id,
            observationId: row.observation_id,
            classification: row.classification,
            action: row.action,
            risk: row.risk,
            outcome: row.outcome,
            reasonCode: row.reason_code,
            memoryVersionId: row.memory_version_id,
            operatorStyleVersionId: row.operator_style_version_id,
            createdAt: row.created_at,
          }))
        } catch {
          throw new Error("迁移数据库人工参考终态结果格式错误")
        }
        if (results.length === 0) break
        lastResultRowId = Number(results.at(-1)?.row_id ?? lastResultRowId)
      }
      const invalidRunning = portable.prepare(`SELECT 1 FROM learning_source_observations observation
        LEFT JOIN memory_maintenance_runs run ON run.id=observation.current_run_id
        WHERE (observation.processing_status='running' AND (
          observation.lock_token IS NULL OR observation.locked_at IS NULL OR observation.current_run_id IS NULL
          OR run.status IS NOT 'running'
          OR EXISTS (SELECT 1 FROM reference_learning_results result
            WHERE result.run_id=observation.current_run_id AND result.observation_id=observation.id)
        )) OR (observation.processing_status!='running' AND observation.current_run_id IS NOT NULL)
        LIMIT 1`).get()
      const invalidRunningRun = portable.prepare(`SELECT 1 FROM memory_maintenance_runs run
        WHERE run.status='running' AND (
          run.scanned_events<=0 OR run.scanned_events<>(
            (SELECT COUNT(*) FROM reference_learning_results result WHERE result.run_id=run.id)
            + (SELECT COUNT(*) FROM learning_source_observations observation
              WHERE observation.processing_status='running' AND observation.current_run_id=run.id)
          )
        ) LIMIT 1`).get()
      if (invalidRunning || invalidRunningRun) throw new Error("迁移数据库人工参考运行状态关系损坏")
    }
    if (modelLineage === "legacy") {
      const profiles = portable.prepare(`SELECT purpose,model,reasoning_effort,timeout_seconds,max_concurrency,
        enabled,updated_at FROM model_profiles ORDER BY purpose`).all()
      try {
        const parsed = z.array(legacyModelProfileSchema).length(2).parse(profiles)
        if (parsed[0]?.purpose !== "answer" || parsed[1]?.purpose !== "memory") throw new Error("旧模型配置用途不完整")
      } catch {
        throw new Error("迁移数据库旧模型配置不完整")
      }
    }
    const hasStyleVersions = existing.has("operator_style_versions")
    const hasStyleEvidence = existing.has("operator_style_version_evidence")
    if (hasStyleVersions !== hasStyleEvidence || (schemaVersion >= 17 && !hasStyleVersions)) {
      throw new Error("迁移数据库风格结构不完整")
    }
    const styleEvidenceColumns = hasStyleEvidence
      ? (portable.prepare("PRAGMA table_info(operator_style_version_evidence)").all() as Array<{ name: string }>).map((column) => column.name)
      : []
    if (schemaVersion >= 18) {
      const expectedColumns = ["id", "operator_style_version_id", "observation_id", "source_telegram_user_id", "thread_id"]
      if (styleEvidenceColumns.length !== expectedColumns.length
        || expectedColumns.some((column) => !styleEvidenceColumns.includes(column))) {
        throw new Error("迁移数据库风格证据结构不完整")
      }
      let lastEvidenceRowId = 0
      while (true) {
        const evidence = portable.prepare(`SELECT rowid AS row_id,* FROM operator_style_version_evidence
          WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastEvidenceRowId) as Array<Record<string, unknown> & { row_id: number }>
        try {
          evidence.forEach((row) => operatorStyleEvidenceSnapshotSchema.parse({
            id: row.id,
            operatorStyleVersionId: row.operator_style_version_id,
            observationId: row.observation_id,
            sourceTelegramUserId: row.source_telegram_user_id,
            threadId: row.thread_id,
          }))
        } catch {
          throw new Error("迁移数据库风格证据行格式错误")
        }
        if (evidence.length === 0) break
        lastEvidenceRowId = Number(evidence.at(-1)?.row_id ?? lastEvidenceRowId)
      }
      const inconsistentLiveSnapshot = portable.prepare(`SELECT 1
        FROM operator_style_version_evidence evidence
        JOIN learning_source_observations observation ON observation.id=evidence.observation_id
        WHERE evidence.source_telegram_user_id IS NOT observation.source_telegram_user_id
          OR evidence.thread_id IS NOT observation.thread_id LIMIT 1`).get()
      if (inconsistentLiveSnapshot) throw new Error("迁移数据库风格证据快照不一致")
    } else if (schemaVersion === 17
      && (styleEvidenceColumns.length !== 2
        || !styleEvidenceColumns.includes("operator_style_version_id")
        || !styleEvidenceColumns.includes("observation_id"))) {
      throw new Error("迁移数据库风格证据结构不完整")
    }
    const hasStyleVersionRows = hasStyleVersions && Boolean(portable.prepare(
      "SELECT 1 FROM operator_style_versions LIMIT 1",
    ).get())
    if (hasStyleVersionRows && !existing.has("learning_source_observations")) {
      throw new Error("迁移数据库风格证据缺少观察依赖")
    }
    const hasLearningSourceRole = (portable.prepare("PRAGMA table_info(telegram_roles)").all() as Array<{ name: string }>)
      .some((column) => column.name === "learning_source_enabled")
    if (hasLearningSourceRole && !existing.has("learning_source_observations")) throw new Error("迁移数据库结构不完整")
    const hasOperatorDeliveryStatus = (portable.prepare("PRAGMA table_info(support_replies)").all() as Array<{ name: string }>)
      .some((column) => column.name === "operator_delivery_status")
    if (hasOperatorDeliveryStatus && !existing.has("support_reply_alert_deliveries")) throw new Error("迁移数据库结构不完整")
    if (hasStyleVersionRows) {
      let lastStyleRowId = 0
      while (true) {
        const evidenceSourceUserCount = schemaVersion >= 18
          ? `SELECT COUNT(DISTINCT evidence.source_telegram_user_id)
            FROM operator_style_version_evidence evidence
            WHERE evidence.operator_style_version_id=operator_style_versions.id`
          : `SELECT COUNT(DISTINCT observation.source_telegram_user_id)
            FROM operator_style_version_evidence evidence
            JOIN learning_source_observations observation ON observation.id=evidence.observation_id
            WHERE evidence.operator_style_version_id=operator_style_versions.id`
        const evidenceThreadCount = schemaVersion >= 18
          ? `SELECT COUNT(DISTINCT evidence.thread_id)
            FROM operator_style_version_evidence evidence
            WHERE evidence.operator_style_version_id=operator_style_versions.id`
          : `SELECT COUNT(DISTINCT observation.thread_id)
            FROM operator_style_version_evidence evidence
            JOIN learning_source_observations observation ON observation.id=evidence.observation_id
            WHERE evidence.operator_style_version_id=operator_style_versions.id AND observation.thread_id IS NOT NULL`
        const versions = portable.prepare(`SELECT rowid AS row_id,*,(
          SELECT COUNT(*) FROM operator_style_version_evidence evidence
          WHERE evidence.operator_style_version_id=operator_style_versions.id
        ) AS evidence_count,(${evidenceSourceUserCount}) AS evidence_source_user_count,
        (${evidenceThreadCount}) AS evidence_thread_count FROM operator_style_versions
          WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastStyleRowId) as Array<Record<string, unknown> & { row_id: number }>
        try {
          versions.forEach((row) => {
            const profile = operatorStyleProfileSchema.parse(JSON.parse(String(row.profile_json)))
            const version = operatorStyleVersionSchema.parse({
              id: row.id,
              version: Number(row.version_number),
              profile,
              status: row.status,
              sampleCount: Number(row.sample_count),
              sourceUserCount: Number(row.source_user_count),
              threadCount: Number(row.thread_count),
              createdAt: row.created_at,
              activatedAt: row.activated_at,
              supersededAt: row.superseded_at,
            })
            if (Number(row.evidence_count) !== version.sampleCount) throw new Error("风格版本证据数量不一致")
            if (Number(row.evidence_source_user_count) !== version.sourceUserCount
              || Number(row.evidence_thread_count) !== version.threadCount) {
              throw new Error("风格版本证据来源计数不一致")
            }
          })
        } catch {
          throw new Error("迁移数据库风格 profile 格式错误")
        }
        if (versions.length === 0) break
        lastStyleRowId = Number(versions.at(-1)?.row_id ?? lastStyleRowId)
      }
    }
    const supportThreadColumns = (portable.prepare("PRAGMA table_info(support_threads)").all() as Array<{ name: string }>)
      .map((column) => column.name)
    const hasThreadStyleVersion = supportThreadColumns.includes("operator_style_version_id")
    const hasThreadStyleProfile = supportThreadColumns.includes("operator_style_profile_json")
    if (hasThreadStyleVersion !== hasThreadStyleProfile || (schemaVersion >= 19 && !hasThreadStyleVersion)) {
      throw new Error("迁移数据库线程风格快照结构不完整")
    }
    if (hasThreadStyleVersion) {
      let lastThreadRowId = 0
      while (true) {
        const threads = portable.prepare(`SELECT rowid AS row_id,operator_style_version_id,operator_style_profile_json
          FROM support_threads WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastThreadRowId) as Array<{
          row_id: number
          operator_style_version_id: string | null
          operator_style_profile_json: string
        }>
        try {
          threads.forEach((thread) => {
            const snapshot = operatorStyleProfileSchema.parse(JSON.parse(thread.operator_style_profile_json))
            // 版本受 retention 清理后 FK 会置空，但线程必须继续保留当时固定的有效快照。
            if (thread.operator_style_version_id === null) return
            const version = portable.prepare("SELECT profile_json FROM operator_style_versions WHERE id=?").get(
              thread.operator_style_version_id,
            ) as { profile_json: string } | undefined
            if (!version) throw new Error("线程风格版本不存在")
            const versionProfile = operatorStyleProfileSchema.parse(JSON.parse(version.profile_json))
            if (JSON.stringify(snapshot) !== JSON.stringify(versionProfile)) throw new Error("线程风格快照与版本不一致")
          })
        } catch {
          throw new Error("迁移数据库线程风格快照格式错误")
        }
        if (threads.length === 0) break
        lastThreadRowId = Number(threads.at(-1)?.row_id ?? lastThreadRowId)
      }
    }
    const threadAnswerPolicyColumns = [
      "answer_model_instance_id", "answer_reply_style", "answer_timeout_seconds", "answer_max_concurrency",
      "answer_binding_enabled", "answer_include_ai_memory", "answer_include_interface_docs", "answer_include_magic_book",
    ]
    const threadAnswerPolicyColumnCount = threadAnswerPolicyColumns.filter((column) => supportThreadColumns.includes(column)).length
    if (threadAnswerPolicyColumnCount !== 0 && threadAnswerPolicyColumnCount !== threadAnswerPolicyColumns.length) {
      throw new Error("迁移数据库线程回答策略快照结构不完整")
    }
    if (schemaVersion >= 21 && threadAnswerPolicyColumnCount !== threadAnswerPolicyColumns.length) {
      throw new Error("迁移数据库线程回答策略快照结构不完整")
    }
    const invalidPath = portable.prepare(`SELECT 1 FROM service_code_snapshot_items
      WHERE relative_path NOT IN ('java-project','sfzf-web') LIMIT 1`).get()
    if (invalidPath) throw new Error("迁移数据库包含无效代码快照路径")
    const accountCount = Number((portable.prepare("SELECT COUNT(*) AS total FROM telegram_accounts").get() as { total: number }).total)
    if (accountCount !== 0) throw new Error("迁移数据库包含客服账号凭据")
    const boundGroupCount = Number((portable.prepare("SELECT COUNT(*) AS total FROM telegram_groups WHERE account_id IS NOT NULL").get() as { total: number }).total)
    if (boundGroupCount !== 0) throw new Error("迁移数据库包含本机账号绑定")
    if (modelLineage === "modern") {
      const apiCredentialCount = Number((portable.prepare(`SELECT COUNT(*) AS total FROM model_instances
        WHERE transport='direct_api' AND (credentials IS NOT NULL OR enabled!=0)`).get() as { total: number }).total)
      if (apiCredentialCount !== 0) throw new Error("迁移数据库包含模型 API 凭据")
      const catalogCount = Number((portable.prepare("SELECT COUNT(*) AS total FROM model_catalog_entries").get() as { total: number }).total)
      if (catalogCount !== 0) throw new Error("迁移数据库包含本机模型目录缓存")
    }
    let lastVersionRowId = 0
    while (true) {
      const versions = portable.prepare("SELECT rowid AS row_id,content,content_hash FROM memory_versions WHERE rowid>? ORDER BY rowid LIMIT 2000").all(lastVersionRowId) as Array<{ row_id: number; content: string; content_hash: string }>
      if (versions.some((row) => sha256(row.content) !== row.content_hash)) throw new Error("迁移数据库记忆哈希损坏")
      if (versions.length === 0) break
      lastVersionRowId = Number(versions.at(-1)?.row_id ?? lastVersionRowId)
    }
    const invalidCurrent = portable.prepare(`SELECT 1 FROM memory_facts f
      LEFT JOIN memory_versions v ON v.id=f.current_version_id
      WHERE f.current_version_id IS NOT NULL AND (v.id IS NULL OR v.fact_id!=f.id OR v.status!='active') LIMIT 1`).get()
    const unpointedActive = portable.prepare(`SELECT 1 FROM memory_versions v JOIN memory_facts f ON f.id=v.fact_id
      WHERE v.status='active' AND f.current_version_id IS NOT v.id LIMIT 1`).get()
    if (invalidCurrent || unpointedActive) throw new Error("迁移数据库记忆关系损坏")
    assertPortableSafe(portable)
  }
}
