import { describe, expect, it } from "vitest"

import {
  classifyThreadRouteResultJsonSchema,
  classifyThreadRouteResultSchema,
  resolveThreadRouteResultJsonSchema,
  resolveThreadRouteResultSchema,
  type AnswerDecision,
} from "../../src/codex/schemas.js"
import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import { latestAdminChatMessage } from "../../src/admin-chat/worker.js"
import {
  hasVerifiedTechnicalEscalation,
  responsibilityGroundingReasons,
} from "../../src/support/investigation-service.js"

const thirdPartyResults = [
  "HTTP 200", "HTTP 400", "HTTP 401", "HTTP 403", "HTTP 404",
  "HTTP 405", "HTTP 408", "HTTP 409", "HTTP 429", "HTTP 500",
  "HTTP 502", "HTTP 503", "HTTP 504", "HTTP 520", "HTTP 521",
  "HTTP 522", "HTTP 524", "业务码 E1001", "业务码 UNKNOWN_77", "空响应",
] as const

const responsePhenomena = [
  (result: string) => `上游返回 ${result}`,
  (result: string) => `通道响应 ${result}`,
  (result: string) => `第三方接口报错 ${result}`,
  (result: string) => `请求上游时收到 ${result}`,
  (result: string) => `上游拒绝请求并返回 ${result}`,
  (result: string) => `调用第三方后超时，最后记录为 ${result}`,
] as const

const responsibilityScenarios = thirdPartyResults.flatMap((result) => responsePhenomena.map((render, index) => ({
  label: `${result}-${index + 1}`,
  phenomenon: render(result),
})))

function decision(input: Partial<AnswerDecision> = {}): AnswerDecision {
  return {
    decision: "reply",
    escalationType: "none",
    answer: "这次算我方处理问题",
    quote: null,
    reason: "仅看到第三方响应现象",
    confidence: 0.5,
    usedMemoryVersionIds: [],
    responsibility: {
      party: "our_side",
      certainty: "inference",
      evidenceSources: ["message"],
    },
    investigation: {
      summary: "只取得消息中的响应现象",
      steps: [{
        source: "message",
        title: "读取本轮问题",
        status: "confirmed",
        evidence: "第三方返回异常",
        conclusion: "只能确认第三方返回了该内容",
      }],
    },
    ...input,
  }
}

