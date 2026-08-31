import { createHash } from "node:crypto"
import { chmod, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

const [databasePath, masterKeyPath, runtimeDirectory, reportPath, requestedLimit = "15"] = process.argv.slice(2)
if (!databasePath || !masterKeyPath || !runtimeDirectory || !reportPath) {
  throw new Error("用法：node scripts/run-reply-regression.mjs <SQLite副本> <master.key副本> <生产runtime目录> <报告路径> [样本数]")
}
const maximumSamples = Math.min(Math.max(Number(requestedLimit) || 15, 1), 40)
const dist = path.resolve("dist")
const { RuntimeDatabase } = await import(path.join(dist, "runtime/database.js"))
const { LocalSecretVault } = await import(path.join(dist, "runtime/secret-vault.js"))
const { ModelConfigService } = await import(path.join(dist, "runtime/model-config-service.js"))
const { RuntimeKnowledgeService } = await import(path.join(dist, "runtime/knowledge-service.js"))
const { ConfiguredSecretRedactor } = await import(path.join(dist, "security/dlp.js"))
const { ProjectCodeSyncService } = await import(path.join(dist, "git-sync/project-service.js"))
const { ReadonlyResourceBroker } = await import(path.join(dist, "diagnostics/resource-broker.js"))
const { ReadonlyAgentToolBroker } = await import(path.join(dist, "diagnostics/readonly-agent-tool-broker.js"))
const { DirectApiAdapter } = await import(path.join(dist, "models/direct-api/direct-api-adapter.js"))
const { CodexExecutor } = await import(path.join(dist, "codex/executor.js"))
const { CodexSupportDecisionAgent } = await import(path.join(dist, "support/agent.js"))
const { SupportInvestigationService } = await import(path.join(dist, "support/investigation-service.js"))
const { ResourceWorkspace } = await import(path.join(dist, "support/resource-workspace.js"))
const { latestAdminChatMessage } = await import(path.join(dist, "admin-chat/worker.js"))

const comparisonSchema = z.object({
  preferred: z.enum(["new", "historical", "tie"]),
  regression: z.boolean(),
  dimensions: z.object({
    factualGrounding: z.number().int().min(-1).max(1),
    completeness: z.number().int().min(-1).max(1),
    requestFit: z.number().int().min(-1).max(1),
    recipientClarity: z.number().int().min(-1).max(1),
    evidenceUse: z.number().int().min(-1).max(1),
    safetyBoundary: z.number().int().min(-1).max(1),
  }).strict(),
  issues: z.array(z.string().trim().min(1).max(300)).max(8),
  reason: z.string().trim().min(1).max(800),
}).strict()
const comparisonJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["preferred", "regression", "dimensions", "issues", "reason"],
  properties: {
    preferred: { type: "string", enum: ["new", "historical", "tie"] },
    regression: { type: "boolean" },
    dimensions: {
      type: "object",
      additionalProperties: false,
      required: ["factualGrounding", "completeness", "requestFit", "recipientClarity", "evidenceUse", "safetyBoundary"],
      properties: Object.fromEntries([
        "factualGrounding", "completeness", "requestFit", "recipientClarity", "evidenceUse", "safetyBoundary",
      ].map((name) => [name, { type: "integer", minimum: -1, maximum: 1 }])),
    },
    issues: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 300 } },
    reason: { type: "string", minLength: 1, maxLength: 800 },
  },
}

const database = await RuntimeDatabase.open(path.resolve(databasePath))
const vault = await LocalSecretVault.open(path.resolve(masterKeyPath))
const config = new ModelConfigService(database, vault)
const redactor = new ConfiguredSecretRedactor(database, () => config.listConfiguredSecrets())
const knowledge = new RuntimeKnowledgeService(database, redactor)
knowledge.ensureSystemDirectives()
const direct = new DirectApiAdapter(fetch, new ReadonlyAgentToolBroker((value) => redactor.redact(value).text))
const executor = new CodexExecutor(config, undefined, direct)
const agent = new CodexSupportDecisionAgent(executor)
const investigation = new SupportInvestigationService({
  database,
  codeSync: new ProjectCodeSyncService(database, path.resolve(runtimeDirectory)),
  knowledge,
  resourceWorkspace: new ResourceWorkspace(database),
  redactor,
  agent,
  resourceBroker: new ReadonlyResourceBroker(database),
})

function rows(sql, parameters = []) {
  return database.prepare(sql).all(...parameters)
}

