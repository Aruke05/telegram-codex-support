export type HealthStatus = {
  status: "ok"
  service: string
  version: string
  schemaVersion: number
}

export type ModelPurpose = "answer" | "memory"
export type ModelProvider = "openai" | "deepseek" | "anthropic" | "glm"
export type ModelTransport = "codex_cli" | "direct_api"
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
export type ModelServiceTier = "standard" | "fast" | "priority"
export type ModelInstance = {
  id: string
  alias: string
  provider: ModelProvider
  transport: ModelTransport
  modelId: string
  reasoningEffort: ReasoningEffort | null
  serviceTier: ModelServiceTier | null
  parameters: Record<string, unknown>
  credentialsConfigured: boolean
  credentialHint: string
  enabled: boolean
  healthStatus: "not_tested" | "ready" | "error"
  healthMessage: string
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
}
export type RuntimeModelBinding = {
  purpose: ModelPurpose
  modelInstanceId: string
  timeoutSeconds: number
  maxConcurrency: number
  enabled: boolean
  updatedAt: string
}
export type ModelCatalogEntry = {
  provider: ModelProvider
  transport: ModelTransport
  modelId: string
  displayName: string
  capabilities: {
    defaultReasoningEffort: ReasoningEffort | null
    supportedReasoningEfforts: ReasoningEffort[]
    serviceTiers: ModelServiceTier[]
    inputModalities: Array<"text" | "image">
    supportsTools: boolean
    supportsStructuredOutput: boolean
    supportsCustomModelId: boolean
  }
  hidden: boolean
  deprecated: boolean
  upgradeModelId: string | null
  refreshedAt: string
}
export type ModelCatalogResult = {
  entries: ModelCatalogEntry[]
  refreshedAt: string | null
  stale: boolean
  error: string | null
}
export type ModelProfile = {
  purpose: ModelPurpose
  model: string
  reasoningEffort: ReasoningEffort
  timeoutSeconds: number
  maxConcurrency: number
  enabled: boolean
  updatedAt: string
}
export type RuntimeSettings = {
  telegramEnabled: boolean
  codeSyncEnabled: boolean
  autoLearningEnabled: boolean
  learningIntervalSeconds: number
  learningBatchSize: number
  messageDebounceMs: number
  progressNotificationSeconds: number
  dailyGroupShutdownEnabled: boolean
  dailyGroupShutdownTime: string
  dailyGroupShutdownTimezone: "Asia/Shanghai"
  dailyGroupShutdownLastRunAt: string | null
  dailyGroupShutdownLastDisabledCount: number
  updatedAt: string
}
export type LearningRunStatus = {
  status: "running" | "completed" | "failed"
  scannedEvents: number
  createdVersions: number
  conflictCount: number
  summary: string
  startedAt: string
  finishedAt: string | null
}
export type RuntimeStatus = {
  codex: { available: boolean; authenticated: boolean; version: string; message: string }
  telegram: {
    running: boolean; botLoops: number; userConnections: number; lastUpdateAt: string | null
    lastErrorAt: string | null; lastErrorCode: string | null
  }
  codeSync: { lastRun: null | {
    status: "running" | "published" | "fallback" | "failed" | "interrupted"
    triggerSource: "answer" | "hourly" | "manual" | "learning"
    branch: string
    safeSummary: string | null
    errorType: string | null
    snapshotId: string | null
    fallbackSnapshotId: string | null
    backendCommit: string | null
    frontendCommit: string | null
    startedAt: string
    finishedAt: string | null
  } }
  learning: {
    pending: number; completed: number
    lastRun: LearningRunStatus | null
    activeStyle: OperatorStyleVersion | null
    reference: {
      running: boolean; busy: boolean; pending: number; processing: number; failed: number; completed: number
      lastRun: LearningRunStatus | null
    }
    legacy: { pending: number; processing: number; failed: number; completed: number }
  }
}

