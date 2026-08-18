import { resolve } from "node:path"

import { AdminChatStore } from "./admin-chat/store.js"
import { AdminChatWorker } from "./admin-chat/worker.js"
import { buildApp } from "./app.js"
import { loadGroupCatalog } from "./catalog/service.js"
import { loadEnv } from "./config/env.js"
import { loadInterfaceDocument } from "./knowledge/interface-documents.js"
import { KnowledgeResolver } from "./knowledge/resolver.js"
import { StaticMagicBookKnowledgeSource } from "./magicbook/json-source.js"
import { MagicBookRepository } from "./magicbook/repository.js"
import { ProjectAdminService } from "./projects/project-admin-service.js"
import { ProjectCodeSyncService } from "./git-sync/project-service.js"
import { HourlyCodeSyncWorker } from "./git-sync/hourly-worker.js"
import { CodeSnapshotRetentionService } from "./git-sync/retention-service.js"
import { ResourceResolver } from "./projects/resource-resolver.js"
import { ReadonlyResourceBroker } from "./diagnostics/resource-broker.js"
import { ReplyEventBus } from "./replies/reply-event-bus.js"
import { ReplyService } from "./replies/reply-service.js"
import { RetentionService } from "./replies/retention-service.js"
import { RuntimeAdminService } from "./runtime/admin-service.js"
import { BackupService } from "./runtime/backup-service.js"
import { RuntimeDatabase } from "./runtime/database.js"
import { RuntimeKnowledgeService } from "./runtime/knowledge-service.js"
import { ModelConfigService } from "./runtime/model-config-service.js"
import { CodexCatalogClient } from "./models/codex-catalog-client.js"
import { ModelCatalogService } from "./models/model-catalog-service.js"
import { DirectApiAdapter } from "./models/direct-api/direct-api-adapter.js"
import { ReadonlyAgentToolBroker } from "./diagnostics/readonly-agent-tool-broker.js"
import { RuntimeControlService } from "./runtime/control-service.js"
import { DailyGroupShutdownWorker } from "./runtime/daily-group-shutdown-worker.js"
import { LocalSecretVault } from "./runtime/secret-vault.js"
import { ConfiguredSecretRedactor } from "./security/dlp.js"
import { TelegramConnectionService } from "./telegram/connection-service.js"
import { TelegramUserLoginService } from "./telegram/user-login-service.js"
import { CodexExecutor } from "./codex/executor.js"
import { CodexSupportDecisionAgent } from "./support/agent.js"
import { SupportAnswerWorker } from "./support/answer-worker.js"
import { SupportInvestigationService } from "./support/investigation-service.js"
import { SupportDeadlineService } from "./support/deadline-service.js"
import { ResourceWorkspace } from "./support/resource-workspace.js"
import { SupportCorrectionService } from "./support/correction-service.js"
import { SupportMessageProcessor } from "./support/message-processor.js"
import { SupportThreadCoordinator } from "./support/thread-coordinator.js"
import { CodexSupportThreadRouter } from "./support/thread-router.js"
import { SupportThreadStore } from "./support/thread-store.js"
import { LearningSourceObserver } from "./support/learning-source-observer.js"
import { LearningSourceStore } from "./support/learning-source-store.js"
import { TechnicalAlertService } from "./support/technical-alert-service.js"
import { SupportThreadLifecycleService } from "./support/thread-lifecycle-service.js"
import { SupportThreadQueryService } from "./support/thread-query-service.js"
import { CodexMemoryLearningAgent } from "./learning/agent.js"
import { CodexReferenceAgent } from "./learning/reference-agent.js"
import { OperatorStyleService } from "./learning/operator-style-service.js"
import { ReferenceLearningWorker } from "./learning/reference-worker.js"
import { MemoryLearningWorker } from "./learning/worker.js"
import { MemoryAuthoringService } from "./learning/authoring.js"
import { AttachmentService } from "./telegram/attachment-service.js"
import { TelegramDeliveryError, TelegramRuntime } from "./telegram/runtime.js"

