import { randomUUID } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

import { referenceProposalResultSchema, type ReferenceProposal } from "../codex/schemas.js"
import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"
import type { ModelConfigService } from "../runtime/model-config-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeKnowledgeService } from "../runtime/knowledge-service.js"
import type {
  MemoryRisk,
  ReferenceLearningRunResult,
  ReferenceLearningWorkerStatus,
} from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import { OperatorStyleService } from "./operator-style-service.js"
import {
  REFERENCE_LEARNING_BATCH_LIMIT,
  REFERENCE_TRANSIENT_URL_MARKER,
  boundReferenceLearningMaterial,
  escapeReferenceLearningMarkerLiterals,
  normalizeReferenceLearningText,
  safeReferenceThreadContextSchema,
  type ReferenceAgentPort,
  type SafeReferenceThreadContext,
} from "./reference-agent.js"

type CodeSyncPort = {
  readCurrentSnapshot(serviceId: string): ProjectCodeSnapshot
}

type QueueCandidate = {
  id: string
  message_event_id: string
  source_telegram_user_id: string
  source_role: string
  observation_thread_id: string | null
  observation_service_id: string | null
  observation_risk: string
  classification: string
  reference_text: string | null
  event_sender_user_id: string | null
  event_sender_role: string | null
  event_route_status: string | null
  event_group_id: string | null
  thread_group_id: string | null
  thread_project_id: string | null
  thread_service_id: string | null
  group_enabled: number | null
  group_purpose: string | null
  group_project_id: string | null
  group_service_id: string | null
  knowledge_scope: string | null
  project_enabled: number | null
  service_key: string | null
  service_project_id: string | null
  service_enabled: number | null
  region: string | null
  branch: string | null
  role_enabled: number | null
  role_learning_source_enabled: number | null
  configured_role: string | null
}

type AuthorizedObservation = QueueCandidate & {
  observation_thread_id: string
  observation_service_id: string
  observation_risk: MemoryRisk
  knowledge_scope: string
  service_key: string
  branch: string
}

type ClaimedObservation = AuthorizedObservation & { lock_token: string }

type ValidatedProposal = Omit<ReferenceProposal, "risk" | "codeEvidencePaths"> & {
  risk: MemoryRisk
  codeEvidencePaths: string[]
  deterministicNoop: boolean
}

type LearningClassification = ReferenceProposal["classification"] | "unclassified"
type LearningAction = ReferenceProposal["action"]
type LearningOutcome = "noop" | "candidate" | "conflict" | "active"
  | "style_candidate" | "style_active" | "ignored" | "failed"
type LearningReasonCode = "proposal_noop" | "deterministic_noop" | "non_learnable_classification"
  | "memory_candidate" | "memory_conflict" | "memory_active" | "style_candidate" | "style_active"
  | "unsafe_learning_material" | "invalid_proposal_batch" | "processing_failed" | "interrupted_run"

type TerminalLearningResult = {
  observationId: string
  classification: LearningClassification
  action: LearningAction
  risk: MemoryRisk
  outcome: LearningOutcome
  reasonCode: LearningReasonCode
  memoryVersionId: string | null
  operatorStyleVersionId: string | null
}

type ClaimedBatch = {
  runId: string
  observations: ClaimedObservation[]
}

class InvalidProposalBatchError extends Error {}

