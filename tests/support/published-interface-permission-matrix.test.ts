import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { answerDecisionModelSchema } from "../../src/codex/schemas.js"
import { systemDirectivesPrompt } from "../../src/support/system-directives.js"

type InterfaceModule = {
  controller: string
  menu: string
  base: string
  endpoints: readonly string[]
}

const module = (
  controller: string,
  menu: string,
  base: string,
  endpoints: readonly string[],
): InterfaceModule => ({ controller, menu, base, endpoints })

// prod-pkr 已发布 b2b0c2f9c30fbe90a5fbe4bb625d342b356f3e12 的全部显式 HTTP 接口。
// GET 及 POST 查询和导出也保留，避免把 HTTP 方法误当成“必须技术操作”的依据。
const publishedInterfaceModules = [
  module("CallbackRetryConfigController", "回调重试配置", "/callback/retry/config", [
    "POST /list", "POST /create", "PUT /update", "PUT /update-intervals", "DELETE /{id}", "PUT /{id}/set-default",
    "GET /default", "GET /{id}", "GET /{id}/intervals",
  ]),
  module("CashierController", "收银台", "/cashierApi", ["GET /generate/{orderNo}"]),
  module("DashboardStatsController", "统计看板", "/sfzf/stats", [
    "POST /refresh", "GET /payment/trend", "GET /merchant/ranking", "GET /payment/pipeline-health",
  ]),
  module("DeadlockMonitorController", "死锁监控", "/sfzf/deadlock", [
    "GET /stats/today", "GET /lock-failure/today", "GET /rate-check",
  ]),
  module("MerchantSubAccountController", "商户子账号", "/yygl/shgl/subAccount", [
    "POST /list", "POST /create", "POST /resetPassword", "POST /changeStatus", "POST /delete",
  ]),
  module("SfzfBankCodeMappingController", "银行编码映射", "/sfzf/bankCodeMapping", [
    "POST /add", "DELETE /delete", "DELETE /deleteBatch", "POST /batchAdd", "POST /copyChannel", "POST /importExcel",
    "GET /list", "GET /{id}", "GET /listByChannel/{channelCode}", "GET /listSupportCollection/{channelCode}",
    "GET /listSupportPayment/{channelCode}",
  ]),
  module("SfzfBotIgnoreController", "机器人忽略名单", "/sfzf/botIgnore", [
    "POST /add", "DELETE /delete", "DELETE /deleteBatch", "GET /list", "GET /{id}",
  ]),
  module("SfzfFzDsfqjeController", "商户分组金额", "/yygl/shfz", [
    "POST /saveGroupAmountRange", "GET /listGroupAmountRanges", "GET /listGroupSupportMeta", "GET /exportGroupSupportMeta",
    "GET /listThbGroupSupportMeta", "GET /exportThbGroupSupportMeta",
  ]),
  module("SfzfHttpProxyController", "HTTP 代理", "/sfzf/httpProxy", [
    "POST /add", "DELETE /delete", "DELETE /deleteBatch", "POST /test", "GET /list", "GET /queryById", "GET /options",
  ]),
  module("SfzfHttpRequestTemplateController", "接口模板", "/sfzf/http-request-template", [
    "POST /create", "POST /update", "DELETE /delete/{id}", "DELETE /cache/clearByEnums", "DELETE /cache/clearAll",
    "DELETE /cache/clearByEntity", "DELETE /cache/clearByChannel", "DELETE /cache/clearByInterface",
    "POST /batch-update/preview", "POST /batch-update/execute", "POST /query-by-conditions",
    "POST /copy-channel-interface/preview", "POST /copy-channel-interface/execute",
    "GET /getByEnums", "GET /getByEnumsFromDb", "GET /interfaceTypes", "GET /channelTypes",
    "GET /interfaceType/description", "GET /available-fields", "GET /channel-interfaces/{channelType}",
    "GET /check-interface-exists", "GET /copy-modes",
  ]),
  module("SfzfOrderInterceptRuleController", "订单拦截规则", "/sfzf/orderInterceptRule", [
    "POST /add", "DELETE /delete", "DELETE /deleteBatch", "GET /list", "GET /{id}",
  ]),
  module("SfzfShfzbController", "商户分组", "/sfzf/shfzb", [
    "POST /create", "PUT /update", "DELETE /delete/{id}", "PUT /sort", "POST /validate",
    "GET /detail/{id}", "GET /list", "GET /ungrouped",
  ]),
  module("SfzfSysController", "运营登录", "/yy", ["POST /login"]),
  module("SfzfSysUserController", "系统用户", "", ["GET /genPassword"]),
  module("SfzfTjController", "数据统计", "/sfzf/tj", [
    "POST /dsddStatByChannelAll", "POST /dsddStatByChannel", "POST /dsddStatByCurrencyAll", "POST /dsddStatByCurrency",
    "POST /shtj", "POST /shtj/merged", "POST /shtj/merged/export", "POST /dstj", "POST /dstj/last30m",
    "POST /dstj/export", "POST /dftj", "POST /dftj/export", "POST /dfddStatByChannelAll", "POST /dfddStatByChannel",
    "POST /dfddStatByCurrencyAll", "POST /dfddStatByCurrency", "POST /dsddStatByChannel/export",
    "POST /dfddStatByChannel/export", "POST /report/daily", "POST /report/daily/export", "POST /report/monthly",
    "POST /report/monthly/export", "GET /shtj/export",
  ]),
  module("SfzfWhitelistApproverController", "白名单审批人", "/sfzf/whitelistApprover", [
    "POST /add", "DELETE /delete", "DELETE /deleteBatch", "GET /list", "GET /{id}",
  ]),
  module("TelegramMsgController", "Telegram 消息", "/telegram/msg", [
    "POST /add", "DELETE /delete", "DELETE /deleteBatch", "POST /updateStatus", "POST /processMessage",
    "POST /sendMessage", "POST /uploadImage", "POST /getImage",
    "GET /list", "GET /queryById", "GET /queryByTemplateName", "GET /queryEnabled", "GET /queryWithCron",
  ]),
  module("TelegramTemplateGroupController", "Telegram 模板群组", "/telegram/templateGroup", [
    "POST ", "PUT ", "DELETE /template/{templateId}", "POST /sendMessage", "GET /template/{templateId}",
    "GET /group/{groupId}", "GET /list",
  ]),
  module("MerchantFinancialReportController", "商户财务报表", "/financial-report", [
    "POST /page", "POST /export",
  ]),
  module("OpsSsoAccountController", "运营 SSO 账号", "/sys/ops-sso/accounts", ["POST /bind/verify"]),
  module("OpsSsoController", "运营 SSO", "/sys/ops-sso", ["POST /exchange", "POST /backchannel-logout"]),
  module("OcrController", "OCR", "/ocr", ["POST /test", "POST /extract"]),
  module("OcrFeignClient", "OCR 内部调用", "", ["POST /ocr"]),
  module("QuartzJobController", "定时任务", "/sys/quartzJob", ["GET /pause", "GET /resume", "GET /execute"]),
  module("OppayScanOpsController", "Oppay 运营查询", "/yygl/oppayscan", [
    "POST /collection/query/{orderNo}", "POST /payment/query/{orderNo}", "POST /balance/{channelId}",
  ]),
  module("YyglCwglController", "财务管理", "/yygl/cwgl", [
    "POST /yetz", "POST /tzjl", "POST /applyBalanceAdjust",
  ]),
  module("YyglDdglController", "订单管理", "/yygl/ddgl", [
    "POST /listDsdd", "POST /countDsdd", "POST /listDsddHistory", "POST /countDsddHistory",
    "POST /exportDsddExcelStreaming", "POST /exportDsddHistoryExcelStreaming", "POST /exportDsddExcel",
    "POST /exportDfddExcelStreaming", "POST /exportDfddHistoryExcelStreaming", "POST /exportDfddExcel",
    "POST /pendingOrderPage", "POST /listDfdd", "POST /countDfdd", "POST /listDfddHistory", "POST /countDfddHistory",
    "POST /dsddMore", "POST /dfddMore", "POST /dfddSdpf", "POST /paymentOrderBatchAssign", "POST /verifyTotpCode",
    "POST /testDFOrder", "POST /csddDS", "POST /getDsOrderDetail", "POST /getDsOrderHistoryDetail",
    "POST /getDfOrderDetail", "POST /getDfOrderHistoryDetail", "POST /dfddMoreBatch", "POST /dsddCallbackBatch",
  ]),
  module("YyglJqrglController", "机器人管理", "/yygl/jqrgl", [
    "POST /listQ", "POST /saveQ", "POST /bindingConflicts", "POST /listUpstreamQ", "POST /saveUpstreamQ",
  ]),
  module("YyglShglController", "商户管理", "/yygl/shgl", [
    "POST /zjls", "POST /list", "POST /balanceSummary", "POST /exportBalanceSummaryExcel", "POST /add", "POST /update",
    "POST /batchUpdateFee", "POST /cancelDsEmptyOrderLimit/{sh}", "POST /mycz", "POST /listTd", "POST /saveTd",
    "DELETE /deleteTd_{shtdid}", "POST /saveBatchTd", "POST /exportShzjlsExcel", "POST /exportShzjlsExcelStreaming",
    "POST /applyKeyReset", "POST /applyWithdraw", "POST /applyPasswordReset", "POST /exportMerchantListExcel",
    "GET /openingBalance", "GET /listAll", "GET /get/{sh}", "GET /listTdByShChecked_{shbh}", "GET /viewKey/{shbh}",
  ]),
  module("YyglShspController", "商户审批", "/yygl/shsp", [
    "POST /handleApproval", "POST /revokeWithdrawApproval", "POST /queryApprovalRecords", "POST /exportApprovalRecordsExcel",
    "GET /getApprovalDetail/{spdh}",
  ]),
  module("YyglTdglController", "通道管理", "/yygl/tdgl", [
    "POST /list", "DELETE /logical_deletion/{dstdid}", "POST /save", "DELETE /delete_{tdid}", "POST /saveDs",
    "DELETE /deleteDs_{dstdid}", "POST /listDfc", "POST /saveDfc", "POST /listDfctdpz", "POST /saveDfctdpz",
    "POST /saveSharedPaymentScheme", "DELETE /deleteDfc_{id}", "POST /updateWhiteList_{tdid}", "POST /updateBytddh",
    "POST /batchCreate", "POST /updateChannelConfig", "POST /settlementConfig",
    "GET /get_{tdid}", "GET /listDs_{tdid}", "GET /listSharedPaymentSchemes", "GET /listTdOptions_{tdlx}",
    "GET /listTransactionTypes", "GET /listCurrencies", "GET /currentCurrency", "GET /settlementConfig/{tdid}",
  ]),
] as const satisfies readonly InterfaceModule[]

