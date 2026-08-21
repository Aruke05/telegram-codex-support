import { createHash, randomUUID } from "node:crypto"

import { sessions, TelegramClient } from "teleproto"
import { NewMessage, type NewMessageEvent } from "teleproto/events/index.js"

import type { RuntimeAdminService } from "../runtime/admin-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { ModelConfigService } from "../runtime/model-config-service.js"
import type { RuntimeGroup } from "../runtime/types.js"
import type { SupportMessageProcessor } from "../support/message-processor.js"
import { AttachmentService, type AttachmentKind, type IncomingAttachmentDescriptor } from "./attachment-service.js"
import { TelegramIdentityCommandService, type TelegramIdentity } from "./identity-commands.js"

type Fetcher = typeof fetch
type BotApiResponse<T> = {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}
type BotFile = { file_path?: string }
type BotPhoto = { file_id: string; file_size?: number; width: number; height: number }
type BotDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
type BotVideo = BotDocument & { duration?: number; width?: number; height?: number }
type BotUser = { id: number | string; is_bot?: boolean; username?: string; first_name?: string; last_name?: string }
type BotMessage = {
  message_id: number
  date?: number
  media_group_id?: string
  message_thread_id?: number
  chat: { id: number | string; type?: string }
  from?: BotUser
  reply_to_message?: {
    message_id: number
    from?: BotUser
  }
  text?: string
  caption?: string
  document?: BotDocument
  photo?: BotPhoto[]
  video?: BotVideo
}
type BotUpdate = { update_id: number; message?: BotMessage }
const attachmentShutdownGraceMs = 3_000
const outgoingOwnershipPollMs = 10

export type TelegramDeliveryErrorType = "account_unavailable" | "rate_limited" | "forbidden" | "chat_not_found" | "timeout" | "network" | "unknown"
export type TelegramDeliveryState = "failed" | "uncertain"

export type TelegramOutputOwnership = {
  groupId?: string | null
  threadId?: string | null
  serviceId?: string | null
  replyId?: string | null
  notificationId?: string | null
  kind?: string
}

export class TelegramDeliveryError extends Error {
  override readonly name = "TelegramDeliveryError"

  constructor(
    readonly type: TelegramDeliveryErrorType,
    readonly state: TelegramDeliveryState,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super("Telegram 消息发送失败")
  }
}

function botApiDeliveryError(response: BotApiResponse<unknown>): TelegramDeliveryError {
  const description = response.description?.toLocaleLowerCase("en-US") ?? ""
  if (response.error_code === 429) return new TelegramDeliveryError(
    "rate_limited", "failed", Number.isFinite(response.parameters?.retry_after) ? Number(response.parameters?.retry_after) : null,
  )
  if (response.error_code === 403) return new TelegramDeliveryError("forbidden", "failed")
  if (response.error_code === 400 && /chat not found|chat_id is empty|message thread not found/u.test(description)) {
    return new TelegramDeliveryError("chat_not_found", "failed")
  }
  return new TelegramDeliveryError("unknown", "failed")
}

function networkDeliveryError(error: unknown): TelegramDeliveryError {
  if (error instanceof TelegramDeliveryError) return error
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new TelegramDeliveryError("timeout", "uncertain")
  }
  return new TelegramDeliveryError("network", "uncertain")
}

export type TelegramRuntimeStatus = {
  running: boolean
  botLoops: number
  userConnections: number
  lastUpdateAt: string | null
  lastErrorAt: string | null
  lastErrorCode: string | null
}

function kindFor(name: string, mimeType: string): AttachmentKind {
  const lower = name.toLocaleLowerCase("en-US")
  if (mimeType.startsWith("text/") || /\.(?:txt|log|json|xml|csv|md|yaml|yml)$/i.test(lower)) return "text"
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf"
  if (/(?:zip|compressed|archive|tar|gzip|7z)/i.test(mimeType) || /\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(lower)) return "archive"
  return "other"
}

function chatMatches(configured: string, incoming: string): boolean {
  if (configured === incoming) return true
  const configuredDigits = configured.replace(/^-100|-/, "")
  const incomingDigits = incoming.replace(/^-100|-/, "")
  return configuredDigits === incomingDigits
}

function outputDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function telegramMessageId(value: unknown): string {
  const normalized = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : ""
  if (!/^[1-9]\d{0,18}$/u.test(normalized)
    || BigInt(normalized) > 9_223_372_036_854_775_807n) {
    throw new TelegramDeliveryError("unknown", "uncertain")
  }
  return normalized
}

function botIdentity(user: BotUser | undefined): TelegramIdentity | null {
  return user ? ({
    id: String(user.id),
    username: user.username ?? null,
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
  }) : null
}

class BotApiClient {
  constructor(private readonly admin: RuntimeAdminService, private readonly fetcher: Fetcher) {}

  async updates(accountId: string, offset: number): Promise<BotUpdate[]> {
    return this.call<BotUpdate[]>(accountId, "getUpdates", { offset, timeout: 25, limit: 100, allowed_updates: ["message"] }, 35_000)
  }

  async send(accountId: string, chatId: string, text: string, replyTo?: string, quote?: string | null): Promise<string> {
    const result = await this.call<{ message_id: number }>(accountId, "sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyTo ? {
        reply_parameters: {
          message_id: Number(replyTo), allow_sending_without_reply: true,
          ...(quote ? { quote } : {}),
        },
      } : {}),
    })
    return telegramMessageId(result.message_id)
  }

  async forward(
    accountId: string,
    targetChatId: string,
    sourceChatId: string,
    messageIds: string[],
  ): Promise<string[]> {
    const result = await this.call<Array<{ message_id: number }>>(accountId, "forwardMessages", {
      chat_id: targetChatId,
      from_chat_id: sourceChatId,
      message_ids: messageIds.map(Number),
    })
    return result.map((message) => telegramMessageId(message.message_id))
  }

  async download(accountId: string, fileId: string): Promise<Buffer | null> {
    const credentials = this.admin.getAccountCredentials(accountId)
    const token = credentials.botToken ?? ""
    if (!token) return null
    const file = await this.call<BotFile>(accountId, "getFile", { file_id: fileId })
    if (!file.file_path) return null
    const response = await this.fetcher(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  }

  private async call<T>(accountId: string, method: string, body: unknown, timeout = 20_000): Promise<T> {
    let token = ""
    try {
      token = this.admin.getAccountCredentials(accountId).botToken ?? ""
    } catch {
      throw new TelegramDeliveryError("account_unavailable", "failed")
    }
    if (!token) throw new TelegramDeliveryError("account_unavailable", "failed")
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      const parsed = await response.json() as BotApiResponse<T>
      if (!response.ok || !parsed.ok || parsed.result === undefined) throw botApiDeliveryError(parsed)
      return parsed.result
    } catch (error) {
      throw networkDeliveryError(error)
    }
  }
}

export class TelegramRuntime {
  private readonly bot: BotApiClient
  private readonly identityCommands: TelegramIdentityCommandService
  private readonly botPolling = new Set<string>()
  private readonly userConnecting = new Set<string>()
  private readonly userClients = new Map<string, TelegramClient<sessions.StringSession>>()
  private readonly attachmentTasks = new Set<Promise<void>>()
  private discardLateAttachmentResults = false
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastUpdateAt: string | null = null
  private lastErrorAt: string | null = null
  private lastErrorCode: string | null = null

