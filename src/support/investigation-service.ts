import { readFileSync, statSync } from "node:fs"
import path from "node:path"

import type { AnswerDecision, InvestigationStep, InvestigationTrace } from "../codex/schemas.js"
import type { CodexCommandObservation } from "../codex/executor.js"
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
  SupportDecisionAgentPort,
  SupportInvestigationCheckpoint,
  SupportResourceSummary,
} from "./agent.js"
import { operatorStylePrompt } from "./operator-style.js"
import {
  operatorAnswerStartsWithMechanicalAcknowledgement,
  operatorQuestionWantsTechnicalDetail,
  operatorQuoteForReply,
} from "./operator-voice.js"
import type { ResourceWorkspace } from "./resource-workspace.js"
import {
  type TrustedDatabaseQueryRequest,
  validateTrustedCommandObservation,
} from "./trusted-command-observation.js"

type ResourceBrokerPort = {
  runServerCheck(resourceId: string, check: "nginx_routes" | "system_resources"): Promise<{ exitCode: number; stdout: string; stderr: string }>
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

const anomalyPattern = /(?:延迟|失败|不到账|未到账|没到账|未回调|没回调|报错|异常|超时|错误|error|failed|failure|delay|timeout)/iu
const repeatedIncidentConcernPattern = /(?:几十|很多|多笔|多单|一批|批量|成批|大批|好几|多次|又(?:有|来|出现|发生)|再次|反复|今天.{0,10}(?:两次|多次|几次|又)|得注意|要注意|需要注意|严重)/u
const operationalIncidentContextPattern = /(?:订单|代付|代收|上游|通道|回调|打款中|待结果|Pending|失败|延迟|异常)/iu
const upstreamCallbackMissingEvidencePattern = /上游回调日志\s*[：:]\s*(?:\/|无|暂无|没有|未收到|空|null)(?:\s|$)/iu
const upstreamPendingEvidencePattern = /(?:上游请求日志|上游名称)[\s\S]{0,5000}(?:"status"\s*:\s*"Pending"|状态\s*[：:]\s*Pending)/iu
const upstreamReturnedErrorEvidencePattern = /(?:上游|通道|ADPay)[^\r\n]{0,120}(?:(?:报错|错误信息|错误原因|失败原因|错误码)|(?:响应|返回)[^\r\n]{0,100}(?:提示|报错|错误信息|错误原因|失败原因|错误码|(?:error|message|msg)(?:Code|Message)?\s*["']?\s*[:=]))[^\r\n]{0,300}/iu
const callbackLaterArrivedPattern = /(?:(?:上游|通道).{0,16}(?:已经|已)(?:回调|通知|发送|推送)|(?:已经|已)(?:收到|有).{0,12}(?:上游|通道)?(?:回调|最终结果)|(?:回调|最终结果).{0,8}(?:已经|已)(?:收到|到了))/iu
const explicitExternalNegationPattern = /(?:(?:不是|并非)(?:我们|我方)(?:这边|系统|平台)?[^。\n]{0,12}(?:有问题|异常|故障|错误)|(?:我们|我方)(?:这边|系统|平台)?[^。\n]{0,12}(?:没有|没|不存在|无)(?:任何)?[^。\n]{0,8}(?:问题|异常|故障|错误))[，,。；;\s]*/giu
const forbiddenOperatorEscalationPattern = /(?:我们|我方)(?:这边|的)?(?:系统|平台|代码|程序|后端|服务端|处理逻辑)?[^。\n]{0,12}(?:有问题|出问题|存在缺陷|代码有误|逻辑有误|处理异常|系统故障)|(?:已(?:经)?)?(?:反馈|提交|同步)(?:给|至)?技术|(?:交给|发给|转给|让|找|需要|得让)(?:技术|开发|研发)(?:处理|排查|确认|看|介入)|(?:技术|开发|研发)(?:已经|正在|会|要)?(?:处理|排查|确认|介入)/iu
const operatorJargonPattern = /(?:nginx|HTML|HTTP|JSON|反序列化|序列化|解析(?:失败|异常|错误页)|状态机|异步(?:任务|结果|处理)|请求方法|根路径|反向代理|堆栈|查询通道|执行环境|bwrap|NETLINK_ROUTE|loopback)/iu
const operatorReportPattern = /(?:需求范围已明确|请确认你说的|请再确认(?:一个|下)?规则|还需要明确哪些|如还包含[^\n]{0,30}请一并明确|^\s*\d+[.、]\s*\S)/imu
const automationIdentityDisclosurePattern = /(?:(?:我|我们|这边|这里|客服)(?:是|不是|属于|作为|由).{0,12}(?:AI|人工智能|机器人|機器人|bot|模型|自动客服|自動客服|程序)|^(?:不是|并不是).{0,8}(?:AI|人工智能|机器人|機器人|bot|自动客服|自動客服))/iu
const verifiedCodeDefectPattern = /^\[已确认代码问题\]\s+仓库=([^\s]+)\s+文件=([^\s]+)\s+行=(\d+)(?:\s|$)/u
const verifiedTechnicalChangePattern = /^\[已确认技术处理\]\s*类型=(生产配置|后台映射|后台数据|服务操作)(?:\s|$)/u
const verifiedFeatureRequestPattern = /^\[产品改动需求\](?:\s|$)/u
const verifiedServiceHandoffPattern = /^\[跨服务人工接管\]\s*服务=([^\r\n]+)\s*(?:\r?\n|$)/u
const verifiedHumanOperationPattern = /^\[专人操作\](?:\s|$)/u
const serviceHandoffInsistencePattern = /(?:同一个团队|同一团队|一个团队|不也是你们|也是你们|还是(?:要|会|得)?来问你们|到时候.{0,12}问你们|你们(?:自己|这边)?接手|帮我转|帮忙转|非要.{0,8}死板|机器人吗|来回.{0,8}(?:问|转|跑))/iu
const capabilityRequestPattern = /(?:能不能|可不可以|可以不可以|能否|是否可以|(?:可以|能).{1,40}吗)/u
const featureChangeActionPattern = /(?:加(?:个|一个)?|新增|增加|添加|修改|改成|调整|优化|支持|开发|补充|开放)/u
const featureObjectPattern = /(?:功能|页面|接口|字段|展示|流程|代码|按钮|菜单|筛选|导出|通知|回调|权限|开关|批量|自动)/u
const auditableActionClaimPattern = /(?:被|已|曾|人工|手动|执行了|进行了).{0,32}(?:释放|补单|重新派发|再次派发|重派|强制修改状态|手动改状态)|(?:释放|补单|重新派发|再次派发|重派|强制修改状态|手动改状态).{0,16}(?:了|时间|记录|操作人|执行人|成功|完成|共\s*\d+\s*笔)/u
const auditableActionEvidencePattern = /(?:释放|补单|重新派发|再次派发|重派|强制修改状态|手动改状态|release|redispatch|reassign|manual.{0,8}status)/iu
const actionActorEvidencePattern = /(?:操作人|操作账号|操作用户|执行人|经办人|管理员|operator(?:_?(?:id|name|user))?|actor(?:_?(?:id|name|user))?|user_?name|username|user_?id|admin(?:_?(?:id|name|user))?|created?_?by|updated?_?by|create_?user|update_?user|creator|updater)/iu
const answerKnownActorPattern = /(?:操作人|操作账号|操作用户|执行人|经办人)\s*(?:分别)?(?:是|为|[:：=])\s*([^\s，。；;]{1,160})/u
const answerUnknownActorPattern = /(?:操作人|操作账号|操作用户|执行人|经办人).{0,32}(?:无法确认|未留下|未记录|没有记录|未查到|未知|为空)/u
type TechnicalChangeType = "生产配置" | "后台映射" | "后台数据" | "服务操作"
const technicalChangeEvidencePatterns: Record<TechnicalChangeType, RegExp> = {
  生产配置: /(?:config|configuration|properties|ya?ml|env|配置|参数|开关)/iu,
  后台映射: /(?:mapping|mapper|map[_-]?|bank[_-]?(?:code|mapping)|channel[_-]?|映射|银行编码|通道)/iu,
  后台数据: /(?:database|table|select|from|where|record|row|数据|记录|订单)/iu,
  服务操作: /(?:systemctl|service|process|restart|reload|deploy|进程|服务|重启|发布)/iu,
}
const evidenceIdentifierStopwords = new Set([
  "active", "actual", "code", "command", "config", "configuration", "confirmed", "database", "enabled", "error",
  "execute", "id", "mapper", "mapping", "name", "output", "read", "readonly", "result", "return", "select",
  "server", "service", "status", "support", "value", "where",
])
function retryInstruction(depth: ResponseDepth, operatorStyleProfile: unknown, rejectionRequirement?: string): string {
  const style = depth === "followup"
    ? "这是后续追问 只接最新一句新增的意思 不总结对话 不评价上一条回复 但不能省略仍在解释当前异常所必需的原因主体 动作和影响 问题很窄时一句话就够"
    : "这是首次回答 直接说原因 结果和必要处理方式"
  const rejection = rejectionRequirement ? `上一次具体未通过项：${rejectionRequirement}。` : ""
  return `上一次 answer 未通过发送要求 由模型重新生成完整 answer：${style}；${rejection}${operatorStylePrompt(operatorStyleProfile)}。每句话都推进当前事情 不做情绪分析 服务复盘或规则解释 不照抄历史回复 不承诺系统做不到的转交和跟进 不暴露自动化身份。reason 保留实际证据 investigation 只记录实际执行并先脱敏 没有可信证据不得升级。`
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function upstreamLabels(context: string): string[] {
  const raw = context.match(/上游名称\s*[：:]\s*([^|\r\n]+)/u)?.[1]?.trim()
  if (!raw) {
    const excluded = new Set(["pending", "rejected", "success", "failed", "http", "json", "api", "url", "id"])
    const latinLabels = (context.match(/\b[A-Za-z][A-Za-z0-9_-]{2,31}\b/gu) ?? [])
      .filter((value) => !excluded.has(value.toLocaleLowerCase("en-US")))
      .slice(0, 8)
    return [...new Set([...latinLabels, "上游"])]
  }
  const short = raw.replace(/[-_\s]*(?:代付|代收)$/u, "").trim()
  return [...new Set([raw, short, "上游"].filter((value) => value.length > 0))]
}

function hasVerifiedMissingUpstreamCallbackRuntimeEvidence(decision: AnswerDecision): boolean {
  const sources = new Set<"database" | "runtime">()
  for (const step of decision.investigation.steps) {
    if (!["server", "log", "database"].includes(step.source)
      || !["confirmed", "not_found"].includes(step.status)) continue
    const text = `${step.title}\n${step.evidence}\n${step.conclusion}`
    if (!/(?:回调|最终结果|结果通知)/u.test(text)
      || !/(?:未收到|没收到|没有|未发送|没发送|无记录|未查到|没查到|为空|返回行数=0|\b0\s*(?:条|笔|行)\b)/u.test(text)) continue
    sources.add(step.source === "database" ? "database" : "runtime")
  }
  return sources.has("database") && sources.has("runtime")
}

export function answerExplicitlyClearsOurResponsibility(answer: string): boolean {
  return /(?:(?:不是|并非|不属于)(?:我们|我方)(?:这边|后台|系统|平台)?(?:的)?(?:问题|异常|故障|原因|导致|处理失败|处理异常)|(?:我们|我方)(?:这边|后台|系统|平台)?.{0,12}(?:没有|没|无|不存在)(?:任何)?.{0,8}(?:问题|异常|故障|错误)|(?:问题|原因|责任).{0,10}(?:在|属于|来自)(?:商户|ADPay|上游|通道|银行|第三方))/iu.test(answer)
}

export function hasVerifiedExternalCauseEvidence(decision: AnswerDecision): boolean {
  const investigationText = decision.investigation.steps
    .map((step) => `${step.title}\n${step.evidence}\n${step.conclusion}`)
    .join("\n")
  if (upstreamReturnedErrorEvidencePattern.test(investigationText)) return false
  const externalCause = /(?:商户|上游|通道|银行|第三方).{0,48}(?:未|没有|没|漏|缺少|为空|填错|传错|拒绝|返回失败|未发起|未下单|未提交)/u
  let codeConfirmed = false
  const runtimeSources = new Set<InvestigationStep["source"]>()
  for (const step of decision.investigation.steps) {
    const text = `${step.title}\n${step.evidence}\n${step.conclusion}`
    if (step.source === "code" && step.status === "confirmed") codeConfirmed = true
    if (["server", "log", "database", "redis"].includes(step.source)
      && ["confirmed", "not_found"].includes(step.status)
      && externalCause.test(text)) runtimeSources.add(step.source)
  }
  return codeConfirmed && runtimeSources.size >= 2
}

export function upstreamReturnedErrorInferenceNeedsQualification(
  question: string,
  conversationContext: string | undefined,
  decision: AnswerDecision,
): boolean {
  const source = `${conversationContext ?? ""}\n${question}\n${decision.reason}`
  if (!upstreamReturnedErrorEvidencePattern.test(source)) return false
  const conclusion = `${decision.reason}\n${decision.answer}`
  const concludesMissingCallback = /(?:(?:未|没|没有|漏)(?:发|发送|收到|接收|推送)?[^。；;\r\n]{0,10}(?:回调|最终结果|结果通知)|(?:回调|最终结果|结果通知)[^。；;\r\n]{0,10}(?:未|没|没有|漏))/u.test(conclusion)
  if (concludesMissingCallback && hasVerifiedMissingUpstreamCallbackRuntimeEvidence(decision)) return false
  if (hasVerifiedExternalCauseEvidence(decision)) return false
  return /(?:原因|根源|导致|因此|判断|推测|责任|是因为|说明|表示)/u.test(conclusion)
}

export function answerQualifiesUpstreamReturnedInference(answer: string): boolean {
  const namesReturnedMessage = /(?:上游|通道|ADPay).{0,16}(?:返回|响应|报错|错误信息).{0,20}(?:提示|显示|内容|为|:|：)/iu.test(answer)
  const statesInference = /(?:(?:根据|按|仅从|只从).{0,20}(?:上游|通道|ADPay).{0,16}(?:返回|响应|报错).{0,20}(?:初步判断|推测|暂时判断|来看)|(?:初步判断|推测|暂时判断).{0,24}(?:上游|通道|ADPay).{0,16}(?:返回|响应|报错)|(?:尚无|没有|无法).{0,12}(?:独立证据|其他证据).{0,12}(?:确认|证明))/iu.test(answer)
  return namesReturnedMessage && statesInference
}

function normalizedEvidenceText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim()
}

export function answerClaimGroundingReasons(
  question: string,
  latestMessage: string,
  conversationContext: string | undefined,
  decision: AnswerDecision,
): string[] {
  if (decision.decision === "ignore") return []
  // 旧持久记录和现有内部调用允许没有该字段；正式模型输出的 JSON Schema 始终要求提供。
  if (decision.answerClaims === undefined) return []
  const claims = decision.answerClaims
  if (claims.length === 0) return ["answer 缺少统一事实来源清单"]
  const answer = normalizedEvidenceText(decision.answer)
  const sourceCorpus = new Map<InvestigationStep["source"], string>()
  sourceCorpus.set("message", normalizedEvidenceText(`${conversationContext ?? ""}\n${question}\n${latestMessage}`))
  for (const step of decision.investigation.steps) {
    if (!["confirmed", "not_found"].includes(step.status)) continue
    const existing = sourceCorpus.get(step.source) ?? ""
    sourceCorpus.set(step.source, normalizedEvidenceText(`${existing}\n${step.title}\n${step.evidence}\n${step.conclusion}`))
  }
  const provenanceWording: Partial<Record<NonNullable<AnswerDecision["answerClaims"]>[number]["provenance"], RegExp>> = {
    user_report: /(?:聊天|对方|运营|用户|消息|提供|反馈|表示|称|转述|原文|记录中)/u,
    display: /(?:显示|页面|界面|后台|截图|画面|看到)/u,
    request: /(?:请求|提交|发送给|发给|传给)/u,
    response: /(?:响应|返回|答复|受理)/u,
    callback: /(?:回调|通知|推送)/u,
    runtime: /(?:记录|日志|数据库|服务器|核对|查到|未查到|实际)/u,
    code: /(?:代码|逻辑|流程|按设计|实现)/u,
    document: /(?:文档|接口定义|字段定义)/u,
    inference: /(?:初步|推测|可能|暂时|目前无法确认|还不能确认|无法确定)/u,
  }
  const compatibleSources: Record<NonNullable<AnswerDecision["answerClaims"]>[number]["provenance"], InvestigationStep["source"][]> = {
    user_report: ["message"],
    display: ["message"],
    request: ["message", "server", "log", "database"],
    response: ["message", "server", "log", "database"],
    callback: ["message", "server", "log", "database"],
    runtime: ["server", "log", "database", "redis"],
    code: ["code"],
    document: ["document"],
    inference: ["inference"],
    recommendation: ["inference"],
  }
  const reasons: string[] = []
  for (const claim of claims) {
    const statement = normalizedEvidenceText(claim.statement)
    const evidence = normalizedEvidenceText(claim.evidence)
    if (!statement || !answer.includes(statement)) {
      reasons.push("事实来源清单中的 statement 没有逐字出现在 answer")
      continue
    }
    if (!compatibleSources[claim.provenance].includes(claim.evidenceSource)) {
      reasons.push(`事实来源 ${claim.provenance} 与证据层 ${claim.evidenceSource} 不一致`)
    }
    const wording = provenanceWording[claim.provenance]
    if (wording && !wording.test(statement)) {
      reasons.push(`answer 没有按 ${claim.provenance} 的真实来源表述事实`)
    }
    if (claim.evidenceSource === "message"
      && ["display", "request", "response", "callback"].includes(claim.provenance)
      && wording && !wording.test(evidence)) {
      reasons.push(`消息证据摘录本身不属于 ${claim.provenance} 来源`)
    }
    if (claim.provenance !== "inference" && claim.provenance !== "recommendation") {
      const corpus = sourceCorpus.get(claim.evidenceSource) ?? ""
      if (!evidence || !corpus.includes(evidence)) reasons.push(`事实来源 ${claim.provenance} 的证据摘录未在可信 ${claim.evidenceSource} 记录中出现`)
    }
  }
  const clauses = decision.answer.split(/[\n。！？；]+/u).map(normalizedEvidenceText).filter((value) => value.length >= 4)
  if (clauses.some((clause) => !claims.some((claim) => normalizedEvidenceText(claim.statement).includes(clause)))) {
    reasons.push("answer 仍有句子没有登记事实来源或建议来源")
  }
  return [...new Set(reasons)].slice(0, 4)
}

export function upstreamBalanceErrorMisattributesResponsibility(
  question: string,
  conversationContext: string | undefined,
  answer: string,
): boolean {
  const source = `${conversationContext ?? ""}\n${question}`
  if (!/(?:上游|通道|ADPay)[\s\S]{0,120}(?:返回|响应|报错|错误信息)[\s\S]{0,120}余额不足/u.test(source)) return false
  const identifiesOurUpstreamAccount = /(?:我方|我们|运营)(?:在|的)?.{0,12}(?:上游|通道|ADPay).{0,12}(?:账户|账号|可用)?余额不足|(?:上游|通道|ADPay).{0,12}(?:我方|我们|运营).{0,12}(?:账户|账号|可用)?余额不足/u.test(answer)
  const wronglyClearsUs = answerExplicitlyClearsOurResponsibility(answer)
  const blamesUpstreamBalance = /(?:上游|通道|ADPay)(?:自身|这边|方)(?:的)?(?:账户|账号|可用)?余额不足/u.test(answer)
  return !identifiesOurUpstreamAccount || wronglyClearsUs || blamesUpstreamBalance
}

function latestMessageRequestsDerivedStatistics(latestMessage: string): boolean {
  return /(?:统计|计算|算(?:一下|下)?|占比|比例|发生率|百分比|概率|几率|频率)|(?:多少(?:笔|单|次)?|几(?:笔|单|次)|多大|多高).{0,12}(?:笔|单|次|占比|比例|发生率|百分比|概率|几率|频率)?|(?:占比|比例|发生率|百分比|概率|几率|频率).{0,12}(?:多少|几(?:笔|单|次)|多大|多高)/u.test(latestMessage)
}

export function answerIntroducesUnrequestedDerivedStatistics(latestMessage: string, answer: string): boolean {
  if (latestMessageRequestsDerivedStatistics(latestMessage)) return false
  return /(?:\d+(?:\.\d+)?\s*%|百分之\s*\d|(?:占比|比例|发生率|概率|几率|频率).{0,12}\d|\d+\s*(?:笔|单|次)\s*[/／]\s*\d+\s*(?:笔|单|次)|按.{0,30}(?:计算|统计).{0,30}\d+(?:\.\d+)?\s*%)/u.test(answer)
}

export function upstreamCallbackValidationReason(
  question: string,
  latestMessage: string,
  decision: AnswerDecision,
): string | null {
  const answer = decision.answer
  if (callbackLaterArrivedPattern.test(latestMessage)) return null
  const latestExplicitlyShowsMissingCallback = upstreamCallbackMissingEvidencePattern.test(latestMessage)
    && upstreamPendingEvidencePattern.test(latestMessage)
  const runtimeVerified = hasVerifiedMissingUpstreamCallbackRuntimeEvidence(decision)
  if (!latestExplicitlyShowsMissingCallback && !runtimeVerified) return null

  const evidenceContext = `${latestMessage}\n${question}`
  const baseReason = runtimeVerified
    ? "本轮服务器和数据库证据交叉确认上游尚未发送最终结果 回复必须直接写明上游名称或上游没有发送回调及其造成的订单状态 并明确说不是我方问题"
    : "本轮最新消息明确显示上游尚未发送最终结果 回复必须直接写明上游名称或上游没有发送回调及其造成的订单状态"

  const omissionVerbs = "(?:发送|推送|回调|通知|返回|给出|提供|同步)"
  const missingWords = "(?:还没有|还没|尚未|没有|没|未)"
  const actorGap = "[^，,。；;！？!?\\r\\n]{0,12}"
  let causeAt = -1
  for (const label of upstreamLabels(`${evidenceContext}\n${answer}`)) {
    const actor = escapeRegularExpression(label)
    const matched = new RegExp(`${actor}${actorGap}${missingWords}.{0,10}${omissionVerbs}|${actor}${actorGap}${missingWords}.{0,12}(?:最终结果|结果通知)`, "iu").exec(answer)
    if (matched?.index !== undefined && (causeAt < 0 || matched.index < causeAt)) causeAt = matched.index
  }
  if (causeAt < 0) return `${baseReason} 不能使用没收到结果或需要核对等无主体被动句`

  const relevantTail = answer.slice(causeAt, causeAt + 120)
  const statesImpact = /(?:订单|后台|状态|这批|这些).{0,24}(?:打款中|待结果|待支付|未更新|没更新|无法更新|保持|停在|卡在)|(?:仍|还|一直|继续|保持).{0,8}(?:打款中|待结果|待支付)/u.test(relevantTail)
  if (!statesImpact) return `${baseReason} 当前回答没有说明对我方订单状态的影响`
  if (runtimeVerified && !answerExplicitlyClearsOurResponsibility(answer)) {
    return `${baseReason} 当前回答没有明确排除我方处理异常`
  }
  return null
}

function repeatedIncidentWasIgnored(
  question: string,
  latestMessage: string,
  conversationContext: string | undefined,
  decision: AnswerDecision,
): boolean {
  if (decision.decision !== "ignore" || !repeatedIncidentConcernPattern.test(latestMessage)) return false
  return operationalIncidentContextPattern.test(`${conversationContext ?? ""}\n${question}`)
}

const directInterfaceQuestionPattern = /(?:接口|api)\s*文档|文档.{0,8}(?:接口|参数|字段|签名|路径|地址)|(?:正确|具体|实际|真正).{0,8}(?:接口|路径|地址)|(?:接口|路径|地址|endpoint).{0,10}(?:是什么|是多少|哪个|发一下|发下|给下|怎么填|怎么传|在哪|有吗)|(?:请求参数|返回参数|响应字段|签名规则|字段).{0,10}(?:是什么|有哪些|怎么填|怎么传|格式|要求)|(?:transactionType|bankCode|IFSC|UTR|sign).{0,8}(?:是什么|怎么填|怎么传|格式|规则|要求)/iu
const contextualInterfaceFollowupPattern = /^\s*(?:这个|它)?(?:怎么填|怎么传|是什么|发一下|发下|给下)[？?]?\s*$/u
const magicBookQuestionPattern = /(?:MagicBook|银行(?:名称|编码|代码)|bankCode|transactionType|交易类型|代收|代付|地区|国家|币种|currency|IFSC|UTR|通道|上游)/iu
const interfaceContextPattern = /(?:接口|路径|地址|endpoint|请求参数|返回参数|响应字段|签名|transactionType|bankCode|IFSC|UTR)/iu
const orderQuestionPattern = /(?:订单|訂單|下单|下單|进单|進單|代收|代付)|\b[A-Z]{2,8}\d{6,}\b/iu
const merchantOrderInvestigationPattern = /(?:商户|商戶).{0,16}(?:后台|後台|提交|下单|下單|请求|請求|回调|回調|地址|IP|响应|響應|返回)|(?:提交|下单|下單|请求|請求|来源|來源|出口|发送代付地址|發送代付地址).{0,12}(?:地址|IP|参数|參數)|(?:来源|來源|出口)\s*IP|(?:商户|商戶)(?:回调|回調)/iu
const upstreamOrderInvestigationPattern = /(?:上游|通道|金流|channel).{0,20}(?:收到|下单|下單|请求|請求|回调|回調|地址|参数|參數|响应|響應|返回|状态|狀態)|(?:发给|發給|发送|發送).{0,10}(?:上游|通道|金流)/iu
const serverResourceMetric = "(?:CPU|内存|記憶體|负载|負載|磁盘|磁碟|网络|網路|带宽|帶寬|流量|网卡|網卡)"
const serverResourceQuestionPatterns = [
  new RegExp(`(?:服务器|服務器|主机|主機).{0,16}${serverResourceMetric}|${serverResourceMetric}.{0,16}(?:服务器|服務器|主机|主機)`, "iu"),
  new RegExp(`(?:查(?:下|一下)?|看(?:下|一下)?|查看|检查|檢查|帮忙看|幫忙看).{0,8}${serverResourceMetric}`, "iu"),
  new RegExp(`${serverResourceMetric}.{0,8}(?:查(?:下|一下)?|看(?:下|一下)?|查看|检查|檢查|占用|使用率|速率|速度|情况|情況|怎么样|怎麼樣|如何|是否正常|卡顿|卡頓)`, "iu"),
  /(?:服务|服務|服务器|服務器|主机|主機).{0,10}(?:状态|狀態|资源|資源|性能|是否正常|怎么样|怎麼樣|如何|卡顿|卡頓)/iu,
]
const orderMainRecordPattern = /(?:订单|訂單)(?:主记录|主記錄|主表|记录|記錄|信息|資料)|(?:代收|代付)(?:订单|訂單)(?:表|记录|記錄|信息|資料)/iu
const orderIdentifierFields = new Set([
  "xtddh", "shddh", "ddh", "order_id", "order_no", "orderid", "orderno",
  "merchant_order_id", "merchant_order_no", "merchantorderid", "merchantorderno",
  "platform_order_id", "platform_order_no", "platformorderid", "platformorderno",
  "trade_no", "tradeno", "out_trade_no", "outtradeno", "mch_order_id", "mch_order_no", "mchorderid", "mchorderno",
  "channel_order_id", "channel_order_no", "channelorderid", "channelorderno",
  "upstream_order_id", "upstream_order_no", "upstreamorderid", "upstreamorderno",
])
const logOrderPayloadFields = new Set([
  "content", "request", "request_body", "request_params", "requestbody", "requestparams",
  "response", "response_body", "responsebody", "params", "payload", "message", "remark",
  "request_content", "response_content", "requestcontent", "responsecontent",
  "req_data", "res_data", "reqdata", "resdata", "callback_content", "callback_data", "callbackcontent", "callbackdata",
])
type OrderDatabaseQueryKind = "order_main" | "sys_log" | "channel_log" | "generic"
const systemResourceMetricKeys = new Set([
  "cpu_usage_percent", "loadavg_1m", "loadavg_5m", "loadavg_15m",
  "memory_total_kb", "memory_available_kb", "disk_total_kb", "disk_available_kb", "disk_used_percent",
  "network_rx_bytes_per_second", "network_tx_bytes_per_second", "network_sample_seconds",
])

function garbled(value: string): boolean {
  return value.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)
}

function validSystemResourcesOutput(output: string): boolean {
  const values = new Map<string, number>()
  for (const line of output.trim().split(/\r?\n/gu)) {
    const matched = line.match(/^([a-z0-9_]+)=(-?\d+(?:\.\d+)?)$/u)
    if (!matched?.[1] || !matched[2] || !systemResourceMetricKeys.has(matched[1]) || values.has(matched[1])) return false
    const value = Number(matched[2])
    if (!Number.isFinite(value) || value < 0) return false
    values.set(matched[1], value)
  }
  if (values.size !== systemResourceMetricKeys.size) return false
  const cpu = values.get("cpu_usage_percent")!
  const diskUsed = values.get("disk_used_percent")!
  const memoryTotal = values.get("memory_total_kb")!
  const memoryAvailable = values.get("memory_available_kb")!
  const diskTotal = values.get("disk_total_kb")!
  const diskAvailable = values.get("disk_available_kb")!
  const networkSampleSeconds = values.get("network_sample_seconds")!
  return cpu <= 100 && diskUsed <= 100 && memoryTotal > 0 && memoryAvailable <= memoryTotal
    && diskTotal > 0 && diskAvailable <= diskTotal && networkSampleSeconds >= 0.05 && networkSampleSeconds <= 10
}

function messageSegmentNeedsSystemResources(value: string): boolean {
  const hasExplicitServerContext = /(?:服务器|服務器|主机|主機)/iu.test(value)
  const resourceCandidate = hasExplicitServerContext
    ? value
    : value.replace(/(?:内存卡|記憶體卡|流量卡|流量咭|网络订单|網路訂單)/giu, " ")
  return serverResourceQuestionPatterns.some((pattern) => pattern.test(resourceCandidate))
}

export function questionNeedsSystemResources(value: string): boolean {
  return value.split(/\r?\n+/u).some((segment) => messageSegmentNeedsSystemResources(segment))
}

export function questionNeedsInterfaceDocumentation(latestMessage: string, question = latestMessage): boolean {
  return directInterfaceQuestionPattern.test(latestMessage)
    || (contextualInterfaceFollowupPattern.test(latestMessage) && interfaceContextPattern.test(question))
}

export function questionNeedsMagicBookKnowledge(latestMessage: string, question = latestMessage): boolean {
  return magicBookQuestionPattern.test(`${latestMessage}\n${question}`)
}

export function questionRequestsFeatureChange(value: string): boolean {
  const focus = value.trim().slice(-500)
  const hasActionAndObject = featureChangeActionPattern.test(focus) && featureObjectPattern.test(focus)
  const explicitChange = /(?:加(?:个|一个)?|新增|增加|添加|修改|改成|调整|优化|开发|补充|开放)/u.test(focus)
  const explicitlyUnsupported = /(?:没有|暂无|不支持|做不到|不能做).{0,24}(?:功能|能力|页面|接口|字段|展示|流程|按钮|菜单|筛选|导出|通知|回调|权限|开关|批量|自动)/u.test(focus)
  return (capabilityRequestPattern.test(focus) && hasActionAndObject)
    || (explicitChange && featureObjectPattern.test(focus))
    || explicitlyUnsupported
}

function orderIdentifiers(question: string): string[] {
  const values = new Set<string>()
  for (const match of question.matchAll(/\b[A-Z]{2,8}\d{8,}\b/giu)) values.add(match[0])
  for (const match of question.matchAll(/(?:系统|系統|商户|商戶)?(?:订单号|訂單號)\s*[:：]?\s*([A-Z0-9-]{6,64})/giu)) {
    if (match[1]) values.add(match[1])
  }
  for (const match of question.matchAll(/\b\d{10,24}\b/gu)) values.add(match[0])
  return [...values]
}

function sqlTableNames(sql: string): Set<string> {
  const withoutStrings = sql.replace(/'(?:''|\\.|[^'])*'/gu, "''").replace(/"(?:""|\\.|[^"])*"/gu, '""')
  const names = new Set<string>()
  const tableReference = /\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*))?)/giu
  for (const match of withoutStrings.matchAll(tableReference)) {
    const name = match[1]?.split(".").at(-1)?.trim().replace(/^`|`$/gu, "").toLocaleLowerCase("en-US")
    if (name) names.add(name)
  }
  return names
}