const env = loadEnv()
await ResourceWorkspace.cleanupOrphans()
const groupCatalog = await loadGroupCatalog("config/telegram-groups.json")
const vault = await LocalSecretVault.open(resolve(env.dataDir, "runtime/master.key"))
const runtimeDatabase = await RuntimeDatabase.open(
  resolve(env.dataDir, "runtime/support.sqlite"),
  RuntimeAdminService.seedGroups(groupCatalog),
)
const runtimeAdminService = new RuntimeAdminService(runtimeDatabase, vault)
const dailyGroupShutdownWorker = new DailyGroupShutdownWorker(runtimeDatabase)
const projectAdminService = new ProjectAdminService(runtimeDatabase)
const resourceResolver = new ResourceResolver(runtimeDatabase)
const readonlyResourceBroker = new ReadonlyResourceBroker(runtimeDatabase)
const replyEventBus = new ReplyEventBus()
const modelConfigService = new ModelConfigService(runtimeDatabase, vault)
const modelCatalogService = new ModelCatalogService(runtimeDatabase, new CodexCatalogClient())
const configuredSecretRedactor = new ConfiguredSecretRedactor(runtimeDatabase, () => modelConfigService.listConfiguredSecrets())
const attachmentService = new AttachmentService(env.dataDir, configuredSecretRedactor)
const replyService = new ReplyService(runtimeDatabase, replyEventBus, configuredSecretRedactor)
const retentionService = new RetentionService(runtimeDatabase, resolve(env.dataDir, "attachments"))
const runtimeKnowledgeService = new RuntimeKnowledgeService(runtimeDatabase, configuredSecretRedactor)
runtimeKnowledgeService.ensureSystemDirectives()
const telegramConnectionService = new TelegramConnectionService(runtimeAdminService)
const snapshot = await new StaticMagicBookKnowledgeSource(
  "config/magicbook-safe-bootstrap.json",
  "knowledge/bootstrap/magicbook-bank-codes-sanitized.json",
).load()
const indiaInterfaceDocument = await loadInterfaceDocument("knowledge/bootstrap/interface-docs-india-sanitized.md")
const nonIndiaInterfaceDocument = await loadInterfaceDocument("knowledge/bootstrap/interface-docs-non-india-sanitized.md")
runtimeKnowledgeService.indexStaticKnowledge([
  { source: "magicbook", title: "MagicBook 全局参数", scope: "global", content: JSON.stringify(snapshot), capturedAt: snapshot.syncedAt },
  { source: "interface_india", title: indiaInterfaceDocument.title, scope: "india", content: indiaInterfaceDocument.rawText, capturedAt: indiaInterfaceDocument.capturedAt },
  { source: "interface_non_india", title: nonIndiaInterfaceDocument.title, scope: "non_india", content: nonIndiaInterfaceDocument.rawText, capturedAt: nonIndiaInterfaceDocument.capturedAt },
])
const directApiAdapter = new DirectApiAdapter(fetch, new ReadonlyAgentToolBroker((value) => configuredSecretRedactor.redact(value).text))
const codexExecutor = new CodexExecutor(modelConfigService, undefined, directApiAdapter)
const memoryAuthoringService = new MemoryAuthoringService(codexExecutor, runtimeKnowledgeService)
const projectCodeSyncService = new ProjectCodeSyncService(runtimeDatabase, resolve(env.dataDir, "runtime"))
const memoryLearningWorker = new MemoryLearningWorker(
  runtimeDatabase,
  modelConfigService,
  runtimeKnowledgeService,
  new CodexMemoryLearningAgent(codexExecutor),
  projectCodeSyncService,
)
const referenceLearningWorker = new ReferenceLearningWorker(
  runtimeDatabase,
  modelConfigService,
  runtimeKnowledgeService,
  new CodexReferenceAgent(codexExecutor),
  projectCodeSyncService,
  new OperatorStyleService(runtimeDatabase),
  configuredSecretRedactor,
)
let telegramRuntime: TelegramRuntime
const telegramTransport = {
  sendMessage: (
    accountId: string | null,
    chatId: string,
    text: string,
    replyToMessageId?: string,
    quote?: string | null,
    ownership?: import("./telegram/runtime.js").TelegramOutputOwnership,
  ) => (
    telegramRuntime.sendMessage(accountId, chatId, text, replyToMessageId, quote, ownership)
  ),
  forwardMessages: (
    accountId: string | null,
    targetChatId: string,
    sourceChatId: string,
    messageIds: string[],
    ownership?: import("./telegram/runtime.js").TelegramOutputOwnership,
  ) => telegramRuntime.forwardMessages(accountId, targetChatId, sourceChatId, messageIds, ownership),
}
const supportThreadStore = new SupportThreadStore(
  runtimeDatabase,
  configuredSecretRedactor,
  (event) => replyEventBus.publish(event),
)
let supportThreadCoordinator: SupportThreadCoordinator
const technicalAlertService = new TechnicalAlertService(
  runtimeDatabase,
  supportThreadStore,
  replyService,
  configuredSecretRedactor,
  telegramTransport,
)
const hourlyCodeSyncWorker = new HourlyCodeSyncWorker({
  database: runtimeDatabase,
  codeSync: projectCodeSyncService,
  alerts: technicalAlertService,
})
const codeSnapshotRetentionService = new CodeSnapshotRetentionService(
  runtimeDatabase,
  resolve(env.dataDir, "runtime"),
)
const supportCorrectionService = new SupportCorrectionService(runtimeDatabase, memoryAuthoringService, telegramTransport)
const supportAnswerWorker = new SupportAnswerWorker({
  database: runtimeDatabase,
  store: supportThreadStore,
  config: modelConfigService,
  replies: replyService,
  knowledge: runtimeKnowledgeService,
  redactor: configuredSecretRedactor,
  codeSync: projectCodeSyncService,
  agent: new CodexSupportDecisionAgent(codexExecutor),
  transport: telegramTransport,
  technicalAlerts: technicalAlertService,
  learning: memoryLearningWorker,
  resourceWorkspace: new ResourceWorkspace(runtimeDatabase),
  resourceBroker: readonlyResourceBroker,
})
const adminChatStore = new AdminChatStore(runtimeDatabase)
const supportInvestigationService = new SupportInvestigationService({
  database: runtimeDatabase,
  codeSync: projectCodeSyncService,
  knowledge: runtimeKnowledgeService,
  resourceWorkspace: new ResourceWorkspace(runtimeDatabase),
  redactor: configuredSecretRedactor,
  agent: new CodexSupportDecisionAgent(codexExecutor),
  resourceBroker: readonlyResourceBroker,
})
const adminChatWorker = new AdminChatWorker({
  store: adminChatStore,
  database: runtimeDatabase,
  config: modelConfigService,
  investigation: supportInvestigationService,
  redactor: configuredSecretRedactor,
  events: replyEventBus,
})
const supportThreadLifecycleService = new SupportThreadLifecycleService(supportThreadStore, supportAnswerWorker)
const learningSourceObserver = new LearningSourceObserver({
  database: runtimeDatabase,
  threads: supportThreadStore,
  observations: new LearningSourceStore(runtimeDatabase),
  materializePendingBatch: (eventId) => supportThreadCoordinator.materializePendingBatchForEvent(eventId),
  lifecycle: supportThreadLifecycleService,
})
const supportThreadQueryService = new SupportThreadQueryService(
  runtimeDatabase,
  supportThreadStore,
  supportThreadLifecycleService,
)
const supportDeadlineService = new SupportDeadlineService({
  database: runtimeDatabase,
  store: supportThreadStore,
  redactor: configuredSecretRedactor,
  cancellation: supportAnswerWorker,
  transport: telegramTransport,
})
supportThreadCoordinator = new SupportThreadCoordinator({
  database: runtimeDatabase,
  store: supportThreadStore,
  router: new CodexSupportThreadRouter(codexExecutor),
  batchWindowMs: () => modelConfigService.getSettings().messageDebounceMs,
  wake: () => supportAnswerWorker.wake(),
  cancelStale: () => { supportAnswerWorker.cancelClosed() },
  sendHelp: async (group, text, replyToMessageId) => {
    await telegramTransport.sendMessage(
      group.accountId,
      group.telegramChatId!,
      text,
      replyToMessageId,
      undefined,
      { groupId: group.id, serviceId: group.serviceId, kind: "help" },
    )
  },
  sendPresenceReply: ({ group, event, text }) => telegramTransport.sendMessage(
    group.accountId,
    group.telegramChatId!,
    text,
    event.telegramMessageId,
    undefined,
    { groupId: group.id, serviceId: group.serviceId, kind: "presence_reply" },
  ),
  sendRouteClarification: async ({ group, service, event, text }) => {
    const outbound = configuredSecretRedactor.assertSafeOutbound(text)
    if (!outbound.allowed || outbound.safeText !== text) throw new Error("待归属自然确认未通过发送前安全校验")
    const pending = replyService.createPending({
      threadId: null,
      inputRevision: null,
      groupId: group.id,
      accountId: group.accountId,
      projectId: service.projectId,
      serviceId: service.id,
      telegramMessageId: event.telegramMessageId,
      senderUserId: event.senderUserId,
      senderUsername: event.senderUsername,
      senderDisplayName: event.senderDisplayName,
      senderRole: event.senderRole,
      service: service.key,
      serviceSource: "group_binding",
      question: event.safeText || event.attachmentSummary,
    })
    replyService.transition(pending.id, "generating")
    const sending = replyService.claimUnthreadedSending(pending.id, {
      answer: text,
      decisionReason: "同一发送人存在两个具体候选事项，回答模型生成自然确认",
      decisionConfidence: 1,
    })
    if (!sending) throw new Error("待归属确认无法进入发送状态")
    try {
      const telegramMessageId = await telegramTransport.sendMessage(
        group.accountId,
        group.telegramChatId!,
        text,
        event.telegramMessageId,
        undefined,
        { groupId: group.id, serviceId: service.id, replyId: pending.id, kind: "support_route_clarification" },
      )
      replyService.transition(pending.id, "replied", { telegramReplyMessageId: telegramMessageId })
      return { replyId: pending.id }
    } catch (error) {
      replyService.transition(pending.id, "failed", {
        errorCode: "support_route_clarification_failed",
        decisionReason: "待归属自然确认发送失败",
        operatorDeliveryStatus: error instanceof TelegramDeliveryError && error.state === "uncertain"
          ? "uncertain"
          : "failed",
      })
      throw error
    }
  },
  sendStatusUpdate: async ({ group, service, thread, event, text }) => {
    const outbound = configuredSecretRedactor.assertSafeOutbound(text)
    if (!outbound.allowed || outbound.safeText !== text) throw new Error("催促进度回复未通过发送前安全校验")
    const pending = replyService.createPending({
      threadId: thread.id,
      inputRevision: thread.revision,
      groupId: group.id,
      accountId: group.accountId,
      projectId: service.projectId,
      serviceId: service.id,
      telegramMessageId: event.telegramMessageId,
      senderUserId: event.senderUserId,
      senderUsername: event.senderUsername,
      senderDisplayName: event.senderDisplayName,
      senderRole: event.senderRole,
      service: service.key,
      serviceSource: "group_binding",
      question: event.safeText || event.attachmentSummary,
    })
    replyService.transition(pending.id, "generating")
    const sending = replyService.claimSideMessageSending(pending.id, {
      answer: text,
      decisionReason: "运营仅询问当前排查进度，路由模型生成当班客服进度回复，原排查继续运行",
      decisionConfidence: 1,
    })
    if (!sending) throw new Error("催促进度回复无法进入发送状态")
    try {
      const telegramMessageId = await telegramTransport.sendMessage(
        group.accountId,
        group.telegramChatId!,
        text,
        event.telegramMessageId,
        undefined,
        { groupId: group.id, threadId: thread.id, serviceId: service.id, replyId: pending.id, kind: "progress" },
      )
      replyService.transition(pending.id, "replied", { telegramReplyMessageId: telegramMessageId })
      if (event.senderUserId) supportThreadStore.setSenderFocusAfterDeliveredReply(
        thread.id, event.senderUserId, telegramMessageId,
      )
      return { replyId: pending.id }
    } catch (error) {
      replyService.transition(pending.id, "failed", {
        errorCode: "support_status_update_failed",
        decisionReason: "催促进度回复发送失败，原排查继续运行",
        operatorDeliveryStatus: error instanceof TelegramDeliveryError && error.state === "uncertain"
          ? "uncertain"
          : "failed",
      })
      throw error
    }
  },
  correct: (input) => supportCorrectionService.handle(input).then(() => undefined),
  learningSourceObserver,
})
const messageProcessor = new SupportMessageProcessor(supportThreadCoordinator, supportAnswerWorker)
telegramRuntime = new TelegramRuntime(
  runtimeDatabase,
  runtimeAdminService,
  modelConfigService,
  messageProcessor,
  attachmentService,
)
const runtimeControlService = new RuntimeControlService(
  runtimeDatabase, codexExecutor, telegramRuntime, projectCodeSyncService, memoryLearningWorker, referenceLearningWorker,
)
const app = buildApp({
  adminChatStore,
  adminChatWorker,
  runtimeDatabase,
  runtimeAdminService,
  projectAdminService,
  resourceResolver,
  readonlyResourceBroker,
  replyService,
  replyEventBus,
  runtimeKnowledgeService,
  modelConfigService,
  modelCatalogService,
  modelConnectionTester: codexExecutor,
  runtimeControlService,
  memoryAuthoringService,
  backupService: new BackupService(runtimeDatabase),
  configuredSecretRedactor,
  telegramConnectionService,
  telegramUserLoginService: new TelegramUserLoginService(runtimeAdminService),
  supportThreadQueryService,
  attachmentService,
  magicBookRepository: new MagicBookRepository(snapshot),
  knowledgeResolver: new KnowledgeResolver(snapshot),
  interfaceDocuments: {
    india: indiaInterfaceDocument,
    non_india: nonIndiaInterfaceDocument,
  },
  adminUiRoot: resolve("dist/public"),
})

