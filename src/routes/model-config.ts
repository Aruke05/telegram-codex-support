import type { FastifyInstance } from "fastify"

import type { ModelConfigService } from "../runtime/model-config-service.js"
import type { RuntimeControlService } from "../runtime/control-service.js"
import type { ModelCatalogService } from "../models/model-catalog-service.js"
import { modelProviderSchema, modelPurposeSchema, modelTransportSchema } from "../runtime/types.js"
import { z } from "zod"

export type ModelConnectionTester = {
  testModelConnection(id: string): Promise<void>
}

const catalogQuerySchema = z.object({
  provider: modelProviderSchema.optional(),
  transport: modelTransportSchema.optional(),
  includeHidden: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
}).strict()

export function registerModelConfigRoutes(
  app: FastifyInstance,
  service: ModelConfigService,
  runtime?: RuntimeControlService,
  catalog?: ModelCatalogService,
  tester?: ModelConnectionTester,
): void {
  app.get("/api/models", async () => ({ models: service.listModelInstances() }))
  app.post<{ Body: unknown }>("/api/models", async (request, reply) => (
    reply.code(201).send(service.createModelInstance(request.body as never))
  ))
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/models/:id", async (request) => (
    service.updateModelInstance(request.params.id, request.body as never)
  ))
  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    service.deleteModelInstance(request.params.id)
    return reply.code(204).send()
  })
  if (tester) app.post<{ Params: { id: string } }>("/api/models/:id/test", async (request) => {
    await tester.testModelConnection(request.params.id)
    return service.getModelInstance(request.params.id)
  })
  app.get("/api/model-bindings", async () => ({ bindings: service.listBindings() }))
  app.patch<{ Params: { purpose: string }; Body: unknown }>("/api/model-bindings/:purpose", async (request) => (
    service.updateBinding(modelPurposeSchema.parse(request.params.purpose), request.body as never)
  ))
  if (catalog) {
    app.get<{ Querystring: unknown }>("/api/model-catalog", async (request) => catalog.list(catalogQuerySchema.parse(request.query)))
    app.post("/api/model-catalog/refresh", async () => catalog.refreshCodex())
  }
  app.get("/api/model-config", async () => ({ profiles: service.listProfiles() }))
  app.patch<{ Params: { purpose: string }; Body: unknown }>("/api/model-config/:purpose", async (request) => (
    service.updateProfile(modelPurposeSchema.parse(request.params.purpose), request.body)
  ))
  app.get("/api/runtime-settings", async () => service.getSettings())
  app.patch<{ Body: unknown }>("/api/runtime-settings", async (request) => service.updateSettings(request.body))
  if (runtime) {
    app.get("/api/runtime-status", async () => runtime.status())
    app.post("/api/runtime/codex/check", async () => runtime.checkCodex())
    app.post<{ Body: unknown }>("/api/runtime/code-sync", async (request) => runtime.sync(request.body))
    app.post("/api/runtime/learning", async () => runtime.runLearning())
  }
}
