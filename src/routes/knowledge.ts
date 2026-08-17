import type { FastifyInstance } from "fastify"

import {
  lookupInterfaceSections,
  type InterfaceDocumentScope,
  type InterfaceDocumentSnapshot,
} from "../knowledge/interface-documents.js"

type InterfaceDocuments = Record<InterfaceDocumentScope, InterfaceDocumentSnapshot>

export function registerKnowledgeRoutes(app: FastifyInstance, documents: InterfaceDocumentSnapshot | InterfaceDocuments): void {
  const scoped = "india" in documents && "non_india" in documents ? documents as InterfaceDocuments : null

  app.get("/api/interface-docs", async () => ({
    documents: scoped
      ? Object.values(scoped).map((snapshot) => ({
        scope: snapshot.scope,
        title: snapshot.title,
        applicableRegions: snapshot.applicableRegions,
        sourceVersion: snapshot.contentHash,
        capturedAt: snapshot.capturedAt,
        endpointCount: snapshot.endpoints.length,
      }))
      : [],
  }))

  app.get<{ Querystring: { q?: string; scope?: InterfaceDocumentScope } }>("/api/interface-docs/search", async (request, reply) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : ""
    if (!query) return reply.code(400).send({ error: "查询内容不能为空" })
    let snapshot: InterfaceDocumentSnapshot
    if (scoped) {
      if (request.query.scope !== "india" && request.query.scope !== "non_india") {
        return reply.code(400).send({ error: "必须选择印度或非印度文档" })
      }
      snapshot = scoped[request.query.scope]
    } else {
      snapshot = documents as InterfaceDocumentSnapshot
    }
    const sections = lookupInterfaceSections(snapshot, query).map((section) => ({
      title: section.title,
      content: section.content,
      endpoints: section.endpoints,
      writeOperation: section.writeOperation,
      explainOnly: section.explainOnly,
    }))
    return {
      query,
      scope: snapshot.scope,
      title: snapshot.title,
      applicableRegions: snapshot.applicableRegions,
      sourceVersion: snapshot.contentHash,
      sections,
    }
  })
}
