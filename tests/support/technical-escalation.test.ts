import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { answerDecisionSchema, evidenceFactSchema } from "../../src/codex/schemas.js"
import { systemDirectivesPrompt } from "../../src/support/system-directives.js"

const base = {
  answer: "已经通知技术同事处理",
  quote: null,
  reason: "已确认需要技术处理",
  confidence: 1,
  usedMemoryVersionIds: [],
  investigation: {
    summary: "已完成排查",
    steps: [{
      source: "message" as const,
      title: "读取问题",
      status: "confirmed" as const,
      evidence: "运营原消息",
      conclusion: "已理解当前诉求",
    }],
  },
}

const operatorSelfServiceCases = [
  {
    scenario: "代收接口命中商户代收开关关闭",
    question: "前端拉不起代收单，返回 Merchant collection is not enabled",
    runtimeFact: "商户代收开关为关闭，未生成订单",
    menu: ["【商户列表】", "【代收开关】"],
    answer: "已确认是商户代收开关关闭，所以这次没有生成订单。运营在【商户列表】打开【代收开关】并完成动态验证码后，再让前端重新拉起即可。",
  },
  {
    scenario: "下单接口命中商户接口白名单",
    question: "下单返回 IP address is not whitelisted",
    runtimeFact: "实际出口 IP 不在该商户接口白名单，未生成订单",
    menu: ["【商户列表】", "【接口白名单】"],
    answer: "已确认这次请求的出口 IP 不在商户接口白名单，所以没有生成订单。运营在【商户列表】打开【接口白名单】，加入已确认的出口 IP 并保存后，让商户重试即可。",
  },
  {
    scenario: "商户没有加入商户分组",
    question: "商户已经建好了，但提示未加入分组",
    runtimeFact: "商户当前没有所属分组，分组路由无法生效",
    menu: ["【商户分组】"],
    answer: "已确认这个商户当前没有加入任何商户分组，所以分组路由没有生效。运营在【商户分组】把该商户加入对应分组并保存后，再重新发起即可。",
  },
  {
    scenario: "商户通道配置缺少可用通道",
    question: "商户提示没有可用通道，帮忙处理下",
    runtimeFact: "商户通道配置中没有符合当前业务条件的启用通道",
    menu: ["【商户通道配置】"],
    answer: "已确认该商户当前没有符合条件的启用通道，所以请求无法继续。运营在【商户通道配置】补充或启用对应通道并保存后，再重新发起即可。",
  },
  {
    scenario: "通道管理中的现有通道被停用",
    question: "这个通道怎么没有参与派发",
    runtimeFact: "通道管理中该通道处于停用状态",
    menu: ["【通道管理】"],
    answer: "已确认该通道目前处于停用状态，所以没有参与派发。运营在【通道管理】确认业务条件后启用该通道并保存，后续新请求才会参与选择。",
  },
] as const

describe("技术升级由模型语义和通用记忆判断", () => {
  it.each(operatorSelfServiceCases)("运营可通过不同现有接口处理时只回复路径：$scenario", ({
    question,
    runtimeFact,
    menu,
    answer,
  }) => {
    expect(question).toBeTruthy()
    expect(runtimeFact).toBeTruthy()
    menu.forEach((item) => expect(answer).toContain(item))
    expect(answer).not.toContain("通知技术")
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "reply",
      escalationType: "none",
      answer,
      reason: `当前代码和生产配置确认：${runtimeFact}；当前发布前后端存在运营操作入口。`,
    }).success).toBe(true)

    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("页面实际调用的查询 导出 新增 修改 启停 审批 重试 派发和账号操作接口")
    expect(prompt).toContain("后端权限注解和角色判断")
    expect(prompt).toContain("运营角色实际权限")
    expect(prompt).toContain("回答工作者自身只能只读不等于运营账号不能操作")
    expect(prompt).toContain("只要运营角色已有入口和操作权限")
  })

  it("自助配置规则不依赖接口错误码或数据库字段名", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).not.toContain("1002")
    expect(prompt).not.toContain("1005")
    expect(prompt).not.toContain("dsqyzt")
    expect(prompt).toContain("任何现有功能")
  })

  it("没有运营入口和权限且必须内部写入时仍允许技术升级", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("已排除运营及其他授权业务角色通过现有功能处理")
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "escalate",
      escalationType: "technical_change",
      answer: "已确认这项配置没有运营后台入口，需要技术修改内部服务配置，已经通知技术同事处理。",
      reason: "[已确认技术处理] 类型=生产配置\n当前代码和运行数据已确认唯一根源；前后端没有运营操作入口，运营角色也没有对应写权限。",
    }).success).toBe(true)
  })

  it("结构协议只保证升级类型与决定一致", () => {
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "escalate",
      escalationType: "technical_change",
    }).success).toBe(true)
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "reply",
      escalationType: "technical_change",
    }).success).toBe(false)
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "escalate",
      escalationType: "none",
    }).success).toBe(false)
  })

  it("专人操作只做结构完整性校验", () => {
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "escalate",
      escalationType: "human_operation",
      humanOperation: { action: "解冻账号", identifiers: ["merchant-1001"] },
    }).success).toBe(true)
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "escalate",
      escalationType: "human_operation",
      humanOperation: null,
    }).success).toBe(false)
  })

  it("忽略消息允许空必答要点，但需要回复时必须至少有一项", () => {
    const evidencePacket = {
      version: "1" as const,
      communication: { intent: "ignore" as const, recipient: null, desiredOutcome: "无需回复" },
      facts: [],
      requiredAnswerPoints: [],
      unknowns: [],
      handlingNotes: [],
      reviewLevel: "standard" as const,
    }
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "ignore",
      escalationType: "none",
      evidencePacket,
    }).success).toBe(true)
    expect(answerDecisionSchema.safeParse({
      ...base,
      decision: "reply",
      escalationType: "none",
      evidencePacket: {
        ...evidencePacket,
        communication: { ...evidencePacket.communication, intent: "direct_answer" as const },
      },
    }).success).toBe(false)
  })

  it("推断来源和推断事实不能伪装成已确认", () => {
    const baseFact = {
      id: "F1",
      statement: "当前只是初步判断",
      provenance: "inference" as const,
      evidenceSource: "inference" as const,
      evidence: "基于前述证据推断",
      outboundSafe: true,
    }
    expect(evidenceFactSchema.safeParse({ ...baseFact, certainty: "inferred" }).success).toBe(true)
    expect(evidenceFactSchema.safeParse({ ...baseFact, certainty: "confirmed" }).success).toBe(false)
    expect(evidenceFactSchema.safeParse({
      ...baseFact,
      provenance: "code",
      evidenceSource: "inference",
      certainty: "reported",
    }).success).toBe(false)
  })

  it("故障升级边界由统一提示词说明而非正则验句", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("只有已确认唯一根源且必须由技术修改代码 生产配置 通道映射或后台业务数据时才升级故障")
    expect(prompt).toContain("商户参数缺失 上游自身问题 正常状态 责任不确定 只读资源失败或证据冲突不得升级")
    expect(prompt).toContain("业务语义全部由回答模型")
  })

  it("生产调查路径不再包含技术升级业务门禁函数", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/support/investigation-service.ts", import.meta.url)), "utf8")
    expect(source).not.toMatch(/hasVerifiedTechnicalEscalation|hasVerifiedServiceHandoff|escalationAnswerIsConcrete|featureRequestAnswerConfirmsDeployment/u)
  })
})
