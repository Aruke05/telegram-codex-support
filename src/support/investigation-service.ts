import {
  composedReplySchema,
  evidenceProvenanceCanSupportCurrentResponsibility,
  replyReviewSchema,
  type AnswerDecision,
  type ComposedReply,
  type EvidenceFact,
  type EvidencePacket,
  type InvestigationStep,
  type InvestigationTrace,
  type ReplyReview,
  type ResponsibilityAssessment,
} from "../codex/schemas.js"
import type { CodexCommandObservation } from "../codex/executor.js"
import { ModelExecutionError } from "../models/errors.js"
import {
  type ProjectCodeSnapshot,
  type ProjectCodeSyncService,
} from "../git-sync/project-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeKnowledgeService } from "../runtime/knowledge-service.js"
import type { ModelInstanceSnapshot } from "../runtime/model-config-service.js"
import type { MemoryView, ProjectServiceRecord, ReplyStyle, TelegramRole } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type {
  ResponseDepth,
  SupportAttachmentContext,
  SupportDecisionInput,
  SupportDecisionAgentPort,
  SupportInvestigationCheckpoint,
  SupportResourceSummary,
} from "./agent.js"
import type { ResourceWorkspace } from "./resource-workspace.js"
import {
  applyEvidenceBindingGate,
  type EvidenceBindingIssue,
  EvidenceBindingStructuralError,
} from "./evidence-binding-gate.js"
import {
  type TrustedDatabaseQueryRequest,
  validateTrustedCommandObservation,
} from "./trusted-command-observation.js"

type ResourceBrokerPort = {
  verifyDatabaseQuery?(serviceId: string, request: TrustedDatabaseQueryRequest, signal?: AbortSignal): Promise<{
    columns: string[]
    rows: unknown[]
    truncated: boolean
  }>
}

export type SupportInvestigationInput = {
  serviceId: string
  groupName: string
  question: string
  latestMessage: string
  conversationContext?: string
  priorInvestigation?: SupportInvestigationCheckpoint
  responseDepth: ResponseDepth
  senderRole: TelegramRole["role"] | null
  scope: string
  attachments: SupportAttachmentContext[]
  answerTimeoutSeconds: number
  operatorStyleProfile: unknown
  modelInstanceId: string
  modelSnapshot: ModelInstanceSnapshot
  answerMaxConcurrency: number
  answerBindingEnabled: boolean
  includeAiMemory: boolean
  includeInterfaceDocs: boolean
  includeMagicBook: boolean
  replyStyle: ReplyStyle
  onSnapshot?: (snapshot: ProjectCodeSnapshot) => void | Promise<void>
  onProgress?: (progress: SupportInvestigationProgress) => void | Promise<void>
}

export type SupportInvestigationProgress = {
  snapshot: ProjectCodeSnapshot
  investigation: InvestigationTrace
}

export type SupportInvestigationResult = {
  service: ProjectServiceRecord
  snapshot: ProjectCodeSnapshot
  decision: AnswerDecision
  allowedMemoryIds: Set<string>
  pipelineAudit: SupportReplyPipelineAudit
}

export type SupportReplyPipelineAudit = {
  version: "evidence-binding-review-v2"
  mode: "legacy" | "multi_stage"
  evidencePacket: EvidencePacket | null
  baselineAnswer: string
  firstCandidateAnswer: string | null
  revisedCandidateAnswer: string | null
  reviews: SupportReplyPipelineAuditEvent[]
  finalSource: "baseline" | "first_candidate" | "revised_candidate"
  fallbackReason: string | null
}

export type SupportReplyPipelineAuditEvent = {
  stage: "gate" | "baseline_review" | "revision_review" | "blocked"
  attempt: 0 | 1 | 2
  outcome: "pass" | "issues" | ReplyReview["outcome"] | "blocked"
  issues: string[]
  reason: string
}

export type SupportInvestigationServiceDependencies = {
  database: Pick<RuntimeDatabase, "readProjectServices" | "readServerResources" | "readDatabaseResources">
  codeSync: Pick<ProjectCodeSyncService, "readCurrentSnapshot" | "currentServiceForSnapshot">
  knowledge: Pick<RuntimeKnowledgeService, "listDirectives" | "listAnswerMemories" | "searchStaticKnowledge">
  resourceWorkspace: Pick<ResourceWorkspace, "open">
  redactor: ConfiguredSecretRedactor
  agent: SupportDecisionAgentPort
  resourceBroker?: ResourceBrokerPort
}

const maximumVerifiedDatabaseQueries = 10
const codeObservationStepTitle = "执行代码只读检查"
const attachmentObservationStepTitle = "读取本轮附件"
const databaseObservationStepTitle = "父进程复核数据库只读查询"
const documentObservationStepTitle = "检索当前地区接口文档"
const memoryObservationStepTitle = "读取本轮实际引用的有效记忆"
const visualInputEvidenceMarker = "visualInputAttached=true"
const trustedResultEvidenceMarker = "可信结果正文="
const verifiedMemoryExcerptsMarker = "逐字摘录JSON="
const runtimeResponsibilitySources = ["server", "log", "database", "redis"] as const

function garbled(value: string): boolean {
  return value.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)
}

export class SupportCodeConfigurationChangedError extends Error {
  constructor() {
    super("回答准备期间服务代码配置发生变化")
    this.name = "SupportCodeConfigurationChangedError"
  }
}

export class SupportModelOutputRejectedError extends Error {
  readonly rejectionReasons: string[]

  constructor(
    rejectionReasons: string[] = [],
    readonly pipelineAudit: SupportReplyPipelineAudit | undefined = undefined,
  ) {
    const reasons = [...new Set(rejectionReasons.map((reason) => reason.trim()).filter(Boolean))]
    super(reasons.length > 0
      ? `回答模型结果触发非业务出站安全阻断：${reasons.join("；")}`
      : "回答模型未形成可安全发送的结果")
    this.name = "SupportModelOutputRejectedError"
    this.rejectionReasons = reasons
  }
}

export class SupportEvidenceStructureError extends ModelExecutionError {
  constructor(
    readonly structuralIssues: EvidenceBindingIssue[],
    readonly pipelineAudit: SupportReplyPipelineAudit,
  ) {
    super(
      "structured_output_invalid",
      structuralIssues.length > 0
        ? `回答模型交易证据引用结构无效：${structuralIssues.map((issue) => issue.message).join("；")}`
        : "回答模型交易证据引用结构无效",
    )
    this.name = "SupportEvidenceStructureError"
  }
}

export class SupportCodeSyncRuntimeError extends Error {
  constructor(cause: unknown) {
    super("代码同步发生未分类错误，没有形成可用快照", { cause })
    this.name = "SupportCodeSyncRuntimeError"
  }
}

