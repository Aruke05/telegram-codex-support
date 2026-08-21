import { resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { buildApp } from "../src/app.js"
import { createApiClient } from "../web/src/api.js"
import { directiveDeleteConfirmation } from "../web/src/directive-presentation.js"
import { shortHash } from "../web/src/format.js"
import { normalizeRoute } from "../web/src/router.js"
import { AppStore } from "../web/src/store.js"
import type { GroupCatalogResponse, HealthStatus, MagicBookStatus, TelegramRole } from "../web/src/types.js"
import { filterGroups } from "../web/src/group-filter.js"
import { normalizeThemePreference } from "../web/src/theme.js"
import { filterOptions } from "../web/src/option-filter.js"
import { optionalTelegramChatId, validateGroupForm } from "../web/src/group-form.js"
import { sensitiveCategoryLabel } from "../web/src/security-labels.js"
import { learningObservationFacts, roleLearningSourceLabel } from "../web/src/learning-source-labels.js"
import {
  accountOptions,
  allGroupsSelected,
  buildBatchGroupPatch,
  groupBatchActionBlocked,
  partitionGroupsForEnable,
  performGroupQuickToggle,
  selectedGroups,
  sharedAccessMode,
} from "../web/src/group-batch.js"
import type { TelegramAccount, TelegramGroup } from "../web/src/types.js"

describe("人工规则删除前端契约", () => {
  it("使用精确规则 ID 和后台操作者发送删除请求", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const client = createApiClient(fetcher as typeof fetch)

    await client.deleteDirective("rule/id")

    expect(fetcher).toHaveBeenCalledWith("/api/directives/rule%2Fid", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ actor: "后台管理员" }),
    }))
  })

  it("确认文案包含精确标题和不可恢复提示", () => {
    expect(directiveDeleteConfirmation("TataPay 本次代理返佣异常临时处理")).toEqual({
      title: "删除 TataPay 本次代理返佣异常临时处理",
      warning: "删除后不能恢复，已有历史证据和删除审计仍会保留。",
    })
  })
})

describe("学习报告续跑前端契约", () => {
  it("使用精确报告 ID 请求继续生成", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "report/id", status: "completed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    const client = createApiClient(fetcher as typeof fetch)

    await client.retryLearningReport("report/id")

    expect(fetcher).toHaveBeenCalledWith("/api/learning-reports/report%2Fid/retry", expect.objectContaining({
      method: "POST",
    }))
  })
})

describe("GET /health", () => {
  const apps: Array<ReturnType<typeof buildApp>> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it("服务存活时只返回固定安全状态", async () => {
    const app = buildApp()
    apps.push(app)

    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: "ok",
      service: "telegram-codex-support",
      version: "2.2.2",
      schemaVersion: 31,
    })
    expect(response.body).not.toContain("TOKEN")
  })

  it("只用本机静态资源提供安全管理页面", async () => {
    const app = buildApp({ adminUiRoot: resolve("web") })
    apps.push(app)

    const response = await app.inject({ method: "GET", url: "/" })

    expect(response.statusCode).toBe(200)
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'")
    expect(response.body).toContain("AI 客服控制台")
    expect(response.body).not.toMatch(/token|password|chatId/i)
  })
})

