import { createReadStream } from "node:fs"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type { AdminChatStore } from "../admin-chat/store.js"
import type { MemoryAuthoringService } from "../learning/authoring.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { AdminChatSession, AdminChatTurn } from "../runtime/types.js"
import type { AttachmentService } from "../telegram/attachment-service.js"
import type { SupportAttachmentContext } from "../support/agent.js"
import { requirePrincipal } from "../auth/types.js"

type AdminChatWorkerPort = { wake(): void; cancel(turnId: string): boolean }

export type AdminChatRoutesDependencies = {
  store: AdminChatStore
  worker: AdminChatWorkerPort
  database: Pick<RuntimeDatabase, "readProjects" | "readProjectServices" | "prepare">
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

function publicTurn(turn: AdminChatTurn) {
  return {
    ...turn,
    attachments: turn.attachments.map(({ storagePath, extractedText, ...attachment }) => ({
      ...attachment,
      url: storagePath ? `/api/admin-chat/attachments/${encodeURIComponent(attachment.id)}` : null,
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
  const viewer = (request: FastifyRequest) => {
    const principal = requirePrincipal(request)
    return { userId: principal.userId, isSuperAdmin: principal.isSuperAdmin }
  }
  const publicSession = (session: AdminChatSession & {
    latestTurnStatus?: AdminChatTurn["status"] | null
    latestTurnUpdatedAt?: string | null
  }) => {
    const project = deps.database.readProjects("WHERE id=?", [session.projectId])[0]
    const service = deps.database.readProjectServices("WHERE id=?", [session.serviceId])[0]
    if (!project || !service) throw new Error("后台对话关联的项目服务不存在")
    const owner = session.createdByUserId
      ? deps.database.prepare("SELECT username FROM admin_users WHERE id=?").get(session.createdByUserId) as { username?: unknown } | undefined
      : undefined
    const createdByUsername = String(owner?.username ?? "system")
    const { createdByUserId: _createdByUserId, ...safeSession } = session
    return {
      ...safeSession,
      createdByUsername,
      title: session.title,
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
      const principal = requirePrincipal(request)
      return reply.code(201).send(publicSession(deps.store.createSession(input.serviceId, principal.userId)))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.get<{ Querystring: unknown }>("/api/admin-chat/sessions", async (request) => {
    const input = listSessionsSchema.parse(request.query)
    return { sessions: deps.store.listSessions(input.serviceId, viewer(request)).map(publicSession) }
  })

  app.get("/api/admin-chat/services", async () => {
    const projects = deps.database.readProjects("WHERE enabled=1")
    const services = deps.database.readProjectServices("WHERE enabled=1")
    return {
      projects: projects.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
        enabled: project.enabled,
        services: services.filter((service) => service.projectId === project.id).map((service) => ({
          id: service.id,
          projectId: service.projectId,
          key: service.key,
          name: service.name,
          region: service.region,
          timezone: service.timezone,
          branch: service.branch,
          enabled: service.enabled,
          repositories: [],
          serverCount: 0,
          databaseCount: 0,
          createdAt: service.createdAt,
          updatedAt: service.updatedAt,
        })),
      })),
    }
  })

  app.get<{ Params: { id: string } }>("/api/admin-chat/sessions/:id", async (request, reply) => {
    try {
      const detail = deps.store.getSession(idSchema.parse(request.params.id), viewer(request))
      return {
        session: publicSession(detail.session),
        turns: detail.turns.map(publicTurn),
      }
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Body: unknown }>("/api/admin-chat/turns", async (request, reply) => {
    try {
      const message = await messageInput(request, deps.attachments)
      const input = createConversationSchema.parse(message.fields)
      const principal = requirePrincipal(request)
      const created = deps.store.createSessionWithTurn(input.serviceId, input.question, message.files, principal.userId)
      deps.worker.wake()
      return reply.code(202).send({
        session: publicSession(created.session),
        turn: publicTurn(created.turn),
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
          viewer(request),
        )
        created.supersededTurnIds.forEach((turnId) => deps.worker.cancel(turnId))
        deps.worker.wake()
        return reply.code(202).send(publicTurn(created.turn))
      } catch (error) {
        return handleKnownError(error, reply)
      }
    },
  )

  app.post<{ Params: { id: string } }>("/api/admin-chat/turns/:id/retry", async (request, reply) => {
    try {
      const created = deps.store.retryTurnSupersedingActive(idSchema.parse(request.params.id), viewer(request))
      created.supersededTurnIds.forEach((turnId) => deps.worker.cancel(turnId))
      deps.worker.wake()
      return reply.code(202).send(publicTurn(created.turn))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Params: { id: string } }>("/api/admin-chat/turns/:id/cancel", async (request, reply) => {
    try {
      const turnId = idSchema.parse(request.params.id)
      const turn = deps.store.cancelTurn(turnId, viewer(request))
      deps.worker.cancel(turnId)
      return reply.send(publicTurn(turn))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/admin-chat/turns/:id/corrections", async (request, reply) => {
    try {
      const input = correctionSchema.parse(request.body)
      const turnId = idSchema.parse(request.params.id)
      const original = deps.store.getTurn(turnId, viewer(request))
      if (original.status !== "completed") throw new Error("只有已完成的回答可以纠正")
      const session = deps.store.getSession(original.sessionId, viewer(request)).session
      const project = deps.database.readProjects("WHERE id=?", [session.projectId])[0]
      const service = deps.database.readProjectServices("WHERE id=?", [session.serviceId])[0]
      if (!project || !service) throw new Error("后台对话关联的项目服务不存在")
      const previousCorrection = original.corrections.at(-1)
      await deps.authoring?.correctAdminChatTurn({
        originalQuestion: original.question || `附件消息 ${original.attachments.map((attachment) => attachment.name).join(" ")}`,
        previousAnswer: previousCorrection?.correctedAnswer || original.answer,
        correctedAnswer: input.correctedAnswer,
        reason: input.reason,
        correctedBy: requirePrincipal(request).username,
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
        requirePrincipal(request).username,
      )
      return reply.code(201).send(publicTurn(turn))
    } catch (error) {
      return handleKnownError(error, reply)
    }
  })

  app.get<{ Params: { id: string }; Querystring: unknown }>("/api/admin-chat/attachments/:id", async (request, reply) => {
    try {
      const input = attachmentQuerySchema.parse(request.query)
      const attachment = deps.store.getAttachment(idSchema.parse(request.params.id), viewer(request))
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