  constructor(
    private readonly database: RuntimeDatabase,
    private readonly admin: RuntimeAdminService,
    private readonly config: ModelConfigService,
    private readonly processor: SupportMessageProcessor,
    private readonly attachments: AttachmentService,
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {
    this.bot = new BotApiClient(admin, fetcher)
    this.identityCommands = new TelegramIdentityCommandService(database)
  }

  start(): void {
    if (this.running) return
    this.discardLateAttachmentResults = false
    this.recoverInterruptedOutputs()
    this.running = true
    this.processor.start()
    this.timer = setInterval(() => this.reconcile(), 2_000)
    this.timer.unref()
    this.reconcile()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.race([
      Promise.allSettled([...this.attachmentTasks]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, attachmentShutdownGraceMs)
        timer.unref()
      }),
    ])
    this.discardLateAttachmentResults = true
    await Promise.allSettled([...this.userClients.values()].map((client) => client.disconnect()))
    this.userClients.clear()
    await this.processor.stop()
  }

  status(): TelegramRuntimeStatus {
    return {
      running: this.running,
      botLoops: this.botPolling.size,
      userConnections: this.userClients.size,
      lastUpdateAt: this.lastUpdateAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
    }
  }

  async sendMessage(
    accountId: string | null,
    chatId: string,
    text: string,
    replyTo?: string,
    quote?: string | null,
    ownership: TelegramOutputOwnership = {},
  ): Promise<string> {
    if (!accountId) throw new TelegramDeliveryError("account_unavailable", "failed")
    const account = (() => {
      try {
        return this.admin.getAccount(accountId)
      } catch {
        throw new TelegramDeliveryError("account_unavailable", "failed")
      }
    })()
    const inferredGroup = this.database.readGroups().find((group) => (
      group.accountId === accountId && group.telegramChatId && chatMatches(group.telegramChatId, chatId)
    ))
    const ownershipId = randomUUID()
    const requestKey = randomUUID()
    const now = new Date().toISOString()
    this.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ownershipId,
      accountId,
      ownership.groupId === undefined ? inferredGroup?.id ?? null : ownership.groupId,
      chatId,
      null,
      ownership.threadId ?? null,
      ownership.serviceId === undefined ? inferredGroup?.serviceId ?? null : ownership.serviceId,
      ownership.replyId ?? null,
      ownership.notificationId ?? null,
      ownership.kind?.trim().slice(0, 80) || "other",
      "sending",
      requestKey,
      outputDigest(text),
      replyTo ?? null,
      now,
      now,
    )
    try {
      let messageId: string
      if (account.type === "bot") {
        messageId = await this.bot.send(accountId, chatId, text, replyTo, quote)
      } else {
        const client = this.userClients.get(accountId)
        if (!client) throw new TelegramDeliveryError("account_unavailable", "failed")
        const sent = await client.sendMessage(chatId, { message: text, ...(replyTo ? { replyTo: Number(replyTo) } : {}) })
        messageId = telegramMessageId(sent.id)
      }
      this.completeOutput(ownershipId, messageId)
      return messageId
    } catch (error) {
      const deliveryError = networkDeliveryError(error)
      this.database.prepare(`UPDATE telegram_output_ownership SET delivery_status=?,updated_at=?
        WHERE id=? AND delivery_status='sending'`).run(
        deliveryError.state === "uncertain" ? "unknown" : "failed",
        new Date().toISOString(),
        ownershipId,
      )
      throw deliveryError
    }
  }

  async forwardMessages(
    accountId: string | null,
    targetChatId: string,
    sourceChatId: string,
    messageIds: string[],
    ownership: TelegramOutputOwnership = {},
  ): Promise<string[]> {
    if (!accountId) throw new TelegramDeliveryError("account_unavailable", "failed")
    if (messageIds.length === 0 || messageIds.length > 100 || messageIds.some((id) => !/^\d+$/u.test(id))) {
      throw new TelegramDeliveryError("unknown", "failed")
    }
    const account = (() => {
      try {
        return this.admin.getAccount(accountId)
      } catch {
        throw new TelegramDeliveryError("account_unavailable", "failed")
      }
    })()
    const inferredGroup = this.database.readGroups().find((group) => (
      group.accountId === accountId && group.telegramChatId && chatMatches(group.telegramChatId, targetChatId)
    ))
    const now = new Date().toISOString()
    const ownershipIds = messageIds.map((messageId) => {
      const ownershipId = randomUUID()
      this.database.prepare(`INSERT INTO telegram_output_ownership(
        id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
        notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ownershipId,
        accountId,
        ownership.groupId === undefined ? inferredGroup?.id ?? null : ownership.groupId,
        targetChatId,
        null,
        ownership.threadId ?? null,
        ownership.serviceId === undefined ? inferredGroup?.serviceId ?? null : ownership.serviceId,
        ownership.replyId ?? null,
        ownership.notificationId ?? null,
        ownership.kind?.trim().slice(0, 80) || "forwarded_message",
        "sending",
        randomUUID(),
        outputDigest(`forward:${sourceChatId}:${messageId}`),
        null,
        now,
        now,
      )
      return ownershipId
    })
    try {
      const sentMessageIds = account.type === "bot"
        ? await this.bot.forward(accountId, targetChatId, sourceChatId, messageIds)
        : await (async () => {
          const client = this.userClients.get(accountId)
          if (!client) throw new TelegramDeliveryError("account_unavailable", "failed")
          const sent = await client.forwardMessages(targetChatId, {
            messages: messageIds.map(Number),
            fromPeer: sourceChatId,
          })
          return sent.map((message) => telegramMessageId(message.id))
        })()
      if (sentMessageIds.length !== ownershipIds.length) {
        this.database.prepare(`UPDATE telegram_output_ownership SET delivery_status='unknown',updated_at=?
          WHERE id IN (${ownershipIds.map(() => "?").join(",")}) AND delivery_status='sending'`).run(
          new Date().toISOString(), ...ownershipIds,
        )
        throw new TelegramDeliveryError("unknown", "uncertain")
      }
      sentMessageIds.forEach((messageId, index) => this.completeOutput(ownershipIds[index]!, messageId))
      return sentMessageIds
    } catch (error) {
      const deliveryError = networkDeliveryError(error)
      this.database.prepare(`UPDATE telegram_output_ownership SET delivery_status=?,updated_at=?
        WHERE id IN (${ownershipIds.map(() => "?").join(",")}) AND delivery_status='sending'`).run(
        deliveryError.state === "uncertain" ? "unknown" : "failed",
        new Date().toISOString(),
        ...ownershipIds,
      )
      throw deliveryError
    }
  }

  private reconcile(): void {
    if (!this.running || !this.config.getSettings().telegramEnabled) return
    const accounts = this.admin.listAccounts().filter((item) => item.enabled && item.status === "ready")
    const groups = this.database.readGroups().filter((item) => item.enabled && item.telegramChatId)
    accounts.forEach((account) => {
      if (!groups.some((group) => group.accountId === account.id && group.accessMode === account.type)) return
      if (account.type === "bot" && !this.botPolling.has(account.id)) void this.pollBot(account.id)
      if (account.type === "user" && !this.userClients.has(account.id) && !this.userConnecting.has(account.id)) void this.connectUser(account.id)
    })
  }

  private async pollBot(accountId: string): Promise<void> {
    this.botPolling.add(accountId)
    try {
      while (this.shouldPollBot(accountId)) {
        const row = this.database.prepare("SELECT last_update_id FROM telegram_offsets WHERE account_id=?").get(accountId) as { last_update_id: number } | undefined
        const updates = await this.bot.updates(accountId, row?.last_update_id ?? 0)
        for (const update of updates) {
          if (!this.running) break
          if (update.message) await this.handleBotMessage(accountId, update.message)
          const next = update.update_id + 1
          this.database.prepare(`INSERT INTO telegram_offsets(account_id,last_update_id,updated_at) VALUES (?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET last_update_id=excluded.last_update_id,updated_at=excluded.updated_at`).run(
            accountId, next, new Date().toISOString(),
          )
          this.lastUpdateAt = new Date().toISOString()
        }
      }
    } catch {
      this.lastErrorAt = new Date().toISOString()
      this.lastErrorCode = "bot_poll_failed"
    } finally {
      this.botPolling.delete(accountId)
    }
  }

  private async handleBotMessage(accountId: string, message: BotMessage): Promise<void> {
    const chatId = String(message.chat.id)
    if (message.from?.is_bot) return
    const identityReply = this.identityCommands.resolve({
      text: message.text ?? message.caption ?? "",
      chatId,
      chatType: message.chat.type ?? null,
      sender: botIdentity(message.from),
      replySender: botIdentity(message.reply_to_message?.from),
      hasReply: message.reply_to_message !== undefined,
    })
    if (identityReply !== null) {
      await this.sendMessage(
        accountId,
        chatId,
        identityReply,
        String(message.message_id),
        undefined,
        { kind: "identity" },
      )
      return
    }
    const group = this.groupFor(accountId, "bot", chatId)
    if (!group) return
    const descriptors: IncomingAttachmentDescriptor[] = []
    if (message.document) {
      const document = message.document
      const name = document.file_name ?? "document"
      const mimeType = document.mime_type ?? "application/octet-stream"
      descriptors.push({ name, mimeType, size: document.file_size ?? 0, kind: kindFor(name, mimeType), download: () => this.bot.download(accountId, document.file_id) })
    } else if (message.photo?.length) {
      const photo = message.photo.at(-1)!
      descriptors.push({ name: "photo.jpg", mimeType: "image/jpeg", size: photo.file_size ?? 0, kind: "image", download: () => this.bot.download(accountId, photo.file_id) })
    } else if (message.video) {
      const video = message.video
      descriptors.push({ name: video.file_name ?? "video.mp4", mimeType: video.mime_type ?? "video/mp4", size: video.file_size ?? 0, kind: "video" })
    }
    const event = this.processor.accept({
      groupId: group.id, messageId: String(message.message_id), senderId: String(message.from?.id ?? 0),
      senderUsername: message.from?.username ?? null, fromBot: message.from?.is_bot ?? false,
      senderDisplayName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
      replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
      messageThreadId: message.message_thread_id === undefined ? null : String(message.message_thread_id),
      replyTargetIsBot: message.reply_to_message?.from?.is_bot ?? false,
      text: message.text ?? message.caption ?? "", attachments: descriptors.map((item) => this.attachments.describe(item)),
      attachmentsPending: descriptors.length > 0,
      mediaGroupId: message.media_group_id ?? null,
      ...(message.date ? { createdAt: new Date(message.date * 1000).toISOString() } : {}),
    })
    if (event && descriptors.length > 0) this.prepareAttachments(event.id, descriptors)
  }

  private async connectUser(accountId: string): Promise<void> {
    this.userConnecting.add(accountId)
    const credentials = this.admin.getAccountCredentials(accountId)
    const client = new TelegramClient(
      new sessions.StringSession(credentials.session ?? ""), Number(credentials.apiId), credentials.apiHash ?? "",
      { connectionRetries: 3, timeout: 10 },
    )
    try {
      await client.connect()
      if (!await client.checkAuthorization()) throw new Error("未登录")
      client.addEventHandler((event) => { void this.handleUserMessage(accountId, event) }, new NewMessage({}))
      this.userClients.set(accountId, client)
    } catch {
      await client.disconnect().catch(() => undefined)
      this.lastErrorAt = new Date().toISOString()
      this.lastErrorCode = "user_connect_failed"
    } finally {
      this.userConnecting.delete(accountId)
    }
  }

  private async handleUserMessage(accountId: string, event: NewMessageEvent): Promise<void> {
    const message = event.message
    const chatId = message.chatId?.toString()
    if (!chatId) return
    if (message.out && await this.isApplicationOutput(
      accountId,
      chatId,
      String(message.id),
      message.text ?? "",
      message.replyToMsgId === undefined ? null : String(message.replyToMsgId),
    )) return
    const group = this.groupFor(accountId, "user", chatId)
    if (!group) return
    const sender = message.sender as {
      username?: string
      bot?: boolean
      firstName?: string
      lastName?: string
    } | undefined
    if (sender?.bot) return
    const replyToMessageId = message.replyToMsgId === undefined ? null : String(message.replyToMsgId)
    const replyTargetIsBot = replyToMessageId !== null && (
      Boolean(this.database.prepare(`SELECT 1 FROM telegram_output_ownership
        WHERE delivery_group_id=? AND telegram_message_id=? LIMIT 1`).get(group.id, replyToMessageId))
      || this.database.readReplies(
        "WHERE r.group_id=? AND r.telegram_reply_message_id=? LIMIT 1",
        [group.id, replyToMessageId],
      ).length > 0
    )
    const descriptors: IncomingAttachmentDescriptor[] = []
    if (message.file) {
      const name = message.file.name || (message.video ? "video.mp4" : message.photo ? "photo.jpg" : "attachment")
      const mimeType = message.file.mimeType || "application/octet-stream"
      const size = Number(message.file.size ?? 0)
      const kind = kindFor(name, mimeType)
      descriptors.push({
        name, mimeType, size, kind,
        ...(kind === "video" ? {} : { download: async () => {
          const output = await message.downloadMedia()
          return Buffer.isBuffer(output) ? output : null
        } }),
      })
    }
    const recorded = this.processor.accept({
      groupId: group.id, messageId: String(message.id), senderId: message.senderId?.toString() ?? "0",
      senderUsername: sender?.username ?? null, senderDisplayName: [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") || null,
      fromBot: false,
      accountOwnerOutgoing: Boolean(message.out),
      replyToMessageId,
      messageThreadId: message.replyTo?.replyToTopId === undefined ? null : String(message.replyTo.replyToTopId),
      replyTargetIsBot,
      text: message.text ?? "", attachments: descriptors.map((item) => this.attachments.describe(item)),
      attachmentsPending: descriptors.length > 0,
      mediaGroupId: message.groupedId?.toString() ?? null,
      ...(message.date ? { createdAt: new Date(message.date * 1000).toISOString() } : {}),
    })
    if (recorded && descriptors.length > 0) this.prepareAttachments(recorded.id, descriptors)
    this.lastUpdateAt = new Date().toISOString()
  }

  private prepareAttachments(eventId: string, descriptors: IncomingAttachmentDescriptor[]): void {
    const task = Promise.all(descriptors.map(async (descriptor) => {
      try {
        return await this.attachments.prepare(descriptor)
      } catch {
        const metadata = this.attachments.describe(descriptor)
        return { ...metadata, extractedText: `附件：${metadata.name}；读取失败，只记录元数据。` }
      }
    })).then((prepared) => {
      if (this.discardLateAttachmentResults) return
      this.processor.enrichAttachments(eventId, prepared)
    }).catch(() => {
      if (this.discardLateAttachmentResults) return
      this.lastErrorAt = new Date().toISOString()
      this.lastErrorCode = "attachment_processing_failed"
    })
    this.attachmentTasks.add(task)
    void task.finally(() => this.attachmentTasks.delete(task))
  }

  private shouldPollBot(accountId: string): boolean {
    if (!this.running || !this.config.getSettings().telegramEnabled) return false
    const account = this.admin.listAccounts().find((item) => item.id === accountId)
    if (!account?.enabled || account.status !== "ready" || account.type !== "bot") return false
    return this.database.readGroups().some((group) => (
      group.enabled && group.accountId === accountId && group.accessMode === "bot" && group.telegramChatId
    ))
  }

  private groupFor(accountId: string, accessMode: RuntimeGroup["accessMode"], chatId: string): RuntimeGroup | undefined {
    return this.database.readGroups().find((group) => group.enabled && group.accountId === accountId
      && group.accessMode === accessMode && group.telegramChatId && chatMatches(group.telegramChatId, chatId))
  }

  private completeOutput(ownershipId: string, telegramMessageId: string): void {
    const result = this.database.prepare(`UPDATE telegram_output_ownership SET
      telegram_message_id=?,delivery_status='sent',updated_at=?
      WHERE id=? AND delivery_status IN ('sending','sent')
        AND (telegram_message_id IS NULL OR telegram_message_id=?)`).run(
      telegramMessageId,
      new Date().toISOString(),
      ownershipId,
      telegramMessageId,
    )
    if (Number(result.changes) !== 1) throw new Error("Telegram 输出所有权完成失败")
  }

  private async isApplicationOutput(
    accountId: string,
    chatId: string,
    telegramMessageId: string,
    text: string,
    replyToMessageId: string | null,
  ): Promise<boolean> {
    const quarantined = this.database.prepare(`SELECT candidate.resolution_status FROM telegram_outgoing_candidates candidate
      JOIN telegram_output_ownership ownership ON ownership.id=candidate.ownership_id
      WHERE ownership.account_id=? AND ownership.telegram_chat_id=? AND candidate.telegram_message_id=?
      ORDER BY candidate.created_at,candidate.id`).all(
      accountId,
      chatId,
      telegramMessageId,
    ) as Array<{ resolution_status: "pending" | "application" | "manual" | "unknown" }>
    if (quarantined.some((candidate) => candidate.resolution_status !== "manual")) return true
    const exact = this.database.prepare(`SELECT id FROM telegram_output_ownership
      WHERE account_id=? AND telegram_chat_id=? AND telegram_message_id=? LIMIT 1`).get(
      accountId,
      chatId,
      telegramMessageId,
    ) as { id: string } | undefined
    if (exact) {
      this.database.prepare(`UPDATE telegram_outgoing_candidates SET resolution_status='application',updated_at=?
        WHERE ownership_id=? AND telegram_message_id=?`).run(new Date().toISOString(), exact.id, telegramMessageId)
      return true
    }
    const candidates = this.database.prepare(`SELECT id FROM telegram_output_ownership
      WHERE account_id=? AND telegram_chat_id=? AND telegram_message_id IS NULL
        AND delivery_status IN ('sending','unknown') AND content_sha256=?
        AND COALESCE(reply_to_message_id,'')=COALESCE(?,'')
      ORDER BY created_at,id`).all(
      accountId,
      chatId,
      outputDigest(text),
      replyToMessageId,
    ) as Array<{ id: string }>
    if (candidates.length === 0) return false
    const ids = candidates.map((candidate) => candidate.id)
    const placeholders = ids.map(() => "?").join(",")
    const candidateNow = new Date().toISOString()
    this.database.transaction(() => {
      const insert = this.database.prepare(`INSERT OR IGNORE INTO telegram_outgoing_candidates(
        id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?)`)
      ids.forEach((ownershipId) => insert.run(
        randomUUID(), ownershipId, telegramMessageId, "pending", candidateNow, candidateNow,
      ))
    })
    const resolveCandidates = (status: "application" | "manual" | "unknown"): void => {
      this.database.prepare(`UPDATE telegram_outgoing_candidates SET resolution_status=?,updated_at=?
        WHERE ownership_id IN (${placeholders}) AND telegram_message_id=? AND resolution_status='pending'`).run(
        status,
        new Date().toISOString(),
        ...ids,
        telegramMessageId,
      )
    }
    while (true) {
      const current = this.database.prepare(`SELECT id,telegram_message_id,delivery_status
        FROM telegram_output_ownership WHERE id IN (${placeholders})`).all(...ids) as Array<{
        id: string
        telegram_message_id: string | null
        delivery_status: "sending" | "sent" | "failed" | "unknown"
      }>
      if (current.some((ownership) => ownership.telegram_message_id === telegramMessageId)) {
        resolveCandidates("application")
        return true
      }
      if (current.length !== ids.length || current.some((ownership) => ownership.delivery_status === "unknown")) {
        resolveCandidates("unknown")
        return true
      }
      if (!current.some((ownership) => ownership.delivery_status === "sending")) {
        resolveCandidates("manual")
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, outgoingOwnershipPollMs))
    }
  }

  private recoverInterruptedOutputs(now = new Date().toISOString()): number {
    return this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE telegram_output_ownership SET delivery_status='unknown',updated_at=?
        WHERE delivery_status='sending'`).run(now)
      this.database.prepare(`UPDATE telegram_outgoing_candidates AS candidate SET resolution_status=CASE
          WHEN EXISTS (SELECT 1 FROM telegram_output_ownership ownership
            WHERE ownership.id=candidate.ownership_id AND ownership.delivery_status='sent'
              AND ownership.telegram_message_id=candidate.telegram_message_id) THEN 'application'
          WHEN EXISTS (SELECT 1 FROM telegram_output_ownership ownership
            WHERE ownership.id=candidate.ownership_id AND ownership.delivery_status IN ('sent','failed')) THEN 'manual'
          ELSE 'unknown' END,
        updated_at=? WHERE resolution_status='pending'`).run(now)
      return Number(result.changes)
    })
  }
}