export function classifyOrderDatabaseQuery(sql: string): OrderDatabaseQueryKind {
  const tables = sqlTableNames(sql)
  if (tables.has("sys_log")) return "sys_log"
  if (["channel_log", "sfzf_channel_log", "channel_log_history", "sfzf_channel_log_history"].some((table) => tables.has(table))) {
    return "channel_log"
  }
  if (["sfzf_dfddb", "sfzf_dsddb"].some((table) => tables.has(table))) return "order_main"
  return "generic"
}

function trimOuterParentheses(input: string): string {
  let value = input.trim()
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0
    let quote = false
    let enclosesWholeValue = true
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!
      if (character === "'" && value[index - 1] !== "\\") quote = !quote
      if (quote) continue
      if (character === "(") depth += 1
      if (character === ")") depth -= 1
      if (depth === 0 && index < value.length - 1) {
        enclosesWholeValue = false
        break
      }
    }
    if (!enclosesWholeValue || depth !== 0 || quote) break
    value = value.slice(1, -1).trim()
  }
  return value
}

function splitOrderPredicateBranches(input: string): string[] | null {
  const value = trimOuterParentheses(input)
  let depth = 0
  let quote = false
  let start = 0
  const branches: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === "'" && value[index - 1] !== "\\") {
      quote = !quote
      continue
    }
    if (quote) continue
    if (character === "(") depth += 1
    else if (character === ")") {
      depth -= 1
      if (depth < 0) return null
    } else if (depth === 0 && value.slice(index).match(/^OR\b/iu) && (index === 0 || /\s/u.test(value[index - 1]!))) {
      const branch = value.slice(start, index).trim()
      if (!branch) return null
      const nested = splitOrderPredicateBranches(branch)
      if (!nested) return null
      branches.push(...nested)
      index += 1
      start = index + 1
    }
  }
  if (quote || depth !== 0) return null
  const tail = value.slice(start).trim()
  if (!tail) return null
  if (branches.length === 0) return [value]
  const nestedTail = splitOrderPredicateBranches(tail)
  return nestedTail ? [...branches, ...nestedTail] : null
}