describe("第三方响应不能直接归为我方责任的通用门禁", () => {
  it("覆盖的独立责任场景不少于100种", () => {
    expect(responsibilityScenarios).toHaveLength(120)
  })

  it.each(responsibilityScenarios)("拦截 $label 仅凭响应现象认定我方责任", ({ phenomenon }) => {
    const candidate = decision({
      reason: phenomenon,
      investigation: {
        summary: "只取得第三方响应",
        steps: [{
          source: "message",
          title: "读取本轮问题",
          status: "confirmed",
          evidence: phenomenon,
          conclusion: "只确认响应现象，未确认责任",
        }],
      },
    })

    expect(responsibilityGroundingReasons(candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining("实际代码检查和生产只读运行证据"),
      expect.stringContaining("responsibility 声明我方承担责任"),
    ]))
  })

  it("实际代码检查与生产数据库证据共同确认时才允许认定我方责任", () => {
    const candidate = decision({
      answer: "已确认是我方处理链路的问题",
      reason: "代码与当前订单数据共同确认内部状态转换遗漏",
      responsibility: {
        party: "our_side",
        certainty: "confirmed",
        evidenceSources: ["code", "database"],
      },
      investigation: {
        summary: "内部根源已由代码和当前数据共同确认",
        steps: [{
          source: "code",
          title: "执行代码只读检查",
          status: "confirmed",
          evidence: "实际命令=rg -n transition src/OrderService.ts\n退出码=0\n输出=src/OrderService.ts:18 transition missing",
          conclusion: "确认当前发布代码遗漏该状态转换",
        }, {
          source: "database",
          title: "父进程复核数据库只读查询",
          status: "confirmed",
          evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT status FROM orders WHERE id='X' LIMIT 1 返回行数=1",
          conclusion: "当前订单数据与代码缺陷一致",
        }],
      },
    })

    expect(responsibilityGroundingReasons(candidate)).toEqual([])
  })

  it("责任字段写未知但回答正文暗示我方责任时仍硬拦截", () => {
    expect(responsibilityGroundingReasons(decision({
      responsibility: { party: "unknown", certainty: "unknown", evidenceSources: ["message"] },
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("与 responsibility.party 不一致"),
    ]))
  })

  it("只有第三方返回时也不能反向确认第三方责任", () => {
    expect(responsibilityGroundingReasons(decision({
      answer: "上游返回了失败结果",
      responsibility: { party: "upstream", certainty: "confirmed", evidenceSources: ["message"] },
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("没有代码与多项生产只读证据"),
    ]))
  })

  it("外部责任只标推断时正文不能写成确定归责", () => {
    expect(responsibilityGroundingReasons(decision({
      answer: "这是上游的问题",
      responsibility: { party: "upstream", certainty: "inference", evidenceSources: ["message"] },
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("仅标为推断"),
    ]))
  })

  it("实际代码与两类运行证据确认外部根源后允许明确责任", () => {
    expect(responsibilityGroundingReasons(decision({
      answer: "商户没有发起这笔下单，不是我方问题",
      responsibility: {
        party: "merchant",
        certainty: "confirmed",
        evidenceSources: ["code", "log", "database"],
      },
      investigation: {
        summary: "商户未下单且已排除我方异常",
        steps: [{
          source: "code",
          title: "执行代码只读检查",
          status: "confirmed",
          evidence: "实际命令=rg -n createOrder src/OrderService.ts\n退出码=0\n输出=src/OrderService.ts:10 createOrder",
          conclusion: "确认收到请求后才创建订单",
        }, {
          source: "log",
          title: "执行限量日志检查",
          status: "not_found",
          evidence: "实际命令=rg ORDER-X app.log\n退出码=0\n输出=商户没有发起对应下单请求",
          conclusion: "商户未发送下单请求",
        }, {
          source: "database",
          title: "父进程复核数据库只读查询",
          status: "not_found",
          evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT id FROM orders WHERE id='ORDER-X' LIMIT 1 返回行数=0 商户没有对应订单",
          conclusion: "商户未下单，我方没有处理对象",
        }],
      },
    }))).toEqual([])
  })

  it("不是上游问题的否定表达不会被误判成外部归责", () => {
    expect(responsibilityGroundingReasons(decision({
      answer: "目前不能确认责任，这不是上游问题的已确认结论",
      responsibility: { party: "unknown", certainty: "unknown", evidenceSources: ["message"] },
    }))).toEqual([])
  })
})

describe("路由模式使用互斥输出协议", () => {
  const routeBase = {
    questionFragment: "这笔是谁的问题",
    reason: "承接当前问题",
    confidence: 1,
    clarificationReply: null,
  }

  it("分类模式拒绝 candidate_1 和 candidate_2", () => {
    expect(classifyThreadRouteResultSchema.safeParse({ ...routeBase, action: "candidate_1" }).success).toBe(false)
    expect(classifyThreadRouteResultSchema.safeParse({ ...routeBase, action: "candidate_2" }).success).toBe(false)
    expect(classifyThreadRouteResultJsonSchema.properties.action.enum).toEqual([
      "follow_up", "new_thread", "idle", "uncertain",
    ])
  })

  it("待确认回答模式拒绝 follow_up 并只允许候选协议", () => {
    expect(resolveThreadRouteResultSchema.safeParse({ ...routeBase, action: "follow_up" }).success).toBe(false)
    expect(resolveThreadRouteResultSchema.safeParse({ ...routeBase, action: "candidate_1" }).success).toBe(true)
    expect(resolveThreadRouteResultJsonSchema.properties.action.enum).toEqual([
      "candidate_1", "candidate_2", "new_thread", "idle", "uncertain",
    ])
  })
})

describe("后台粘贴记录只回应最后一条真实消息", () => {
  it("从问题版本界面记录中提取末尾责任追问", () => {
    const transcript = `DF202608182050232600932
DAPay · 问题版本 v2 · 08/18 23:27

起始问题
08/18 23:23
DF202608182050232600932

AI 处理结果
已回复
08/18 23:33
这笔已经成功，最初上游返回 HTTP 520，后来重新派发成功。

这个订单是你们问题吗`

    expect(latestAdminChatMessage(transcript)).toBe("这个订单是你们问题吗")
  })
})

describe("产品需求升级必须来自最新一句明确改动请求", () => {
  const snapshot: ProjectCodeSnapshot = {
    projectId: "00000000-0000-4000-8000-000000000001",
    serviceId: "00000000-0000-4000-8000-000000000002",
    service: "service",
    branch: "main",
    commit: "a".repeat(40),
    snapshotId: "00000000-0000-4000-8000-000000000003",
    syncBatchId: "00000000-0000-4000-8000-000000000004",
    configurationFingerprint: "test",
    syncState: "fresh",
    failure: null,
    publishedAt: "2026-08-18T00:00:00.000Z",
    workspacePath: "/tmp/test",
    repositories: [],
  }
  const feature = decision({
    decision: "escalate",
    escalationType: "feature_request",
    answer: "已经通知技术，技术上线后会解决",
    reason: "[产品改动需求]\n准备增加自动恢复功能",
    investigation: {
      summary: "读取最新消息",
      steps: [{
        source: "message",
        title: "读取本轮问题",
        status: "confirmed",
        evidence: "这个订单是你们问题吗",
        conclusion: "用户在追问责任",
      }],
    },
  })

  it("责任追问不能伪装成产品改动需求", () => {
    expect(hasVerifiedTechnicalEscalation(
      feature,
      snapshot,
      "历史里提到自动恢复，最新只问责任",
      "这个订单是你们问题吗",
    )).toBe(false)
  })

  it("最新一句明确要求新增功能时才允许产品需求升级", () => {
    expect(hasVerifiedTechnicalEscalation(
      feature,
      snapshot,
      "能不能加一个自动恢复功能",
      "能不能加一个自动恢复功能",
    )).toBe(true)
  })
})