app.addHook("onClose", async () => {
  process.off("SIGTERM", handleShutdownSignal)
  process.off("SIGINT", handleShutdownSignal)
  clearInterval(retentionTimer)
  clearInterval(codeSnapshotRetentionTimer)
  clearInterval(legacyLearningTimer)
  clearInterval(threadExpiryTimer)
  clearInterval(resourceCleanupTimer)
  dailyGroupShutdownWorker.stop()
  await hourlyCodeSyncWorker.stop()
  await supportDeadlineService.stop()
  await adminChatWorker.stop()
  await referenceLearningWorker.stop()
  await codexExecutor.shutdown()
  await telegramRuntime.stop()
  runtimeDatabase.close()
})

let shuttingDown = false
const handleShutdownSignal = () => {
  if (shuttingDown) return
  shuttingDown = true
  const forceExit = setTimeout(() => process.exit(1), 15_000)
  void app.close().then(
    () => { clearTimeout(forceExit); process.exit(0) },
    () => { clearTimeout(forceExit); process.exit(1) },
  )
}
process.once("SIGTERM", handleShutdownSignal)
process.once("SIGINT", handleShutdownSignal)

const runRetention = () => {
  try {
    const result = retentionService.run()
    const metrics = {
      cutoff: result.cutoff,
      deletedThreads: result.deletedThreads,
      deletedReplies: result.deletedReplies,
      deletedOutputOwnership: result.deletedOutputOwnership,
      deletedMessageEvents: result.deletedMessageEvents,
      deletedAttachmentRows: result.deletedAttachments,
      expiredAttachmentRows: result.expiredAttachmentRows,
      attachmentFileCutoff: result.attachmentFileCutoff,
      deletedAttachmentFiles: result.deletedAttachmentFiles,
      deletedOrphanFiles: result.deletedOrphanFiles,
      deletedAttachmentDirectories: result.deletedAttachmentDirectories,
      failedAttachmentFiles: result.failedAttachmentFiles,
    }
    if (result.failedAttachmentFiles > 0) {
      process.stderr.write(`${JSON.stringify({
        time: new Date().toISOString(), level: "warn", component: "retention",
        message: "客服记录和附件保留任务完成，但有文件未能清理", ...metrics,
      })}\n`)
    } else if (Object.values(metrics).some((value) => typeof value === "number" && value > 0)) {
      process.stdout.write(`${JSON.stringify({
        time: new Date().toISOString(), level: "info", component: "retention",
        message: "客服记录和附件保留任务完成", ...metrics,
      })}\n`)
    }
  } catch {
    process.stderr.write(`${JSON.stringify({
      time: new Date().toISOString(), level: "warn", component: "retention",
      message: "客服记录和附件保留任务执行失败",
    })}\n`)
  }
}

