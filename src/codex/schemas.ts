import { z } from "zod"

const investigationSourceSchema = z.enum([
  "message", "memory", "document", "code", "server", "log", "database", "redis", "inference",
])

export const investigationStepSchema = z.object({
  source: investigationSourceSchema,
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

const evidenceFactIdSchema = z.string().regex(/^F(?:[1-9]|1\d|2[0-4])$/u)
const evidenceAssociationIdSchema = z.string().regex(/^A(?:[1-9]|1\d|2[0-4])$/u)

const answerClaimProvenanceSchema = z.enum([
  "user_report", "display", "request", "response", "callback", "runtime", "memory", "code", "document", "inference", "recommendation",
])

export type EvidenceProvenance = z.infer<typeof answerClaimProvenanceSchema>
export type EvidenceSource = z.infer<typeof investigationSourceSchema>

const runtimeEvidenceSources = new Set<EvidenceSource>(["server", "log", "database", "redis"])

export function evidenceSourceMatchesProvenance(
  provenance: EvidenceProvenance,
  evidenceSource: EvidenceSource,
): boolean {
  if (provenance === "user_report" || provenance === "display") return evidenceSource === "message"
  if (provenance === "request" || provenance === "response"
    || provenance === "callback" || provenance === "runtime") {
    return runtimeEvidenceSources.has(evidenceSource)
  }
  if (provenance === "memory") return evidenceSource === "memory"
  if (provenance === "code") return evidenceSource === "code"
  if (provenance === "document") return evidenceSource === "document"
  if (provenance === "inference") return evidenceSource === "inference"
  if (provenance === "recommendation") return evidenceSource !== "inference"
  const exhausted: never = provenance
  return exhausted
}

export function evidenceProvenanceCanSupportCurrentResponsibility(
  provenance: EvidenceProvenance,
): boolean {
  if (provenance === "request" || provenance === "response" || provenance === "callback"
    || provenance === "runtime" || provenance === "code" || provenance === "document") return true
  if (provenance === "user_report" || provenance === "display" || provenance === "memory"
    || provenance === "inference" || provenance === "recommendation") return false
  const exhausted: never = provenance
  return exhausted
}

function requireEvidenceSourcePair(
  value: { provenance: EvidenceProvenance; evidenceSource: EvidenceSource },
  context: z.RefinementCtx,
): void {
  if (evidenceSourceMatchesProvenance(value.provenance, value.evidenceSource)) return
  context.addIssue({
    code: "custom",
    path: ["evidenceSource"],
    message: `provenance=${value.provenance} 不能使用 evidenceSource=${value.evidenceSource}`,
  })
}

const answerClaimFields = {
  statement: z.string().trim().min(1).max(1000),
  provenance: answerClaimProvenanceSchema,
  evidenceSource: investigationStepSchema.shape.source,
  evidence: z.string().trim().max(1000),
} as const

/** 仅用于读取升级前的夹具；不得作为生产模型输出 validator。 */
export const legacyAnswerClaimSchema = z.object({
  factId: evidenceFactIdSchema.optional(),
  ...answerClaimFields,
}).strict()

export const answerClaimSchema = z.object({
  factId: evidenceFactIdSchema,
  ...answerClaimFields,
}).strict().superRefine((value, context) => {
  requireEvidenceSourcePair(value, context)
})

export type AnswerClaim = z.infer<typeof answerClaimSchema>
export type LegacyAnswerClaim = z.infer<typeof legacyAnswerClaimSchema>

const responsibilityAssessmentFields = {
  party: z.enum(["our_side", "merchant", "upstream", "bank", "third_party", "shared", "unknown", "not_applicable"]),
  certainty: z.enum(["confirmed", "inference", "unknown", "not_applicable"]),
  evidenceSources: z.array(investigationStepSchema.shape.source).max(8),
} as const

function refineResponsibilityAssessment(
  value: Pick<z.infer<z.ZodObject<typeof responsibilityAssessmentFields>>, "party" | "certainty" | "evidenceSources">,
  context: z.RefinementCtx,
): void {
  if ((value.party === "unknown" || value.party === "not_applicable")
    && !["unknown", "not_applicable"].includes(value.certainty)) {
    context.addIssue({ code: "custom", path: ["certainty"], message: "未知或不适用责任不能标为已确认或推断" })
  }
  if (value.certainty === "confirmed" && value.evidenceSources.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceSources"], message: "已确认责任必须声明证据来源" })
  }
  if (value.certainty === "confirmed" && value.evidenceSources.includes("memory")) {
    context.addIssue({
      code: "custom",
      path: ["evidenceSources"],
      message: "AI 记忆不能登记为本轮已确认责任的当前证据",
    })
  }
}

const legacyResponsibilityAssessmentSchema = z.object(responsibilityAssessmentFields)
  .strict()
  .superRefine(refineResponsibilityAssessment)

export const responsibilityAssessmentSchema = z.object({
  ...responsibilityAssessmentFields,
  factIds: z.array(evidenceFactIdSchema).max(24),
}).strict().superRefine((value, context) => {
  refineResponsibilityAssessment(value, context)
  if (new Set(value.evidenceSources).size !== value.evidenceSources.length) {
    context.addIssue({ code: "custom", path: ["evidenceSources"], message: "责任证据来源不能重复" })
  }
  if (new Set(value.factIds).size !== value.factIds.length) {
    context.addIssue({ code: "custom", path: ["factIds"], message: "责任证据事实引用不能重复" })
  }
  const unknownParty = value.party === "unknown" || value.party === "not_applicable"
  const validState = value.party === "unknown"
    ? value.certainty === "unknown"
    : value.party === "not_applicable"
      ? value.certainty === "not_applicable"
      : value.certainty === "confirmed" || value.certainty === "inference"
  if (!validState) {
    context.addIssue({ code: "custom", path: ["certainty"], message: "责任 party 与 certainty 状态不匹配" })
  }
  if (!unknownParty && value.certainty === "inference" && value.evidenceSources.includes("memory")) {
    context.addIssue({
      code: "custom",
      path: ["evidenceSources"],
      message: "AI 记忆不能登记为本轮推断责任的当前证据",
    })
  }
  if (unknownParty && value.factIds.length > 0) {
    context.addIssue({ code: "custom", path: ["factIds"], message: "未知或不适用责任不能引用责任证据事实" })
  }
  if (unknownParty && value.evidenceSources.length > 0) {
    context.addIssue({ code: "custom", path: ["evidenceSources"], message: "未知或不适用责任不能声明责任证据来源" })
  }
  if (!unknownParty && ["confirmed", "inference"].includes(value.certainty) && value.factIds.length === 0) {
    context.addIssue({ code: "custom", path: ["factIds"], message: "已知责任的确认或推断必须引用至少一项具体事实" })
  }
  if (!unknownParty && ["confirmed", "inference"].includes(value.certainty) && value.evidenceSources.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceSources"], message: "已知责任的确认或推断必须声明具体事实来源" })
  }
})

export type ResponsibilityAssessment = z.infer<typeof responsibilityAssessmentSchema>

export const evidenceSubjectKindSchema = z.enum(["general", "transaction", "configuration", "merchant", "channel"])
export const evidenceBusinessTypeSchema = z.enum(["collection", "payment", "unknown", "not_applicable"])
export const stableIdentifierKindSchema = z.enum([
  "system_order_no", "merchant_order_no", "upstream_order_no", "bank_reference", "request_id",
])
export const lookupHintKindSchema = z.enum(["amount", "time", "recipient", "account", "merchant", "channel"])

export const evidenceIdentifierSchema = z.object({
  kind: stableIdentifierKindSchema,
  value: z.string().trim().min(1).max(300),
}).strict()

const legacyEvidenceFactSchema = z.object({
  id: evidenceFactIdSchema,
  statement: z.string().trim().min(1).max(1000),
  provenance: legacyAnswerClaimSchema.shape.provenance,
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

export const evidenceFactSchema = z.object({
  id: evidenceFactIdSchema,
  statement: z.string().trim().min(1).max(1000),
  provenance: answerClaimProvenanceSchema,
  evidenceSource: investigationStepSchema.shape.source,
  evidence: z.string().trim().max(1000),
  certainty: z.enum(["confirmed", "reported", "inferred"]),
  outboundSafe: z.boolean(),
  subjectKind: evidenceSubjectKindSchema,
  businessType: evidenceBusinessTypeSchema,
  identifiers: z.array(evidenceIdentifierSchema).max(12),
  associationId: evidenceAssociationIdSchema.nullable(),
  dependsOnFactIds: z.array(evidenceFactIdSchema).max(24),
}).strict().superRefine((value, context) => {
  requireEvidenceSourcePair(value, context)
  const isInferenceFact = value.provenance === "inference"
    && value.evidenceSource === "inference"
    && value.certainty === "inferred"
  const hasInferenceField = value.provenance === "inference"
    || value.evidenceSource === "inference"
    || value.certainty === "inferred"
  if (hasInferenceField && !isInferenceFact) {
    context.addIssue({
      code: "custom",
      path: ["certainty"],
      message: "推断事实必须同时使用 provenance=inference、evidenceSource=inference 和 certainty=inferred",
    })
  }
  if (isInferenceFact && value.dependsOnFactIds.length === 0) {
    context.addIssue({ code: "custom", path: ["dependsOnFactIds"], message: "推断事实必须引用至少一项前置事实" })
  }
  if (value.provenance === "user_report" && value.certainty !== "reported") {
    context.addIssue({ code: "custom", path: ["certainty"], message: "聊天转述事实只能标为 reported" })
  }
  if (value.evidenceSource === "memory" && !["general", "configuration"].includes(value.subjectKind)) {
    context.addIssue({
      code: "custom",
      path: ["subjectKind"],
      message: "AI 记忆只能表达一般或配置知识，不能充当当前交易、商户或通道事实",
    })
  }
  if (value.evidenceSource === "memory" && value.identifiers.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["identifiers"],
      message: "AI 记忆不能提供当前交易稳定标识",
    })
  }
  if (value.provenance === "display" && (
    value.evidenceSource !== "message"
    || value.certainty !== "reported"
    || value.subjectKind !== "general"
    || value.businessType !== "not_applicable"
    || value.identifiers.length > 0
    || value.associationId !== null
    || value.dependsOnFactIds.length > 0
  )) {
    context.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "截图展示只能登记为脱离交易关联、无依赖和无稳定标识的一般报告性事实",
    })
  }
  if (value.subjectKind !== "transaction" && value.identifiers.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["identifiers"],
      message: "非交易事实不能携带交易稳定标识",
    })
  }
  if (value.subjectKind !== "transaction" && value.associationId !== null) {
    context.addIssue({
      code: "custom",
      path: ["associationId"],
      message: "非交易事实不能加入交易关联",
    })
  }
})

