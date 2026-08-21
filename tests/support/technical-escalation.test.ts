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

describe("技术升级由模型语义和通用记忆判断", () => {
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
