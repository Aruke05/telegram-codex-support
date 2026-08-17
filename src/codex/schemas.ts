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
  // 兼容升级前的持久记录和测试夹具；正式模型 JSON Schema 始终要求提供。
  interaction: customerInteractionSchema.optional(),
  investigation: investigationTraceSchema,
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
}).transform((value) => value.decision === "ignore" ? { ...value, answer: "", quote: null } : value)

export type AnswerDecision = z.infer<typeof answerDecisionSchema>

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
  "idle",
  "uncertain",
  "candidate_1",
  "candidate_2",
])

export const threadRouteResultSchema = z.object({
  action: threadRouteActionSchema,
  questionFragment: z.string().trim().max(12000),
  reason: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  clarificationReply: z.string().trim().min(1).max(240).nullable(),
}).strict()

export type ThreadRouteAction = z.infer<typeof threadRouteActionSchema>
export type ThreadRouteResult = z.infer<typeof threadRouteResultSchema>

export const answerDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "escalationType", "humanOperation", "answer", "quote", "reason", "confidence", "usedMemoryVersionIds", "answerClaims", "interaction", "investigation"],
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
  required: ["action", "questionFragment", "reason", "confidence", "clarificationReply"],
  properties: {
    action: { type: "string", enum: ["follow_up", "new_thread", "idle", "uncertain", "candidate_1", "candidate_2"] },
    questionFragment: { type: "string", maxLength: 12000 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    clarificationReply: { anyOf: [{ type: "string", minLength: 1, maxLength: 240 }, { type: "null" }] },
  },
} as const
