import { CodexExecutionError, CodexExecutionTimeoutError } from "../codex/executor.js"
import { ProjectCodeSyncUnavailableError } from "../git-sync/project-service.js"
import { ModelExecutionError } from "../models/errors.js"
import type { ReplyEventBus } from "../replies/reply-event-bus.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { ModelConfigService } from "../runtime/model-config-service.js"
import type { AdminChatTurn } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import type { ResponseDepth } from "../support/agent.js"
import {
  SupportCodeConfigurationChangedError,
  SupportCodeSyncRuntimeError,
  SupportModelOutputRejectedError,
  type SupportInvestigationService,
} from "../support/investigation-service.js"
import type { AdminChatStore } from "./store.js"

type AdminChatWorkerDependencies = {
  store: AdminChatStore
  database: Pick<RuntimeDatabase, "readProjects" | "readActiveOperatorStyle">
  config: Pick<ModelConfigService, "getProfile" | "getBinding" | "getModelInstanceSnapshot">
  investigation: Pick<SupportInvestigationService, "investigate">
  redactor: ConfiguredSecretRedactor
  events: ReplyEventBus
}

type SafeFailure = { errorCode: string; reason: string }

const maximumHistoryTurns = 20
const maximumContextLength = 12_000

function turnMessageSignature(turn: AdminChatTurn): string {
  const attachments = turn.attachments
    .map((attachment) => `${attachment.name}:${attachment.mimeType}:${attachment.size}`)
    .join("|")
  return `${turn.question.trim()}\n${attachments}`
}

export function conversationHistory(turns: AdminChatTurn[], current: AdminChatTurn): string {
  const logicalTurns: Array<{ user: AdminChatTurn; reply: AdminChatTurn | null; latest: AdminChatTurn }> = []
  for (const turn of turns
    .filter((item) => item.position < current.position && ["completed", "failed", "cancelled"].includes(item.status))
    .sort((left, right) => left.position - right.position)) {
    const previous = logicalTurns.at(-1)
    if (previous
      && previous.latest.status !== "completed"
      && turnMessageSignature(previous.latest) === turnMessageSignature(turn)) {
      previous.latest = turn
      if (turn.status === "completed") previous.reply = turn
      continue
    }
    logicalTurns.push({
      user: turn,
      reply: turn.status === "completed" ? turn : null,
      latest: turn,
    })
  }
  const latestLogicalTurn = logicalTurns.at(-1)
  if (latestLogicalTurn
    && latestLogicalTurn.latest.status !== "completed"
    && turnMessageSignature(latestLogicalTurn.latest) === turnMessageSignature(current)) {
    logicalTurns.pop()
  }
  const history = logicalTurns
    .slice(-maximumHistoryTurns)
    .reverse()
  const blocks: string[] = []
  let length = 0
  for (const logical of history) {
    const attachmentNames = logical.user.attachments.map((attachment) => attachment.name).join(" ")
    const parts = [
      `[运营 ${logical.user.createdAt} message_id=admin-chat:${logical.user.id}]`,
      logical.user.question || `[附件 ${attachmentNames}]`,
    ]
    if (logical.reply) {
      const corrected = logical.reply.corrections.at(-1)?.correctedAnswer
      parts.push(
        "",
        `[客服 ${logical.reply.completedAt ?? logical.reply.updatedAt} reply_id=admin-chat:${logical.reply.id}]`,
        corrected || logical.reply.answer,
      )
    }
    const block = parts.join("\n")
    if (block.length + 2 + length > maximumContextLength) break
    blocks.unshift(block)
    length += block.length + 2
  }
  return blocks.join("\n\n")
}

