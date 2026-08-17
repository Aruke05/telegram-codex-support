import { readFile } from "node:fs/promises"

import { groupCatalogSchema, type GroupCatalog, type TelegramGroup } from "./schema.js"

export async function loadGroupCatalog(filePath: string): Promise<GroupCatalog> {
  return groupCatalogSchema.parse(JSON.parse(await readFile(filePath, "utf8")))
}

export function findEnabledGroupByChatId(catalog: GroupCatalog, chatId: string): TelegramGroup | null {
  if (!chatId) return null
  return catalog.groups.find((group) => group.enabled && group.telegramChatId === chatId) ?? null
}