const supportBase = `SELECT r.id,'support' AS source,r.service_id,r.status,r.input_revision,r.sender_role,
    p.question,p.answer,g.name AS group_name,g.knowledge_scope,
    p.has_attachment,CASE WHEN r.status='corrected' THEN 1 ELSE 0 END AS corrected,
    r.updated_at
  FROM support_replies r JOIN support_reply_payloads p ON p.reply_id=r.id
  LEFT JOIN telegram_groups g ON g.id=r.group_id
  WHERE r.service_id IS NOT NULL AND r.status IN ('replied','escalated','corrected') AND trim(p.answer)<>''`
const adminBase = `SELECT turn.id,'admin' AS source,session.service_id,turn.status,NULL AS input_revision,NULL AS sender_role,
    turn.question,COALESCE(correction.corrected_answer,turn.answer) AS answer,'后台 AI 对话' AS group_name,
    project.default_knowledge_scope AS knowledge_scope,
    CASE WHEN EXISTS(SELECT 1 FROM admin_chat_attachments attachment WHERE attachment.turn_id=turn.id) THEN 1 ELSE 0 END AS has_attachment,
    CASE WHEN correction.id IS NULL THEN 0 ELSE 1 END AS corrected,turn.updated_at
  FROM admin_chat_turns turn JOIN admin_chat_sessions session ON session.id=turn.session_id
  JOIN projects project ON project.id=session.project_id
  LEFT JOIN admin_chat_corrections correction ON correction.id=(
    SELECT latest.id FROM admin_chat_corrections latest WHERE latest.turn_id=turn.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
  ) WHERE turn.status='completed' AND trim(turn.answer)<>''`

const strata = [
  rows(`${supportBase} AND r.status='corrected' ORDER BY r.updated_at DESC LIMIT 6`),
  rows(`${supportBase} AND r.status='escalated' ORDER BY r.updated_at DESC LIMIT 3`),
  rows(`${supportBase} AND p.has_attachment=1 ORDER BY r.updated_at DESC LIMIT 3`),
  rows(`${supportBase} AND COALESCE(r.input_revision,1)>1 ORDER BY r.updated_at DESC LIMIT 3`),
  rows(`${supportBase} ORDER BY length(p.answer) DESC,r.updated_at DESC LIMIT 3`),
  rows(`${supportBase} ORDER BY r.updated_at DESC LIMIT 5`),
  rows(`${adminBase} AND correction.id IS NOT NULL ORDER BY turn.updated_at DESC LIMIT 3`),
  rows(`${adminBase} AND EXISTS(SELECT 1 FROM admin_chat_attachments attachment WHERE attachment.turn_id=turn.id)
    ORDER BY turn.updated_at DESC LIMIT 3`),
  rows(`${adminBase} ORDER BY turn.updated_at DESC LIMIT 5`),
]
let selected = []
const seen = new Set()
const maximumStratumLength = Math.max(...strata.map((stratum) => stratum.length))
for (let offset = 0; offset < maximumStratumLength && selected.length < maximumSamples; offset += 1) {
  for (const stratum of strata) {
    const row = stratum[offset]
    if (row) {
      const key = `${row.source}:${row.id}`
      if (!seen.has(key)) {
        seen.add(key)
        selected.push(row)
      }
    }
    if (selected.length >= maximumSamples) break
  }
}
if (process.env.REGRESSION_CASE_ID) {
  selected = selected.filter((row) => (
    createHash("sha256").update(`${row.source}:${row.id}`).digest("hex").slice(0, 12) === process.env.REGRESSION_CASE_ID
  ))
  if (selected.length === 0) throw new Error("指定的回归样本不在当前分层样本中")
}

const binding = config.getBinding("answer")
const modelSnapshot = config.getModelInstanceSnapshot(binding.modelInstanceId)
const operatorStyle = database.readActiveOperatorStyle()
const report = {
  generatedAt: new Date().toISOString(),
  schemaVersion: database.schemaVersion(),
  corpus: {
    supportCompleted: Number(rows(`SELECT COUNT(*) count FROM (${supportBase})`)[0].count),
    adminCompleted: Number(rows(`SELECT COUNT(*) count FROM (${adminBase})`)[0].count),
    supportCorrected: Number(rows(`${supportBase} AND r.status='corrected'`).length),
    adminCorrected: Number(rows(`${adminBase} AND correction.id IS NOT NULL`).length),
  },
  requestedSamples: maximumSamples,
  cases: [],
}

