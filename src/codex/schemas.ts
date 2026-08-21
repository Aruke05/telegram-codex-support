import { z } from "zod"

export const investigationStepSchema = z.object({
  source: z.enum(["message", "document", "code", "server", "log", "database", "redis", "inference"]),
  title: z.string().trim().min(1).max(160),
  status: z.enum(["confirmed", "not_found", "failed", "skipped"]),
  evidence: z.string().trim().max(4000),
  conclusion: z.string().trim().min(1).max(1000),
}).strict()

export const investigationTraceSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  steps: z.array(investigationStepSchema).min(1).max(24),
}).strict()

export type InvestigationStep = z.infer<typeof investigationStepSchema>
export type InvestigationTrace = z.infer<typeof investigationTraceSchema>

export const customerInteractionSchema = z.object({
  sentiment: z.enum(["neutral", "confused", "frustrated", "hostile"]),
  situation: z.enum(["new_request", "followup", "correction", "complaint", "identity_challenge", "scope_boundary"]),
  underlyingNeed: z.string().trim().min(1).max(300),
  responseStrategy: z.enum(["direct_answer", "minimal_clarification", "service_recovery", "boundary_with_next_step", "ignore"]),
}).strict()

export type CustomerInteraction = z.infer<typeof customerInteractionSchema>

export const answerClaimSchema = z.object({
  statement: z.string().trim().min(1).max(1000),
  provenance: z.enum([
    "user_report", "display", "request", "response", "callback", "runtime", "code", "document", "inference", "recommendation",
  ]),
  evidenceSource: investigationStepSchema.shape.source,
  evidence: z.string().trim().max(1000),
}).strict()

export type AnswerClaim = z.infer<typeof answerClaimSchema>

export const responsibilityAssessmentSchema = z.object({
  party: z.enum(["our_side", "merchant", "upstream", "bank", "third_party", "shared", "unknown", "not_applicable"]),
  certainty: z.enum(["confirmed", "inference", "unknown", "not_applicable"]),
  evidenceSources: z.array(investigationStepSchema.shape.source).max(8),
}).strict().superRefine((value, context) => {
  if ((value.party === "unknown" || value.party === "not_applicable")
    && !["unknown", "not_applicable"].includes(value.certainty)) {
    context.addIssue({ code: "custom", path: ["certainty"], message: "未知或不适用责任不能标为已确认或推断" })
  }
  if (value.certainty === "confirmed" && value.evidenceSources.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceSources"], message: "已确认责任必须声明证据来源" })
  }
})

export type ResponsibilityAssessment = z.infer<typeof responsibilityAssessmentSchema>

export const evidenceFactSchema = z.object({
  id: z.string().regex(/^F(?:[1-9]|1\d|2[0-4])$/u),
  statement: z.string().trim().min(1).max(1000),
  provenance: answerClaimSchema.shape.provenance,
  evidenceSource: investigationStepSchema.shape.source,
  evidence: z.string().trim().max(1000),
  certainty: z.enum(["confirmed", "reported", "inferred"]),
  outboundSafe: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.evidenceSource === "inference" && value.certainty !== "inferred") {
    context.addIssue({ code: "custom", path: ["certainty"], message: "推断来源不能标为已确认或转述" })
  }
  if (value.provenance === "inference" && value.certainty !== "inferred") {
    context.addIssue({ code: "custom", path: ["certainty"], message: "推断事实不能标为已确认或转述" })
  }
})

export const evidencePacketSchema = z.object({
  version: z.literal("1"),
  communication: z.object({
    intent: z.enum(["direct_answer", "copyable_message", "minimal_clarification", "handoff", "ignore"]),
    recipient: z.string().trim().min(1).max(120).nullable(),
    desiredOutcome: z.string().trim().min(1).max(500),
  }).strict(),
  facts: z.array(evidenceFactSchema).max(24),
  requiredAnswerPoints: z.array(z.string().trim().min(1).max(500)).max(12),
  unknowns: z.array(z.string().trim().min(1).max(500)).max(12),
  handlingNotes: z.array(z.string().trim().min(1).max(500)).max(12),
  reviewLevel: z.enum(["standard", "strict"]),
}).strict().superRefine((value, context) => {
  const ids = value.facts.map((fact) => fact.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["facts"], message: "证据事实 ID 不能重复" })
  }
  if (value.communication.intent === "copyable_message" && !value.communication.recipient) {
    context.addIssue({ code: "custom", path: ["communication", "recipient"], message: "可转发沟通必须说明接收方" })
  }
})

