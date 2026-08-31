import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { CodexSupportDecisionAgent, type SupportDecisionInput } from "../../src/support/agent.js"
import { baselineOperatorStyleProfile } from "../../src/support/operator-style.js"
import { systemDirectivesPrompt } from "../../src/support/system-directives.js"

const modelSnapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  alias: "测试回答模型",
  provider: "openai" as const,
  transport: "codex_cli" as const,
  modelId: "gpt-5.6-terra",
  reasoningEffort: "medium" as const,
  serviceTier: "standard" as const,
  parameters: {},
  apiKey: null,
  enabled: true,
  healthStatus: "not_tested" as const,
  healthMessage: "尚未检测",
  lastCheckedAt: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
}

const communicationIntentCases = [
  ["这个可以发给上游吗", "上游"],
  ["这段能直接转给商户吗", "商户"],
  ["银行那边问了，我应该怎么回", "银行"],
  ["帮我整理一段给通道方", "通道方"],
  ["怎么跟对方解释这个状态", "对方"],
  ["给技术写一段能直接看的说明", "技术"],
  ["这个结论能不能给客户看", "客户"],
  ["帮我组织一下回复内容", "接收方"],
  ["对方不认，怎么把证据发过去", "对方"],
  ["这份结果怎么转述比较清楚", "接收方"],
  ["我要回复代理，直接给我一段", "代理"],
  ["怎么举证是我们已经发出了", "接收方"],
] as const

const verifiedEvidenceCases = [
  "系统订单号和商户订单号",
  "我方实际发送时间",
  "我方实际发送的关键字段",
  "我方实际收到的接口响应",
  "我方实际收到的结果回调",
  "我方未收到的预期结果",
  "当前数据库订单状态",
  "状态变化和精确时间",
  "当前代码赋予状态的业务含义",
  "希望第三方核对的具体事项",
] as const

function input(question: string): SupportDecisionInput {
  return {
    service: "service",
    groupName: "客服群",
    question,
    latestMessage: question,
    conversationContext: "运营前面正在核对同一笔订单",
    responseDepth: "followup",
    senderRole: null,
    scope: "global",
    region: null,
    branch: "main",
    codeSnapshot: null,
    directives: [],
    memories: [],
    documents: [],
    resources: { servers: [], databases: [], checks: [] },
    attachments: [],
    resourceWorkspacePath: process.cwd(),
    resourceManifestPath: path.join(process.cwd(), "resource-manifest.json"),
    networkHosts: [],
    answerTimeoutSeconds: 60,
    operatorStyleProfile: baselineOperatorStyleProfile,
    modelInstanceId: modelSnapshot.id,
    modelSnapshot,
    answerMaxConcurrency: 2,
    answerBindingEnabled: true,
    replyStyle: "human",
  }
}

describe("第三方沟通成品通用情景", () => {
  it.each(communicationIntentCases)("识别不同问法和接收方：%s", async (question, recipient) => {
    const execute = vi.fn().mockResolvedValue({
      decision: "reply",
      escalationType: "none",
      answer: `下面这段可以直接发给${recipient}：\n已确认事实和待核对事项`,
      quote: null,
      reason: "按最新消息生成第三方沟通成品",
      confidence: 1,
      usedMemoryVersionIds: [],
      investigation: { summary: "生成沟通成品", steps: [] },
    })
    const agent = new CodexSupportDecisionAgent({ execute } as never)

    await agent.decide(input(question))

    const prompt = String(execute.mock.calls[0]?.[1]?.prompt)
    expect(prompt).toContain(`本轮唯一需要直接回应的最新消息：${question}`)
    expect(prompt).toContain("索要一份可直接复制发送的沟通成品")
    expect(prompt).toContain("明确告诉运营后面的独立正文可以直接发给谁")
    expect(prompt).toContain("不能裸放正文让运营猜测")
  })

  it.each(verifiedEvidenceCases)("可转发正文覆盖我方证据类型：%s", (evidenceType) => {
    expect(evidenceType).toBeTruthy()
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("已经由当前代码或实际只读资源核实")
    expect(prompt).toContain("我方实际发送的关键字段")
    expect(prompt).toContain("实际收到的响应或回调")
    expect(prompt).toContain("未收到的预期结果")
    expect(prompt).toContain("当前数据库状态")
    expect(prompt).toContain("明确希望接收方核对或处理的具体事项")
  })

  it("不把聊天转述、截图、推断和历史回复冒充我方运行证据", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("聊天转述 截图展示 推断和历史客服结论不能冒充我方运行证据")
    expect(prompt).toContain("尚未核实的内容必须按真实来源说明")
    expect(prompt).toContain("缺少形成对外证据所必需的最少业务标识则先只追问一项")
  })

  it("第三方正文只放可复核业务事实并保留敏感边界", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt).toContain("只写足以定位和复核的证据")
    expect(prompt).toContain("不堆砌全部内部排查记录")
    expect(prompt).toContain("不得输出密钥 签名 完整报文 连接信息 内部路径")
  })

  it("独立成稿与审核都保留会改变结论的代码条件", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        answer: "自动处理开关开启并取得终态时，主动查单可更新订单状态。",
        quote: null,
        claims: [{ factId: "F1", statement: "自动处理开关开启并取得终态时，主动查单可更新订单状态。" }],
        usedMemoryVersionIds: [],
      })
      .mockResolvedValueOnce({ outcome: "approve", issues: [], reason: "关键条件完整" })
    const agent = new CodexSupportDecisionAgent({ execute } as never)
    const request = input("主动查单会不会更新状态")
    const decision = { decision: "reply" as const, escalationType: "none" as const }
    const evidencePacket = {
      version: "1" as const,
      communication: { intent: "direct_answer" as const, recipient: null, desiredOutcome: "解释查单状态更新条件" },
      facts: [{
        id: "F1" as const,
        statement: "自动处理开关开启并取得终态时，主动查单可更新订单状态。",
        provenance: "code" as const,
        evidenceSource: "code" as const,
        evidence: "当前发布代码中的条件分支",
        certainty: "confirmed" as const,
        outboundSafe: true,
      }],
      requiredAnswerPoints: ["说明状态更新的开关和结果条件"],
      unknowns: [],
      handlingNotes: ["不得概括成主动查单绝不会修改状态"],
      reviewLevel: "strict" as const,
    }
    const candidate = await agent.composeReply({ request, decision, evidencePacket })
    await agent.reviewReply({
      request,
      decision,
      evidencePacket,
      baseline: { answer: "基线", quote: null, answerClaims: [], usedMemoryVersionIds: [] },
      candidate,
      attempt: 1,
    })

    const composePrompt = String(execute.mock.calls[0]?.[1]?.prompt)
    const reviewPrompt = String(execute.mock.calls[1]?.[1]?.prompt)
    expect(composePrompt).toContain("必须保留会改变结论的条件")
    expect(composePrompt).toContain("对方无法独立复核或本题不需要的请求体/响应体哈希、字节数")
    expect(composePrompt).toContain("usedMemoryVersionIds 必须设为 []")
    expect(composePrompt).not.toContain("运营前面正在核对同一笔订单")
    expect(composePrompt).not.toContain("有效记忆：")
    expect(reviewPrompt).toContain("禁止把有条件行为审核成无条件规则")
    expect(reviewPrompt).toContain("无关诊断元数据堆砌都不能 approve")
    expect(execute.mock.calls[0]?.[1]?.concurrencyGroup).toBeUndefined()
    expect(execute.mock.calls[1]?.[1]?.concurrencyGroup).toBeUndefined()
  })
})