async function compare(row, result) {
  const prompt = [
    "你是客服回复回归评测员，只输出结构化 JSON。比较同一个历史问题的历史有效回复和新流水线回复。",
    "证据包和新调查结果优先于历史客服判断；历史回复只作为当前版本表现基线，不能冒充本轮运行证据。",
    "每个维度填 -1 表示新回复更差，0 表示相当，1 表示更好。只有出现明确、可复核的退步时 regression=true；不能因措辞不同判退步。",
    "重点检查事实来源、已确认与推断边界、必要原因和当前状态是否完整、是否回应最新诉求、第三方沟通是否明确接收方并包含我方证据、是否只追问最少信息、是否泄漏敏感信息或越权承诺。",
    `问题：${row.question}`,
    `历史有效回复：${row.answer}`,
    `新流水线回复：${result.decision.answer}`,
    `新证据包：${JSON.stringify(result.pipelineAudit.evidencePacket)}`,
    `新业务判断：${JSON.stringify({ decision: result.decision.decision, escalationType: result.decision.escalationType, responsibility: result.decision.responsibility })}`,
  ].join("\n\n")
  return executor.execute("answer", {
    cwd: process.cwd(),
    modelInstanceId: binding.modelInstanceId,
    modelSnapshot,
    bindingSnapshot: binding,
    prompt,
    outputSchema: comparisonJsonSchema,
    validator: comparisonSchema,
    accessMode: "text-only",
    concurrencyGroup: "reply-regression-judge",
    maxConcurrency: binding.maxConcurrency,
    executionTimeoutMs: binding.timeoutSeconds * 1000,
  })
}

function attachmentsFor(row) {
  const attachmentRows = row.source === "admin"
    ? rows(`SELECT file_name,mime_type,file_size,kind,storage_path,extracted_text
        FROM admin_chat_attachments WHERE turn_id=? ORDER BY created_at,id`, [row.id])
    : rows(`SELECT file_name,mime_type,file_size,kind,storage_path,extracted_text
        FROM support_attachments WHERE reply_id=? ORDER BY created_at,id`, [row.id])
  return attachmentRows.map((attachment) => ({
    name: String(attachment.file_name),
    kind: attachment.kind,
    mimeType: String(attachment.mime_type),
    size: Number(attachment.file_size),
    extractedText: String(attachment.extracted_text),
    localPath: String(attachment.storage_path || "") || null,
  }))
}

for (let index = 0; index < selected.length; index += 1) {
  const row = selected[index]
  const startedAt = Date.now()
  const caseId = createHash("sha256").update(`${row.source}:${row.id}`).digest("hex").slice(0, 12)
  try {
    const question = String(row.question)
    const result = await investigation.investigate({
      serviceId: String(row.service_id),
      groupName: String(row.group_name || "历史客服群"),
      question,
      latestMessage: row.source === "admin" ? latestAdminChatMessage(question) : question,
      responseDepth: Number(row.input_revision ?? 1) > 1 ? "followup" : "initial",
      senderRole: row.sender_role || null,
      scope: String(row.knowledge_scope || "global"),
      attachments: attachmentsFor(row),
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
    }, new AbortController().signal)
    const comparison = await compare(row, result)
    report.cases.push({
      caseId,
      source: row.source,
      corrected: Boolean(row.corrected),
      hadAttachment: Boolean(row.has_attachment),
      historicalStatus: row.status,
      pipelineMode: result.pipelineAudit.mode,
      finalSource: result.pipelineAudit.finalSource,
      reviewOutcomes: result.pipelineAudit.reviews.map((review) => review.outcome),
      comparison: {
        ...comparison,
        issues: comparison.issues.map((issue) => redactor.redact(issue).text),
        reason: redactor.redact(comparison.reason).text,
      },
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const safeError = error instanceof Error ? redactor.redact(error.message).text.slice(0, 1000) : "未知错误"
    report.cases.push({
      caseId,
      source: row.source,
      corrected: Boolean(row.corrected),
      hadAttachment: Boolean(row.has_attachment),
      historicalStatus: row.status,
      error: error instanceof Error ? error.name : "UnknownError",
      errorMessage: safeError,
      durationMs: Date.now() - startedAt,
    })
  }
  process.stdout.write(`CASE ${index + 1}/${selected.length} ${caseId} completed\n`)
}

report.summary = {
  completed: report.cases.filter((item) => !item.error).length,
  failed: report.cases.filter((item) => item.error).length,
  regressions: report.cases.filter((item) => item.comparison?.regression).length,
  preferredNew: report.cases.filter((item) => item.comparison?.preferred === "new").length,
  preferredHistorical: report.cases.filter((item) => item.comparison?.preferred === "historical").length,
  ties: report.cases.filter((item) => item.comparison?.preferred === "tie").length,
  baselineFallbacks: report.cases.filter((item) => item.finalSource === "baseline").length,
}
await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
await chmod(path.resolve(reportPath), 0o600)
process.stdout.write(`SUMMARY ${JSON.stringify(report.summary)}\n`)
await executor.shutdown()
database.close()