export type EvidenceFact = z.infer<typeof evidenceFactSchema>
export type EvidencePacket = z.infer<typeof evidencePacketSchema>

const humanOperationSchema = z.object({
  action: z.string().trim().min(1).max(300),
  identifiers: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
}).strict()

export const answerDecisionSchema = z.object({
  decision: z.enum(["reply", "ignore", "escalate"]),
  escalationType: z.enum(["none", "code_defect", "technical_change", "feature_request", "service_handoff", "human_operation"]),
  humanOperation: humanOperationSchema.nullable().optional(),
  answer: z.string().max(12000),
  quote: z.string().max(1000).nullable(),
  reason: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  usedMemoryVersionIds: z.array(z.string().uuid()).max(30),
  // 兼容升级前的测试夹具；正式回答模型 JSON Schema 始终要求提供。
  answerClaims: z.array(answerClaimSchema).max(24).optional(),
  // 兼容升级前的持久记录和测试夹具；正式回答模型 JSON Schema 始终要求提供。
  responsibility: responsibilityAssessmentSchema.optional(),
  // 兼容升级前的持久记录和测试夹具；正式模型 JSON Schema 始终要求提供。
  interaction: customerInteractionSchema.optional(),
  investigation: investigationTraceSchema,
  // 兼容升级前的持久记录和测试夹具；正式调查模型 JSON Schema 始终要求提供。
  evidencePacket: evidencePacketSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.decision === "reply" || value.decision === "escalate") && !value.answer.trim()) {
    context.addIssue({ code: "custom", path: ["answer"], message: "回复内容不能为空" })
  }
  if (value.decision === "escalate" && value.escalationType === "none") {
    context.addIssue({ code: "custom", path: ["escalationType"], message: "升级必须说明升级类型" })
  }
  if (value.decision !== "escalate" && value.escalationType !== "none") {
    context.addIssue({ code: "custom", path: ["escalationType"], message: "普通回复和忽略不能携带升级类型" })
  }
  if (value.escalationType === "human_operation" && !value.humanOperation) {
    context.addIssue({ code: "custom", path: ["humanOperation"], message: "专人操作必须提供原消息中的操作和必要标识" })
  }
  if (value.escalationType !== "human_operation" && value.humanOperation) {
    context.addIssue({ code: "custom", path: ["humanOperation"], message: "非专人操作不能携带专人操作信息" })
  }
  if (value.decision !== "ignore" && value.evidencePacket?.requiredAnswerPoints.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidencePacket", "requiredAnswerPoints"],
      message: "需要回复或升级时必须列出至少一个必答要点",
    })
  }
}).transform((value) => value.decision === "ignore" ? { ...value, answer: "", quote: null } : value)

export type AnswerDecision = z.infer<typeof answerDecisionSchema>

export const composedReplySchema = z.object({
  answer: z.string().max(12000),
  quote: z.string().max(1000).nullable(),
  claims: z.array(z.object({
    factId: evidenceFactSchema.shape.id,
    statement: z.string().trim().min(1).max(1000),
  }).strict()).max(24),
  usedMemoryVersionIds: z.array(z.string().uuid()).max(30),
}).strict().superRefine((value, context) => {
  if (!value.answer.trim()) context.addIssue({ code: "custom", path: ["answer"], message: "回复内容不能为空" })
  const ids = value.claims.map((claim) => claim.factId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["claims"], message: "事实引用不能重复" })
  }
  value.claims.forEach((claim, index) => {
    if (!value.answer.includes(claim.statement)) {
      context.addIssue({ code: "custom", path: ["claims", index, "statement"], message: "事实声明必须逐字出现在回复中" })
    }
  })
})

export const replyReviewSchema = z.object({
  outcome: z.enum(["approve", "revise", "prefer_baseline"]),
  issues: z.array(z.string().trim().min(1).max(500)).max(12),
  reason: z.string().trim().min(1).max(1000),
}).strict().superRefine((value, context) => {
  if (value.outcome === "revise" && value.issues.length === 0) {
    context.addIssue({ code: "custom", path: ["issues"], message: "要求重写时必须说明问题" })
  }
})

export type ComposedReply = z.infer<typeof composedReplySchema>
export type ReplyReview = z.infer<typeof replyReviewSchema>

