import { describe, expect, it } from "vitest"

import type { CodexExecutor } from "../../src/codex/executor.js"
import type { AnswerDecision } from "../../src/codex/schemas.js"
import type { AdminChatTurn, ModelPurpose } from "../../src/runtime/types.js"
import {
  conversationHistory,
  latestAdminChatMessage,
  latestInvestigationCheckpoint,
} from "../../src/admin-chat/worker.js"
import {
  answerStyleInstruction,
  CodexSupportDecisionAgent,
  type ResponseDepth,
  type SupportDecisionInput,
} from "../../src/support/agent.js"
import {
  answerIntroducesUnrequestedDerivedStatistics,
  answerExplicitlyClearsOurResponsibility,
  answerQualifiesUpstreamReturnedInference,
  hasVerifiedExternalCauseEvidence,
  questionNeedsInterfaceDocumentation,
  questionRequestsFeatureChange,
  upstreamBalanceErrorMisattributesResponsibility,
  upstreamReturnedErrorInferenceNeedsQualification,
} from "../../src/support/investigation-service.js"
import { baselineOperatorStyleProfile } from "../../src/support/operator-style.js"

async function answerPrompt(depth: ResponseDepth, overrides: Partial<SupportDecisionInput> = {}): Promise<string> {
  let prompt = ""
  const agent = new CodexSupportDecisionAgent({
    execute: async <T>(_purpose: ModelPurpose, input: { prompt: string }): Promise<T> => {
      prompt = input.prompt
      return {} as T
    },
  } as unknown as CodexExecutor)

  await agent.decide({
    service: "test",
    groupName: "test",
    question: "正确接口发一下",
    responseDepth: depth,
    senderRole: null,
    scope: "test",
    region: null,
    branch: null,
    codeSnapshot: null,
    directives: [],
    memories: [],
    documents: [],
    resources: { servers: [], databases: [], checks: [] },
    attachments: [],
    resourceWorkspacePath: ".",
    resourceManifestPath: "READ_ONLY.md",
    networkHosts: [],
    answerTimeoutSeconds: 30,
    operatorStyleProfile: baselineOperatorStyleProfile,
    modelInstanceId: "00000000-0000-4000-8000-000000000001",
    modelSnapshot: {
      id: "00000000-0000-4000-8000-000000000001",
      alias: "测试回答模型",
      provider: "openai",
      transport: "codex_cli",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      serviceTier: "standard",
      parameters: {},
      apiKey: null,
      enabled: true,
      healthStatus: "not_tested",
      healthMessage: "尚未检测",
      lastCheckedAt: null,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    },
    answerMaxConcurrency: 2,
    answerBindingEnabled: true,
    replyStyle: "human",
    ...overrides,
  })
  return prompt
}

