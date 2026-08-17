import fastifyStatic from "@fastify/static"
import type { FastifyInstance } from "fastify"

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ")

export function registerAdminUi(app: FastifyInstance, publicRoot: string): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/api/") && request.url !== "/health") {
      reply.header("Content-Security-Policy", contentSecurityPolicy)
      reply.header("X-Content-Type-Options", "nosniff")
      reply.header("Referrer-Policy", "no-referrer")
      reply.header("X-Frame-Options", "DENY")
    }
    return payload
  })

  void app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
  })
}
