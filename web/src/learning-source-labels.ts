import type { LearningObservationAudit, TelegramRole } from "./types.js"

const associationLabels: Record<LearningObservationAudit["associationReason"], string> = {
  direct_question: "直接问题关联",
  direct_bot_reply: "直接回复机器人",
  reply_chain: "回复链关联",
  single_active_thread: "唯一处理中问题",
  ambiguous: "歧义未处理",
  none: "未关联",
}

const takeoverLabels: Record<LearningObservationAudit["takeoverStatus"], string> = {
  cancelled: "已接管",
  delivery_in_flight: "发送中未知",
  thread_already_terminal: "线程已结束",
  ambiguous: "歧义未处理",
  not_linked: "未关联",
}

const processingLabels: Record<LearningObservationAudit["processingStatus"], string> = {
  pending: "等待学习",
  ignored: "已忽略",
  running: "处理中",
  completed: "已完成",
  failed: "处理失败",
}

const classificationLabels: Record<string, string> = {
  unclassified: "未分类",
  style: "回复风格",
  correction: "纠正规则",
  business_rule: "业务规则",
  ephemeral: "一次性信息",
  action_result: "动作结果",
  general: "普通内容",
}

const actionLabels: Record<NonNullable<LearningObservationAudit["terminalResult"]>["action"], string> = {
  add: "新增",
  reinforce: "强化",
  conflict: "冲突",
  noop: "不变更",
}

const outcomeLabels: Record<NonNullable<LearningObservationAudit["terminalResult"]>["outcome"], string> = {
  noop: "未变更",
  candidate: "记忆候选",
  conflict: "记忆冲突",
  active: "记忆生效",
  style_candidate: "风格候选",
  style_active: "风格生效",
  ignored: "已安全忽略",
  failed: "处理失败",
}

const reasonLabels: Record<NonNullable<LearningObservationAudit["terminalResult"]>["reasonCode"], string> = {
  proposal_noop: "模型明确不变更",
  deterministic_noop: "确定性禁学规则",
  non_learnable_classification: "分类不进入长期学习",
  memory_candidate: "形成记忆候选",
  memory_conflict: "形成记忆冲突",
  memory_active: "记忆已生效",
  style_candidate: "形成风格候选",
  style_active: "风格已生效",
  unsafe_learning_material: "材料不满足安全学习条件",
  invalid_proposal_batch: "提议未完整覆盖批次",
  processing_failed: "处理未形成有效终态",
  interrupted_run: "处理进程中断",
}

export function roleLearningSourceLabel(role: Pick<TelegramRole, "telegramUserId" | "learningSourceEnabled">): string {
  return `${role.learningSourceEnabled ? "学习来源已授权" : "不作为学习来源"} · ID ${role.telegramUserId}`
}

export function learningObservationFacts(observation: Pick<LearningObservationAudit, "associationReason" | "threadId" | "takeoverStatus" | "processingStatus" | "terminalResult">): Array<[string, string]> {
  const terminal = observation.terminalResult
  const facts: Array<[string, string]> = [
    ["关联方式", associationLabels[observation.associationReason]],
    ["问题线程", observation.threadId ?? "未关联"],
    ["接管状态", takeoverLabels[observation.takeoverStatus]],
    ["学习结果", processingLabels[observation.processingStatus]],
  ]
  if (!terminal) return [...facts, ["终态审计", "尚未生成"]]
  facts.push(
    ["终态分类", classificationLabels[terminal.classification] ?? terminal.classification],
    ["终态动作", actionLabels[terminal.action]],
    ["终态结果", outcomeLabels[terminal.outcome]],
    ["原因", reasonLabels[terminal.reasonCode]],
  )
  if (terminal.memoryVersionId) facts.push(["记忆版本", terminal.memoryVersionId])
  if (terminal.operatorStyleVersionId) facts.push(["风格版本", terminal.operatorStyleVersionId])
  return facts
}
