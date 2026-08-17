import { randomUUID } from "node:crypto"

import { z } from "zod"

import { redactText } from "../security/dlp.js"
import type { RuntimeDatabase } from "./database.js"
import type { LocalSecretVault } from "./secret-vault.js"
import {
  encryptedValueSchema,
  modelInstanceRecordSchema,
  modelProfileRecordSchema,
  modelProviderSchema,
  modelPurposeSchema,
  modelReasoningEffortSchema,
  modelServiceTierSchema,
  modelTransportSchema,
  reasoningEffortSchema,
  runtimeModelBindingSchema,
  runtimeSettingsRecordSchema,
  type EncryptedValue,
  type ModelInstanceRecord,
  type ModelProfileRecord,
  type ModelProvider,
  type ModelPurpose,
  type ModelTransport,
  type RuntimeModelBinding,
  type RuntimeSettingsRecord,
} from "./types.js"

const safeModel = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const aliasSchema = z.string().trim().min(1).max(80)
const apiKeySchema = z.string().trim().min(8).max(1000)
const modelParametersSchema = z.object({
  maxOutputTokens: z.number().int().min(1).max(262144).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  verbosity: z.enum(["low", "medium", "high"]).optional(),
  thinking: z.boolean().optional(),
}).strict()

const createModelInstanceSchema = z.object({
  alias: aliasSchema,
  provider: modelProviderSchema,
  transport: modelTransportSchema,
  modelId: safeModel,
  reasoningEffort: modelReasoningEffortSchema.default(null),
  serviceTier: modelServiceTierSchema.default(null),
  parameters: modelParametersSchema.default({}),
  apiKey: apiKeySchema.optional(),
  enabled: z.boolean().default(false),
}).strict()

const updateModelInstanceSchema = z.object({
  alias: aliasSchema.optional(),
  provider: modelProviderSchema.optional(),
  transport: modelTransportSchema.optional(),
  modelId: safeModel.optional(),
  reasoningEffort: modelReasoningEffortSchema.optional(),
  serviceTier: modelServiceTierSchema.optional(),
  parameters: modelParametersSchema.optional(),
  apiKey: apiKeySchema.optional(),
  clearCredentials: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict()

const bindingUpdateSchema = z.object({
  modelInstanceId: z.string().uuid().optional(),
  timeoutSeconds: z.number().int().min(30).max(3600).optional(),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  enabled: z.boolean().optional(),
}).strict()

const profileUpdateSchema = z.object({
  model: safeModel.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  timeoutSeconds: z.number().int().min(30).max(3600).optional(),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  enabled: z.boolean().optional(),
}).strict()

const settingsUpdateSchema = z.object({
  telegramEnabled: z.boolean().optional(),
  codeSyncEnabled: z.boolean().optional(),
  autoLearningEnabled: z.boolean().optional(),
  learningIntervalSeconds: z.number().int().min(30).max(86400).optional(),
  learningBatchSize: z.number().int().min(2).max(50).optional(),
  messageDebounceMs: z.number().int().min(0).max(300000).optional(),
  progressNotificationSeconds: z.number().int().min(30).max(3600).optional(),
  dailyGroupShutdownEnabled: z.boolean().optional(),
  dailyGroupShutdownTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).optional(),
}).strict()

export type CreateModelInstanceInput = z.input<typeof createModelInstanceSchema>
export type UpdateModelInstanceInput = z.input<typeof updateModelInstanceSchema>
export type UpdateRuntimeModelBindingInput = z.input<typeof bindingUpdateSchema>

export type ModelInstanceSnapshot = Omit<ModelInstanceRecord, "credentialsConfigured" | "credentialHint"> & {
  apiKey: string | null
}

type Row = Record<string, unknown>

function parseEncrypted(value: unknown): EncryptedValue | null {
  if (value === null || value === undefined || value === "") return null
  return encryptedValueSchema.parse(JSON.parse(String(value)))
}

function parseParameters(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value ?? "{}")) as unknown
  return modelParametersSchema.parse(parsed)
}