export const evidenceAssociationSchema = z.object({
  id: evidenceAssociationIdSchema,
  subjectKind: z.literal("transaction"),
  status: z.enum(["confirmed", "unconfirmed", "conflicting"]),
  factIds: z.array(evidenceFactIdSchema).max(24),
  matchedIdentifiers: z.array(z.object({
    kind: stableIdentifierKindSchema,
    value: z.string().trim().min(1).max(300),
    factIds: z.tuple([evidenceFactIdSchema, evidenceFactIdSchema]),
  }).strict()).max(12),
  lookupHints: z.array(z.object({
    kind: lookupHintKindSchema,
    value: z.string().trim().min(1).max(300),
    factIds: z.array(evidenceFactIdSchema).max(24),
  }).strict()).max(24),
  conflicts: z.array(z.object({
    field: z.enum(["business_type", "service", "merchant", "channel", "identifier"]),
    leftFactId: evidenceFactIdSchema,
    rightFactId: evidenceFactIdSchema,
    summary: z.string().trim().min(1).max(500),
  }).strict()).max(24),
}).strict()

const evidencePacketCommonFields = {
  communication: z.object({
    intent: z.enum(["direct_answer", "copyable_message", "minimal_clarification", "handoff", "ignore"]),
    recipient: z.string().trim().min(1).max(120).nullable(),
    desiredOutcome: z.string().trim().min(1).max(500),
  }).strict(),
  requiredAnswerPoints: z.array(z.string().trim().min(1).max(500)).max(12),
  unknowns: z.array(z.string().trim().min(1).max(500)).max(12),
  handlingNotes: z.array(z.string().trim().min(1).max(500)).max(12),
  reviewLevel: z.enum(["standard", "strict"]),
} as const

