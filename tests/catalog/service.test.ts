import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { findEnabledGroupByChatId, loadGroupCatalog } from "../../src/catalog/service.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("Telegram 群目录", () => {
  it("初始目录只包含13个禁用的客服群且完全排除Peakpay", async () => {
    const catalog = await loadGroupCatalog("config/telegram-groups.json")

    expect(catalog.groups).toHaveLength(13)
    expect(catalog.groups.some((group) => group.name === "技术部")).toBe(false)
    expect(catalog.groups.some((group) => group.platform === "peakpay")).toBe(false)
    expect(catalog.groups.every((group) => group.telegramChatId === null && !group.enabled)).toBe(true)
    expect(catalog.technicalAlertGroup).toEqual({ name: "技术部", telegramChatId: null })
  })

  it("MCBPAY消息只会使用prod-pkr分支", async () => {
    const catalog = await loadGroupCatalog("config/telegram-groups.json")
    const mcbpay = catalog.groups.find((group) => group.key === "mcbpay")

    expect(mcbpay).toMatchObject({ platform: "mcbpay", branch: "prod-pkr", serverAlias: "pkr" })
  })

  it("禁用群和未知chat_id都不会匹配", async () => {
    const catalog = await loadGroupCatalog("config/telegram-groups.json")

    expect(findEnabledGroupByChatId(catalog, "-100123")).toBeNull()
    expect(findEnabledGroupByChatId(catalog, "")).toBeNull()
  })

  it("拒绝重复的非空chat_id", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tg-catalog-"))
    temporaryDirectories.push(directory)
    const raw = JSON.parse(await readFile("config/telegram-groups.json", "utf8")) as {
      groups: Array<{ telegramChatId: string | null; enabled: boolean }>
    }
    raw.groups[0]!.telegramChatId = "-100123"
    raw.groups[0]!.enabled = true
    raw.groups[1]!.telegramChatId = "-100123"
    raw.groups[1]!.enabled = true
    const file = path.join(directory, "groups.json")
    await writeFile(file, JSON.stringify(raw), "utf8")

    await expect(loadGroupCatalog(file)).rejects.toThrow("telegramChatId 不能重复")
  })
})
