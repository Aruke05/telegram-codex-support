import type { FastifyInstance } from "fastify"

import type { KnowledgeResolver } from "../knowledge/resolver.js"
import type { MagicBookRepository } from "../magicbook/repository.js"

export function registerMagicBookRoutes(
  app: FastifyInstance,
  repository: MagicBookRepository,
  resolver: KnowledgeResolver,
): void {
  app.get("/api/magicbook/status", async () => {
    const snapshot = repository.current()
    const services = snapshot.parameters.find((parameter) => parameter.key === "sourceService")?.options ?? []
    const regions = snapshot.parameters.find((parameter) => parameter.key === "targetRegion")?.mappingRules
      .flatMap((rule) => rule.values.map((value) => value.value)) ?? []
    return {
      sourceVersion: snapshot.sourceVersion,
      importedAt: snapshot.syncedAt,
      contentHash: snapshot.contentHash,
      serviceCount: services.length,
      services: services.map(({ label, value }) => ({ label, value })),
      regionCount: new Set(regions).size,
      promptFallback: { enabled: false, mode: "按需" },
    }
  })

  app.get<{ Params: { service: string } }>("/api/magicbook/service/:service", async (request, reply) => {
    const result = resolver.lookupService(request.params.service)
    if (!result.found) return reply.code(404).send({ error: "未找到该服务知识" })
    return result
  })
}
