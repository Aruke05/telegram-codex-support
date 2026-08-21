import type { FastifyInstance } from "fastify"

import type { ShadowReportStore } from "../learning/shadow-report-store.js"
import type { ShadowReportWorker } from "../learning/shadow-report-worker.js"

export function registerShadowLearningRoutes(
  app: FastifyInstance,
  store: ShadowReportStore,
  worker: Pick<ShadowReportWorker, "runNow" | "retry">,
): void {
  app.get("/api/learning-reports", async () => ({ items: store.list() }))
  app.get<{ Params: { id: string } }>("/api/learning-reports/:id", async (request) => store.detail(request.params.id))
  app.post("/api/learning-reports", async (_request, reply) => (
    reply.code(201).send(await worker.runNow())
  ))
  app.post<{ Params: { id: string } }>("/api/learning-reports/:id/retry", async (request) => (
    worker.retry(request.params.id)
  ))
}