function binding(row: Row): RuntimeModelBinding {
  return runtimeModelBindingSchema.parse({
    purpose: row.purpose,
    modelInstanceId: row.model_instance_id,
    timeoutSeconds: Number(row.timeout_seconds),
    maxConcurrency: Number(row.max_concurrency),
    enabled: Number(row.enabled) === 1,
    updatedAt: row.updated_at,
  })
}

function settings(row: Row, schedule: Row): RuntimeSettingsRecord {
  return runtimeSettingsRecordSchema.parse({
    telegramEnabled: Number(row.telegram_enabled) === 1,
    codeSyncEnabled: true,
    autoLearningEnabled: Number(row.auto_learning_enabled) === 1,
    learningIntervalSeconds: Number(row.learning_interval_seconds),
    learningBatchSize: Number(row.learning_batch_size),
    messageDebounceMs: Number(row.message_debounce_ms),
    progressNotificationSeconds: Number(row.progress_notification_seconds),
    dailyGroupShutdownEnabled: Number(schedule.enabled) === 1,
    dailyGroupShutdownTime: schedule.local_time,
    dailyGroupShutdownTimezone: schedule.timezone,
    dailyGroupShutdownLastRunAt: schedule.last_run_at,
    dailyGroupShutdownLastDisabledCount: Number(schedule.last_disabled_count),
    updatedAt: row.updated_at,
  })
}

function assertSafeLabel(value: string): void {
  if (redactText(value).changed) throw new Error("模型配置包含敏感信息")
}

function providerLabel(provider: ModelProvider): string {
  return ({ openai: "ChatGPT / OpenAI", deepseek: "DeepSeek", anthropic: "Claude", glm: "GLM" })[provider]
}

function validateConnection(
  provider: ModelProvider,
  transport: ModelTransport,
  serviceTier: "standard" | "fast" | "priority" | null,
  hasCredential: boolean,
  enabled: boolean,
): void {
  if (transport === "codex_cli" && provider !== "openai") throw new Error(`${providerLabel(provider)} 仅支持 API 密钥接入`)
  if (transport === "codex_cli" && serviceTier === "priority") throw new Error("Codex CLI 不支持 Priority 加速")
  if (transport === "direct_api" && serviceTier === "fast") throw new Error("API 密钥接入不支持 Codex Fast")
  if (transport === "direct_api" && provider !== "openai" && serviceTier === "priority") throw new Error(`${providerLabel(provider)} 不支持 Priority 加速`)
  if (transport === "direct_api" && enabled && !hasCredential) throw new Error("启用 API 模型前必须配置密钥")
}

export class ModelConfigService {
  private activeExecutionChecker: (id: string) => boolean = () => false
  constructor(
    readonly database: RuntimeDatabase,
    private readonly vault?: LocalSecretVault,
  ) {}

  listModelInstances(): ModelInstanceRecord[] {
    return (this.database.prepare("SELECT * FROM model_instances ORDER BY alias COLLATE NOCASE,id").all() as Row[])
      .map((row) => this.publicInstance(row))
  }

  getModelInstance(id: string): ModelInstanceRecord {
    const row = this.requireInstanceRow(id)
    return this.publicInstance(row)
  }

  getModelInstanceSnapshot(id: string): ModelInstanceSnapshot {
    const row = this.requireInstanceRow(id)
    const publicRecord = this.publicInstance(row)
    const { credentialsConfigured: _configured, credentialHint: _hint, ...safe } = publicRecord
    return { ...safe, apiKey: this.openApiKey(row.credentials) }
  }

