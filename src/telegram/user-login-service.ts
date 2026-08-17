import { Api, sessions, TelegramClient } from "teleproto"

import type { RuntimeAdminService } from "../runtime/admin-service.js"

type LoginStage = "connecting" | "waiting_code" | "waiting_password" | "ready" | "error"

type PendingLogin = {
  client: TelegramClient<sessions.StringSession>
  stage: LoginStage
  message: string
  phoneNumber: string
  phoneCodeHash: string
  apiCredentials: { apiId: number; apiHash: string }
  expiry: ReturnType<typeof setTimeout>
}

export class TelegramUserLoginService {
  private readonly pending = new Map<string, PendingLogin>()

  constructor(private readonly admin: RuntimeAdminService) {}

  async start(accountId: string): Promise<{ stage: LoginStage; message: string }> {
    const account = this.admin.getAccount(accountId)
    if (account.type !== "user") throw new Error("只有个人账号需要登录")
    await this.cancel(accountId)
    const credentials = this.admin.getAccountCredentials(accountId)
    const apiCredentials = { apiId: Number(credentials.apiId), apiHash: credentials.apiHash ?? "" }
    const client = new TelegramClient(
      new sessions.StringSession(credentials.session ?? ""),
      apiCredentials.apiId,
      apiCredentials.apiHash,
      { connectionRetries: 2, timeout: 10 },
    )
    try {
      await client.connect()
      if (await client.checkAuthorization()) {
        await this.admin.saveUserSession(accountId, client.session.save())
        await client.disconnect().catch(() => undefined)
        return { stage: "ready", message: "登录完成" }
      }
      const sent = await client.sendCode(apiCredentials, credentials.phone ?? "")
      if (sent.emailRequired || sent.emailCodeSent) {
        await client.disconnect().catch(() => undefined)
        return { stage: "error", message: "该账号需要邮箱验证，当前后台不支持，请换用 Bot 或已登录 Session" }
      }
      const pending: PendingLogin = {
        client,
        stage: "waiting_code",
        message: "验证码已发送，请输入 Telegram 验证码",
        phoneNumber: credentials.phone ?? "",
        phoneCodeHash: sent.phoneCodeHash,
        apiCredentials,
        expiry: setTimeout(() => { void this.cancel(accountId) }, 5 * 60_000),
      }
      this.pending.set(accountId, pending)
      return { stage: pending.stage, message: pending.message }
    } catch {
      await client.disconnect().catch(() => undefined)
      return { stage: "error", message: "登录连接失败，请检查 API 配置后重试" }
    }
  }

  async continue(accountId: string, input: { code?: string; password?: string }): Promise<{ stage: LoginStage; message: string }> {
    const pending = this.pending.get(accountId)
    if (!pending) throw new Error("没有进行中的登录")
    if (pending.stage === "waiting_code") {
      if (!input.code?.trim()) throw new Error("验证码不能为空")
      try {
        const result = await pending.client.invoke(new Api.auth.SignIn({
          phoneNumber: pending.phoneNumber,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: input.code.trim(),
        }))
        if (result instanceof Api.auth.AuthorizationSignUpRequired) {
          await this.finishWithError(accountId, pending, "该手机号还没有 Telegram 账号，已停止登录，不会自动创建账号")
          return { stage: "error", message: pending.message }
        }
        return this.complete(accountId, pending)
      } catch (error) {
        if ((error as { errorMessage?: string }).errorMessage === "SESSION_PASSWORD_NEEDED") {
          pending.stage = "waiting_password"
          pending.message = "请输入 Telegram 两步验证密码"
          return { stage: pending.stage, message: pending.message }
        }
        pending.message = "验证码验证失败，请检查后重试"
        return { stage: pending.stage, message: pending.message }
      }
    }

    if (pending.stage === "waiting_password") {
      if (!input.password) throw new Error("两步验证密码不能为空")
      try {
        await pending.client.signInWithPassword(pending.apiCredentials, {
          password: async () => input.password as string,
          onError: async () => true,
        })
        return this.complete(accountId, pending)
      } catch {
        pending.message = "两步验证密码不正确，请检查后重试"
        return { stage: pending.stage, message: pending.message }
      }
    }

    return { stage: pending.stage, message: pending.message }
  }

  async cancel(accountId: string): Promise<void> {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.expiry)
    await pending.client.disconnect().catch(() => undefined)
  }

  private async complete(accountId: string, pending: PendingLogin): Promise<{ stage: LoginStage; message: string }> {
    await this.admin.saveUserSession(accountId, pending.client.session.save())
    pending.stage = "ready"
    pending.message = "登录完成"
    this.pending.delete(accountId)
    clearTimeout(pending.expiry)
    await pending.client.disconnect().catch(() => undefined)
    return { stage: pending.stage, message: pending.message }
  }

  private async finishWithError(accountId: string, pending: PendingLogin, message: string): Promise<void> {
    pending.stage = "error"
    pending.message = message
    this.pending.delete(accountId)
    clearTimeout(pending.expiry)
    await pending.client.disconnect().catch(() => undefined)
  }
}
