import { describe, expect, it } from "vitest"

import { answerDecisionSchema, type AnswerDecision } from "../../src/codex/schemas.js"
import type { ProjectCodeSnapshot } from "../../src/git-sync/project-service.js"
import {
  escalationAnswerIsConcrete,
  hasVerifiedServiceHandoff,
  hasVerifiedTechnicalEscalation,
} from "../../src/support/investigation-service.js"

const snapshot: ProjectCodeSnapshot = {
  projectId: "00000000-0000-4000-8000-000000000001",
  serviceId: "00000000-0000-4000-8000-000000000002",
  service: "service",
  branch: "main",
  commit: "a".repeat(40),
  snapshotId: "00000000-0000-4000-8000-000000000003",
  syncBatchId: "00000000-0000-4000-8000-000000000004",
  configurationFingerprint: "test-fingerprint",
  syncState: "fresh",
  failure: null,
  publishedAt: "2026-08-12T00:00:00.000Z",
  workspacePath: "/tmp/test-snapshot",
  repositories: [],
}

function technicalDecision(steps: AnswerDecision["investigation"]["steps"]): AnswerDecision {
  return {
    decision: "escalate",
    escalationType: "technical_change",
    answer: "已确认 bank_mapping 映射缺失 需要补齐",
    quote: null,
    reason: "[已确认技术处理] 类型=后台映射 bank_mapping 缺失 已核对代码和当前数据",
    confidence: 1,
    usedMemoryVersionIds: [],
    investigation: { summary: "根源已确认", steps },
  }
}

function serviceHandoffDecision(target = "mcbpay"): AnswerDecision {
  return {
    decision: "escalate",
    escalationType: "service_handoff",
    answer: "行 我已经通知技术同事接手了 后面让他们直接跟你对接",
    quote: null,
    reason: `[跨服务人工接管] 服务=${target}\n运营明确要求同一团队接手 不再重复要求换群`,
    confidence: 1,
    usedMemoryVersionIds: [],
    interaction: {
      sentiment: "frustrated",
      situation: "scope_boundary",
      underlyingNeed: "由同一团队直接接手查询mcbpay营收",
      responseStrategy: "boundary_with_next_step",
    },
    investigation: {
      summary: "运营在跨服务边界说明后仍要求同一团队接手",
      steps: [{
        source: "message",
        title: "读取跨服务后续诉求",
        status: "confirmed",
        evidence: "mcbpay的团队不也是你们吗 到时候还是来问你们",
        conclusion: "需要转人工接管",
      }],
    },
  }
}

