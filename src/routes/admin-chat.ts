import { createReadStream } from "node:fs"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type { AdminChatStore } from "../admin-chat/store.js"
import type { MemoryAuthoringService } from "../learning/authoring.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { AdminChatSession, AdminChatTurn } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { AttachmentService } from "../telegram/attachment-service.js"
import type { SupportAttachmentContext } from "../support/agent.js"

type AdminChatWorkerPort = { wake(): void; cancel(turnId: string): boolean }

export type AdminChatRoutesDependencies = {
  store: AdminChatStore
  worker: AdminChatWorkerPort
  database: Pick<RuntimeDatabase, "readProjects" | "readProjectServices">
  redactor: ConfiguredSecretRedactor
  attachments?: Pick<AttachmentService, "prepareBuffer" | "resolveStoredPath">
  authoring?: Pick<MemoryAuthoringService, "correctAdminChatTurn">
}

const idSchema = z.string().uuid()
const createSessionSchema = z.object({ serviceId: idSchema }).strict()
const createTurnSchema = z.object({ question: z.string().max(12000).default("") }).strict()
const createConversationSchema = z.object({ serviceId: idSchema, question: z.string().max(12000).default("") }).strict()
const correctionSchema = z.object({
  correctedAnswer: z.string().trim().min(1).max(12000),
  reason: z.string().trim().min(1).max(1000),
  correctedBy: z.string().trim().min(1).max(160).default("后台管理员"),
}).strict()
const listSessionsSchema = z.object({ serviceId: idSchema.optional() }).strict()
const attachmentQuerySchema = z.object({ download: z.enum(["1", "true"]).optional() }).strict()

const inputErrors = new Set([
  "服务不存在或未启用",
  "后台对话会话不存在",
  "后台对话轮次不存在",
  "后台对话附件不存在",
  "只有失败或已终止的后台对话轮次可以重试",
  "只有已完成的回答可以纠正",
  "请输入问题或添加附件",
  "后台对话附件上传不可用",
  "单个附件不能超过 20MB",
  "单条消息附件总大小不能超过 40MB",
])

function handleKnownError(error: unknown, reply: FastifyReply): never | FastifyReply {
  if (error instanceof Error && error.message === "当前会话还有问题正在处理") {
    return reply.code(409).send({ error: error.message })
  }
  if (error instanceof Error && inputErrors.has(error.message)) {
    return reply.code(400).send({ error: error.message })
  }
  throw error
}

function redactJson(value: unknown, redactor: ConfiguredSecretRedactor): unknown {
  if (typeof value === "string") return redactor.redact(value).text
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redactor))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, redactor)]))
  }
  return value
}

function publicTurn(turn: AdminChatTurn, redactor: ConfiguredSecretRedactor) {
  return {
    ...turn,
    question: redactor.redact(turn.question).text,
    answer: redactor.redact(turn.answer).text,
    decisionReason: turn.decisionReason ? redactor.redact(turn.decisionReason).text : null,
    investigation: redactJson(turn.investigation, redactor) as AdminChatTurn["investigation"],
    attachments: turn.attachments.map(({ storagePath, extractedText, ...attachment }) => ({
      ...attachment,
      name: redactor.redact(attachment.name).text,
      mimeType: redactor.redact(attachment.mimeType).text,
      url: storagePath ? `/api/admin-chat/attachments/${encodeURIComponent(attachment.id)}` : null,
    })),
    corrections: turn.corrections.map((correction) => ({
      ...correction,
      correctedAnswer: redactor.redact(correction.correctedAnswer).text,
      reason: redactor.redact(correction.reason).text,
      correctedBy: redactor.redact(correction.correctedBy).text,
    })),
  }
}

async function messageInput(
  request: FastifyRequest,
  attachments: AdminChatRoutesDependencies["attachments"],
): Promise<{ fields: Record<string, unknown>; files: SupportAttachmentContext[] }> {
  if (!request.isMultipart()) return { fields: request.body as Record<string, unknown>, files: [] }
  if (!attachments) throw new Error("后台对话附件上传不可用")
  const fields: Record<string, unknown> = {}
  const files: SupportAttachmentContext[] = []
  let totalSize = 0
  for await (const part of request.parts({
    limits: { files: 8, fields: 4, parts: 12, fileSize: 20 * 1024 * 1024 },
  })) {
    if (part.type === "field") {
      if (part.fieldname === "question" || part.fieldname === "serviceId") fields[part.fieldname] = String(part.value)
      continue
    }
    const buffer = await part.toBuffer()
    totalSize += buffer.byteLength
    if (totalSize > 40 * 1024 * 1024) throw new Error("单条消息附件总大小不能超过 40MB")
    files.push(await attachments.prepareBuffer(part.filename || "未命名附件", part.mimetype, buffer))
  }
  return { fields, files }
}