export const learningProposalSchema = z.object({
  action: z.enum(["add", "reinforce", "conflict", "noop"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().max(12000),
  scope: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).nullable(),
  branch: z.string().trim().max(120).nullable(),
  risk: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  evidenceReplyIds: z.array(z.string().uuid()).max(50),
  codeEvidencePaths: z.array(z.string().trim().min(1).max(500)).max(10),
  reason: z.string().trim().min(1).max(1000),
}).strict()

export const learningResultSchema = z.object({
  proposals: z.array(learningProposalSchema).max(30),
  summary: z.string().trim().min(1).max(1000),
}).strict()

export type LearningResult = z.infer<typeof learningResultSchema>

const relativeCodePathSchema = z.string().trim().min(1).max(500).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false
  return !value.split("/").some((part) => part === "" || part === "." || part === "..")
}, "代码证据必须是当前快照内的安全相对路径")

export const referenceClassificationSchema = z.enum([
  "style",
  "correction",
  "business_rule",
  "ephemeral",
  "action_result",
  "general",
])

export const referenceProposalSchema = z.object({
  classification: referenceClassificationSchema,
  action: z.enum(["add", "reinforce", "conflict", "noop"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  scope: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120).nullable(),
  branch: z.string().trim().min(1).max(120).nullable(),
  risk: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  evidenceObservationIds: z.array(z.string().uuid()).min(1).max(50),
  codeEvidencePaths: z.array(relativeCodePathSchema).max(10),
  reason: z.string().trim().min(1).max(1000),
}).strict()

export const referenceProposalResultSchema = z.object({
  proposals: z.array(referenceProposalSchema).max(30),
}).strict()

export type ReferenceClassification = z.infer<typeof referenceClassificationSchema>
export type ReferenceProposal = z.infer<typeof referenceProposalSchema>
export type ReferenceProposalResult = z.infer<typeof referenceProposalResultSchema>

export const threadRouteActionSchema = z.enum([
  "follow_up",
  "new_thread",
  "split",
  "idle",
  "uncertain",
  "candidate_1",
  "candidate_2",
])

export const threadRouteIssueSchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1).max(32),
  questionFragment: z.string().trim().min(1).max(12000),
}).strict()

export const threadInvestigationEffectSchema = z.enum(["changes_input", "status_only"])

const threadRouteResultShape = {
  questionFragment: z.string().trim().max(12000),
  issues: z.array(threadRouteIssueSchema).min(2).max(8).nullable().optional(),
  investigationEffect: threadInvestigationEffectSchema.optional(),
  progressReply: z.string().trim().min(1).max(500).nullable().optional(),
  reason: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  clarificationReply: z.string().trim().min(1).max(240).nullable(),
} as const

export const classifyThreadRouteResultSchema = z.object({
  action: z.enum(["follow_up", "new_thread", "split", "idle", "uncertain"]),
  ...threadRouteResultShape,
}).strict().superRefine((value, context) => {
  if (value.action === "split" && !value.issues) {
    context.addIssue({ code: "custom", path: ["issues"], message: "拆分路由必须提供至少两个问题单元" })
  }
  if (value.action !== "split" && value.issues != null) {
    context.addIssue({ code: "custom", path: ["issues"], message: "非拆分路由不能提供问题单元" })
  }
  if (value.investigationEffect === "status_only" && value.action !== "follow_up") {
    context.addIssue({ code: "custom", path: ["investigationEffect"], message: "只有后续追问可以是不改变排查输入的进度询问" })
  }
  if (value.investigationEffect === "status_only" && !value.progressReply) {
    context.addIssue({ code: "custom", path: ["progressReply"], message: "进度询问必须生成当班客服的进度回复" })
  }
  if (value.investigationEffect !== "status_only" && value.progressReply != null) {
    context.addIssue({ code: "custom", path: ["progressReply"], message: "非进度询问不能生成进度回复" })
  }
})

export const resolveThreadRouteResultSchema = z.object({
  action: z.enum(["candidate_1", "candidate_2", "new_thread", "idle", "uncertain"]),
  ...threadRouteResultShape,
}).strict().superRefine((value, context) => {
  if (value.issues != null) {
    context.addIssue({ code: "custom", path: ["issues"], message: "待归属回答不能拆分为新问题" })
  }
  if (value.investigationEffect === "status_only") {
    context.addIssue({ code: "custom", path: ["investigationEffect"], message: "待归属回答不能声明为进度询问" })
  }
  if (value.progressReply != null) {
    context.addIssue({ code: "custom", path: ["progressReply"], message: "待归属回答不能生成进度回复" })
  }
})