queueMicrotask(runRetention)
const retentionTimer = setInterval(() => {
  runRetention()
}, 24 * 60 * 60 * 1000)
retentionTimer.unref()

const runCodeSnapshotRetention = () => {
  void codeSnapshotRetentionService.run().then((result) => {
    if (result.deletedSnapshots > 0 || result.deletedStagingDirectories > 0
      || result.deletedOrphanSnapshotDirectories > 0 || result.failedPaths > 0) {
      const target = result.failedPaths > 0 ? process.stderr : process.stdout
      target.write(`${JSON.stringify({
        time: new Date().toISOString(),
        level: result.failedPaths > 0 ? "warn" : "info",
        component: "code_snapshot_retention",
        message: "代码快照保留任务完成",
        ...result,
      })}\n`)
    }
  }).catch(() => {
    process.stderr.write(`${JSON.stringify({
      time: new Date().toISOString(), level: "warn", component: "code_snapshot_retention",
      message: "代码快照保留任务执行失败",
    })}\n`)
  })
}
queueMicrotask(runCodeSnapshotRetention)
const codeSnapshotRetentionTimer = setInterval(runCodeSnapshotRetention, 24 * 60 * 60 * 1000)
codeSnapshotRetentionTimer.unref()

supportThreadStore.archiveExpired()
const threadExpiryTimer = setInterval(() => {
  try { supportThreadStore.archiveExpired() } catch { /* 下次定时任务继续归档。 */ }
}, 60_000)
threadExpiryTimer.unref()

const resourceCleanupTimer = setInterval(() => {
  void ResourceWorkspace.cleanupOrphans().catch(() => undefined)
}, 10 * 60 * 1000)
resourceCleanupTimer.unref()

let legacyLearningBusy = false
const drainLegacyLearning = () => {
  if (legacyLearningBusy) return
  legacyLearningBusy = true
  void memoryLearningWorker.runOnce().then(
    () => { legacyLearningBusy = false },
    () => { legacyLearningBusy = false },
  )
}
queueMicrotask(drainLegacyLearning)
const legacyLearningTimer = setInterval(() => {
  drainLegacyLearning()
}, 5_000)
legacyLearningTimer.unref()

await app.listen({ host: env.host, port: env.port })
dailyGroupShutdownWorker.start()
adminChatWorker.start()
telegramRuntime.start()
hourlyCodeSyncWorker.start()
supportDeadlineService.start()
referenceLearningWorker.start()