  createModelInstance(input: CreateModelInstanceInput): ModelInstanceRecord {
    const parsed = createModelInstanceSchema.parse(input)
    assertSafeLabel(parsed.alias)
    assertSafeLabel(parsed.modelId)
    const encrypted = parsed.apiKey ? this.sealApiKey(parsed.apiKey) : null
    validateConnection(parsed.provider, parsed.transport, parsed.serviceTier, Boolean(encrypted), parsed.enabled)
    const now = new Date().toISOString()
    const id = randomUUID()
    try {
      this.database.prepare(`INSERT INTO model_instances(
        id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
        enabled,health_status,health_message,last_checked_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'not_tested','尚未检测',NULL,?,?)`).run(
        id, parsed.alias, parsed.provider, parsed.transport, parsed.modelId, parsed.reasoningEffort, parsed.serviceTier,
        JSON.stringify(parsed.parameters), encrypted ? JSON.stringify(encrypted) : null, Number(parsed.enabled), now, now,
      )
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: model_instances.alias")) throw new Error("模型别名不能重复")
      throw error
    }
    return this.getModelInstance(id)
  }

  updateModelInstance(id: string, input: UpdateModelInstanceInput): ModelInstanceRecord {
    const update = updateModelInstanceSchema.parse(input)
    const row = this.requireInstanceRow(id)
    const unclosedThreadCount = this.unclosedThreadReferenceCount(id)
    if (unclosedThreadCount > 0) throw new Error(`模型别名仍被未关闭问题线程引用：${unclosedThreadCount} 条`)
    const current = this.publicInstance(row)
    const next = {
      alias: update.alias ?? current.alias,
      provider: update.provider ?? current.provider,
      transport: update.transport ?? current.transport,
      modelId: update.modelId ?? current.modelId,
      reasoningEffort: update.reasoningEffort === undefined ? current.reasoningEffort : update.reasoningEffort,
      serviceTier: update.serviceTier === undefined ? current.serviceTier : update.serviceTier,
      parameters: update.parameters ?? current.parameters,
      enabled: update.enabled ?? current.enabled,
    }
    const encrypted = next.transport === "codex_cli" || update.clearCredentials
      ? null
      : update.apiKey
        ? this.sealApiKey(update.apiKey)
        : next.provider !== current.provider || current.transport !== "direct_api"
          ? null
          : parseEncrypted(row.credentials)
    assertSafeLabel(next.alias)
    assertSafeLabel(next.modelId)
    validateConnection(next.provider, next.transport, next.serviceTier, Boolean(encrypted), next.enabled)
    const changedConnection = next.provider !== current.provider || next.transport !== current.transport
      || next.modelId !== current.modelId || next.reasoningEffort !== current.reasoningEffort
      || next.serviceTier !== current.serviceTier || JSON.stringify(next.parameters) !== JSON.stringify(current.parameters)
      || update.apiKey !== undefined || Boolean(update.clearCredentials)
    const now = new Date().toISOString()
    try {
      this.database.prepare(`UPDATE model_instances SET
        alias=?,provider=?,transport=?,model_id=?,reasoning_effort=?,service_tier=?,parameters_json=?,credentials=?,enabled=?,
        health_status=?,health_message=?,last_checked_at=?,updated_at=? WHERE id=?`).run(
        next.alias, next.provider, next.transport, next.modelId, next.reasoningEffort, next.serviceTier,
        JSON.stringify(modelParametersSchema.parse(next.parameters)), encrypted ? JSON.stringify(encrypted) : null, Number(next.enabled),
        changedConnection ? "not_tested" : current.healthStatus, changedConnection ? "配置已更新，请重新检测" : current.healthMessage,
        changedConnection ? null : current.lastCheckedAt, now, id,
      )
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: model_instances.alias")) throw new Error("模型别名不能重复")
      throw error
    }
    return this.getModelInstance(id)
  }

  updateModelHealth(id: string, input: { status: "ready" | "error"; message: string }): ModelInstanceRecord {
    const message = input.message.trim().slice(0, 240)
    if (redactText(message).changed) throw new Error("模型检测结果包含敏感信息")
    const now = new Date().toISOString()
    const result = this.database.prepare(`UPDATE model_instances SET health_status=?,health_message=?,last_checked_at=?,updated_at=? WHERE id=?`)
      .run(input.status, message, now, now, id)
    if (Number(result.changes) === 0) throw new Error("模型别名不存在")
    return this.getModelInstance(id)
  }