function orderLiteral(input: string): string | null {
  const value = input.trim()
  const quoted = value.match(/^'([A-Za-z0-9-]{6,64})'$/u)
  if (quoted?.[1]) return quoted[1]
  return /^\d{6,24}$/u.test(value) ? value : null
}

export function hasStrictOrderPredicate(sql: string, identifiers: string[], kind: OrderDatabaseQueryKind): boolean {
  if (kind === "generic" || identifiers.length === 0 || /\bJOIN\b/iu.test(sql) || sqlTableNames(sql).size !== 1) return false
  const condition = sql.match(/\bWHERE\b([\s\S]*?)(?=\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|PROCEDURE)\b|$)/iu)?.[1]?.trim()
  if (!condition) return false
  const conditionWithoutStrings = condition.replace(/'(?:''|\\.|[^'])*'/gu, "''")
  if (/\bAND\b/iu.test(conditionWithoutStrings)) return false
  const branches = splitOrderPredicateBranches(condition)
  if (!branches || branches.length === 0) return false
  const expected = new Set(identifiers.map((identifier) => identifier.toLocaleUpperCase("en-US")))
  return branches.every((rawBranch) => {
    const branch = trimOuterParentheses(rawBranch)
    const matched = branch.match(/^(?:(?:`?[A-Za-z_$][A-Za-z0-9_$-]*`?)\s*\.\s*)?(`?[A-Za-z_$][A-Za-z0-9_$-]*`?)\s*(=|IN|LIKE)\s*([\s\S]+)$/iu)
    if (!matched?.[1] || !matched[2] || !matched[3]) return false
    const field = matched[1].replace(/^`|`$/gu, "").toLocaleLowerCase("en-US")
    const operator = matched[2].toLocaleUpperCase("en-US")
    const operand = matched[3].trim()
    if (operator === "=") {
      const value = orderLiteral(operand)
      return orderIdentifierFields.has(field) && Boolean(value && expected.has(value.toLocaleUpperCase("en-US")))
    }
    if (operator === "IN") {
      if (!orderIdentifierFields.has(field) || !operand.startsWith("(") || !operand.endsWith(")")) return false
      const values = operand.slice(1, -1).split(",").map(orderLiteral)
      return values.length > 0 && values.every((value) => Boolean(value && expected.has(value.toLocaleUpperCase("en-US"))))
    }
    if (kind === "order_main" || (!orderIdentifierFields.has(field) && !logOrderPayloadFields.has(field))) return false
    const like = operand.match(/^'(%?)([A-Za-z0-9-]{6,64})(%?)'$/u)
    return Boolean(like?.[2] && expected.has(like[2].toLocaleUpperCase("en-US")))
  })
}