export type OperatorStyleProfile = {
  interactionStyle: {
    collaboration: "shared_problem_solving" | "direct_delivery"
    actionLayout: "conversational" | "structured_when_requested"
    softening: "contextual" | "none"
  }
  statistics: {
    sampleCount: number; sourceUserCount: number; threadCount: number
    medianTextChars: number; p90TextChars: number; singleMessageRatio: number; segmentedMessageRatio: number
  }
  shortSentenceMaxChars: number
  simpleReply: { maxMessages: 1; maxLines: number }
  complexReply: { maxMessages: number; maxLinesPerMessage: number }
  segmentation: "single_message" | "line_break"
  allowedPhrases: Array<"就行" | "这个" | "发一下" | "找对方看下">
  forbiddenPhrases: string[]
  clarification: { requestMaterial: "发一下" }
}

export type OperatorStyleVersion = {
  id: string
  version: number
  profile: OperatorStyleProfile
  status: "candidate" | "active" | "superseded"
  sampleCount: number
  sourceUserCount: number
  threadCount: number
  createdAt: string
  activatedAt: string | null
  supersededAt: string | null
}

export type TelegramAccount = {
  id: string
  name: string
  type: "bot" | "user"
  enabled: boolean
  status: "not_tested" | "ready" | "error" | "login_required"
  statusMessage: string
  botUsername: string | null
  secretConfigured: true
  secretHint: string
  createdAt: string
  updatedAt: string
}

export type TelegramGroup = {
  id: string
  key: string
  name: string
  telegramChatId: string | null
  accountId: string | null
  projectId: string | null
  serviceId: string | null
  enabled: boolean
  configured: boolean
  accessMode: "bot" | "user"
  triggerMode: "all" | "command"
  platform: string
  repositories: Array<"java-project" | "sfzf-web">
  branch: string | null
  serverAlias: string | null
  databaseAlias: string
  knowledgeScope: string
  purpose: "support" | "technical_alert"
  aiModelInstanceId: string | null
  replyStyle: "human" | "unrestricted"
  createdAt: string
  updatedAt: string
}

export type BatchGroupPatch = {
  enabled?: boolean
  accessMode?: TelegramGroup["accessMode"]
  accountId?: string
  replyStyle?: TelegramGroup["replyStyle"]
}

export type BatchGroupUpdateInput = {
  ids: string[]
  patch: BatchGroupPatch
}

export type TelegramRole = {
  id: string
  telegramUserId: string
  username: string | null
  displayName: string
  role: "operator" | "technical" | "reviewer" | "ignored"
  canCorrect: boolean
  enabled: boolean
  learningSourceEnabled: boolean
  createdAt: string
  updatedAt: string
}

export type TelegramRoleInput = Pick<TelegramRole, "telegramUserId" | "username" | "displayName" | "role" | "canCorrect" | "enabled" | "learningSourceEnabled">

export type ReferenceLearningTerminalResult = {
  classification: "unclassified" | "style" | "correction" | "business_rule" | "ephemeral" | "action_result" | "general"
  action: "add" | "reinforce" | "conflict" | "noop"
  risk: "low" | "medium" | "high"
  outcome: "noop" | "candidate" | "conflict" | "active" | "style_candidate" | "style_active" | "ignored" | "failed"
  reasonCode: "proposal_noop" | "deterministic_noop" | "non_learnable_classification"
    | "memory_candidate" | "memory_conflict" | "memory_active" | "style_candidate" | "style_active"
    | "unsafe_learning_material" | "invalid_proposal_batch" | "processing_failed" | "interrupted_run"
  memoryVersionId: string | null
  operatorStyleVersionId: string | null
  createdAt: string
}