  deleteModelInstance(id: string): void {
    this.requireInstanceRow(id)
    const references: string[] = []
    const bindingRows = this.database.prepare("SELECT purpose FROM runtime_model_bindings WHERE model_instance_id=? ORDER BY purpose").all(id) as Row[]
    bindingRows.forEach((row) => references.push(row.purpose === "answer" ? "运行配置：回答模型" : "运行配置：记忆模型"))
    const groupRows = this.database.prepare("SELECT name FROM telegram_groups WHERE ai_model_instance_id=? ORDER BY name").all(id) as Row[]
    groupRows.forEach((row) => references.push(`白名单群：${String(row.name)}`))
    const unclosedThreadCount = this.unclosedThreadReferenceCount(id)
    if (unclosedThreadCount > 0) references.push(`未关闭问题线程：${unclosedThreadCount} 条`)
    if (references.length > 0) throw new Error(`模型别名仍被引用 ${references.join("、")}`)
    if (this.activeExecutionChecker(id)) throw new Error("模型别名仍有运行中的任务")
    this.database.prepare("DELETE FROM model_instances WHERE id=?").run(id)
  }

  setActiveExecutionChecker(checker: (id: string) => boolean): void {
    this.activeExecutionChecker = checker
  }

  private unclosedThreadReferenceCount(id: string): number {
    return Number((this.database.prepare(`SELECT COUNT(*) AS count FROM support_threads
      WHERE answer_model_instance_id=? AND status<>'closed'`).get(id) as { count: number }).count)
  }

  listBindings(): RuntimeModelBinding[] {
    return (this.database.prepare("SELECT * FROM runtime_model_bindings ORDER BY purpose").all() as Row[]).map(binding)
  }

  getBinding(purpose: ModelPurpose): RuntimeModelBinding {
    const parsedPurpose = modelPurposeSchema.parse(purpose)
    const row = this.database.prepare("SELECT * FROM runtime_model_bindings WHERE purpose=?").get(parsedPurpose) as Row | undefined
    if (!row) throw new Error("运行模型绑定不存在")
    return binding(row)
  }