describe("管理后台基础状态", () => {
  it("只接受五个固定页面路由", () => {
    expect(normalizeRoute("#/groups")).toBe("groups")
    expect(normalizeRoute("#security")).toBe("security")
    expect(normalizeRoute("#/unknown")).toBe("overview")
    expect(normalizeRoute("")).toBe("overview")
  })

  it("知识哈希只显示八位安全摘要", () => {
    expect(shortHash("1234567890abcdef")).toBe("12345678")
    expect(shortHash("")).toBe("—")
  })

  it("概览数据只加载一次且允许强制刷新", async () => {
    const health: HealthStatus = {
      status: "ok",
      service: "telegram-codex-support",
      version: "2.1.0",
      schemaVersion: 25,
    }
    const groups: GroupCatalogResponse = {
      version: 1,
      technicalAlertGroup: { name: "技术部", configured: false },
      groups: [],
    }
    const magicBook: MagicBookStatus = {
      sourceVersion: "safe-v1",
      importedAt: "2026-08-09T00:00:00.000Z",
      contentHash: "1234567890abcdef",
      serviceCount: 13,
      services: [],
      regionCount: 7,
      promptFallback: { enabled: false, mode: "按需" },
    }
    let calls = 0
    const store = new AppStore({
      getHealth: async () => { calls += 1; return health },
      getGroups: async () => groups,
      getMagicBookStatus: async () => magicBook,
    }, () => new Date("2026-08-09T01:02:03.000Z"))

    const first = await store.loadOverview()
    const cached = await store.loadOverview()
    const refreshed = await store.loadOverview(true)

    expect(first).toEqual({ health, groups, magicBook, loadedAt: "2026-08-09T01:02:03.000Z" })
    expect(cached).toBe(first)
    expect(refreshed).not.toBe(first)
    expect(calls).toBe(2)
  })

  it("未知主题值自动跟随系统", () => {
    expect(normalizeThemePreference("dark")).toBe("dark")
    expect(normalizeThemePreference("light")).toBe("light")
    expect(normalizeThemePreference("broken")).toBe("system")
    expect(normalizeThemePreference(null)).toBe("system")
  })

  it("群筛选同时匹配关键词和接入状态", () => {
    const catalog: GroupCatalogResponse["groups"] = [
      {
        key: "mcbpay",
        name: "MCBPAY 巴基技术支持",
        enabled: true,
        configured: true,
        accessMode: "bot",
        platform: "mcbpay",
        repositories: ["java-project", "sfzf-web"],
        branch: "pord-pkr",
        serverAlias: "pkr",
        databaseAlias: "db_pkr_prod",
        knowledgeScope: "mcbpay",
      },
      {
        key: "lakpay",
        name: "LakPay 技术沟通群",
        enabled: false,
        configured: false,
        accessMode: "user",
        platform: "lakpay",
        repositories: ["java-project"],
        branch: "lakpay",
        serverAlias: "lak",
        databaseAlias: "db_lak_prod",
        knowledgeScope: "lakpay",
      },
    ]

    expect(filterGroups(catalog, "巴基", "enabled").map((group) => group.key)).toEqual(["mcbpay"])
    expect(filterGroups(catalog, "lakpay", "user").map((group) => group.key)).toEqual(["lakpay"])
    expect(filterGroups(catalog, "uat", "all")).toEqual([])
  })

  it("银行编码搜索同时匹配名称和编码", () => {
    const options = [
      { label: "Banco do Brasil", value: "001" },
      { label: "Nubank", value: "260" },
    ]
    expect(filterOptions(options, "brasil")).toEqual([{ label: "Banco do Brasil", value: "001" }])
    expect(filterOptions(options, "260")).toEqual([{ label: "Nubank", value: "260" }])
    expect(filterOptions(options, "")).toEqual(options)
  })

  it("敏感信息类别使用简短中文名称", () => {
    expect(sensitiveCategoryLabel("credential")).toBe("账号凭据")
    expect(sensitiveCategoryLabel("private-key")).toBe("私钥")
    expect(sensitiveCategoryLabel("business-identifier")).toBe("业务敏感字段")
  })

  it("角色学习来源只由已配置的数字 ID 授权", () => {
    const role: TelegramRole = {
      id: "00000000-0000-4000-8000-000000000001",
      telegramUserId: "10001",
      username: "operator",
      displayName: "同名运营",
      role: "operator",
      canCorrect: false,
      enabled: true,
      learningSourceEnabled: true,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    }

    expect(roleLearningSourceLabel(role)).toBe("学习来源已授权 · ID 10001")
    expect(roleLearningSourceLabel({ ...role, learningSourceEnabled: false })).toBe("不作为学习来源 · ID 10001")
  })

  it("观察审计使用可区分的关联、接管和处理文案", () => {
    expect(learningObservationFacts({
      associationReason: "reply_chain",
      threadId: "thread-001",
      takeoverStatus: "cancelled",
      processingStatus: "completed",
      terminalResult: {
        classification: "business_rule",
        action: "add",
        risk: "medium",
        outcome: "candidate",
        reasonCode: "memory_candidate",
        memoryVersionId: "00000000-0000-4000-8000-000000000001",
        operatorStyleVersionId: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    })).toEqual([
      ["关联方式", "回复链关联"],
      ["问题线程", "thread-001"],
      ["接管状态", "已接管"],
      ["学习结果", "已完成"],
      ["终态分类", "业务规则"],
      ["终态动作", "新增"],
      ["终态结果", "记忆候选"],
      ["原因", "形成记忆候选"],
      ["记忆版本", "00000000-0000-4000-8000-000000000001"],
    ])
    expect(learningObservationFacts({ associationReason: "direct_bot_reply", threadId: null, takeoverStatus: "delivery_in_flight", processingStatus: "running", terminalResult: null }).at(2)?.[1]).toBe("发送中未知")
    expect(learningObservationFacts({ associationReason: "ambiguous", threadId: null, takeoverStatus: "ambiguous", processingStatus: "pending", terminalResult: null }).at(2)?.[1]).toBe("歧义未处理")
    expect(learningObservationFacts({ associationReason: "none", threadId: null, takeoverStatus: "not_linked", processingStatus: "ignored", terminalResult: null }).at(2)?.[1]).toBe("未关联")
  })
})

describe("白名单群批量配置状态", () => {
  const group = (id: string, accessMode: TelegramGroup["accessMode"]): TelegramGroup => ({
    id,
    key: id,
    name: `群 ${id}`,
    telegramChatId: `-100${id}`,
    accountId: null,
    projectId: "00000000-0000-4000-8000-000000000101",
    serviceId: "00000000-0000-4000-8000-000000000102",
    enabled: false,
    configured: false,
    accessMode,
    triggerMode: "all",
    platform: "service",
    repositories: [],
    branch: null,
    serverAlias: null,
    databaseAlias: "database",
    knowledgeScope: "default",
    purpose: "support",
    aiModelInstanceId: null,
    replyStyle: "unrestricted",
    operationMode: "live",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  })
  const account = (id: string, type: TelegramAccount["type"]): TelegramAccount => ({
    id,
    name: `${type} account`,
    type,
    enabled: true,
    status: "ready",
    statusMessage: "连接正常",
    botUsername: null,
    secretConfigured: true,
    secretHint: "已配置",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  })
  const botA = account("00000000-0000-4000-8000-000000000201", "bot")
  const botB = account("00000000-0000-4000-8000-000000000202", "bot")
  const user = account("00000000-0000-4000-8000-000000000203", "user")
  const botGroup = group("1", "bot")
  const otherBotGroup = group("2", "bot")
  const userGroup = group("3", "user")

  it("按列表顺序解析选择并正确判断全选", () => {
    const groups = [botGroup, otherBotGroup, userGroup]
    const selected = new Set([userGroup.id, botGroup.id])

    expect(selectedGroups(groups, selected).map((item) => item.id)).toEqual([botGroup.id, userGroup.id])
    expect(allGroupsSelected(groups, selected)).toBe(false)
    expect(allGroupsSelected(groups, new Set(groups.map((item) => item.id)))).toBe(true)
    expect(allGroupsSelected([], new Set())).toBe(false)
  })

  it("批量启用只提交已完成群 ID 和账号配置的群", () => {
    const ready = { ...botGroup, id: "ready", accountId: botA.id, configured: true }
    const draft = { ...otherBotGroup, id: "draft", telegramChatId: null, configured: false }

    const result = partitionGroupsForEnable([draft, ready], [botA])

    expect(result.eligible.map((item) => item.id)).toEqual(["ready"])
    expect(result.skipped.map((item) => item.id)).toEqual(["draft"])
  })

  it("批量启用跳过账号已停用或账号类型不匹配的群", () => {
    const disabledBot = { ...botA, id: "00000000-0000-4000-8000-000000000204", enabled: false }
    const disabledAccountGroup = { ...botGroup, id: "disabled", accountId: disabledBot.id, configured: true }
    const wrongTypeGroup = { ...otherBotGroup, id: "wrong-type", accountId: user.id, configured: true }

    const result = partitionGroupsForEnable([disabledAccountGroup, wrongTypeGroup], [disabledBot, user])

    expect(result.eligible).toEqual([])
    expect(result.skipped.map((item) => item.id)).toEqual(["disabled", "wrong-type"])
  })

  it("单群开关等待请求完成后才更新并重绘列表", async () => {
    let resolveUpdate: ((value: { groups: TelegramGroup[] }) => void) | undefined
    const update = new Promise<{ groups: TelegramGroup[] }>((resolve) => { resolveUpdate = resolve })
    const events: string[] = []
    const changed = { ...botGroup, enabled: true }

    const operation = performGroupQuickToggle({
      group: botGroup,
      enabled: true,
      update: () => update,
      onSuccess: () => events.push("success"),
      onFailure: () => events.push("failure"),
      onSettled: () => events.push("render"),
    })

    expect(events).toEqual([])
    resolveUpdate?.({ groups: [changed] })
    await operation
    expect(events).toEqual(["success", "render"])
  })

  it("任一单群请求进行中时阻止批量操作并发提交", () => {
    expect(groupBatchActionBlocked(false, 1)).toBe(true)
    expect(groupBatchActionBlocked(true, 0)).toBe(true)
    expect(groupBatchActionBlocked(false, 0)).toBe(false)
  })

  it("只在全部所选群接入方式一致时返回共同方式", () => {
    expect(sharedAccessMode([botGroup, otherBotGroup])).toBe("bot")
    expect(sharedAccessMode([botGroup, userGroup])).toBe(null)
    expect(sharedAccessMode([])).toBe(null)
  })

  it("客服账号只保留最终接入方式匹配项", () => {
    expect(accountOptions([botA, user, botB], "bot").map((item) => item.id)).toEqual([botA.id, botB.id])
    expect(accountOptions([botA, user, botB], "user").map((item) => item.id)).toEqual([user.id])
    expect(accountOptions([botA, user], null)).toEqual([])
  })

  it("拒绝没有任何修改的批量表单", () => {
    expect(buildBatchGroupPatch({ groups: [botGroup], accessMode: "", accountId: "", replyStyle: "" }, [botA]))
      .toEqual({ ok: false, error: "至少选择一项批量修改" })
  })

  it("允许只修改回复方式", () => {
    expect(buildBatchGroupPatch({ groups: [botGroup, userGroup], accessMode: "", accountId: "", replyStyle: "human" }, [botA, user]))
      .toEqual({ ok: true, patch: { replyStyle: "human" } })
  })

  it("统一接入方式时必须同时选择同类型账号", () => {
    expect(buildBatchGroupPatch({ groups: [botGroup], accessMode: "user", accountId: "", replyStyle: "" }, [botA, user]))
      .toEqual({ ok: false, error: "修改接入方式时必须选择匹配的客服账号" })
    expect(buildBatchGroupPatch({ groups: [botGroup], accessMode: "user", accountId: botA.id, replyStyle: "" }, [botA, user]))
      .toEqual({ ok: false, error: "客服账号与接入方式不一致" })
    expect(buildBatchGroupPatch({ groups: [botGroup], accessMode: "user", accountId: user.id, replyStyle: "human" }, [botA, user]))
      .toEqual({ ok: true, patch: { accessMode: "user", accountId: user.id, replyStyle: "human" } })
  })

  it("混合接入方式时不能只统一客服账号", () => {
    expect(buildBatchGroupPatch({ groups: [botGroup, userGroup], accessMode: "", accountId: botA.id, replyStyle: "" }, [botA, user]))
      .toEqual({ ok: false, error: "所选群接入方式不一致 请先统一接入方式" })
    expect(buildBatchGroupPatch({ groups: [botGroup, otherBotGroup], accessMode: "", accountId: botA.id, replyStyle: "" }, [botA, user]))
      .toEqual({ ok: true, patch: { accountId: botA.id } })
  })
})

describe("白名单群编辑表单", () => {
  const draft = {
    key: "dapay",
    name: "DApay 越南技术支持群",
    telegramChatId: "",
    accountId: "",
    projectId: "00000000-0000-4000-8000-000000000101",
    serviceId: "00000000-0000-4000-8000-000000000102",
    enabled: false,
    existing: true,
    purpose: "support" as const,
  }

  it("未启用的草稿群允许在没有群 ID 和账号时保存其他设置", () => {
    expect(validateGroupForm(draft)).toBeNull()
    expect(optionalTelegramChatId("   ")).toBeNull()
  })

  it("新增群仍必须填写群 ID 不扩大草稿规则", () => {
    expect(validateGroupForm({ ...draft, existing: false })).toEqual({
      field: "telegramChatId",
      message: "添加群前请先填写群 ID",
    })
  })

  it("启用草稿群时明确指出缺少群 ID 而不是静默不提交", () => {
    expect(validateGroupForm({ ...draft, enabled: true })).toEqual({
      field: "telegramChatId",
      message: "启用群前请先填写群 ID",
    })
  })

  it("填写群 ID 后继续指出启用所缺的客服账号", () => {
    expect(validateGroupForm({ ...draft, enabled: true, telegramChatId: " -1001234567890 " })).toEqual({
      field: "accountId",
      message: "启用群前请先绑定客服账号",
    })
    expect(optionalTelegramChatId(" -1001234567890 ")).toBe("-1001234567890")
  })

  it("群 ID 格式错误时给出可见提示", () => {
    expect(validateGroupForm({ ...draft, telegramChatId: "group-100" })).toEqual({
      field: "telegramChatId",
      message: "群 ID 只能填写数字，可在开头带负号",
    })
  })
})
