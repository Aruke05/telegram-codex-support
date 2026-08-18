import { randomUUID } from "node:crypto"

import { z } from "zod"

import type { GroupCatalog } from "../catalog/schema.js"
import { redactText } from "../security/dlp.js"
import type { RuntimeDatabase } from "./database.js"
import type { LocalSecretVault } from "./secret-vault.js"
import type { RuntimeGroup, TelegramAccount, TelegramRole } from "./types.js"

const botCredentialsSchema = z.object({ botToken: z.string().trim().min(30).max(300) }).strict()
const userSessionSchema = z.string().max(20000)
const userCredentialsSchema = z.object({
  apiId: z.string().trim().regex(/^\d+$/),
  apiHash: z.string().trim().min(20).max(200),
  phone: z.string().trim().min(6).max(40),
  session: userSessionSchema.default(""),
}).strict()

const createAccountSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string().trim().min(1).max(80),
    type: z.literal("bot"),
    botToken: botCredentialsSchema.shape.botToken,
    enabled: z.boolean().default(false),
  }),
  z.object({
    name: z.string().trim().min(1).max(80),
    type: z.literal("user"),
    apiId: userCredentialsSchema.shape.apiId,
    apiHash: userCredentialsSchema.shape.apiHash,
    phone: userCredentialsSchema.shape.phone,
    session: userCredentialsSchema.shape.session.optional(),
    enabled: z.boolean().default(false),
  }),
])

const accountUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  botToken: botCredentialsSchema.shape.botToken.optional(),
  apiId: userCredentialsSchema.shape.apiId.optional(),
  apiHash: userCredentialsSchema.shape.apiHash.optional(),
  phone: userCredentialsSchema.shape.phone.optional(),
  session: userSessionSchema.optional(),
}).strict()

const groupInputFields = {
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  telegramChatId: z.string().trim().regex(/^-?\d+$/),
  accountId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable().default(null),
  serviceId: z.string().uuid().nullable().default(null),
  enabled: z.boolean(),
  accessMode: z.enum(["bot", "user"]),
  triggerMode: z.enum(["all", "command"]),
  platform: z.string().trim().min(1).max(80),
  repositories: z.array(z.enum(["java-project", "sfzf-web"])),
  branch: z.string().trim().min(1).max(120).nullable(),
  serverAlias: z.string().trim().min(1).max(120).nullable(),
  databaseAlias: z.string().trim().min(1).max(120),
  knowledgeScope: z.string().trim().min(1).max(120),
  purpose: z.enum(["support", "technical_alert"]).default("support"),
  aiModelInstanceId: z.string().uuid().nullable().default(null),
  replyStyle: z.enum(["human", "unrestricted"]).default("unrestricted"),
} as const

function validateGroupInput(
  group: Omit<z.infer<z.ZodObject<typeof groupInputFields>>, "telegramChatId"> & { telegramChatId: string | null },
  context: z.RefinementCtx,
): void {
  if (group.enabled && !group.telegramChatId) context.addIssue({ code: "custom", path: ["telegramChatId"], message: "启用群必须填写群 ID" })
  if (group.enabled && !group.accountId) context.addIssue({ code: "custom", path: ["accountId"], message: "启用群必须绑定账号" })
  if (group.repositories.length > 0 && !group.branch) context.addIssue({ code: "custom", path: ["branch"], message: "代码仓库必须绑定分支" })
  if (group.repositories.length === 0 && group.branch) context.addIssue({ code: "custom", path: ["branch"], message: "没有代码仓库时不能配置分支" })
  if (group.purpose === "support" && group.triggerMode !== "all") context.addIssue({ code: "custom", path: ["triggerMode"], message: "客服群必须判断每条文字" })
  if (group.purpose === "technical_alert" && group.triggerMode !== "command") context.addIssue({ code: "custom", path: ["triggerMode"], message: "技术告警群不处理群内消息" })
  if (Boolean(group.projectId) !== Boolean(group.serviceId)) context.addIssue({ code: "custom", path: ["serviceId"], message: "项目和服务必须同时配置" })
  if (group.purpose === "support" && (!group.projectId || !group.serviceId)) context.addIssue({ code: "custom", path: ["serviceId"], message: "客服群必须绑定项目和服务" })
  if (group.purpose === "technical_alert" && (group.projectId || group.serviceId)) context.addIssue({ code: "custom", path: ["serviceId"], message: "技术告警群不绑定固定服务" })
  if (group.purpose === "support" && group.aiModelInstanceId) context.addIssue({ code: "custom", path: ["aiModelInstanceId"], message: "客服群使用回答模型配置" })
}