export const evidencePacketSchema = z.object({
  version: z.literal("2"),
  ...evidencePacketCommonFields,
  facts: z.array(evidenceFactSchema).max(24),
  associations: z.array(evidenceAssociationSchema).max(24),
}).strict().superRefine((value, context) => {
  const ids = value.facts.map((fact) => fact.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["facts"], message: "证据事实 ID 不能重复" })
  }
  const associationIds = value.associations.map((association) => association.id)
  if (new Set(associationIds).size !== associationIds.length) {
    context.addIssue({ code: "custom", path: ["associations"], message: "交易关联 ID 不能重复" })
  }
  if (value.communication.intent === "copyable_message" && !value.communication.recipient) {
    context.addIssue({ code: "custom", path: ["communication", "recipient"], message: "可转发沟通必须说明接收方" })
  }
})

const legacyEvidencePacketSchema = z.object({
  version: z.literal("1"),
  ...evidencePacketCommonFields,
  facts: z.array(legacyEvidenceFactSchema).max(24),
}).strict().superRefine((value, context) => {
  const ids = value.facts.map((fact) => fact.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["facts"], message: "证据事实 ID 不能重复" })
  }
  if (value.communication.intent === "copyable_message" && !value.communication.recipient) {
    context.addIssue({ code: "custom", path: ["communication", "recipient"], message: "可转发沟通必须说明接收方" })
  }
})

