import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { RuntimeDatabase } from "../../src/runtime/database.js"
import { TelegramRuntime } from "../../src/telegram/runtime.js"

const directories: string[] = []
const databases: RuntimeDatabase[] = []

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-user-cursor-"))
  directories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  databases.push(database)
  const now = new Date().toISOString()
  const projectId = randomUUID()
  const serviceId = randomUUID()
  const accountId = randomUUID()
  const groupId = randomUUID()
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(projectId, `project-${projectId}`, "项目", "", 1, "default", now, now)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, `service-${serviceId}`, "服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  database.prepare(`INSERT INTO telegram_accounts(
    id,name,type,enabled,status,status_message,credentials,created_at,updated_at
  ) VALUES(?,?,'user',1,'ready','','{}',?,?)`).run(accountId, "个人客服号", now, now)
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, `group-${groupId}`, "NexaPay 客服群", "-10001", accountId, projectId, serviceId, 1,
    "user", "all", "telegram", "[]", null, null, "database", "default", "support", now, now,
  )
  return { database, accountId, groupId }
}

function userMessage(id: number, text: string) {
  return {
    id,
    chatId: -10001,
    out: false,
    text,
    senderId: 7001,
    sender: { username: "operator", firstName: "运营" },
    replyToMsgId: undefined,
    replyTo: undefined,
    groupedId: undefined,
    file: undefined,
    date: 1_788_192_000,
  }
}

function createRuntime(database: RuntimeDatabase, accepted: string[]) {
  return new TelegramRuntime(
    database,
    { getAccountCredentials: vi.fn(), listAccounts: vi.fn(() => []) } as never,
    { getSettings: vi.fn(() => ({ telegramEnabled: true })) } as never,
    {
      accept: vi.fn((input: { messageId: string }) => { accepted.push(input.messageId); return null }),
      start: vi.fn(), stop: vi.fn(), enrichAttachments: vi.fn(),
    } as never,
    { describe: vi.fn(), prepare: vi.fn() } as never,
  )
}

type CursorRuntime = {
  running: boolean
  userClients: Map<string, unknown>
  userHistoryCatchupRequired: Set<string>
  syncNextUserGroup(accountId: string, client: unknown): Promise<void>
  handleUserMessage(accountId: string, event: { message: ReturnType<typeof userMessage> }): Promise<void>
}

describe("个人客服号 Telegram 持久消息游标", () => {
  it("首次只建立当前游标，重启后补拉断线期间的新消息且不重放历史", async () => {
    const { database, accountId, groupId } = await createDatabase()
    const accepted: string[] = []
    const runtime = createRuntime(database, accepted) as unknown as CursorRuntime
    const firstClient = {
      connected: true,
      getMessages: vi.fn(async () => [userMessage(100, "历史最新消息")]),
    }
    runtime.running = true
    runtime.userClients.set(accountId, firstClient)
    await runtime.syncNextUserGroup(accountId, firstClient)
    expect(accepted).toEqual([])
    expect(database.prepare(`SELECT telegram_chat_id,last_message_id FROM telegram_user_chat_cursors
      WHERE account_id=? AND group_id=?`).get(accountId, groupId)).toEqual({
      telegram_chat_id: "-10001", last_message_id: 100,
    })

    const restartedRuntime = createRuntime(database, accepted) as unknown as CursorRuntime
    const restartedClient = {
      connected: true,
      getMessages: vi.fn(async (_chatId: string, options: { offsetId?: number }) => {
        expect(options).toMatchObject({ offsetId: 100, reverse: true, limit: 200 })
        return [userMessage(101, "kefu005 重置一下谷歌验证")]
      }),
    }
    restartedRuntime.running = true
    restartedRuntime.userClients.set(accountId, restartedClient)
    restartedRuntime.userHistoryCatchupRequired.add(`${accountId}:${groupId}`)
    await restartedRuntime.handleUserMessage(accountId, { message: userMessage(105, "重连后先到的实时消息") })
    expect(database.prepare(`SELECT last_message_id FROM telegram_user_chat_cursors
      WHERE account_id=? AND group_id=?`).get(accountId, groupId)).toEqual({ last_message_id: 100 })
    await restartedRuntime.syncNextUserGroup(accountId, restartedClient)
    expect(accepted).toEqual(["105", "101"])
    expect(database.prepare(`SELECT last_message_id FROM telegram_user_chat_cursors
      WHERE account_id=? AND group_id=?`).get(accountId, groupId)).toEqual({ last_message_id: 101 })
  })
})
