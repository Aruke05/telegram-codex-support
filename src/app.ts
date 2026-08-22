import Fastify, { type FastifyInstance } from "fastify"
import fastifyMultipart from "@fastify/multipart"

import type { AdminChatStore } from "./admin-chat/store.js"
import type { AdminChatWorker } from "./admin-chat/worker.js"
import type { GroupCatalog } from "./catalog/schema.js"
import type { InterfaceDocumentScope, InterfaceDocumentSnapshot } from "./knowledge/interface-documents.js"
import type { KnowledgeResolver } from "./knowledge/resolver.js"
import type { MagicBookRepository } from "./magicbook/repository.js"
import type { ProjectAdminService } from "./projects/project-admin-service.js"
import type { ReadonlyResourceBrokerPort, ResourceResolverPort } from "./routes/diagnostics.js"
import type { ReplyEventBus } from "./replies/reply-event-bus.js"
import type { ReplyService } from "./replies/reply-service.js"
import { ModelExecutionError } from "./models/errors.js"
import { GroupBatchUpdateError, type RuntimeAdminService } from "./runtime/admin-service.js"
import type { BackupService } from "./runtime/backup-service.js"
import type { RuntimeDatabase } from "./runtime/database.js"
import { redactText, type ConfiguredSecretRedactor } from "./security/dlp.js"
import type { RuntimeKnowledgeService } from "./runtime/knowledge-service.js"
import type { ModelConfigService } from "./runtime/model-config-service.js"
import type { ModelCatalogService } from "./models/model-catalog-service.js"
import type { RuntimeControlService } from "./runtime/control-service.js"
import type { MemoryAuthoringService } from "./learning/authoring.js"
import type { TelegramConnectionService } from "./telegram/connection-service.js"
import type { TelegramUserLoginService } from "./telegram/user-login-service.js"
import type { SupportThreadQueryService } from "./support/thread-query-service.js"
import type { AttachmentService } from "./telegram/attachment-service.js"
import type { ShadowReportStore } from "./learning/shadow-report-store.js"
import type { ShadowReportWorker } from "./learning/shadow-report-worker.js"
import type { AdminAuthService } from "./auth/service.js"
import { registerCatalogRoutes } from "./routes/catalog.js"
import { registerAdminChatRoutes } from "./routes/admin-chat.js"
import { registerDiagnosticRoutes } from "./routes/diagnostics.js"
import { registerKnowledgeRoutes } from "./routes/knowledge.js"
import { registerMagicBookRoutes } from "./routes/magicbook.js"
import { registerModelConfigRoutes } from "./routes/model-config.js"
import type { ModelConnectionTester } from "./routes/model-config.js"
import { registerOperationsRoutes } from "./routes/operations.js"
import { registerProjectRoutes } from "./routes/projects.js"
import { registerRuntimeAdminRoutes } from "./routes/runtime-admin.js"
import { registerSecurityRoutes } from "./routes/security.js"
import { registerShadowLearningRoutes } from "./routes/shadow-learning.js"
import { registerAuth } from "./routes/auth.js"
import { registerAdminUi } from "./ui/register.js"
import { APP_VERSION, DATABASE_SCHEMA_VERSION } from "./version.js"

export type AppDependencies = {
  adminChatStore: AdminChatStore
  adminChatWorker: Pick<AdminChatWorker, "wake" | "cancel"> & Partial<Pick<AdminChatWorker, "start" | "stop">>
  runtimeDatabase: RuntimeDatabase
  groupCatalog: GroupCatalog
  magicBookRepository: MagicBookRepository
  knowledgeResolver: KnowledgeResolver
  interfaceDocument: InterfaceDocumentSnapshot
  interfaceDocuments: Record<InterfaceDocumentScope, InterfaceDocumentSnapshot>
  runtimeAdminService: RuntimeAdminService
  projectAdminService: ProjectAdminService
  resourceResolver: ResourceResolverPort
  readonlyResourceBroker: ReadonlyResourceBrokerPort
  replyService: ReplyService
  replyEventBus: ReplyEventBus
  runtimeKnowledgeService: RuntimeKnowledgeService
  modelConfigService: ModelConfigService
  modelCatalogService: ModelCatalogService
  modelConnectionTester: ModelConnectionTester
  runtimeControlService: RuntimeControlService
  memoryAuthoringService: MemoryAuthoringService
  backupService: BackupService
  configuredSecretRedactor: ConfiguredSecretRedactor
  telegramConnectionService: TelegramConnectionService
  telegramUserLoginService: TelegramUserLoginService
  supportThreadQueryService: SupportThreadQueryService
  attachmentService: AttachmentService
  shadowReportStore: ShadowReportStore
  shadowReportWorker: Pick<ShadowReportWorker, "runNow" | "retry">
  authService: AdminAuthService
  adminUiRoot: string
}