describe("技术升级证据门禁", () => {
  it("产品改动必须已通知技术并说明技术上线后解决", () => {
    const decision = answerDecisionSchema.parse({
      decision: "escalate",
      escalationType: "feature_request",
      answer: "已经通知技术了，技术上线后会解决",
      quote: null,
      reason: "[产品改动需求]\n运营要求新增功能",
      confidence: 1,
      usedMemoryVersionIds: [],
      investigation: {
        summary: "这是产品改动需求",
        steps: [{
          source: "message",
          title: "读取本轮需求",
          status: "confirmed",
          evidence: "这个可以不可以加个功能",
          conclusion: "需要通知技术",
        }],
      },
    })

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(true)
    expect(hasVerifiedTechnicalEscalation({ ...decision, answer: "已经通知技术了" }, snapshot)).toBe(false)
    expect(hasVerifiedTechnicalEscalation({ ...decision, answer: "技术上线后会解决" }, snapshot)).toBe(false)
  })

  it("跨服务首问不能直接升级 后续坚持由同一团队接手才允许升级", () => {
    const decision = serviceHandoffDecision()
    const services = [
      { key: "lakpay", name: "LakPay" },
      { key: "mcbpay", name: "MCBPay" },
    ]
    const question = "mcbpay今天营收怎么样\n\nmcbpay的团队不也是你们吗 到时候还是来问你们"

    expect(hasVerifiedServiceHandoff(decision, "lakpay", services, question, "initial")).toBe(false)
    expect(hasVerifiedServiceHandoff(decision, "lakpay", services, question, "followup")).toBe(true)
  })

  it("身份质疑可以承接同一线程中的目标服务并升级", () => {
    const decision = serviceHandoffDecision("MCBPay")
    decision.interaction = {
      sentiment: "hostile",
      situation: "identity_challenge",
      underlyingNeed: "不要继续推群而是由团队接手",
      responseStrategy: "service_recovery",
    }
    const question = "mcbpay今天营收怎么样\n\n你是机器人吗 非要这么死板"

    expect(hasVerifiedServiceHandoff(decision, "lakpay", [
      { key: "lakpay", name: "LakPay" },
      { key: "mcbpay", name: "MCBPay" },
    ], question, "followup")).toBe(true)
  })

  it("未知服务 当前服务和没有明确坚持的后续都不能借人工接管越过边界", () => {
    const services = [
      { key: "lakpay", name: "LakPay" },
      { key: "mcbpay", name: "MCBPay" },
    ]
    expect(hasVerifiedServiceHandoff(
      serviceHandoffDecision("unknown"), "lakpay", services,
      "unknown也是你们团队 你们接手", "followup",
    )).toBe(false)
    expect(hasVerifiedServiceHandoff(
      serviceHandoffDecision("lakpay"), "lakpay", services,
      "lakpay也是你们团队 你们接手", "followup",
    )).toBe(false)
    expect(hasVerifiedServiceHandoff(
      serviceHandoffDecision(), "lakpay", services,
      "mcbpay今天营收怎么样", "followup",
    )).toBe(false)
  })

  it("只接受实际代码读取与精确可信运行观测的组合", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=rg -n bank_mapping src/BankMappingService.ts\n退出码=0\n输出=src/BankMappingService.ts:12 bank_mapping",
      conclusion: "确认字段由后台映射派生",
    }, {
      source: "database",
      title: "父进程复核数据库只读查询",
      status: "confirmed",
      evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT EXISTS(SELECT 1 FROM bank_mapping WHERE bank_code='MAYA') AS mapping_exists 返回行数=1 截断=否 样本=[{\"mapping_exists\":0}]",
      conclusion: "需要技术写入映射",
    }])

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(true)
  })

  it("快照元数据 泛化服务器预检和模型自报步骤不能触发升级", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "读取当前双仓快照",
      status: "confirmed",
      evidence: "snapshot metadata",
      conclusion: "已取得快照",
    }, {
      source: "server",
      title: "执行绑定服务器只读预检",
      status: "confirmed",
      evidence: "nginx routes",
      conclusion: "预检成功",
    }, {
      source: "inference",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "模型自报",
      conclusion: "模型认为已查过",
    }])

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(false)
  })

  it("无关代码和运行观测不能为声明的后台映射根因背书", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=sed -n 1,20p README.md\n退出码=0\n输出=项目说明",
      conclusion: "读取了无关说明",
    }, {
      source: "server",
      title: "执行服务器只读检查",
      status: "confirmed",
      evidence: "实际命令=ssh support-1 uptime\n退出码=0\n输出=up 10 days",
      conclusion: "服务器在线",
    }])

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(false)
  })

  it("代码命令带关键词和源码路径但输出只命中文档时不能升级", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=rg -n bank_mapping src/Unrelated.ts README.md\n退出码=0\n输出=README.md:8 bank_mapping 是映射表",
      conclusion: "只有说明文档命中",
    }, {
      source: "database",
      title: "父进程复核数据库只读查询",
      status: "confirmed",
      evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT EXISTS(SELECT 1 FROM bank_mapping) AS mapping_exists 返回行数=1 截断=否 样本=[{\"mapping_exists\":0}]",
      conclusion: "运行侧查询完成",
    }])

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(false)
  })

  it("声明的具体根因标识必须同时出现在代码与运行证据中", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=rg -n bank_mapping src/BankMappingService.ts\n退出码=0\n输出=src/BankMappingService.ts:12 bank_mapping",
      conclusion: "代码读取完成",
    }, {
      source: "database",
      title: "父进程复核数据库只读查询",
      status: "confirmed",
      evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT EXISTS(SELECT 1 FROM bank_mapping) AS mapping_exists 返回行数=1 截断=否 样本=[{\"mapping_exists\":0}]",
      conclusion: "运行查询完成",
    }])
    decision.reason = "[已确认技术处理] 类型=后台映射 PSP_X currency_mapping 缺失"
    decision.answer = "PSP_X币种映射没配上 需要补齐"

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(false)
  })

  it("运行结果明确显示映射存在时不能反向声明映射缺失", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=rg -n bank_mapping src/BankMappingService.ts\n退出码=0\n输出=src/BankMappingService.ts:12 bank_mapping",
      conclusion: "代码读取完成",
    }, {
      source: "database",
      title: "父进程复核数据库只读查询",
      status: "confirmed",
      evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT EXISTS(SELECT 1 FROM bank_mapping) AS mapping_exists 返回行数=1 截断=否 样本=[{\"mapping_exists\":1}]",
      conclusion: "映射实际存在",
    }])

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(false)
  })

  it("不同映射只共享 enabled 泛字段时不能互相背书", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=rg -n enabled src/BankMappingService.ts\n退出码=0\n输出=src/BankMappingService.ts:12 bank_mapping enabled",
      conclusion: "代码读取完成",
    }, {
      source: "database",
      title: "父进程复核数据库只读查询",
      status: "confirmed",
      evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT enabled FROM currency_mapping 返回行数=1 截断=否 样本=[{\"enabled\":0}]",
      conclusion: "币种映射未启用",
    }])
    decision.reason = "[已确认技术处理] 类型=后台映射 bank_mapping enabled 没启用"
    decision.answer = "MAYA bank_mapping enabled 没启用"

    expect(hasVerifiedTechnicalEscalation(decision, snapshot)).toBe(false)
  })

  it("fallback 代码快照不能确认需要写入的技术变更", () => {
    const decision = technicalDecision([{
      source: "code",
      title: "执行代码只读检查",
      status: "confirmed",
      evidence: "实际命令=rg -n bank_mapping src/BankMappingService.ts\n退出码=0\n输出=src/BankMappingService.ts:12 bank_mapping",
      conclusion: "确认字段由后台映射派生",
    }, {
      source: "database",
      title: "父进程复核数据库只读查询",
      status: "confirmed",
      evidence: "父进程经绑定服务器重新执行 只读SQL=SELECT bank_code FROM bank_mapping 返回行数=1 截断=否 样本=[]",
      conclusion: "映射记录缺失",
    }])

    expect(hasVerifiedTechnicalEscalation(decision, { ...snapshot, syncState: "fallback" })).toBe(false)
  })

  it("升级运营答案必须是具体业务根因且不能夹带技术处理状态", () => {
    for (const answer of [
      "技术正在处理 请等待",
      "会让开发处理",
      "已经反馈给技术",
      "交给研发排查",
      "请稍等",
      "服务异常",
      "数据有问题",
      "代码错误",
      "这个代码错误",
      "这个字段错了",
      "服务配置错误",
      "订单字段错误",
      "银行映射错误",
      "通道配置不一致",
    ]) expect(escalationAnswerIsConcrete(answer)).toBe(false)

    expect(escalationAnswerIsConcrete("maya银行映射没配上 需要补齐映射")).toBe(true)
    expect(escalationAnswerIsConcrete("风控判断反了 需要修复")).toBe(true)
    expect(escalationAnswerIsConcrete("提现手续费逻辑漏了 需要修复")).toBe(true)
  })

  it("结构化协议强制升级类型与决策一致", () => {
    const base = {
      answer: "已确认结论",
      quote: null,
      reason: "已确认证据",
      confidence: 1,
      usedMemoryVersionIds: [],
      investigation: {
        summary: "已确认",
        steps: [{
          source: "message",
          title: "读取问题",
          status: "confirmed",
          evidence: "原消息",
          conclusion: "已读取",
        }],
      },
    } as const

    expect(answerDecisionSchema.safeParse({ ...base, decision: "reply", escalationType: "none" }).success).toBe(true)
    expect(answerDecisionSchema.safeParse({ ...base, decision: "reply", escalationType: "technical_change" }).success).toBe(false)
    expect(answerDecisionSchema.safeParse({ ...base, decision: "escalate", escalationType: "none" }).success).toBe(false)
    expect(answerDecisionSchema.safeParse({
      ...base, decision: "escalate", escalationType: "service_handoff",
    }).success).toBe(true)
    expect(answerDecisionSchema.safeParse({
      ...base, decision: "escalate", escalationType: "technical_change", answer: "",
    }).success).toBe(false)
  })
})
