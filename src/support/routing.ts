import type { RuntimeGroup, TelegramRole } from "../runtime/types.js"

type SenderRole = TelegramRole["role"] | null

export type SupportRoute =
  | { action: "process"; question: string; requestedService: string | null; serviceSource: "group_binding" | "technical_command"; immediate: boolean }
  | { action: "correct"; correctionText: string }
  | { action: "ignore"; reason: string }
  | { action: "help"; text: string }
  | { action: "drop" }

export function routeSupportMessage(input: {
  purpose: RuntimeGroup["purpose"]
  senderRole: SenderRole
  canCorrect: boolean
  text: string
}): SupportRoute {
  const text = input.text.trim()
  if (input.purpose === "technical_alert") {
    return { action: "ignore", reason: "技术群只接收运营问题原消息转发" }
  }

  const aiCommand = text.match(/^\/ai(?:@\w+)?\s+([\s\S]+)$/i)
  if (aiCommand) {
    return {
      action: "process",
      requestedService: null,
      question: aiCommand[1]!.trim(),
      serviceSource: "group_binding",
      immediate: true,
    }
  }
  const correction = text.match(/^\/correct(?:@\w+)?\s+([\s\S]+)$/i)
  if (correction && input.canCorrect) return { action: "correct", correctionText: correction[1]!.trim() }
  if (input.senderRole !== null) return { action: "ignore", reason: "角色用户普通消息不进入客服问题" }
  return { action: "process", requestedService: null, question: text, serviceSource: "group_binding", immediate: false }
}
