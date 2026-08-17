import { sessions, TelegramClient } from "teleproto"

import type { PublicTelegramAccount, RuntimeAdminService } from "../runtime/admin-service.js"
import { chineseBotCommands } from "./commands.js"

type Fetcher = typeof fetch

type BotApiResponse<T> = {
  ok: boolean
  result?: T
}

export class TelegramConnectionService {
  private readonly fetcher: Fetcher

  constructor(
    private readonly admin: RuntimeAdminService,
    options: { fetcher?: Fetcher } = {},
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  async testAccount(id: string): Promise<PublicTelegramAccount> {
    const account = this.admin.getAccount(id)
    try {
      if (account.type === "bot") {
        const credentials = this.admin.getAccountCredentials(id)
        const me = await this.botApiCall<{ username?: string }>(credentials.botToken ?? "", "getMe")
        return this.admin.updateAccountConnection(id, {
          status: "ready",
          statusMessage: "连接正常",
          botUsername: me.username ?? null,
        })
      }

      const credentials = this.admin.getAccountCredentials(id)
      if (!credentials.session) {
        return this.admin.updateAccountConnection(id, {
          status: "login_required",
          statusMessage: "需要完成 Telegram 登录",
        })
      }
      const client = new TelegramClient(
        new sessions.StringSession(credentials.session),
        Number(credentials.apiId),
        credentials.apiHash ?? "",
        { connectionRetries: 2, timeout: 10 },
      )
      try {
        await client.connect()
        if (!await client.checkAuthorization()) throw new Error("未登录")
        await client.getMe()
      } finally {
        await client.disconnect().catch(() => undefined)
      }
      return this.admin.updateAccountConnection(id, { status: "ready", statusMessage: "连接正常" })
    } catch {
      return this.admin.updateAccountConnection(id, {
        status: account.type === "user" ? "login_required" : "error",
        statusMessage: account.type === "user" ? "登录已失效，需要重新登录" : "连接失败，请检查配置",
      })
    }
  }

  async syncBotCommands(id: string): Promise<void> {
    const account = this.admin.getAccount(id)
    if (account.type !== "bot") throw new Error("只有 Bot 可以同步命令")
    const credentials = this.admin.getAccountCredentials(id)
    await this.botApiCall(credentials.botToken ?? "", "setMyCommands", {
      commands: chineseBotCommands,
      language_code: "zh",
    })
  }

  private async botApiCall<T>(token: string, method: string, body?: unknown): Promise<T> {
    if (!token) throw new Error("Bot Token 未配置")
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      }),
    })
    const result = await response.json() as BotApiResponse<T>
    if (!response.ok || !result.ok || result.result === undefined) throw new Error("Telegram 请求失败")
    return result.result
  }
}