function contentDisposition(name: string, download: boolean): string {
  const safeName = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
  return `${download ? "attachment" : "inline"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function registerAdminChatRoutes(app: FastifyInstance, deps: AdminChatRoutesDependencies): void {
  const publicSession = (session: AdminChatSession & {
    latestTurnStatus?: AdminChatTurn["status"] | null
    latestTurnUpdatedAt?: string | null
  }) => {
    const project = deps.database.readProjects("WHERE id=?", [session.projectId])[0]
    const service = deps.database.readProjectServices("WHERE id=?", [session.serviceId])[0]
    if (!project || !service) throw new Error("后台对话关联的项目服务不存在")
    return {
      ...session,
      title: deps.redactor.redact(session.title).text,
      latestTurnStatus: session.latestTurnStatus ?? null,
      latestTurnUpdatedAt: session.latestTurnUpdatedAt ?? null,
      project: { id: project.id, key: project.key, name: project.name },
      service: {
        id: service.id,
        key: service.key,
        name: service.name,
        region: service.region,
        branch: service.branch,
        enabled: service.enabled,
      },
    }
  }

  app.post<{ Body: unknown }>("/api/admin-chat/sessions", async (request, reply) => {
    try {
      const input = createSessionSchema.parse(request.body)
      return reply.code(201).send(publicSession(deps.store.createSession(input.serviceId)))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.get<{ Querystring: unknown }>("/api/admin-chat/sessions", async (request) => {
    const input = listSessionsSchema.parse(request.query)
    return { sessions: deps.store.listSessions(input.serviceId).map(publicSession) }
  })

  app.get<{ Params: { id: string } }>("/api/admin-chat/sessions/:id", async (request, reply) => {
    try {
      const detail = deps.store.getSession(idSchema.parse(request.params.id))
      return {
        session: publicSession(detail.session),
        turns: detail.turns.map((turn) => publicTurn(turn, deps.redactor)),
      }
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Body: unknown }>("/api/admin-chat/turns", async (request, reply) => {
    try {
      const message = await messageInput(request, deps.attachments)
      const input = createConversationSchema.parse(message.fields)
      const created = deps.store.createSessionWithTurn(input.serviceId, input.question, message.files)
      deps.worker.wake()
      return reply.code(202).send({
        session: publicSession(created.session),
        turn: publicTurn(created.turn, deps.redactor),
      })
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/admin-chat/sessions/:id/turns",
    async (request, reply) => {
      try {
        const message = await messageInput(request, deps.attachments)
        const input = createTurnSchema.parse(message.fields)
        const created = deps.store.createTurnSupersedingActive(
          idSchema.parse(request.params.id),
          input.question,
          message.files,
        )
        created.supersededTurnIds.forEach((turnId) => deps.worker.cancel(turnId))
        deps.worker.wake()
        return reply.code(202).send(publicTurn(created.turn, deps.redactor))
      } catch (error) {
        return handleKnownError(error, reply)
      }
    },
  )

  app.post<{ Params: { id: string } }>("/api/admin-chat/turns/:id/retry", async (request, reply) => {
    try {
      const created = deps.store.retryTurnSupersedingActive(idSchema.parse(request.params.id))
      created.supersededTurnIds.forEach((turnId) => deps.worker.cancel(turnId))
      deps.worker.wake()
      return reply.code(202).send(publicTurn(created.turn, deps.redactor))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Params: { id: string } }>("/api/admin-chat/turns/:id/cancel", async (request, reply) => {
    try {
      const turnId = idSchema.parse(request.params.id)
      const turn = deps.store.cancelTurn(turnId)
      deps.worker.cancel(turnId)
      return reply.send(publicTurn(turn, deps.redactor))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/admin-chat/turns/:id/corrections", async (request, reply) => {
    try {
      const input = correctionSchema.parse(request.body)
      const turnId = idSchema.parse(request.params.id)
      const original = deps.store.getTurn(turnId)
      if (original.status !== "completed") throw new Error("只有已完成的回答可以纠正")
      const session = deps.store.getSession(original.sessionId).session
      const project = deps.database.readProjects("WHERE id=?", [session.projectId])[0]
      const service = deps.database.readProjectServices("WHERE id=?", [session.serviceId])[0]
      if (!project || !service) throw new Error("后台对话关联的项目服务不存在")
      const previousCorrection = original.corrections.at(-1)
      await deps.authoring?.correctAdminChatTurn({
        originalQuestion: original.question || `附件消息 ${original.attachments.map((attachment) => attachment.name).join(" ")}`,
        previousAnswer: previousCorrection?.correctedAnswer || original.answer,
        correctedAnswer: input.correctedAnswer,
        reason: input.reason,
        correctedBy: input.correctedBy,
        scope: project.defaultKnowledgeScope,
        region: service.region || null,
        branch: service.branch || null,
        referencedMemoryIds: original.memoryVersionRefs,
        codeRevision: original.codeRevision,
        sourceRef: `admin-chat:${turnId}`,
      })
      const turn = deps.store.correctTurn(
        turnId,
        input.correctedAnswer,
        input.reason,
        input.correctedBy,
      )
      return reply.code(201).send(publicTurn(turn, deps.redactor))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.get<{ Params: { id: string }; Querystring: unknown }>("/api/admin-chat/attachments/:id", async (request, reply) => {
    try {
      const input = attachmentQuerySchema.parse(request.query)
      const attachment = deps.store.getAttachment(idSchema.parse(request.params.id))
      const filePath = deps.attachments?.resolveStoredPath(attachment.storagePath)
      if (!filePath) return reply.code(404).send({ error: "附件文件不存在" })
      reply.type(attachment.mimeType || "application/octet-stream")
      reply.header("Content-Disposition", contentDisposition(attachment.name, Boolean(input.download)))
      reply.header("X-Content-Type-Options", "nosniff")
      return reply.send(createReadStream(filePath))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })
}