export function buildApp(deps: Partial<AppDependencies> = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  })
  void app.register(fastifyMultipart, {
    limits: { files: 8, fields: 4, parts: 12, fileSize: 20 * 1024 * 1024 },
  })
  const onlineImportWorker = deps.adminChatWorker?.start && deps.adminChatWorker.stop
    ? {
        start: () => deps.adminChatWorker?.start?.(),
        stop: () => deps.adminChatWorker?.stop?.() ?? Promise.resolve(),
      }
    : undefined

  app.get("/health", async () => ({
    status: "ok",
    service: "telegram-codex-support",
    version: APP_VERSION,
    schemaVersion: deps.runtimeDatabase?.schemaVersion() ?? DATABASE_SCHEMA_VERSION,
  }))

  if (deps.authService) registerAuth(app, deps.authService)

  if (deps.runtimeAdminService) registerRuntimeAdminRoutes(
    app,
    deps.runtimeAdminService,
    deps.telegramConnectionService,
    deps.telegramUserLoginService,
  )
  else if (deps.groupCatalog) registerCatalogRoutes(app, deps.groupCatalog)
  if (deps.projectAdminService) registerProjectRoutes(app, deps.projectAdminService)
  if (deps.adminChatStore && deps.adminChatWorker && deps.runtimeDatabase && deps.configuredSecretRedactor) {
    registerAdminChatRoutes(app, {
      store: deps.adminChatStore,
      worker: deps.adminChatWorker,
      database: deps.runtimeDatabase,
      ...(deps.attachmentService ? { attachments: deps.attachmentService } : {}),
      ...(deps.memoryAuthoringService ? { authoring: deps.memoryAuthoringService } : {}),
    })
  }
  if (deps.modelConfigService) registerModelConfigRoutes(
    app, deps.modelConfigService, deps.runtimeControlService, deps.modelCatalogService, deps.modelConnectionTester,
  )
  if (deps.resourceResolver) registerDiagnosticRoutes(app, deps.resourceResolver, deps.readonlyResourceBroker)
  if (deps.runtimeKnowledgeService && deps.backupService) {
    registerOperationsRoutes(
      app,
      deps.runtimeKnowledgeService,
      deps.backupService,
      deps.replyService,
      deps.replyEventBus,
      deps.memoryAuthoringService,
      deps.supportThreadQueryService,
      onlineImportWorker,
    )
  }
  if (deps.magicBookRepository && deps.knowledgeResolver) {
    registerMagicBookRoutes(app, deps.magicBookRepository, deps.knowledgeResolver)
  }
  if (deps.interfaceDocuments) registerKnowledgeRoutes(app, deps.interfaceDocuments)
  else if (deps.interfaceDocument) registerKnowledgeRoutes(app, deps.interfaceDocument)
  if (deps.shadowReportStore && deps.shadowReportWorker) {
    registerShadowLearningRoutes(app, deps.shadowReportStore, deps.shadowReportWorker)
  }
  registerSecurityRoutes(app, deps.configuredSecretRedactor)
  if (deps.adminUiRoot) registerAdminUi(app, deps.adminUiRoot)

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "接口不存在" }))
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof Error && error.name === "ZodError") return reply.code(400).send({ error: "配置内容格式错误" })
    if (error instanceof GroupBatchUpdateError && !redactText(error.message).changed) {
      return reply.code(400).send({ error: error.message })
    }
    const safeMessages = [
      "Telegram 账号不存在", "群配置不存在", "群标识不能重复", "群 ID 不能重复",
      "群接入方式与账号类型不一致", "账号仍被群配置使用", "账号状态格式错误",
      "群配置保存失败", "角色配置不存在", "固定规则不存在", "固定规则状态格式错误",
      "固定规则删除格式错误", "系统固定规则不能删除",
      "规则内容脱敏后为空", "AI 记忆不存在", "记忆状态格式错误", "记忆内容脱敏后为空",
      "纠正内容脱敏后为空", "问题内容脱敏后为空", "问题内容为空", "回复记录不存在",
      "迁移文件不能覆盖运行数据库", "迁移数据库创建失败", "迁移数据库版本不兼容",
      "迁移数据库结构不完整", "迁移数据库包含客服账号凭据", "迁移数据库包含本机账号绑定",
      "迁移数据库不能为空", "迁移数据库超过 64 GB",
      "迁移数据库包含敏感信息",
      "系统固定规则不能修改",
      "只有 Bot 可以同步命令", "Bot Token 未配置", "Telegram 请求失败",
      "只有个人账号需要登录", "个人账号不存在", "没有进行中的登录",
      "验证码不能为空", "两步验证密码不能为空", "Telegram 连接服务未启用",
      "个人账号登录服务未启用",
      "学习报告不存在", "只有失败的学习报告可以继续生成", "学习报告不能重试",
      "配置包含敏感信息", "只能配置一个技术告警群", "启用群必须绑定已启用的客服账号",
      "静态知识包含敏感信息",
      "迁移数据库完整性检查失败", "迁移数据库外键关系损坏",
      "迁移数据库记忆哈希损坏", "迁移数据库记忆关系损坏",
      "项目不存在", "项目标识不能重复", "项目仍有服务资源", "项目仍被群配置使用",
      "项目仍有客服记录，只能停用", "服务仍有客服记录，只能停用",
      "代码仓库不存在", "代码仓库不属于该项目", "代码仓库仍被服务使用",
      "前后端代码仓库不能相同", "服务代码仓库必须启用", "后端仓库必须是 java-project", "前端仓库必须是 sfzf-web",
      "项目服务不存在", "服务不属于该项目", "服务仍有连接资源", "服务仍被群配置使用",
      "服务器资源不存在", "数据库资源不存在", "Peakpay 不允许配置",
      "项目和服务必须同时配置", "未找到服务资源", "服务资源匹配不唯一",
      "只允许只读查询", "客服记录状态流转无效", "客服记录游标无效",
      "客服线程游标无效", "客服问题线程不存在",
      "只允许读取原始字段",
      "只允许查询当前服务数据库",
      "模型配置不存在", "运行配置不存在",
      "模型配置包含敏感信息", "模型检测结果包含敏感信息", "模型别名不能重复", "模型别名不存在",
      "模型别名仍有运行中的任务", "运行模型绑定不存在", "运行配置只能选择已启用模型",
      "本机模型密钥库未配置", "启用 API 模型前必须配置密钥", "模型连接检测失败",
      "Codex CLI 不支持 Priority 加速", "API 密钥接入不支持 Codex Fast",
      "DeepSeek 仅支持 API 密钥接入", "Claude 仅支持 API 密钥接入", "GLM 仅支持 API 密钥接入",
      "DeepSeek 不支持 Priority 加速", "Claude 不支持 Priority 加速", "GLM 不支持 Priority 加速",
      "回答模型已停用", "记忆模型已停用", "分支格式错误", "服务未配置代码仓库",
      "Codex 命令不可用", "Codex 执行失败", "Codex 未返回结果", "Codex 执行超时",
      "Codex 返回格式错误", "Codex 结果过大", "个人账号连接未就绪",
    ]
    const safeModelReference = error instanceof Error
      && error.message.startsWith("模型别名仍被引用 ")
      && !redactText(error.message).changed
    if (error instanceof ModelExecutionError && !redactText(error.message).changed) {
      const status = ["provider_timeout", "provider_unavailable"].includes(error.code) ? 503 : 400
      return reply.code(status).send({ error: error.message, code: error.code })
    }
    if (error instanceof Error && (safeMessages.includes(error.message) || safeModelReference)) return reply.code(400).send({ error: error.message })
    return reply.code(500).send({ error: "请求处理失败" })
  })

  return app
}
