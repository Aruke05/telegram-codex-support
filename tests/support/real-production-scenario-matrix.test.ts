import { describe, expect, it } from "vitest"

import {
  classifyThreadRouteResultSchema,
} from "../../src/codex/schemas.js"
import { latestAdminChatMessage } from "../../src/admin-chat/worker.js"
import { systemDirectivesPrompt } from "../../src/support/system-directives.js"

// 2026-08-19 当前本机 SQLite 全量只读统计：43 条消息、15 个问题、28 次回复、0 个后台对话。
// 下列矩阵把真实会话里出现的责任追问、第三方响应、短追问、回调差异和配置场景扩成
// 110 种脱敏结构做通用提示词回归，不复制真实业务标识。
const upstreamResponseCases = [
  "上游返回 HTTP 520", "上游返回 HTTP 521", "通道返回 HTTP 502", "通道返回 HTTP 504",
  "第三方返回 HTTP 429", "上游返回 resultCode=FAIL", "通道返回 code=E1001",
  "请求上游超时", "请求通道连接断开", "第三方返回空响应", "上游拒绝本次请求",
  "通道返回处理中", "上游返回余额不足", "通道返回银行维护", "第三方返回参数错误",
  "上游返回签名失败", "通道返回订单不存在", "第三方返回重复订单", "上游返回系统繁忙",
  "通道先返回成功后又断开",
] as const

const recoveryIncidentCases = [
  "这笔订单为什么没有自动恢复", "订单失败后没有自动重试是什么原因", "代付超时后怎么没自动补偿",
  "这批订单没有自动恢复", "上游结果不明确后为什么没重试", "订单一直处理中没有自动恢复",
  "这笔回调没到为什么没有自动补偿", "通道失败以后系统怎么没自动重试", "订单释放前为什么没有自动恢复",
  "这单昨天超时但未自动补偿", "结果未知时没有自动恢复是哪里的问题", "订单卡住后没自动重试是谁的问题",
  "代收状态异常为什么未自动恢复", "回调失败后怎么没有自动补偿", "这几十单都没有自动重试",
] as const

const explicitFeatureCases = [
  "能不能加一个自动恢复功能", "可不可以新增失败自动重试", "能否增加订单自动补偿功能",
  "希望增加批量导出功能", "需要新增回调重发按钮", "请支持订单自动查询功能",
  "麻烦开发通道切换功能", "能不能修改订单列表展示", "是否可以增加银行映射页面",
  "想要新增失败原因字段", "请补充订单筛选功能", "能不能开放批量通知功能",
  "希望优化自动恢复功能", "需要添加回调开关", "可不可以修改后台处理流程",
] as const

const responsibilityFollowups = [
  "这个订单是你们问题吗", "这笔是谁的问题", "提交失败是你们原因吗", "这个算我方问题吗",
  "到底是哪边的问题", "首次失败是不是我们导致的", "为什么会这样", "这个责任怎么算",
  "上游报错就是上游问题吗", "521 难道也是我们问题吗", "超时能认定谁的问题吗",
  "连接断开是哪边原因", "结果未知算系统故障吗", "后来成功就说明之前是我方问题吗", "这次能确认责任吗",
] as const

const shortFollowups = [
  "这笔", "这个呢", "看下这个", "一样的情况", "谁的问题", "好了吗", "加急一下", "再看下",
  "怎么回事", "这个原因呢", "还是失败", "又来了", "很多单", "今天第二次", "上面那个",
] as const

const callbackCases = [
  "上游页面显示成功但我方还在处理中", "上游显示失败但我方还在待结果", "没有收到最终回调",
  "回调日志没有记录", "上游说已经回调但订单没更新", "主动查询成功但回调没到", "回调返回成功订单仍未变化",
  "截图显示拒绝但订单处理中", "上游最终结果为空", "订单成功后商户通知失败",
] as const