function completedEvidenceStep(
  decision: AnswerDecision,
  source: InvestigationStep["source"] | Array<InvestigationStep["source"]>,
  pattern: RegExp,
  identifiers: string[] = [],
): boolean {
  const sources = new Set(Array.isArray(source) ? source : [source])
  return decision.investigation.steps.some((step) => {
    if (!sources.has(step.source) || !["confirmed", "not_found"].includes(step.status)) return false
    const evidence = `${step.title}\n${step.evidence}\n${step.conclusion}`
    return pattern.test(evidence) && (identifiers.length === 0 || identifiers.some((id) => evidence.includes(id)))
  })
}

export function missingRequiredInvestigationEvidence(
  question: string,
  latestMessage: string,
  decision: AnswerDecision,
): string | null {
  if (questionNeedsInterfaceDocumentation(latestMessage, question)) return null
  const focus = (latestMessage.trim() || question).slice(-400)
  const identifiers = orderIdentifiers(question)
  if (identifiers.length > 0 && orderQuestionPattern.test(question)) {
    if (!completedEvidenceStep(decision, "database", orderMainRecordPattern, identifiers)) {
      return `先按订单号 ${identifiers[0]} 查询当前服务订单主记录并把真实结果写入 database 步骤`
    }
    if (merchantOrderInvestigationPattern.test(focus)
      && !completedEvidenceStep(decision, ["database", "log"], /\bsys_log\b/iu, identifiers)) {
      return `这是商户侧订单问题 必须按订单号 ${identifiers[0]} 查询 sys_log 的请求地址 来源IP 请求参数 平台响应和商户回调证据`
    }
    if (upstreamOrderInvestigationPattern.test(focus)
      && !completedEvidenceStep(decision, ["database", "log"], /\bchannel_log\b/iu, identifiers)) {
      return `这是上游侧订单问题 必须按订单号 ${identifiers[0]} 查询 channel_log 的上游请求 响应和回调证据`
    }
  }
  const resourceFocus = questionNeedsSystemResources(focus) ? focus : question
  if (!questionNeedsSystemResources(resourceFocus)) return null
  const requestedMetrics: Array<[RegExp, RegExp, string]> = [
    [/(?:内存|記憶體|memory)/iu, /(?:内存|記憶體|memory|MemTotal|MemAvailable)/iu, "内存"],
    [/(?:网络|網路|带宽|帶寬|流量|网卡|網卡)/iu, /(?:网络|網路|带宽|帶寬|流量|网卡|網卡|RX|TX|receive|transmit)/iu, "网络"],
    [/(?:CPU|负载|負載|load)/iu, /(?:CPU|负载|負載|load)/iu, "CPU和负载"],
    [/(?:磁盘|磁碟|disk)/iu, /(?:磁盘|磁碟|disk|filesystem)/iu, "磁盘"],
  ]
  let matchedSpecificMetric = false
  for (const [questionPattern, evidencePattern, label] of requestedMetrics) {
    if (!questionPattern.test(resourceFocus)) continue
    matchedSpecificMetric = true
    if (!decision.investigation.steps.some((step) => (
      step.source === "server" && step.status === "confirmed"
      && evidencePattern.test(`${step.title}\n${step.evidence}\n${step.conclusion}`)
    ))) return `必须先 SSH 到当前绑定服务器取得实时${label}数据并写入 confirmed 的 server 步骤`
  }
  if (!matchedSpecificMetric && !decision.investigation.steps.some((step) => (
    step.source === "server" && step.status === "confirmed"
    && /(?:采样绑定服务器实时资源|cpu_usage_percent|memory_total_kb|network_sample_seconds)/iu.test(`${step.title}\n${step.evidence}\n${step.conclusion}`)
  ))) return "必须先 SSH 到当前绑定服务器取得实时服务状态并写入 confirmed 的 server 步骤"
  return null
}