export const threadRouteResultSchema = z.object({
  action: threadRouteActionSchema,
  ...threadRouteResultShape,
}).strict().superRefine((value, context) => {
  if (value.action === "split" && !value.issues) {
    context.addIssue({ code: "custom", path: ["issues"], message: "拆分路由必须提供至少两个问题单元" })
  }
  if (value.action !== "split" && value.issues != null) {
    context.addIssue({ code: "custom", path: ["issues"], message: "非拆分路由不能提供问题单元" })
  }
  if (value.investigationEffect === "status_only" && value.action !== "follow_up") {
    context.addIssue({ code: "custom", path: ["investigationEffect"], message: "只有后续追问可以是不改变排查输入的进度询问" })
  }
  if (value.investigationEffect === "status_only" && !value.progressReply) {
    context.addIssue({ code: "custom", path: ["progressReply"], message: "进度询问必须生成当班客服的进度回复" })
  }
  if (value.investigationEffect !== "status_only" && value.progressReply != null) {
    context.addIssue({ code: "custom", path: ["progressReply"], message: "非进度询问不能生成进度回复" })
  }
})

export type ThreadRouteAction = z.infer<typeof threadRouteActionSchema>
export type ThreadRouteResult = z.infer<typeof threadRouteResultSchema>

const evidenceFactJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "statement", "provenance", "evidenceSource", "evidence", "certainty", "outboundSafe"],
  properties: {
    id: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
    statement: { type: "string", minLength: 1, maxLength: 1000 },
    provenance: {
      type: "string",
      enum: ["user_report", "display", "request", "response", "callback", "runtime", "code", "document", "inference", "recommendation"],
    },
    evidenceSource: { type: "string", enum: ["message", "document", "code", "server", "log", "database", "redis", "inference"] },
    evidence: { type: "string", maxLength: 1000 },
    certainty: { type: "string", enum: ["confirmed", "reported", "inferred"] },
    outboundSafe: { type: "boolean" },
  },
} as const

const evidencePacketJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "communication", "facts", "requiredAnswerPoints", "unknowns", "handlingNotes", "reviewLevel"],
  properties: {
    version: { type: "string", enum: ["1"] },
    communication: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "recipient", "desiredOutcome"],
      properties: {
        intent: { type: "string", enum: ["direct_answer", "copyable_message", "minimal_clarification", "handoff", "ignore"] },
        recipient: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
        desiredOutcome: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    facts: { type: "array", maxItems: 24, items: evidenceFactJsonSchema },
    requiredAnswerPoints: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
    unknowns: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
    handlingNotes: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
    reviewLevel: { type: "string", enum: ["standard", "strict"] },
  },
} as const

export const answerDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "escalationType", "humanOperation", "answer", "quote", "reason", "confidence", "usedMemoryVersionIds", "answerClaims", "responsibility", "interaction", "investigation", "evidencePacket"],
  properties: {
    decision: { type: "string", enum: ["reply", "ignore", "escalate"] },
    escalationType: { type: "string", enum: ["none", "code_defect", "technical_change", "feature_request", "service_handoff", "human_operation"] },
    humanOperation: {
      anyOf: [{
        type: "object",
        additionalProperties: false,
        required: ["action", "identifiers"],
        properties: {
          action: { type: "string", minLength: 1, maxLength: 300 },
          identifiers: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      }, { type: "null" }],
    },
    answer: { type: "string", maxLength: 12000 },
    quote: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    usedMemoryVersionIds: { type: "array", maxItems: 30, items: { type: "string" } },
    answerClaims: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "provenance", "evidenceSource", "evidence"],
        properties: {
          statement: { type: "string", minLength: 1, maxLength: 1000 },
          provenance: {
            type: "string",
            enum: ["user_report", "display", "request", "response", "callback", "runtime", "code", "document", "inference", "recommendation"],
          },
          evidenceSource: { type: "string", enum: ["message", "document", "code", "server", "log", "database", "redis", "inference"] },
          evidence: { type: "string", maxLength: 1000 },
        },
      },
    },
    responsibility: {
      type: "object",
      additionalProperties: false,
      required: ["party", "certainty", "evidenceSources"],
      properties: {
        party: {
          type: "string",
          enum: ["our_side", "merchant", "upstream", "bank", "third_party", "shared", "unknown", "not_applicable"],
        },
        certainty: { type: "string", enum: ["confirmed", "inference", "unknown", "not_applicable"] },
        evidenceSources: {
          type: "array",
          maxItems: 8,
          items: { type: "string", enum: ["message", "document", "code", "server", "log", "database", "redis", "inference"] },
        },
      },
    },
    interaction: {
      type: "object",
      additionalProperties: false,
      required: ["sentiment", "situation", "underlyingNeed", "responseStrategy"],
      properties: {
        sentiment: { type: "string", enum: ["neutral", "confused", "frustrated", "hostile"] },
        situation: { type: "string", enum: ["new_request", "followup", "correction", "complaint", "identity_challenge", "scope_boundary"] },
        underlyingNeed: { type: "string", minLength: 1, maxLength: 300 },
        responseStrategy: { type: "string", enum: ["direct_answer", "minimal_clarification", "service_recovery", "boundary_with_next_step", "ignore"] },
      },
    },
    investigation: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "steps"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 2000 },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 24,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "title", "status", "evidence", "conclusion"],
            properties: {
              source: { type: "string", enum: ["message", "document", "code", "server", "log", "database", "redis", "inference"] },
              title: { type: "string", minLength: 1, maxLength: 160 },
              status: { type: "string", enum: ["confirmed", "not_found", "failed", "skipped"] },
              evidence: { type: "string", maxLength: 4000 },
              conclusion: { type: "string", minLength: 1, maxLength: 1000 },
            },
          },
        },
      },
    },
    evidencePacket: evidencePacketJsonSchema,
  },
} as const