/** 只读版本化解析，不会把历史 v1 补写或升级为可发送的 v2。 */
export const persistedEvidencePacketSchema = z.union([evidencePacketSchema, legacyEvidencePacketSchema])

export type EvidenceFact = z.infer<typeof evidenceFactSchema>
export type EvidencePacket = z.infer<typeof evidencePacketSchema>
export type EvidenceAssociation = z.infer<typeof evidenceAssociationSchema>

const humanOperationSchema = z.object({
  action: z.string().trim().min(1).max(300),
  identifiers: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
}).strict()

const answerDecisionCommonFields = {
  decision: z.enum(["reply", "ignore", "escalate"]),
  escalationType: z.enum(["none", "code_defect", "technical_change", "feature_request", "service_handoff", "human_operation"]),
  answer: z.string().max(12000),
  quote: z.string().max(1000).nullable(),
  reason: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  usedMemoryVersionIds: z.array(z.string().uuid()).max(30),
  investigation: investigationTraceSchema,
} as const

/** 仅用于升级前决定和测试夹具的受控读取；生产模型必须使用 answerDecisionModelSchema。 */
export const compatibleAnswerDecisionSchema = z.object({
  ...answerDecisionCommonFields,
  humanOperation: humanOperationSchema.nullable().optional(),
  // 兼容升级前的测试夹具；正式回答模型 JSON Schema 始终要求提供。
  answerClaims: z.array(legacyAnswerClaimSchema).max(24).optional(),
  // 兼容升级前的持久记录和测试夹具；正式回答模型 JSON Schema 始终要求提供。
  responsibility: z.union([responsibilityAssessmentSchema, legacyResponsibilityAssessmentSchema]).optional(),
  // 兼容升级前的持久记录和测试夹具；正式模型 JSON Schema 始终要求提供。
  interaction: customerInteractionSchema.optional(),
  // 兼容升级前的持久记录和测试夹具；正式调查模型 JSON Schema 始终要求提供。
  evidencePacket: persistedEvidencePacketSchema.optional(),
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

export const answerDecisionModelSchema = z.object({
  ...answerDecisionCommonFields,
  humanOperation: humanOperationSchema.nullable(),
  answerClaims: z.array(answerClaimSchema).max(24),
  responsibility: responsibilityAssessmentSchema,
  interaction: customerInteractionSchema,
  evidencePacket: evidencePacketSchema,
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
  if (value.decision !== "ignore" && value.evidencePacket.requiredAnswerPoints.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidencePacket", "requiredAnswerPoints"],
      message: "需要回复或升级时必须列出至少一个必答要点",
    })
  }
  if (value.decision !== "ignore" && value.answerClaims.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["answerClaims"],
      message: "需要回复或升级时必须提供至少一项事实声明",
    })
  }
  if (value.decision !== "ignore" && value.evidencePacket.facts.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidencePacket", "facts"],
      message: "需要回复或升级时必须提供至少一项证据事实",
    })
  }
  value.answerClaims.forEach((claim, index) => {
    if (!value.answer.includes(claim.statement)) {
      context.addIssue({
        code: "custom",
        path: ["answerClaims", index, "statement"],
        message: "事实声明必须逐字出现在回复中",
      })
    }
  })
}).transform((value) => value.decision === "ignore" ? { ...value, answer: "", quote: null } : value)