const bracketedTelegramHeader = /^\[(?:19|20)\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\]\s*[^:\r\n]{1,160}:\s*(.*)$/u
const exportedTelegramHeader = /^.{1,160},\s*\[(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+(?:19|20)\d{2}\s+at\s+\d{1,2}:\d{2}(?::\d{2})?\]:\s*(.*)$/iu
const adminChatUiTimestamp = /^\d{2}\/\d{2}\s+\d{2}:\d{2}\s*$/u
const adminChatUiOnlyLine = /^(?:AI\s*客服|真人口吻|复制|纠正|已回复|正在生成|关闭问题|起始问题|后续补充|处理依据)$/u

function latestPastedAdminUiMessage(question: string): string | null {
  if (!/(?:起始问题|问题版本\s*v\d+)[\s\S]{0,20000}AI\s*处理结果/u.test(question)) return null
  const normalized = question.replace(/\r\n?/gu, "\n")
  const markerAt = normalized.lastIndexOf("AI 处理结果")
  if (markerAt < 0) return null
  const afterMarker = normalized.slice(markerAt + "AI 处理结果".length)
  const blocks = afterMarker.split(/\n\s*\n+/u)
    .map((block) => block.split("\n")
      .filter((line) => !adminChatUiTimestamp.test(line.trim()) && !adminChatUiOnlyLine.test(line.trim()))
      .join("\n").trim())
    .filter(Boolean)
  if (blocks.length < 2) return null
  return blocks.at(-1) ?? null
}

export function latestAdminChatMessage(question: string): string {
  const lines = question.replace(/\r\n?/gu, "\n").split("\n")
  let latestStart = -1
  let firstLine = ""
  for (let index = 0; index < lines.length; index += 1) {
    const matched = bracketedTelegramHeader.exec(lines[index]!) ?? exportedTelegramHeader.exec(lines[index]!)
    if (!matched) continue
    latestStart = index
    firstLine = matched[1] ?? ""
  }
  if (latestStart < 0) return latestPastedAdminUiMessage(question) ?? question.trim()

  const content = [firstLine]
  for (let index = latestStart + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (bracketedTelegramHeader.test(line) || exportedTelegramHeader.test(line) || adminChatUiTimestamp.test(line)) break
    content.push(line)
  }
  return content.join("\n").trim() || question.trim()
}

export function latestInvestigationCheckpoint(
  turns: AdminChatTurn[],
  current: AdminChatTurn,
): Pick<AdminChatTurn, "id" | "completedAt" | "codeSnapshotId" | "codeRevision" | "investigation"> | null {
  const completed = turns
    .filter((turn) => turn.status === "completed"
      && turn.position < current.position
      && turn.codeSnapshotId
      && Object.keys(turn.investigation).length > 0)
    .sort((left, right) => right.position - left.position)[0]
  if (!completed) return null
  return {
    id: completed.id,
    completedAt: completed.completedAt,
    codeSnapshotId: completed.codeSnapshotId,
    codeRevision: completed.codeRevision,
    investigation: completed.investigation,
  }
}

export function responseDepthForHistory(history: string): ResponseDepth {
  return history ? "followup" : "initial"
}

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof CodexExecutionTimeoutError || (error instanceof Error && error.name === "CodexExecutionTimeoutError")) {
    return { errorCode: "admin_chat_timeout", reason: "后台对话排查达到回答模型运行上限" }
  }
  if (error instanceof ProjectCodeSyncUnavailableError || (error instanceof Error && error.name === "ProjectCodeSyncUnavailableError")) {
    return { errorCode: "admin_chat_code_sync_unavailable", reason: "后台对话排查没有取得可用的完整代码快照" }
  }
  if (error instanceof SupportCodeConfigurationChangedError
    || (error instanceof Error && error.name === "SupportCodeConfigurationChangedError")) {
    return { errorCode: "admin_chat_code_configuration_changed", reason: "后台对话排查期间服务代码配置发生变化" }
  }
  if (error instanceof SupportCodeSyncRuntimeError
    || (error instanceof Error && error.name === "SupportCodeSyncRuntimeError")) {
    return { errorCode: "admin_chat_code_sync_failed", reason: "后台对话代码同步没有形成可用快照" }
  }
  if (error instanceof SupportModelOutputRejectedError
    || (error instanceof Error && error.name === "SupportModelOutputRejectedError")) {
    return {
      errorCode: "admin_chat_model_output_rejected",
      reason: error instanceof Error ? error.message : "回答模型连续三次未通过发送前校验",
    }
  }
  if (error instanceof ModelExecutionError) {
    const reasons: Record<ModelExecutionError["code"], string> = {
      model_disabled: "回答模型当前已停用",
      credentials_missing: "回答模型缺少调用凭据",
      authentication_failed: "回答模型厂商鉴权失败",
      quota_exhausted: "回答模型厂商额度不足",
      rate_limited: "回答模型厂商请求过于频繁",
      model_not_found: "回答模型不存在或当前不可用",
      parameter_unsupported: error.message,
      structured_output_invalid: "回答模型连续返回了无效结构化结果",
      tool_loop_exhausted: "回答模型只读工具调用达到轮数上限",
      provider_timeout: "回答模型厂商请求超时",
      provider_unavailable: error.message,
    }
    return { errorCode: `admin_chat_model_${error.code}`, reason: reasons[error.code] }
  }
  if (error instanceof CodexExecutionError || (error instanceof Error && error.name === "CodexExecutionError")) {
    return {
      errorCode: "admin_chat_codex_execution_failed",
      reason: error instanceof Error && error.message === "Codex 未返回结果"
        ? "本机回答模型没有返回结果"
        : "本机回答模型执行失败",
    }
  }
  if (error instanceof Error && error.message === "回答模型已停用") {
    return { errorCode: "admin_chat_answer_disabled", reason: "回答模型当前已停用" }
  }
  return { errorCode: "admin_chat_investigation_failed", reason: "后台对话排查执行失败" }
}

export class AdminChatWorker {
  private readonly active = new Set<Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private claiming = false

