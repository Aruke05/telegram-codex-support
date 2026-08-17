import { z } from "zod"

const telegramChatIdSchema = z.string().regex(/^-?\d+$/, "telegramChatId 格式错误").nullable()

const telegramGroupSchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  telegramChatId: telegramChatIdSchema,
  enabled: z.boolean(),
  accessMode: z.enum(["bot", "user"]),
  platform: z.string().trim().min(1),
  repositories: z.array(z.enum(["java-project", "sfzf-web"])),
  branch: z.string().trim().min(1).nullable(),
  serverAlias: z.string().trim().min(1).nullable(),
  databaseAlias: z.string().trim().min(1),
  knowledgeScope: z.string().trim().min(1),
}).strict().superRefine((group, context) => {
  if (group.enabled && group.telegramChatId === null) {
    context.addIssue({ code: "custom", path: ["telegramChatId"], message: "启用群必须配置 telegramChatId" })
  }
  if (group.repositories.length === 0 && group.branch !== null) {
    context.addIssue({ code: "custom", path: ["branch"], message: "没有代码仓库时 branch 必须为空" })
  }
  if (group.repositories.length > 0 && group.branch === null) {
    context.addIssue({ code: "custom", path: ["branch"], message: "代码仓库必须绑定 branch" })
  }
})

export const groupCatalogSchema = z.object({
  version: z.number().int().positive(),
  technicalAlertGroup: z.object({
    name: z.literal("技术部"),
    telegramChatId: telegramChatIdSchema,
  }).strict(),
  groups: z.array(telegramGroupSchema).length(13, "客服群必须恰好为13个"),
}).strict().superRefine((catalog, context) => {
  const keys = new Set<string>()
  const chatIds = new Set<string>()
  for (const [index, group] of catalog.groups.entries()) {
    if (keys.has(group.key)) {
      context.addIssue({ code: "custom", path: ["groups", index, "key"], message: "群 key 不能重复" })
    }
    keys.add(group.key)

    if (group.telegramChatId !== null) {
      if (chatIds.has(group.telegramChatId)) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "telegramChatId"],
          message: "telegramChatId 不能重复",
        })
      }
      chatIds.add(group.telegramChatId)
    }
  }
})

export type RepositoryName = z.infer<typeof telegramGroupSchema>["repositories"][number]
export type TelegramGroup = z.infer<typeof telegramGroupSchema>
export type GroupCatalog = z.infer<typeof groupCatalogSchema>
