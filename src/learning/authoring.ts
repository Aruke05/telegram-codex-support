import { z } from "zod"

import type { CodexExecutor } from "../codex/executor.js"
import type { RuntimeKnowledgeService } from "../runtime/knowledge-service.js"

const memoryInputSchema = z.object({
  title: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(12000),
  scope: z.string().trim().min(1).max(120), region: z.string().trim().max(120).nullable(),
  branch: z.string().trim().max(120).nullable(), risk: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1), source: z.literal("human_rule"), actor: z.string().trim().min(1).max(160),
}).strict()
const correctionInputSchema = z.object({
  correctedAnswer: z.string().trim().min(1).max(12000), reason: z.string().trim().min(1).max(1000),
  scope: z.string().trim().min(1).max(120), region: z.string().trim().max(120).nullable(),
  branch: z.string().trim().max(120).nullable(), correctedBy: z.string().trim().min(1).max(160),
}).strict()
const adminChatCorrectionInputSchema = correctionInputSchema.extend({
  originalQuestion: z.string().trim().min(1).max(12000),
  previousAnswer: z.string().max(12000),
  referencedMemoryIds: z.array(z.string().uuid()),
  codeRevision: z.string().trim().max(160).nullable(),
  sourceRef: z.string().trim().min(1).max(200),
}).strict()
const authoredMemorySchema = z.object({
  title: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(12000),
  risk: z.enum(["low", "medium", "high"]), confidence: z.number().min(0).max(1),
}).strict()
const authoredCorrectionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  applicability: z.string().trim().min(1).max(4000),
  guidance: z.string().trim().min(1).max(4000),
}).strict()
const authoredMemoryJsonSchema = {
  type: "object", additionalProperties: false, required: ["title", "content", "risk", "confidence"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 160 }, content: { type: "string", minLength: 1, maxLength: 12000 },
    risk: { type: "string", enum: ["low", "medium", "high"] }, confidence: { type: "number", minimum: 0, maximum: 1 },
  },
}
const authoredCorrectionJsonSchema = {
  type: "object", additionalProperties: false, required: ["title", "applicability", "guidance"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 160 },
    applicability: { type: "string", minLength: 1, maxLength: 4000 },
    guidance: { type: "string", minLength: 1, maxLength: 4000 },
  },
}

export class MemoryAuthoringService {
  constructor(private readonly codex: CodexExecutor, private readonly knowledge: RuntimeKnowledgeService) {}

  async createMemory(input: unknown) {
    const parsed = memoryInputSchema.parse(input)
    let authored = { title: parsed.title, content: parsed.content, risk: parsed.risk, confidence: parsed.confidence }
    try {
      authored = await this.codex.execute("memory", {
        cwd: process.cwd(),
        prompt: [
          "把人工新增的 AI 客服记忆整理成明确、可检索、无歧义的事实。保留原结论，不添加新事实。",
          "涉及密钥、签名、权限、安全、生产写操作或资金操作时 risk 必须 high。只输出 JSON。",
          JSON.stringify(authored),
        ].join("\n\n"),
        outputSchema: authoredMemoryJsonSchema,
        validator: authoredMemorySchema,
      })
    } catch { /* Codex 暂不可用时保留人工原文，不能阻断新增。 */ }
    return this.knowledge.createMemory({ ...parsed, ...authored })
  }

  async correctReply(replyId: string, input: unknown) {
    const parsed = correctionInputSchema.parse(input)
    const reply = this.knowledge.getReply(replyId)
    let authored = {
      title: `纠正：${reply.question.slice(0, 120)}`,
      applicability: `当出现与原问题同类的情况时，按人工纠正处理；${parsed.reason}`.slice(0, 4000),
      guidance: parsed.reason,
    }
    try {
      authored = await this.codex.execute("memory", {
        cwd: process.cwd(),
        prompt: [
          "把人工对 AI 客服的纠正整理成可检索标题、适用条件和语义化回答原则。人工正确回答只是历史证据，不是模板；不得生成可直接发送的完整回复，不得复用其中的固定句子、开场、分行或句式。只输出 JSON。",
          "applicability 概括同类问题，不要只复述字面。guidance 只提取必须保留的事实、处理意图、语气和禁止事项，让回答模型结合最新消息自行组织文案；不得添加新事实、新操作或无法保证的承诺。",
          JSON.stringify({
            originalQuestion: reply.question,
            previousAnswer: reply.answer,
            correctedAnswer: parsed.correctedAnswer,
            correctionReason: parsed.reason,
          }),
        ].join("\n\n"),
        outputSchema: authoredCorrectionJsonSchema,
        validator: authoredCorrectionSchema,
      })
    } catch { /* Codex 暂不可用时使用确定性适用条件，不能阻断纠错。 */ }
    const memoryContent = [
      `适用条件：${authored.applicability}`,
      `回答原则：${authored.guidance}`,
      "生成要求：只遵循上述语义和处理意图 结合本轮最新消息自然作答 不复用历史正确回答的完整句子 分行或固定句式",
    ].join("\n").slice(0, 12000)
    return this.knowledge.correctReply(replyId, { ...parsed, title: authored.title, memoryContent })
  }

  async correctAdminChatTurn(input: unknown) {
    const parsed = adminChatCorrectionInputSchema.parse(input)
    let authored = {
      title: `纠正：${parsed.originalQuestion.slice(0, 120)}`,
      applicability: `当出现与原问题同类的情况时，按人工纠正处理；${parsed.reason}`.slice(0, 4000),
      guidance: parsed.reason,
    }
    try {
      authored = await this.codex.execute("memory", {
        cwd: process.cwd(),
        prompt: [
          "把人工对 AI 客服的纠正整理成可检索标题、适用条件和语义化回答原则。人工正确回答只是历史证据，不是模板；不得生成可直接发送的完整回复，不得复用其中的固定句子、开场、分行或句式。只输出 JSON。",
          "applicability 概括同类问题，不要只复述字面。guidance 只提取必须保留的事实、处理意图、语气和禁止事项，让回答模型结合最新消息自行组织文案；不得添加新事实、新操作或无法保证的承诺。",
          JSON.stringify({
            originalQuestion: parsed.originalQuestion,
            previousAnswer: parsed.previousAnswer,
            correctedAnswer: parsed.correctedAnswer,
            correctionReason: parsed.reason,
          }),
        ].join("\n\n"),
        outputSchema: authoredCorrectionJsonSchema,
        validator: authoredCorrectionSchema,
      })
    } catch { /* 记忆模型暂不可用时仍使用人工原文生成确定性纠正记忆。 */ }
    const memoryContent = [
      `适用条件：${authored.applicability}`,
      `回答原则：${authored.guidance}`,
      "生成要求：只遵循上述语义和处理意图 结合本轮最新消息自然作答 不复用历史正确回答的完整句子 分行或固定句式",
    ].join("\n").slice(0, 12000)
    return this.knowledge.createStandaloneCorrection({ ...parsed, title: authored.title, memoryContent })
  }
}
