import type { MemoryAuthoringService } from "../learning/authoring.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeGroup, SupportMessageEvent, TelegramRole } from "../runtime/types.js"
import type { TelegramOutputOwnership } from "../telegram/runtime.js"

type CorrectionTransport = {
  sendMessage(
    accountId: string | null,
    chatId: string,
    text: string,
    replyToMessageId?: string,
    quote?: string | null,
    ownership?: TelegramOutputOwnership,
  ): Promise<string>
}

export type SupportCorrectionInput = {
  group: RuntimeGroup
  role: TelegramRole
  event: SupportMessageEvent
  correctionText: string
  replyToMessageId: string | null
  replyTargetIsBot: boolean
}

export class SupportCorrectionService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly authoring: MemoryAuthoringService,
    private readonly transport: CorrectionTransport,
  ) {}

  async handle(input: SupportCorrectionInput): Promise<"corrected" | "ignored"> {
    if (!input.role.enabled || !input.role.canCorrect || input.group.purpose !== "support" || !input.group.telegramChatId) return "ignored"
    if (!input.replyToMessageId || !input.replyTargetIsBot) {
      await this.transport.sendMessage(
        input.group.accountId,
        input.group.telegramChatId,
        "请回复一条机器人回答，再输入 /correct 正确内容",
        input.event.telegramMessageId,
        undefined,
        { groupId: input.group.id, serviceId: input.group.serviceId, kind: "correction" },
      )
      return "ignored"
    }
    const reply = this.database.readReplies(
      "WHERE r.group_id=? AND r.telegram_reply_message_id=? ORDER BY r.created_at DESC LIMIT 1",
      [input.group.id, input.replyToMessageId],
    )[0]
    if (!reply) {
      await this.transport.sendMessage(
        input.group.accountId,
        input.group.telegramChatId,
        "没找到这条机器人回答，去后台【客服记录】里纠正",
        input.event.telegramMessageId,
        undefined,
        { groupId: input.group.id, serviceId: input.group.serviceId, kind: "correction" },
      )
      return "ignored"
    }
    const service = reply.serviceId
      ? this.database.readProjectServices("WHERE id=?", [reply.serviceId])[0]
      : undefined
    const correctedBy = input.role.displayName || input.role.username || input.role.telegramUserId
    await this.authoring.correctReply(reply.id, {
      correctedAnswer: input.correctionText,
      reason: "群内人工纠正：原回答不准确，以本次正确内容为准。",
      scope: input.group.knowledgeScope,
      region: service?.region || null,
      branch: service?.branch ?? input.group.branch,
      correctedBy,
    })
    await this.transport.sendMessage(
      input.group.accountId,
      input.group.telegramChatId,
      "纠错已记录",
      input.event.telegramMessageId,
      undefined,
      {
        groupId: input.group.id,
        serviceId: reply.serviceId ?? input.group.serviceId,
        threadId: reply.threadId,
        replyId: reply.id,
        kind: "correction",
      },
    )
    return "corrected"
  }
}