export type AnswerDecision = z.infer<typeof answerDecisionModelSchema>

export const composedReplySchema = z.object({
  answer: z.string().max(12000),
  quote: z.string().max(1000).nullable(),
  claims: z.array(z.object({
    factId: evidenceFactSchema.shape.id,
    statement: z.string().trim().min(1).max(1000),
  }).strict()).min(1).max(24),
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
  if (value.outcome === "approve" && value.issues.length > 0) {
    context.addIssue({ code: "custom", path: ["issues"], message: "审核通过时不得同时报告问题" })
  }
  if (value.outcome !== "approve" && value.issues.length === 0) {
    context.addIssue({ code: "custom", path: ["issues"], message: "拒绝当前候选时必须说明问题" })
  }
})

export type ComposedReply = z.infer<typeof composedReplySchema>
export type ReplyReview = z.infer<typeof replyReviewSchema>

export const technicalAvailabilityReplySchema = z.object({
  answer: z.string().trim().min(1).max(500),
}).strict()

export type TechnicalAvailabilityReply = z.infer<typeof technicalAvailabilityReplySchema>

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
export const threadMessageIntentSchema = z.enum([
  "actionable",
  "progress_request",
  "non_actionable",
  "unclear",
])

const threadRouteResultShape = {
  messageIntent: threadMessageIntentSchema,
  questionFragment: z.string().trim().max(12000),
  issues: z.array(threadRouteIssueSchema).min(2).max(8).nullable(),
  investigationEffect: threadInvestigationEffectSchema.nullable(),
  reason: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  clarificationReply: z.string().trim().min(1).max(240).nullable(),
} as const

