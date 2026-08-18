import type { TelegramGroup } from "./types.js"

export type GroupFormDraft = {
  key: string
  name: string
  telegramChatId: string
  accountId: string
  projectId: string
  serviceId: string
  enabled: boolean
  existing: boolean
  purpose: TelegramGroup["purpose"]
}

export type GroupFormIssue = {
  field: "key" | "name" | "telegramChatId" | "accountId" | "projectId" | "serviceId"
  message: string
}

export function optionalTelegramChatId(value: string): string | null {
  const normalized = value.trim()
  return normalized || null
}

export function validateGroupForm(draft: GroupFormDraft): GroupFormIssue | null {
  if (!draft.name.trim()) return { field: "name", message: "请填写群名称" }
  if (!draft.key.trim()) return { field: "key", message: "请填写唯一标识" }

  const telegramChatId = optionalTelegramChatId(draft.telegramChatId)
  if (!telegramChatId && !draft.existing) return { field: "telegramChatId", message: "添加群前请先填写群 ID" }
  if (draft.enabled && !telegramChatId) return { field: "telegramChatId", message: "启用群前请先填写群 ID" }
  if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) return { field: "telegramChatId", message: "群 ID 只能填写数字，可在开头带负号" }

  if (draft.enabled && !draft.accountId) return { field: "accountId", message: "启用群前请先绑定客服账号" }
  if (draft.purpose === "support" && !draft.projectId) return { field: "projectId", message: "客服群必须选择项目" }
  if (draft.purpose === "support" && !draft.serviceId) return { field: "serviceId", message: "客服群必须选择服务" }
  return null
}
