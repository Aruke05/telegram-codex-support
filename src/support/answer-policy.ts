import type { ReplyStyle, RuntimeGroup, RuntimeModelBinding } from "../runtime/types.js"

export type AnswerPolicy = {
  modelInstanceId: string
  includeAiMemory: boolean
  includeInterfaceDocs: boolean
  includeMagicBook: boolean
  enqueueLearning: boolean
  replyStyle: ReplyStyle
}

export function resolveAnswerPolicy(group: RuntimeGroup, answerBinding: RuntimeModelBinding): AnswerPolicy {
  if (group.purpose === "technical_alert") {
    if (!group.aiModelInstanceId) throw new Error("技术告警群尚未配置 /ai 模型")
    return {
      modelInstanceId: group.aiModelInstanceId,
      includeAiMemory: false,
      includeInterfaceDocs: true,
      includeMagicBook: true,
      enqueueLearning: false,
      replyStyle: group.replyStyle,
    }
  }
  return {
    modelInstanceId: answerBinding.modelInstanceId,
    includeAiMemory: true,
    includeInterfaceDocs: true,
    includeMagicBook: true,
    enqueueLearning: true,
    replyStyle: group.replyStyle,
  }
}