export type LearningObservationAudit = {
  id: string
  sourceTelegramUserId: string
  sourceRole: "operator" | "technical" | "reviewer" | "ignored"
  threadId: string | null
  associationReason: "direct_question" | "direct_bot_reply" | "reply_chain" | "single_active_thread" | "ambiguous" | "none"
  takeoverStatus: "cancelled" | "delivery_in_flight" | "thread_already_terminal" | "ambiguous" | "not_linked"
  processingStatus: "pending" | "ignored" | "running" | "completed" | "failed"
  createdAt: string
  terminalResult: ReferenceLearningTerminalResult | null
}

export type LearningObservation = LearningObservationAudit & {
  messageEventId: string
  serviceId: string | null
  associationConfidence: number
  updatedAt: string
}

export type TelegramAccountsResponse = {
  accounts: TelegramAccount[]
  commands: Array<{ command: string; description: string }>
}

export type TelegramLoginState = {
  stage: "connecting" | "waiting_code" | "waiting_password" | "ready" | "error"
  message: string
}

export type TelegramGroupsResponse = {
  version: number
  technicalAlertGroup: { name: string; configured: boolean }
  groups: TelegramGroup[]
}

// 第一阶段只读目录的兼容类型；新后台使用 TelegramGroupsResponse。
export type GroupCatalogEntry = {
  key: string
  name: string
  enabled: boolean
  configured: boolean
  accessMode: "bot" | "user"
  platform: string
  repositories: string[]
  branch: string
  serverAlias: string
  databaseAlias: string
  knowledgeScope: string
}

export type GroupCatalogResponse = {
  version: number
  technicalAlertGroup: { name: string; configured: boolean }
  groups: GroupCatalogEntry[]
}

export type MemoryStatus = "active" | "candidate" | "conflict" | "superseded" | "disabled"
export type MemoryRisk = "low" | "medium" | "high"
export type MemoryEventType = "human_rule" | "correction" | "question" | "reply" | "code" | "document" | "magicbook" | "attachment" | "ai_observation" | "retraction"

export type MemoryView = {
  id: string
  versionId: string
  factId: string
  version: number
  title: string
  content: string
  scope: string
  region: string | null
  branch: string | null
  source: MemoryEventType
  risk: MemoryRisk
  confidence: number
  status: MemoryStatus
  conflictReason: string | null
  validFrom: string
  validTo: string | null
  createdByEventId: string
  createdAt: string
  topicKey: string
  currentVersionId: string | null
  evidenceCount: number
  previousVersionCount: number
}

export type MemoryEvent = {
  id: string
  type: MemoryEventType
  sourceRef: string | null
  factId: string | null
  replyRecordId: string | null
  content: string
  scope: string
  region: string | null
  branch: string | null
  codeRevision: string | null
  risk: MemoryRisk
  confidence: number
  actor: string
  occurredAt: string
}

export type MemoryEvidenceSummary = {
  codeEvidence: Array<{ path: string; codeRevision: string | null; snapshotId: string }>
  sourceThreads: Array<{ observationId: string; threadId: string }>
}

export type Directive = {
  id: string
  title: string
  content: string
  scope: string
  source: "system" | "human"
  priority: number
  enabled: boolean
  createdAt: string
  disabledAt: string | null
}

export type ReplyRecord = {
  id: string
  threadId: string | null
  inputRevision: number | null
  groupId: string | null
  accountId: string | null
  projectId: string | null
  serviceId: string | null
  telegramMessageId: string | null
  telegramReplyMessageId: string | null
  senderUserId: string | null
  senderUsername: string | null
  senderDisplayName: string | null
  senderRole: "operator" | "technical" | "reviewer" | "ignored" | null
  service: string
  serviceSource: "group_binding" | "technical_command" | null
  question: string
  answer: string
  quote: string | null
  decision: "pending" | "reply" | "ignore" | "escalate"
  status: "pending" | "queued" | "generating" | "sending" | "replied" | "ignored" | "escalated" | "failed" | "correcting" | "corrected" | "superseded"
  memoryVersionRefs: string[]
  codeRevision: string | null
  codeSnapshotId: string | null
  codeSyncBatchId: string | null
  operatorDeliveryStatus: "sending" | "sent" | "failed" | "uncertain" | null
  createdAt: string
  updatedAt: string
  generationStartedAt: string | null
  heartbeatAt: string | null
  durationMs: number | null
  errorCode: string | null
  decisionReason: string | null
  decisionConfidence: number | null
  correctedAt: string | null
}