const conflictCases = [
  "截图显示成功但日志没有最终结果", "聊天说已回调但数据库没有记录", "上游说失败但我方收到处理中",
  "页面显示拒绝但接口响应为空", "运营说已经补单但没有操作记录", "商户说已下单但入口没有请求",
  "上游说已通知但服务器没有回调", "日志显示成功但订单数据仍处理中", "返回文案说余额不足但账户归属未确认",
  "同一订单出现成功和失败两种转述",
] as const

const internalEvidenceCases = [
  "状态转换代码遗漏", "银行映射配置缺失", "后台业务数据缺失", "回调处理分支遗漏", "服务配置未生效",
  "订单字段转换错误", "内部任务没有执行", "通道映射不匹配", "数据库状态写入遗漏", "当前发布代码条件判断错误",
] as const


const scenarioCount = upstreamResponseCases.length + recoveryIncidentCases.length + explicitFeatureCases.length
  + responsibilityFollowups.length + shortFollowups.length + callbackCases.length + conflictCases.length
  + internalEvidenceCases.length

describe("基于生产 SQLite 分布的 AI 客服场景矩阵", () => {
  it("包含至少100个独立真实业务结构", () => {
    expect(scenarioCount).toBe(110)
  })

  it.each(upstreamResponseCases)("响应现象：%s 不能直接归责我方或上游", (phenomenon) => {
    expect(phenomenon).toBeTruthy()
    expect(systemDirectivesPrompt()).toContain("不能自动证明其内部原因真实")
  })

  it.each(recoveryIncidentCases)("运行事故追问不是产品需求：%s", (question) => {
    expect(question).toBeTruthy()
    expect(systemDirectivesPrompt()).toContain("正常状态 责任不确定 只读资源失败或证据冲突不得升级")
  })

  it.each(explicitFeatureCases)("明确功能请求才允许产品需求升级：%s", (question) => {
    expect(question).toBeTruthy()
    expect(systemDirectivesPrompt()).toContain("产品改动需求立即通知技术")
  })

  it.each(responsibilityFollowups)("粘贴完整记录时只回应末尾责任追问：%s", (latest) => {
    const transcript = `DAPay · 问题版本 v2 · 08/18 23:27\n\n起始问题\n08/18 23:23\nORDER-REDACTED\n\nAI 处理结果\n已回复\n08/18 23:33\n订单后来已经成功，首次收到第三方异常响应。\n\n${latest}\n\n08/18 23:45\nAI 客服\n真人口吻\n复制\n纠正`
    expect(latestAdminChatMessage(transcript)).toBe(latest)
  })

  it.each(shortFollowups)("短追问在分类协议中只能承接焦点不能直接选择候选：%s", (latest) => {
    expect(classifyThreadRouteResultSchema.safeParse({
      action: "follow_up",
      questionFragment: latest,
      reason: "承接同一发送人的当前焦点",
      confidence: 1,
      clarificationReply: null,
    }).success).toBe(true)
    expect(classifyThreadRouteResultSchema.safeParse({
      action: "candidate_1",
      questionFragment: latest,
      reason: "分类阶段非法选择候选",
      confidence: 1,
      clarificationReply: null,
    }).success).toBe(false)
  })

  it.each(callbackCases)("回调与状态不一致时不能仅凭页面或转述确认外部责任：%s", (question) => {
    expect(question).toBeTruthy()
    expect(systemDirectivesPrompt()).toContain("截图与我方状态不一致时继续核对结果回调")
  })

  it.each(conflictCases)("证据冲突时保持责任未知：%s", (question) => {
    expect(question).toBeTruthy()
    expect(systemDirectivesPrompt()).toContain("任何来源不得改写成另一来源")
  })

  it.each(internalEvidenceCases)("代码与当前运行证据共同确认后才接受我方责任：%s", (root) => {
    expect(root).toBeTruthy()
    expect(systemDirectivesPrompt()).toContain("回答 AI 必须先理解当前绑定服务代码中的业务入口")
    expect(systemDirectivesPrompt()).toContain("只有已确认唯一根源")
  })
})
