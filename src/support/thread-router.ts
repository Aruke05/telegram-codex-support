import type { CodexExecutor } from "../codex/executor.js"
import {
  classifyThreadRouteResultJsonSchema,
  classifyThreadRouteResultSchema,
  resolveThreadRouteResultJsonSchema,
  resolveThreadRouteResultSchema,
  threadRouteResultSchema,
  type ThreadRouteResult,
} from "../codex/schemas.js"
import type { ProjectServiceRecord, RuntimeGroup, SupportMessageEvent } from "../runtime/types.js"

export type SenderRouteFocusContext = {
  summary: string
  recentMessages: Array<{ sender: "operator" | "support"; text: string; createdAt: string }>
}

export type SenderRoutePendingContext = {
  latestQuestion: string
  candidateLabels: string[]
}

export type ThreadRouteTimelineEntry = {
  direction: "inbound" | "outbound"
  eventId: string | null
  messageId: string
  replyToMessageId: string | null
  senderId: string | null
  sender: string
  text: string
  threadIds: string[]
  createdAt: string
}

export type ThreadRouteInput = {
  mode: "classify" | "resolve_clarification"
  group: RuntimeGroup
  service: ProjectServiceRecord
  messages: SupportMessageEvent[]
  focus: SenderRouteFocusContext | null
  pending: SenderRoutePendingContext | null
  ambiguity: SenderRoutePendingContext | null
}

export type SupportThreadRouterPort = {
  route(input: ThreadRouteInput): Promise<ThreadRouteResult>
}

const invalidClarificationPattern = /(?:\bAI\b|机器人|模型|自动客服|程序|你问的是哪项|具体事项.{0,4}(?:发|说)(?:一下)?|要跟进的问题|把问题发我|上面哪个)/iu

function labelTokens(label: string): string[] {
  const tokens = new Set<string>()
  for (const match of label.matchAll(/[A-Za-z0-9_-]+|[\p{Script=Han}]{2,}/gu)) {
    const token = match[0]!
    if (!/^[\p{Script=Han}]+$/u.test(token)) {
      tokens.add(token)
      continue
    }
    if (token.length === 2) {
      tokens.add(token)
      continue
    }
    for (let index = 0; index < token.length - 1; index += 1) tokens.add(token.slice(index, index + 2))
  }
  return [...tokens]
}

export function validateRouteClarificationReply(reply: string, candidateLabels: string[]): string {
  const normalized = reply.trim()
  if (!normalized || normalized.length > 240 || invalidClarificationPattern.test(normalized)) {
    throw new Error("路由模型没有生成合格的自然确认")
  }
  if (candidateLabels.length < 1 || candidateLabels.length > 2) throw new Error("路由确认候选数量无效")
  const tokenSets = candidateLabels.map(labelTokens)
  for (let index = 0; index < tokenSets.length; index += 1) {
    const otherTokens = new Set(tokenSets.flatMap((tokens, otherIndex) => otherIndex === index ? [] : tokens))
    const distinctive = tokenSets[index]!.filter((token) => !otherTokens.has(token))
    const searchable = distinctive.length > 0 ? distinctive : tokenSets[index]!
    if (searchable.length === 0 || !searchable.some((token) => normalized.includes(token))) {
      throw new Error("路由模型的自然确认没有点出全部具体候选")
    }
  }
  return normalized
}

export class CodexSupportThreadRouter implements SupportThreadRouterPort {
  constructor(private readonly codex: CodexExecutor) {}

  async route(input: ThreadRouteInput): Promise<ThreadRouteResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300_000)
    timeout.unref()
    try {
      const result = await this.codex.execute<ThreadRouteResult>("answer", {
        cwd: process.cwd(),
        prompt: [
          "你负责判断同一位 Telegram 运营的新消息如何承接当前对话，只输出结构化 JSON。",
          "系统已经处理 reply_to 等强关系。你不能选择线程 ID，也不能把消息归到其他发送人的事项。",
          input.mode === "classify"
            ? "分类模式 action 只能是 follow_up、new_thread、idle、uncertain，绝不能输出 candidate_1 或 candidate_2。"
            : "待确认回答模式 action 只能是 candidate_1、candidate_2、new_thread、idle、uncertain，绝不能输出 follow_up。",
          "延迟、失败、不到账、未回调、报错、异常等陈述属于求助，不能判为 idle。‘人呢’‘这个好了没’‘加急一下’‘这个呢’‘1’等短追问只要语境连续就判为 follow_up。",
          "只有待确认回答模式中的 pending 才允许选择 candidate_1/candidate_2。分类模式中的 ambiguity 只用于决定 follow_up、new_thread 或发起 uncertain 确认，不能直接选择候选。",
          "uncertain 且存在两个候选时，clarificationReply 必须用当班客服自然口吻在一句话里点出两个具体事项。禁止提 AI、机器人、模型、程序、线程、上下文，也禁止空泛问‘你问的是哪项’。其他 action 的 clarificationReply 必须为 null。",
          "questionFragment 保留本次排查所需原文，URL、订单号、金额、百分比、时间和错误标识逐字保留。",
          `群绑定：${JSON.stringify({ group: input.group.name, service: input.service.key, branch: input.service.branch })}`,
          `当前模式：${input.mode}`,
          `当前发送人的焦点：${JSON.stringify(input.focus)}`,
          `当前发送人的待确认事项：${JSON.stringify(input.pending)}`,
          `分类模式中的歧义参考：${JSON.stringify(input.ambiguity)}`,
          `最新消息：${JSON.stringify(input.messages.map((message) => ({
            eventId: message.id,
            messageId: message.telegramMessageId,
            text: message.safeText,
            attachments: message.attachmentSummary,
            time: message.createdAt,
          })))}`,
        ].join("\n\n"),
        outputSchema: (input.mode === "classify"
          ? classifyThreadRouteResultJsonSchema
          : resolveThreadRouteResultJsonSchema) as unknown as Record<string, unknown>,
        validator: (input.mode === "classify"
          ? classifyThreadRouteResultSchema
          : resolveThreadRouteResultSchema) as unknown as typeof threadRouteResultSchema,
        executionTimeoutMs: 300_000,
        concurrencyGroup: "support_route",
        maxConcurrency: 2,
        signal: controller.signal,
      })
      const candidates = input.mode === "classify" ? input.ambiguity : input.pending
      if (result.action === "uncertain" && candidates?.candidateLabels.length === 2) {
        return {
          ...result,
          clarificationReply: validateRouteClarificationReply(
            result.clarificationReply ?? "",
            candidates.candidateLabels,
          ),
        }
      }
      if (result.clarificationReply !== null) throw new Error("非歧义路由不得生成客服确认文案")
      return result
    } finally {
      clearTimeout(timeout)
    }
  }
}
