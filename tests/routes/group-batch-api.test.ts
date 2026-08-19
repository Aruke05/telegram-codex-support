import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildApp } from "../../src/app.js"
import { RuntimeAdminService } from "../../src/runtime/admin-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { LocalSecretVault } from "../../src/runtime/secret-vault.js"

const timestamp = "2026-08-13T00:00:00.000Z"
const projectId = "00000000-0000-4000-8000-000000000101"
const serviceId = "00000000-0000-4000-8000-000000000102"
const modelId = "00000000-0000-4000-8000-000000000103"

const harnesses: Array<{
  directory: string
  database: RuntimeDatabase
  app: ReturnType<typeof buildApp>
}> = []

async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "group-batch-api-"))
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  const vault = await LocalSecretVault.open(path.join(directory, "master.key"))
  const admin = new RuntimeAdminService(database, vault)
  const app = buildApp({ runtimeAdminService: admin })

  database.prepare(`INSERT INTO projects(
    id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "default", timestamp, timestamp)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
  )
  database.prepare(`INSERT INTO model_instances(
    id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
    enabled,health_status,health_message,last_checked_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    modelId, "技术群模型", "openai", "codex_cli", "gpt-5", "high", "standard", "{}", null,
    1, "ready", "连接正常", timestamp, timestamp, timestamp,
  )

  const bot = await admin.createAccount({
    type: "bot",
    name: "客服 Bot",
    botToken: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    enabled: true,
  })
  const user = await admin.createAccount({
    type: "user",
    name: "个人客服",
    apiId: "123456",
    apiHash: "abcdefabcdefabcdefabcdefabcdefab",
    phone: "+8613800000000",
    session: "test-session",
    enabled: true,
  })

  const supportA = await admin.createGroup({
    key: "support-a", name: "客服一群", telegramChatId: "-100000000001", accountId: bot.id,
    projectId, serviceId, enabled: false, accessMode: "bot", triggerMode: "all", platform: "service",
    repositories: [], branch: null, serverAlias: null, databaseAlias: "database", knowledgeScope: "default",
    purpose: "support", aiModelInstanceId: null, replyStyle: "unrestricted",
  })
  const supportB = await admin.createGroup({
    key: "support-b", name: "客服二群", telegramChatId: "-100000000002", accountId: bot.id,
    projectId, serviceId, enabled: false, accessMode: "bot", triggerMode: "all", platform: "service",
    repositories: [], branch: null, serverAlias: null, databaseAlias: "database", knowledgeScope: "default",
    purpose: "support", aiModelInstanceId: null, replyStyle: "unrestricted",
  })
  const technical = await admin.createGroup({
    key: "technical", name: "技术告警群", telegramChatId: "-100000000003", accountId: bot.id,
    projectId: null, serviceId: null, enabled: false, accessMode: "bot", triggerMode: "command", platform: "internal",
    repositories: [], branch: null, serverAlias: null, databaseAlias: "none", knowledgeScope: "technical-alert",
    purpose: "technical_alert", aiModelInstanceId: modelId, replyStyle: "unrestricted",
  })

  const harness = { directory, database, app, admin, bot, user, supportA, supportB, technical }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ app, database, directory }) => {
    await app.close()
    database.close()
    await rm(directory, { recursive: true, force: true })
  }))
})

