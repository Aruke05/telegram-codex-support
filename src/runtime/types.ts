import { z } from "zod"

import { isSafeSshHost, isSafeSshUsername } from "../security/ssh-target.js"
import { operatorStyleProfileSchema } from "../support/operator-style.js"

export const encryptedValueSchema = z.object({
  algorithm: z.literal("aes-256-gcm"),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict()

export type EncryptedValue = z.infer<typeof encryptedValueSchema>

export const telegramAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(["bot", "user"]),
  enabled: z.boolean(),
  status: z.enum(["not_tested", "ready", "error", "login_required"]),
  statusMessage: z.string().max(200),
  credentials: encryptedValueSchema,
  botUsername: z.string().max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const groupOperationModeSchema = z.enum(["live", "learning"])

export const runtimeGroupSchema = z.object({
  id: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  telegramChatId: z.string().regex(/^-?\d+$/).nullable(),
  accountId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  serviceId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  accessMode: z.enum(["bot", "user"]),
  triggerMode: z.enum(["all", "command"]),
  platform: z.string().trim().min(1).max(80),
  repositories: z.array(z.enum(["java-project", "sfzf-web"])),
  branch: z.string().trim().min(1).max(120).nullable(),
  serverAlias: z.string().trim().min(1).max(120).nullable(),
  databaseAlias: z.string().trim().min(1).max(120),
  knowledgeScope: z.string().trim().min(1).max(120),
  purpose: z.enum(["support", "technical_alert"]),
  aiModelInstanceId: z.string().uuid().nullable(),
  replyStyle: z.enum(["human", "unrestricted"]),
  operationMode: groupOperationModeSchema.default("live"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const projectRecordSchema = z.object({
  id: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000),
  enabled: z.boolean(),
  defaultKnowledgeScope: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const projectRepositoryRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  localPath: z.string().max(1000),
  remoteUrl: z.string().max(1000),
  branch: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const codeRepositoryRoleSchema = z.enum(["backend", "frontend"])

export const projectServiceRepositoryBindingRecordSchema = z.object({
  serviceId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  role: codeRepositoryRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const projectServiceRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  region: z.string().max(120),
  timezone: z.string().max(120),
  repositoryId: z.string().uuid().nullable(),
  branch: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const serverResourceRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  serviceId: z.string().uuid(),
  alias: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255).refine(isSafeSshHost, "SSH 主机格式无效"),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(120).refine(isSafeSshUsername, "SSH 用户名格式无效"),
  privateKey: z.string().min(1).max(100000),
  workdir: z.string().trim().min(1).max(1000),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const databaseResourceRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  serviceId: z.string().uuid(),
  alias: z.string().trim().min(1).max(120),
  engine: z.literal("mysql"),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(10000),
  timezone: z.string().max(120),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const modelPurposeSchema = z.enum(["answer", "memory"])
export const modelProviderSchema = z.enum(["openai", "deepseek", "anthropic", "glm"])
export const modelTransportSchema = z.enum(["codex_cli", "direct_api"])
export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
export const modelReasoningEffortSchema = reasoningEffortSchema.nullable()
export const modelServiceTierSchema = z.enum(["standard", "fast", "priority"]).nullable()
export const modelHealthStatusSchema = z.enum(["not_tested", "ready", "error"])
export const replyStyleSchema = z.enum(["human", "unrestricted"])
export const modelInstanceRecordSchema = z.object({
  id: z.string().uuid(),
  alias: z.string().trim().min(1).max(80),
  provider: modelProviderSchema,
  transport: modelTransportSchema,
  modelId: z.string().trim().min(1).max(160),
  reasoningEffort: modelReasoningEffortSchema,
  serviceTier: modelServiceTierSchema,
  parameters: z.record(z.string(), z.json()),
  credentialsConfigured: z.boolean(),
  credentialHint: z.string().max(40),
  enabled: z.boolean(),
  healthStatus: modelHealthStatusSchema,
  healthMessage: z.string().max(240),
  lastCheckedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
export const runtimeModelBindingSchema = z.object({
  purpose: modelPurposeSchema,
  modelInstanceId: z.string().uuid(),
  timeoutSeconds: z.number().int().min(30).max(3600),
  maxConcurrency: z.number().int().min(1).max(8),
  enabled: z.boolean(),
  updatedAt: z.string().datetime(),
}).strict()
export const modelProfileRecordSchema = z.object({
  purpose: modelPurposeSchema,
  model: z.string().trim().min(1).max(120),
  reasoningEffort: reasoningEffortSchema,
  timeoutSeconds: z.number().int().min(30).max(3600),
  maxConcurrency: z.number().int().min(1).max(8),
  enabled: z.boolean(),
  updatedAt: z.string().datetime(),
}).strict()

export const dailyGroupShutdownScheduleSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  timezone: z.literal("Asia/Shanghai"),
  lastRunLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  lastRunAt: z.string().datetime().nullable(),
  lastDisabledCount: z.number().int().min(0),
  updatedAt: z.string().datetime(),
}).strict()

export const runtimeSettingsRecordSchema = z.object({
  telegramEnabled: z.boolean(),
  codeSyncEnabled: z.boolean(),
  autoLearningEnabled: z.boolean(),
  learningIntervalSeconds: z.number().int().min(30).max(86400),
  learningBatchSize: z.number().int().min(2).max(50),
  messageDebounceMs: z.number().int().min(0).max(300000),
  progressNotificationSeconds: z.number().int().min(30).max(3600),
  dailyGroupShutdownEnabled: dailyGroupShutdownScheduleSchema.shape.enabled,
  dailyGroupShutdownTime: dailyGroupShutdownScheduleSchema.shape.time,
  dailyGroupShutdownTimezone: dailyGroupShutdownScheduleSchema.shape.timezone,
  dailyGroupShutdownLastRunAt: dailyGroupShutdownScheduleSchema.shape.lastRunAt,
  dailyGroupShutdownLastDisabledCount: dailyGroupShutdownScheduleSchema.shape.lastDisabledCount,
  updatedAt: z.string().datetime(),
}).strict()

export const telegramRoleSchema = z.object({
  id: z.string().uuid(),
  telegramUserId: z.string().regex(/^\d+$/),
  username: z.string().trim().max(80).nullable(),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["operator", "technical", "reviewer", "ignored"]),
  canCorrect: z.boolean(),
  enabled: z.boolean(),
  learningSourceEnabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const learningAssociationReasonSchema = z.enum([
  "direct_question",
  "direct_bot_reply",
  "reply_chain",
  "single_active_thread",
  "ambiguous",
  "none",
])
export const learningTakeoverStatusSchema = z.enum([
  "cancelled",
  "delivery_in_flight",
  "thread_already_terminal",
  "ambiguous",
  "not_linked",
])
export const learningObservationProcessingStatusSchema = z.enum(["pending", "ignored", "running", "completed", "failed"])
export const referenceLearningClassificationSchema = z.enum([
  "unclassified", "style", "correction", "business_rule", "ephemeral", "action_result", "general",
])
export const referenceLearningActionSchema = z.enum(["add", "reinforce", "conflict", "noop"])
export const referenceLearningOutcomeSchema = z.enum([
  "noop", "candidate", "conflict", "active", "style_candidate", "style_active", "ignored", "failed",
])
export const referenceLearningReasonCodeSchema = z.enum([
  "proposal_noop", "deterministic_noop", "non_learnable_classification",
  "memory_candidate", "memory_conflict", "memory_active", "style_candidate", "style_active",
  "unsafe_learning_material", "invalid_proposal_batch", "processing_failed", "interrupted_run",
])
export const referenceLearningTerminalResultSchema = z.object({
  classification: referenceLearningClassificationSchema,
  action: referenceLearningActionSchema,
  risk: z.enum(["low", "medium", "high"]),
  outcome: referenceLearningOutcomeSchema,
  reasonCode: referenceLearningReasonCodeSchema,
  memoryVersionId: z.string().uuid().nullable(),
  operatorStyleVersionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict()

const signedTelegramIdSchema = z.string().regex(/^-?[1-9]\d{0,18}$/u).superRefine((value, context) => {
  const parsed = BigInt(value)
  if (parsed < -9_223_372_036_854_775_808n || parsed > 9_223_372_036_854_775_807n) {
    context.addIssue({ code: "custom", message: "Telegram chat ID 超出 64 位整数范围" })
  }
})
const telegramMessageIdSchema = z.string().regex(/^[1-9]\d{0,18}$/u).superRefine((value, context) => {
  if (BigInt(value) > 9_223_372_036_854_775_807n) {
    context.addIssue({ code: "custom", message: "Telegram message ID 超出 64 位整数范围" })
  }
})
const telegramOutputKindSchema = z.string().min(1).max(80)
  .regex(/^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$/u)
const strictTimestampSchema = z.string().datetime({ precision: 3 })

export const telegramOutputOwnershipRowSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  deliveryGroupId: z.string().uuid().nullable(),
  telegramChatId: signedTelegramIdSchema,
  telegramMessageId: telegramMessageIdSchema.nullable(),
  threadId: z.string().uuid().nullable(),
  serviceId: z.string().uuid().nullable(),
  replyId: z.string().uuid().nullable(),
  notificationId: z.string().uuid().nullable(),
  outputKind: telegramOutputKindSchema,
  deliveryStatus: z.enum(["sending", "sent", "failed", "unknown"]),
  requestKey: z.string().uuid(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  replyToMessageId: telegramMessageIdSchema.nullable(),
  createdAt: strictTimestampSchema,
  updatedAt: strictTimestampSchema,
}).strict().superRefine((row, context) => {
  if (Date.parse(row.createdAt) > Date.parse(row.updatedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "所有权更新时间早于创建时间" })
  }
  if (row.deliveryStatus === "sent" ? row.telegramMessageId === null : row.telegramMessageId !== null) {
    context.addIssue({ code: "custom", path: ["telegramMessageId"], message: "所有权终态与消息 ID 不一致" })
  }
})

export const telegramOutgoingCandidateRowSchema = z.object({
  id: z.string().uuid(),
  ownershipId: z.string().uuid(),
  telegramMessageId: telegramMessageIdSchema,
  resolutionStatus: z.enum(["pending", "application", "manual", "unknown"]),
  createdAt: strictTimestampSchema,
  updatedAt: strictTimestampSchema,
}).strict().superRefine((row, context) => {
  if (Date.parse(row.createdAt) > Date.parse(row.updatedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "候选更新时间早于创建时间" })
  }
})

export const learningSourceObservationSchema = z.object({
  id: z.string().uuid(),
  messageEventId: z.string().uuid(),
  sourceTelegramUserId: z.string().regex(/^\d+$/),
  sourceRole: z.enum(["operator", "technical", "reviewer", "ignored"]),
  threadId: z.string().uuid().nullable(),
  serviceId: z.string().uuid().nullable(),
  associationReason: learningAssociationReasonSchema,
  associationConfidence: z.number().min(0).max(1),
  takeoverStatus: learningTakeoverStatusSchema,
  classification: z.string().trim().min(1).max(80),
  risk: z.enum(["low", "medium", "high"]),
  processingStatus: learningObservationProcessingStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lockToken: z.string().max(160).nullable(),
  lockedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const operatorStyleVersionStatusSchema = z.enum(["candidate", "active", "superseded"])
export const operatorStyleVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  profile: operatorStyleProfileSchema,
  status: operatorStyleVersionStatusSchema,
  sampleCount: z.number().int().positive(),
  sourceUserCount: z.number().int().positive(),
  threadCount: z.number().int().positive(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  supersededAt: z.string().datetime().nullable(),
}).strict().superRefine((value, context) => {
  const statistics = value.profile.statistics
  if (value.sampleCount !== statistics.sampleCount
    || value.sourceUserCount !== statistics.sourceUserCount
    || value.threadCount !== statistics.threadCount) {
    context.addIssue({ code: "custom", path: ["profile", "statistics"], message: "风格版本计数与 profile 不一致" })
  }
  if (value.sourceUserCount > value.sampleCount || value.threadCount > value.sampleCount) {
    context.addIssue({ code: "custom", path: ["sampleCount"], message: "风格来源计数不能超过样本数" })
  }
  if (value.status === "active" && (
    value.sampleCount < 20 || value.sourceUserCount < 2 || value.threadCount < 5 || value.activatedAt === null
  )) {
    context.addIssue({ code: "custom", path: ["status"], message: "active 风格版本未达到 20/2/5 门槛" })
  }
})

export const memoryRiskSchema = z.enum(["low", "medium", "high"])
export const memoryStatusSchema = z.enum(["active", "candidate", "conflict", "superseded", "disabled"])
export const memoryEventTypeSchema = z.enum([
  "human_rule",
  "correction",
  "question",
  "reply",
  "code",
  "document",
  "magicbook",
  "attachment",
  "ai_observation",
  "retraction",
])

export const directiveSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  scope: z.string().trim().min(1).max(120),
  source: z.enum(["system", "human"]),
  priority: z.number().int().min(1).max(100),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  disabledAt: z.string().datetime().nullable(),
}).strict()

export const memoryEventSchema = z.object({
  id: z.string().uuid(),
  type: memoryEventTypeSchema,
  sourceRef: z.string().max(240).nullable(),
  factId: z.string().uuid().nullable(),
  replyRecordId: z.string().uuid().nullable(),
  content: z.string().trim().min(1).max(24000),
  scope: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120).nullable(),
  branch: z.string().trim().min(1).max(120).nullable(),
  codeRevision: z.string().trim().min(1).max(160).nullable(),
  risk: memoryRiskSchema,
  confidence: z.number().min(0).max(1),
  actor: z.string().trim().min(1).max(160),
  occurredAt: z.string().datetime(),
}).strict()

export const memoryFactSchema = z.object({
  id: z.string().uuid(),
  topicKey: z.string().length(64),
  title: z.string().trim().min(1).max(160),
  currentVersionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict()

export const memoryVersionSchema = z.object({
  id: z.string().uuid(),
  factId: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  scope: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120).nullable(),
  branch: z.string().trim().min(1).max(120).nullable(),
  source: memoryEventTypeSchema,
  risk: memoryRiskSchema,
  confidence: z.number().min(0).max(1),
  status: memoryStatusSchema,
  conflictReason: z.string().max(500).nullable(),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().nullable(),
  createdByEventId: z.string().uuid(),
  createdAt: z.string().datetime(),
}).strict()

export const memoryViewSchema = memoryVersionSchema.extend({
  versionId: z.string().uuid(),
  topicKey: z.string().length(64),
  currentVersionId: z.string().uuid().nullable(),
  evidenceCount: z.number().int().nonnegative(),
  previousVersionCount: z.number().int().nonnegative(),
}).strict()

export const supportThreadStatusSchema = z.enum(["collecting", "generating", "answered", "escalated", "closed"])
export const supportEventRouteStatusSchema = z.enum([
  "received",
  "batched",
  "ignored",
  "role_skipped",
  "command",
  "routed",
  "correction",
])
export const supportThreadRelationSchema = z.enum(["origin", "supplement", "reopen"])
export const supportSenderFocusSourceSchema = z.enum([
  "explicit_reply",
  "new_thread",
  "operator_reply",
  "clarification_answer",
])
export const supportRouteClarificationStatusSchema = z.enum(["pending", "resolved", "expired", "cancelled"])

export const supportThreadSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  projectId: z.string().uuid(),
  serviceId: z.string().uuid(),
  status: supportThreadStatusSchema,
  revision: z.number().int().positive(),
  settleAt: z.string().datetime(),
  anchorMessageId: z.string().min(1).max(80),
  latestMessageAt: z.string().datetime(),
  summary: z.string().max(12000),
  originBatchId: z.string().uuid().nullable(),
  operatorStyleVersionId: z.string().uuid().nullable(),
  operatorStyleProfile: operatorStyleProfileSchema,
  answerModelInstanceId: z.string().uuid(),
  answerReplyStyle: replyStyleSchema,
  answerTimeoutSeconds: z.number().int().min(30).max(3600),
  answerMaxConcurrency: z.number().int().min(1).max(8),
  answerBindingEnabled: z.boolean(),
  answerIncludeAiMemory: z.boolean(),
  answerIncludeInterfaceDocs: z.boolean(),
  answerIncludeMagicBook: z.boolean(),
  answerOperationMode: groupOperationModeSchema.default("live"),
  generationStartedAt: z.string().datetime().nullable(),
  progressDueAt: z.string().datetime().nullable(),
  hardDeadlineAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  closedBy: z.string().max(160).nullable(),
  closedReason: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const supportMessageEventSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  telegramMessageId: z.string().min(1).max(80),
  replyToMessageId: z.string().max(80).nullable(),
  messageThreadId: z.string().max(80).nullable(),
  mediaGroupId: z.string().max(80).nullable(),
  senderUserId: z.string().min(1).max(80),
  senderUsername: z.string().max(120).nullable(),
  senderDisplayName: z.string().max(240).nullable(),
  senderRole: z.enum(["operator", "technical", "reviewer", "ignored"]).nullable(),
  safeText: z.string().max(12000),
  attachmentSummary: z.string().max(12000),
  ingestBatchId: z.string().uuid().nullable(),
  routeStatus: supportEventRouteStatusSchema,
  skipReason: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(),
}).strict()

export const supportThreadMessageSchema = z.object({
  threadId: z.string().uuid(),
  messageEventId: z.string().uuid(),
  relation: supportThreadRelationSchema,
  questionFragment: z.string().max(12000),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict()

export const supportMessageAttachmentSchema = z.object({
  id: z.string().uuid(),
  messageEventId: z.string().uuid(),
  fileName: z.string().max(500),
  mimeType: z.string().max(240),
  fileSize: z.number().int().nonnegative(),
  kind: z.enum(["text", "image", "video", "archive", "pdf", "other"]),
  storagePath: z.string().max(2000),
  extractedText: z.string().max(12000),
  createdAt: z.string().datetime(),
}).strict()

export const supportSenderFocusSchema = z.object({
  groupId: z.string().uuid(),
  serviceId: z.string().uuid(),
  senderUserId: z.string().min(1).max(80),
  threadId: z.string().uuid(),
  source: supportSenderFocusSourceSchema,
  lastOperatorMessageId: z.string().min(1).max(80).nullable(),
  lastBotMessageId: z.string().min(1).max(80).nullable(),
  focusedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const supportRouteClarificationSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  serviceId: z.string().uuid(),
  senderUserId: z.string().min(1).max(80),
  messageEventId: z.string().uuid(),
  candidateThreadIds: z.array(z.string().uuid()).min(1).max(2),
  candidateLabels: z.array(z.string().trim().min(1).max(240)).min(1).max(2),
  status: supportRouteClarificationStatusSchema,
  promptReplyId: z.string().uuid().nullable(),
  selectedThreadId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.candidateThreadIds.length !== value.candidateLabels.length) {
    context.addIssue({ code: "custom", message: "候选线程和标签数量必须一致" })
  }
  if (value.selectedThreadId !== null && !value.candidateThreadIds.includes(value.selectedThreadId)) {
    context.addIssue({ code: "custom", message: "选中的线程必须来自候选集合" })
  }
})

export const replyRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  inputRevision: z.number().int().positive().nullable(),
  groupId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  serviceId: z.string().uuid().nullable(),
  telegramMessageId: z.string().max(80).nullable(),
  telegramReplyMessageId: z.string().max(80).nullable(),
  senderUserId: z.string().max(80).nullable(),
  senderUsername: z.string().max(120).nullable(),
  senderDisplayName: z.string().max(240).nullable(),
  senderRole: z.enum(["operator", "technical", "reviewer", "ignored"]).nullable(),
  service: z.string().trim().max(120),
  serviceSource: z.enum(["group_binding", "technical_command"]).nullable(),
  question: z.string().trim().min(1).max(12000),
  answer: z.string().max(12000),
  quote: z.string().max(1000).nullable(),
  decision: z.enum(["pending", "reply", "ignore", "escalate"]),
  status: z.enum(["pending", "queued", "generating", "sending", "replied", "ignored", "escalated", "failed", "correcting", "corrected", "superseded"]),
  memoryVersionRefs: z.array(z.string().uuid()),
  codeRevision: z.string().max(160).nullable(),
  codeSnapshotId: z.string().uuid().nullable(),
  codeSyncBatchId: z.string().uuid().nullable(),
  operatorDeliveryStatus: z.enum(["sending", "sent", "failed", "uncertain"]).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  generationStartedAt: z.string().datetime().nullable(),
  heartbeatAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().max(120).nullable(),
  decisionReason: z.string().max(2000).nullable(),
  decisionConfidence: z.number().min(0).max(1).nullable(),
  correctedAt: z.string().datetime().nullable(),
}).strict()

export const adminChatDecisionSchema = z.enum(["reply", "ignore", "escalate"])
export const adminChatTurnStatusSchema = z.enum(["pending", "generating", "completed", "failed", "cancelled"])

export const adminChatAttachmentSchema = z.object({
  id: z.string().uuid(),
  turnId: z.string().uuid(),
  name: z.string().min(1).max(240),
  mimeType: z.string().max(160),
  size: z.number().int().nonnegative(),
  kind: z.enum(["text", "image", "video", "archive", "pdf", "other"]),
  storagePath: z.string(),
  extractedText: z.string().max(30000),
  createdAt: z.string().datetime(),
}).strict()

export const adminChatCorrectionSchema = z.object({
  id: z.string().uuid(),
  turnId: z.string().uuid(),
  correctedAnswer: z.string().trim().min(1).max(12000),
  reason: z.string().trim().min(1).max(1000),
  correctedBy: z.string().trim().min(1).max(160),
  createdAt: z.string().datetime(),
}).strict()

export const adminChatSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  serviceId: z.string().uuid(),
  createdByUserId: z.string().uuid().nullable(),
  title: z.string().min(1).max(72),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const adminChatTurnSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  position: z.number().int().positive(),
  question: z.string().max(12000),
  answer: z.string().max(12000),
  decision: adminChatDecisionSchema.nullable(),
  status: adminChatTurnStatusSchema,
  investigation: z.record(z.string(), z.json()),
  decisionReason: z.string().max(2000).nullable(),
  decisionConfidence: z.number().min(0).max(1).nullable(),
  codeRevision: z.string().max(160).nullable(),
  codeSnapshotId: z.string().uuid().nullable(),
  codeSyncBatchId: z.string().uuid().nullable(),
  memoryVersionRefs: z.array(z.string().uuid()),
  errorCode: z.string().max(120).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  generationStartedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  attachments: z.array(adminChatAttachmentSchema).max(8),
  corrections: z.array(adminChatCorrectionSchema),
}).strict()

export const adminChatSessionDetailSchema = z.object({
  session: adminChatSessionSchema,
  turns: z.array(adminChatTurnSchema),
}).strict()

export const maintenanceRunSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["running", "completed", "failed"]),
  scannedEvents: z.number().int().nonnegative(),
  createdVersions: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  summary: z.string().max(1000),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
}).strict()

