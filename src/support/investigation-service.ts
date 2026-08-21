import type {
  AnswerClaim,
  AnswerDecision,
  ComposedReply,
  EvidencePacket,
  InvestigationStep,
  InvestigationTrace,
  ReplyReview,
} from "../codex/schemas.js"
import type { CodexCommandObservation } from "../codex/executor.js"
import {
  type ProjectCodeSnapshot,
  type ProjectCodeSyncService,
} from "../git-sync/project-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeKnowledgeService } from "../runtime/knowledge-service.js"
import type { ModelInstanceSnapshot } from "../runtime/model-config-service.js"
import type { ProjectServiceRecord, ReplyStyle, TelegramRole } from "../runtime/types.js"
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
  version: "evidence-compose-review-v1"
  mode: "legacy" | "multi_stage"
  evidencePacket: EvidencePacket | null
  baselineAnswer: string
  firstCandidateAnswer: string | null
  revisedCandidateAnswer: string | null
  reviews: ReplyReview[]
  finalSource: "baseline" | "first_candidate" | "revised_candidate"
  fallbackReason: string | null
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

  constructor(rejectionReasons: string[] = []) {
    const reasons = [...new Set(rejectionReasons.map((reason) => reason.trim()).filter(Boolean))]
    super(reasons.length > 0
      ? `回答模型结果触发非业务出站安全阻断：${reasons.join("；")}`
      : "回答模型未形成可安全发送的结果")
    this.name = "SupportModelOutputRejectedError"
    this.rejectionReasons = reasons
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
      decision = this.redactDecision({
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
          modelDecision: generated,
          workspacePath: resourceWorkspace.path,
        }),
      }, allowedMemoryIds)
      const pipeline = await this.runReplyPipeline(decisionInput, decision, allowedMemoryIds, signal)
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
        throw new SupportModelOutputRejectedError(rejectionReasons)
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
    const legacyAudit = (fallbackReason: string | null): SupportReplyPipelineAudit => ({
      version: "evidence-compose-review-v1",
      mode: "legacy",
      evidencePacket: baseline.evidencePacket ?? null,
      baselineAnswer: baseline.answer,
      firstCandidateAnswer: null,
      revisedCandidateAnswer: null,
      reviews: [],
      finalSource: "baseline",
      fallbackReason,
    })
    if (baseline.decision === "ignore") return { decision: baseline, audit: legacyAudit("ignore 不生成对外回复") }
    if (!baseline.evidencePacket || !this.deps.agent.composeReply || !this.deps.agent.reviewReply) {
      return { decision: baseline, audit: legacyAudit("调查模型或运行适配器尚未提供多阶段交接") }
    }
    if (baseline.evidencePacket.communication.intent !== "copyable_message") {
      return { decision: baseline, audit: legacyAudit("当前诉求不需要独立沟通成稿，保留调查模型基线") }
    }
    const packet = this.trustEvidencePacket(baseline.evidencePacket, baseline.investigation)
    const baseReviewInput = {
      request,
      decision: {
        decision: baseline.decision,
        escalationType: baseline.escalationType,
        humanOperation: baseline.humanOperation,
        responsibility: baseline.responsibility,
        interaction: baseline.interaction,
      },
      evidencePacket: packet,
      baseline: {
        answer: baseline.answer,
        quote: baseline.quote,
        answerClaims: baseline.answerClaims,
        usedMemoryVersionIds: baseline.usedMemoryVersionIds,
      },
    } as const
    let first: ComposedReply | null = null
    let revised: ComposedReply | null = null
    const reviews: ReplyReview[] = []
    try {
      first = this.safeComposedReply(
        await this.deps.agent.composeReply({
          request: baseReviewInput.request,
          decision: baseReviewInput.decision,
          evidencePacket: packet,
        }, signal),
        packet,
        allowedMemoryIds,
        request.latestMessage ?? request.question,
      )
      const firstReview = this.redactReview(await this.deps.agent.reviewReply({
        ...baseReviewInput,
        candidate: first,
        attempt: 1,
      }, signal))
      reviews.push(firstReview)
      if (firstReview.outcome === "approve") {
        return this.pipelineResult(baseline, packet, first, null, reviews, "first_candidate", null)
      }
      if (firstReview.outcome === "prefer_baseline") {
        return this.pipelineResult(baseline, packet, first, null, reviews, "baseline", firstReview.reason)
      }
      revised = this.safeComposedReply(
        await this.deps.agent.composeReply({
          request: baseReviewInput.request,
          decision: baseReviewInput.decision,
          evidencePacket: packet,
          revisionFeedback: firstReview.issues,
        }, signal),
        packet,
        allowedMemoryIds,
        request.latestMessage ?? request.question,
      )
      const secondReview = this.redactReview(await this.deps.agent.reviewReply({
        ...baseReviewInput,
        candidate: revised,
        attempt: 2,
      }, signal))
      reviews.push(secondReview)
      if (secondReview.outcome === "approve") {
        return this.pipelineResult(baseline, packet, first, revised, reviews, "revised_candidate", null)
      }
      return this.pipelineResult(baseline, packet, first, revised, reviews, "baseline", secondReview.reason)
    } catch (error) {
      if (signal.aborted) throw error
      const reason = error instanceof Error
        ? `多阶段回复未完成，保留调查模型基线：${error.name}`
        : "多阶段回复未完成，保留调查模型基线"
      return this.pipelineResult(baseline, packet, first, revised, reviews, "baseline", reason)
    }
  }

  private pipelineResult(
    baseline: AnswerDecision,
    packet: EvidencePacket,
    first: ComposedReply | null,
    revised: ComposedReply | null,
    reviews: ReplyReview[],
    finalSource: SupportReplyPipelineAudit["finalSource"],
    fallbackReason: string | null,
  ): { decision: AnswerDecision; audit: SupportReplyPipelineAudit } {
    const selected = finalSource === "first_candidate" ? first : finalSource === "revised_candidate" ? revised : null
    const decision = selected ? this.applyComposedReply(baseline, selected, packet) : baseline
    return {
      decision,
      audit: {
        version: "evidence-compose-review-v1",
        mode: "multi_stage",
        evidencePacket: packet,
        baselineAnswer: baseline.answer,
        firstCandidateAnswer: first?.answer ?? null,
        revisedCandidateAnswer: revised?.answer ?? null,
        reviews,
        finalSource,
        fallbackReason,
      },
    }
  }

  private applyComposedReply(baseline: AnswerDecision, composed: ComposedReply, packet: EvidencePacket): AnswerDecision {
    const facts = new Map(packet.facts.map((fact) => [fact.id, fact]))
    const claims: AnswerClaim[] = composed.claims.map((claim) => {
      const fact = facts.get(claim.factId)
      if (!fact || !fact.outboundSafe) throw new Error("回复引用了不存在或不可出站的证据事实")
      return {
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
    const outbound = this.deps.redactor.assertSafeOutbound(reply.answer)
    if (!outbound.allowed || !outbound.safeText.trim() || garbled(outbound.safeText)) {
      throw new SupportModelOutputRejectedError(["组合回复为空、乱码或触发敏感信息出站拦截"])
    }
    if (reply.quote && !latestMessage.includes(reply.quote)) throw new Error("组合回复引用片段不属于本轮最新消息")
    const safeQuote = reply.quote ? this.deps.redactor.assertSafeOutbound(reply.quote).safeText.slice(0, 1000) : null
    if (reply.quote && safeQuote !== reply.quote) throw new Error("组合回复引用片段触发脱敏后无法逐字引用")
    const knownFacts = new Map(packet.facts.map((fact) => [fact.id, fact]))
    const claims = reply.claims.map((claim) => {
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
      usedMemoryVersionIds: reply.usedMemoryVersionIds.filter((id) => allowedMemoryIds.has(id)),
    }
  }

  private trustEvidencePacket(packet: EvidencePacket, trace: InvestigationTrace): EvidencePacket {
    const availableSources = new Set(trace.steps
      .filter((step) => step.status === "confirmed")
      .map((step) => step.source))
    availableSources.add("inference")
    const redact = (value: string, maximum: number) => this.deps.redactor.redact(value).text.slice(0, maximum)
    return {
      ...packet,
      communication: {
        ...packet.communication,
        recipient: packet.communication.recipient ? redact(packet.communication.recipient, 120) : null,
        desiredOutcome: redact(packet.communication.desiredOutcome, 500),
      },
      facts: packet.facts
        .filter((fact) => availableSources.has(fact.evidenceSource))
        .map((fact) => ({
          ...fact,
          statement: redact(fact.statement, 1000),
          evidence: redact(fact.evidence, 1000),
        })),
      requiredAnswerPoints: packet.requiredAnswerPoints.map((item) => redact(item, 500)),
      unknowns: packet.unknowns.map((item) => redact(item, 500)),
      handlingNotes: packet.handlingNotes.map((item) => redact(item, 500)),
    }
  }

  private redactReview(review: ReplyReview): ReplyReview {
    const redact = (value: string, maximum: number) => this.deps.redactor.redact(value).text.slice(0, maximum)
    return {
      ...review,
      issues: review.issues.map((issue) => redact(issue, 500)),
      reason: redact(review.reason, 1000),
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
        title: "读取本轮附件",
        status: "confirmed",
        evidence: input.attachments.map((attachment) => (
          `name=${attachment.name} kind=${attachment.kind} mime=${attachment.mimeType} size=${attachment.size}`
        )).join("\n").slice(0, 3000),
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
      steps.push({
        source: "document",
        title: "检索当前地区接口文档",
        status: matched.length > 0 ? "confirmed" : "not_found",
        evidence: matched.length > 0
          ? matched.map((document) => `${document.title}\n${document.content.slice(0, 1000)}`).join("\n\n").slice(0, 3000)
          : "当前地区接口文档没有命中本轮问题",
        conclusion: matched.length > 0 ? "已取得本轮明确询问的接口定义" : "不能猜测接口定义",
      })
    }
    steps.push(...resources.checks.map((check): InvestigationStep => ({
      source: "server",
      title: check.check === "system_resources" ? "采样绑定服务器实时资源" : "执行绑定服务器只读预检",
      status: check.status === "completed" ? "confirmed" : "failed",
      evidence: check.status === "completed"
        ? `check=${check.check}\nstdout=${check.stdout.slice(0, 2500)}\nstderr=${check.stderr.slice(0, 700)}`
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
        evidence: `实际命令=${validated.command.slice(0, 1600)}\n退出码=${observation.exitCode ?? "未知"}\n输出=${output.slice(0, 3000) || "无输出"}`,
        conclusion: status === "confirmed"
          ? "回答会话已在当前绑定服务器取得实际只读结果"
          : status === "not_found"
            ? "回答会话已执行只读检查但当前没有匹配结果"
            : "回答会话执行只读检查失败 不能把该命令当作成功证据",
      })
    }
    const trustedSteps = steps.slice(0, modelDecision ? 23 : 24)
    const trustedCount = trustedSteps.length
    if (modelDecision) {
      trustedSteps.push({
        source: "inference",
        title: "模型判断（推断）",
        status: "skipped",
        evidence: `仅允许概括前述 ${trustedCount} 个可信步骤 模型自报的其他排查步骤未采信${modelDecision.responsibility
          ? ` responsibility.party=${modelDecision.responsibility.party} responsibility.certainty=${modelDecision.responsibility.certainty} responsibility.evidenceSources=${modelDecision.responsibility.evidenceSources.join(",")}`
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

  private async verifyDatabaseQuery(
    serviceId: string,
    request: TrustedDatabaseQueryRequest,
    signal: AbortSignal,
  ): Promise<InvestigationStep> {
    if (signal.aborted) throw new Error("Codex 执行已取消")
    const title = "父进程复核数据库只读查询"
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
        evidence: `父进程经绑定服务器重新执行 只读SQL=${request.sql.slice(0, 2000)} 返回行数=${rowCount} 截断=${result.truncated ? "是" : "否"} 样本=${sample}`,
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
    return "执行代码只读检查"
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
        evidencePacket: {
          ...decision.evidencePacket,
          communication: {
            ...decision.evidencePacket.communication,
            recipient: decision.evidencePacket.communication.recipient
              ? redact(decision.evidencePacket.communication.recipient, 120)
              : null,
            desiredOutcome: redact(decision.evidencePacket.communication.desiredOutcome, 500),
          },
          facts: decision.evidencePacket.facts.map((fact) => ({
            ...fact,
            statement: redact(fact.statement, 1000),
            evidence: redact(fact.evidence, 1000),
          })),
          requiredAnswerPoints: decision.evidencePacket.requiredAnswerPoints.map((item) => redact(item, 500)),
          unknowns: decision.evidencePacket.unknowns.map((item) => redact(item, 500)),
          handlingNotes: decision.evidencePacket.handlingNotes.map((item) => redact(item, 500)),
        },
      } : {}),
      investigation,
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
