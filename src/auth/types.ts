import type { FastifyRequest } from "fastify"

export const menuKeys = [
  "overview", "projects", "connections", "replies", "chat", "memories",
  "docs", "models", "runtime", "transfer", "settings", "access",
] as const

export type MenuKey = typeof menuKeys[number]

export type AuthPrincipal = {
  userId: string
  username: string
  authVersion: number
  menus: MenuKey[]
  isSuperAdmin: boolean
  csrfToken: string
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthPrincipal | null
  }
}

export function requirePrincipal(request: FastifyRequest): AuthPrincipal {
  if (!request.auth) throw new Error("未登录")
  return request.auth
}
