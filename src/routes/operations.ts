import { createReadStream, createWriteStream } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import type { FastifyInstance } from "fastify"

import type { ReplyEventBus } from "../replies/reply-event-bus.js"
import type { ReplyService } from "../replies/reply-service.js"
import type { MemoryAuthoringService } from "../learning/authoring.js"
import type { SupportThreadQueryService } from "../support/thread-query-service.js"
import type { BackupService } from "../runtime/backup-service.js"
import { isMemoryStatus, type RuntimeKnowledgeService } from "../runtime/knowledge-service.js"
import { referenceLearningTerminalResultSchema, type MemoryEventType, type ReplyRecord } from "../runtime/types.js"

type OnlineImportWorkerPort = {
  stop(): Promise<void>
  start(): void
}

export function registerOperationsRoutes(
  app: FastifyInstance,
  knowledge: RuntimeKnowledgeService,
  backup: BackupService,
  replies?: ReplyService,
  replyEvents?: ReplyEventBus,
  authoring?: MemoryAuthoringService,
  threadQueries?: SupportThreadQueryService,
  onlineImportWorker?: OnlineImportWorkerPort,
): void {
  app.addContentTypeParser(
    ["application/vnd.sqlite3", "application/octet-stream"],
    (_request, payload, done) => done(null, payload),
  )
  if (threadQueries) registerSupportThreadRoutes(app, threadQueries)

  app.get<{
    Querystring: { factId?: string; status?: string; scope?: string; region?: string; branch?: string; q?: string; limit?: string }
  }>("/api/memories", async (request) => {
    const status = request.query.status
    if (status && !isMemoryStatus(status)) throw new Error("记忆状态格式错误")
    const memoryStatus = isMemoryStatus(status) ? status : undefined
    const filters = {
      ...(request.query.factId ? { factId: request.query.factId } : {}),
      ...(memoryStatus ? { status: memoryStatus } : {}),
      ...(request.query.scope ? { scope: request.query.scope } : {}),
      ...(request.query.region ? { region: request.query.region } : {}),
      ...(request.query.branch ? { branch: request.query.branch } : {}),
      ...(request.query.q ? { q: request.query.q } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    }
    return {
      generation: knowledge.database.memoryGeneration(),
      items: knowledge.listMemories(filters),
    }
  })

  app.get<{ Params: { id: string } }>("/api/memories/:id", async (request) => ({
    memory: knowledge.getMemory(request.params.id),
    events: knowledge.listEvents({ factId: knowledge.getMemory(request.params.id).factId }),
    evidence: knowledge.getMemoryEvidence(request.params.id),
  }))

  app.get<{ Querystring: {
    processingStatus?: string
    classification?: string
    risk?: string
    limit?: string
  } }>("/api/learning-observations", async (request) => {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (request.query.processingStatus) {
      if (!["pending", "ignored", "running", "completed", "failed"].includes(request.query.processingStatus)) {
        throw new Error("学习观察状态格式错误")
      }
      clauses.push("observation.processing_status=?")
      parameters.push(request.query.processingStatus)
    }
    if (request.query.classification) {
      if (!["unclassified", "style", "correction", "business_rule", "ephemeral", "action_result", "general"]
        .includes(request.query.classification)) throw new Error("学习终态分类格式错误")
      clauses.push("result.classification=?")
      parameters.push(request.query.classification)
    }
    if (request.query.risk) {
      if (!["low", "medium", "high"].includes(request.query.risk)) throw new Error("学习观察风险格式错误")
      clauses.push("result.risk=?")
      parameters.push(request.query.risk)
    }
    const requestedLimit = Number(request.query.limit ?? 200)
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 200
    const rows = knowledge.database.prepare(`SELECT observation.id,observation.message_event_id,
      observation.source_telegram_user_id,observation.source_role,observation.thread_id,observation.service_id,
      observation.association_reason,observation.association_confidence,observation.takeover_status,
      observation.processing_status,observation.created_at,observation.updated_at,
      result.classification AS terminal_classification,result.action AS terminal_action,result.risk AS terminal_risk,
      result.outcome AS terminal_outcome,result.reason_code AS terminal_reason_code,
      result.memory_version_id AS terminal_memory_version_id,
      result.operator_style_version_id AS terminal_operator_style_version_id,result.created_at AS terminal_created_at
      FROM learning_source_observations observation
      LEFT JOIN reference_learning_results result ON result.id=(
        SELECT latest.id FROM reference_learning_results latest WHERE latest.observation_id=observation.id
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
      )
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY observation.created_at DESC,observation.id DESC LIMIT ${limit}`).all(...parameters) as Array<Record<string, unknown>>
    return { items: rows.map((row) => ({
      id: row.id,
      messageEventId: row.message_event_id,
      sourceTelegramUserId: row.source_telegram_user_id,
      sourceRole: row.source_role,
      threadId: row.thread_id,
      serviceId: row.service_id,
      associationReason: row.association_reason,
      associationConfidence: Number(row.association_confidence),
      takeoverStatus: row.takeover_status,
      processingStatus: row.processing_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalResult: row.terminal_classification == null ? null : referenceLearningTerminalResultSchema.parse({
        classification: row.terminal_classification,
        action: row.terminal_action,
        risk: row.terminal_risk,
        outcome: row.terminal_outcome,
        reasonCode: row.terminal_reason_code,
        memoryVersionId: row.terminal_memory_version_id,
        operatorStyleVersionId: row.terminal_operator_style_version_id,
        createdAt: row.terminal_created_at,
      }),
    })) }
  })

  app.get("/api/operator-style-versions", async () => ({
    items: knowledge.database.readOperatorStyleVersions("ORDER BY version_number DESC"),
  }))

  app.post<{ Body: unknown }>("/api/memories", async (request, reply) => (
    reply.code(201).send(authoring ? await authoring.createMemory(request.body) : await knowledge.createMemory(request.body as never))
  ))

  app.post<{ Body: unknown }>("/api/memories/observations", async (request, reply) => (
    reply.code(201).send(await knowledge.submitObservation(request.body as never))
  ))

  app.patch<{ Params: { id: string }; Body: { status?: string; actor?: string } }>(
    "/api/memories/:id/status",
    async (request) => {
      if (!isMemoryStatus(request.body?.status) || !request.body.actor) throw new Error("记忆状态格式错误")
      return knowledge.setMemoryStatus(request.params.id, request.body.status, request.body.actor)
    },
  )

  app.get<{ Querystring: { type?: MemoryEventType; factId?: string; limit?: string } }>("/api/memory-events", async (request) => ({
    events: knowledge.listEvents({
      ...(request.query.type ? { type: request.query.type } : {}),
      ...(request.query.factId ? { factId: request.query.factId } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    }),
  }))

  app.get<{ Querystring: { enabled?: string; scope?: string } }>("/api/directives", async (request) => ({
    directives: knowledge.listDirectives({
      ...(request.query.enabled === undefined ? {} : { enabled: request.query.enabled === "true" }),
      ...(request.query.scope ? { scope: request.query.scope } : {}),
    }),
  }))

  app.post<{ Body: unknown }>("/api/directives", async (request, reply) => (
    reply.code(201).send(await knowledge.createDirective(request.body as never))
  ))

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; actor?: string } }>("/api/directives/:id", async (request) => {
    if (typeof request.body?.enabled !== "boolean" || !request.body.actor) throw new Error("固定规则状态格式错误")
    return knowledge.setDirectiveEnabled(request.params.id, request.body.enabled, request.body.actor)
  })

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/directives/:id/content", async (request) => (
    knowledge.updateDirective(request.params.id, request.body as never)
  ))

  app.delete<{ Params: { id: string }; Body: { actor?: string } }>("/api/directives/:id", async (request, reply) => {
    if (!request.body?.actor) throw new Error("固定规则删除格式错误")
    await knowledge.deleteDirective(request.params.id, request.body.actor)
    return reply.code(204).send()
  })

  app.get<{ Querystring: {
    status?: ReplyRecord["status"]
    groupId?: string
    projectId?: string
    serviceId?: string
    senderQ?: string
    role?: ReplyRecord["senderRole"]
    decision?: ReplyRecord["decision"]
    from?: string
    to?: string
    q?: string
    cursor?: string
    limit?: number
  } }>(
    "/api/replies",
    async (request) => replies ? replies.listRecent(request.query) : ({ records: knowledge.listReplyRecords(request.query) }),
  )

  if (replies) app.get<{ Querystring: { limit?: string } }>("/api/replies/work", async (request) => (
    replies.listWorkQueue(Number(request.query.limit ?? 100))
  ))

  app.get<{ Params: { id: string } }>("/api/replies/:id", async (request) => ({
    record: replies ? replies.getDetail(request.params.id) : knowledge.getReply(request.params.id),
  }))

  if (replyEvents) app.get("/api/replies/events", async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    })
    reply.raw.write(": connected\n\n")
    const unsubscribe = replyEvents.subscribe((event) => {
      const eventName = "kind" in event && event.kind === "admin-chat-turn" ? "admin-chat-turn" : "reply-status"
      if (!reply.raw.destroyed) reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n")
    }, 25_000)
    heartbeat.unref()
    request.raw.once("close", () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.post<{ Body: unknown }>("/api/replies", async (request, reply) => (
    reply.code(201).send(await knowledge.recordReply(request.body as never))
  ))

  app.post<{ Params: { id: string }; Body: unknown }>("/api/replies/:id/corrections", async (request, reply) => (
    reply.code(201).send(authoring
      ? await authoring.correctReply(request.params.id, request.body)
      : await knowledge.correctReply(request.params.id, request.body as never))
  ))

  app.get("/api/transfer/export", async (_request, reply) => {
    const directory = await mkdtemp(path.join(tmpdir(), "mercury-claw-export-"))
    const filePath = path.join(directory, `telegram-support-${new Date().toISOString().slice(0, 10)}.sqlite`)
    try {
      await backup.export(filePath)
      const file = await stat(filePath)
      const stream = createReadStream(filePath)
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        void rm(directory, { recursive: true, force: true })
      }
      stream.once("error", cleanup)
      reply.raw.once("finish", cleanup)
      reply.raw.once("close", cleanup)
      reply.header("Cache-Control", "no-store")
      reply.header("X-Contains-Plaintext-Infrastructure-Credentials", "true")
      reply.header("Content-Type", "application/vnd.sqlite3")
      reply.header("Content-Length", file.size)
      reply.header("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`)
      return reply.send(stream)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  })

  app.post<{ Body: Readable }>("/api/transfer/import", { bodyLimit: 64 * 1024 ** 3 }, async (request) => {
    if (!(request.body instanceof Readable)) throw new Error("迁移数据库不能为空")
    const directory = await mkdtemp(path.join(tmpdir(), "mercury-claw-import-"))
    const filePath = path.join(directory, "portable.sqlite")
    try {
      let received = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          if (received > 64 * 1024 ** 3) callback(new Error("迁移数据库超过 64 GB"))
          else callback(null, chunk)
        },
      })
      await pipeline(request.body, meter, createWriteStream(filePath, { flags: "wx", mode: 0o600 }))
      if (received === 0) throw new Error("迁移数据库不能为空")
      try {
        await onlineImportWorker?.stop()
        await backup.import(filePath)
        knowledge.ensureSystemDirectives()
        return { imported: true }
      } finally {
        onlineImportWorker?.start()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

export function registerSupportThreadRoutes(app: FastifyInstance, service: SupportThreadQueryService): void {
  app.get<{ Querystring: { limit?: string } }>("/api/support-threads/work", async (request) => (
    service.listWork(Number(request.query.limit ?? 100))
  ))
  app.get<{ Querystring: {
    projectId?: string
    serviceId?: string
    groupId?: string
    status?: string
    hasSuperseded?: string
    excludeActive?: string
    senderQ?: string
    from?: string
    to?: string
    q?: string
    cursor?: string
    limit?: string
  } }>("/api/support-threads", async (request) => service.listRecent({
    ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
    ...(request.query.serviceId ? { serviceId: request.query.serviceId } : {}),
    ...(request.query.groupId ? { groupId: request.query.groupId } : {}),
    ...(request.query.status ? { status: request.query.status as never } : {}),
    ...(request.query.hasSuperseded === "true" ? { hasSuperseded: true } : {}),
    ...(request.query.excludeActive === "true" ? { excludeActive: true } : {}),
    ...(request.query.senderQ ? { senderQ: request.query.senderQ } : {}),
    ...(request.query.from ? { from: request.query.from } : {}),
    ...(request.query.to ? { to: request.query.to } : {}),
    ...(request.query.q ? { q: request.query.q } : {}),
    ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
    ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
  }))
  app.get<{ Params: { id: string } }>("/api/support-threads/:id", async (request) => service.getDetail(request.params.id))
  app.post<{ Params: { id: string } }>("/api/support-threads/:id/close", async (request, reply) => {
    try {
      return service.closeManually(request.params.id)
    } catch (error) {
      if (error instanceof Error && error.message === "客服问题线程不存在") {
        return reply.code(404).send({ error: error.message })
      }
      throw error
    }
  })
}