export const composedReplyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "quote", "claims", "usedMemoryVersionIds"],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 12000 },
    quote: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
    claims: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factId", "statement"],
        properties: {
          factId: evidenceFactJsonSchema.properties.id,
          statement: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
    usedMemoryVersionIds: { type: "array", maxItems: 30, items: { type: "string" } },
  },
} as const

export const replyReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "issues", "reason"],
  properties: {
    outcome: { type: "string", enum: ["approve", "revise", "prefer_baseline"] },
    issues: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const

export const learningResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposals", "summary"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "title", "content", "scope", "region", "branch", "risk", "confidence", "evidenceReplyIds", "codeEvidencePaths", "reason"],
        properties: {
          action: { type: "string", enum: ["add", "reinforce", "conflict", "noop"] },
          title: { type: "string", minLength: 1, maxLength: 160 },
          content: { type: "string", maxLength: 12000 },
          scope: { type: "string", minLength: 1, maxLength: 120 },
          region: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
          branch: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceReplyIds: { type: "array", maxItems: 50, items: { type: "string" } },
          codeEvidencePaths: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500 } },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
    summary: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const

const relativeCodePathJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[^\\u0000]+$",
} as const

export const referenceProposalResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "classification", "action", "title", "content", "scope", "region", "branch", "risk", "confidence",
          "evidenceObservationIds", "codeEvidencePaths", "reason",
        ],
        properties: {
          classification: { type: "string", enum: ["style", "correction", "business_rule", "ephemeral", "action_result", "general"] },
          action: { type: "string", enum: ["add", "reinforce", "conflict", "noop"] },
          title: { type: "string", minLength: 1, maxLength: 160 },
          content: { type: "string", minLength: 1, maxLength: 12000 },
          scope: { type: "string", minLength: 1, maxLength: 120 },
          region: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
          branch: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceObservationIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
          codeEvidencePaths: { type: "array", maxItems: 10, items: relativeCodePathJsonSchema },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
} as const

export const threadRouteResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "questionFragment", "issues", "investigationEffect", "progressReply", "reason", "confidence", "clarificationReply"],
  properties: {
    action: { type: "string", enum: ["follow_up", "new_thread", "split", "idle", "uncertain", "candidate_1", "candidate_2"] },
    questionFragment: { type: "string", maxLength: 12000 },
    issues: {
      anyOf: [{
        type: "array",
        minItems: 2,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["eventIds", "questionFragment"],
          properties: {
            eventIds: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
            questionFragment: { type: "string", minLength: 1, maxLength: 12000 },
          },
        },
      }, { type: "null" }],
    },
    investigationEffect: { type: "string", enum: ["changes_input", "status_only"] },
    progressReply: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    clarificationReply: { anyOf: [{ type: "string", minLength: 1, maxLength: 240 }, { type: "null" }] },
  },
} as const

function threadRouteJsonSchema(actions: readonly string[]) {
  return {
    ...threadRouteResultJsonSchema,
    properties: {
      ...threadRouteResultJsonSchema.properties,
      action: { type: "string", enum: actions },
    },
  } as const
}

export const classifyThreadRouteResultJsonSchema = threadRouteJsonSchema([
  "follow_up", "new_thread", "split", "idle", "uncertain",
] as const)

export const resolveThreadRouteResultJsonSchema = threadRouteJsonSchema([
  "candidate_1", "candidate_2", "new_thread", "idle", "uncertain",
] as const)
