import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const teleproto = vi.hoisted(() => ({
  clients: [] as Array<{
    handlers: Array<{ handler: (event: unknown) => void; builder: unknown }>
    connect: ReturnType<typeof vi.fn>
    checkAuthorization: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
    forwardMessages: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock("teleproto", () => ({
  sessions: { StringSession: class StringSession {} },
  TelegramClient: class TelegramClient {
    handlers: Array<{ handler: (event: unknown) => void; builder: unknown }> = []
    connect = vi.fn(async () => undefined)
    checkAuthorization = vi.fn(async () => true)
    disconnect = vi.fn(async () => undefined)
    sendMessage = vi.fn(async () => ({ id: 900 }))
    forwardMessages = vi.fn(async () => [{ id: 901 }, { id: 902 }])

    constructor() {
      teleproto.clients.push(this)
    }

    addEventHandler(handler: (event: unknown) => void, builder: unknown): void {
      this.handlers.push({ handler, builder })
    }
  },
}))

import { RuntimeDatabase } from "../../src/runtime/database.js"
import type { RuntimeGroup, TelegramAccount } from "../../src/runtime/types.js"
import { TelegramRuntime } from "../../src/telegram/runtime.js"

const directories: string[] = []
const databases: RuntimeDatabase[] = []
const runtimes: TelegramRuntime[] = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()))
  teleproto.clients.splice(0)
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-runtime-learning-"))
  directories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  databases.push(database)
  const timestamp = "2026-08-12T00:00:00.000Z"
  const account: TelegramAccount = {
    id: randomUUID(),
    name: "个人客服号",
    type: "user",
    enabled: true,
    status: "ready",
    statusMessage: "",
    credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
    botUsername: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  database.insertAccount(account)
  const group: RuntimeGroup = {
    id: randomUUID(),
    key: "support",
    name: "客服群",
    telegramChatId: "-10001",
    accountId: account.id,
    projectId: null,
    serviceId: null,
    enabled: true,
    accessMode: "user",
    triggerMode: "all",
    platform: "telegram",
    repositories: [],
    branch: null,
    serverAlias: null,
    databaseAlias: "database",
    knowledgeScope: "default",
    purpose: "support",
    aiModelInstanceId: null,
    replyStyle: "human",
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  database.insertGroup(group)
  const accept = vi.fn((_event: {
    senderId: string
    replyToMessageId: string | null
    replyTargetIsBot: boolean
    accountOwnerOutgoing?: boolean
  }) => null)
  const runtime = new TelegramRuntime(
    database,
    {
      getAccountCredentials: () => ({ apiId: "1", apiHash: "hash", session: "session" }),
      getAccount: () => account,
      listAccounts: () => [account],
    } as never,
    { getSettings: () => ({ telegramEnabled: true }) } as never,
    { accept, enrichAttachments: vi.fn(), start: vi.fn(), stop: vi.fn(async () => undefined) } as never,
    { describe: vi.fn(), prepare: vi.fn() } as never,
  )
  runtimes.push(runtime)
  await (runtime as unknown as { connectUser(accountId: string): Promise<void> }).connectUser(account.id)
  const client = teleproto.clients[0]!
  return { database, account, group, runtime, accept, client }
}

async function createBotHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "telegram-runtime-identity-"))
  directories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "support.sqlite"))
  databases.push(database)
  const timestamp = "2026-08-12T00:00:00.000Z"
  const account: TelegramAccount = {
    id: randomUUID(),
    name: "客服机器人",
    type: "bot",
    enabled: true,
    status: "ready",
    statusMessage: "",
    credentials: { algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" },
    botUsername: "support_bot",
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  database.insertAccount(account)
  const projectId = randomUUID()
  const serviceId = randomUUID()
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "identity-project", "身份项目", "", 1, "default", timestamp, timestamp)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "identity-service", "身份服务", "", "Asia/Shanghai", null, "main", 1, timestamp, timestamp,
  )
  const group: RuntimeGroup = {
    id: randomUUID(),
    key: "bot-support",
    name: "机器人客服群",
    telegramChatId: "-10002",
    accountId: account.id,
    projectId,
    serviceId,
    enabled: true,
    accessMode: "bot",
    triggerMode: "all",
    platform: "telegram",
    repositories: [],
    branch: null,
    serverAlias: null,
    databaseAlias: "database",
    knowledgeScope: "default",
    purpose: "support",
    aiModelInstanceId: null,
    replyStyle: "human",
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  database.insertGroup(group)
  const fetcher = vi.fn(async (
    _url: string | URL | Request,
    _request?: RequestInit,
  ): Promise<{ ok: boolean; json(): Promise<unknown> }> => ({
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 701 } }),
  }))
  const runtime = new TelegramRuntime(
    database,
    {
      getAccountCredentials: () => ({ botToken: "test-token" }),
      getAccount: () => account,
      listAccounts: () => [account],
    } as never,
    { getSettings: () => ({ telegramEnabled: true }) } as never,
    { accept: vi.fn(), enrichAttachments: vi.fn(), start: vi.fn(), stop: vi.fn(async () => undefined) } as never,
    { describe: vi.fn(), prepare: vi.fn() } as never,
    fetcher as never,
  )
  runtimes.push(runtime)
  return { database, account, group, serviceId, runtime, fetcher }
}