export function operatorAnswerNeedsTechnicalOnly(value: string): boolean {
  const withoutExternalNegation = value.replace(explicitExternalNegationPattern, "")
  if (/(?:交给|发给|转给|让|找|需要|得让|要)(?:技术|开发|研发|后端|工程师|程序员|同事)(?:来|去|再)?(?:处理|排查|确认|看|介入|跟进)/u.test(withoutExternalNegation)) return true
  return forbiddenOperatorEscalationPattern.test(withoutExternalNegation)
}

export function escalationAnswerIsConcrete(value: string): boolean {
  const answer = value.trim()
  const factualAnswer = answer
    .replace(/(?:(?:我(?:这边)?|这边)?(?:已经|已)?(?:通知|转给|同步给|反馈给).{0,12}(?:技术|开发|研发)(?:同事)?(?:了|跟进|处理)?|(?:技术|开发|研发)(?:同事)?.{0,10}(?:已经|已)(?:收到|同步|跟进|处理))/gu, "")
    .trim()
  if (!factualAnswer || operatorAnswerNeedsTechnicalOnly(factualAnswer)) return false
  if (/^(?:服务|数据|代码|系统|程序|后台)?(?:有问题|异常|错误|故障)$/u.test(factualAnswer)) return false
  const relation = factualAnswer.match(/(?:缺失|缺少|没配(?:上)?|未配|未配置|没启用|未启用|不匹配|为空|未写入|未生成|未同步|未运行|已停止|(?:字段|参数|记录|映射|配置|判断|逻辑).{0,16}(?:空|缺|错|反|漏|没有|不一致|未生效))/u)
  if (!relation || relation.index === undefined) return false
  const subject = factualAnswer.slice(0, relation.index)
    .replace(/(?:已确认|确认是|内部|当前|这个|的)/gu, "")
    .trim()
  return Boolean(subject && !/^(?:服务|数据|代码|系统|程序|后台|订单|银行|通道|字段|配置|映射|订单字段|银行映射|通道配置)$/u.test(subject))
}

export function operatorAnswerIsTooTechnical(answer: string, latestMessage: string): boolean {
  return !operatorQuestionWantsTechnicalDetail(latestMessage) && operatorJargonPattern.test(answer)
}

export function operatorAnswerIsReportLike(answer: string): boolean {
  return operatorReportPattern.test(answer)
}

export function operatorAnswerIsEmptyAcknowledgement(answer: string): boolean {
  return operatorAnswerStartsWithMechanicalAcknowledgement(answer)
}

export function auditableActionAnswerIsComplete(decision: AnswerDecision): boolean {
  if (!auditableActionClaimPattern.test(decision.answer)) return true
  const knownActors = (decision.answer.match(answerKnownActorPattern)?.[1] ?? "")
    .split(/[、,，/]|(?:和|及)/u)
    .map((actor) => actor.trim().replace(/^@/u, ""))
    .filter(Boolean)
  const unknownActor = answerUnknownActorPattern.test(decision.answer)
  if (knownActors.length === 0 && !unknownActor) return false
  return decision.investigation.steps.some((step) => {
    if (!["database", "log"].includes(step.source) || !["confirmed", "not_found"].includes(step.status)) return false
    const trusted = (step.source === "database" && step.title === "父进程复核数据库只读查询"
      && /^父进程经绑定服务器重新执行 只读SQL=/u.test(step.evidence))
      || (step.source === "log" && step.title === "执行限量日志检查"
        && /^实际命令=/u.test(step.evidence))
    const evidence = `${step.evidence}\n${step.conclusion}`
    if (!trusted || !auditableActionEvidencePattern.test(evidence) || !actionActorEvidencePattern.test(evidence)) return false
    if (knownActors.length > 0) {
      const normalizedEvidence = evidence.toLocaleLowerCase("zh-CN")
      return knownActors.every((actor) => normalizedEvidence.includes(actor.toLocaleLowerCase("zh-CN")))
    }
    return step.status === "not_found"
      || /(?:操作人|操作账号|操作用户|执行人|经办人|operator(?:_?(?:id|name|user))?|actor(?:_?(?:id|name|user))?|user_?name|username|user_?id|admin(?:_?(?:id|name|user))?|created?_?by|updated?_?by|create_?user|update_?user)\s*["']?\s*[:=]\s*(?:null|["']{2}|unknown)/iu.test(evidence)
  })
}

export function operatorAnswerDisclosesAutomationIdentity(answer: string): boolean {
  return automationIdentityDisclosurePattern.test(answer)
}

function interactionStrategyIsInvalid(decision: AnswerDecision): boolean {
  const interaction = decision.interaction
  if (!interaction) return false
  const needsRepair = interaction.sentiment === "frustrated" || interaction.sentiment === "hostile"
    || interaction.situation === "complaint" || interaction.situation === "identity_challenge"
  if (needsRepair) {
    return decision.decision === "ignore"
      || !["service_recovery", "boundary_with_next_step"].includes(interaction.responseStrategy)
  }
  if (interaction.situation === "scope_boundary") {
    return decision.decision === "ignore" || interaction.responseStrategy !== "boundary_with_next_step"
  }
  if (decision.decision === "ignore") return interaction.responseStrategy !== "ignore"
  return interaction.responseStrategy === "ignore"
}

function wordingCharacters(value: string): string[] {
  return [...value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]/gu, "")]
}

