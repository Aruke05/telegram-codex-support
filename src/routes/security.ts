import type { FastifyInstance } from "fastify"

import { assertSafeOutbound, type ConfiguredSecretRedactor } from "../security/dlp.js"

export function registerSecurityRoutes(app: FastifyInstance, configuredSecrets?: ConfiguredSecretRedactor): void {
  app.post("/api/security/check", async (request, reply) => {
    const body = request.body as { text?: unknown } | null
    if (!body || typeof body.text !== "string" || body.text.length === 0) {
      return reply.code(400).send({ error: "检查内容不能为空" })
    }
    if (body.text.length > 100_000) return reply.code(413).send({ error: "检查内容过长" })
    if (configuredSecrets) {
      configuredSecrets.refresh()
      return configuredSecrets.assertSafeOutbound(body.text)
    }
    return assertSafeOutbound(body.text)
  })
}
