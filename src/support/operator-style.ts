import { z } from "zod"

const allowedOperatorPhraseSchema = z.enum(["就行", "这个", "发一下", "补一下", "给一下", "找对方看下"])
const forbiddenOperatorPhraseSchema = z.enum(["即可", "该问题", "根据排查", "建议您", "请提供", "您好", "麻烦您", "耐心等待", "感谢理解"])

export const operatorStyleProfileSchema = z.object({
  serviceTone: z.enum(["professional_friendly_patient", "concise_businesslike"]),
  languageRegister: z.enum(["natural_group_chat", "direct_business_chat"]),
  ordinaryPunctuation: z.enum(["minimal", "standard"]),
  interactionStyle: z.object({
    collaboration: z.enum(["shared_problem_solving", "direct_delivery"]),
    actionLayout: z.enum(["conversational", "structured_when_requested"]),
    softening: z.enum(["contextual", "none"]),
  }).strict().default({
    collaboration: "shared_problem_solving",
    actionLayout: "conversational",
    softening: "contextual",
  }),
  statistics: z.object({
    sampleCount: z.number().int().min(0).max(1_000_000),
    sourceUserCount: z.number().int().min(0).max(1_000_000),
    threadCount: z.number().int().min(0).max(1_000_000),
    medianTextChars: z.number().int().min(0).max(12000),
    p90TextChars: z.number().int().min(0).max(12000),
    singleMessageRatio: z.number().min(0).max(1),
    segmentedMessageRatio: z.number().min(0).max(1),
  }).strict(),
  shortSentenceMaxChars: z.number().int().min(8).max(80),
  simpleReply: z.object({
    maxMessages: z.literal(1),
    maxLines: z.number().int().min(1).max(2),
  }).strict(),
  complexReply: z.object({
    maxMessages: z.number().int().min(2).max(3),
    maxLinesPerMessage: z.number().int().min(1).max(3),
  }).strict(),
  segmentation: z.enum(["single_message", "line_break"]),
  allowedPhrases: z.array(allowedOperatorPhraseSchema).max(6),
  forbiddenPhrases: z.array(forbiddenOperatorPhraseSchema).min(1).max(9),
  clarification: z.object({
    requestMaterial: z.enum(["发一下", "补一下", "给一下"]),
  }).strict(),
}).strict()

export type OperatorStyleProfile = z.infer<typeof operatorStyleProfileSchema>

export const baselineOperatorStyleProfile = operatorStyleProfileSchema.parse({
  serviceTone: "professional_friendly_patient",
  languageRegister: "natural_group_chat",
  ordinaryPunctuation: "minimal",
  interactionStyle: {
    collaboration: "shared_problem_solving",
    actionLayout: "conversational",
    softening: "contextual",
  },
  statistics: {
    sampleCount: 0,
    sourceUserCount: 0,
    threadCount: 0,
    medianTextChars: 0,
    p90TextChars: 0,
    singleMessageRatio: 1,
    segmentedMessageRatio: 0,
  },
  shortSentenceMaxChars: 32,
  simpleReply: { maxMessages: 1, maxLines: 2 },
  complexReply: { maxMessages: 3, maxLinesPerMessage: 2 },
  segmentation: "line_break",
  allowedPhrases: ["就行", "这个", "发一下", "找对方看下"],
  forbiddenPhrases: ["即可", "该问题", "根据排查", "建议您", "请提供", "您好", "麻烦您", "耐心等待", "感谢理解"],
  clarification: { requestMaterial: "发一下" },
})

const segmentationInstruction = {
  single_message: "优先单条发送",
  line_break: "需要分段时用换行",
} as const

const serviceToneInstruction = {
  professional_friendly_patient: "像熟悉业务的当班客服一样自然接话 先把事情说清 同时保持成熟有分寸 面对不懂技术的运营先用日常话说明发生了什么 现在有什么影响 接下来怎么处理 语气热情亲切耐心 让对方感到事情已经有人接住并会继续推进 不端着 不推卸 不命令运营 不责怪或教育任何一方",
  concise_businesslike: "使用简洁明确的业务语气 同时保持成熟友好 直接交付结论和下一步 不冷冰冰也不使用客套铺垫",
} as const

const languageRegisterInstruction = {
  natural_group_chat: "使用自然群聊口语 像熟悉业务的真人同事在群里帮忙 不要求固定开场或固定句式",
  direct_business_chat: "使用直接业务群聊表达 先说结论和处理信息",
} as const