function wordingSimilarity(left: string, right: string): number {
  const pairs = (value: string): Map<string, number> => {
    const characters = wordingCharacters(value)
    const result = new Map<string, number>()
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const pair = `${characters[index]}${characters[index + 1]}`
      result.set(pair, (result.get(pair) ?? 0) + 1)
    }
    return result
  }
  const leftPairs = pairs(left)
  const rightPairs = pairs(right)
  const leftSize = [...leftPairs.values()].reduce((sum, count) => sum + count, 0)
  const rightSize = [...rightPairs.values()].reduce((sum, count) => sum + count, 0)
  if (leftSize === 0 || rightSize === 0) return 0
  const shared = [...leftPairs].reduce((sum, [pair, count]) => (
    sum + Math.min(count, rightPairs.get(pair) ?? 0)
  ), 0)
  return (2 * shared) / (leftSize + rightSize)
}

function answerCopiesHistoricalWording(
  answer: string,
  memories: MemoryView[],
  conversationContext?: string,
): boolean {
  const candidates = memories.flatMap((memory) => {
    if (memory.source !== "correction") return []
    const marker = "\n参考回复："
    const at = memory.content.indexOf(marker)
    return at >= 0 ? [memory.content.slice(at + marker.length).trim()] : []
  })
  const contextPattern = /\[客服 [^\]]+\]\n([\s\S]*?)(?=\n\n\[(?:运营|客服) |$)/gu
  for (const matched of conversationContext?.matchAll(contextPattern) ?? []) {
    if (matched[1]?.trim()) candidates.push(matched[1].trim())
  }
  return candidates.some((candidate) => (
    wordingCharacters(candidate).length >= 8 && wordingSimilarity(answer, candidate) >= 0.72
  ))
}

export function hasVerifiedCodeDefect(decision: AnswerDecision, snapshot: ProjectCodeSnapshot): boolean {
  if (decision.decision !== "escalate" || snapshot.syncState !== "fresh") return false
  const matched = decision.reason.match(verifiedCodeDefectPattern)
  if (!matched?.[1] || !matched[2] || !matched[3]) return false
  const repository = snapshot.repositories.find((item) => item.name === matched[1])
  if (!repository) return false
  const root = path.resolve(repository.snapshotPath)
  const candidate = path.resolve(root, matched[2])
  const relative = path.relative(root, candidate)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  const line = Number(matched[3])
  if (!Number.isInteger(line) || line < 1) return false
  try {
    if (!statSync(candidate).isFile()) return false
    return line <= readFileSync(candidate, "utf8").split(/\r?\n/u).length
  } catch {
    return false
  }
}

export function hasVerifiedTechnicalEscalation(
  decision: AnswerDecision,
  snapshot: ProjectCodeSnapshot,
  question = "",
): boolean {
  if (decision.decision !== "escalate") return false
  if (decision.escalationType === "feature_request") {
    if (!verifiedFeatureRequestPattern.test(decision.reason)
      || !featureRequestAnswerConfirmsDeployment(decision.answer)) return false
    return decision.investigation.steps.some((step) => (
      step.source === "message" && step.status === "confirmed" && step.evidence.trim().length > 0
    ))
  }
  if (decision.escalationType === "human_operation") {
    if (!verifiedHumanOperationPattern.test(decision.reason)
      || !decision.humanOperation
      || !humanOperationAnswerConfirmsNotification(decision.answer)
      || humanOperationAnswerClaimsCompletion(decision.answer)) return false
    const normalize = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
    const source = normalize(question)
    const action = normalize(decision.humanOperation.action)
    const genericIdentifiers = new Set([
      "用户", "账号", "运营账号", "商户", "客户", "会员", "这个", "那个", "一下", "一个",
      "新的", "刚才", "之前", "怎么", "如何", "帮忙", "处理", "创建", "解冻", "重置",
      "运营", "名称", "名字", "编号", "id", "标识", "用户名", "账号名", "用户id", "账号id",
    ])
    if (!action || !source.includes(action)) return false
    const identifiers = decision.humanOperation.identifiers.map(normalize)
    if (new Set(identifiers).size !== identifiers.length) return false
    const sourceWithoutAction = source.split(action).join(" ")
    return identifiers.every((identifier) => {
      if (!identifier
        || genericIdentifiers.has(identifier)
        || action.includes(identifier)
        || !sourceWithoutAction.includes(identifier)) return false
      return [...identifier].length >= 2 || /^\d+$/u.test(identifier)
    })
  }
  if (decision.escalationType === "code_defect") return hasVerifiedCodeDefect(decision, snapshot)
  if (decision.escalationType !== "technical_change") return false
  if (snapshot.syncState !== "fresh") return false
  const matched = decision.reason.match(verifiedTechnicalChangePattern)
  const changeType = matched?.[1] as TechnicalChangeType | undefined
  if (!changeType) return false
  const categoryPattern = technicalChangeEvidencePatterns[changeType]
  const commandOutput = (evidence: string): string | null => {
    const matchedOutput = evidence.match(/^实际命令=[^\n]+\n退出码=0\n输出=([\s\S]+)$/u)
    return matchedOutput?.[1]?.trim() || null
  }
  const codeSteps = decision.investigation.steps.flatMap((step) => {
    if (step.source !== "code" || step.status !== "confirmed" || step.title !== "执行代码只读检查") return []
    const output = commandOutput(step.evidence)
    if (!output
      || !/\.(?:java|kt|ts|tsx|js|jsx|vue|xml|sql|go|py|php|rb|rs|cs|ya?ml|properties|sh)(?::\d+|\b)/iu.test(output)
      || !categoryPattern.test(output)) return []
    return [output]
  })
  const runtimeSteps = decision.investigation.steps.flatMap((step) => {
    if (step.status !== "confirmed") return []
    const content = step.source === "database" ? step.evidence : commandOutput(step.evidence)
    if (!content || !categoryPattern.test(content)) return []
    const trusted = (
      (step.source === "server" && step.title === "执行服务器只读检查" && /^实际命令=/u.test(step.evidence))
      || (step.source === "log" && step.title === "执行限量日志检查" && /^实际命令=/u.test(step.evidence))
      || (step.source === "database" && step.title === "父进程复核数据库只读查询"
        && /^父进程经绑定服务器重新执行 只读SQL=/u.test(step.evidence))
      || (step.source === "redis" && step.title === "执行 Redis 只读检查" && /^实际命令=/u.test(step.evidence))
    )
    if (!trusted) return []
    const claim = `${decision.reason}\n${decision.answer}`
    const supported = changeType === "服务操作"
      ? /(?:未运行|已停止|重启|恢复)/u.test(claim) && /(?:inactive|dead|failed|stopped|未运行|已停止)/iu.test(content)
      : /(?:没启用|未启用|未生效)/u.test(claim)
        ? /["']?(?:enabled|active)["']?\s*[:=]\s*(?:0|false|null)/iu.test(content)
        : /(?:缺失|缺少|没配|未配|未配置|为空|未写入|未生成|没有)/u.test(claim)
          ? /["']?(?:[A-Za-z0-9_]*(?:exists|count)|value)["']?\s*[:=]\s*(?:0|false|null|["']{2})/iu.test(content)
          : /(?:不匹配|不一致)/u.test(claim)
            && /["']?(?:matches|matched|consistent)["']?\s*[:=]\s*(?:0|false)/iu.test(content)
    return supported ? [content] : []
  })
  const identifiers = (value: string): Set<string> => new Set(
    (value.match(/[A-Za-z_][A-Za-z0-9_.-]{3,}/gu) ?? [])
      .map((item) => item.toLocaleLowerCase("en-US"))
      .filter((item) => !evidenceIdentifierStopwords.has(item) && !/^\d/u.test(item)),
  )
  const declaredIdentifiers = identifiers(`${decision.reason}\n${decision.answer}`)
  return codeSteps.some((codeEvidence) => {
    const codeIdentifiers = identifiers(codeEvidence)
    return runtimeSteps.some((runtimeEvidence) => [...identifiers(runtimeEvidence)].some(
      (id) => codeIdentifiers.has(id) && declaredIdentifiers.has(id),
    ))
  })
}

export function hasVerifiedServiceHandoff(
  decision: AnswerDecision,
  currentService: string,
  projectServices: Array<{ key: string; name: string }>,
  question: string,
  responseDepth: ResponseDepth,
): boolean {
  if (decision.decision !== "escalate" || decision.escalationType !== "service_handoff") return false
  if (responseDepth !== "followup" || !serviceHandoffInsistencePattern.test(question)) return false
  const targetLabel = decision.reason.match(verifiedServiceHandoffPattern)?.[1]?.trim()
  if (!targetLabel) return false
  const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
  const current = normalize(currentService)
  const target = projectServices.find((service) => {
    const key = normalize(service.key)
    const name = normalize(service.name)
    return key !== current && name !== current && (normalize(targetLabel) === key || normalize(targetLabel) === name)
  })
  if (!target) return false
  const normalizedQuestion = normalize(question)
  if (![target.key, target.name].some((value) => normalizedQuestion.includes(normalize(value)))) return false
  const interaction = decision.interaction
  const handoffContext = interaction && (
    interaction.sentiment === "frustrated" || interaction.sentiment === "hostile"
    || interaction.situation === "complaint" || interaction.situation === "identity_challenge"
    || interaction.situation === "scope_boundary" || interaction.situation === "followup"
  )
  if (!handoffContext) return false
  return decision.investigation.steps.some((step) => (
    step.source === "message" && step.status === "confirmed" && step.evidence.trim().length > 0
  ))
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
      ? `回答模型连续三次均触发发送前硬门禁：${reasons.join("；")}`
      : "回答模型连续三次未形成可安全发送的结果")
    this.name = "SupportModelOutputRejectedError"
    this.rejectionReasons = reasons
  }
}