const createGroupSchema = z.object(groupInputFields).strict().superRefine(validateGroupInput)
const persistedGroupInputSchema = z.object({
  ...groupInputFields,
  telegramChatId: groupInputFields.telegramChatId.nullable(),
}).strict().superRefine(validateGroupInput)
const updateGroupSchema = z.object({
  key: groupInputFields.key.optional(),
  name: groupInputFields.name.optional(),
  telegramChatId: groupInputFields.telegramChatId.nullable().optional(),
  accountId: groupInputFields.accountId.optional(),
  projectId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  enabled: groupInputFields.enabled.optional(),
  accessMode: groupInputFields.accessMode.optional(),
  triggerMode: groupInputFields.triggerMode.optional(),
  platform: groupInputFields.platform.optional(),
  repositories: groupInputFields.repositories.optional(),
  branch: groupInputFields.branch.optional(),
  serverAlias: groupInputFields.serverAlias.optional(),
  databaseAlias: groupInputFields.databaseAlias.optional(),
  knowledgeScope: groupInputFields.knowledgeScope.optional(),
  purpose: z.enum(["support", "technical_alert"]).optional(),
  aiModelInstanceId: z.string().uuid().nullable().optional(),
  replyStyle: z.enum(["human", "unrestricted"]).optional(),
}).strict()

const batchGroupPatchSchema = z.object({
  enabled: groupInputFields.enabled.optional(),
  accessMode: groupInputFields.accessMode.optional(),
  accountId: z.string().uuid().optional(),
  replyStyle: groupInputFields.replyStyle.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "至少选择一项批量修改")

const batchGroupUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "群 ID 不能重复"),
  patch: batchGroupPatchSchema,
}).strict()

const roleInputSchema = z.object({
  telegramUserId: z.string().trim().regex(/^\d+$/),
  username: z.string().trim().max(80).nullable().default(null),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["operator", "technical", "reviewer", "ignored"]),
  canCorrect: z.boolean(),
  enabled: z.boolean(),
  learningSourceEnabled: z.boolean().default(false),
}).strict()

export type CreateAccountInput = z.input<typeof createAccountSchema>
export type UpdateAccountInput = z.input<typeof accountUpdateSchema>
export type CreateGroupInput = z.input<typeof createGroupSchema>
export type UpdateGroupInput = z.input<typeof updateGroupSchema>
export type BatchGroupPatch = z.input<typeof batchGroupPatchSchema>
export type BatchGroupUpdateInput = z.input<typeof batchGroupUpdateSchema>
export type RoleInput = z.input<typeof roleInputSchema>

export type PublicTelegramAccount = Omit<TelegramAccount, "credentials"> & {
  secretConfigured: true
  secretHint: string
}

export type PublicRuntimeGroup = RuntimeGroup & { configured: boolean }

export class GroupBatchUpdateError extends Error {
  override readonly name = "GroupBatchUpdateError"
}

