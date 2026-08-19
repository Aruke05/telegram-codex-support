import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"

import { AdminAuthService, LoginThrottledError, menuForApi } from "../auth/service.js"
import { menuKeys, requirePrincipal } from "../auth/types.js"

const cookieName = "mercuryclaw_session"
const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(1024),
}).strict()
const idSchema = z.string().uuid()
const createAccessUserSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(1024),
  roleId: idSchema,
  enabled: z.boolean().default(true),
}).strict()
const updateAccessUserSchema = z.object({
  username: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(8).max(1024).optional(),
  roleId: idSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0)
const updateAccessRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  menus: z.array(z.enum(menuKeys)).min(1).max(menuKeys.length).transform((menus) => [...new Set(menus)]),
}).strict()
const accessErrors = new Set([
  "账号已存在", "账号不存在", "权限方案不存在", "角色至少保留一个菜单",
  "不能停用当前登录账号", "至少保留一个可用的全部功能账号",
])

function accessError(error: unknown): never {
  throw error
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try { return decodeURIComponent(part.slice(separator + 1).trim()) } catch { return undefined }
  }
  return undefined
}

function sessionCookie(token: string, secure: boolean): string {
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`
}

function expiredCookie(secure: boolean): string {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`
}

function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === "https" || request.headers["x-forwarded-proto"] === "https"
}

function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === request.headers.host } catch { return false }
}

export function registerAuth(app: FastifyInstance, auth: AdminAuthService): void {
  app.decorateRequest("auth", null)

  app.post<{ Body: unknown }>("/api/auth/login", { bodyLimit: 4096 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (!sameOrigin(request)) return reply.code(403).send({ error: "登录失败" })
    try {
      const input = loginSchema.parse(request.body)
      const result = await auth.login(input.username, input.password, request.ip)
      reply.header("Set-Cookie", sessionCookie(result.token, isSecureRequest(request)))
      return reply.send({ menus: result.principal.menus, csrfToken: result.principal.csrfToken })
    } catch (error) {
      if (error instanceof LoginThrottledError) return reply.code(429).send({ error: "登录失败，请稍后再试" })
      return reply.code(401).send({ error: "账号或密码错误" })
    }
  })

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url === "/api/auth/login") return
    reply.header("Cache-Control", "no-store")
    request.auth = auth.authenticate(cookieValue(request, cookieName))
    if (!request.auth) return reply.code(401).send({ error: "请先登录" })
    const pathname = request.url.split("?", 1)[0] || request.url
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (!sameOrigin(request) || request.headers["x-csrf-token"] !== request.auth.csrfToken) {
        return reply.code(403).send({ error: "请求校验失败" })
      }
    }
    if (pathname.startsWith("/api/auth/")) return
    const required = menuForApi(request.method, pathname)
    const allowed = required === "chat-or-replies"
      ? request.auth.menus.includes("chat") || request.auth.menus.includes("replies")
      : required !== null && request.auth.menus.includes(required)
    if (!allowed) return reply.code(403).send({ error: "无权使用此功能" })
  })

  app.get("/api/auth/me", async (request) => {
    const principal = requirePrincipal(request)
    return { menus: principal.menus, csrfToken: principal.csrfToken }
  })

  app.post("/api/auth/logout", async (request, reply) => {
    const principal = requirePrincipal(request)
    auth.invalidateSessions(principal.userId, principal.authVersion)
    reply.header("Set-Cookie", expiredCookie(isSecureRequest(request)))
    return reply.code(204).send()
  })

  app.get("/api/access-control", async (request) => {
    const principal = requirePrincipal(request)
    return auth.accessControl(principal.userId)
  })

  app.post<{ Body: unknown }>("/api/access-control/users", async (request, reply) => {
    try {
      const created = await auth.createAccessUser(createAccessUserSchema.parse(request.body))
      return reply.code(201).send(created)
    } catch (error) {
      if (error instanceof Error && accessErrors.has(error.message)) return reply.code(400).send({ error: error.message })
      return accessError(error)
    }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/access-control/users/:id", async (request, reply) => {
    try {
      const principal = requirePrincipal(request)
      const updated = await auth.updateAccessUser(
        idSchema.parse(request.params.id),
        updateAccessUserSchema.parse(request.body),
        principal.userId,
      )
      return reply.send(updated)
    } catch (error) {
      if (error instanceof Error && accessErrors.has(error.message)) return reply.code(400).send({ error: error.message })
      return accessError(error)
    }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/access-control/roles/:id", async (request, reply) => {
    try {
      const updated = auth.updateAccessRole(
        idSchema.parse(request.params.id),
        updateAccessRoleSchema.parse(request.body),
      )
      return reply.send(updated)
    } catch (error) {
      if (error instanceof Error && accessErrors.has(error.message)) return reply.code(400).send({ error: error.message })
      return accessError(error)
    }
  })
}
