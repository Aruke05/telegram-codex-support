import type { RuntimeDatabase } from "../runtime/database.js"

export type TelegramIdentity = {
  id: string
  username: string | null
  displayName: string | null
}

export type TelegramIdentityCommandInput = {
  text: string
  chatId: string
  chatType: string | null
  sender: TelegramIdentity | null
  replySender: TelegramIdentity | null
  hasReply: boolean
}

type IdentityRow = {
  telegram_user_id: string
  username: string | null
}

const infoUsage = "使用：/info 或 /info @username；也可以回复某人的消息后发送 /info。"

function identityReply(identity: TelegramIdentity): string {
  return identity.username
    ? `@${identity.username}\n用户 ID：${identity.id}`
    : `用户 ID：${identity.id}`
}

function normalizedUsername(value: string): string {
  return value.replace(/^@/, "").toLocaleLowerCase("en-US")
}

export class TelegramIdentityCommandService {
  constructor(private readonly database: RuntimeDatabase) {}

  resolve(input: TelegramIdentityCommandInput): string | null {
    const text = input.text.trim()
    if (/^\/start(?:@\w+)?$/i.test(text)) {
      const chatLabel = input.chatType === "private" ? "当前会话 ID" : "当前群 ID"
      const senderLine = input.sender ? `你的用户 ID：${input.sender.id}` : "无法取得发送者用户 ID。"
      return `${chatLabel}：${input.chatId}\n${senderLine}`
    }

    const info = text.match(/^\/info(?:@\w+)?(?:\s+([\s\S]+))?$/i)
    if (!info) return null
    const argument = info[1]?.trim() ?? ""
    if (argument && !/^@?[a-zA-Z0-9_]{1,80}$/.test(argument)) return infoUsage

    if (input.hasReply) {
      return input.replySender
        ? identityReply(input.replySender)
        : "无法取得被回复用户的 ID，请改用 /info @username。"
    }
    if (!argument) return input.sender ? `你的用户 ID：${input.sender.id}` : "无法取得发送者用户 ID。"

    const requestedUsername = argument.replace(/^@/, "")
    const identities = this.findByUsername(normalizedUsername(requestedUsername))
    if (identities.length === 0) {
      return `暂未记录 @${requestedUsername}，请让对方发送 /info，或回复对方消息后发送 /info。`
    }
    if (identities.length > 1) {
      return `@${requestedUsername} 对应多个用户 ID，请回复目标用户的消息后发送 /info。`
    }
    return identityReply(identities[0]!)
  }

  private findByUsername(username: string): TelegramIdentity[] {
    const candidates = new Map<string, TelegramIdentity>()
    for (const role of this.database.readRoles()) {
      if (role.username && normalizedUsername(role.username) === username) {
        candidates.set(role.telegramUserId, {
          id: role.telegramUserId,
          username: role.username.replace(/^@/, ""),
          displayName: role.displayName,
        })
      }
    }
    const rows = this.database.prepare(`SELECT sender_user_id AS telegram_user_id,MAX(sender_username) AS username
      FROM support_message_events
      WHERE sender_username=? COLLATE NOCASE
      GROUP BY sender_user_id
      ORDER BY MAX(created_at) DESC
      LIMIT 3`).all(username) as IdentityRow[]
    for (const row of rows) {
      if (!/^\d+$/.test(row.telegram_user_id) || row.telegram_user_id === "0" || candidates.has(row.telegram_user_id)) continue
      candidates.set(row.telegram_user_id, {
        id: row.telegram_user_id,
        username: row.username?.replace(/^@/, "") ?? null,
        displayName: null,
      })
    }
    return [...candidates.values()]
  }
}