const safeBatchGroupErrors = new Set([
  "启用群必须填写群 ID",
  "启用群必须绑定账号",
  "启用群必须绑定已启用的客服账号",
  "群接入方式与账号类型不一致",
  "Telegram 账号不存在",
  "项目和服务必须同时配置",
  "服务不属于该项目",
  "客服群必须绑定项目和服务",
  "技术告警群不绑定固定服务",
  "客服群使用回答模型配置",
  "模型别名不存在",
  "客服群必须判断每条文字",
  "技术告警群不处理群内消息",
  "只能配置一个技术告警群",
  "配置包含敏感信息",
])

function publicAccount(account: TelegramAccount, vault: LocalSecretVault): PublicTelegramAccount {
  const credentials = vault.openJson<Record<string, string>>(account.credentials)
  const hint = account.type === "bot"
    ? `Token ••••${(credentials.botToken ?? "").slice(-4)}`
    : `${credentials.phone?.slice(0, 3) ?? ""}••••${credentials.phone?.slice(-2) ?? ""}`
  const { credentials: _credentials, ...safe } = account
  return { ...safe, secretConfigured: true, secretHint: hint }
}

function assertConfigurationSafe(values: Array<string | null | undefined>): void {
  if (values.some((value) => value && redactText(value).changed)) throw new Error("配置包含敏感信息")
}

export class RuntimeAdminService {
  constructor(
    readonly database: RuntimeDatabase,
    readonly vault: LocalSecretVault,
  ) {}

  static seedGroups(catalog: GroupCatalog): RuntimeGroup[] {
    const now = new Date().toISOString()
    const groups: RuntimeGroup[] = catalog.groups.map((group) => ({
      id: randomUUID(),
      key: group.key,
      name: group.name,
      telegramChatId: group.telegramChatId,
      accountId: null,
      projectId: null,
      serviceId: null,
      enabled: false,
      accessMode: group.accessMode,
      triggerMode: "all",
      platform: group.platform,
      repositories: group.repositories,
      branch: group.branch,
      serverAlias: group.serverAlias,
      databaseAlias: group.databaseAlias,
      knowledgeScope: group.knowledgeScope,
      purpose: "support",
      aiModelInstanceId: null,
      replyStyle: "unrestricted",
      createdAt: now,
      updatedAt: now,
    }))
    if (catalog.technicalAlertGroup.telegramChatId) groups.push({
      id: randomUUID(),
      key: "technical-alert",
      name: catalog.technicalAlertGroup.name,
      telegramChatId: catalog.technicalAlertGroup.telegramChatId,
      accountId: null,
      projectId: null,
      serviceId: null,
      enabled: false,
      accessMode: "bot",
      triggerMode: "command",
      platform: "internal",
      repositories: [],
      branch: null,
      serverAlias: null,
      databaseAlias: "none",
      knowledgeScope: "technical-alert",
      purpose: "technical_alert",
      aiModelInstanceId: "00000000-0000-4000-8000-000000000001",
      replyStyle: "unrestricted",
      createdAt: now,
      updatedAt: now,
    })
    return groups
  }

  listAccounts(): PublicTelegramAccount[] {
    return this.database.readAccounts().map((account) => publicAccount(account, this.vault))
  }

  getAccount(id: string): PublicTelegramAccount {
    const account = this.database.readAccounts().find((item) => item.id === id)
    if (!account) throw new Error("Telegram 账号不存在")
    return publicAccount(account, this.vault)
  }

  async createAccount(input: CreateAccountInput): Promise<PublicTelegramAccount> {
    const parsed = createAccountSchema.parse(input)
    assertConfigurationSafe([parsed.name])
    const credentials = parsed.type === "bot"
      ? botCredentialsSchema.parse({ botToken: parsed.botToken })
      : userCredentialsSchema.parse({ apiId: parsed.apiId, apiHash: parsed.apiHash, phone: parsed.phone, session: parsed.session ?? "" })
    const now = new Date().toISOString()
    const hasSession = parsed.type === "user" && "session" in credentials && credentials.session.length > 0
    const account: TelegramAccount = {
      id: randomUUID(), name: parsed.name, type: parsed.type, enabled: parsed.enabled,
      status: parsed.type === "bot" || hasSession ? "not_tested" : "login_required",
      statusMessage: parsed.type === "bot" || hasSession ? "尚未检测连接" : "需要完成 Telegram 登录",
      credentials: this.vault.sealJson(credentials), botUsername: null, createdAt: now, updatedAt: now,
    }
    this.database.insertAccount(account)
    return publicAccount(account, this.vault)
  }