function escalationAnswerConfirmsNotification(value: string): boolean {
  return /(?:(?:已经|已)?(?:通知|转给|同步给|反馈给).{0,12}(?:技术|开发|研发)|(?:技术|开发|研发).{0,10}(?:已经|已).{0,10}(?:收到|同步|跟进|处理))/u.test(value)
}

export function featureRequestAnswerConfirmsDeployment(value: string): boolean {
  return escalationAnswerConfirmsNotification(value)
    && /(?:技术|开发|功能).{0,16}(?:上线|发布).{0,12}(?:解决|支持|生效)|(?:上线|发布)后.{0,12}(?:解决|支持|生效)/u.test(value)
}

function humanOperationAnswerConfirmsNotification(value: string): boolean {
  return /(?:(?:我|这边)?(?:已经|已)(?:帮你|给你)?(?:通知|转|转给|发给|同步给|反馈给).{0,12}(?:技术|开发|研发|同事)|(?:技术|开发|研发|同事).{0,10}(?:已经|已).{0,10}(?:收到|接手|跟进))/u.test(value)
}

function humanOperationAnswerClaimsCompletion(value: string): boolean {
  return /(?:(?:账号|用户|操作).{0,8}(?:已经|已)(?:创建|解冻|完成|处理)|(?:已经|已)(?:创建|解冻|完成)(?:账号|用户|操作)?|(?:技术|开发|研发|同事).{0,8}(?:已经|已)(?:处理|完成))/u.test(value)
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
    const wantsInterfaceDocumentation = input.includeInterfaceDocs && questionNeedsInterfaceDocumentation(input.latestMessage, input.question)
    const interfaceDocuments = wantsInterfaceDocumentation
      ? this.deps.knowledge.searchStaticKnowledge(input.question, 20, interfaceScope)
        .filter((document) => document.source === interfaceSource)
      : []
    const wantsMagicBook = input.includeMagicBook && questionNeedsMagicBookKnowledge(input.latestMessage, input.question)
    const magicBookDocuments = wantsMagicBook
      ? this.deps.knowledge.searchStaticKnowledge(`${input.question} ${service.key} ${service.region}`, 8)
        .filter((document) => document.source === "magicbook")
      : []
    const documents = [...interfaceDocuments, ...magicBookDocuments]
    const resources = this.resources(service.id)
    resources.checks = await this.preflightServerChecks(service.id, input.question)
    await this.publishProgress(input, snapshot, this.trustedInvestigation({
      input,
      snapshot,
      documents,
      wantsInterfaceDocumentation,
      resources,
      databaseSteps: [],
      observations: [],
      modelDecision: null,
    }))
    const projectServices = this.deps.database.readProjectServices(
      "WHERE project_id=? AND enabled=1 AND lower(service_key)<>'peakpay' ORDER BY name",
      [service.projectId],
    ).map((item) => ({ key: item.key, name: item.name }))
    const resourceWorkspace = await this.deps.resourceWorkspace.open(service.id, snapshot)
    let decision: AnswerDecision | null = null
    const observations: CodexCommandObservation[] = []
    const databaseSteps: InvestigationStep[] = []
    const observationKeys = new Set<string>()
    const databaseRequestKeys = new Set<string>()
    let databaseVerificationCount = 0
    let databaseLimitRecorded = false
    let retryRequirement: string | null = null
    const sendableCandidates: Array<{
      decision: AnswerDecision
      qualityReasons: string[]
      attempt: number
    }> = []
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const generated = await this.deps.agent.decide({
          service: service.key,
          groupName: input.groupName,
          projectServices,
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
                if (databaseVerificationCount >= 6) {
                  if (!databaseLimitRecorded) {
                    databaseLimitRecorded = true
                    databaseSteps.push({
                      source: "database",
                      title: "父进程数据库复核达到安全上限",
                      status: "skipped",
                      evidence: "本轮只执行前 6 个去重后的数据库只读复核请求",
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
              wantsInterfaceDocumentation,
              resources,
              databaseSteps,
              observations,
              modelDecision: null,
              workspacePath: resourceWorkspace.path,
            }))
          },
          ...(attempt > 0 ? {
            retryInstruction: input.replyStyle === "human"
              ? retryInstruction(input.responseDepth, input.operatorStyleProfile, retryRequirement ?? undefined)
              : `上一次结果不能发送 ${retryRequirement ?? ""} 请重新提交完整准确的结构化结果 保留实际技术证据并先完成脱敏 没有已确认根源和符合升级类型的可信证据不得升级`,
          } : {}),
        }, signal)
        decision = this.redactDecision({
          ...generated,
          investigation: this.trustedInvestigation({
            input,
            snapshot,
            documents,
            wantsInterfaceDocumentation,
            resources,
            databaseSteps,
            observations,
            modelDecision: generated,
            workspacePath: resourceWorkspace.path,
          }),
        }, allowedMemoryIds, input.latestMessage, input.replyStyle)
        await this.publishProgress(input, snapshot, decision.investigation)
        const verifiedEscalation = decision.escalationType === "service_handoff"
          ? hasVerifiedServiceHandoff(decision, service.key, projectServices, input.question, input.responseDepth)
          : hasVerifiedTechnicalEscalation(decision, snapshot, input.question)
        const unverifiedEscalation = decision.decision === "escalate" && !verifiedEscalation
        const missedFeatureRequest = questionRequestsFeatureChange(input.latestMessage)
          && !(decision.decision === "escalate" && decision.escalationType === "feature_request")
        const unsafeOperatorAnswer = (decision.decision === "escalate"
          && decision.escalationType !== "feature_request"
          && decision.escalationType !== "service_handoff"
          && decision.escalationType !== "human_operation"
          && !escalationAnswerIsConcrete(decision.answer))
          || (input.replyStyle === "human" && decision.decision === "reply" && operatorAnswerNeedsTechnicalOnly(decision.answer))
        const tooTechnical = input.replyStyle === "human" && decision.decision !== "ignore" && operatorAnswerIsTooTechnical(decision.answer, input.latestMessage)
        const tooFormal = input.replyStyle === "human" && decision.decision !== "ignore" && operatorAnswerIsReportLike(decision.answer)
        const mechanicalAcknowledgement = input.replyStyle === "human" && decision.decision !== "ignore"
          && operatorAnswerIsEmptyAcknowledgement(decision.answer)
        const incompleteActionAudit = decision.decision !== "ignore"
          && !auditableActionAnswerIsComplete(decision)
        const ignoredAnomaly = decision.decision === "ignore" && anomalyPattern.test(input.question)
        const ignoredRepeatedIncident = repeatedIncidentWasIgnored(
          input.question,
          input.latestMessage,
          input.conversationContext,
          decision,
        )
        const upstreamCallbackRejection = input.replyStyle === "human" && decision.decision !== "ignore"
          ? upstreamCallbackValidationReason(input.question, input.latestMessage, decision)
          : null
        const omittedVerifiedExternalResponsibility = input.replyStyle === "human"
          && decision.decision !== "ignore"
          && hasVerifiedExternalCauseEvidence(decision)
          && !answerExplicitlyClearsOurResponsibility(decision.answer)
        const unqualifiedUpstreamReturnedInference = input.replyStyle === "human"
          && decision.decision !== "ignore"
          && upstreamReturnedErrorInferenceNeedsQualification(
            input.question,
            input.conversationContext,
            decision,
          )
          && !answerQualifiesUpstreamReturnedInference(decision.answer)
        const answerGroundingReasons = answerClaimGroundingReasons(
          input.question,
          input.latestMessage,
          input.conversationContext,
          decision,
        )
        const misattributedUpstreamBalanceError = input.replyStyle === "human"
          && decision.decision !== "ignore"
          && upstreamBalanceErrorMisattributesResponsibility(
            input.question,
            input.conversationContext,
            decision.answer,
          )
        const unsolicitedDerivedStatistics = input.replyStyle === "human"
          && decision.decision !== "ignore"
          && answerIntroducesUnrequestedDerivedStatistics(input.latestMessage, decision.answer)
        const disclosedAutomationIdentity = decision.decision !== "ignore"
          && operatorAnswerDisclosesAutomationIdentity(decision.answer)
        const invalidInteractionStrategy = interactionStrategyIsInvalid(decision)
        const notificationConfirmed = decision.escalationType === "human_operation"
          ? humanOperationAnswerConfirmsNotification(decision.answer)
          : escalationAnswerConfirmsNotification(decision.answer)
        const missingTechnicalNotification = decision.decision === "escalate" && !notificationConfirmed
        const copiedHistoricalWording = decision.decision !== "ignore"
          && answerCopiesHistoricalWording(decision.answer, memories, input.conversationContext)
        const outbound = decision.decision !== "ignore" ? this.deps.redactor.assertSafeOutbound(decision.answer) : null
        const unsafeOutbound = Boolean(outbound && (!outbound.allowed || !outbound.safeText.trim() || garbled(outbound.safeText)))
        const blockingRejectionReasons = [
          ...(unverifiedEscalation
            ? [decision.escalationType === "feature_request"
              ? "产品改动升级没有同时满足消息证据、通知技术和上线后解决的要求"
              : decision.escalationType === "service_handoff"
                ? "跨服务接管升级没有通过服务边界、上下文或用户原话校验"
                : decision.escalationType === "human_operation"
                  ? "专人操作升级缺少可核对的操作原话或必要业务标识"
                  : decision.escalationType === "code_defect"
                    ? "代码缺陷升级缺少可验证的仓库、文件或行号证据"
                    : "技术升级缺少可信的代码检查和运行证据"]
            : []),
          ...(missedFeatureRequest
            ? ["这是产品改动需求 必须使用 feature_request 并通知技术"]
            : []),
          ...(unsafeOperatorAnswer
            ? [decision.decision === "reply"
              ? "普通回复把未确认问题直接交给技术处理"
              : "技术升级回复没有说清已确认根源和具体处理事项"]
            : []),
          ...(incompleteActionAudit
            ? ["回复声称发生了后台操作，但没有核对操作人及相关审计记录"]
            : []),
          ...(ignoredAnomaly ? ["异常问题被错误判断为无需回复"] : []),
          ...(ignoredRepeatedIncident ? ["运营强调同一异常成批或反复发生 不能当成闲聊或无需介入"] : []),
          ...(misattributedUpstreamBalanceError
            ? ["上游返回余额不足描述的是我方运营在该上游的账户可用余额 answer 必须明确写成我方在上游的账户余额不足 不得写成上游自身余额不足或不是我方问题"]
            : []),
          ...(disclosedAutomationIdentity ? ["回复暴露了 AI、机器人或自动客服身份"] : []),
          ...(missingTechnicalNotification ? ["升级回复没有明确说明已经通知技术接手"] : []),
          ...(unsafeOutbound ? ["回复为空、乱码或触发敏感信息出站拦截"] : []),
        ]
        const qualityRejectionReasons = [
          ...(tooTechnical ? ["真人口吻回复包含运营未询问的技术术语"] : []),
          ...(tooFormal ? ["真人口吻回复使用了报告或需求分析式表达"] : []),
          ...(mechanicalAcknowledgement
            ? ["使用了可以 能查 查到了等机械确认开场 必须直接给真实结果或处理结果"]
            : []),
          ...(upstreamCallbackRejection ? [upstreamCallbackRejection] : []),
          ...(omittedVerifiedExternalResponsibility
            ? ["代码与实际只读证据已经确认唯一根源在商户 上游 银行或其他外部方 并排除我方处理异常 回复必须说清外部方的实际动作并明确说不是我方问题"]
            : []),
          ...(unqualifiedUpstreamReturnedInference
            ? ["本轮原因依据来自上游返回的报错信息 answer 必须先说明上游返回提示的原文含义 再明确说当前只是根据该返回初步判断 不得写成已确认事实或仅凭此排除我方问题"]
            : []),
          ...answerGroundingReasons,
          ...(unsolicitedDerivedStatistics
            ? ["本轮最新消息没有要求统计 不得自行计算或补充百分比 占比 分母 样本量或发生率 只回应最新补充和当前处理"]
            : []),
          ...(invalidInteractionStrategy ? ["回复策略与当前投诉、追问或范围边界状态不一致"] : []),
          ...(copiedHistoricalWording ? ["回复与历史纠正或历史客服话术过度相似"] : []),
        ]
        const rejectionReasons = [...blockingRejectionReasons, ...qualityRejectionReasons]
        if (rejectionReasons.length === 0) break
        if (blockingRejectionReasons.length === 0) {
          sendableCandidates.push({ decision, qualityReasons: qualityRejectionReasons, attempt })
        }
        retryRequirement = rejectionReasons.join("；")
        if (attempt === 2) {
          const selected = [...sendableCandidates].sort((left, right) => (
            left.qualityReasons.length - right.qualityReasons.length || right.attempt - left.attempt
          ))[0]
          if (selected) {
            const qualityStep: InvestigationStep = {
              source: "inference",
              title: "回答质量校验降级",
              status: "skipped",
              evidence: `三次候选仍有表达质量项未完全满足 已选择未触发安全 权限 敏感信息或高风险事实硬门禁的最佳模型候选\n未满足项=${selected.qualityReasons.join("；")}`.slice(0, 4000),
              conclusion: "已保持回答模型原文继续发送 没有使用确定性代码改写或生成兜底文案",
            }
            decision = {
              ...selected.decision,
              investigation: {
                summary: "模型候选通过硬性安全校验并按质量分数选优发送",
                steps: [...selected.decision.investigation.steps.slice(0, 23), qualityStep],
              },
            }
            break
          }
          const candidate = decision.answer.trim()
            ? `\n模型最后候选（仅供后台复核 未发送）=${decision.answer.slice(0, 1200)}`
            : "\n模型最后候选为空"
          const rejectionStep: InvestigationStep = {
            source: "inference",
            title: "发送前硬门禁",
            status: "failed",
            evidence: `${rejectionReasons.join("；")}${candidate}`.slice(0, 4000),
            conclusion: "三个模型候选都触发安全 权限 升级合法性 高风险事实或输出完整性硬门禁 结果未发送",
          }
          decision = {
            ...decision,
            investigation: {
              summary: "三个模型候选均未通过发送前硬门禁",
              steps: [...decision.investigation.steps.slice(0, 23), rejectionStep],
            },
          }
          await this.publishProgress(input, snapshot, decision.investigation)
          throw new SupportModelOutputRejectedError(rejectionReasons)
        }
      }
    } finally {
      await resourceWorkspace.cleanup()
    }
    if (!decision) throw new Error("回答模型未形成结果")
    await this.publishProgress(input, snapshot, decision.investigation)
    const currentService = this.deps.codeSync.currentServiceForSnapshot(snapshot)
    if (!currentService) throw new SupportCodeConfigurationChangedError()
    service = currentService
    return { service, snapshot, decision, allowedMemoryIds }
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
        evidence: `仅允许概括前述 ${trustedCount} 个可信步骤 模型自报的其他排查步骤未采信`,
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
    latestMessage: string,
    replyStyle: ReplyStyle,
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
      quote: replyStyle === "human" ? operatorQuoteForReply(safeQuote, latestMessage) : safeQuote,
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

  private async preflightServerChecks(serviceId: string, question: string): Promise<SupportResourceSummary["checks"]> {
    if (!this.deps.resourceBroker) return []
    const checks: Array<SupportResourceSummary["checks"][number]["check"]> = []
    if (/(?:nginx|https?|api\s*url|域名|路由|\b(?:404|405|502|504)\b)/iu.test(question)) checks.push("nginx_routes")
    if (questionNeedsSystemResources(question)) checks.push("system_resources")
    if (checks.length === 0) return []
    const server = this.deps.database.readServerResources("WHERE service_id=? AND enabled=1 ORDER BY created_at,id LIMIT 1", [serviceId])[0]
    if (!server) return []
    return Promise.all(checks.map(async (check): Promise<SupportResourceSummary["checks"][number]> => {
      try {
        const result = await this.deps.resourceBroker!.runServerCheck(server.id, check)
        const validOutput = check === "system_resources" ? validSystemResourcesOutput(result.stdout) : true
        if (check === "system_resources" && (result.exitCode !== 0 || !validOutput)) {
          return {
            check,
            status: "failed",
            stdout: "",
            stderr: result.exitCode !== 0 ? "SYSTEM_RESOURCES_COMMAND_FAILED" : "SYSTEM_RESOURCES_INVALID_OUTPUT",
          }
        }
        return {
          check,
          status: result.exitCode === 0 && validOutput ? "completed" : "failed",
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 1000),
        }
      } catch {
        return {
          check,
          status: "failed",
          stdout: "",
          stderr: check === "system_resources" ? "SYSTEM_RESOURCES_EXECUTION_FAILED" : "SERVER_CHECK_EXECUTION_FAILED",
        }
      }
    }))
  }
}