const riskRank: Record<MemoryRisk, number> = { low: 0, medium: 1, high: 2 }
const sensitiveKnowledge = /(?:密钥|密码|口令|token|签名|验签|权限|安全|商户号|私钥|凭据|生产.{0,12}(?:修改|写入|删除|重启|部署)|(?:修改|写入|删除).{0,12}生产|资金|余额|解冻|冻结|代收|代付|数据库.{0,8}(?:修改|写入|删除)|redis.{0,8}(?:修改|写入|删除))/iu
const orderInstancePattern = /(?:订单(?:号|编号)?|单号|order[_-]?(?:id|no|number)|mch(?:ant)?[_-]?order[_-]?(?:id|no)|trade[_-]?(?:id|no))\s*[:：#=]?\s*[A-Z0-9][A-Z0-9._-]{5,}/iu
const datedTimestampPattern = /(?:\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b|20\d{2}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}(?:时|:)\d{1,2}(?:分|(?::\d{1,2}))?)?)/u
const clockTimestampPattern = /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/u
const durableSchedulePattern = /(?:每日|每天|每周|每月|每年|固定(?:在)?|定时|周期|cron|schedul(?:e|ed)|every\s+(?:day|week|month|year))/iu
const epochTimestampPattern = /\b(?:\d{10}|\d{13})\b/u
const statusAssignmentPattern = /(?:(?:订单)?状态|\b(?:(?:order|trade)[ _-]?)?status\b)\s*[:：=为]?\s*(?:success|succeeded|failed|failure|pending|processing|cancelled|canceled|completed|成功|失败|处理中|待处理|已完成|已关闭|已取消|未到账|已到账|冻结|解冻)(?![\p{L}\p{N}_])/iu
const durableStatusDefinitionPattern = /(?:(?:订单)?状态|\b(?:(?:order|trade)[ _-]?)?status\b)\s*[:：=为]?\s*(?:success|succeeded|failed|failure|pending|processing|cancelled|canceled|completed|成功|失败|处理中|待处理|已完成|已关闭|已取消|未到账|已到账|冻结|解冻).{0,20}(?:表示|含义|对应|映射|定义为|是(?:成功|失败)?(?:状态|终态))/iu
const durableStatusConditionalPattern = /(?:如果|若|当).{0,40}(?:(?:订单)?状态|\b(?:(?:order|trade)[ _-]?)?status\b)\s*[:：=为]?\s*(?:success|succeeded|failed|failure|pending|processing|cancelled|canceled|completed|成功|失败|处理中|待处理|已完成|已关闭|已取消|未到账|已到账|冻结|解冻).{0,40}(?:时|则|应当|应该|需要|必须|会)/iu
const durableStatusEnumerationPattern = /(?:(?:订单)?状态|\b(?:(?:order|trade)[ _-]?)?status\b).{0,24}(?:枚举|可选值|固定值|定义).{0,30}(?:success|succeeded|failed|failure|pending|processing|cancelled|canceled|completed|成功|失败|处理中|待处理|已完成|已关闭|已取消|未到账|已到账|冻结|解冻)/iu
const absoluteUrlPattern = /https?:\/\/[^\s"'<>]+/iu
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u
const ipv6Pattern = /(?:(?:\b[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b|(?<![\w:])(?:[A-F0-9]{1,4}:){1,7}:(?:[A-F0-9]{1,4})?(?![\w:]))/iu
const redactedLocationPattern = /[◼◈]/u
const transientUrlLocationPattern = /◈/u
const transientLocationPattern = /(?:临时|一次性|本次|这次|短期|签名(?:地址|链接|URL)?|带签名|当前(?:出口|来源|临时|地址|IP|URL|链接)|[?&](?:sign|signature|token|expires?|auth)[_=])/iu
const oneShotIncidentPattern = /(?:本次|这次|这笔|该笔|刚才|刚刚|今天|昨日|昨晚|单次|偶发|临时).{0,30}(?:故障|异常|报错|错误|失败|超时|timeout|卡住|不到账|未到账|请求)/iu
const actionResultPattern = /(?:(?:已经|已)(?:经)?(?:处理|发送|发|添加|加|修改|改|修复|恢复|重启|部署|回调|通知|提交|完成|关闭|打开|配置|更新)(?:完|好|成功|了)?|(?:处理|发送|添加|修改|修复|恢复|重启|部署|回调|通知|提交|配置|更新)(?:完成|完毕|成功|好了|好|完)(?:了)?)/u
const durableConfiguredActionPattern = /(?:系统|服务|代码|规则).{0,8}已(?:配置|设置|更新).{0,12}(?:固定|长期|默认|规则)/u
const durableStateActionPattern = /(?:已处理|已完成|处理完成).{0,8}(?:时|后|则|表示|含义|对应|应|需要|必须|会)/u
const oneShotShortReplyPattern = /^(?:稍等|等下|好的|好|收到|ok|okay|可以了|搞定了)[\s。.!！]*$/iu
const redactionMarker = /[◼◈]/gu
const redactedOnlyLinePattern = /^[^\S\r\n]*["']?[\p{L}\p{N}_. -]{1,120}["']?[^\S\r\n]*[:=：][^\S\r\n]*[◼◈][^\S\r\n]*$/gimu
const redactedFieldFragmentPattern = /["']?[\p{L}\p{N}_.-]{1,80}["']?\s*[:=：]\s*[◼◈]/giu
const absoluteUrlCandidatePattern = /https?:\/\/[^\s"'<>]+/giu
const signedUrlCredentialPattern = /[?&#](?:sign|signature|token|expires?|auth)(?:=|_)/iu
const transientUrlRedactionMarker = REFERENCE_TRANSIENT_URL_MARKER
const literalLearningMarkerPattern = /〔原文(?:脱敏标记|临时URL标记|黑方块符号|菱形符号)〕/gu
const sensitiveLearningLabelPattern = /(?:password|passwd|pwd|secret|token|api[_-]?(?:key|hash)|auth[_-]?key|string[_-]?session|session|md5?key|mdkey|sign(?:ature)?|merchant(?:id|code|no)?|mch(?:id|no)?|private[_-]?key|密码|口令|令牌|密钥|私钥|签名|商户号|数据库配置值|配置值)/giu
const nonSemanticCharacters = /[\s\p{P}\p{S}]/gu
const minimumSafeSignalRatio = 0.25

type RedactedLearningText = {
  safeText: string
  changed: boolean
  sourceSignalLength: number
  safeSignalLength: number
}

function maximumRisk(left: MemoryRisk, right: MemoryRisk): MemoryRisk {
  return riskRank[left] >= riskRank[right] ? left : right
}

function zeroResult(): ReferenceLearningRunResult {
  return { processed: 0, createdVersions: 0, conflicts: 0, styleVersions: 0 }
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isMemoryRisk(value: string): value is MemoryRisk {
  return value === "low" || value === "medium" || value === "high"
}

function isDeterministicallyNonLearnable(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  if (orderInstancePattern.test(text)
    || datedTimestampPattern.test(text)
    || (clockTimestampPattern.test(text) && !durableSchedulePattern.test(text))
    || epochTimestampPattern.test(text)
    || oneShotIncidentPattern.test(text)
    || oneShotShortReplyPattern.test(text)) return true
  const durableStatusExplanation = durableStatusDefinitionPattern.test(text)
    || durableStatusConditionalPattern.test(text)
    || durableStatusEnumerationPattern.test(text)
  if (statusAssignmentPattern.test(text) && !durableStatusExplanation) return true
  if (transientUrlLocationPattern.test(text)) return true
  const hasLocation = absoluteUrlPattern.test(text)
    || ipv4Pattern.test(text)
    || ipv6Pattern.test(text)
    || redactedLocationPattern.test(text)
  if (hasLocation && transientLocationPattern.test(text)) return true
  return actionResultPattern.test(text)
    && !durableConfiguredActionPattern.test(text)
    && !durableStateActionPattern.test(text)
}

function authorized(candidate: QueueCandidate): candidate is AuthorizedObservation {
  return candidate.classification === "reference_reply"
    && Boolean(candidate.observation_thread_id)
    && Boolean(candidate.observation_service_id)
    && candidate.observation_service_id === candidate.thread_service_id
    && candidate.observation_service_id === candidate.group_service_id
    && candidate.event_group_id === candidate.thread_group_id
    && Number(candidate.group_enabled) === 1
    && candidate.group_purpose === "support"
    && candidate.group_project_id === candidate.thread_project_id
    && candidate.group_project_id === candidate.service_project_id
    && Number(candidate.project_enabled) === 1
    && Number(candidate.service_enabled) === 1
    && candidate.source_telegram_user_id === candidate.event_sender_user_id
    && candidate.source_role === candidate.event_sender_role
    && candidate.source_role === candidate.configured_role
    && candidate.event_route_status === "role_skipped"
    && Number(candidate.role_enabled) === 1
    && Number(candidate.role_learning_source_enabled) === 1
    && Boolean(candidate.reference_text?.trim())
    && Boolean(candidate.knowledge_scope)
    && Boolean(candidate.service_key)
    && Boolean(candidate.branch)
    && isMemoryRisk(candidate.observation_risk)
}

export class ReferenceLearningWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private activeRun: Promise<ReferenceLearningRunResult> | null = null
  private lastStartedAt = 0
  private acceptingRuns = true

  constructor(
    private readonly database: RuntimeDatabase,
    private readonly config: ModelConfigService,
    private readonly knowledge: RuntimeKnowledgeService,
    private readonly agent: ReferenceAgentPort,
    private readonly codeSync: CodeSyncPort,
    private readonly styles: OperatorStyleService,
    private readonly redactor: ConfiguredSecretRedactor,
  ) {}

  start(): void {
    if (this.timer) return
    this.acceptingRuns = true
    this.timer = setInterval(() => this.tick(), 5_000)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.acceptingRuns = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.activeRun?.catch(() => undefined)
  }

  status(): ReferenceLearningWorkerStatus {
    const row = this.database.prepare(`SELECT
      SUM(CASE WHEN processing_status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN processing_status='running' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN processing_status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN processing_status='completed' THEN 1 ELSE 0 END) AS completed
      FROM learning_source_observations`).get() as {
      pending: number | null
      processing: number | null
      failed: number | null
      completed: number | null
    }
    return {
      running: this.timer !== null,
      busy: this.activeRun !== null,
      pending: Number(row.pending ?? 0),
      processing: Number(row.processing ?? 0),
      failed: Number(row.failed ?? 0),
      completed: Number(row.completed ?? 0),
    }
  }

  recoverInterrupted(now = new Date()): number {
    const modelTimeoutSeconds = this.config.getProfile("memory").timeoutSeconds
    const leaseSeconds = Math.max(10 * 60, modelTimeoutSeconds + 5 * 60)
    const stale = new Date(now.getTime() - leaseSeconds * 1000).toISOString()
    const timestamp = now.toISOString()
    return this.database.transaction(() => {
      const orphanRuns = this.database.prepare(`SELECT run.id,run.scanned_events,
          (SELECT COUNT(*) FROM reference_learning_results result WHERE result.run_id=run.id) AS terminal_count
        FROM memory_maintenance_runs run WHERE run.status='running' AND NOT EXISTS (
          SELECT 1 FROM learning_source_observations observation
          WHERE observation.processing_status='running' AND observation.current_run_id=run.id
        ) ORDER BY run.id`).all() as Array<{ id: string; scanned_events: number; terminal_count: number }>
      for (const run of orphanRuns) {
        if (Number(run.scanned_events) <= 0 || Number(run.terminal_count) !== Number(run.scanned_events)) {
          throw new Error("人工参考孤儿 run 的终态审计数量不完整")
        }
        const updated = this.database.prepare(`UPDATE memory_maintenance_runs SET status='failed',
          summary='人工参考学习中断，终态已保留',finished_at=? WHERE id=? AND status='running'`).run(timestamp, run.id)
        if (Number(updated.changes) !== 1) throw new Error("人工参考孤儿 run 恢复竞争失败")
      }

      const staleRunIds = (this.database.prepare(`SELECT DISTINCT current_run_id FROM learning_source_observations
        WHERE processing_status='running' AND locked_at<? AND current_run_id IS NOT NULL
        ORDER BY current_run_id`).all(stale) as Array<{ current_run_id: string }>).map((row) => row.current_run_id)
      const legacy = this.database.prepare(`SELECT id,risk,current_run_id FROM learning_source_observations
        WHERE processing_status='running' AND locked_at<? AND current_run_id IS NULL ORDER BY id`).all(stale) as Array<{
        id: string
        risk: MemoryRisk
        current_run_id: string | null
      }>
      const linked = staleRunIds.length === 0 ? [] : this.database.prepare(`SELECT id,risk,current_run_id
        FROM learning_source_observations WHERE processing_status='running'
        AND current_run_id IN (${staleRunIds.map(() => "?").join(",")}) ORDER BY current_run_id,id`).all(
        ...staleRunIds,
      ) as Array<{ id: string; risk: MemoryRisk; current_run_id: string }>
      const rows = [...legacy, ...linked]
      if (rows.length === 0) return 0
      if (legacy.length > 0) {
        const runId = randomUUID()
        this.database.insertMaintenanceRun({
          id: runId,
          status: "failed",
          scannedEvents: legacy.length,
          createdVersions: 0,
          conflictCount: 0,
          summary: "人工参考学习中断，等待重试",
          startedAt: timestamp,
          finishedAt: timestamp,
        })
        this.insertTerminalResults(runId, legacy.map((row) => ({
          observationId: row.id,
          classification: "unclassified",
          action: "noop",
          risk: row.risk,
          outcome: "failed",
          reasonCode: "interrupted_run",
          memoryVersionId: null,
          operatorStyleVersionId: null,
        })), timestamp)
      }
      for (const runId of staleRunIds) {
        const runRows = linked.filter((row) => row.current_run_id === runId)
        const run = this.database.prepare(`SELECT scanned_events FROM memory_maintenance_runs
          WHERE id=? AND status='running'`).get(runId) as { scanned_events: number } | undefined
        const terminalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results
          WHERE run_id=?`).get(runId) as { count: number }).count)
        if (!run || terminalCount + runRows.length !== Number(run.scanned_events)) {
          throw new Error("人工参考中断 run 的终态审计数量不完整")
        }
        this.insertTerminalResults(runId, runRows.map((row) => ({
          observationId: row.id,
          classification: "unclassified",
          action: "noop",
          risk: row.risk,
          outcome: "failed",
          reasonCode: "interrupted_run",
          memoryVersionId: null,
          operatorStyleVersionId: null,
        })), timestamp)
        const updated = this.database.prepare(`UPDATE memory_maintenance_runs SET status='failed',summary='人工参考学习中断，等待重试',
          finished_at=? WHERE id=? AND status='running'`).run(timestamp, runId)
        if (Number(updated.changes) !== 1) throw new Error("人工参考中断 run 恢复竞争失败")
      }
      const ids = rows.map((row) => row.id)
      const result = this.database.prepare(`UPDATE learning_source_observations
        SET processing_status='failed',lock_token=NULL,locked_at=NULL,current_run_id=NULL,updated_at=?
        WHERE processing_status='running' AND id IN (${ids.map(() => "?").join(",")})`).run(timestamp, ...ids)
      if (Number(result.changes) !== rows.length) throw new Error("人工参考中断恢复时 observation 已变化")
      return rows.length
    })
  }

  runOnce(now = new Date()): Promise<ReferenceLearningRunResult> {
    if (!this.acceptingRuns) return Promise.resolve(zeroResult())
    if (this.activeRun) return this.activeRun
    const running = this.executeOnce(now)
    this.activeRun = running
    void running.then(
      () => { if (this.activeRun === running) this.activeRun = null },
      () => { if (this.activeRun === running) this.activeRun = null },
    )
    return running
  }

  private async executeOnce(now: Date): Promise<ReferenceLearningRunResult> {
    let lockToken: string | null = null
    let claimedCount = 0
    let runId: string | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let heartbeatLostClaim = false
    try {
      const settings = this.config.getSettings()
      if (!settings.autoLearningEnabled) return zeroResult()
      const claimedBatch = this.claim(Math.min(settings.learningBatchSize, REFERENCE_LEARNING_BATCH_LIMIT), now)
      if (!claimedBatch) return zeroResult()
      runId = claimedBatch.runId
      lockToken = claimedBatch.observations[0]!.lock_token
      claimedCount = claimedBatch.observations.length
      const prepared = claimedBatch.observations.map((observation) => ({
        observation,
        context: this.prepareThreadContext(observation),
      }))
      const ignoredIds = prepared.filter(({ context }) => context === null).map(({ observation }) => observation.id)
      const learnable = prepared.filter(({ context }) => context !== null)
      if (ignoredIds.length > 0) this.ignoreClaimed(
        runId,
        lockToken,
        prepared.map(({ observation }) => observation),
        ignoredIds,
        now,
        learnable.length === 0,
      )
      const claimed = learnable.map(({ observation }) => observation)
      const threadContexts = learnable.map(({ context }) => context!)
      claimedCount = claimed.length
      if (claimed.length === 0) return zeroResult()
      heartbeat = setInterval(() => {
        try {
          const timestamp = new Date().toISOString()
          const result = this.database.prepare(`UPDATE learning_source_observations
            SET locked_at=?,updated_at=? WHERE processing_status='running' AND lock_token=?`).run(
            timestamp,
            timestamp,
            lockToken,
          )
          if (Number(result.changes) !== claimedCount) heartbeatLostClaim = true
        } catch {
          heartbeatLostClaim = true
        }
      }, 60_000)
      heartbeat.unref()
      const effective = claimed[0]!
      const snapshot = this.codeSync.readCurrentSnapshot(effective.observation_service_id)
      this.assertFreshSnapshot(snapshot, effective)
      const query = threadContexts.flatMap((context) => context.messages.map((message) => message.safeText)).join(" ").slice(0, 2000)
      const activeMemories = this.knowledge.listMemories({
        status: "active",
        scope: effective.knowledge_scope,
        ...(effective.region ? { region: effective.region } : {}),
        branch: effective.branch,
        q: query,
        limit: 30,
      })
      const boundedMaterial = boundReferenceLearningMaterial(threadContexts, activeMemories)
      const evidenceByObservationId = new Map(boundedMaterial.threadContexts.map((context) => (
        [context.observationId, context.messages.map((message) => message.safeText)] as const
      )))
      const rawProposalResult = await this.agent.classify({
        target: {
          scope: effective.knowledge_scope,
          region: effective.region || null,
          branch: effective.branch,
        },
        threadContexts: boundedMaterial.threadContexts,
        activeMemories: boundedMaterial.activeMemories,
        codeSnapshot: snapshot,
      })
      let proposed
      try {
        proposed = referenceProposalResultSchema.parse(rawProposalResult)
      } catch (error) {
        throw new InvalidProposalBatchError(`人工参考模型返回结构非法：${String(error)}`)
      }
      const activeRunId = runId
      const activeLockToken = lockToken
      if (!activeRunId || !activeLockToken) throw new Error("人工参考学习缺少活动 run 或 claim")
      return this.database.transaction(() => {
        const currentSnapshot = this.codeSync.readCurrentSnapshot(effective.observation_service_id)
        this.assertSameCurrentSnapshot(snapshot, currentSnapshot, effective)
        this.assertFinalAuthorization(activeLockToken, claimed)
        let validated: ValidatedProposal[]
        try {
          this.assertExactProposalCoverage(proposed.proposals, claimed)
          validated = proposed.proposals.map((proposal) => this.validateProposal(
            proposal,
            claimed,
            evidenceByObservationId,
            snapshot,
            effective,
          ))
        } catch (error) {
          if (error instanceof InvalidProposalBatchError) throw error
          throw new InvalidProposalBatchError(`人工参考模型提议非法：${String(error)}`)
        }
        if (heartbeatLostClaim) throw new Error("人工参考观察 heartbeat 已失去 claim")
        this.assertOwnsClaim(activeLockToken, claimedCount)

        let createdVersions = 0
        let conflicts = 0
        let styleVersions = 0
        const terminalResults: TerminalLearningResult[] = []
        for (const proposal of validated) {
          if (proposal.action === "noop") {
            terminalResults.push(...proposal.evidenceObservationIds.map((observationId) => ({
              observationId,
              classification: proposal.classification,
              action: proposal.action,
              risk: proposal.risk,
              outcome: "noop" as const,
              reasonCode: proposal.deterministicNoop ? "deterministic_noop" as const : "proposal_noop" as const,
              memoryVersionId: null,
              operatorStyleVersionId: null,
            })))
            continue
          }
          if (proposal.classification === "style") {
            const before = Number((this.database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get() as { count: number }).count)
            const styleVersion = this.styles.updateFromObservations(proposal.evidenceObservationIds)
            if (!styleVersion || !["candidate", "active"].includes(styleVersion.status)) {
              throw new Error("人工参考风格提议未形成有效版本")
            }
            const after = Number((this.database.prepare("SELECT COUNT(*) AS count FROM operator_style_versions").get() as { count: number }).count)
            styleVersions += Math.max(0, after - before)
            const active = styleVersion.status === "active"
            terminalResults.push(...proposal.evidenceObservationIds.map((observationId) => ({
              observationId,
              classification: proposal.classification,
              action: proposal.action,
              risk: proposal.risk,
              outcome: active ? "style_active" as const : "style_candidate" as const,
              reasonCode: active ? "style_active" as const : "style_candidate" as const,
              memoryVersionId: null,
              operatorStyleVersionId: styleVersion.id,
            })))
            continue
          }
          if (!["business_rule", "correction"].includes(proposal.classification)) {
            terminalResults.push(...proposal.evidenceObservationIds.map((observationId) => ({
              observationId,
              classification: proposal.classification,
              action: proposal.action,
              risk: proposal.risk,
              outcome: "noop" as const,
              reasonCode: "non_learnable_classification" as const,
              memoryVersionId: null,
              operatorStyleVersionId: null,
            })))
            continue
          }
          const submitted = this.knowledge.submitReferenceObservation({
            action: proposal.action,
            title: proposal.title,
            content: proposal.content,
            scope: effective.knowledge_scope,
            region: effective.region || null,
            branch: effective.branch,
            risk: proposal.risk,
            confidence: proposal.confidence,
            actor: "人工参考学习",
            observationIds: proposal.evidenceObservationIds,
            snapshotId: snapshot.snapshotId,
            codeRevision: snapshot.commit,
            codeEvidencePaths: proposal.codeEvidencePaths,
          })
          if (!["candidate", "conflict", "active"].includes(submitted.memory.status)) {
            throw new Error("人工参考业务提议未形成可审计版本")
          }
          if (submitted.createdVersion) createdVersions += 1
          if (submitted.memory.status === "conflict") conflicts += 1
          const memoryStatus = submitted.memory.status as "candidate" | "conflict" | "active"
          terminalResults.push(...proposal.evidenceObservationIds.map((observationId) => ({
            observationId,
            classification: proposal.classification,
            action: proposal.action,
            risk: proposal.risk,
            outcome: memoryStatus,
            reasonCode: `memory_${memoryStatus}` as "memory_candidate" | "memory_conflict" | "memory_active",
            memoryVersionId: submitted.memory.versionId,
            operatorStyleVersionId: null,
          })))
        }
        const result = { processed: claimed.length, createdVersions, conflicts, styleVersions }
        this.complete(
          activeLockToken,
          claimedCount,
          result,
          activeRunId,
          terminalResults,
          `人工参考学习完成：处理 ${claimed.length} 条观察`,
        )
        return result
      })
    } catch (error) {
      if (lockToken && runId) {
        this.fail(lockToken, runId, error instanceof InvalidProposalBatchError ? "invalid_proposal_batch" : "processing_failed")
      }
      return zeroResult()
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }
  }

  private claim(limit: number, now: Date): ClaimedBatch | null {
    const timestamp = now.toISOString()
    return this.database.transaction(() => {
      this.recoverInterrupted(now)
      const candidates = this.database.prepare(`SELECT
        observation.id,
        observation.message_event_id,
        observation.source_telegram_user_id,
        observation.source_role,
        observation.thread_id AS observation_thread_id,
        observation.service_id AS observation_service_id,
        observation.risk AS observation_risk,
        observation.classification,
        event.safe_text AS reference_text,
        event.sender_user_id AS event_sender_user_id,
        event.sender_role AS event_sender_role,
        event.route_status AS event_route_status,
        event.group_id AS event_group_id,
        thread.group_id AS thread_group_id,
        thread.project_id AS thread_project_id,
        thread.service_id AS thread_service_id,
        group_config.enabled AS group_enabled,
        group_config.purpose AS group_purpose,
        group_config.project_id AS group_project_id,
        group_config.service_id AS group_service_id,
        group_config.knowledge_scope,
        project.enabled AS project_enabled,
        service.service_key,
        service.project_id AS service_project_id,
        service.enabled AS service_enabled,
        service.region,
        service.branch,
        role.enabled AS role_enabled,
        role.learning_source_enabled AS role_learning_source_enabled,
        role.role AS configured_role
      FROM learning_source_observations observation
      LEFT JOIN support_message_events event ON event.id=observation.message_event_id
      LEFT JOIN support_threads thread ON thread.id=observation.thread_id
      LEFT JOIN telegram_groups group_config ON group_config.id=event.group_id
      LEFT JOIN projects project ON project.id=thread.project_id
      LEFT JOIN project_services service ON service.id=observation.service_id
      LEFT JOIN telegram_roles role ON role.telegram_user_id=observation.source_telegram_user_id
      WHERE observation.processing_status IN ('pending','failed') AND observation.attempt_count<5
      ORDER BY observation.created_at,observation.id LIMIT 500`).all() as QueueCandidate[]
      const invalid = candidates.filter((candidate) => !authorized(candidate))
      if (invalid.length > 0) {
        const ids = invalid.map((candidate) => candidate.id)
        this.database.prepare(`UPDATE learning_source_observations SET processing_status='ignored',
          lock_token=NULL,locked_at=NULL,current_run_id=NULL,updated_at=? WHERE id IN (${ids.map(() => "?").join(",")})
          AND processing_status IN ('pending','failed')`).run(timestamp, ...ids)
      }
      const valid = candidates.filter(authorized)
      const first = valid[0]
      if (!first) return null
      const selected = valid.filter((candidate) => (
        candidate.observation_service_id === first.observation_service_id
        && candidate.knowledge_scope === first.knowledge_scope
        && candidate.region === first.region
        && candidate.branch === first.branch
      )).slice(0, limit)
      const ids = selected.map((candidate) => candidate.id)
      const lockToken = randomUUID()
      const runId = randomUUID()
      this.database.insertMaintenanceRun({
        id: runId,
        status: "running",
        scannedEvents: selected.length,
        createdVersions: 0,
        conflictCount: 0,
        summary: "人工参考学习处理中",
        startedAt: timestamp,
        finishedAt: null,
      })
      const result = this.database.prepare(`UPDATE learning_source_observations SET processing_status='running',
        attempt_count=attempt_count+1,lock_token=?,locked_at=?,current_run_id=?,updated_at=?
        WHERE id IN (${ids.map(() => "?").join(",")}) AND processing_status IN ('pending','failed') AND attempt_count<5`).run(
        lockToken,
        timestamp,
        runId,
        timestamp,
        ...ids,
      )
      if (Number(result.changes) !== ids.length) throw new Error("人工参考观察 claim 竞争失败")
      return {
        runId,
        observations: selected.map((candidate) => ({ ...candidate, lock_token: lockToken })),
      }
    })
  }

  private prepareThreadContext(observation: ClaimedObservation): SafeReferenceThreadContext | null {
    const rows = this.database.prepare(`SELECT message.message_event_id,message.relation,event.safe_text
      FROM support_thread_messages message
      JOIN support_message_events event ON event.id=message.message_event_id
      WHERE message.thread_id=? ORDER BY message.position,event.created_at,event.id LIMIT 48`).all(
      observation.observation_thread_id,
    ) as Array<{ message_event_id: string; relation: string; safe_text: string }>
    const rawReferenceText = observation.reference_text?.trim() ?? ""
    if (!rawReferenceText) throw new Error("人工参考观察缺少 reference 文本")
    const reference = this.redactLearningText(rawReferenceText)
    const selectedRows = rows
      .filter((row) => row.message_event_id !== observation.message_event_id)
      .slice(0, 23)
    const contextParts = selectedRows
      .map((row) => ({ row, redacted: this.redactLearningText(row.safe_text) }))
      .filter((item): item is { row: typeof item.row; redacted: RedactedLearningText } => item.redacted !== null)
    if (!reference || this.hasHighSecretDensity([reference])) return null
    if (this.hasHighSecretDensity([reference, ...contextParts.map(({ redacted }) => redacted)])) return null
    const referenceText = reference.safeText.slice(0, 4000)
    if (!referenceText) return null
    const messages: SafeReferenceThreadContext["messages"] = []
    let remaining = 24_000 - referenceText.length
    for (const { row, redacted } of contextParts) {
      if (messages.length >= 23) break
      const text = redacted.safeText.slice(0, Math.min(4000, remaining))
      if (!text) continue
      messages.push({ role: row.relation === "origin" ? "question" : "context", safeText: text })
      remaining -= text.length
      if (remaining <= 0) break
    }
    messages.push({ role: "reference", safeText: referenceText })
    return safeReferenceThreadContextSchema.parse({
      observationId: observation.id,
      threadId: observation.observation_thread_id,
      messages,
    })
  }

  private redactLearningText(input: string): RedactedLearningText | null {
    const source = input.trim()
    if (!source) return null
    const initiallyRedacted = this.redactor.redact(source)
    let annotatedTransientUrl = false
    const escapedSource = escapeReferenceLearningMarkerLiterals(source)
    if (escapedSource !== source && initiallyRedacted.changed) return null
    const categorizedSource = escapedSource.replace(absoluteUrlCandidatePattern, (candidate) => {
      if (!signedUrlCredentialPattern.test(candidate)) return candidate
      annotatedTransientUrl = true
      return transientUrlRedactionMarker
    })
    const redacted = categorizedSource === source ? initiallyRedacted : this.redactor.redact(categorizedSource)
    const safeText = normalizeReferenceLearningText(redacted.text).trim()
    if (!safeText) return null
    return {
      safeText,
      changed: initiallyRedacted.changed || annotatedTransientUrl || redacted.changed,
      sourceSignalLength: source.replace(nonSemanticCharacters, "").length,
      safeSignalLength: safeText
        .replace(literalLearningMarkerPattern, "")
        .replace(redactedOnlyLinePattern, "")
        .replace(redactedFieldFragmentPattern, "")
        .replace(redactionMarker, "")
        .replace(sensitiveLearningLabelPattern, "")
        .replace(nonSemanticCharacters, "")
        .length,
    }
  }

  private hasHighSecretDensity(parts: RedactedLearningText[]): boolean {
    if (!parts.some((part) => part.changed)) return false
    const sourceSignalLength = parts.reduce((sum, part) => sum + part.sourceSignalLength, 0)
    const safeSignalLength = parts.reduce((sum, part) => sum + part.safeSignalLength, 0)
    return safeSignalLength === 0
      || sourceSignalLength === 0
      || safeSignalLength / sourceSignalLength < minimumSafeSignalRatio
  }

  private ignoreClaimed(
    runId: string,
    lockToken: string,
    claimed: ClaimedObservation[],
    observationIds: string[],
    now: Date,
    finishRun: boolean,
  ): void {
    if (observationIds.length === 0) return
    const timestamp = now.toISOString()
    this.database.transaction(() => {
      this.insertTerminalResults(runId, observationIds.map((observationId) => {
        const observation = claimed.find((candidate) => candidate.id === observationId)
        if (!observation) throw new Error("高秘密密度人工参考观察不属于 claim")
        return {
          observationId,
          classification: "unclassified" as const,
          action: "noop" as const,
          risk: observation.observation_risk,
          outcome: "ignored" as const,
          reasonCode: "unsafe_learning_material" as const,
          memoryVersionId: null,
          operatorStyleVersionId: null,
        }
      }), timestamp)
      const result = this.database.prepare(`UPDATE learning_source_observations SET processing_status='ignored',
        lock_token=NULL,locked_at=NULL,current_run_id=NULL,updated_at=? WHERE processing_status='running' AND lock_token=?
        AND current_run_id=? AND id IN (${observationIds.map(() => "?").join(",")})`).run(
        timestamp,
        lockToken,
        runId,
        ...observationIds,
      )
      if (Number(result.changes) !== observationIds.length) throw new Error("高秘密密度人工参考观察终止失败")
      if (finishRun) this.finishRun(
        runId,
        zeroResult(),
        "人工参考学习完成：观察均已安全忽略",
        timestamp,
      )
    })
  }

  private assertFinalAuthorization(lockToken: string, claimed: ClaimedObservation[]): void {
    const ids = claimed.map((observation) => observation.id)
    const current = this.database.prepare(`SELECT
      observation.id,
      observation.message_event_id,
      observation.source_telegram_user_id,
      observation.source_role,
      observation.thread_id AS observation_thread_id,
      observation.service_id AS observation_service_id,
      observation.risk AS observation_risk,
      observation.classification,
      event.safe_text AS reference_text,
      event.sender_user_id AS event_sender_user_id,
      event.sender_role AS event_sender_role,
      event.route_status AS event_route_status,
      event.group_id AS event_group_id,
      thread.group_id AS thread_group_id,
      thread.project_id AS thread_project_id,
      thread.service_id AS thread_service_id,
      group_config.enabled AS group_enabled,
      group_config.purpose AS group_purpose,
      group_config.project_id AS group_project_id,
      group_config.service_id AS group_service_id,
      group_config.knowledge_scope,
      project.enabled AS project_enabled,
      service.service_key,
      service.project_id AS service_project_id,
      service.enabled AS service_enabled,
      service.region,
      service.branch,
      role.enabled AS role_enabled,
      role.learning_source_enabled AS role_learning_source_enabled,
      role.role AS configured_role
    FROM learning_source_observations observation
    LEFT JOIN support_message_events event ON event.id=observation.message_event_id
    LEFT JOIN support_threads thread ON thread.id=observation.thread_id
    LEFT JOIN telegram_groups group_config ON group_config.id=event.group_id
    LEFT JOIN projects project ON project.id=thread.project_id
    LEFT JOIN project_services service ON service.id=observation.service_id
    LEFT JOIN telegram_roles role ON role.telegram_user_id=observation.source_telegram_user_id
    WHERE observation.processing_status='running' AND observation.lock_token=?
      AND observation.id IN (${ids.map(() => "?").join(",")})`).all(lockToken, ...ids) as QueueCandidate[]
    if (current.length !== claimed.length) throw new Error("人工参考观察最终授权时 claim 已失效")
    const currentById = new Map(current.map((candidate) => [candidate.id, candidate]))
    const stableAuthorizationFields: Array<keyof QueueCandidate> = [
      "message_event_id",
      "source_telegram_user_id",
      "source_role",
      "observation_thread_id",
      "observation_service_id",
      "observation_risk",
      "classification",
      "event_sender_user_id",
      "event_sender_role",
      "event_route_status",
      "event_group_id",
      "thread_group_id",
      "thread_project_id",
      "thread_service_id",
      "group_purpose",
      "group_project_id",
      "group_service_id",
      "knowledge_scope",
      "service_key",
      "service_project_id",
      "region",
      "branch",
      "configured_role",
    ]
    for (const expected of claimed) {
      const candidate = currentById.get(expected.id)
      if (!candidate || !authorized(candidate)
        || stableAuthorizationFields.some((field) => candidate[field] !== expected[field])) {
        throw new Error("人工参考分类期间来源授权或绑定已变化")
      }
    }
  }

  private assertFreshSnapshot(snapshot: ProjectCodeSnapshot, effective: ClaimedObservation): void {
    if (snapshot.syncState !== "fresh"
      || snapshot.serviceId !== effective.observation_service_id
      || snapshot.service !== effective.service_key
      || snapshot.branch !== effective.branch
      || snapshot.repositories.length === 0
      || snapshot.repositories.some((repository) => repository.branch !== effective.branch)) {
      throw new Error("人工参考学习必须使用当前 fresh 代码快照")
    }
  }

  private assertSameCurrentSnapshot(
    expected: ProjectCodeSnapshot,
    current: ProjectCodeSnapshot,
    effective: ClaimedObservation,
  ): void {
    this.assertFreshSnapshot(current, effective)
    const repositoryIdentity = (snapshot: ProjectCodeSnapshot): string => JSON.stringify(
      snapshot.repositories.map((repository) => ({
        role: repository.role,
        repositoryId: repository.repositoryId,
        name: repository.name,
        branch: repository.branch,
        commit: repository.commit,
      })).sort((left, right) => `${left.role}:${left.repositoryId}:${left.name}`.localeCompare(
        `${right.role}:${right.repositoryId}:${right.name}`,
      )),
    )
    if (current.projectId !== expected.projectId
      || current.serviceId !== expected.serviceId
      || current.snapshotId !== expected.snapshotId
      || current.syncBatchId !== expected.syncBatchId
      || current.configurationFingerprint !== expected.configurationFingerprint
      || current.commit !== expected.commit
      || repositoryIdentity(current) !== repositoryIdentity(expected)) {
      throw new Error("人工参考分类期间当前代码快照已变化")
    }
  }

  private assertExactProposalCoverage(proposals: ReferenceProposal[], claimed: ClaimedObservation[]): void {
    const expected = new Set(claimed.map((observation) => observation.id))
    const seen = new Set<string>()
    for (const proposal of proposals) {
      for (const observationId of proposal.evidenceObservationIds) {
        if (!expected.has(observationId)) throw new InvalidProposalBatchError("模型引用了本批次以外的人工观察")
        if (seen.has(observationId)) throw new InvalidProposalBatchError("模型重复引用了同一人工观察")
        seen.add(observationId)
      }
    }
    if (seen.size !== expected.size || [...expected].some((observationId) => !seen.has(observationId))) {
      throw new InvalidProposalBatchError("模型提议未逐条覆盖本批次人工观察")
    }
  }

  private validateProposal(
    proposal: ReferenceProposal,
    claimed: ClaimedObservation[],
    evidenceByObservationId: Map<string, string[]>,
    snapshot: ProjectCodeSnapshot,
    effective: ClaimedObservation,
  ): ValidatedProposal {
    const allowedObservationIds = new Set(claimed.map((observation) => observation.id))
    if (proposal.evidenceObservationIds.some((id) => !allowedObservationIds.has(id))) {
      throw new Error("模型引用了本批次以外的人工观察")
    }
    const expectedRegion = effective.region || null
    if (proposal.scope !== effective.knowledge_scope || proposal.region !== expectedRegion || proposal.branch !== effective.branch) {
      throw new Error("模型提议的 scope region branch 与观察来源不一致")
    }
    const codeEvidencePaths = [...new Set(proposal.codeEvidencePaths.map((relativePath) => (
      this.verifyExactCodePath(snapshot, relativePath)
    )))]
    const evidenceText = proposal.evidenceObservationIds.flatMap((observationId) => {
      const texts = evidenceByObservationId.get(observationId)
      if (!texts) throw new Error("模型引用了不存在的人工观察")
      return texts
    })
    const deterministicallyNonLearnable = [
      ...evidenceText,
      proposal.title,
      proposal.content,
      proposal.reason,
    ].some(isDeterministicallyNonLearnable)
    const deterministicRisk = sensitiveKnowledge.test(`${proposal.title}\n${proposal.content}`) ? "high" : "low"
    const observationRisk = proposal.evidenceObservationIds.reduce<MemoryRisk>((risk, observationId) => {
      const observation = claimed.find((candidate) => candidate.id === observationId)
      if (!observation) throw new Error("模型引用了不存在的人工观察")
      return maximumRisk(risk, observation.observation_risk)
    }, "low")
    return {
      ...proposal,
      action: deterministicallyNonLearnable ? "noop" : proposal.action,
      evidenceObservationIds: [...proposal.evidenceObservationIds],
      codeEvidencePaths,
      risk: maximumRisk(maximumRisk(proposal.risk, deterministicRisk), observationRisk),
      deterministicNoop: deterministicallyNonLearnable,
    }
  }

  private verifyExactCodePath(snapshot: ProjectCodeSnapshot, relativePath: string): string {
    const repository = snapshot.repositories.find((candidate) => relativePath.startsWith(`${candidate.name}/`))
    if (!repository) throw new Error("代码证据不属于当前快照仓库")
    const suffix = relativePath.slice(repository.name.length + 1)
    const root = path.resolve(repository.snapshotPath)
    const candidate = path.resolve(root, suffix)
    if (!suffix || !inside(candidate, root) || !existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error("代码证据不是当前快照中的精确文件")
    }
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    if (!inside(realCandidate, realRoot)) throw new Error("代码证据逃逸当前快照")
    return relativePath
  }

  private assertOwnsClaim(lockToken: string, claimedCount: number): void {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM learning_source_observations
      WHERE processing_status='running' AND lock_token=?`).get(lockToken) as { count: number }
    if (Number(row.count) !== claimedCount) throw new Error("人工参考观察 claim 已失效")
  }

  private insertTerminalResults(runId: string, results: TerminalLearningResult[], createdAt: string): void {
    if (results.length === 0) return
    const insert = this.database.prepare(`INSERT INTO reference_learning_results(
      id,run_id,observation_id,classification,action,risk,outcome,reason_code,
      memory_version_id,operator_style_version_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    for (const result of results) {
      insert.run(
        randomUUID(),
        runId,
        result.observationId,
        result.classification,
        result.action,
        result.risk,
        result.outcome,
        result.reasonCode,
        result.memoryVersionId,
        result.operatorStyleVersionId,
        createdAt,
      )
    }
  }

  private finishRun(runId: string, result: ReferenceLearningRunResult, summary: string, finishedAt: string): void {
    const run = this.database.prepare(`SELECT scanned_events FROM memory_maintenance_runs
      WHERE id=? AND status='running'`).get(runId) as { scanned_events: number } | undefined
    if (!run) throw new Error("人工参考学习 run 已失效")
    const terminalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results
      WHERE run_id=?`).get(runId) as { count: number }).count)
    if (terminalCount !== Number(run.scanned_events)) throw new Error("人工参考学习终态结果数量不完整")
    const updated = this.database.prepare(`UPDATE memory_maintenance_runs SET status='completed',created_versions=?,conflict_count=?,
      summary=?,finished_at=? WHERE id=? AND status='running'`).run(
      result.createdVersions,
      result.conflicts,
      summary,
      finishedAt,
      runId,
    )
    if (Number(updated.changes) !== 1) throw new Error("人工参考学习 run 完成竞争失败")
  }

  private complete(
    lockToken: string,
    claimedCount: number,
    result: ReferenceLearningRunResult,
    runId: string,
    terminalResults: TerminalLearningResult[],
    summary: string,
  ): void {
    const finishedAt = new Date().toISOString()
    this.database.transaction(() => {
      if (terminalResults.length !== claimedCount
        || new Set(terminalResults.map((terminal) => terminal.observationId)).size !== claimedCount) {
        throw new Error("人工参考学习终态结果未逐条覆盖 claim")
      }
      this.insertTerminalResults(runId, terminalResults, finishedAt)
      const completed = this.database.prepare(`UPDATE learning_source_observations SET processing_status='completed',
        lock_token=NULL,locked_at=NULL,current_run_id=NULL,updated_at=?
        WHERE processing_status='running' AND lock_token=? AND current_run_id=?`).run(finishedAt, lockToken, runId)
      if (Number(completed.changes) !== claimedCount) throw new Error("人工参考观察完成时 claim 已失效")
      this.finishRun(runId, result, summary, finishedAt)
    })
  }

  private fail(
    lockToken: string,
    runId: string,
    reasonCode: "invalid_proposal_batch" | "processing_failed",
  ): void {
    const failedAt = new Date().toISOString()
    this.database.transaction(() => {
      const failedRows = this.database.prepare(`SELECT id,risk FROM learning_source_observations
        WHERE processing_status='running' AND lock_token=? AND current_run_id=? ORDER BY id`).all(lockToken, runId) as Array<{
        id: string
        risk: MemoryRisk
      }>
      this.insertTerminalResults(runId, failedRows.map((row) => ({
        observationId: row.id,
        classification: "unclassified",
        action: "noop",
        risk: row.risk,
        outcome: "failed",
        reasonCode,
        memoryVersionId: null,
        operatorStyleVersionId: null,
      })), failedAt)
      const failed = this.database.prepare(`UPDATE learning_source_observations SET processing_status='failed',
        lock_token=NULL,locked_at=NULL,current_run_id=NULL,updated_at=?
        WHERE processing_status='running' AND lock_token=? AND current_run_id=?`).run(failedAt, lockToken, runId)
      if (Number(failed.changes) !== failedRows.length) throw new Error("人工参考观察失败终态写入时 claim 已变化")
      const run = this.database.prepare("SELECT scanned_events FROM memory_maintenance_runs WHERE id=? AND status='running'")
        .get(runId) as { scanned_events: number } | undefined
      if (!run) throw new Error("人工参考学习失败时 run 已失效")
      const terminalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM reference_learning_results
        WHERE run_id=?`).get(runId) as { count: number }).count)
      if (terminalCount !== Number(run.scanned_events)) throw new Error("人工参考学习失败终态结果数量不完整")
      const updated = this.database.prepare(`UPDATE memory_maintenance_runs SET status='failed',
        summary='人工参考学习失败，等待重试',finished_at=? WHERE id=? AND status='running'`).run(failedAt, runId)
      if (Number(updated.changes) !== 1) {
        throw new Error("人工参考学习失败 run 更新竞争失败")
      }
    })
  }

  private tick(): void {
    let settings
    try {
      settings = this.config.getSettings()
    } catch {
      return
    }
    if (!settings.autoLearningEnabled || this.activeRun
      || Date.now() - this.lastStartedAt < settings.learningIntervalSeconds * 1000) return
    this.lastStartedAt = Date.now()
    void this.runOnce().catch(() => undefined)
  }
}