  async updateAccount(id: string, input: UpdateAccountInput): Promise<PublicTelegramAccount> {
    const parsed = accountUpdateSchema.parse(input)
    assertConfigurationSafe([parsed.name])
    const account = this.requireAccount(id)
    const credentials = this.vault.openJson<Record<string, string>>(account.credentials)
    const botTokenChanged = account.type === "bot" && Boolean(parsed.botToken && parsed.botToken !== credentials.botToken)
    if (account.type === "bot" && parsed.botToken) credentials.botToken = parsed.botToken
    let userIdentityChanged = false
    let userSessionChanged = false
    if (account.type === "user") {
      userIdentityChanged = Boolean(
        (parsed.apiId && parsed.apiId !== credentials.apiId)
        || (parsed.apiHash && parsed.apiHash !== credentials.apiHash)
        || (parsed.phone && parsed.phone !== credentials.phone),
      )
      if (parsed.apiId) credentials.apiId = parsed.apiId
      if (parsed.apiHash) credentials.apiHash = parsed.apiHash
      if (parsed.phone) credentials.phone = parsed.phone
      if (userIdentityChanged) credentials.session = ""
      else if (parsed.session !== undefined) {
        userSessionChanged = parsed.session !== credentials.session
        credentials.session = parsed.session
      }
    }
    account.name = parsed.name ?? account.name
    account.enabled = parsed.enabled ?? account.enabled
    account.credentials = this.vault.sealJson(credentials)
    if (userIdentityChanged || (account.type === "user" && userSessionChanged && !credentials.session)) {
      account.enabled = false
      account.status = "login_required"
      account.statusMessage = "身份配置已更新，需要重新登录"
    } else if (botTokenChanged || userSessionChanged) {
      account.status = "not_tested"
      account.statusMessage = "连接配置已更新，请重新检测"
    }
    account.updatedAt = new Date().toISOString()
    this.updateAccountRow(account)
    if (!account.enabled) this.database.prepare("UPDATE telegram_groups SET enabled=0,updated_at=? WHERE account_id=?").run(account.updatedAt, account.id)
    return publicAccount(account, this.vault)
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<PublicTelegramAccount> {
    return this.updateAccount(id, { enabled })
  }

  async updateAccountConnection(id: string, update: Pick<TelegramAccount, "status" | "statusMessage"> & { botUsername?: string | null }): Promise<PublicTelegramAccount> {
    const account = this.requireAccount(id)
    account.status = update.status
    account.statusMessage = update.statusMessage
    if (update.botUsername !== undefined) account.botUsername = update.botUsername
    account.updatedAt = new Date().toISOString()
    this.updateAccountRow(account)
    return publicAccount(account, this.vault)
  }

  async saveUserSession(id: string, session: string): Promise<PublicTelegramAccount> {
    const account = this.requireAccount(id)
    if (account.type !== "user") throw new Error("个人账号不存在")
    const credentials = this.vault.openJson<Record<string, string>>(account.credentials)
    account.credentials = this.vault.sealJson({ ...credentials, session })
    account.status = "ready"
    account.statusMessage = "连接正常"
    account.updatedAt = new Date().toISOString()
    this.updateAccountRow(account)
    return publicAccount(account, this.vault)
  }

  async deleteAccount(id: string): Promise<void> {
    if (this.database.readGroups().some((group) => group.accountId === id)) throw new Error("账号仍被群配置使用")
    const result = this.database.prepare("DELETE FROM telegram_accounts WHERE id=?").run(id)
    if (Number(result.changes) === 0) throw new Error("Telegram 账号不存在")
  }

  listGroups(): PublicRuntimeGroup[] {
    return this.database.readGroups().map((group) => ({ ...group, configured: Boolean(group.telegramChatId && group.accountId) }))
  }

  async createGroup(input: CreateGroupInput): Promise<PublicRuntimeGroup> {
    const parsed = createGroupSchema.parse(input)
    assertConfigurationSafe([parsed.key, parsed.name, parsed.platform, parsed.branch, parsed.serverAlias, parsed.databaseAlias, parsed.knowledgeScope])
    this.validateGroupAccount(parsed.accountId, parsed.accessMode, parsed.enabled)
    this.validateGroupProject(parsed.projectId, parsed.serviceId)
    this.validateGroupModel(parsed.aiModelInstanceId, parsed.purpose ?? "support", parsed.enabled)
    if (parsed.purpose === "technical_alert" && this.database.readGroups().some((item) => item.purpose === "technical_alert")) throw new Error("只能配置一个技术告警群")
    const now = new Date().toISOString()
    const group: RuntimeGroup = { ...parsed, purpose: parsed.purpose ?? "support", id: randomUUID(), createdAt: now, updatedAt: now }
    try {
      this.database.insertGroup(group)
    } catch {
      if (this.database.readGroups().some((item) => item.key === group.key)) throw new Error("群标识不能重复")
      if (this.database.readGroups().some((item) => item.telegramChatId === group.telegramChatId)) throw new Error("群 ID 不能重复")
      throw new Error("群配置保存失败")
    }
    return { ...group, configured: Boolean(group.telegramChatId && group.accountId) }
  }

  async updateGroup(id: string, input: UpdateGroupInput): Promise<PublicRuntimeGroup> {
    const parsed = updateGroupSchema.parse(input)
    const found = this.database.readGroups().find((item) => item.id === id)
    if (!found) throw new Error("群配置不存在")
    const updated = this.prepareGroupUpdate(found, parsed, new Date().toISOString())
    this.updateGroupRow(updated)
    return this.publicGroup(updated)
  }

  async updateGroups(input: BatchGroupUpdateInput): Promise<PublicRuntimeGroup[]> {
    const parsed = batchGroupUpdateSchema.parse(input)
    const groups = this.database.readGroups()
    const found = parsed.ids.map((id) => groups.find((group) => group.id === id))
    if (found.some((group) => !group)) throw new GroupBatchUpdateError("所选白名单群不存在")
    const timestamp = new Date().toISOString()
    const updated = (found as RuntimeGroup[]).map((group) => {
      try {
        return this.prepareGroupUpdate(group, parsed.patch, timestamp)
      } catch (error) {
        const candidateDetail = error instanceof z.ZodError
          ? error.issues[0]?.message ?? "群配置格式错误"
          : error instanceof Error ? error.message : "群配置保存失败"
        const detail = error instanceof z.ZodError || safeBatchGroupErrors.has(candidateDetail)
          ? candidateDetail
          : "群配置校验失败"
        const redactedName = redactText(group.name)
        const label = redactedName.changed || !group.name.trim() ? "白名单群" : group.name
        throw new GroupBatchUpdateError(`${label}：${detail}`)
      }
    })
    this.database.transaction(() => updated.forEach((group) => {
      this.database.prepare(`UPDATE telegram_groups SET
        enabled=?,access_mode=?,account_id=?,reply_style=?,updated_at=? WHERE id=?`).run(
        Number(group.enabled), group.accessMode, group.accountId, group.replyStyle, group.updatedAt, group.id,
      )
    }))
    return updated.map((group) => this.publicGroup(group))
  }

  private prepareGroupUpdate(
    found: RuntimeGroup,
    parsed: UpdateGroupInput,
    updatedAt: string,
  ): RuntimeGroup {
    const merged = persistedGroupInputSchema.parse({
      key: parsed.key ?? found.key,
      name: parsed.name ?? found.name,
      telegramChatId: parsed.telegramChatId === undefined ? found.telegramChatId : parsed.telegramChatId,
      accountId: parsed.accountId === undefined ? found.accountId : parsed.accountId,
      projectId: parsed.projectId === undefined ? found.projectId : parsed.projectId,
      serviceId: parsed.serviceId === undefined ? found.serviceId : parsed.serviceId,
      enabled: parsed.enabled ?? found.enabled,
      accessMode: parsed.accessMode ?? found.accessMode,
      triggerMode: parsed.triggerMode ?? found.triggerMode,
      platform: parsed.platform ?? found.platform,
      repositories: parsed.repositories ?? found.repositories,
      branch: parsed.branch === undefined ? found.branch : parsed.branch,
      serverAlias: parsed.serverAlias === undefined ? found.serverAlias : parsed.serverAlias,
      databaseAlias: parsed.databaseAlias ?? found.databaseAlias,
      knowledgeScope: parsed.knowledgeScope ?? found.knowledgeScope,
      purpose: parsed.purpose ?? found.purpose,
      aiModelInstanceId: parsed.aiModelInstanceId === undefined ? found.aiModelInstanceId : parsed.aiModelInstanceId,
      replyStyle: parsed.replyStyle ?? found.replyStyle,
    })
    assertConfigurationSafe([merged.key, merged.name, merged.platform, merged.branch, merged.serverAlias, merged.databaseAlias, merged.knowledgeScope])
    this.validateGroupAccount(merged.accountId, merged.accessMode, merged.enabled)
    this.validateGroupProject(merged.projectId, merged.serviceId)
    this.validateGroupModel(merged.aiModelInstanceId, merged.purpose ?? found.purpose, merged.enabled)
    if (merged.purpose === "technical_alert" && this.database.readGroups().some((item) => item.purpose === "technical_alert" && item.id !== found.id)) throw new Error("只能配置一个技术告警群")
    return { ...found, ...merged, purpose: merged.purpose ?? found.purpose, updatedAt }
  }

  private updateGroupRow(updated: RuntimeGroup): void {
    this.database.prepare(`UPDATE telegram_groups SET
      group_key=?,name=?,telegram_chat_id=?,account_id=?,project_id=?,service_id=?,enabled=?,access_mode=?,trigger_mode=?,platform=?,repositories=?,branch=?,server_alias=?,database_alias=?,knowledge_scope=?,purpose=?,ai_model_instance_id=?,reply_style=?,updated_at=? WHERE id=?`).run(
      updated.key, updated.name, updated.telegramChatId, updated.accountId, updated.projectId, updated.serviceId, Number(updated.enabled), updated.accessMode,
      updated.triggerMode, updated.platform, JSON.stringify(updated.repositories), updated.branch, updated.serverAlias,
      updated.databaseAlias, updated.knowledgeScope, updated.purpose, updated.aiModelInstanceId, updated.replyStyle, updated.updatedAt, updated.id,
    )
  }

  private publicGroup(group: RuntimeGroup): PublicRuntimeGroup {
    return { ...group, configured: Boolean(group.telegramChatId && group.accountId) }
  }

  async deleteGroup(id: string): Promise<void> {
    const result = this.database.prepare("DELETE FROM telegram_groups WHERE id=?").run(id)
    if (Number(result.changes) === 0) throw new Error("群配置不存在")
  }

  listRoles(): TelegramRole[] {
    return this.database.readRoles()
  }

  async createRole(input: RoleInput): Promise<TelegramRole> {
    const parsed = roleInputSchema.parse(input)
    assertConfigurationSafe([parsed.username, parsed.displayName])
    const now = new Date().toISOString()
    const role: TelegramRole = { ...parsed, username: parsed.username ?? null, id: randomUUID(), createdAt: now, updatedAt: now }
    this.database.insertRole(role)
    return role
  }

  async updateRole(id: string, input: Partial<RoleInput>): Promise<TelegramRole> {
    const found = this.database.readRoles().find((role) => role.id === id)
    if (!found) throw new Error("角色配置不存在")
    const merged = roleInputSchema.parse({
      telegramUserId: input.telegramUserId ?? found.telegramUserId,
      username: input.username === undefined ? found.username : input.username,
      displayName: input.displayName ?? found.displayName,
      role: input.role ?? found.role,
      canCorrect: input.canCorrect ?? found.canCorrect,
      enabled: input.enabled ?? found.enabled,
      learningSourceEnabled: input.learningSourceEnabled ?? found.learningSourceEnabled,
    })
    assertConfigurationSafe([merged.username, merged.displayName])
    const updated: TelegramRole = { ...found, ...merged, username: merged.username ?? null, updatedAt: new Date().toISOString() }
    this.database.prepare(`UPDATE telegram_roles SET telegram_user_id=?,username=?,display_name=?,role=?,can_correct=?,enabled=?,learning_source_enabled=?,updated_at=? WHERE id=?`).run(
      updated.telegramUserId, updated.username, updated.displayName, updated.role, Number(updated.canCorrect), Number(updated.enabled), Number(updated.learningSourceEnabled), updated.updatedAt, id,
    )
    return updated
  }

  async deleteRole(id: string): Promise<void> {
    const result = this.database.prepare("DELETE FROM telegram_roles WHERE id=?").run(id)
    if (Number(result.changes) === 0) throw new Error("角色配置不存在")
  }

  getAccountCredentials(id: string): Record<string, string> {
    return this.vault.openJson<Record<string, string>>(this.requireAccount(id).credentials)
  }

  getGroupChatId(id: string): string {
    const group = this.database.readGroups().find((item) => item.id === id)
    if (!group?.telegramChatId) throw new Error("群尚未配置 ID")
    return group.telegramChatId
  }

  private requireAccount(id: string): TelegramAccount {
    const account = this.database.readAccounts().find((item) => item.id === id)
    if (!account) throw new Error("Telegram 账号不存在")
    return account
  }

  private validateGroupAccount(accountId: string | null, accessMode: RuntimeGroup["accessMode"], groupEnabled: boolean): void {
    if (!accountId) return
    const account = this.database.readAccounts().find((item) => item.id === accountId)
    if (!account) throw new Error("Telegram 账号不存在")
    if (account.type !== accessMode) throw new Error("群接入方式与账号类型不一致")
    if (groupEnabled && !account.enabled) throw new Error("启用群必须绑定已启用的客服账号")
  }

  private validateGroupProject(projectId: string | null, serviceId: string | null): void {
    if (!projectId && !serviceId) return
    if (!projectId || !serviceId) throw new Error("项目和服务必须同时配置")
    const service = this.database.readProjectServices("WHERE id=?", [serviceId])[0]
    if (!service || service.projectId !== projectId) throw new Error("服务不属于该项目")
  }

  private validateGroupModel(modelInstanceId: string | null, purpose: RuntimeGroup["purpose"], groupEnabled: boolean): void {
    if (purpose === "support") {
      if (modelInstanceId) throw new Error("客服群使用运行配置中的回答模型")
      return
    }
    void groupEnabled
    if (!modelInstanceId) return
    const model = this.database.prepare("SELECT enabled FROM model_instances WHERE id=?").get(modelInstanceId) as { enabled: number } | undefined
    if (!model) throw new Error("模型别名不存在")
  }

  private updateAccountRow(account: TelegramAccount): void {
    this.database.prepare(`UPDATE telegram_accounts SET
      name=?,enabled=?,status=?,status_message=?,credentials=?,bot_username=?,updated_at=? WHERE id=?`).run(
      account.name, Number(account.enabled), account.status, account.statusMessage, JSON.stringify(account.credentials),
      account.botUsername, account.updatedAt, account.id,
    )
  }
}