function userEvent(input: { id: number; senderId: string; outgoing: boolean; text: string; replyToMessageId?: number }) {
  return {
    message: {
      id: input.id,
      out: input.outgoing,
      chatId: { toString: () => "-10001" },
      senderId: { toString: () => input.senderId },
      sender: { username: `user_${input.senderId}`, firstName: "客服", lastName: "人员", bot: false },
      text: input.text,
      file: null,
      replyToMsgId: input.replyToMessageId,
      replyTo: null,
      groupedId: undefined,
      date: undefined,
    },
  }
}

describe("Telegram 个人账号可信人工来源", () => {
  it("Bot 使用 Telegram 原生批量转发接口而不是重新发送文本", async () => {
    const harness = await createBotHarness()
    harness.fetcher.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: [{ message_id: 801 }, { message_id: 802 }] }),
    })

    await expect(harness.runtime.forwardMessages(
      harness.account.id,
      "-10003",
      harness.group.telegramChatId!,
      ["301", "302"],
      { groupId: harness.group.id, serviceId: harness.serviceId, kind: "technical_alert:escalation" },
    )).resolves.toEqual(["801", "802"])

    const [url, request] = harness.fetcher.mock.calls[0]!
    expect(String(url)).toContain("/forwardMessages")
    expect(JSON.parse(String((request as { body: string }).body))).toEqual({
      chat_id: "-10003",
      from_chat_id: harness.group.telegramChatId,
      message_ids: [301, 302],
    })
  })

  it("同时订阅 incoming 与 outgoing，当前账号手工 outgoing 和其他人工 incoming 都进入处理器", async () => {
    const harness = await createHarness()
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    expect(subscription.builder).toMatchObject({ incoming: undefined, outgoing: undefined })

    subscription.handler(userEvent({ id: 101, senderId: "20001", outgoing: false, text: "其他人工回复" }))
    subscription.handler(userEvent({ id: 102, senderId: "20002", outgoing: true, text: "当前账号手工回复" }))
    await vi.waitFor(() => expect(harness.accept).toHaveBeenCalledTimes(2))
    expect(harness.accept.mock.calls.map(([event]) => event.senderId)).toEqual(["20001", "20002"])
    expect(harness.accept.mock.calls.map(([event]) => event.accountOwnerOutgoing)).toEqual([false, true])
  })

  it("持久 registry 中精确 account chat message-id 所有权排除应用自产 outgoing", async () => {
    const harness = await createHarness()
    const timestamp = "2026-08-12T00:00:00.000Z"
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), harness.account.id, harness.group.id, "-10001", "103", null, null, null, null,
      "other", "sent", randomUUID(), "a".repeat(64), null, timestamp, timestamp,
    )
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    subscription.handler(userEvent({ id: 103, senderId: "20002", outgoing: true, text: "应用自产回复" }))
    await new Promise((resolve) => setImmediate(resolve))

    expect(harness.accept).not.toHaveBeenCalled()
  })

  it("所有发送先持久 claim，成功后完成 message-id ownership 并排除回流事件", async () => {
    const harness = await createHarness()
    harness.client.sendMessage.mockResolvedValueOnce({ id: 104 })

    const messageId = await (harness.runtime as unknown as {
      sendMessage(
        accountId: string,
        chatId: string,
        text: string,
        replyTo?: string,
        quote?: string | null,
        ownership?: { groupId: string; kind: string },
      ): Promise<string>
    }).sendMessage(
      harness.account.id,
      "-10001",
      "应用统一发送",
      undefined,
      null,
      { groupId: harness.group.id, kind: "support_reply" },
    )

    expect(messageId).toBe("104")
    expect(harness.database.prepare(`SELECT delivery_group_id,telegram_message_id,output_kind,delivery_status
      FROM telegram_output_ownership`).all()).toEqual([{
      delivery_group_id: harness.group.id,
      telegram_message_id: "104",
      output_kind: "support_reply",
      delivery_status: "sent",
    }])

    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!
    subscription.handler(userEvent({ id: 104, senderId: "20002", outgoing: true, text: "应用统一发送" }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.accept).not.toHaveBeenCalled()
  })

  it("个人客服号发送成功回包缺少 message-id 时按未知结果收口且不写入 undefined", async () => {
    const harness = await createHarness()
    harness.client.sendMessage.mockResolvedValueOnce({ id: undefined })

    await expect(harness.runtime.sendMessage(
      harness.account.id,
      "-10001",
      "回包缺少消息编号",
      undefined,
      null,
      { groupId: harness.group.id, kind: "support_reply" },
    )).rejects.toMatchObject({ type: "unknown", state: "uncertain" })

    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status
      FROM telegram_output_ownership`).get()).toEqual({
      telegram_message_id: null,
      delivery_status: "unknown",
    })
  })

  it("Bot 发送成功回包的 message-id 格式错误时按未知结果收口", async () => {
    const harness = await createBotHarness()
    harness.fetcher.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: "undefined" } }),
    })

    await expect(harness.runtime.sendMessage(
      harness.account.id,
      "-10002",
      "Bot 回包消息编号异常",
      undefined,
      null,
      { groupId: harness.group.id, kind: "support_reply" },
    )).rejects.toMatchObject({ type: "unknown", state: "uncertain" })

    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status
      FROM telegram_output_ownership`).get()).toEqual({
      telegram_message_id: null,
      delivery_status: "unknown",
    })
  })

  it("发送回包前 outgoing 事件只等待持久 pending 候选，RPC 返回后按精确 message-id 排除", async () => {
    const harness = await createHarness()
    let completeSend!: (message: { id: number }) => void
    harness.client.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { completeSend = resolve }))

    const sending = (harness.runtime as unknown as {
      sendMessage(
        accountId: string,
        chatId: string,
        text: string,
        replyTo?: string,
        quote?: string | null,
        ownership?: { groupId: string; kind: string },
      ): Promise<string>
    }).sendMessage(
      harness.account.id,
      "-10001",
      "回包前应用输出",
      "77",
      null,
      { groupId: harness.group.id, kind: "progress" },
    )
    await Promise.resolve()
    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status FROM telegram_output_ownership`).get())
      .toEqual({ telegram_message_id: null, delivery_status: "sending" })

    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!
    subscription.handler({
      ...userEvent({ id: 105, senderId: "20002", outgoing: true, text: "回包前应用输出" }),
      message: {
        ...userEvent({ id: 105, senderId: "20002", outgoing: true, text: "回包前应用输出" }).message,
        replyToMsgId: 77,
      },
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(harness.accept).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status FROM telegram_output_ownership`).get())
      .toEqual({ telegram_message_id: null, delivery_status: "sending" })
    completeSend({ id: 105 })
    await expect(sending).resolves.toBe("105")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.accept).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status FROM telegram_output_ownership`).get())
      .toEqual({ telegram_message_id: "105", delivery_status: "sent" })
  })

  it("同文同回复目标的手工 outgoing 等待 RPC 精确 message-id 后仍进入处理器", async () => {
    const harness = await createHarness()
    let completeSend!: (message: { id: number }) => void
    harness.client.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { completeSend = resolve }))
    const sending = harness.runtime.sendMessage(
      harness.account.id,
      "-10001",
      "相同文本",
      "77",
      null,
      { groupId: harness.group.id, kind: "progress" },
    )
    await Promise.resolve()
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    subscription.handler(userEvent({
      id: 106,
      senderId: "20002",
      outgoing: true,
      text: "相同文本",
      replyToMessageId: 77,
    }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.accept).not.toHaveBeenCalled()

    completeSend({ id: 105 })
    await expect(sending).resolves.toBe("105")
    await vi.waitFor(() => expect(harness.accept).toHaveBeenCalledTimes(1))
    expect(harness.accept).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "106",
      replyToMessageId: "77",
      accountOwnerOutgoing: true,
    }))

    subscription.handler(userEvent({
      id: 105,
      senderId: "20002",
      outgoing: true,
      text: "相同文本",
      replyToMessageId: 77,
    }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.accept).toHaveBeenCalledTimes(1)
  })

  it("个人客服号成组转发原消息并为每条输出记录所有权", async () => {
    const harness = await createHarness()

    await expect(harness.runtime.forwardMessages(
      harness.account.id,
      "-10002",
      harness.group.telegramChatId!,
      ["201", "202"],
      { groupId: harness.group.id, kind: "technical_alert:escalation" },
    )).resolves.toEqual(["901", "902"])

    expect(harness.client.forwardMessages).toHaveBeenCalledWith("-10002", {
      messages: [201, 202],
      fromPeer: harness.group.telegramChatId,
    })
    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status,output_kind
      FROM telegram_output_ownership ORDER BY telegram_message_id`).all()).toEqual([
      { telegram_message_id: "901", delivery_status: "sent", output_kind: "technical_alert:escalation" },
      { telegram_message_id: "902", delivery_status: "sent", output_kind: "technical_alert:escalation" },
    ])
  })

  it("成组转发任一回包缺少 message-id 时整组按未知结果收口", async () => {
    const harness = await createHarness()
    harness.client.forwardMessages.mockResolvedValueOnce([{ id: 901 }, { id: undefined }])

    await expect(harness.runtime.forwardMessages(
      harness.account.id,
      "-10002",
      harness.group.telegramChatId!,
      ["201", "202"],
      { groupId: harness.group.id, kind: "technical_alert:escalation" },
    )).rejects.toMatchObject({ type: "unknown", state: "uncertain" })

    expect(harness.database.prepare(`SELECT telegram_message_id,delivery_status
      FROM telegram_output_ownership ORDER BY created_at,id`).all()).toEqual([
      { telegram_message_id: null, delivery_status: "unknown" },
      { telegram_message_id: null, delivery_status: "unknown" },
    ])
  })

  it("疑似应用 outgoing 先到而 RPC 结果 uncertain 时持久 quarantine 且绝不进入人工学习", async () => {
    const harness = await createHarness()
    let rejectSend!: (error: Error) => void
    harness.client.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject }))
    const sending = harness.runtime.sendMessage(
      harness.account.id,
      "-10001",
      "结果未知的应用输出",
      "77",
      null,
      { groupId: harness.group.id, kind: "progress" },
    )
    await Promise.resolve()
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!
    subscription.handler(userEvent({
      id: 107,
      senderId: "20002",
      outgoing: true,
      text: "结果未知的应用输出",
      replyToMessageId: 77,
    }))
    await new Promise((resolve) => setImmediate(resolve))

    rejectSend(new Error("network result unknown"))
    await expect(sending).rejects.toBeInstanceOf(Error)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(harness.accept).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT candidate.telegram_message_id,candidate.resolution_status,
      ownership.delivery_status FROM telegram_outgoing_candidates candidate
      JOIN telegram_output_ownership ownership ON ownership.id=candidate.ownership_id`).get()).toEqual({
      telegram_message_id: "107",
      resolution_status: "unknown",
      delivery_status: "unknown",
    })
  })

  it("RPC 先 uncertain 后应用 outgoing 才到仍进入持久 quarantine", async () => {
    const harness = await createHarness()
    harness.client.sendMessage.mockRejectedValueOnce(new Error("network result unknown"))
    await expect(harness.runtime.sendMessage(
      harness.account.id,
      "-10001",
      "RPC 失败后才回流",
      "77",
      null,
      { groupId: harness.group.id, kind: "progress" },
    )).rejects.toBeInstanceOf(Error)
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    subscription.handler(userEvent({
      id: 111,
      senderId: "20002",
      outgoing: true,
      text: "RPC 失败后才回流",
      replyToMessageId: 77,
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(harness.accept).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT candidate.resolution_status,ownership.delivery_status
      FROM telegram_outgoing_candidates candidate JOIN telegram_output_ownership ownership
        ON ownership.id=candidate.ownership_id`).get()).toEqual({
      resolution_status: "unknown",
      delivery_status: "unknown",
    })
  })

  it("跨小时重启后早于 outgoing 十分零一秒的 unknown fingerprint 仍持久 quarantine", async () => {
    const harness = await createHarness()
    const ownershipAt = "2026-08-12T00:49:59.000Z"
    const eventAt = "2026-08-12T01:00:00.000Z"
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), harness.account.id, harness.group.id, "-10001", null, null, null, null, null,
      "progress", "unknown", randomUUID(), createHash("sha256").update("跨小时未决应用输出").digest("hex"), "77",
      ownershipAt, ownershipAt,
    )
    harness.runtime.start()
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    subscription.handler({
      ...userEvent({
        id: 113,
        senderId: "20002",
        outgoing: true,
        text: "跨小时未决应用输出",
        replyToMessageId: 77,
      }),
      message: {
        ...userEvent({
          id: 113,
          senderId: "20002",
          outgoing: true,
          text: "跨小时未决应用输出",
          replyToMessageId: 77,
        }).message,
        date: Date.parse(eventAt) / 1000,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(harness.accept).not.toHaveBeenCalled()
    expect(harness.database.prepare(`SELECT resolution_status FROM telegram_outgoing_candidates
      WHERE telegram_message_id='113'`).all()).toEqual([{ resolution_status: "unknown" }])
  })

  it("疑似应用 outgoing 不按固定 resolver deadline 自动放行为人工", async () => {
    vi.useFakeTimers()
    try {
      const harness = await createHarness()
      let rejectSend!: (error: Error) => void
      harness.client.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject }))
      const sending = harness.runtime.sendMessage(
        harness.account.id,
        "-10001",
        "长时间未决应用输出",
        "77",
        null,
        { groupId: harness.group.id, kind: "progress" },
      )
      await Promise.resolve()
      const subscription = harness.client.handlers.find(({ builder }) => (
        typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
      ))!
      subscription.handler(userEvent({
        id: 108,
        senderId: "20002",
        outgoing: true,
        text: "长时间未决应用输出",
        replyToMessageId: 77,
      }))
      await vi.advanceTimersByTimeAsync(31_000)

      expect(harness.accept).not.toHaveBeenCalled()
      expect(harness.database.prepare("SELECT resolution_status FROM telegram_outgoing_candidates").get())
        .toEqual({ resolution_status: "pending" })

      rejectSend(new Error("network result unknown"))
      await expect(sending).rejects.toBeInstanceOf(Error)
      await vi.advanceTimersByTimeAsync(20)
      expect(harness.accept).not.toHaveBeenCalled()
      expect(harness.database.prepare("SELECT resolution_status FROM telegram_outgoing_candidates").get())
        .toEqual({ resolution_status: "unknown" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("runtime 重启把遗留 sending 恢复为 unknown 而不是永久占用 in-flight", async () => {
    const harness = await createHarness()
    const timestamp = "2026-08-12T00:00:00.000Z"
    const ownershipId = randomUUID()
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ownershipId, harness.account.id, harness.group.id, "-10001", null, null, null, null, null,
      "progress", "sending", randomUUID(), "b".repeat(64), null, timestamp, timestamp,
    )
    harness.database.prepare(`INSERT INTO telegram_outgoing_candidates(
      id,ownership_id,telegram_message_id,resolution_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)`).run(randomUUID(), ownershipId, "108", "pending", timestamp, timestamp)

    harness.runtime.start()

    expect(harness.database.prepare("SELECT delivery_status FROM telegram_output_ownership").get())
      .toEqual({ delivery_status: "unknown" })
    expect(harness.database.prepare("SELECT resolution_status FROM telegram_outgoing_candidates").get())
      .toEqual({ resolution_status: "unknown" })
  })

  it("runtime 重启后无预建 candidate 的应用 outgoing 补发也 fail closed", async () => {
    const harness = await createHarness()
    const timestamp = new Date().toISOString()
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), harness.account.id, harness.group.id, "-10001", null, null, null, null, null,
      "progress", "sending", randomUUID(), createHash("sha256").update("重启后才补发").digest("hex"), "77", timestamp, timestamp,
    )
    harness.runtime.start()
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    subscription.handler(userEvent({
      id: 112,
      senderId: "20002",
      outgoing: true,
      text: "重启后才补发",
      replyToMessageId: 77,
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(harness.accept).not.toHaveBeenCalled()
    expect(harness.database.prepare("SELECT resolution_status FROM telegram_outgoing_candidates").get())
      .toEqual({ resolution_status: "unknown" })
  })

  it("人工直接回复 progress ownership 时 replyTargetIsBot 使用统一反向关联", async () => {
    const harness = await createHarness()
    const timestamp = "2026-08-12T00:00:00.000Z"
    harness.database.prepare(`INSERT INTO telegram_output_ownership(
      id,account_id,delivery_group_id,telegram_chat_id,telegram_message_id,thread_id,service_id,reply_id,
      notification_id,output_kind,delivery_status,request_key,content_sha256,reply_to_message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), harness.account.id, harness.group.id, "-10001", "109", null, null, null, null,
      "progress", "sent", randomUUID(), "d".repeat(64), null, timestamp, timestamp,
    )
    const subscription = harness.client.handlers.find(({ builder }) => (
      typeof builder === "object" && builder !== null && "incoming" in builder && "outgoing" in builder
    ))!

    subscription.handler(userEvent({
      id: 110,
      senderId: "20001",
      outgoing: false,
      text: "人工接手",
      replyToMessageId: 109,
    }))
    await vi.waitFor(() => expect(harness.accept).toHaveBeenCalledTimes(1))

    expect(harness.accept.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      replyToMessageId: "109",
      replyTargetIsBot: true,
    }))
  })

  it("identity command 也经统一 sender 持久登记 ownership", async () => {
    const harness = await createBotHarness()

    await (harness.runtime as unknown as {
      handleBotMessage(accountId: string, message: unknown): Promise<void>
    }).handleBotMessage(harness.account.id, {
      message_id: 700,
      chat: { id: -10002, type: "supergroup" },
      from: { id: 20001, is_bot: false, first_name: "人工" },
      text: "/start",
    })

    expect(harness.fetcher).toHaveBeenCalledTimes(1)
    expect(harness.database.prepare(`SELECT delivery_group_id,service_id,telegram_message_id,output_kind,delivery_status
      FROM telegram_output_ownership`).all()).toEqual([{
      delivery_group_id: harness.group.id,
      service_id: harness.serviceId,
      telegram_message_id: "701",
      output_kind: "identity",
      delivery_status: "sent",
    }])
  })
})