export const referenceLearningRunResultSchema = z.object({
  processed: z.number().int().nonnegative(),
  createdVersions: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  styleVersions: z.number().int().nonnegative(),
}).strict()

export const referenceLearningWorkerStatusSchema = z.object({
  running: z.boolean(),
  busy: z.boolean(),
  pending: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
}).strict()

export type TelegramAccount = z.infer<typeof telegramAccountSchema>
export type RuntimeGroup = z.infer<typeof runtimeGroupSchema>
export type ProjectRecord = z.infer<typeof projectRecordSchema>
export type ProjectRepositoryRecord = z.infer<typeof projectRepositoryRecordSchema>
export type CodeRepositoryRole = z.infer<typeof codeRepositoryRoleSchema>
export type ProjectServiceRepositoryBindingRecord = z.infer<typeof projectServiceRepositoryBindingRecordSchema>
export type ProjectServiceRecord = z.infer<typeof projectServiceRecordSchema>
export type ServerResourceRecord = z.infer<typeof serverResourceRecordSchema>
export type DatabaseResourceRecord = z.infer<typeof databaseResourceRecordSchema>
export type ModelPurpose = z.infer<typeof modelPurposeSchema>
export type ModelProvider = z.infer<typeof modelProviderSchema>
export type ModelTransport = z.infer<typeof modelTransportSchema>
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>
export type ModelServiceTier = z.infer<typeof modelServiceTierSchema>
export type ModelHealthStatus = z.infer<typeof modelHealthStatusSchema>
export type ModelInstanceRecord = z.infer<typeof modelInstanceRecordSchema>
export type RuntimeModelBinding = z.infer<typeof runtimeModelBindingSchema>
export type ReplyStyle = z.infer<typeof replyStyleSchema>
export type ModelProfileRecord = z.infer<typeof modelProfileRecordSchema>
export type RuntimeSettingsRecord = z.infer<typeof runtimeSettingsRecordSchema>
export type DailyGroupShutdownScheduleRecord = z.infer<typeof dailyGroupShutdownScheduleSchema>
export type TelegramRole = z.infer<typeof telegramRoleSchema>
export type LearningSourceObservation = z.infer<typeof learningSourceObservationSchema>
export type ReferenceLearningTerminalResult = z.infer<typeof referenceLearningTerminalResultSchema>
export type OperatorStyleVersionStatus = z.infer<typeof operatorStyleVersionStatusSchema>
export type OperatorStyleVersion = z.infer<typeof operatorStyleVersionSchema>
export type Directive = z.infer<typeof directiveSchema>
export type MemoryRisk = z.infer<typeof memoryRiskSchema>
export type MemoryStatus = z.infer<typeof memoryStatusSchema>
export type MemoryEventType = z.infer<typeof memoryEventTypeSchema>
export type MemoryEvent = z.infer<typeof memoryEventSchema>
export type MemoryFact = z.infer<typeof memoryFactSchema>
export type MemoryVersion = z.infer<typeof memoryVersionSchema>
export type MemoryView = z.infer<typeof memoryViewSchema>
export type SupportThreadStatus = z.infer<typeof supportThreadStatusSchema>
export type SupportEventRouteStatus = z.infer<typeof supportEventRouteStatusSchema>
export type SupportThreadRelation = z.infer<typeof supportThreadRelationSchema>
export type SupportThread = z.infer<typeof supportThreadSchema>
export type SupportMessageEvent = z.infer<typeof supportMessageEventSchema>
export type SupportSenderFocus = z.infer<typeof supportSenderFocusSchema>
export type SupportSenderFocusSource = z.infer<typeof supportSenderFocusSourceSchema>
export type SupportRouteClarification = z.infer<typeof supportRouteClarificationSchema>
export type SupportThreadMessage = z.infer<typeof supportThreadMessageSchema>
export type SupportMessageAttachment = z.infer<typeof supportMessageAttachmentSchema>
export type SupportThreadDetailMessage = SupportThreadMessage & {
  event: SupportMessageEvent
  attachments: SupportMessageAttachment[]
}
export type SupportThreadDetail = {
  thread: SupportThread
  messages: SupportThreadDetailMessage[]
}
export type ReplyRecord = z.infer<typeof replyRecordSchema>
export type ReplyStatus = ReplyRecord["status"]
export type AdminChatDecision = z.infer<typeof adminChatDecisionSchema>
export type AdminChatTurnStatus = z.infer<typeof adminChatTurnStatusSchema>
export type AdminChatAttachment = z.infer<typeof adminChatAttachmentSchema>
export type AdminChatCorrection = z.infer<typeof adminChatCorrectionSchema>
export type AdminChatSession = z.infer<typeof adminChatSessionSchema>
export type AdminChatTurn = z.infer<typeof adminChatTurnSchema>
export type AdminChatSessionDetail = z.infer<typeof adminChatSessionDetailSchema>
export type MaintenanceRun = z.infer<typeof maintenanceRunSchema>
export type ReferenceLearningRunResult = z.infer<typeof referenceLearningRunResultSchema>
export type ReferenceLearningWorkerStatus = z.infer<typeof referenceLearningWorkerStatusSchema>