describe("白名单群批量更新 API", () => {
  it("原子批量开启客服群学习模式并持久化运行模式", async () => {
    const { app, database, supportA, supportB } = await createHarness()

    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id, supportB.id], patch: { operationMode: "learning" } },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: supportA.id, operationMode: "learning" }),
      expect.objectContaining({ id: supportB.id, operationMode: "learning" }),
    ]))
    expect(database.prepare("SELECT id,operation_mode FROM telegram_groups WHERE id IN (?,?) ORDER BY id")
      .all(supportA.id, supportB.id)).toEqual(expect.arrayContaining([
      { id: supportA.id, operation_mode: "learning" },
      { id: supportB.id, operation_mode: "learning" },
    ]))
  })

  it("批量学习模式混入技术告警群时整批回滚", async () => {
    const { app, database, supportA, technical } = await createHarness()

    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id, technical.id], patch: { operationMode: "learning" } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain("技术告警群不能开启学习模式")
    expect(database.prepare("SELECT id,operation_mode FROM telegram_groups WHERE id IN (?,?) ORDER BY id")
      .all(supportA.id, technical.id)).toEqual(expect.arrayContaining([
      { id: supportA.id, operation_mode: "live" },
      { id: technical.id, operation_mode: "live" },
    ]))
  })

  it("原子批量启停并返回持久化后的群状态", async () => {
    const { app, database, supportA, supportB } = await createHarness()

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id, supportB.id], patch: { enabled: true } },
    })

    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().groups).toEqual([
      expect.objectContaining({ id: supportA.id, enabled: true }),
      expect.objectContaining({ id: supportB.id, enabled: true }),
    ])
    expect(database.prepare("SELECT id,enabled FROM telegram_groups WHERE id IN (?,?) ORDER BY id").all(supportA.id, supportB.id))
      .toEqual([
        { id: [supportA.id, supportB.id].sort()[0], enabled: 1 },
        { id: [supportA.id, supportB.id].sort()[1], enabled: 1 },
      ])

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id, supportB.id], patch: { enabled: false } },
    })
    expect(disabled.statusCode).toBe(200)
    expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id IN (?,?) ORDER BY id").all(supportA.id, supportB.id))
      .toEqual([{ enabled: 0 }, { enabled: 0 }])
  })

  it("批量启停不重置未提交的学习模式和回复方式", async () => {
    const { app, admin, database, supportA } = await createHarness()
    await admin.updateGroup(supportA.id, { operationMode: "learning", replyStyle: "human" })

    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id], patch: { enabled: true } },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().groups[0]).toMatchObject({
      id: supportA.id,
      enabled: true,
      operationMode: "learning",
      replyStyle: "human",
    })
    expect(database.prepare("SELECT enabled,operation_mode,reply_style FROM telegram_groups WHERE id=?").get(supportA.id))
      .toEqual({ enabled: 1, operation_mode: "learning", reply_style: "human" })
  })

  it("批量修改接入和回复方式但保留归属用途模型与触发规则", async () => {
    const { app, database, user, supportA, technical } = await createHarness()
    const before = database.prepare(`SELECT id,project_id,service_id,purpose,ai_model_instance_id,trigger_mode
      FROM telegram_groups WHERE id IN (?,?) ORDER BY id`).all(supportA.id, technical.id)

    const supportChanged = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: {
        ids: [supportA.id],
        patch: { accessMode: "user", accountId: user.id, replyStyle: "human" },
      },
    })
    const mixedReplyStyle = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id, technical.id], patch: { replyStyle: "human" } },
    })

    expect(supportChanged.statusCode).toBe(200)
    expect(supportChanged.json().groups[0]).toMatchObject({
      id: supportA.id, accessMode: "user", accountId: user.id, replyStyle: "human", triggerMode: "all",
    })
    expect(mixedReplyStyle.statusCode).toBe(200)
    expect(database.prepare(`SELECT id,project_id,service_id,purpose,ai_model_instance_id,trigger_mode
      FROM telegram_groups WHERE id IN (?,?) ORDER BY id`).all(supportA.id, technical.id)).toEqual(before)
  })

  it("任一群无效时整批回滚并指出失败群", async () => {
    const { app, admin, database, supportA, supportB } = await createHarness()
    await admin.updateGroup(supportB.id, { accountId: null })

    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id, supportB.id], patch: { enabled: true } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain("客服二群")
    expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id IN (?,?) ORDER BY id").all(supportA.id, supportB.id))
      .toEqual([{ enabled: 0 }, { enabled: 0 }])
  })

  it("未填写群 ID 的草稿群仍可批量停用和修改非启用配置", async () => {
    const { app, database, supportA } = await createHarness()
    database.prepare("UPDATE telegram_groups SET telegram_chat_id=NULL WHERE id=?").run(supportA.id)

    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id], patch: { enabled: false, replyStyle: "human" } },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().groups[0]).toMatchObject({
      id: supportA.id,
      telegramChatId: null,
      enabled: false,
      replyStyle: "human",
    })
  })

  it("未填写群 ID 的草稿群可以通过单群编辑保存其他配置", async () => {
    const { app, database, supportA } = await createHarness()
    database.prepare("UPDATE telegram_groups SET telegram_chat_id=NULL WHERE id=?").run(supportA.id)

    const response = await app.inject({
      method: "PATCH",
      url: `/api/telegram/groups/${supportA.id}`,
      payload: { telegramChatId: null, enabled: false, replyStyle: "human" },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: supportA.id,
      telegramChatId: null,
      enabled: false,
      replyStyle: "human",
    })
    expect(database.prepare("SELECT telegram_chat_id,enabled,reply_style FROM telegram_groups WHERE id=?").get(supportA.id))
      .toEqual({ telegram_chat_id: null, enabled: 0, reply_style: "human" })
  })

  it("停用群可以清空群 ID 且启用群不能清空", async () => {
    const { app, database, supportA } = await createHarness()

    const clearDisabled = await app.inject({
      method: "PATCH",
      url: `/api/telegram/groups/${supportA.id}`,
      payload: { telegramChatId: null, enabled: false },
    })
    expect(clearDisabled.statusCode).toBe(200)
    expect(database.prepare("SELECT telegram_chat_id,enabled FROM telegram_groups WHERE id=?").get(supportA.id))
      .toEqual({ telegram_chat_id: null, enabled: 0 })

    database.prepare("UPDATE telegram_groups SET telegram_chat_id='-100000000001',enabled=1 WHERE id=?").run(supportA.id)
    const clearEnabled = await app.inject({
      method: "PATCH",
      url: `/api/telegram/groups/${supportA.id}`,
      payload: { telegramChatId: null },
    })
    expect(clearEnabled.statusCode).toBe(400)
    expect(database.prepare("SELECT telegram_chat_id,enabled FROM telegram_groups WHERE id=?").get(supportA.id))
      .toEqual({ telegram_chat_id: "-100000000001", enabled: 1 })
  })

  it("新增停用群仍拒绝空群 ID", async () => {
    const { app, bot } = await createHarness()
    const response = await app.inject({
      method: "POST",
      url: "/api/telegram/groups",
      payload: {
        key: "new-draft", name: "新增草稿", telegramChatId: null, accountId: bot.id,
        projectId, serviceId, enabled: false, accessMode: "bot", triggerMode: "all", platform: "service",
        repositories: [], branch: null, serverAlias: null, databaseAlias: "database", knowledgeScope: "default",
        purpose: "support", aiModelInstanceId: null, replyStyle: "unrestricted",
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it("停用客服账号时仍会联动停用已启用群", async () => {
    const { admin, bot, database, supportA } = await createHarness()
    await admin.updateGroup(supportA.id, { enabled: true })

    await admin.updateAccount(bot.id, { enabled: false })

    expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id=?").get(supportA.id))
      .toEqual({ enabled: 0 })
  })

  it("批量启用未填写群 ID 的草稿群时返回明确中文原因", async () => {
    const { app, database, supportA } = await createHarness()
    database.prepare("UPDATE telegram_groups SET telegram_chat_id=NULL WHERE id=?").run(supportA.id)

    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: { ids: [supportA.id], patch: { enabled: true } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "客服一群：启用群必须填写群 ID" })
    expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id=?").get(supportA.id)).toEqual({ enabled: 0 })
  })

  it.each([
    { name: "空补丁", payload: { ids: ["00000000-0000-4000-8000-000000000001"], patch: {} } },
    { name: "重复群 ID", payload: { ids: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"], patch: { enabled: true } } },
    { name: "未知字段", payload: { ids: ["00000000-0000-4000-8000-000000000001"], patch: { enabled: true, purpose: "support" } } },
  ])("拒绝$name", async ({ payload }) => {
    const { app } = await createHarness()
    const response = await app.inject({ method: "PATCH", url: "/api/telegram/groups", payload })
    expect(response.statusCode).toBe(400)
  })

  it("拒绝不存在的群且不修改其他群", async () => {
    const { app, database, supportA } = await createHarness()
    const response = await app.inject({
      method: "PATCH",
      url: "/api/telegram/groups",
      payload: {
        ids: [supportA.id, "00000000-0000-4000-8000-000000000999"],
        patch: { enabled: true },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(database.prepare("SELECT enabled FROM telegram_groups WHERE id=?").get(supportA.id)).toEqual({ enabled: 0 })
  })
})