  constructor(private readonly deps: AdminChatWorkerDependencies) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.recover()
    this.timer = setInterval(() => this.wake(), 500)
    this.timer.unref()
    this.wake()
  }

  wake(): void {
    if (!this.running || this.claiming) return
    const maximum = Math.max(1, this.deps.config.getProfile("answer").maxConcurrency)
    if (this.active.size >= maximum) return
    this.claiming = true
    try {
      const turn = this.deps.store.claimNext()
      if (!turn) return
      const task = this.process(turn).finally(() => {
        this.active.delete(task)
        if (this.running) queueMicrotask(() => this.wake())
      })
      this.active.add(task)
      this.publish(turn)
    } finally {
      this.claiming = false
    }
  }

  cancel(turnId: string): boolean {
    const controller = this.controllers.get(turnId)
    if (!controller || controller.signal.aborted) return false
    controller.abort(new Error("用户终止后台对话"))
    return true
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.controllers.forEach((controller) => controller.abort())
    await Promise.allSettled([...this.active])
    this.recover()
  }

  recover(): number {
    return this.deps.store.recoverInterrupted()
  }

  private async process(turn: AdminChatTurn): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(turn.id, controller)
    try {
      const detail = this.deps.store.getSession(turn.sessionId)
      if (detail.turns.find((item) => item.id === turn.id)?.status !== "generating") return
      const project = this.deps.database.readProjects("WHERE id=? AND enabled=1", [detail.session.projectId])[0]
      if (!project) throw new Error("后台对话项目不存在或未启用")
      const binding = this.deps.config.getBinding("answer")
      const modelSnapshot = this.deps.config.getModelInstanceSnapshot(binding.modelInstanceId)
      const operatorStyle = this.deps.database.readActiveOperatorStyle()
      const history = conversationHistory(detail.turns, turn)
      const question = turn.question || `请查看并判断本消息附件 ${turn.attachments.map((attachment) => attachment.name).join(" ")}`
      const latestMessage = latestAdminChatMessage(question)
      const priorInvestigation = latestInvestigationCheckpoint(detail.turns, turn)
      const result = await this.deps.investigation.investigate({
        serviceId: detail.session.serviceId,
        groupName: "后台 AI 对话",
        question,
        latestMessage,
        ...(history ? { conversationContext: history } : {}),
        ...(priorInvestigation ? { priorInvestigation } : {}),
        responseDepth: responseDepthForHistory(history),
        senderRole: null,
        scope: project.defaultKnowledgeScope,
        attachments: turn.attachments.map((attachment) => ({
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          size: attachment.size,
          extractedText: attachment.extractedText,
          localPath: attachment.storagePath || null,
        })),
        answerTimeoutSeconds: binding.timeoutSeconds,
        operatorStyleProfile: operatorStyle.profile,
        modelInstanceId: binding.modelInstanceId,
        modelSnapshot,
        answerMaxConcurrency: binding.maxConcurrency,
        answerBindingEnabled: binding.enabled,
        includeAiMemory: true,
        includeInterfaceDocs: true,
        includeMagicBook: true,
        replyStyle: "human",
        onProgress: async (progress) => {
          const updated = this.deps.store.updateInvestigationProgress(turn.id, {
            investigation: this.redactJson(progress.investigation),
            codeRevision: progress.snapshot.commit,
            codeSnapshotId: progress.snapshot.snapshotId,
            codeSyncBatchId: progress.snapshot.syncBatchId,
          })
          this.publish(updated)
        },
      }, controller.signal)
      const redact = (value: string) => this.deps.redactor.redact(value).text
      const decision = result.decision
      const completed = this.deps.store.completeTurn(turn.id, {
        answer: redact(decision.answer),
        decision: decision.decision,
        investigation: this.redactJson(decision.investigation),
        decisionReason: redact(decision.reason),
        decisionConfidence: decision.confidence,
        codeRevision: result.snapshot.commit,
        codeSnapshotId: result.snapshot.snapshotId,
        codeSyncBatchId: result.snapshot.syncBatchId,
        memoryVersionRefs: decision.usedMemoryVersionIds.filter((id) => result.allowedMemoryIds.has(id)),
      })
      this.publish(completed)
    } catch (error) {
      if (controller.signal.aborted) return
      const failure = safeFailure(error)
      try {
        const failed = this.deps.store.failTurn(
          turn.id,
          failure.errorCode,
          this.deps.redactor.redact(failure.reason).text,
        )
        this.publish(failed)
      } catch {
        // 状态已经由并发恢复或关闭流程接管时不覆盖现有结果。
      }
    } finally {
      if (this.controllers.get(turn.id) === controller) this.controllers.delete(turn.id)
    }
  }

  private redactJson(value: unknown): unknown {
    if (typeof value === "string") return this.deps.redactor.redact(value).text
    if (Array.isArray(value)) return value.map((item) => this.redactJson(item))
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactJson(item)]))
    }
    return value
  }

  private publish(turn: AdminChatTurn): void {
    const session = this.deps.store.getSession(turn.sessionId).session
    this.deps.events.publish({
      kind: "admin-chat-turn",
      id: turn.id,
      sessionId: turn.sessionId,
      ownerUserId: session.createdByUserId,
      status: turn.status,
      updatedAt: turn.updatedAt,
    })
  }
}