export type ReplyListItem = Omit<ReplyRecord, "question" | "answer" | "quote" | "memoryVersionRefs"> & {
  questionPreview: string
  answerPreview: string
}

export type SupportThreadStatus = "collecting" | "generating" | "answered" | "escalated" | "closed"

export type SupportThreadListItem = {
  id: string
  groupId: string
  groupName: string
  projectId: string
  projectName: string
  serviceId: string
  service: string
  serviceName: string
  status: SupportThreadStatus
  revision: number
  settleAt: string
  latestMessageAt: string
  summary: string
  senderUserId: string | null
  senderUsername: string | null
  senderDisplayName: string | null
  latestReplyStatus: ReplyRecord["status"] | null
  hasSuperseded: boolean
  createdAt: string
  updatedAt: string
}

export type SupportMessageEvent = {
  id: string
  groupId: string
  accountId: string | null
  telegramMessageId: string
  replyToMessageId: string | null
  messageThreadId: string | null
  mediaGroupId: string | null
  senderUserId: string
  senderUsername: string | null
  senderDisplayName: string | null
  senderRole: "operator" | "technical" | "reviewer" | "ignored" | null
  safeText: string
  attachmentSummary: string
  routeStatus: "received" | "batched" | "ignored" | "role_skipped" | "command" | "routed" | "correction"
  skipReason: string | null
  createdAt: string
}

export type SupportMessageAttachment = {
  id: string
  messageEventId: string
  fileName: string
  mimeType: string
  fileSize: number
  kind: "text" | "image" | "video" | "archive" | "pdf" | "other"
  storagePath: string
  extractedText: string
  createdAt: string
}

export type SupportThreadDetail = {
  thread: {
    id: string
    groupId: string
    projectId: string
    serviceId: string
    status: SupportThreadStatus
    revision: number
    settleAt: string
    anchorMessageId: string
    latestMessageAt: string
    summary: string
    operatorStyleVersionId: string | null
    operatorStyleProfile: OperatorStyleProfile
    generationStartedAt: string | null
    progressDueAt: string | null
    hardDeadlineAt: string | null
    closedAt: string | null
    closedBy: string | null
    closedReason: string | null
    createdAt: string
    updatedAt: string
  }
  messages: Array<{
    threadId: string
    messageEventId: string
    relation: "origin" | "supplement" | "reopen"
    questionFragment: string
    position: number
    createdAt: string
    event: SupportMessageEvent
    attachments: SupportMessageAttachment[]
  }>
  context: {
    groupName: string
    projectName: string
    service: string
    serviceName: string
    knowledgeScope: string
    region: string
    branch: string
  }
  replies: ReplyRecord[]
  learningObservations: LearningObservationAudit[]
}

export type ProjectRepository = {
  id: string; projectId: string; name: string; remoteUrl: string; enabled: boolean; createdAt: string; updatedAt: string
}

export type ProjectService = {
  id: string; projectId: string; key: string; name: string; region: string; timezone: string; branch: string; enabled: boolean; createdAt: string; updatedAt: string
  repositories: {
    backend: { repositoryId: string; name: string } | null
    frontend: { repositoryId: string; name: string } | null
  }
  codeSync: {
    status: "healthy" | "failed" | "never"
    snapshotPublishedAt: string | null
    backendCommit: string | null
    frontendCommit: string | null
    safeSummary: string | null
  }
}

