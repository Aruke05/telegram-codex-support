import type { FastifyInstance } from "fastify"

import type { RuntimeAdminService } from "../runtime/admin-service.js"
import type { TelegramConnectionService } from "../telegram/connection-service.js"
import { chineseBotCommands } from "../telegram/commands.js"
import type { TelegramUserLoginService } from "../telegram/user-login-service.js"

export function registerRuntimeAdminRoutes(
  app: FastifyInstance,
  service: RuntimeAdminService,
  connection?: TelegramConnectionService,
  userLogin?: TelegramUserLoginService,
): void {
  app.get("/api/telegram/accounts", async () => ({ accounts: service.listAccounts(), commands: chineseBotCommands }))

  app.post<{ Body: unknown }>("/api/telegram/accounts", async (request, reply) => {
    const account = await service.createAccount(request.body as never)
    return reply.code(201).send(account)
  })

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/telegram/accounts/:id", async (request) => (
    service.updateAccount(request.params.id, request.body as never)
  ))

  app.delete<{ Params: { id: string } }>("/api/telegram/accounts/:id", async (request, reply) => {
    await service.deleteAccount(request.params.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>("/api/telegram/accounts/:id/test", async (request) => {
    if (!connection) throw new Error("Telegram 连接服务未启用")
    return connection.testAccount(request.params.id)
  })

  app.post<{ Params: { id: string } }>("/api/telegram/accounts/:id/commands", async (request) => {
    if (!connection) throw new Error("Telegram 连接服务未启用")
    await connection.syncBotCommands(request.params.id)
    return { synced: true, commands: chineseBotCommands }
  })

  app.post<{ Params: { id: string } }>("/api/telegram/accounts/:id/login/start", async (request) => {
    if (!userLogin) throw new Error("个人账号登录服务未启用")
    return userLogin.start(request.params.id)
  })

  app.post<{ Params: { id: string }; Body: { code?: string; password?: string } }>(
    "/api/telegram/accounts/:id/login/continue",
    async (request) => {
      if (!userLogin) throw new Error("个人账号登录服务未启用")
      return userLogin.continue(request.params.id, request.body ?? {})
    },
  )

  app.post<{ Params: { id: string } }>("/api/telegram/accounts/:id/login/cancel", async (request, reply) => {
    if (!userLogin) throw new Error("个人账号登录服务未启用")
    await userLogin.cancel(request.params.id)
    return reply.code(204).send()
  })

  const groupList = () => {
    const groups = service.listGroups()
    return {
      version: 1,
      technicalAlertGroup: {
        name: groups.find((group) => group.purpose === "technical_alert")?.name ?? "技术部",
        configured: groups.some((group) => group.purpose === "technical_alert" && group.configured),
      },
      groups,
    }
  }

  app.get("/api/telegram/groups", async () => groupList())
  app.get("/api/groups", async () => {
    const result = groupList()
    return {
      ...result,
      groups: result.groups.map(({ telegramChatId: _telegramChatId, accountId: _accountId, ...group }) => group),
    }
  })

  app.post<{ Body: unknown }>("/api/telegram/groups", async (request, reply) => {
    const group = await service.createGroup(request.body as never)
    return reply.code(201).send(group)
  })

  app.patch<{ Body: unknown }>("/api/telegram/groups", async (request) => ({
    groups: await service.updateGroups(request.body as never),
  }))

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/telegram/groups/:id", async (request) => (
    service.updateGroup(request.params.id, request.body as never)
  ))

  app.delete<{ Params: { id: string } }>("/api/telegram/groups/:id", async (request, reply) => {
    await service.deleteGroup(request.params.id)
    return reply.code(204).send()
  })

  app.get("/api/telegram/roles", async () => ({ roles: service.listRoles() }))

  app.post<{ Body: unknown }>("/api/telegram/roles", async (request, reply) => (
    reply.code(201).send(await service.createRole(request.body as never))
  ))

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/telegram/roles/:id", async (request) => (
    service.updateRole(request.params.id, request.body as never)
  ))

  app.delete<{ Params: { id: string } }>("/api/telegram/roles/:id", async (request, reply) => {
    await service.deleteRole(request.params.id)
    return reply.code(204).send()
  })
}