describe("运营追问提示词", () => {
  it("首次问题简短直答 后续追问先识别最新一句的沟通动作", () => {
    expect(answerStyleInstruction("initial")).toContain("首次回答")
    expect(answerStyleInstruction("initial")).toContain("直接说")
    expect(answerStyleInstruction("initial")).not.toContain("一到两行")
    expect(answerStyleInstruction("followup")).toContain("后续追问")
    expect(answerStyleInstruction("followup")).toContain("补充 纠正 催促还是质疑")
    expect(answerStyleInstruction("followup")).toContain("不再重复上一轮")
  })

  it("把发一下作为接口资料追问 并保留上下文判断", () => {
    expect(questionNeedsInterfaceDocumentation("正确接口发一下")).toBe(true)
    expect(questionNeedsInterfaceDocumentation("发一下", "上次的接口路径是什么")).toBe(true)
  })

  it("能否问法按真实动作意图分流 不统一当成是非题", () => {
    expect(questionRequestsFeatureChange("这个可以不可以加个功能")).toBe(true)
    expect(questionRequestsFeatureChange("这个可以加一个批量导出功能吗")).toBe(true)
    expect(questionRequestsFeatureChange("这个字段能改成必填吗")).toBe(true)
    expect(questionRequestsFeatureChange("这个字段能不能修改")).toBe(true)
    expect(questionRequestsFeatureChange("是否可以支持批量通知")).toBe(true)
    expect(questionRequestsFeatureChange("帮忙新增一个批量导出功能")).toBe(true)
    expect(questionRequestsFeatureChange("现在做不到批量导出")).toBe(true)
    expect(questionRequestsFeatureChange("这个时间段可以查看释放了几笔订单吗")).toBe(false)
    expect(questionRequestsFeatureChange("这笔订单能查到操作人吗")).toBe(false)
    expect(questionRequestsFeatureChange("这个账号能不能解冻")).toBe(false)
    expect(questionRequestsFeatureChange("这个功能能不能用")).toBe(false)
  })

  it("后续追问同时保留参考回复风格和结构化值保护", async () => {
    const prompt = await answerPrompt("followup")

    expect(prompt).toContain("后续追问")
    expect(prompt).toContain("短句优先")
    expect(prompt).toContain("使用自然群聊口语")
    expect(prompt).toContain("结构化业务值")
    expect(prompt).toContain("IPv6")
    expect(prompt).toContain("不是只问能力或许可")
    expect(prompt).toContain("技术上线后会解决")
    expect(prompt).toContain("核对操作人 操作时间 对象和结果")
  })

  it("后台真实模型会话使用和 Telegram 相同的交错角色上下文", () => {
    const base = {
      sessionId: "00000000-0000-4000-8000-000000000020",
      decision: "reply" as const,
      status: "completed" as const,
      investigation: {},
      decisionReason: null,
      decisionConfidence: null,
      codeRevision: null,
      codeSnapshotId: null,
      codeSyncBatchId: null,
      memoryVersionRefs: [],
      errorCode: null,
      generationStartedAt: null,
      attachments: [],
      corrections: [],
    }
    const first = {
      ...base,
      id: "00000000-0000-4000-8000-000000000021",
      position: 1,
      question: "mcbpay今天营收怎么样",
      answer: "先到对应服务入口查",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:10.000Z",
      completedAt: "2026-08-14T00:00:10.000Z",
    } satisfies AdminChatTurn
    const current = {
      ...base,
      id: "00000000-0000-4000-8000-000000000022",
      position: 2,
      question: "不也是你们团队吗",
      answer: "",
      status: "pending" as const,
      createdAt: "2026-08-14T00:01:00.000Z",
      updatedAt: "2026-08-14T00:01:00.000Z",
      completedAt: null,
    } satisfies AdminChatTurn

    const history = conversationHistory([first, current], current)

    expect(history).toContain("[运营 2026-08-14T00:00:00.000Z message_id=admin-chat:00000000-0000-4000-8000-000000000021]")
    expect(history).toContain("[客服 2026-08-14T00:00:10.000Z reply_id=admin-chat:00000000-0000-4000-8000-000000000021]")
    expect(history.indexOf("mcbpay今天营收怎么样")).toBeLessThan(history.indexOf("先到对应服务入口查"))
    expect(history).not.toContain("不也是你们团队吗")
  })

  it("后台会话保留失败和终止消息并压缩连续重试副本", () => {
    const base = {
      sessionId: "00000000-0000-4000-8000-000000000030",
      decision: null,
      investigation: {},
      decisionReason: null,
      decisionConfidence: null,
      codeRevision: null,
      codeSnapshotId: null,
      codeSyncBatchId: null,
      memoryVersionRefs: [],
      generationStartedAt: null,
      attachments: [],
      corrections: [],
      completedAt: null,
      answer: "",
      errorCode: null,
    }
    const failed = {
      ...base,
      id: "00000000-0000-4000-8000-000000000031",
      position: 1,
      question: "上游无法二次回调",
      status: "failed" as const,
      createdAt: "2026-08-17T12:19:00.000Z",
      updatedAt: "2026-08-17T12:19:10.000Z",
      errorCode: "failed",
    } satisfies AdminChatTurn
    const retried = {
      ...base,
      id: "00000000-0000-4000-8000-000000000032",
      position: 2,
      question: "上游无法二次回调",
      answer: "按成功明细逐笔核对后处理",
      decision: "reply" as const,
      status: "completed" as const,
      createdAt: "2026-08-17T12:19:11.000Z",
      updatedAt: "2026-08-17T12:21:00.000Z",
      completedAt: "2026-08-17T12:21:00.000Z",
    } satisfies AdminChatTurn
    const cancelled = {
      ...base,
      id: "00000000-0000-4000-8000-000000000033",
      position: 3,
      question: "今天出现两次了",
      status: "cancelled" as const,
      createdAt: "2026-08-17T12:30:00.000Z",
      updatedAt: "2026-08-17T12:30:05.000Z",
    } satisfies AdminChatTurn
    const current = {
      ...base,
      id: "00000000-0000-4000-8000-000000000034",
      position: 4,
      question: "今天之前没有出现过",
      status: "pending" as const,
      createdAt: "2026-08-17T12:31:00.000Z",
      updatedAt: "2026-08-17T12:31:00.000Z",
    } satisfies AdminChatTurn

    const history = conversationHistory([failed, retried, cancelled, current], current)

    expect(history.match(/上游无法二次回调/gu)).toHaveLength(1)
    expect(history).toContain("按成功明细逐笔核对后处理")
    expect(history).toContain("今天出现两次了")
    expect(history).not.toContain("reply_id=admin-chat:00000000-0000-4000-8000-000000000033")
  })

  it("失败轮次原文在立即重试时只作为当前消息出现一次", () => {
    const shared = {
      sessionId: "00000000-0000-4000-8000-000000000060",
      question: "咱们后台的26笔订单在上游后台都是成功的",
      answer: "",
      decision: null,
      investigation: {},
      decisionReason: null,
      decisionConfidence: null,
      codeRevision: null,
      codeSnapshotId: null,
      codeSyncBatchId: null,
      memoryVersionRefs: [],
      generationStartedAt: null,
      attachments: [],
      corrections: [],
      completedAt: null,
    }
    const failed = {
      ...shared,
      id: "00000000-0000-4000-8000-000000000061",
      position: 1,
      status: "failed" as const,
      errorCode: "failed",
      createdAt: "2026-08-17T12:18:00.000Z",
      updatedAt: "2026-08-17T12:18:30.000Z",
    } satisfies AdminChatTurn
    const retry = {
      ...shared,
      id: "00000000-0000-4000-8000-000000000062",
      position: 2,
      status: "pending" as const,
      errorCode: null,
      createdAt: "2026-08-17T12:19:00.000Z",
      updatedAt: "2026-08-17T12:19:00.000Z",
    } satisfies AdminChatTurn

    expect(conversationHistory([failed, retry], retry)).toBe("")
  })

  it("整段粘贴记录只把最后一条 Telegram 消息作为直接回应目标", () => {
    const transcript = [
      "[2026-08-17 20:19] 白马王子: 上游无法二次回调",
      "",
      "08/17 20:21",
      "AI 客服",
      "上游没有发送最终回调",
      "青蛙王子, [Aug 17, 2026 at 20:27:00]:",
      "要再观察下这种情况出现的几率有多大",
      "",
      "白马王子, [Aug 17, 2026 at 20:30:28]:",
      "今天出现两次  都是几十单",
      "",
      "今天之前没有出现过",
      "",
      "08/17 20:31",
      "AI 正在排查",
    ].join("\n")

    expect(latestAdminChatMessage(transcript)).toBe("今天出现两次  都是几十单\n\n今天之前没有出现过")
    expect(latestAdminChatMessage("直接问一句")).toBe("直接问一句")
  })

  it("同代码快照复用最近完成排查检查点并在提示词说明时点边界", async () => {
    const checkpoint = {
      id: "00000000-0000-4000-8000-000000000041",
      completedAt: "2026-08-17T12:21:00.000Z",
      codeSnapshotId: "00000000-0000-4000-8000-000000000042",
      codeRevision: "abc123",
      investigation: { summary: "已核对回调记录", steps: [] },
    }
    const prompt = await answerPrompt("followup", {
      latestMessage: "今天出现两次 都是几十单",
      priorInvestigation: checkpoint,
    })

    expect(prompt).toContain("上一轮持久化排查检查点")
    expect(prompt).toContain("已核对回调记录")
    expect(prompt).toContain("不要无意义重复相同查询")
    expect(prompt).toContain("回调是否后来到达")
    expect(prompt).toContain("本轮唯一需要直接回应的最新消息：今天出现两次 都是几十单")
  })

  it("最近完成且有快照的轮次才会成为后台排查检查点", () => {
    const current = {
      id: "00000000-0000-4000-8000-000000000053",
      sessionId: "00000000-0000-4000-8000-000000000050",
      position: 3,
      question: "继续",
      answer: "",
      decision: null,
      status: "pending" as const,
      investigation: {},
      decisionReason: null,
      decisionConfidence: null,
      codeRevision: null,
      codeSnapshotId: null,
      codeSyncBatchId: null,
      memoryVersionRefs: [],
      errorCode: null,
      createdAt: "2026-08-17T12:30:00.000Z",
      updatedAt: "2026-08-17T12:30:00.000Z",
      generationStartedAt: null,
      completedAt: null,
      attachments: [],
      corrections: [],
    } satisfies AdminChatTurn
    const completed = {
      ...current,
      id: "00000000-0000-4000-8000-000000000051",
      position: 1,
      question: "第一轮",
      answer: "结果",
      decision: "reply" as const,
      status: "completed" as const,
      investigation: { summary: "可信排查" },
      codeRevision: "abc123",
      codeSnapshotId: "00000000-0000-4000-8000-000000000054",
      createdAt: "2026-08-17T12:20:00.000Z",
      updatedAt: "2026-08-17T12:21:00.000Z",
      completedAt: "2026-08-17T12:21:00.000Z",
    } satisfies AdminChatTurn
    const failed = {
      ...current,
      id: "00000000-0000-4000-8000-000000000052",
      position: 2,
      question: "失败轮次",
      status: "failed" as const,
      investigation: { summary: "未完成" },
      codeSnapshotId: "00000000-0000-4000-8000-000000000055",
      errorCode: "failed",
      createdAt: "2026-08-17T12:22:00.000Z",
      updatedAt: "2026-08-17T12:23:00.000Z",
    } satisfies AdminChatTurn

    expect(latestInvestigationCheckpoint([completed, failed, current], current)).toMatchObject({
      id: completed.id,
      codeSnapshotId: completed.codeSnapshotId,
      investigation: { summary: "可信排查" },
    })
  })

  it("最新消息没要求统计时拦截自行计算比例", () => {
    expect(answerIntroducesUnrequestedDerivedStatistics(
      "今天出现两次 都是几十单 今天之前没有出现过",
      "按31笔/7553笔计算 今天约0.41%",
    )).toBe(true)
    expect(answerIntroducesUnrequestedDerivedStatistics(
      "这种情况出现的几率有多大",
      "按31笔/7553笔计算 今天约0.41%",
    )).toBe(false)
    expect(answerIntroducesUnrequestedDerivedStatistics(
      "今天出现两次 都是几十单",
      "今天已经连续出现两批 需要按批量异常处理",
    )).toBe(false)
  })

  it("上游返回报错只能作为带来源说明的初步判断", () => {
    const decision = {
      decision: "reply",
      escalationType: "none",
      answer: "ADPay账户余额不足",
      quote: null,
      reason: "ADPay返回提示余额不足 据此判断是余额原因",
      confidence: 0.7,
      usedMemoryVersionIds: [],
      investigation: {
        summary: "根据返回推断",
        steps: [{
          source: "inference",
          title: "原因判断",
          status: "confirmed",
          evidence: "ADPay返回提示余额不足",
          conclusion: "根据返回推测余额是当前原因",
        }],
      },
    } satisfies AnswerDecision

    expect(upstreamReturnedErrorInferenceNeedsQualification(
      "ADPay上游返回提示余额不足",
      undefined,
      decision,
    )).toBe(true)
    expect(answerQualifiesUpstreamReturnedInference("ADPay账户余额不足")).toBe(false)
    expect(answerQualifiesUpstreamReturnedInference(
      "ADPay返回提示我方账户余额不足 当前只是根据ADPay返回作出的初步判断",
    )).toBe(true)
  })

  it("上游返回余额不足时识别为我方在上游的账户余额", () => {
    const question = "ADPay上游返回错误信息：余额不足"

    expect(upstreamBalanceErrorMisattributesResponsibility(
      question,
      undefined,
      "ADPay自身余额不足 不是我们的问题",
    )).toBe(true)
    expect(upstreamBalanceErrorMisattributesResponsibility(
      question,
      undefined,
      "ADPay返回提示我方在ADPay的账户余额不足 当前只是根据ADPay返回作出的初步判断",
    )).toBe(false)
  })

  it("外部唯一根源被代码和运行证据确认后必须明确排除我方问题", () => {
    const decision = {
      decision: "reply",
      escalationType: "none",
      answer: "商户没有发起这笔下单",
      quote: null,
      reason: "商户未下单且已排除我方处理异常",
      confidence: 0.95,
      usedMemoryVersionIds: [],
      investigation: {
        summary: "外部原因已交叉确认",
        steps: [{
          source: "code",
          title: "核对下单入口",
          status: "confirmed",
          evidence: "当前代码确认请求入口和订单落库关系",
          conclusion: "收到商户请求后才会生成订单",
        }, {
          source: "server",
          title: "核对入口记录",
          status: "not_found",
          evidence: "服务器入口没有商户下单记录",
          conclusion: "商户未发起对应下单",
        }, {
          source: "database",
          title: "核对订单记录",
          status: "not_found",
          evidence: "数据库没有对应订单",
          conclusion: "商户未下单且我方没有处理对象",
        }, {
          source: "inference",
          title: "交叉结论",
          status: "confirmed",
          evidence: "代码 入口和数据库结果一致",
          conclusion: "唯一根源是商户未下单 已排除我方处理异常",
        }],
      },
    } satisfies AnswerDecision

    expect(hasVerifiedExternalCauseEvidence(decision)).toBe(true)
    expect(answerExplicitlyClearsOurResponsibility(decision.answer)).toBe(false)
    expect(answerExplicitlyClearsOurResponsibility(
      "商户没有发起这笔下单 不是我方系统处理失败",
    )).toBe(true)
  })
})