export type ProjectServer = {
  id: string; projectId: string; serviceId: string; alias: string; host: string; port: number; username: string; workdir: string; enabled: boolean; privateKeyConfigured: boolean; createdAt: string; updatedAt: string
}

export type ProjectDatabase = {
  id: string; projectId: string; serviceId: string; alias: string; engine: "mysql"; host: string; port: number; database: string; username: string; timezone: string; enabled: boolean; passwordConfigured: boolean; createdAt: string; updatedAt: string
}

export type ProjectView = {
  id: string; key: string; name: string; description: string; enabled: boolean; defaultKnowledgeScope: string; createdAt: string; updatedAt: string
  repositories: ProjectRepository[]; services: ProjectService[]; servers: ProjectServer[]; databases: ProjectDatabase[]
}

export type InvestigationSource = "message" | "document" | "code" | "server" | "log" | "database" | "redis" | "inference"
export type InvestigationStatus = "confirmed" | "not_found" | "failed" | "skipped"

export type InvestigationTrace = {
  summary: string
  steps: Array<{
    source: InvestigationSource
    title: string
    status: InvestigationStatus
    evidence: string
    conclusion: string
  }>
}

export type AdminChatSession = {
  id: string
  projectId: string
  serviceId: string
  title: string
  createdAt: string
  updatedAt: string
  latestTurnStatus: AdminChatTurn["status"] | null
  latestTurnUpdatedAt: string | null
  project: { id: string; key: string; name: string }
  service: { id: string; key: string; name: string; region: string; branch: string; enabled: boolean }
}

export type AdminChatTurn = {
  id: string
  sessionId: string
  position: number
  question: string
  answer: string
  decision: "reply" | "ignore" | "escalate" | null
  status: "pending" | "generating" | "completed" | "failed" | "cancelled"
  investigation: Partial<InvestigationTrace>
  decisionReason: string | null
  decisionConfidence: number | null
  codeRevision: string | null
  codeSnapshotId: string | null
  codeSyncBatchId: string | null
  memoryVersionRefs: string[]
  errorCode: string | null
  createdAt: string
  updatedAt: string
  generationStartedAt: string | null
  completedAt: string | null
  attachments: AdminChatAttachment[]
  corrections: AdminChatCorrection[]
}

export type AdminChatAttachment = {
  id: string
  turnId: string
  name: string
  mimeType: string
  size: number
  kind: "text" | "image" | "video" | "archive" | "pdf" | "other"
  createdAt: string
  url: string | null
}

export type AdminChatCorrection = {
  id: string
  turnId: string
  correctedAnswer: string
  reason: string
  correctedBy: string
  createdAt: string
}

export type AdminChatSessionDetail = {
  session: AdminChatSession
  turns: AdminChatTurn[]
}

export type MagicBookOption = { label: string; value: string }

export type MagicBookStatus = {
  sourceVersion: string
  importedAt: string
  contentHash: string
  serviceCount: number
  services: MagicBookOption[]
  regionCount: number
  promptFallback: { enabled: boolean; mode: string }
}

export type InterfaceDocumentSummary = {
  scope: "india" | "non_india"
  title: string
  applicableRegions: string[]
  sourceVersion: string
  capturedAt: string
  endpointCount: number
}

export type InterfaceDocumentSection = {
  title: string
  content: string
  endpoints: string[]
  writeOperation: boolean
  explainOnly: boolean
}

export type InterfaceDocumentSearch = {
  query: string
  scope: "india" | "non_india"
  title: string
  applicableRegions: string[]
  sourceVersion: string
  sections: InterfaceDocumentSection[]
}

export type SensitiveCategory = "private-key" | "connection-string" | "absolute-url" | "credential" | "business-identifier" | "email" | "ip-address" | "bank-card"

export type ThemePreference = "system" | "light" | "dark"
export type RouteKey = "overview" | "projects" | "connections" | "replies" | "chat" | "memories" | "docs" | "models" | "runtime" | "transfer" | "settings"