function validateThreadRouteSemantics(
  value: {
    action: z.infer<typeof threadRouteActionSchema>
    messageIntent: z.infer<typeof threadMessageIntentSchema>
    investigationEffect: z.infer<typeof threadInvestigationEffectSchema> | null
  },
  context: z.RefinementCtx,
): void {
  const actionableAction = value.action === "new_thread"
    || value.action === "split"
    || value.action === "candidate_1"
    || value.action === "candidate_2"
    || (value.action === "follow_up" && value.investigationEffect === "changes_input")
  if (value.messageIntent === "actionable"
    && (!actionableAction || value.investigationEffect !== "changes_input")) {
    context.addIssue({ code: "custom", path: ["messageIntent"], message: "可执行消息必须进入新问题、拆分、候选选择或改变输入的后续补充" })
  }
  if (value.messageIntent === "progress_request"
    && (value.action !== "follow_up" || value.investigationEffect !== "status_only")) {
    context.addIssue({ code: "custom", path: ["messageIntent"], message: "进度询问只能是不改变排查输入的后续消息" })
  }
  if (value.messageIntent === "non_actionable"
    && (value.action !== "idle" || value.investigationEffect !== null)) {
    context.addIssue({ code: "custom", path: ["messageIntent"], message: "无需处理的消息只能静默忽略" })
  }
  if (value.messageIntent === "unclear"
    && ((value.action !== "idle" && value.action !== "uncertain") || value.investigationEffect !== null)) {
    context.addIssue({ code: "custom", path: ["messageIntent"], message: "意图不清只能静默忽略或进入歧义确认" })
  }
  if (value.messageIntent !== "actionable" && actionableAction) {
    context.addIssue({ code: "custom", path: ["action"], message: "创建、拆分、候选选择或改变输入必须来自可执行消息" })
  }
  if (value.messageIntent !== "progress_request" && value.investigationEffect === "status_only") {
    context.addIssue({ code: "custom", path: ["investigationEffect"], message: "只有进度询问可以声明 status_only" })
  }
}

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
  validateThreadRouteSemantics(value, context)
})

export const resolveThreadRouteResultSchema = z.object({
  action: z.enum(["candidate_1", "candidate_2", "new_thread", "idle", "uncertain"]),
  ...threadRouteResultShape,
}).strict().superRefine((value, context) => {
  if (value.issues != null) {
    context.addIssue({ code: "custom", path: ["issues"], message: "待归属回答不能拆分为新问题" })
  }
  validateThreadRouteSemantics(value, context)
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
  validateThreadRouteSemantics(value, context)
})

export type ThreadRouteAction = z.infer<typeof threadRouteActionSchema>
export type ThreadRouteResult = z.infer<typeof threadRouteResultSchema>

const evidenceFactJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "statement", "provenance", "evidenceSource", "evidence", "certainty", "outboundSafe",
    "subjectKind", "businessType", "identifiers", "associationId", "dependsOnFactIds",
  ],
  properties: {
    id: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
    statement: { type: "string", minLength: 1, maxLength: 1000 },
    provenance: {
      type: "string",
      enum: ["user_report", "display", "request", "response", "callback", "runtime", "memory", "code", "document", "inference", "recommendation"],
    },
    evidenceSource: { type: "string", enum: ["message", "memory", "document", "code", "server", "log", "database", "redis", "inference"] },
    evidence: { type: "string", maxLength: 1000 },
    certainty: { type: "string", enum: ["confirmed", "reported", "inferred"] },
    outboundSafe: { type: "boolean" },
    subjectKind: { type: "string", enum: ["general", "transaction", "configuration", "merchant", "channel"] },
    businessType: { type: "string", enum: ["collection", "payment", "unknown", "not_applicable"] },
    identifiers: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: {
            type: "string",
            enum: ["system_order_no", "merchant_order_no", "upstream_order_no", "bank_reference", "request_id"],
          },
          value: { type: "string", minLength: 1, maxLength: 300 },
        },
      },
    },
    associationId: {
      anyOf: [{ type: "string", pattern: "^A(?:[1-9]|1[0-9]|2[0-4])$" }, { type: "null" }],
    },
    dependsOnFactIds: {
      type: "array",
      maxItems: 24,
      items: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
    },
  },
} as const

const evidenceAssociationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "subjectKind", "status", "factIds", "matchedIdentifiers", "lookupHints", "conflicts"],
  properties: {
    id: { type: "string", pattern: "^A(?:[1-9]|1[0-9]|2[0-4])$" },
    subjectKind: { type: "string", enum: ["transaction"] },
    status: { type: "string", enum: ["confirmed", "unconfirmed", "conflicting"] },
    factIds: {
      type: "array",
      maxItems: 24,
      items: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
    },
    matchedIdentifiers: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value", "factIds"],
        properties: {
          kind: {
            type: "string",
            enum: ["system_order_no", "merchant_order_no", "upstream_order_no", "bank_reference", "request_id"],
          },
          value: { type: "string", minLength: 1, maxLength: 300 },
          factIds: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
          },
        },
      },
    },
    lookupHints: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value", "factIds"],
        properties: {
          kind: { type: "string", enum: ["amount", "time", "recipient", "account", "merchant", "channel"] },
          value: { type: "string", minLength: 1, maxLength: 300 },
          factIds: {
            type: "array",
            maxItems: 24,
            items: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
          },
        },
      },
    },
    conflicts: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "leftFactId", "rightFactId", "summary"],
        properties: {
          field: { type: "string", enum: ["business_type", "service", "merchant", "channel", "identifier"] },
          leftFactId: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
          rightFactId: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
          summary: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  },
} as const

const evidencePacketJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version", "communication", "facts", "associations", "requiredAnswerPoints", "unknowns", "handlingNotes", "reviewLevel",
  ],
  properties: {
    version: { type: "string", enum: ["2"] },
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
    associations: { type: "array", maxItems: 24, items: evidenceAssociationJsonSchema },
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
        required: ["factId", "statement", "provenance", "evidenceSource", "evidence"],
        properties: {
          factId: evidenceFactJsonSchema.properties.id,
          statement: { type: "string", minLength: 1, maxLength: 1000 },
          provenance: {
            type: "string",
            enum: ["user_report", "display", "request", "response", "callback", "runtime", "memory", "code", "document", "inference", "recommendation"],
          },
          evidenceSource: { type: "string", enum: ["message", "memory", "document", "code", "server", "log", "database", "redis", "inference"] },
          evidence: { type: "string", maxLength: 1000 },
        },
      },
    },
    responsibility: {
      type: "object",
      additionalProperties: false,
      required: ["party", "certainty", "evidenceSources", "factIds"],
      properties: {
        party: {
          type: "string",
          enum: ["our_side", "merchant", "upstream", "bank", "third_party", "shared", "unknown", "not_applicable"],
        },
        certainty: { type: "string", enum: ["confirmed", "inference", "unknown", "not_applicable"] },
        evidenceSources: {
          type: "array",
          maxItems: 8,
          items: { type: "string", enum: ["message", "memory", "document", "code", "server", "log", "database", "redis", "inference"] },
        },
        factIds: {
          type: "array",
          maxItems: 24,
          items: { type: "string", pattern: "^F(?:[1-9]|1[0-9]|2[0-4])$" },
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
              source: { type: "string", enum: ["message", "memory", "document", "code", "server", "log", "database", "redis", "inference"] },
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
      minItems: 1,
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

export const technicalAvailabilityReplyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 500 },
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
  required: ["action", "messageIntent", "questionFragment", "issues", "investigationEffect", "reason", "confidence", "clarificationReply"],
  properties: {
    action: { type: "string", enum: ["follow_up", "new_thread", "split", "idle", "uncertain", "candidate_1", "candidate_2"] },
    messageIntent: { type: "string", enum: ["actionable", "progress_request", "non_actionable", "unclear"] },
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
    investigationEffect: { anyOf: [{ type: "string", enum: ["changes_input", "status_only"] }, { type: "null" }] },
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