const publishedInterfaces = publishedInterfaceModules.flatMap((group) => group.endpoints.map((endpoint) => {
  const separator = endpoint.indexOf(" ")
  const method = endpoint.slice(0, separator)
  const suffix = endpoint.slice(separator + 1)
  return {
    controller: group.controller,
    menu: group.menu,
    id: `${method} ${group.base}${suffix}`,
  }
}))

const baseDecision = {
  humanOperation: null,
  quote: null,
  confidence: 1,
  usedMemoryVersionIds: [],
  answerClaims: [{
    factId: "F1" as const,
    statement: "当前已发布代码明确了页面入口和业务角色权限",
    provenance: "code" as const,
    evidenceSource: "code" as const,
    evidence: "当前已发布代码与角色权限",
  }],
  responsibility: {
    party: "not_applicable" as const,
    certainty: "not_applicable" as const,
    evidenceSources: [],
    factIds: [],
  },
  interaction: {
    sentiment: "neutral" as const,
    situation: "new_request" as const,
    underlyingNeed: "根据当前页面入口和角色权限确认处理人",
    responseStrategy: "direct_answer" as const,
  },
  investigation: {
    summary: "已完成接口和权限闭环核对",
    steps: [{
      source: "code" as const,
      title: "核对前后端接口和角色权限",
      status: "confirmed" as const,
      evidence: "当前已发布代码与角色权限",
      conclusion: "处理人已确认",
    }],
  },
  evidencePacket: {
    version: "2" as const,
    communication: {
      intent: "direct_answer" as const,
      recipient: null,
      desiredOutcome: "说明当前页面入口和业务角色处理路径",
    },
    facts: [{
      id: "F1" as const,
      statement: "当前已发布代码明确了页面入口和业务角色权限",
      provenance: "code" as const,
      evidenceSource: "code" as const,
      evidence: "当前已发布代码与角色权限",
      certainty: "confirmed" as const,
      outboundSafe: true,
      subjectKind: "general" as const,
      businessType: "not_applicable" as const,
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    }],
    associations: [],
    requiredAnswerPoints: ["说明当前处理入口和角色权限"],
    unknowns: [],
    handlingNotes: [],
    reviewLevel: "standard" as const,
  },
}