  updateBinding(purpose: ModelPurpose, input: UpdateRuntimeModelBindingInput): RuntimeModelBinding {
    const parsedPurpose = modelPurposeSchema.parse(purpose)
    const current = this.getBinding(parsedPurpose)
    const update = bindingUpdateSchema.parse(input)
    const definedUpdate = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined))
    const next = runtimeModelBindingSchema.parse({ ...current, ...definedUpdate, updatedAt: new Date().toISOString() })
    const instance = this.getModelInstance(next.modelInstanceId)
    if (!instance.enabled) throw new Error("运行配置只能选择已启用模型")
    this.database.prepare(`UPDATE runtime_model_bindings SET
      model_instance_id=?,timeout_seconds=?,max_concurrency=?,enabled=?,updated_at=? WHERE purpose=?`).run(
      next.modelInstanceId, next.timeoutSeconds, next.maxConcurrency, Number(next.enabled), next.updatedAt, parsedPurpose,
    )
    return next
  }

  listProfiles(): ModelProfileRecord[] {
    return this.listBindings().map((item) => this.getProfile(item.purpose))
  }

  getProfile(purpose: ModelPurpose): ModelProfileRecord {
    const item = this.getBinding(purpose)
    const instance = this.getModelInstance(item.modelInstanceId)
    return modelProfileRecordSchema.parse({
      purpose: item.purpose,
      model: instance.modelId,
      reasoningEffort: instance.reasoningEffort ?? "minimal",
      timeoutSeconds: item.timeoutSeconds,
      maxConcurrency: item.maxConcurrency,
      enabled: item.enabled && instance.enabled,
      updatedAt: item.updatedAt,
    })
  }

  updateProfile(purpose: ModelPurpose, input: unknown): ModelProfileRecord {
    const update = profileUpdateSchema.parse(input)
    const item = this.getBinding(purpose)
    if (update.model || update.reasoningEffort) this.updateModelInstance(item.modelInstanceId, {
      modelId: update.model,
      reasoningEffort: update.reasoningEffort,
    })
    this.updateBinding(purpose, {
      timeoutSeconds: update.timeoutSeconds,
      maxConcurrency: update.maxConcurrency,
      enabled: update.enabled,
    })
    return this.getProfile(purpose)
  }

  listConfiguredSecrets(): string[] {
    return (this.database.prepare("SELECT credentials FROM model_instances WHERE credentials IS NOT NULL").all() as Row[])
      .map((row) => this.openApiKey(row.credentials))
      .filter((value): value is string => Boolean(value))
  }

  getSettings(): RuntimeSettingsRecord {
    const row = this.database.prepare("SELECT * FROM runtime_settings WHERE id=1").get() as Row | undefined
    const schedule = this.database.prepare("SELECT * FROM daily_group_shutdown_schedule WHERE id=1").get() as Row | undefined
    if (!row || !schedule) throw new Error("运行配置不存在")
    return settings(row, schedule)
  }

  updateSettings(input: unknown): RuntimeSettingsRecord {
    const current = this.getSettings()
    const update = settingsUpdateSchema.parse(input)
    const next = runtimeSettingsRecordSchema.parse({ ...current, ...update, codeSyncEnabled: true, updatedAt: new Date().toISOString() })
    const dailyGroupShutdownTimeChanged = current.dailyGroupShutdownTime !== next.dailyGroupShutdownTime
    this.database.transaction(() => {
      this.database.prepare(`UPDATE runtime_settings SET
        telegram_enabled=?,code_sync_enabled=?,auto_learning_enabled=?,learning_interval_seconds=?,
        learning_batch_size=?,message_debounce_ms=?,progress_notification_seconds=?,updated_at=? WHERE id=1`).run(
        Number(next.telegramEnabled), Number(next.codeSyncEnabled), Number(next.autoLearningEnabled),
        next.learningIntervalSeconds, next.learningBatchSize, next.messageDebounceMs,
        next.progressNotificationSeconds, next.updatedAt,
      )
      this.database.prepare(`UPDATE daily_group_shutdown_schedule
        SET enabled=?,local_time=?,
          last_run_local_date=CASE WHEN ?=1 THEN NULL ELSE last_run_local_date END,
          updated_at=? WHERE id=1`).run(
        Number(next.dailyGroupShutdownEnabled), next.dailyGroupShutdownTime,
        Number(dailyGroupShutdownTimeChanged), next.updatedAt,
      )
    })
    return next
  }

  private publicInstance(row: Row): ModelInstanceRecord {
    const apiKey = this.openApiKey(row.credentials)
    return modelInstanceRecordSchema.parse({
      id: row.id,
      alias: row.alias,
      provider: row.provider,
      transport: row.transport,
      modelId: row.model_id,
      reasoningEffort: row.reasoning_effort,
      serviceTier: row.service_tier,
      parameters: parseParameters(row.parameters_json),
      credentialsConfigured: Boolean(apiKey),
      credentialHint: apiKey ? `••••${apiKey.slice(-4)}` : "",
      enabled: Number(row.enabled) === 1,
      healthStatus: row.health_status,
      healthMessage: row.health_message,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  }

  private requireInstanceRow(id: string): Row {
    const parsed = z.string().uuid().parse(id)
    const row = this.database.prepare("SELECT * FROM model_instances WHERE id=?").get(parsed) as Row | undefined
    if (!row) throw new Error("模型别名不存在")
    return row
  }

  private sealApiKey(apiKey: string): EncryptedValue {
    if (!this.vault) throw new Error("本机模型密钥库未配置")
    return this.vault.sealJson({ apiKey: apiKeySchema.parse(apiKey) })
  }

  private openApiKey(value: unknown): string | null {
    const encrypted = parseEncrypted(value)
    if (!encrypted) return null
    if (!this.vault) return null
    const credentials = this.vault.openJson<{ apiKey?: string }>(encrypted)
    return credentials.apiKey ? apiKeySchema.parse(credentials.apiKey) : null
  }
}