export class SupportInvestigationService {
  constructor(private readonly deps: SupportInvestigationServiceDependencies) {}

  async investigate(input: SupportInvestigationInput, signal: AbortSignal): Promise<SupportInvestigationResult> {
    const stable = await this.syncStableCode(input.serviceId, signal)
    let { service, snapshot } = stable
    const priorInvestigation = input.priorInvestigation?.codeSnapshotId === snapshot.snapshotId
      ? input.priorInvestigation
      : undefined
    await input.onSnapshot?.(snapshot)
    await this.publishProgress(input, snapshot, this.trustedInvestigation({
      input,
      snapshot,
      documents: [],
      wantsInterfaceDocumentation: false,
      resources: { servers: [], databases: [], checks: [] },
      databaseSteps: [],
      observations: [],
      modelDecision: null,
    }))

    const directives = this.deps.knowledge.listDirectives({ enabled: true, scope: input.scope })
    const memories = input.includeAiMemory ? this.deps.knowledge.listAnswerMemories({
      scope: input.scope,
      region: service.region || null,
      branch: service.branch || null,
      q: input.question,
      limit: 24,
    }) : []
    const allowedMemoryIds = new Set(memories.map((memory) => memory.id))
    const interfaceScope = service.region.trim() === "印度" ? "india" : "non_india"
    const interfaceSource = `interface_${interfaceScope}`
    const interfaceDocuments = input.includeInterfaceDocs
      ? this.deps.knowledge.searchStaticKnowledge(input.question, 20, interfaceScope)
        .filter((document) => document.source === interfaceSource)
      : []
    const magicBookDocuments = input.includeMagicBook
      ? this.deps.knowledge.searchStaticKnowledge(`${input.question} ${service.key} ${service.region}`, 8)
        .filter((document) => document.source === "magicbook")
      : []
    const documents = [...interfaceDocuments, ...magicBookDocuments]
    const resources = this.resources(service.id)
    await this.publishProgress(input, snapshot, this.trustedInvestigation({
      input,
      snapshot,
      documents,
      wantsInterfaceDocumentation: false,
      resources,
      databaseSteps: [],
      observations: [],
      modelDecision: null,
    }))
    const resourceWorkspace = await this.deps.resourceWorkspace.open(service.id, snapshot)
    let decision: AnswerDecision | null = null
    let pipelineAudit: SupportReplyPipelineAudit | null = null
    const observations: CodexCommandObservation[] = []
    const databaseSteps: InvestigationStep[] = []
    const observationKeys = new Set<string>()
    const databaseRequestKeys = new Set<string>()
    let databaseVerificationCount = 0
    let databaseLimitRecorded = false
    try {
      const decisionInput: SupportDecisionInput = {
          service: service.key,
          groupName: input.groupName,
          question: input.question,
          latestMessage: input.latestMessage,
          ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
          ...(priorInvestigation ? { priorInvestigation } : {}),
          responseDepth: input.responseDepth,
          senderRole: input.senderRole,
          scope: input.scope,
          region: service.region || null,
          branch: service.branch,
          codeSnapshot: snapshot,
          directives,
          memories,
          documents,
          resources,
          attachments: input.attachments,
          resourceWorkspacePath: resourceWorkspace.path,
          resourceManifestPath: resourceWorkspace.manifestPath,
          networkHosts: resourceWorkspace.networkHosts,
          answerTimeoutSeconds: input.answerTimeoutSeconds,
          operatorStyleProfile: input.operatorStyleProfile,
          modelInstanceId: input.modelInstanceId,
          modelSnapshot: input.modelSnapshot,
          answerMaxConcurrency: input.answerMaxConcurrency,
          answerBindingEnabled: input.answerBindingEnabled,
          replyStyle: input.replyStyle,
          onCommandObservations: async (items) => {
            for (const item of items) {
              if (signal.aborted) throw new Error("Codex 执行已取消")
              const key = `${item.command}\n${item.output}\n${item.exitCode ?? ""}`
              if (observationKeys.has(key)) continue
              observationKeys.add(key)
              const validated = validateTrustedCommandObservation(item, {
                workspacePath: resourceWorkspace.path,
                codeRoots: snapshot.repositories.map((repository) => repository.snapshotPath),
              })
              if (validated?.kind === "evidence") observations.push(item)
              if (validated?.kind === "database") {
                const requestKey = JSON.stringify([
                  validated.request.databaseAlias,
                  validated.request.serverAlias,
                  validated.request.sql,
                  validated.request.rowLimit,
                ])
                if (databaseRequestKeys.has(requestKey)) continue
                databaseRequestKeys.add(requestKey)
                if (databaseVerificationCount >= maximumVerifiedDatabaseQueries) {
                  if (!databaseLimitRecorded) {
                    databaseLimitRecorded = true
                    databaseSteps.push({
                      source: "database",
                      title: "父进程数据库复核达到安全上限",
                      status: "skipped",
                      evidence: `本轮只执行前 ${maximumVerifiedDatabaseQueries} 个去重后的数据库只读复核请求`,
                      conclusion: "其余数据库请求未执行也未作为本轮已确认依据",
                    })
                  }
                  continue
                }
                databaseVerificationCount += 1
                databaseSteps.push(await this.verifyDatabaseQuery(input.serviceId, validated.request, signal))
              }
            }
            await this.publishProgress(input, snapshot, this.trustedInvestigation({
              input,
              snapshot,
              documents,
              wantsInterfaceDocumentation: false,
              resources,
              databaseSteps,
              observations,
              modelDecision: null,
              workspacePath: resourceWorkspace.path,
            }))
          },
        }
      const generated = await this.deps.agent.decide(decisionInput, signal)
      const usedMemoryIds = new Set(generated.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id)))
      const referencedMemories = memories.filter((memory) => usedMemoryIds.has(memory.id)).slice(0, 3)
      const baseline: AnswerDecision = {
        ...generated,
        investigation: this.trustedInvestigation({
          input,
          snapshot,
          documents,
          wantsInterfaceDocumentation: generated.answerClaims?.some((claim) => (
            claim.provenance === "document" || claim.evidenceSource === "document"
          )) ?? false,
          resources,
          databaseSteps,
          observations,
          memories: referencedMemories,
          modelDecision: generated,
          workspacePath: resourceWorkspace.path,
        }),
      }
      const pipeline = await this.runReplyPipeline(decisionInput, baseline, allowedMemoryIds, signal)
      decision = pipeline.decision
      pipelineAudit = pipeline.audit
      await this.publishProgress(input, snapshot, decision.investigation)
      const outbound = decision.decision !== "ignore" ? this.deps.redactor.assertSafeOutbound(decision.answer) : null
      const unsafeOutbound = Boolean(outbound && (!outbound.allowed || !outbound.safeText.trim() || garbled(outbound.safeText)))
      if (unsafeOutbound) {
        const rejectionReason = "回复为空、乱码或触发敏感信息出站拦截"
        const rejectionReasons = [rejectionReason]
        const rejectedDecision: AnswerDecision = {
          ...decision,
          investigation: {
            summary: "模型结果触发出站安全阻断",
            steps: [...decision.investigation.steps.slice(0, 23), {
              source: "inference",
              title: "出站安全校验",
              status: "failed",
              evidence: rejectionReason,
              conclusion: "结果未发送",
            }],
          },
        }
        decision = rejectedDecision
        await this.publishProgress(input, snapshot, rejectedDecision.investigation)
        pipelineAudit = this.appendBlockedAudit(pipelineAudit, rejectionReason, "出站安全校验阻断，结果未发送")
        throw new SupportModelOutputRejectedError(rejectionReasons, pipelineAudit)
      }
    } finally {
      await resourceWorkspace.cleanup()
    }
    if (!decision) throw new Error("回答模型未形成结果")
    if (!pipelineAudit) throw new Error("回答流水线未形成审计结果")
    await this.publishProgress(input, snapshot, decision.investigation)
    const currentService = this.deps.codeSync.currentServiceForSnapshot(snapshot)
    if (!currentService) throw new SupportCodeConfigurationChangedError()
    service = currentService
    return { service, snapshot, decision, allowedMemoryIds, pipelineAudit }
  }

  private async runReplyPipeline(
    request: SupportDecisionInput,
    baseline: AnswerDecision,
    allowedMemoryIds: Set<string>,
    signal: AbortSignal,
  ): Promise<{ decision: AnswerDecision; audit: SupportReplyPipelineAudit }> {
    const traceBinding = this.filterEvidencePacketByTrace(baseline.evidencePacket, baseline.investigation)
    const filteredPacket = traceBinding.packet
    let declaredGate: ReturnType<typeof applyEvidenceBindingGate>
    let gate: ReturnType<typeof applyEvidenceBindingGate>
    try {
      // 先在模型原始对象上做完整引用结构校验，避免来源过滤掩盖错误；
      // 再对父进程实际确认过的来源做最终门禁。
      declaredGate = applyEvidenceBindingGate({
        packet: baseline.evidencePacket,
        claims: baseline.answerClaims,
        responsibility: baseline.responsibility,
      })
      gate = applyEvidenceBindingGate({
        packet: filteredPacket,
        claims: baseline.answerClaims,
        responsibility: baseline.responsibility,
      })
    } catch (error) {
      if (!(error instanceof EvidenceBindingStructuralError)) throw error
      const safeBaseline = this.redactDecision({ ...baseline, evidencePacket: filteredPacket }, allowedMemoryIds)
      const structuralIssues = error.issues.map((issue) => ({
        ...issue,
        message: this.deps.redactor.redact(issue.message).text.slice(0, 500),
      }))
      const events: SupportReplyPipelineAuditEvent[] = [{
        stage: "gate",
        attempt: 0,
        outcome: "issues",
        issues: structuralIssues.map((issue) => issue.message),
        reason: "证据引用结构校验失败",
      }, {
        stage: "blocked",
        attempt: 0,
        outcome: "blocked",
        issues: structuralIssues.map((issue) => issue.message),
        reason: "结构错误结果未发送",
      }]
      const audit = this.buildPipelineAudit({
        baseline: safeBaseline,
        packet: safeBaseline.evidencePacket,
        mode: "multi_stage",
        revised: null,
        events,
        finalSource: "baseline",
        fallbackReason: "blocked_not_sent: evidence_structure_invalid",
      })
      throw new SupportEvidenceStructureError(structuralIssues, audit)
    }

    const responsibilityBinding = this.bindResponsibilityToTrace(
      baseline.responsibility,
      baseline.investigation,
      gate.packet,
    )
    baseline = { ...baseline, responsibility: responsibilityBinding.responsibility }
    const factById = new Map(gate.packet.facts.map((fact) => [fact.id, fact]))
    const normalizedBaseline: AnswerDecision = {
      ...baseline,
      answerClaims: baseline.answerClaims.map((claim) => {
        const fact = factById.get(claim.factId)!
        return {
          ...claim,
          provenance: fact.provenance,
          evidenceSource: fact.evidenceSource,
          evidence: fact.evidence,
        }
      }),
      evidencePacket: gate.packet,
    }
    const safeBaseline = this.redactDecision(normalizedBaseline, allowedMemoryIds)
    const packet = safeBaseline.evidencePacket
    const uniqueIssues = new Map<string, EvidenceBindingIssue>()
    for (const issue of [
      ...traceBinding.issues,
      ...responsibilityBinding.issues,
      ...declaredGate.issues,
      ...gate.issues,
    ]) {
      const key = `${issue.code}\u0000${issue.associationId ?? ""}\u0000${issue.factId ?? ""}\u0000${issue.claimIndex ?? ""}`
      if (!uniqueIssues.has(key)) uniqueIssues.set(key, issue)
    }
    const gateIssues = [...uniqueIssues.values()]
      .map((issue) => this.deps.redactor.redact(issue.message).text.slice(0, 500))
    const events: SupportReplyPipelineAuditEvent[] = [{
      stage: "gate",
      attempt: 0,
      outcome: gateIssues.length > 0 ? "issues" : "pass",
      issues: gateIssues,
      reason: gateIssues.length > 0 ? "交易证据门禁要求收窄或改写回复" : "交易证据门禁通过",
    }]
    if (safeBaseline.decision === "ignore") {
      return {
        decision: safeBaseline,
        audit: this.buildPipelineAudit({
          baseline: safeBaseline,
          packet,
          mode: "legacy",
          revised: null,
          events,
          finalSource: "baseline",
          fallbackReason: "ignore 不生成对外回复",
        }),
      }
    }

    if (!this.deps.agent.composeReply || !this.deps.agent.reviewReply) {
      const reason = "严格审核所需的成稿或复核能力不可用"
      const blockedEvents = [...events, this.blockedAuditEvent(reason)]
      const audit = this.buildPipelineAudit({
        baseline: safeBaseline,
        packet,
        mode: "multi_stage",
        revised: null,
        events: blockedEvents,
        finalSource: "baseline",
        fallbackReason: `blocked_not_sent: ${reason}`,
      })
      throw new SupportModelOutputRejectedError([reason], audit)
    }

    const baseReviewInput = {
      request,
      decision: {
        decision: safeBaseline.decision,
        escalationType: safeBaseline.escalationType,
        humanOperation: safeBaseline.humanOperation,
        responsibility: safeBaseline.responsibility,
        interaction: safeBaseline.interaction,
      },
      evidencePacket: packet,
      trustedInvestigation: safeBaseline.investigation,
      baseline: {
        answer: safeBaseline.answer,
        quote: safeBaseline.quote,
        answerClaims: safeBaseline.answerClaims,
        usedMemoryVersionIds: safeBaseline.usedMemoryVersionIds,
      },
    } as const
    let revised: ComposedReply | null = null
    try {
      let revisionFeedback = gateIssues.slice(0, 12)
      if (revisionFeedback.length === 0) {
        const baselineCandidate: ComposedReply = {
          answer: safeBaseline.answer,
          quote: safeBaseline.quote,
          claims: safeBaseline.answerClaims.map((claim) => ({
            factId: claim.factId,
            statement: claim.statement,
          })),
          usedMemoryVersionIds: safeBaseline.usedMemoryVersionIds,
        }
        const baselineReview = this.redactReview(await this.deps.agent.reviewReply({
          ...baseReviewInput,
          candidate: baselineCandidate,
          attempt: 1,
        }, signal))
        events.push(this.reviewAuditEvent("baseline_review", 1, baselineReview))
        if (baselineReview.outcome === "approve") {
          return {
            decision: safeBaseline,
            audit: this.buildPipelineAudit({
              baseline: safeBaseline,
              packet,
              mode: "multi_stage",
              revised: null,
              events,
              finalSource: "baseline",
              fallbackReason: null,
            }),
          }
        }
        revisionFeedback = (baselineReview.issues.length > 0
          ? baselineReview.issues
          : [baselineReview.reason]).slice(0, 12)
      }

      revised = this.safeComposedReply(
        await this.deps.agent.composeReply({
          request: baseReviewInput.request,
          decision: baseReviewInput.decision,
          evidencePacket: packet,
          revisionFeedback,
        }, signal),
        packet,
        allowedMemoryIds,
        request.latestMessage ?? request.question,
      )
      const revisionReview = this.redactReview(await this.deps.agent.reviewReply({
        ...baseReviewInput,
        candidate: revised,
        attempt: 2,
      }, signal))
      events.push(this.reviewAuditEvent("revision_review", 2, revisionReview))
      if (revisionReview.outcome === "approve") {
        return this.pipelineResult(safeBaseline, packet, revised, events)
      }
      throw new SupportModelOutputRejectedError([
        `修订稿未通过最终审核：${revisionReview.reason}`,
      ])
    } catch (error) {
      if (signal.aborted) throw error
      const reasons = error instanceof SupportModelOutputRejectedError && error.rejectionReasons.length > 0
        ? error.rejectionReasons
        : [error instanceof Error
            ? `严格审核流水线未完成：${error.name}`
            : "严格审核流水线未完成"]
      const safeReasons = reasons.map((reason) => this.deps.redactor.redact(reason).text.slice(0, 500))
      const blockedEvents = [...events, this.blockedAuditEvent(safeReasons.join("；"))]
      const audit = this.buildPipelineAudit({
        baseline: safeBaseline,
        packet,
        mode: "multi_stage",
        revised,
        events: blockedEvents,
        finalSource: "baseline",
        fallbackReason: `blocked_not_sent: ${safeReasons.join("；")}`.slice(0, 1000),
      })
      if (error instanceof ModelExecutionError && error.code === "structured_output_invalid") {
        throw Object.assign(error, { pipelineAudit: audit })
      }
      throw new SupportModelOutputRejectedError(safeReasons, audit)
    }
  }

  private pipelineResult(
    baseline: AnswerDecision,
    packet: EvidencePacket,
    revised: ComposedReply,
    events: SupportReplyPipelineAuditEvent[],
  ): { decision: AnswerDecision; audit: SupportReplyPipelineAudit } {
    const decision = this.applyComposedReply(baseline, revised, packet)
    return {
      decision,
      audit: this.buildPipelineAudit({
        baseline,
        packet,
        mode: "multi_stage",
        revised,
        events,
        finalSource: "revised_candidate",
        fallbackReason: null,
      }),
    }
  }

  private buildPipelineAudit(options: {
    baseline: AnswerDecision
    packet: EvidencePacket
    mode: SupportReplyPipelineAudit["mode"]
    revised: ComposedReply | null
    events: SupportReplyPipelineAuditEvent[]
    finalSource: SupportReplyPipelineAudit["finalSource"]
    fallbackReason: string | null
  }): SupportReplyPipelineAudit {
    return {
      version: "evidence-binding-review-v2",
      mode: options.mode,
      evidencePacket: options.packet,
      baselineAnswer: options.baseline.answer,
      firstCandidateAnswer: null,
      revisedCandidateAnswer: options.revised?.answer ?? null,
      reviews: options.events,
      finalSource: options.finalSource,
      fallbackReason: options.fallbackReason,
    }
  }

  private reviewAuditEvent(
    stage: "baseline_review" | "revision_review",
    attempt: 1 | 2,
    review: ReplyReview,
  ): SupportReplyPipelineAuditEvent {
    return {
      stage,
      attempt,
      outcome: review.outcome,
      issues: review.issues,
      reason: review.reason,
    }
  }

  private blockedAuditEvent(reason: string): SupportReplyPipelineAuditEvent {
    return {
      stage: "blocked",
      attempt: 0,
      outcome: "blocked",
      issues: reason ? [reason.slice(0, 500)] : [],
      reason: "严格审核未形成获准发送的结果",
    }
  }

  private appendBlockedAudit(
    audit: SupportReplyPipelineAudit,
    reason: string,
    eventReason: string,
  ): SupportReplyPipelineAudit {
    const safeReason = this.deps.redactor.redact(reason).text.slice(0, 500)
    return {
      ...audit,
      reviews: [...audit.reviews, {
        ...this.blockedAuditEvent(safeReason),
        reason: eventReason,
      }],
      fallbackReason: `blocked_not_sent: ${safeReason}`.slice(0, 1000),
    }
  }

  private applyComposedReply(baseline: AnswerDecision, composed: ComposedReply, packet: EvidencePacket): AnswerDecision {
    const facts = new Map(packet.facts.map((fact) => [fact.id, fact]))
    const claims: AnswerDecision["answerClaims"] = composed.claims.map((claim) => {
      const fact = facts.get(claim.factId)
      if (!fact || !fact.outboundSafe) throw new Error("回复引用了不存在或不可出站的证据事实")
      return {
        factId: fact.id,
        statement: claim.statement,
        provenance: fact.provenance,
        evidenceSource: fact.evidenceSource,
        evidence: fact.evidence,
      }
    })
    return {
      ...baseline,
      answer: composed.answer,
      quote: composed.quote,
      answerClaims: claims,
      usedMemoryVersionIds: [...new Set([
        ...baseline.usedMemoryVersionIds,
        ...composed.usedMemoryVersionIds,
      ])],
      evidencePacket: packet,
    }
  }

  private safeComposedReply(
    reply: ComposedReply,
    packet: EvidencePacket,
    allowedMemoryIds: Set<string>,
    latestMessage: string,
  ): ComposedReply {
    const validatedReply = composedReplySchema.parse(reply)
    const outbound = this.deps.redactor.assertSafeOutbound(validatedReply.answer)
    if (!outbound.allowed || !outbound.safeText.trim() || garbled(outbound.safeText)) {
      throw new SupportModelOutputRejectedError(["组合回复为空、乱码或触发敏感信息出站拦截"])
    }
    if (validatedReply.quote && !latestMessage.includes(validatedReply.quote)) throw new Error("组合回复引用片段不属于本轮最新消息")
    const safeQuote = validatedReply.quote
      ? this.deps.redactor.assertSafeOutbound(validatedReply.quote).safeText.slice(0, 1000)
      : null
    if (validatedReply.quote && safeQuote !== validatedReply.quote) throw new Error("组合回复引用片段触发脱敏后无法逐字引用")
    const knownFacts = new Map(packet.facts.map((fact) => [fact.id, fact]))
    const claims = validatedReply.claims.map((claim) => {
      const fact = knownFacts.get(claim.factId)
      if (!fact?.outboundSafe) throw new Error("组合回复引用了不可用事实")
      const statement = this.deps.redactor.assertSafeOutbound(claim.statement).safeText.slice(0, 1000)
      if (!outbound.safeText.includes(statement)) throw new Error("组合回复事实声明未出现在最终正文")
      return { factId: claim.factId, statement }
    })
    return {
      answer: outbound.safeText.slice(0, 12000),
      quote: safeQuote,
      claims,
      usedMemoryVersionIds: validatedReply.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id)),
    }
  }

  private filterEvidencePacketByTrace(
    packet: EvidencePacket,
    trace: InvestigationTrace,
  ): { packet: EvidencePacket; issues: EvidenceBindingIssue[] } {
    const cloned = structuredClone(packet)
    const issues: EvidenceBindingIssue[] = []
    const confirmedSteps = trace.steps.filter((step) => step.status === "confirmed")
    for (const fact of cloned.facts) {
      const inferred = fact.provenance === "inference"
        && fact.evidenceSource === "inference"
        && fact.certainty === "inferred"
      if (inferred) continue
      const matchingStep = confirmedSteps.find((step) => this.trustedStepSupportsFact(step, fact))
      if (matchingStep) continue
      fact.outboundSafe = false
      issues.push({
        code: "observation_unbound",
        message: `observation_unbound：证据事实 ${fact.id} 的逐字依据和稳定标识未绑定到同一项父进程可信 observation`,
        factId: fact.id,
        ...(fact.associationId ? { associationId: fact.associationId } : {}),
      })
    }
    return {
      packet: cloned,
      issues,
    }
  }

  private bindResponsibilityToTrace(
    responsibility: ResponsibilityAssessment,
    trace: InvestigationTrace,
    packet: EvidencePacket,
  ): { responsibility: ResponsibilityAssessment; issues: EvidenceBindingIssue[] } {
    const knownParty = responsibility.party !== "unknown" && responsibility.party !== "not_applicable"
    if (!knownParty || !["confirmed", "inference"].includes(responsibility.certainty)) {
      return { responsibility, issues: [] }
    }
    const factsById = new Map(packet.facts.map((fact) => [fact.id, fact]))
    const citedFacts = responsibility.factIds.map((factId) => factsById.get(factId))
    const requireConfirmed = responsibility.certainty === "confirmed"
    const allCitationsBound = citedFacts.every((fact): fact is EvidenceFact => Boolean(fact))
      && citedFacts.every((fact) => this.responsibilityFactClosureIsBound(
        fact!,
        factsById,
        trace,
        new Set<string>(),
      ))
      && (!requireConfirmed || citedFacts.every((fact) => fact?.certainty === "confirmed"))
    const verifiedFacts = allCitationsBound ? citedFacts as EvidenceFact[] : []
    if (responsibility.certainty === "inference" && verifiedFacts.length === responsibility.factIds.length) {
      return { responsibility, issues: [] }
    }
    const hasVerifiedCodeFact = verifiedFacts.some((fact) => (
      fact.provenance === "code" && fact.evidenceSource === "code"
    ))
    const hasVerifiedRuntimeFact = runtimeResponsibilitySources.some((source) => verifiedFacts.some((fact) => (
      fact.evidenceSource === source
      && ["request", "response", "callback", "runtime"].includes(fact.provenance)
    )))
    if (allCitationsBound && hasVerifiedCodeFact && hasVerifiedRuntimeFact) {
      return { responsibility, issues: [] }
    }
    return {
      responsibility: {
        party: "unknown",
        certainty: "unknown",
        evidenceSources: [],
        factIds: [],
      },
      issues: [{
        code: "responsibility_source_unbound",
        message: responsibility.certainty === "confirmed"
          ? "responsibility_source_unbound：已确认责任缺少 factIds 引用且逐字绑定的代码事实与服务器、日志、数据库或 Redis 事实共同支撑"
          : "responsibility_source_unbound：推断责任的 factIds 没有引用可出站、非 memory 且逐字绑定的本轮事实",
      }],
    }
  }

  private responsibilityFactClosureIsBound(
    fact: EvidenceFact,
    factsById: Map<string, EvidenceFact>,
    trace: InvestigationTrace,
    visited: Set<string>,
  ): boolean {
    if (visited.has(fact.id)) return true
    visited.add(fact.id)
    if (!fact.outboundSafe || !evidenceProvenanceCanSupportCurrentResponsibility(fact.provenance)) return false
    if (!trace.steps.some((step) => this.trustedStepSupportsFact(step, fact))) return false
    return fact.dependsOnFactIds.every((dependencyId) => {
      const dependency = factsById.get(dependencyId)
      return dependency
        ? this.responsibilityFactClosureIsBound(dependency, factsById, trace, visited)
        : false
    })
  }

  private redactReview(review: ReplyReview): ReplyReview {
    const validatedReview = replyReviewSchema.parse(review)
    const redact = (value: string, maximum: number) => this.deps.redactor.redact(value).text.slice(0, maximum)
    return {
      ...validatedReview,
      issues: validatedReview.issues.map((issue) => redact(issue, 500)),
      reason: redact(validatedReview.reason, 1000),
    }
  }

  private async syncStableCode(
    serviceId: string,
    signal: AbortSignal,
  ): Promise<{ snapshot: ProjectCodeSnapshot; service: ProjectServiceRecord }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new Error("Codex 执行已取消")
      let snapshot: ProjectCodeSnapshot
      try {
        snapshot = this.deps.codeSync.readCurrentSnapshot(serviceId)
      } catch (error) {
        throw new SupportCodeSyncRuntimeError(error)
      }
      if (signal.aborted) throw new Error("Codex 执行已取消")
      const service = this.deps.codeSync.currentServiceForSnapshot(snapshot)
      if (service) return { snapshot, service }
    }
    throw new SupportCodeConfigurationChangedError()
  }

  private async publishProgress(
    input: SupportInvestigationInput,
    snapshot: ProjectCodeSnapshot,
    investigation: InvestigationTrace,
  ): Promise<void> {
    await input.onProgress?.({ snapshot, investigation: this.redactTrace(investigation) })
  }

  private trustedInvestigation(options: {
    input: SupportInvestigationInput
    snapshot: ProjectCodeSnapshot
    documents: Array<{ source: string; title: string; content: string }>
    wantsInterfaceDocumentation: boolean
    resources: SupportResourceSummary
    databaseSteps: InvestigationStep[]
    observations: CodexCommandObservation[]
    memories?: MemoryView[]
    modelDecision: AnswerDecision | null
    workspacePath?: string
  }): InvestigationTrace {
    const { input, snapshot, documents, wantsInterfaceDocumentation, resources, modelDecision } = options
    const steps: InvestigationStep[] = [{
      source: "message",
      title: "读取本轮问题",
      status: "confirmed",
      evidence: input.question.slice(0, 3000),
      conclusion: "已确认收到本轮原文 原文中的转述和历史客服结论只用于定位 不自动等于运行证据",
    }]
    if (input.attachments.length > 0) {
      const imageCount = input.attachments.filter((attachment) => attachment.kind === "image" && attachment.localPath).length
      steps.push({
        source: "message",
        title: attachmentObservationStepTitle,
        status: "confirmed",
        evidence: `visualInputAttached=${imageCount > 0 ? "true" : "false"}\n${input.attachments.map((attachment) => (
          `name=${attachment.name} kind=${attachment.kind} mime=${attachment.mimeType} size=${attachment.size}`
        )).join("\n")}`.slice(0, 3000),
        conclusion: imageCount > 0
          ? `${imageCount} 张原图已作为本轮视觉输入 图片内容只按截图所示使用`
          : "附件提取内容已随本轮问题提供给回答模型",
      })
    }
    steps.push({
      source: "code",
      title: "读取当前双仓快照",
      status: "confirmed",
      evidence: `branch=${snapshot.branch} commit=${snapshot.commit} snapshot=${snapshot.snapshotId} batch=${snapshot.syncBatchId} publishedAt=${snapshot.publishedAt}`,
      conclusion: "已取得定时任务最近发布的完整代码快照",
    })
    if (wantsInterfaceDocumentation) {
      const matched = documents.slice(0, 3)
      const documentMetadata = matched
        .map((document) => `title=${document.title.slice(0, 160)}`)
        .join("\n")
      const documentResult = matched
        .map((document) => document.content.slice(0, 1000))
        .join("\n\n")
        .slice(0, 3300)
      steps.push({
        source: "document",
        title: documentObservationStepTitle,
        status: matched.length > 0 ? "confirmed" : "not_found",
        evidence: matched.length > 0
          ? `${documentMetadata}\n${trustedResultEvidenceMarker}${documentResult}`
          : "当前地区接口文档没有命中本轮问题",
        conclusion: matched.length > 0 ? "已取得本轮明确询问的接口定义" : "不能猜测接口定义",
      })
    }
    steps.push(...resources.checks.map((check): InvestigationStep => ({
      source: "server",
      title: check.check === "system_resources" ? "采样绑定服务器实时资源" : "执行绑定服务器只读预检",
      status: check.status === "completed" ? "confirmed" : "failed",
      evidence: check.status === "completed"
        ? `check=${check.check}\nstderr=${check.stderr.slice(0, 700)}\n${trustedResultEvidenceMarker}${check.stdout.slice(0, 2500)}`
        : `check=${check.check}\nerror=${check.stderr.slice(0, 160) || "SERVER_CHECK_FAILED"}`,
      conclusion: check.check === "system_resources"
        ? check.status === "completed" ? "父应用进程已完成 CPU 内存 负载 磁盘和网络区间采样" : "父应用进程实时资源采样失败"
        : check.status === "completed" ? "服务器只读预检执行成功" : "服务器只读预检执行失败",
    })))
    steps.push(...options.databaseSteps)
    for (const observation of options.observations) {
      const validated = options.workspacePath ? validateTrustedCommandObservation(observation, {
        workspacePath: options.workspacePath,
        codeRoots: snapshot.repositories.map((repository) => repository.snapshotPath),
      }) : null
      if (validated?.kind !== "evidence") continue
      const source = validated.source
      const status: InvestigationStep["status"] = observation.exitCode === 0
        ? observation.output.trim() ? "confirmed" : "not_found"
        : "failed"
      const output = observation.output.trim()
      steps.push({
        source,
        title: this.commandObservationTitle(source),
        status,
        evidence: `实际命令=${validated.command.slice(0, 700)}\n退出码=${observation.exitCode ?? "未知"}\n${trustedResultEvidenceMarker}${output.slice(0, 3000) || "无输出"}`,
        conclusion: status === "confirmed"
          ? "回答会话已在当前绑定服务器取得实际只读结果"
          : status === "not_found"
            ? "回答会话已执行只读检查但当前没有匹配结果"
            : "回答会话执行只读检查失败 不能把该命令当作成功证据",
      })
    }
    const memorySteps: InvestigationStep[] = []
    const declaredMemoryIds = new Set(modelDecision?.usedMemoryVersionIds ?? [])
    for (const memory of options.memories ?? []) {
      if (!declaredMemoryIds.has(memory.id)) continue
      const claimedFactIds = new Set(modelDecision?.answerClaims.map((claim) => claim.factId) ?? [])
      const verifiedExcerpts: string[] = []
      const candidateExcerpts = (modelDecision?.evidencePacket.facts ?? [])
        .filter((fact) => (fact.provenance === "memory" || fact.provenance === "recommendation")
          && fact.evidenceSource === "memory"
          && fact.evidence.trim()
          && memory.content.includes(fact.evidence))
        .sort((left, right) => Number(claimedFactIds.has(right.id)) - Number(claimedFactIds.has(left.id)))
        .map((fact) => fact.evidence)
      const metadata = `memoryVersionId=${memory.id}\ntitle=${memory.title.slice(0, 300)}`
      for (const excerpt of candidateExcerpts) {
        if (verifiedExcerpts.includes(excerpt)) continue
        const candidate = JSON.stringify([...verifiedExcerpts, excerpt])
        if (metadata.length + verifiedMemoryExcerptsMarker.length + candidate.length > 3850) continue
        verifiedExcerpts.push(excerpt)
      }
      const excerpts = `${verifiedMemoryExcerptsMarker}${JSON.stringify(verifiedExcerpts)}`
      const contentBudget = Math.max(0, 3950 - metadata.length - excerpts.length)
      memorySteps.push({
        source: "memory",
        title: memoryObservationStepTitle,
        status: "confirmed",
        evidence: `${metadata}\ncontent=${memory.content.slice(0, contentBudget)}\n${excerpts}`,
        conclusion: "该记忆版本由宿主在本轮实际检索结果中确认 只可作为一般或配置知识使用",
      })
    }
    const trustedSteps = modelDecision
      ? this.selectTrustedEvidenceSteps(steps, memorySteps, 23, modelDecision)
      : steps.slice(0, 24)
    const trustedCount = trustedSteps.length
    if (modelDecision) {
      trustedSteps.push({
        source: "inference",
        title: "模型判断（推断）",
        status: "skipped",
        evidence: `仅允许概括前述 ${trustedCount} 个可信步骤 模型自报的其他排查步骤未采信${modelDecision.responsibility
          ? ` responsibility.party=${modelDecision.responsibility.party} responsibility.certainty=${modelDecision.responsibility.certainty} responsibility.evidenceSources=${modelDecision.responsibility.evidenceSources.join(",")} responsibility.factIds=${modelDecision.responsibility.factIds.join(",")}`
          : " responsibility=legacy_missing"}`,
        conclusion: `模型依据上述可信步骤给出 ${modelDecision.decision} 决策 置信度=${modelDecision.confidence}`,
      })
    }
    return {
      summary: modelDecision
        ? `已记录 ${trustedCount} 个可信步骤 模型结论作为推断单独标识`
        : `已记录 ${trustedCount} 个可信步骤 排查仍在进行`,
      steps: trustedSteps,
    }
  }

  private selectTrustedEvidenceSteps(
    operationalSteps: InvestigationStep[],
    memorySteps: InvestigationStep[],
    limit: number,
    modelDecision: AnswerDecision,
  ): InvestigationStep[] {
    const reservedMemories = memorySteps.slice(0, Math.min(3, limit))
    const operationalLimit = Math.max(0, limit - reservedMemories.length)
    const facts = new Map(modelDecision.evidencePacket.facts.map((fact) => [fact.id, fact]))
    const claimedFacts = modelDecision.answerClaims
      .map((claim) => facts.get(claim.factId))
      .filter((fact): fact is EvidenceFact => Boolean(fact))
    const outboundFacts = modelDecision.evidencePacket.facts.filter((fact) => fact.outboundSafe)
    const priority = (step: InvestigationStep): number => {
      if (claimedFacts.some((fact) => this.trustedStepSupportsFact(step, fact))) return 0
      if (outboundFacts.some((fact) => this.trustedStepSupportsFact(step, fact))) return 1
      if (step.source === "message" && step.title === "读取本轮问题") return 2
      if (step.status === "confirmed" && (
        ["server", "log", "database", "redis"].includes(step.source)
        || (step.source === "code" && step.title === codeObservationStepTitle)
      )) return 3
      if (step.status === "confirmed" && step.source === "document") return 4
      if (step.source === "message") return 5
      if (step.source === "code" && step.title === "读取当前双仓快照") return 7
      return 6
    }
    const selectedIndexes = new Set(operationalSteps
      .map((step, index) => ({ index, priority: priority(step) }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .slice(0, operationalLimit)
      .map(({ index }) => index))
    return [
      ...operationalSteps.filter((_, index) => selectedIndexes.has(index)),
      ...reservedMemories,
    ]
  }

  private trailingTrustedResult(step: InvestigationStep): string | null {
    const marker = `\n${trustedResultEvidenceMarker}`
    const markerIndex = step.evidence.lastIndexOf(marker)
    if (markerIndex < 0) return null
    return step.evidence.slice(markerIndex + marker.length)
  }

  private trustedStepResultText(step: InvestigationStep): string | null {
    if (step.status !== "confirmed") return null
    if (step.source === "message") {
      return step.title === "读取本轮问题" ? step.evidence : null
    }
    if (step.source === "document") {
      return step.title === documentObservationStepTitle ? this.trailingTrustedResult(step) : null
    }
    if (step.source === "code") {
      return step.title === codeObservationStepTitle ? this.trailingTrustedResult(step) : null
    }
    if (step.source === "database") {
      return step.title === databaseObservationStepTitle ? this.trailingTrustedResult(step) : null
    }
    if (step.source === "log") {
      return step.title === "执行限量日志检查" ? this.trailingTrustedResult(step) : null
    }
    if (step.source === "redis") {
      return step.title === "执行 Redis 只读检查" ? this.trailingTrustedResult(step) : null
    }
    if (step.source === "server" && [
      "执行服务器只读检查",
      "采样绑定服务器实时资源",
      "执行绑定服务器只读预检",
    ].includes(step.title)) {
      return this.trailingTrustedResult(step)
    }
    return null
  }

  private verifiedMemoryExcerpts(step: InvestigationStep): string[] {
    if (step.status !== "confirmed"
      || step.source !== "memory"
      || step.title !== memoryObservationStepTitle) return []
    const marker = `\n${verifiedMemoryExcerptsMarker}`
    const markerIndex = step.evidence.lastIndexOf(marker)
    if (markerIndex < 0) return []
    try {
      const parsed: unknown = JSON.parse(step.evidence.slice(markerIndex + marker.length))
      return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
        ? parsed
        : []
    } catch {
      return []
    }
  }

  private trustedStepSupportsFact(step: InvestigationStep, fact: EvidenceFact): boolean {
    if (fact.provenance === "display") {
      return fact.evidenceSource === "message"
        && fact.certainty === "reported"
        && Boolean(fact.evidence.trim())
        && fact.subjectKind === "general"
        && fact.businessType === "not_applicable"
        && fact.identifiers.length === 0
        && fact.associationId === null
        && fact.dependsOnFactIds.length === 0
        && step.status === "confirmed"
        && step.source === "message"
        && step.title === attachmentObservationStepTitle
        && step.evidence.startsWith(`${visualInputEvidenceMarker}\n`)
    }
    const evidence = fact.evidence.trim()
    if (!evidence || step.status !== "confirmed" || step.source !== fact.evidenceSource) return false
    if (step.source === "memory") {
      return (fact.provenance === "memory" || fact.provenance === "recommendation")
        && this.verifiedMemoryExcerpts(step).some((excerpt) => (
          excerpt === evidence && fact.identifiers.every((identifier) => excerpt.includes(identifier.value))
        ))
    }
    const resultText = this.trustedStepResultText(step)
    if (!resultText?.includes(evidence)) return false
    return fact.identifiers.every((identifier) => resultText.includes(identifier.value))
  }

  private async verifyDatabaseQuery(
    serviceId: string,
    request: TrustedDatabaseQueryRequest,
    signal: AbortSignal,
  ): Promise<InvestigationStep> {
    if (signal.aborted) throw new Error("Codex 执行已取消")
    const title = databaseObservationStepTitle
    if (!this.deps.resourceBroker?.verifyDatabaseQuery) {
      return {
        source: "database",
        title,
        status: "skipped",
        evidence: `只读SQL=${request.sql.slice(0, 2000)} 未配置父进程数据库复核器`,
        conclusion: "模型助手输出和审计文件均未采信 数据库结果未独立验证",
      }
    }
    try {
      const result = await this.deps.resourceBroker.verifyDatabaseQuery(serviceId, request, signal)
      if (signal.aborted) throw new Error("Codex 执行已取消")
      const rows = result.rows.slice(0, 3)
      const rowCount = result.rows.length
      const sample = JSON.stringify(rows).slice(0, 3000)
      if (signal.aborted) throw new Error("Codex 执行已取消")
      const status: InvestigationStep["status"] = rowCount === 0 ? "not_found" : "confirmed"
      return {
        source: "database",
        title,
        status,
        evidence: `父进程经绑定服务器重新执行 只读SQL=${request.sql.slice(0, 700)} 返回行数=${rowCount} 截断=${result.truncated ? "是" : "否"}\n${trustedResultEvidenceMarker}${sample}`,
        conclusion: status === "confirmed" ? "父进程已独立取得当前查询的数据库记录" : "父进程复核后当前查询条件没有记录",
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message === "Codex 执行已取消")) throw error
      return {
        source: "database",
        title,
        status: "failed",
        evidence: `只读SQL=${request.sql.slice(0, 2000)} 父进程经绑定服务器重新执行失败`,
        conclusion: "数据库结果未独立验证 模型输出和审计文件未作为替代证据",
      }
    }
  }

  private commandObservationTitle(source: InvestigationStep["source"]): string {
    if (source === "redis") return "执行 Redis 只读检查"
    if (source === "log") return "执行限量日志检查"
    if (source === "server") return "执行服务器只读检查"
    return codeObservationStepTitle
  }

  private redactTrace(trace: InvestigationTrace): InvestigationTrace {
    const redact = (value: string, maximum: number) => this.deps.redactor.redact(value).text.slice(0, maximum)
    return {
      summary: redact(trace.summary, 2000),
      steps: trace.steps.slice(0, 24).map((step): InvestigationStep => ({
        source: step.source,
        title: redact(step.title, 160),
        status: step.status,
        evidence: redact(step.evidence, 4000),
        conclusion: redact(step.conclusion, 1000),
      })),
    }
  }

  private redactDecision(
    decision: AnswerDecision,
    allowedMemoryIds: Set<string>,
  ): AnswerDecision {
    const redact = (value: string, maximum: number) => this.deps.redactor.redact(value).text.slice(0, maximum)
    const redactOutbound = (value: string, maximum: number) => (
      this.deps.redactor.assertSafeOutbound(value).safeText.slice(0, maximum)
    )
    const investigation = this.redactTrace(decision.investigation)
    const safeQuote = decision.quote ? redactOutbound(decision.quote, 1000) : null
    const safeAnswer = redactOutbound(decision.answer, 12000)
    const interactionReason = decision.interaction
      ? `\n对话判断 sentiment=${decision.interaction.sentiment} situation=${decision.interaction.situation} strategy=${decision.interaction.responseStrategy} need=${redact(decision.interaction.underlyingNeed, 300)}`
      : ""
    return {
      ...decision,
      answer: safeAnswer,
      reason: `${redact(decision.reason, Math.max(1, 1000 - interactionReason.length))}${interactionReason}`.slice(0, 1000),
      quote: safeQuote,
      usedMemoryVersionIds: decision.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id)),
      ...(decision.answerClaims ? {
        answerClaims: decision.answerClaims.map((claim) => ({
          ...claim,
          statement: redactOutbound(claim.statement, 1000),
          evidence: redact(claim.evidence, 1000),
        })),
      } : {}),
      ...(decision.interaction ? {
        interaction: {
          ...decision.interaction,
          underlyingNeed: redact(decision.interaction.underlyingNeed, 300),
        },
      } : {}),
      ...(decision.evidencePacket ? {
        evidencePacket: this.redactEvidencePacket(decision.evidencePacket),
      } : {}),
      investigation,
    }
  }

  private redactEvidencePacket(packet: EvidencePacket): EvidencePacket {
    const redact = (value: string, maximum: number) => this.deps.redactor.redact(value).text.slice(0, maximum)
    return {
      ...packet,
      communication: {
        ...packet.communication,
        recipient: packet.communication.recipient ? redact(packet.communication.recipient, 120) : null,
        desiredOutcome: redact(packet.communication.desiredOutcome, 500),
      },
      facts: packet.facts.map((fact) => ({
        ...fact,
        statement: redact(fact.statement, 1000),
        evidence: redact(fact.evidence, 1000),
        identifiers: fact.identifiers.map((identifier) => ({
          ...identifier,
          value: redact(identifier.value, 300),
        })),
      })),
      associations: packet.associations.map((association) => ({
        ...association,
        matchedIdentifiers: association.matchedIdentifiers.map((identifier) => ({
          ...identifier,
          value: redact(identifier.value, 300),
        })),
        lookupHints: association.lookupHints.map((hint) => ({
          ...hint,
          value: redact(hint.value, 300),
        })),
        conflicts: association.conflicts.map((conflict) => ({
          ...conflict,
          summary: redact(conflict.summary, 500),
        })),
      })),
      requiredAnswerPoints: packet.requiredAnswerPoints.map((item) => redact(item, 500)),
      unknowns: packet.unknowns.map((item) => redact(item, 500)),
      handlingNotes: packet.handlingNotes.map((item) => redact(item, 500)),
    }
  }

  private resources(serviceId: string): SupportResourceSummary {
    return {
      servers: this.deps.database.readServerResources("WHERE service_id=? AND enabled=1", [serviceId])
        .map((item) => ({ id: item.id, alias: item.alias })),
      databases: this.deps.database.readDatabaseResources("WHERE service_id=? AND enabled=1", [serviceId])
        .map((item) => ({ id: item.id, alias: item.alias, database: item.database })),
      checks: [],
    }
  }

}