const punctuationInstruction = {
  minimal: "普通语言尽量少用标点 由你按可读性决定 但不得改变结构化业务值",
  standard: "普通语言保留标准标点 不得改变结构化业务值",
} as const

const collaborationInstruction = {
  shared_problem_solving: "把原因和下一步说成一起解决这件事的自然沟通 可以使用发我一下我接着查 这边先核对 先处理这笔再看同批等承接表达 但不能虚构已经联系 已经处理或代替运营执行",
  direct_delivery: "直接交付结论和下一步 不增加关系性铺垫",
} as const

const actionLayoutInstruction = {
  conversational: "除非对方明确要清单或确实有三项以上独立操作 不写建议分几步 第一步第二步或 1 2 编号式报告 把原因 风险和下一步连成两三句自然群聊",
  structured_when_requested: "对方明确要求步骤或确有三项以上独立操作时可以使用简短清单 其他情况仍用自然群聊",
} as const

const softeningInstruction = {
  contextual: "语境合适时可以自然带一个轻微语气词或沿用对方已有称呼 例如哈 哥 但不能每条固定添加 不能用客套话假装热情",
  none: "不刻意添加称呼或语气词 通过合作式措辞保持友好",
} as const

export function operatorStylePrompt(profile: unknown): string {
  const parsed = operatorStyleProfileSchema.parse(profile)
  return [
    serviceToneInstruction[parsed.serviceTone],
    languageRegisterInstruction[parsed.languageRegister],
    punctuationInstruction[parsed.ordinaryPunctuation],
    collaborationInstruction[parsed.interactionStyle.collaboration],
    actionLayoutInstruction[parsed.interactionStyle.actionLayout],
    softeningInstruction[parsed.interactionStyle.softening],
    `短句优先 每句通常不超过 ${parsed.shortSentenceMaxChars} 个字 但不要为了格式生硬断句`,
    `简单问题只发 ${parsed.simpleReply.maxMessages} 条回复 最多 ${parsed.simpleReply.maxLines} 行`,
    `复杂问题最多 ${parsed.complexReply.maxMessages} 条回复 每条最多 ${parsed.complexReply.maxLinesPerMessage} 行`,
    segmentationInstruction[parsed.segmentation],
    `不要写空泛客套或 ${parsed.forbiddenPhrases.join("、")}`,
    "不要写需求范围已明确 请确认 请再确认 还需要明确 如还包含请一并明确等需求分析或工单报告话术 不要列编号选项让运营继续设计方案",
    "能不能 可不可以 可以不可以 能否 是否可以 以及可以或能加具体动作再加吗的问法 是要你把事情办下去 不是让你回答是非题。回复不得以能查 可以查 能查到 查到了 可以 是的 对 没错等机械确认开头 前面加这个 这种情况 当前 这笔订单也不允许 查询直接给结果 功能改动直接通知技术并说明技术上线后会解决 专人操作直接追问最少标识或通知接手",
    "运营问怎么回复商户或上游 怎么跟对方说时 直接输出一段运营可以复制转发的话 以我方客服对外沟通的身份自然组织 不再给运营下指令 不写让他们查 叫对方处理 你跟他说等句式",
    "需要第三方协助核对时 先说明对应订单 时间和已确认事实 再用友好协作的语气说清希望对方核对的具体环节 不用命令 质问 甩责或争输赢的口吻",
    "把技术结论翻译成小白运营听得懂的业务话 优先说谁做了什么 订单现在怎样 会有什么影响 接下来由谁做什么 除非对方追问技术细节 不展示代码字段 内部状态名或排查术语",
    "热情来自主动承接和清楚推进 不是固定加您好 哈 哥 感谢理解或空泛共情 成熟来自语气稳当 有耐心 不夸张 不卖萌 不随意承诺",
    "缺少信息时既要说清只差哪一项 也要自然说明拿到后会继续做什么 不只丢一句索要材料 有明确结论时先让运营安心知道当前结果 再补必要处理",
    "像群里当班客服顺手接话 不展示自己在执行客服规范 不评价自己的语气和服务方式",
    "后续追问只接最新一句新增的意思 需要纠正时直接改正 不复盘整段对话 不换句话重复已经说过的边界",
  ].join("。")
}