function evidenceForAnswer(
  statement: string,
  evidence: string,
  intent: "direct_answer" | "handoff" = "direct_answer",
  desiredOutcome = "说明当前页面入口和业务角色处理路径",
) {
  return {
    answerClaims: [{
      factId: "F1" as const,
      statement,
      provenance: "code" as const,
      evidenceSource: "code" as const,
      evidence,
    }],
    evidencePacket: {
      ...baseDecision.evidencePacket,
      communication: { intent, recipient: null, desiredOutcome },
      facts: [{
        ...baseDecision.evidencePacket.facts[0],
        statement,
        evidence,
      }],
    },
  }
}

function discoverJavaInterfaces(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".java")) files.push(path)
    }
  }
  walk(root)

  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8")
    const classMatch = source.match(/public\s+(?:class|interface)\s+(\w+)/)
    if (!classMatch) return []
    const classOffset = source.indexOf(classMatch[0])
    const classAnnotations = source.slice(0, classOffset)
    const base = [...classAnnotations.matchAll(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)/g)].at(-1)?.[1] ?? ""
    const mappingPattern = /@(Get|Post|Put|Patch|Delete)Mapping(?:\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']*)["'][^)]*\))?/g
    return [...source.matchAll(mappingPattern)].map((match) => `${match[1]!.toUpperCase()} ${base}${match[2] ?? ""}`)
  })
}

