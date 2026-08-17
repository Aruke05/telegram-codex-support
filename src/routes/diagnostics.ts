import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { ReadonlyResourceBroker } from "../diagnostics/resource-broker.js"
import type { ResourceResolver } from "../projects/resource-resolver.js"

const serverCheckSchema = z.object({
  check: z.enum(["service_status", "recent_logs", "disk_usage", "nginx_routes"]),
}).strict()

const databaseQuerySchema = z.object({
  sql: z.string().trim().min(1).max(20_000),
}).strict()

export type ResourceResolverPort = Pick<ResourceResolver, "resolveService">
export type ReadonlyResourceBrokerPort = Pick<ReadonlyResourceBroker, "runServerCheck" | "runDatabaseQuery">

export function registerDiagnosticRoutes(
  app: FastifyInstance,
  resolver: ResourceResolverPort,
  broker?: ReadonlyResourceBrokerPort,
): void {
  app.get<{ Params: { name: string } }>("/api/diagnostics/services/:name", async (request) => (
    resolver.resolveService(request.params.name)
  ))

  if (!broker) return
  app.post<{ Params: { id: string }; Body: unknown }>("/api/diagnostics/servers/:id/check", async (request) => {
    const input = serverCheckSchema.parse(request.body)
    return broker.runServerCheck(request.params.id, input.check)
  })
  app.post<{ Params: { id: string }; Body: unknown }>("/api/diagnostics/databases/:id/query", async (request) => {
    const input = databaseQuerySchema.parse(request.body)
    return broker.runDatabaseQuery(request.params.id, input.sql)
  })
}
