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
            ? "分类模式 action 只能是 follow_up、new_thread、split、idle、uncertain，绝不能输出 candidate_1 或 candidate_2。"
            : "待确认回答模式 action 只能是 candidate_1、candidate_2、new_thread、idle、uncertain，绝不能输出 follow_up。",
          "同一个群共享连续会话语境，但一批消息里可能同时包含多个彼此独立、都需要处理的事项。此时使用 split，并在 issues 中为每个事项给出所依据的 eventIds 和完整 questionFragment；同一条消息包含多个事项时，同一个 eventId 可以出现在多个 issue。不要靠关键词或固定业务类型拆分，要按消息在当前语境中的真实意图判断。",
          "split 必须覆盖本批全部 eventId，issues 至少两个、最多八个；非 split 时 issues 必须为 null。系统会为每个 issue 独立排查和投递，所以最终可以按事项分条回复。",
          "延迟、失败、不到账、未回调、报错、异常等陈述属于求助，不能判为 idle。‘人呢’‘这个好了没’‘加急一下’‘这个呢’‘1’等短追问只要语境连续就判为 follow_up。",
          "investigationEffect 判断最新消息是否改变当前排查输入。只有 action=follow_up 且消息只是询问进度、催促或提醒尽快处理，没有增加任何事实、证据、附件、订单标识、时间范围、异常现象、纠正、操作要求或新的业务问题时，才使用 status_only。只要新增了可影响排查或回答的内容，无论是否同时催促，都使用 changes_input。无法确定时必须使用 changes_input；其他 action 一律使用 changes_input。这个判断只按完整语义完成，不使用关键词清单。",
          "最高优先级身份要求：所有发给运营的文字都由真实的当班客服自然接话，绝不能自称或暗示是 AI、机器人、模型、自动客服或程序，也不能讨论这些身份。",
          "investigationEffect=status_only 时 progressReply 必须现场生成一到两句热情、亲切、成熟的客服回复：先请对方稍等，再自然说明为了准确判断，除了核对当前服务本身，还要逐项核对数据库、服务器记录和应用后端日志，所以需要一些时间；只能说明仍在核对，不能假装已经查完，不能承诺完成时间。其他情况 progressReply 必须为 null。不要照抄固定模板，要结合本轮语境自然表达。",
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
      if (result.action === "split") {
        const issues = result.issues ?? []
        const allowedEventIds = new Set(input.messages.map((message) => message.id))
        const coveredEventIds = new Set(issues.flatMap((issue) => issue.eventIds))
        if (issues.length < 2
          || issues.some((issue) => issue.eventIds.some((eventId) => !allowedEventIds.has(eventId)))
          || [...allowedEventIds].some((eventId) => !coveredEventIds.has(eventId))) {
          throw new Error("拆分路由没有完整覆盖当前接收批次")
        }
      }
      if (result.action === "uncertain" && candidates?.candidateLabels.length === 2) {
        return result
      }
      if (result.clarificationReply !== null) throw new Error("非歧义路由不得生成客服确认文案")
      return result
    } finally {
      clearTimeout(timeout)
    }
  }
}