describe("当前已发布接口的处理权限场景矩阵", () => {
  it("固定清单覆盖 31 个控制器的 240 个显式 HTTP 接口且没有重复", () => {
    expect(publishedInterfaceModules).toHaveLength(31)
    expect(publishedInterfaces).toHaveLength(240)
    expect(new Set(publishedInterfaces.map((item) => item.id)).size).toBe(240)
  })

  it.each(publishedInterfaces)("当前运营角色有入口和权限时直接回复：$id", ({ id, menu }) => {
    const factStatement = `已确认当前情况可由运营账号在【${menu}】处理。`
    const answer = `${factStatement} 按页面提示处理并保存后重试即可。`
    const parsed = answerDecisionModelSchema.safeParse({
      ...baseDecision,
      ...evidenceForAnswer(factStatement, `当前已发布代码确认 ${id} 的页面入口和运营角色权限`),
      decision: "reply",
      escalationType: "none",
      answer,
      reason: `已核对 ${id} 的页面入口、权限注解和运营角色权限。`,
    })
    expect(parsed.success).toBe(true)
    expect(answer).not.toContain("通知技术")
  })

  it.each(publishedInterfaces)("运营无权但其他业务角色可处理时不报技术：$id", ({ id, menu }) => {
    const factStatement = `已确认【${menu}】有其他授权业务角色可用的现成入口。`
    const answer = `${factStatement} 当前账号没有权限，请由有权限的业务角色处理，不需要修改系统配置。`
    const parsed = answerDecisionModelSchema.safeParse({
      ...baseDecision,
      ...evidenceForAnswer(factStatement, `当前已发布代码确认 ${id} 的页面入口和其他业务角色权限`),
      decision: "reply",
      escalationType: "none",
      answer,
      reason: `已核对 ${id}：运营当前无权，但其他授权业务角色可通过现有页面处理。`,
    })
    expect(parsed.success).toBe(true)
    expect(answer).not.toContain("通知技术")
  })

  it.each(publishedInterfaces)("所有业务角色均无法处理且确需内部写入时才报技术：$id", ({ id }) => {
    const factStatement = "已确认这项处理没有业务角色可用的后台入口。"
    const parsed = answerDecisionModelSchema.safeParse({
      ...baseDecision,
      ...evidenceForAnswer(
        factStatement,
        `当前已发布代码确认 ${id} 没有业务角色操作入口`,
        "handoff",
        "通知技术执行必要的内部配置修改",
      ),
      decision: "escalate",
      escalationType: "technical_change",
      answer: `${factStatement} 必须由技术修改内部配置，已经通知技术处理。`,
      reason: `[已确认技术处理] 类型=生产配置\n已核对 ${id}：现有界面、权限注解、角色授权和运行证据均确认运营及其他业务角色无法完成，且必须内部写入。`,
      responsibility: { party: "our_side", certainty: "confirmed", evidenceSources: ["code"], factIds: ["F1"] },
    })
    expect(parsed.success).toBe(true)
  })

  it("所有现有接口共用同一权限闭环，不按 HTTP 方法或写库与否升级", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("查询 导出 新增 修改 启停 审批 重试 派发和账号操作接口")
    expect(prompt).toContain("接口使用 GET POST PUT PATCH DELETE 方法 会写数据库 需要 TOTP 或当前账号没有权限")
    expect(prompt).toContain("其他业务角色有现成入口和权限")
    expect(prompt).toContain("仍不得作为技术故障升级")
  })

  it("已发布后端快照存在时，新增或遗漏接口会直接使清单对账失败", () => {
    const snapshotRoot = join(
      process.cwd(),
      "data/runtime/git-snapshots/e71761ed-c59e-488a-b596-d4d412ef683a/prod-pkr/b2b0c2f9c30fbe90a5fbe4bb625d342b356f3e12/jeecg-module-system/jeecg-sfzf-biz/src/main/java",
    )
    if (!existsSync(snapshotRoot)) return
    expect(discoverJavaInterfaces(snapshotRoot).sort()).toEqual(publishedInterfaces.map((item) => item.id).sort())
  })

  it("代收开关与商户白名单使用同一运营权限和更新接口", () => {
    const frontendRoot = join(
      process.cwd(),
      "data/runtime/git-snapshots/a746a7a1-10cb-4083-a894-703da9f29b74/prod-pkr/a5daf8d5d0f3eaf4071892a294238eb1d9eedf1e/src/views/system/yygl_shlb",
    )
    if (!existsSync(frontendRoot)) return
    const merchantList = readFileSync(join(frontendRoot, "index.vue"), "utf8")
    const whitelist = readFileSync(join(frontendRoot, "MerchantIpWhitelistModal.vue"), "utf8")
    expect(merchantList).toContain("hasPermission('shlb:add')")
    expect(merchantList).toContain("url: '/yygl/shgl/update'")
    expect(whitelist).toContain("hasPermission('shlb:add')")
    expect(whitelist).toContain("url: '/yygl/shgl/update'")
  })
})
