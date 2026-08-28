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
  it("调查提示词完整声明 v2 交易绑定语义且不依赖事故业务名称", async () => {
    const execute = vi.fn().mockResolvedValue({})
    const agent = new CodexSupportDecisionAgent({ execute } as never)

    await agent.decide(input("核对这笔交易"))

    const prompt = String(execute.mock.calls[0]?.[1]?.prompt)
    expect(prompt).toContain("evidencePacket.version 必须为 2")
    expect(prompt).toContain("answerClaims 中每项必须填写对应 factId")
    expect(prompt).toContain("除 decision=ignore 外，answerClaims 和 evidencePacket.facts 都至少填写一项")
    expect(prompt).toContain("subjectKind")
    expect(prompt).toContain("businessType")
    expect(prompt).toContain("matchedIdentifiers")
    expect(prompt).toContain("lookupHints")
    expect(prompt).toContain("associationId")
    expect(prompt).toContain("conflicts")
    expect(prompt).toContain("dependsOnFactIds")
    expect(prompt).toContain("大小写、前导零、连字符")
    expect(prompt).toContain("每条 fact.evidence 必须从同一个本轮可信来源 observation 的结果正文中逐字复制短摘录")
    expect(prompt).toContain("memory 只能使用 memory")
    expect(prompt).toContain("user_report 只能使用 message 且 certainty=reported")
    expect(prompt).toContain("request、response、callback、runtime 只能使用 server、log、database 或 redis")
    expect(prompt).toContain("responsibility.factIds")
    expect(prompt).toContain("recommendation 只能表达处理建议，不能承载已确认事实、运行核验事实或责任依据")
    expect(prompt).toContain("provenance=inference、evidenceSource=inference 和 certainty=inferred")
    expect(prompt).toContain("display/message/reported、subjectKind=general、businessType=not_applicable")
    expect(prompt).toContain("associationId=null、dependsOnFactIds=[]")
    expect(prompt).toContain("截图也不能作为稳定标识匹配端点")
    expect(prompt).toContain("不能证明当前交易状态、当前配置、责任或提供稳定交易标识")
    expect(prompt).toContain("实际命令、SQL 查询条件、退出码、返回行数、步骤标题、memoryVersionId 和记忆标题")
    expect(prompt).toContain("所有非 transaction 事实 associationId 必须为 null")
    expect(prompt).not.toMatch(/XDPay|AOHPay|DevaPay/u)
  })

  it("生产调查拒绝旧版证据包和缺少事实引用的模型输出", async () => {
    const execute = vi.fn(async (_purpose: string, execution: {
      validator: { parse(value: unknown): unknown }
    }) => execution.validator.parse({
      decision: "reply",
      escalationType: "none",
      humanOperation: null,
      answer: "旧版回答",
      quote: null,
      reason: "旧版结构",
      confidence: 1,
      usedMemoryVersionIds: [],
      answerClaims: [{
        statement: "旧版回答",
        provenance: "user_report",
        evidenceSource: "message",
        evidence: "旧版消息",
      }],
      responsibility: { party: "unknown", certainty: "unknown", evidenceSources: ["message"], factIds: [] },
      interaction: {
        sentiment: "neutral",
        situation: "new_request",
        underlyingNeed: "测试严格协议",
        responseStrategy: "direct_answer",
      },
      investigation: {
        summary: "旧版调查",
        steps: [{
          source: "message",
          title: "读取消息",
          status: "confirmed",
          evidence: "旧版消息",
          conclusion: "只取得旧版结构",
        }],
      },
      evidencePacket: {
        version: "1",
        communication: { intent: "direct_answer", recipient: null, desiredOutcome: "旧版输出" },
        facts: [],
        requiredAnswerPoints: ["回答问题"],
        unknowns: [],
        handlingNotes: [],
        reviewLevel: "standard",
      },
    }))
    const agent = new CodexSupportDecisionAgent({ execute } as never)

    await expect(agent.decide(input("测试模型协议"))).rejects.toThrow()
  })

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
    const decision = {
      decision: "reply" as const,
      escalationType: "none" as const,
      humanOperation: null,
      responsibility: {
        party: "unknown" as const,
        certainty: "unknown" as const,
        evidenceSources: [],
        factIds: [],
      },
      interaction: {
        sentiment: "neutral" as const,
        situation: "new_request" as const,
        underlyingNeed: "解释查单状态更新条件",
        responseStrategy: "direct_answer" as const,
      },
    }
    const evidencePacket = {
      version: "2" as const,
      communication: { intent: "direct_answer" as const, recipient: null, desiredOutcome: "解释查单状态更新条件" },
      facts: [{
        id: "F1" as const,
        statement: "自动处理开关开启并取得终态时，主动查单可更新订单状态。",
        provenance: "code" as const,
        evidenceSource: "code" as const,
        evidence: "当前发布代码中的条件分支",
        certainty: "confirmed" as const,
        outboundSafe: true,
        subjectKind: "general" as const,
        businessType: "not_applicable" as const,
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }],
      associations: [],
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
      trustedInvestigation: {
        summary: "宿主已生成可信调查轨迹",
        steps: [{
          source: "code",
          title: "执行代码只读检查",
          status: "confirmed",
          evidence: "实际命令=rg --files 当前代码目录",
          conclusion: "父进程已校验实际代码只读 observation",
        }],
      },
      baseline: { answer: "基线", quote: null, answerClaims: [], usedMemoryVersionIds: [] },
      candidate,
      attempt: 1,
    })

    const composePrompt = String(execute.mock.calls[0]?.[1]?.prompt)
    const reviewPrompt = String(execute.mock.calls[1]?.[1]?.prompt)
    expect(composePrompt).toContain("必须保留会改变结论的条件")
    expect(composePrompt).toContain("对方无法独立复核或本题不需要的请求体/响应体哈希、字节数")
    expect(composePrompt).toContain("usedMemoryVersionIds 必须设为 []")
    expect(composePrompt).toContain("运营前面正在核对同一笔订单")
    expect(composePrompt).not.toContain("有效记忆：")
    expect(reviewPrompt).toContain("禁止把有条件行为审核成无条件规则")
    expect(reviewPrompt).toContain("无关诊断元数据堆砌都不能 approve")
    expect(reviewPrompt).toContain("宿主可信调查轨迹")
    expect(reviewPrompt).toContain("只证明快照可用，不能证明任意 code 事实")
    expect(reviewPrompt).toContain("每个稳定标识值也必须逐字出现在同一结果正文")
    expect(reviewPrompt).toContain("报告性截图事实必须由你重新查看本轮原图核对")
    expect(reviewPrompt).toContain("不能采用模型自报或静默改写")
    expect(reviewPrompt).toContain("只审 responsibility.factIds 引用的具体事实是否在语义上支撑 party")
    expect(reviewPrompt).toContain("recommendation 只能表达处理建议，不能作为责任 factIds 或事实断言的依据")
    expect(reviewPrompt).toContain("memory 只证明本轮已检索记忆正文中存在该一般或配置知识")
    expect(reviewPrompt).toContain("实际命令=rg --files 当前代码目录")
    expect(execute.mock.calls[0]?.[1]?.concurrencyGroup).toBeUndefined()
    expect(execute.mock.calls[1]?.[1]?.concurrencyGroup).toBeUndefined()
  })

  it("调查、成稿和审核共享绑定身份、完整线程与人工规则，审核另见未引用 correction", async () => {
    const candidate = {
      answer: "消息里的另一个 Pay 就是当前绑定服务，可以直接失败订单。",
      quote: null,
      claims: [{ factId: "F1" as const, statement: "可以直接失败订单" }],
      usedMemoryVersionIds: [],
    }
    const execute = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce({
        outcome: "revise",
        issues: ["候选越过当前绑定服务且违反人工纠正"],
        reason: "必须按完整线程和当前服务边界重审",
      })
    const agent = new CodexSupportDecisionAgent({ execute } as never)
    const request = input("订单 M-SYNTHETIC 仍在处理中\n那可以失败吗")
    request.latestMessage = "那可以失败吗"
    request.conversationContext = "CONVERSATION-SENTINEL：前文明确仍可能继续出款"
    request.service = "BOUND-SERVICE-SENTINEL"
    request.scope = "BOUND-SCOPE-SENTINEL"
    request.region = "BOUND-REGION-SENTINEL"
    request.branch = "BOUND-BRANCH-SENTINEL"
    request.directives = [{
      id: "00000000-0000-4000-8000-000000000811",
      title: "DIRECTIVE-TITLE-SENTINEL",
      content: "DIRECTIVE-CONTENT-SENTINEL：仍可能出款时禁止指导失败",
      scope: request.scope,
      source: "human",
      priority: 100,
      enabled: true,
      createdAt: "2026-08-27T00:00:00.000Z",
      disabledAt: null,
    }]
    request.memories = [{
      id: "00000000-0000-4000-8000-000000000812",
      versionId: "00000000-0000-4000-8000-000000000812",
      factId: "00000000-0000-4000-8000-000000000813",
      version: 1,
      title: "CORRECTION-TITLE-SENTINEL",
      content: "CORRECTION-CONTENT-SENTINEL：不得把其他服务当作当前服务",
      scope: request.scope,
      region: request.region,
      branch: request.branch,
      source: "correction",
      risk: "low",
      confidence: 1,
      status: "active",
      conflictReason: null,
      validFrom: "2026-08-27T00:00:00.000Z",
      validTo: null,
      createdByEventId: "00000000-0000-4000-8000-000000000814",
      createdAt: "2026-08-27T00:00:00.000Z",
      topicKey: "b".repeat(64),
      currentVersionId: "00000000-0000-4000-8000-000000000812",
      evidenceCount: 1,
      previousVersionCount: 0,
    }]
    const decision = {
      decision: "reply" as const,
      escalationType: "none" as const,
      humanOperation: null,
      responsibility: { party: "unknown" as const, certainty: "unknown" as const, evidenceSources: [], factIds: [] },
      interaction: {
        sentiment: "neutral" as const,
        situation: "followup" as const,
        underlyingNeed: "确认具体订单是否可安全失败",
        responseStrategy: "direct_answer" as const,
      },
    }
    const evidencePacket = {
      version: "2" as const,
      communication: { intent: "direct_answer" as const, recipient: null, desiredOutcome: "安全回应承接问题" },
      facts: [{
        id: "F1" as const,
        statement: "仍可能继续出款时不能确认失败安全",
        provenance: "code" as const,
        evidenceSource: "code" as const,
        evidence: "当前代码中的资金安全前置条件",
        certainty: "confirmed" as const,
        outboundSafe: true,
        subjectKind: "general" as const,
        businessType: "not_applicable" as const,
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }],
      associations: [],
      requiredAnswerPoints: ["回应具体订单是否可失败"],
      unknowns: ["当前上游最终状态"],
      handlingNotes: ["不得越过当前绑定服务"],
      reviewLevel: "strict" as const,
    }

    await agent.decide(request)
    await agent.composeReply({ request, decision, evidencePacket })
    const review = await agent.reviewReply({
      request,
      decision,
      evidencePacket,
      trustedInvestigation: { summary: "可信轨迹", steps: [] },
      baseline: { answer: "基线", quote: null, answerClaims: [], usedMemoryVersionIds: [] },
      candidate,
      attempt: 1,
    })

    const prompts = execute.mock.calls.map((call) => String(call[1]?.prompt))
    for (const prompt of prompts) {
      expect(prompt).toContain("BOUND-SERVICE-SENTINEL")
      expect(prompt).toContain("BOUND-SCOPE-SENTINEL")
      expect(prompt).toContain("CONVERSATION-SENTINEL")
      expect(prompt).toContain("订单 M-SYNTHETIC 仍在处理中")
      expect(prompt).toContain("本轮唯一需要直接回应的最新消息：那可以失败吗")
      expect(prompt).toContain("DIRECTIVE-CONTENT-SENTINEL")
    }
    expect(prompts[2]).toContain("CORRECTION-CONTENT-SENTINEL")
    expect(prompts[2]).toContain('"usedMemoryVersionIds":[]')
    expect(review).toMatchObject({ outcome: "revise" })
  })
})
