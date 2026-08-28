import { createHash, randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const executingRegressionRunnerContents = await readFile(fileURLToPath(import.meta.url))
const executingRegressionRunnerHash = createHash("sha256")
  .update(executingRegressionRunnerContents)
  .digest("hex")

const usage = `用法：node scripts/run-reply-regression.mjs <SQLite副本> <master.key副本> <生产runtime目录> <报告路径> [样本数] [--focus-case-id <12位hash>]...

安全边界：
- 只读打开 SQLite 副本，不迁移、不初始化、不写回源库。
- 回放只调用调查和审核流水线，不会发送 Telegram。
- 报告仅保存去标识化 case hash 和结构化审核统计，不保存问题、回复或附件正文。
- 使用历史输入快照和线程固定回答策略，以当前代码和当前模型重新评估；不是历史运行的逐字复现。
- 默认发布门禁：没有有效样本、任一执行失败或任一明确退步都会在报告落盘后返回非零状态。
`

const requiredSchemaVersion = 34

function normalizedCaseId(value, source) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!/^[a-f0-9]{12}$/u.test(normalized)) {
    throw new Error(`${source} 必须是 12 位十六进制 case hash`)
  }
  return normalized
}

export function parseRegressionArguments(argv, environment = process.env) {
  const positionals = []
  const requestedFocus = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--focus-case-id") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new Error("--focus-case-id 缺少 12 位 case hash")
      requestedFocus.push(normalizedCaseId(value, "--focus-case-id"))
      index += 1
      continue
    }
    if (argument.startsWith("--")) throw new Error(`未知参数：${argument}`)
    positionals.push(argument)
  }
  if (positionals.length < 4 || positionals.length > 5) throw new Error(usage.trim())

  const [databasePath, masterKeyPath, runtimeDirectory, reportPath, requestedLimit = "15"] = positionals
  const environmentFocus = String(environment.REGRESSION_CASE_ID ?? "").trim()
  if (environmentFocus) requestedFocus.push(normalizedCaseId(environmentFocus, "REGRESSION_CASE_ID"))
  const focusCaseIds = [...new Set(requestedFocus)]
  if (focusCaseIds.length > 40) throw new Error("聚焦回归样本最多 40 个")

  return {
    databasePath,
    masterKeyPath,
    runtimeDirectory,
    reportPath,
    maximumSamples: Math.min(Math.max(Number(requestedLimit) || 15, 1), 40),
    focusCaseIds,
  }
}

export function regressionCaseId(row) {
  return createHash("sha256").update(`${row.source}:${row.id}`).digest("hex").slice(0, 12)
}

export function selectFocusedRegressionRows(supportRows, adminRows, focusCaseIds) {
  const indexed = new Map([...supportRows, ...adminRows].map((row) => [regressionCaseId(row), row]))
  return focusCaseIds.map((caseId) => {
    const row = indexed.get(caseId)
    if (!row) throw new Error(`未找到已完成回归样本：${caseId}`)
    return row
  })
}

function auditFromError(error) {
  if (!error || typeof error !== "object" || !("pipelineAudit" in error)) return null
  const audit = error.pipelineAudit
  return audit && typeof audit === "object" && !Array.isArray(audit) ? audit : null
}

function allowedValue(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : null
}

const reviewOutcomes = ["pass", "issues", "approve", "revise", "prefer_baseline", "blocked"]

function safeReviewOutcomes(audit) {
  if (!Array.isArray(audit?.reviews)) return []
  return audit.reviews.flatMap((review) => {
    const outcome = allowedValue(review?.outcome, reviewOutcomes)
    return outcome ? [outcome] : []
  })
}

function safeErrorName(error) {
  const allowed = [
    "Error", "TypeError", "AbortError", "ModelExecutionError", "SupportModelOutputRejectedError",
    "SupportEvidenceStructureError", "SupportCodeConfigurationChangedError", "SupportCodeSyncRuntimeError",
    "RegressionAuditRejectedError", "RegressionComparisonRejectedError",
  ]
  return error instanceof Error && allowed.includes(error.name) ? error.name : "UnknownError"
}

function auditSummary(audit) {
  const packet = audit?.evidencePacket
  const packetObject = packet && typeof packet === "object" && !Array.isArray(packet) ? packet : null
  const associations = Array.isArray(packetObject?.associations) ? packetObject.associations : []
  const associationStatuses = [...new Set(associations.flatMap((association) => {
    if (!association || typeof association !== "object" || Array.isArray(association)) return []
    const status = allowedValue(association.status, ["confirmed", "unconfirmed", "conflicting"])
    return status ? [status] : []
  }))].sort()
  const reviews = Array.isArray(audit?.reviews) ? audit.reviews : []
  const gateReview = reviews.filter((review) => (
    review && typeof review === "object" && !Array.isArray(review) && review.stage === "gate"
  )).at(-1)
  const strictReview = reviews.filter((review) => (
    review && typeof review === "object" && !Array.isArray(review)
      && ["baseline_review", "revision_review", "blocked"].includes(review.stage)
  )).at(-1)

  return {
    evidencePacketVersion: allowedValue(packetObject?.version, ["1", "2"]),
    associationStatuses,
    gateOutcome: gateReview ? allowedValue(gateReview.outcome, reviewOutcomes) : null,
    strictReviewOutcome: strictReview ? allowedValue(strictReview.outcome, reviewOutcomes) : null,
    blockedNotSent: strictReview?.stage === "blocked"
      && allowedValue(strictReview.outcome, reviewOutcomes) === "blocked",
  }
}

function rowSummary(row, caseId, durationMs) {
  return {
    caseId,
    source: row.source,
    corrected: Boolean(row.corrected),
    hadAttachment: Boolean(row.has_attachment),
    historicalStatus: row.status,
    durationMs,
  }
}

export function buildSuccessfulRegressionCase({ row, caseId, result, comparison, durationMs }) {
  assertRegressionAuditContract(result)
  assertRegressionComparisonConsistency(comparison)
  const audit = result.pipelineAudit
  return {
    ...rowSummary(row, caseId, durationMs),
    pipelineMode: allowedValue(audit.mode, ["legacy", "multi_stage"]),
    finalSource: allowedValue(audit.finalSource, ["baseline", "first_candidate", "revised_candidate"]),
    reviewOutcomes: safeReviewOutcomes(audit),
    ...auditSummary(audit),
    comparison: {
      preferred: comparison.preferred,
      regression: Boolean(comparison.regression),
      dimensions: comparison.dimensions,
      issueCount: Array.isArray(comparison.issues) ? comparison.issues.length : 0,
    },
  }
}

export function buildFailedRegressionCase({ row, caseId, error, durationMs }) {
  const audit = auditFromError(error)
  return {
    ...rowSummary(row, caseId, durationMs),
    error: safeErrorName(error),
    ...(audit ? {
      pipelineMode: allowedValue(audit.mode, ["legacy", "multi_stage"]),
      finalSource: allowedValue(audit.finalSource, ["baseline", "first_candidate", "revised_candidate"]),
      reviewOutcomes: safeReviewOutcomes(audit),
    } : {}),
    ...auditSummary(audit),
  }
}

export function summarizeRegressionCases(cases) {
  return {
    completed: cases.filter((item) => !item.error).length,
    failed: cases.filter((item) => item.error).length,
    regressions: cases.filter((item) => item.comparison?.regression).length,
    preferredNew: cases.filter((item) => item.comparison?.preferred === "new").length,
    preferredHistorical: cases.filter((item) => item.comparison?.preferred === "historical").length,
    ties: cases.filter((item) => item.comparison?.preferred === "tie").length,
    approvedBaseline: cases.filter((item) => (
      !item.error && item.finalSource === "baseline" && item.strictReviewOutcome === "approve" && !item.blockedNotSent
    )).length,
    blockedNotSent: cases.filter((item) => item.blockedNotSent).length,
  }
}

export function openRegressionDatabase(RuntimeDatabase, databasePath) {
  return RuntimeDatabase.openPortable(path.resolve(databasePath), true)
}

async function existingFileIdentity(filePath) {
  try {
    const value = await stat(filePath)
    return { device: value.dev, inode: value.ino, links: value.nlink }
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw new Error("无法校验回归报告路径隔离")
  }
}

function pathContains(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

async function runtimeReferencesConflict(runtimeDirectory, reportPaths, reportIdentity) {
  const maximumNodes = 100000
  const maximumSymlinkDepth = 8
  const pending = [{ filePath: runtimeDirectory, symlinkDepth: 0 }]
  const visitedDirectories = new Set()
  let visitedNodes = 0
  while (pending.length > 0) {
    const { filePath: current, symlinkDepth } = pending.pop()
    visitedNodes += 1
    if (visitedNodes > maximumNodes) throw new Error("回归 runtime 引用扫描超出安全上限")
    const currentIdentity = await lstat(current)
    if (reportIdentity
      && currentIdentity.dev === reportIdentity.device
      && currentIdentity.ino === reportIdentity.inode) return true
    if (currentIdentity.isSymbolicLink()) {
      if (symlinkDepth >= maximumSymlinkDepth) throw new Error("回归 runtime 符号链接深度超出安全上限")
      const directTargetValue = await readlink(current)
      const directTarget = path.resolve(path.dirname(current), directTargetValue)
      const directTargetIdentity = await lstat(directTarget)
      const target = await realpath(current)
      const targetIdentity = await stat(target)
      if (reportPaths.some((reportPath) => pathContains(target, reportPath) || pathContains(reportPath, target))) return true
      if (reportIdentity
        && targetIdentity.dev === reportIdentity.device
        && targetIdentity.ino === reportIdentity.inode) return true
      if (directTargetIdentity.isSymbolicLink()) {
        pending.push({ filePath: directTarget, symlinkDepth: symlinkDepth + 1 })
      } else if (targetIdentity.isDirectory()) {
        pending.push({ filePath: target, symlinkDepth: symlinkDepth + 1 })
      }
      continue
    }
    if (!currentIdentity.isDirectory()) continue
    const identityKey = `${currentIdentity.dev}:${currentIdentity.ino}`
    if (visitedDirectories.has(identityKey)) continue
    visitedDirectories.add(identityKey)
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) pending.push({ filePath: path.join(current, entry.name), symlinkDepth })
  }
  return false
}

export async function assertRegressionOutputIsolation({ databasePath, masterKeyPath, runtimeDirectory, reportPath }) {
  const resolvedDatabasePath = path.resolve(databasePath)
  const resolvedMasterKeyPath = path.resolve(masterKeyPath)
  const resolvedReportPath = path.resolve(reportPath)
  let canonicalDatabasePath = resolvedDatabasePath
  let canonicalMasterKeyPath = resolvedMasterKeyPath
  try {
    canonicalDatabasePath = await realpath(resolvedDatabasePath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("无法校验回归报告路径隔离")
  }
  try {
    canonicalMasterKeyPath = await realpath(resolvedMasterKeyPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("无法校验回归报告路径隔离")
  }
  try {
    if ((await lstat(resolvedReportPath)).isSymbolicLink()) {
      throw new Error("回归报告路径与只读输入文件冲突")
    }
  } catch (error) {
    if (error?.message === "回归报告路径与只读输入文件冲突") throw error
    if (error?.code !== "ENOENT") throw new Error("无法校验回归报告路径隔离")
  }
  let canonicalReportPath
  try {
    canonicalReportPath = path.join(await realpath(path.dirname(resolvedReportPath)), path.basename(resolvedReportPath))
  } catch {
    throw new Error("无法校验回归报告路径隔离")
  }
  if (runtimeDirectory) {
    const resolvedRuntimeDirectory = path.resolve(runtimeDirectory)
    let canonicalRuntimeDirectory
    try {
      canonicalRuntimeDirectory = await realpath(resolvedRuntimeDirectory)
      if (!(await stat(canonicalRuntimeDirectory)).isDirectory()) {
        throw new Error("无法校验回归报告路径隔离")
      }
    } catch (error) {
      if (error?.message === "无法校验回归报告路径隔离") throw error
      throw new Error("无法校验回归报告路径隔离")
    }
    const overlapsRuntime = pathContains(resolvedRuntimeDirectory, resolvedReportPath)
      || pathContains(resolvedReportPath, resolvedRuntimeDirectory)
      || pathContains(canonicalRuntimeDirectory, canonicalReportPath)
      || pathContains(canonicalReportPath, canonicalRuntimeDirectory)
    if (overlapsRuntime) throw new Error("回归报告路径与只读输入文件冲突")

    try {
      if (await runtimeReferencesConflict(
        canonicalRuntimeDirectory,
        [resolvedReportPath, canonicalReportPath],
        await existingFileIdentity(resolvedReportPath),
      )) throw new Error("回归报告路径与只读输入文件冲突")
    } catch (error) {
      if (error?.message === "回归报告路径与只读输入文件冲突") throw error
      throw new Error("无法校验回归报告路径隔离")
    }
  }
  const protectedPaths = [...new Set([
    resolvedDatabasePath,
    resolvedMasterKeyPath,
    `${resolvedDatabasePath}-wal`,
    `${resolvedDatabasePath}-shm`,
    canonicalDatabasePath,
    canonicalMasterKeyPath,
    `${canonicalDatabasePath}-wal`,
    `${canonicalDatabasePath}-shm`,
  ])]
  if (protectedPaths.includes(resolvedReportPath) || protectedPaths.includes(canonicalReportPath)) {
    throw new Error("回归报告路径与只读输入文件冲突")
  }
  const reportIdentity = await existingFileIdentity(resolvedReportPath)
  if (reportIdentity) {
    for (const protectedPath of protectedPaths) {
      const protectedIdentity = await existingFileIdentity(protectedPath)
      if (protectedIdentity
        && protectedIdentity.device === reportIdentity.device
        && protectedIdentity.inode === reportIdentity.inode) {
        throw new Error("回归报告路径与只读输入文件冲突")
      }
    }
  }
  return { resolvedReportPath, canonicalReportPath }
}

class RegressionComparisonRejectedError extends Error {
  constructor() {
    super("回归评测结果自相矛盾，已按失败关门")
    this.name = "RegressionComparisonRejectedError"
  }
}

class RegressionAuditRejectedError extends Error {
  constructor() {
    super("回归流水线审计不满足发布合同，已按失败关门")
    this.name = "RegressionAuditRejectedError"
  }
}

function validAuditIssues(value, maximumIssues) {
  return Array.isArray(value)
    && (maximumIssues === null || value.length <= maximumIssues)
    && value.every((issue) => typeof issue === "string" && issue.trim().length > 0 && issue.length <= 500)
}

function validAuditReason(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000
}

function validAuditEvent(event, stage, attempt, outcomes, maximumIssues) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || event.stage !== stage
    || event.attempt !== attempt
    || !outcomes.includes(event.outcome)
    || !validAuditIssues(event.issues, maximumIssues)
    || !validAuditReason(event.reason)) return false
  const approved = event.outcome === "pass" || event.outcome === "approve"
  return approved ? event.issues.length === 0 : event.issues.length > 0
}

export function assertRegressionAuditContract(result) {
  const audit = result?.pipelineAudit
  const reviews = Array.isArray(audit?.reviews) ? audit.reviews : []
  const gate = reviews[0]
  const stages = reviews.map((review) => review?.stage)
  const stageSequenceIs = (...expected) => (
    stages.length === expected.length && expected.every((stage, index) => stages[index] === stage)
  )
  const validGate = validAuditEvent(gate, "gate", 0, ["pass", "issues"], null)
  const baselineReview = reviews.find((review) => review?.stage === "baseline_review")
  const revisionReview = reviews.find((review) => review?.stage === "revision_review")
  const validBaselineReview = baselineReview === undefined
    || validAuditEvent(baselineReview, "baseline_review", 1, ["approve", "revise", "prefer_baseline"], 12)
  const validRevisionReview = revisionReview === undefined
    || validAuditEvent(revisionReview, "revision_review", 2, ["approve", "revise", "prefer_baseline"], 12)
  const decisionKind = allowedValue(result?.decision?.decision, ["reply", "ignore", "escalate"])
  const decisionAnswer = typeof result?.decision?.answer === "string" ? result.decision.answer : null
  const nonIgnore = decisionKind === "reply" || decisionKind === "escalate"
  const validCommon = audit
    && typeof audit === "object"
    && !Array.isArray(audit)
    && audit.version === "evidence-binding-review-v2"
    && audit.evidencePacket
    && typeof audit.evidencePacket === "object"
    && !Array.isArray(audit.evidencePacket)
    && audit.evidencePacket.version === "2"
    && typeof audit.baselineAnswer === "string"
    && audit.firstCandidateAnswer === null
    && validGate
    && validBaselineReview
    && validRevisionReview
    && !reviews.some((review) => review?.stage === "blocked" || review?.outcome === "blocked")
  const validIgnore = decisionKind === "ignore"
    && audit?.mode === "legacy"
    && audit?.finalSource === "baseline"
    && audit?.fallbackReason === "ignore 不生成对外回复"
    && audit?.revisedCandidateAnswer === null
    && stageSequenceIs("gate")
    && decisionAnswer === ""
    && decisionAnswer === audit?.baselineAnswer
  const validBaseline = nonIgnore
    && audit?.mode === "multi_stage"
    && audit?.finalSource === "baseline"
    && audit?.fallbackReason === null
    && audit?.revisedCandidateAnswer === null
    && gate?.outcome === "pass"
    && stageSequenceIs("gate", "baseline_review")
    && baselineReview?.outcome === "approve"
    && decisionAnswer?.trim().length > 0
    && decisionAnswer === audit?.baselineAnswer
  const validRevisionSequence = (
    gate?.outcome === "issues" && stageSequenceIs("gate", "revision_review")
  ) || (
    gate?.outcome === "pass"
      && stageSequenceIs("gate", "baseline_review", "revision_review")
      && ["revise", "prefer_baseline"].includes(baselineReview?.outcome)
  )
  const validRevision = nonIgnore
    && audit?.mode === "multi_stage"
    && audit?.finalSource === "revised_candidate"
    && audit?.fallbackReason === null
    && typeof audit?.revisedCandidateAnswer === "string"
    && audit.revisedCandidateAnswer.trim().length > 0
    && revisionReview?.outcome === "approve"
    && validRevisionSequence
    && decisionAnswer === audit?.revisedCandidateAnswer
  if (!validCommon
    || (!validIgnore && !validBaseline && !validRevision)) {
    throw new RegressionAuditRejectedError()
  }
  return audit
}

export function assertRegressionComparisonConsistency(comparison) {
  const deterministicRegression = comparison?.preferred === "historical"
    || Object.values(comparison?.dimensions ?? {}).some((value) => value === -1)
  if (deterministicRegression && comparison?.regression !== true) {
    throw new RegressionComparisonRejectedError()
  }
  return comparison
}

export function assertRegressionSchemaVersion(database) {
  const rawVersion = typeof database?.schemaVersion === "function"
    ? database.schemaVersion()
    : database?.prepare?.("SELECT value FROM metadata WHERE key='schema_version'").get()?.value
  const schemaVersion = Number(rawVersion)
  if (schemaVersion !== requiredSchemaVersion) {
    throw new Error(`回归数据库 schemaVersion 必须为 ${requiredSchemaVersion}`)
  }
  return schemaVersion
}

const artifactMismatchMessage = "回归运行产物与当前源码或版本不一致，请先重新构建"
const buildManifestName = ".reply-regression-build-manifest.json"
const runtimeDependencyMaximumNodes = 20_000
const runtimeDependencyMaximumBytes = 512 * 1024 * 1024
const fixedBuildInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/build-server.mjs",
  "scripts/run-reply-regression.mjs",
  "tsconfig.build.json",
  "tsconfig.json",
]

function relativePosix(rootDirectory, filePath) {
  return path.relative(rootDirectory, filePath).split(path.sep).join("/")
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function artifactTreeFiles(directory, { include, skipDirectory = () => false }) {
  const rootStatus = await lstat(directory)
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) throw new Error(artifactMismatchMessage)
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      const relative = relativePosix(directory, entryPath)
      const value = await lstat(entryPath)
      if (value.isSymbolicLink()) throw new Error(artifactMismatchMessage)
      if (value.isDirectory()) {
        if (!skipDirectory(relative)) pending.push(entryPath)
        continue
      }
      if (!value.isFile()) throw new Error(artifactMismatchMessage)
      if (include(relative)) files.push(entryPath)
    }
  }
  return files.sort((left, right) => compareText(relativePosix(directory, left), relativePosix(directory, right)))
}

async function artifactRecord(rootDirectory, relativePath) {
  const filePath = path.join(rootDirectory, ...relativePath.split("/"))
  const value = await lstat(filePath)
  if (value.isSymbolicLink() || !value.isFile()) throw new Error(artifactMismatchMessage)
  const contents = await readFile(filePath)
  return {
    path: relativePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    contents,
  }
}

function dependencyRootIdentity(value, canonicalPath) {
  return {
    canonicalPath,
    device: value.dev,
    inode: value.ino,
    mode: value.mode,
    modifiedAt: value.mtimeMs,
    changedAt: value.ctimeMs,
  }
}

function sameDependencyRootIdentity(left, right) {
  return left.canonicalPath === right.canonicalPath
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt
}

function sameRegressionRuntimeDependencies(left, right) {
  return left.totalBytes === right.totalBytes
    && left.totalNodes === right.totalNodes
    && sameDependencyRootIdentity(left.rootIdentity, right.rootIdentity)
    && left.nodes.length === right.nodes.length
    && left.nodes.every((node, index) => {
      const other = right.nodes[index]
      if (node.type !== other?.type || node.path !== other.path) return false
      if (node.type === "directory") return true
      if (node.type === "symlink") return node.target === other.target
      return node.size === other.size
        && node.mode === other.mode
        && node.sha256 === other.sha256
    })
}

async function captureRegressionRuntimeDependencies(root, { retainContents = true } = {}) {
  const nodeModulesDirectory = path.join(root, "node_modules")
  const rootStatus = await lstat(nodeModulesDirectory)
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) throw new Error(artifactMismatchMessage)
  const canonicalNodeModules = await realpath(nodeModulesDirectory)
  const rootIdentity = dependencyRootIdentity(rootStatus, canonicalNodeModules)
  const nodes = [{ type: "directory", path: "" }]
  const pending = [{ directory: nodeModulesDirectory, relativePath: "" }]
  let totalBytes = 0
  let totalNodes = 1

  const reserveNode = (byteLength = 0) => {
    totalNodes += 1
    totalBytes += byteLength
    if (totalNodes > runtimeDependencyMaximumNodes || totalBytes > runtimeDependencyMaximumBytes) {
      throw new Error(artifactMismatchMessage)
    }
  }

  while (pending.length > 0) {
    const current = pending.pop()
    const currentStatus = await lstat(current.directory)
    const currentCanonical = await realpath(current.directory)
    if (currentStatus.isSymbolicLink() || !currentStatus.isDirectory()
      || !pathContains(canonicalNodeModules, currentCanonical)) throw new Error(artifactMismatchMessage)
    const entries = await readdir(current.directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current.directory, entry.name)
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name
      const value = await lstat(entryPath)
      if (value.isSymbolicLink()) {
        const target = await readlink(entryPath)
        if (path.isAbsolute(target)) throw new Error(artifactMismatchMessage)
        const directTarget = path.resolve(path.dirname(entryPath), target)
        if (!pathContains(nodeModulesDirectory, directTarget)) throw new Error(artifactMismatchMessage)
        const canonicalTarget = await realpath(directTarget)
        if (!pathContains(canonicalNodeModules, canonicalTarget)) throw new Error(artifactMismatchMessage)
        reserveNode(Buffer.byteLength(target))
        nodes.push({ type: "symlink", path: relativePath, target })
        continue
      }
      if (value.isDirectory()) {
        const canonicalDirectory = await realpath(entryPath)
        if (!pathContains(canonicalNodeModules, canonicalDirectory)) throw new Error(artifactMismatchMessage)
        reserveNode()
        nodes.push({ type: "directory", path: relativePath })
        pending.push({ directory: entryPath, relativePath })
        continue
      }
      if (!value.isFile()) throw new Error(artifactMismatchMessage)
      const canonicalFile = await realpath(entryPath)
      if (!pathContains(canonicalNodeModules, canonicalFile)
        || value.size > runtimeDependencyMaximumBytes - totalBytes) throw new Error(artifactMismatchMessage)
      const handle = await open(entryPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== value.dev || opened.ino !== value.ino
          || opened.size > runtimeDependencyMaximumBytes - totalBytes) throw new Error(artifactMismatchMessage)
        const contents = await handle.readFile()
        const completed = await handle.stat()
        if (completed.dev !== opened.dev || completed.ino !== opened.ino
          || completed.size !== contents.length
          || completed.mtimeMs !== opened.mtimeMs
          || completed.ctimeMs !== opened.ctimeMs) throw new Error(artifactMismatchMessage)
        reserveNode(contents.length)
        nodes.push({
          type: "file",
          path: relativePath,
          size: contents.length,
          mode: opened.mode & 0o777,
          sha256: createHash("sha256").update(contents).digest("hex"),
          ...(retainContents ? { contents } : {}),
          executable: (opened.mode & 0o111) !== 0,
        })
      } finally {
        await handle.close()
      }
    }
  }
  const completedRootStatus = await lstat(nodeModulesDirectory)
  const completedCanonicalNodeModules = await realpath(nodeModulesDirectory)
  const completedRootIdentity = dependencyRootIdentity(completedRootStatus, completedCanonicalNodeModules)
  if (completedRootStatus.isSymbolicLink() || !completedRootStatus.isDirectory()
    || !sameDependencyRootIdentity(rootIdentity, completedRootIdentity)) throw new Error(artifactMismatchMessage)
  nodes.sort((left, right) => compareText(left.path, right.path) || compareText(left.type, right.type))
  return { nodes, rootIdentity, totalBytes, totalNodes }
}

function validManifestRecords(value) {
  return Array.isArray(value)
    && value.length <= 10000
    && value.every((item) => item
      && typeof item === "object"
      && !Array.isArray(item)
      && typeof item.path === "string"
      && /^[a-zA-Z0-9._/-]+$/u.test(item.path)
      && !item.path.startsWith("/")
      && !item.path.split("/").includes("..")
      && typeof item.sha256 === "string"
      && /^[a-f0-9]{64}$/u.test(item.sha256))
}

function sameArtifactRecords(expected, actual) {
  return expected.length === actual.length
    && expected.every((item, index) => (
      item.path === actual[index]?.path && item.sha256 === actual[index]?.sha256
    ))
}

async function validatedRegressionArtifacts({
  rootDirectory = process.cwd(),
  includeRuntimeDependencies = false,
  afterRuntimeDependencyCapture = null,
} = {}) {
  try {
    const resolvedRoot = path.resolve(rootDirectory)
    const rootStatus = await lstat(resolvedRoot)
    if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) throw new Error(artifactMismatchMessage)
    const root = await realpath(resolvedRoot)
    const sourceDirectory = path.join(root, "src")
    const distDirectory = path.join(root, "dist")
    const sourceFiles = await artifactTreeFiles(sourceDirectory, {
      include: (relative) => relative.endsWith(".ts"),
    })
    const sourcePaths = sourceFiles.map((filePath) => `src/${relativePosix(sourceDirectory, filePath)}`)
    const inputPaths = [...fixedBuildInputs, ...sourcePaths].sort()
    const outputFiles = await artifactTreeFiles(distDirectory, {
      include: (relative) => relative !== buildManifestName,
      skipDirectory: (relative) => relative === "public",
    })
    const outputPaths = outputFiles.map((filePath) => `dist/${relativePosix(distDirectory, filePath)}`)
    const expectedJavaScript = sourcePaths.filter((sourcePath) => !sourcePath.endsWith(".d.ts"))
      .map((sourcePath) => `dist/${sourcePath.slice("src/".length).replace(/\.ts$/u, ".js")}`)
      .sort()
    const actualJavaScript = outputPaths.filter((outputPath) => outputPath.endsWith(".js"))
    if (outputPaths.some((outputPath) => !outputPath.endsWith(".js") && !outputPath.endsWith(".js.map"))
      || expectedJavaScript.length !== actualJavaScript.length
      || expectedJavaScript.some((value, index) => value !== actualJavaScript[index])
      || !expectedJavaScript.includes("dist/server.js")
      || !expectedJavaScript.includes("dist/version.js")
      || outputPaths.some((outputPath) => (
        outputPath.endsWith(".js.map") && !expectedJavaScript.includes(outputPath.slice(0, -4))
      ))) throw new Error(artifactMismatchMessage)

    const manifestPath = path.join(distDirectory, buildManifestName)
    const manifestStatus = await lstat(manifestPath)
    if (manifestStatus.isSymbolicLink() || !manifestStatus.isFile()) throw new Error(artifactMismatchMessage)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (manifest?.version !== 1
      || typeof manifest?.appVersion !== "string"
      || !validManifestRecords(manifest?.inputs)
      || !validManifestRecords(manifest?.outputs)) throw new Error(artifactMismatchMessage)
    const [inputs, outputs] = await Promise.all([
      Promise.all(inputPaths.map((relativePath) => artifactRecord(root, relativePath))),
      Promise.all(outputPaths.map((relativePath) => artifactRecord(root, relativePath))),
    ])
    if (!sameArtifactRecords(inputs, manifest.inputs) || !sameArtifactRecords(outputs, manifest.outputs)) {
      throw new Error(artifactMismatchMessage)
    }
    const runnerRecord = inputs.find((item) => item.path === "scripts/run-reply-regression.mjs")
    if (runnerRecord?.sha256 !== executingRegressionRunnerHash) throw new Error(artifactMismatchMessage)

    const packageRecord = inputs.find((item) => item.path === "package.json")
    const packageMetadata = JSON.parse(packageRecord?.contents.toString("utf8") ?? "")
    const sourceVersionText = inputs.find((item) => item.path === "src/version.ts")?.contents.toString("utf8") ?? ""
    const sourceVersion = sourceVersionText.match(/\bAPP_VERSION\s*=\s*["']([^"']+)["']/u)?.[1] ?? null
    const distVersionText = outputs.find((item) => item.path === "dist/version.js")?.contents.toString("utf8") ?? ""
    const distVersion = distVersionText.match(/\bAPP_VERSION\s*=\s*["']([^"']+)["']/u)?.[1] ?? null
    const versions = [packageMetadata?.version, sourceVersion, distVersion, manifest.appVersion]
    if (!versions.every((value) => typeof value === "string" && value === versions[0])) {
      throw new Error(artifactMismatchMessage)
    }
    let runtimeDependencies = null
    if (includeRuntimeDependencies) {
      runtimeDependencies = await captureRegressionRuntimeDependencies(root)
      if (afterRuntimeDependencyCapture) await afterRuntimeDependencyCapture()
      const confirmedRuntimeDependencies = await captureRegressionRuntimeDependencies(root, { retainContents: false })
      if (!sameRegressionRuntimeDependencies(runtimeDependencies, confirmedRuntimeDependencies)) {
        throw new Error(artifactMismatchMessage)
      }
    }
    return {
      root,
      outputs,
      packageJsonContents: packageRecord.contents,
      runtimeDependencies,
      version: versions[0],
    }
  } catch (error) {
    if (error?.message === artifactMismatchMessage) throw error
    throw new Error(artifactMismatchMessage)
  }
}

export async function assertRegressionArtifactConsistency(options = {}) {
  return (await validatedRegressionArtifacts(options)).version
}

async function writeRegressionRuntimeSnapshotFile(snapshotDirectory, relativePath, contents, executable = false) {
  const destinationPath = path.join(snapshotDirectory, ...relativePath.split("/"))
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
  const mode = executable ? 0o500 : 0o400
  const handle = await open(destinationPath, "wx", mode)
  try {
    await handle.writeFile(contents)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function lockRegressionRuntimeSnapshot(snapshotDirectory) {
  const directories = []
  const pending = [snapshotDirectory]
  while (pending.length > 0) {
    const current = pending.pop()
    const value = await lstat(current)
    if (value.isSymbolicLink() || !value.isDirectory()) throw new Error(artifactMismatchMessage)
    directories.push(current)
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      const entryStatus = await lstat(entryPath)
      if (entryStatus.isDirectory() && !entryStatus.isSymbolicLink()) pending.push(entryPath)
      else if (!entryStatus.isFile() && !entryStatus.isSymbolicLink()) throw new Error(artifactMismatchMessage)
    }
  }
  directories.sort((left, right) => right.length - left.length)
  for (const directory of directories) await chmod(directory, 0o500)
}

async function removeRegressionRuntimeSnapshot(snapshotDirectory) {
  const pending = [snapshotDirectory]
  while (pending.length > 0) {
    const current = pending.pop()
    let value
    try {
      value = await lstat(current)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    if (value.isSymbolicLink() || !value.isDirectory()) continue
    await chmod(current, 0o700)
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name))
    }
  }
  await rm(snapshotDirectory, { recursive: true, force: true })
}

async function materializeRegressionRuntimeSnapshot(root, outputs, packageJsonContents, runtimeDependencies) {
  const snapshotDirectory = await mkdtemp(path.join(root, ".reply-regression-runtime-"))
  try {
    await writeRegressionRuntimeSnapshotFile(snapshotDirectory, "package.json", packageJsonContents)
    await writeRegressionRuntimeSnapshotFile(
      snapshotDirectory,
      ".reply-regression-dependencies.mjs",
      'export { z } from "zod"\n',
    )
    for (const output of outputs) {
      const relativePath = output.path.slice("dist/".length)
      await writeRegressionRuntimeSnapshotFile(snapshotDirectory, relativePath, output.contents)
    }
    for (const node of runtimeDependencies.nodes.filter((item) => item.type === "directory")) {
      const destinationPath = path.join(snapshotDirectory, "node_modules", ...node.path.split("/").filter(Boolean))
      await mkdir(destinationPath, { recursive: true, mode: 0o700 })
    }
    for (const node of runtimeDependencies.nodes.filter((item) => item.type === "file")) {
      await writeRegressionRuntimeSnapshotFile(
        snapshotDirectory,
        `node_modules/${node.path}`,
        node.contents,
        node.executable,
      )
    }
    const dependencySymlinks = runtimeDependencies.nodes.filter((item) => item.type === "symlink")
    for (const node of dependencySymlinks) {
      const destinationPath = path.join(snapshotDirectory, "node_modules", ...node.path.split("/"))
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
      await symlink(node.target, destinationPath)
    }
    const snapshotNodeModules = await realpath(path.join(snapshotDirectory, "node_modules"))
    for (const node of dependencySymlinks) {
      const destinationPath = path.join(snapshotDirectory, "node_modules", ...node.path.split("/"))
      const target = await realpath(destinationPath)
      if (!pathContains(snapshotNodeModules, target)) throw new Error(artifactMismatchMessage)
    }
    await lockRegressionRuntimeSnapshot(snapshotDirectory)
    return snapshotDirectory
  } catch (error) {
    await removeRegressionRuntimeSnapshot(snapshotDirectory)
    throw error
  }
}

export async function loadRegressionRuntimeModules({
  rootDirectory = process.cwd(),
  afterRuntimeDependencyCapture = null,
  afterArtifactConsistency = null,
} = {}) {
  if (afterRuntimeDependencyCapture !== null && typeof afterRuntimeDependencyCapture !== "function") {
    throw new TypeError("afterRuntimeDependencyCapture 必须是函数")
  }
  const artifacts = await validatedRegressionArtifacts({
    rootDirectory,
    includeRuntimeDependencies: true,
    afterRuntimeDependencyCapture,
  })
  if (afterArtifactConsistency !== null) {
    if (typeof afterArtifactConsistency !== "function") throw new TypeError("afterArtifactConsistency 必须是函数")
    await afterArtifactConsistency()
  }
  const snapshotDirectory = await materializeRegressionRuntimeSnapshot(
    artifacts.root,
    artifacts.outputs,
    artifacts.packageJsonContents,
    artifacts.runtimeDependencies,
  )
  let loaded = false
  try {
    const moduleAt = (relativePath) => import(pathToFileURL(path.join(snapshotDirectory, ...relativePath.split("/"))).href)
    const [
      { z },
      { RuntimeDatabase },
      { LocalSecretVault },
      { ModelConfigService },
      { RuntimeKnowledgeService },
      { ConfiguredSecretRedactor },
      { ProjectCodeSyncService },
      { ReadonlyResourceBroker },
      { ReadonlyAgentToolBroker },
      { DirectApiAdapter },
      { CodexExecutor },
      { CodexSupportDecisionAgent },
      { SupportInvestigationService },
      { ResourceWorkspace },
      { latestAdminChatMessage },
    ] = await Promise.all([
      moduleAt(".reply-regression-dependencies.mjs"),
      moduleAt("runtime/database.js"),
      moduleAt("runtime/secret-vault.js"),
      moduleAt("runtime/model-config-service.js"),
      moduleAt("runtime/knowledge-service.js"),
      moduleAt("security/dlp.js"),
      moduleAt("git-sync/project-service.js"),
      moduleAt("diagnostics/resource-broker.js"),
      moduleAt("diagnostics/readonly-agent-tool-broker.js"),
      moduleAt("models/direct-api/direct-api-adapter.js"),
      moduleAt("codex/executor.js"),
      moduleAt("support/agent.js"),
      moduleAt("support/investigation-service.js"),
      moduleAt("support/resource-workspace.js"),
      moduleAt("admin-chat/worker.js"),
    ])
    loaded = true
    return {
      z,
      RuntimeDatabase,
      LocalSecretVault,
      ModelConfigService,
      RuntimeKnowledgeService,
      ConfiguredSecretRedactor,
      ProjectCodeSyncService,
      ReadonlyResourceBroker,
      ReadonlyAgentToolBroker,
      DirectApiAdapter,
      CodexExecutor,
      CodexSupportDecisionAgent,
      SupportInvestigationService,
      ResourceWorkspace,
      latestAdminChatMessage,
      cleanup: () => removeRegressionRuntimeSnapshot(snapshotDirectory),
    }
  } finally {
    if (!loaded) await removeRegressionRuntimeSnapshot(snapshotDirectory)
  }
}

function correctedSupportAnswer(content) {
  if (typeof content !== "string") return null
  const answerMarker = "\n人工正确回答："
  const reasonMarker = "\n纠正原因："
  if (!content.startsWith("原问题：")) return null
  const answerStart = content.indexOf(answerMarker)
  const reasonStart = content.indexOf(reasonMarker)
  if (answerStart !== content.lastIndexOf(answerMarker) || reasonStart !== content.lastIndexOf(reasonMarker)) return null
  if (answerStart < 0 || reasonStart <= answerStart + answerMarker.length) return null
  const answer = content.slice(answerStart + answerMarker.length, reasonStart).trim()
  return answer || null
}

function queryRows(database, sql, parameters = []) {
  return database.prepare(sql).all(...parameters)
}

function boundedThreadMessages(database, row) {
  if (!row?.thread_id) return []
  const messages = queryRows(database, `SELECT tm.message_event_id,tm.question_fragment,tm.position,tm.created_at AS linked_at,
      event.telegram_message_id,event.safe_text,event.attachment_summary,event.created_at,event.sender_display_name,
      event.sender_username,event.sender_user_id
    FROM support_thread_messages tm JOIN support_message_events event ON event.id=tm.message_event_id
    WHERE tm.thread_id=? ORDER BY tm.position,event.created_at,event.id,tm.question_fragment`, [row.thread_id])
  const replyCreatedAt = String(row.created_at || row.updated_at || "")
  const target = messages.filter((message) => (
    String(message.telegram_message_id) === String(row.telegram_message_id || "")
      && (!replyCreatedAt || String(message.created_at) <= replyCreatedAt)
  )).at(-1)
  if (target) {
    return messages.filter((message) => (
      Number(message.position) < Number(target.position)
      || (Number(message.position) === Number(target.position)
        && String(message.created_at) <= String(target.created_at))
    ))
  }
  return messages.filter((message) => !replyCreatedAt || String(message.created_at) <= replyCreatedAt)
}

function mappedAttachments(attachmentRows) {
  return attachmentRows.map((attachment) => ({
    name: String(attachment.file_name),
    kind: attachment.kind,
    mimeType: String(attachment.mime_type),
    size: Number(attachment.file_size),
    extractedText: String(attachment.extracted_text),
    localPath: String(attachment.storage_path || "") || null,
  }))
}

function supportAttachments(database, row, messages = boundedThreadMessages(database, row)) {
  const messageEventIds = [...new Set(messages.map((message) => String(message.message_event_id)).filter(Boolean))]
  const live = messageEventIds.length > 0
    ? queryRows(database, `SELECT file_name,mime_type,file_size,kind,storage_path,extracted_text
        FROM support_message_attachments WHERE message_event_id IN (${messageEventIds.map(() => "?").join(",")})
        ORDER BY created_at,id`, messageEventIds)
    : []
  const legacy = queryRows(database, `SELECT file_name,mime_type,file_size,kind,storage_path,extracted_text
    FROM support_attachments WHERE reply_id=? ORDER BY created_at,id`, [row.id])
  const seen = new Set()
  return mappedAttachments([...live, ...legacy]).filter((attachment) => {
    const key = [attachment.name, attachment.mimeType, attachment.size, attachment.kind,
      attachment.localPath, attachment.extractedText].join("\u0000")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function loadSupportRegressionRows(database) {
  const rawRows = queryRows(database, `SELECT r.id,'support' AS source,r.thread_id,r.service_id,r.group_id,r.status,
      r.input_revision,r.sender_role,r.telegram_message_id,r.created_at,r.updated_at,p.question,p.answer,
      g.name AS group_name,g.knowledge_scope,
      CASE WHEN r.status='corrected' THEN 1 ELSE 0 END AS corrected,
      thread.operator_style_profile_json,thread.answer_reply_style,thread.answer_binding_enabled,
      thread.answer_include_ai_memory,thread.answer_include_interface_docs,thread.answer_include_magic_book,
      CASE WHEN EXISTS(SELECT 1 FROM support_attachments legacy WHERE legacy.reply_id=r.id)
        OR EXISTS(SELECT 1 FROM support_message_attachments attachment
          JOIN support_thread_messages linked ON linked.message_event_id=attachment.message_event_id
          JOIN support_message_events attached_event ON attached_event.id=linked.message_event_id
          WHERE linked.thread_id=r.thread_id AND attached_event.created_at<=COALESCE((
            SELECT MAX(target_event.created_at) FROM support_thread_messages target_link
            JOIN support_message_events target_event ON target_event.id=target_link.message_event_id
            WHERE target_link.thread_id=r.thread_id AND target_event.telegram_message_id=r.telegram_message_id
              AND target_event.created_at<=r.created_at
          ),r.created_at) AND linked.position<=COALESCE((
            SELECT MAX(target_link.position) FROM support_thread_messages target_link
            JOIN support_message_events target_event ON target_event.id=target_link.message_event_id
            WHERE target_link.thread_id=r.thread_id AND target_event.telegram_message_id=r.telegram_message_id
              AND target_event.created_at<=r.created_at
          ),linked.position)) THEN 1 ELSE 0 END AS has_attachment,
      (SELECT event.content FROM memory_events event
        WHERE event.type='correction' AND event.reply_record_id=r.id
        ORDER BY event.occurred_at DESC,event.id DESC LIMIT 1) AS correction_content
    FROM support_replies r JOIN support_reply_payloads p ON p.reply_id=r.id
    LEFT JOIN telegram_groups g ON g.id=r.group_id
    LEFT JOIN support_threads thread ON thread.id=r.thread_id
    WHERE r.service_id IS NOT NULL AND r.status IN ('replied','escalated','corrected') AND trim(p.answer)<>''
    ORDER BY r.updated_at DESC,r.id DESC`)
  return rawRows.flatMap((row) => {
    const answer = row.status === "corrected" ? correctedSupportAnswer(row.correction_content) : String(row.answer)
    if (!answer) return []
    return [{ ...row, answer }]
  })
}

function parsedOperatorStyle(rawProfile, fallbackProfile) {
  if (typeof rawProfile !== "string" || !rawProfile.trim()) return fallbackProfile
  try {
    const parsed = JSON.parse(rawProfile)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallbackProfile
  } catch {
    return fallbackProfile
  }
}

function threadConversationContext(database, row, messages) {
  if (!row?.thread_id) return { value: "", hasThreadHistory: false }
  const previous = queryRows(database, `SELECT r.id,
      COALESCE(delivery.sent_at,r.created_at) AS sent_at,
      COALESCE(r.telegram_reply_message_id,delivery.telegram_message_id) AS telegram_reply_message_id,p.answer
    FROM support_replies r JOIN support_reply_payloads p ON p.reply_id=r.id
    LEFT JOIN (SELECT reply_id,MIN(updated_at) AS sent_at,MIN(telegram_message_id) AS telegram_message_id
      FROM telegram_output_ownership
      WHERE output_kind='support_reply' AND delivery_status='sent' AND telegram_message_id IS NOT NULL
      GROUP BY reply_id) delivery ON delivery.reply_id=r.id
    WHERE r.thread_id=? AND r.id<>? AND r.created_at<?
      AND ((delivery.sent_at IS NOT NULL AND delivery.sent_at<?)
        OR (delivery.sent_at IS NULL AND r.telegram_reply_message_id IS NOT NULL AND r.created_at<?))
      AND r.status IN ('replied','escalated','corrected') AND p.answer<>''
    ORDER BY sent_at,r.id`, [row.thread_id, row.id,
    String(row.created_at || row.updated_at || ""), String(row.created_at || row.updated_at || ""),
    String(row.created_at || row.updated_at || "")])
  if (previous.length === 0) return { value: "", hasThreadHistory: false }
  const turns = [
    ...messages.map((message) => ({
      at: String(message.created_at),
      order: Number(message.position) * 2,
      value: `[运营 ${message.created_at} message_id=${message.telegram_message_id}]\n${String(message.question_fragment).trim() || String(message.safe_text).trim()}`,
    })),
    ...previous.map((reply, index) => ({
      at: String(reply.sent_at),
      order: index * 2 + 1,
      value: `[客服 ${reply.sent_at} reply_message_id=${reply.telegram_reply_message_id || "unknown"}]\n${reply.answer}`,
    })),
  ].sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order)
  return {
    value: `【当前问题线程历史】\n\n${turns.map((turn) => turn.value).join("\n\n")}`,
    hasThreadHistory: true,
  }
}

export function buildReplayRequestContext(database, row, options = {}) {
  if (row.source === "admin") {
    const attachments = mappedAttachments(queryRows(database, `SELECT file_name,mime_type,file_size,kind,storage_path,extracted_text
      FROM admin_chat_attachments WHERE turn_id=? ORDER BY created_at,id`, [row.id]))
    return {
      attachments,
      latestMessage: typeof options.latestAdminChatMessage === "function"
        ? options.latestAdminChatMessage(String(row.question))
        : String(row.question),
      conversationContext: "",
      responseDepth: "initial",
      operatorStyleProfile: options.fallbackOperatorStyleProfile,
      answerBindingEnabled: options.fallbackAnswerBindingEnabled ?? true,
      includeAiMemory: true,
      includeInterfaceDocs: true,
      includeMagicBook: true,
      replyStyle: "human",
    }
  }
  const messages = boundedThreadMessages(database, row)
  const attachments = supportAttachments(database, row, messages)
  const conversation = threadConversationContext(database, row, messages)
  const latest = messages.at(-1)
  return {
    attachments,
    latestMessage: latest
      ? String(latest.question_fragment).trim() || String(latest.safe_text).trim()
      : String(row.question),
    conversationContext: conversation.value,
    responseDepth: conversation.hasThreadHistory ? "followup" : "initial",
    operatorStyleProfile: parsedOperatorStyle(row.operator_style_profile_json, options.fallbackOperatorStyleProfile),
    answerBindingEnabled: row.thread_id ? Boolean(row.answer_binding_enabled) : (options.fallbackAnswerBindingEnabled ?? true),
    includeAiMemory: row.thread_id ? Boolean(row.answer_include_ai_memory) : true,
    includeInterfaceDocs: row.thread_id ? Boolean(row.answer_include_interface_docs) : true,
    includeMagicBook: row.thread_id ? Boolean(row.answer_include_magic_book) : true,
    replyStyle: row.thread_id && ["human", "unrestricted"].includes(row.answer_reply_style)
      ? row.answer_reply_style
      : "human",
  }
}

async function canonicalReportDestination(reportPath) {
  const resolvedReportPath = path.resolve(reportPath)
  try {
    if ((await lstat(resolvedReportPath)).isSymbolicLink()) {
      throw new Error("回归报告路径与只读输入文件冲突")
    }
  } catch (error) {
    if (error?.message === "回归报告路径与只读输入文件冲突") throw error
    if (error?.code !== "ENOENT") throw new Error("无法校验回归报告路径隔离")
  }
  try {
    return path.join(await realpath(path.dirname(resolvedReportPath)), path.basename(resolvedReportPath))
  } catch {
    throw new Error("无法校验回归报告路径隔离")
  }
}

async function atomicWriteRegressionReport(destinationPath, contents, beforeRename) {
  const parentDirectory = await realpath(path.dirname(destinationPath))
  const temporaryPath = path.join(
    parentDirectory,
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle = null
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(contents, "utf8")
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = null
    await beforeRename()
    await rename(temporaryPath, destinationPath)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
}

export async function finalizeRegressionReport(report, reportPath, selectedCount, protectedInputs = null) {
  const initialIsolation = protectedInputs
    ? await assertRegressionOutputIsolation({ ...protectedInputs, reportPath })
    : { canonicalReportPath: await canonicalReportDestination(reportPath) }
  await atomicWriteRegressionReport(
    initialIsolation.canonicalReportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    async () => {
      const currentDestination = protectedInputs
        ? (await assertRegressionOutputIsolation({ ...protectedInputs, reportPath })).canonicalReportPath
        : await canonicalReportDestination(reportPath)
      if (currentDestination !== initialIsolation.canonicalReportPath) {
        throw new Error("无法校验回归报告路径隔离")
      }
    },
  )
  if (selectedCount === 0) throw new Error("回归发布门禁未通过：没有选中有效样本")
  if (Number(report.summary?.failed) > 0) throw new Error("回归发布门禁未通过：存在执行失败")
  if (Number(report.summary?.regressions) > 0) throw new Error("回归发布门禁未通过：存在明确退步")
}

export async function assertRegressionMasterKey(masterKeyPath) {
  try {
    const key = await readFile(path.resolve(masterKeyPath))
    if (key.length !== 32) throw new Error("invalid key length")
  } catch {
    throw new Error("回归主密钥副本不可读取或格式错误")
  }
}

function roundRobinStrata(strata, maximumSamples) {
  const selected = []
  const seen = new Set()
  const maximumStratumLength = Math.max(0, ...strata.map((stratum) => stratum.length))
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
  return selected
}

async function runRegression(argv = process.argv.slice(2), environment = process.env) {
  if (argv.includes("--help")) {
    process.stdout.write(usage)
    return
  }
  const parsed = parseRegressionArguments(argv, environment)
  await assertRegressionOutputIsolation(parsed)
  const runtime = await loadRegressionRuntimeModules({ rootDirectory: process.cwd() })
  const {
    z,
    RuntimeDatabase,
    LocalSecretVault,
    ModelConfigService,
    RuntimeKnowledgeService,
    ConfiguredSecretRedactor,
    ProjectCodeSyncService,
    ReadonlyResourceBroker,
    ReadonlyAgentToolBroker,
    DirectApiAdapter,
    CodexExecutor,
    CodexSupportDecisionAgent,
    SupportInvestigationService,
    ResourceWorkspace,
    latestAdminChatMessage,
  } = runtime

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

  let database
  let executor
  try {
    database = openRegressionDatabase(RuntimeDatabase, parsed.databasePath)
    const schemaVersion = assertRegressionSchemaVersion(database)
    await assertRegressionMasterKey(parsed.masterKeyPath)
    const vault = await LocalSecretVault.open(path.resolve(parsed.masterKeyPath))
    const config = new ModelConfigService(database, vault)
    const redactor = new ConfiguredSecretRedactor(database, () => config.listConfiguredSecrets())
    const knowledge = new RuntimeKnowledgeService(database, redactor)
    const direct = new DirectApiAdapter(fetch, new ReadonlyAgentToolBroker((value) => redactor.redact(value).text))
    executor = new CodexExecutor(config, undefined, direct)
    const agent = new CodexSupportDecisionAgent(executor)
    const investigation = new SupportInvestigationService({
      database,
      codeSync: new ProjectCodeSyncService(database, path.resolve(parsed.runtimeDirectory)),
      knowledge,
      resourceWorkspace: new ResourceWorkspace(database),
      redactor,
      agent,
      resourceBroker: new ReadonlyResourceBroker(database),
    })

    function rows(sql, parameters = []) {
      return database.prepare(sql).all(...parameters)
    }

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

    const supportRows = loadSupportRegressionRows(database)
    const adminRows = rows(adminBase)
    const newestFirst = (left, right) => String(right.updated_at).localeCompare(String(left.updated_at))
      || String(right.id).localeCompare(String(left.id))
    const limited = (values, count, comparator = newestFirst) => [...values].sort(comparator).slice(0, count)

    let selected
    if (parsed.focusCaseIds.length > 0) {
      selected = selectFocusedRegressionRows(supportRows, adminRows, parsed.focusCaseIds)
    } else {
      const strata = [
        limited(supportRows.filter((row) => row.status === "corrected"), 6),
        limited(supportRows.filter((row) => row.status === "escalated"), 3),
        limited(supportRows.filter((row) => row.has_attachment), 3),
        limited(supportRows.filter((row) => Number(row.input_revision ?? 1) > 1), 3),
        limited(supportRows, 3, (left, right) => String(right.answer).length - String(left.answer).length || newestFirst(left, right)),
        limited(supportRows, 5),
        limited(adminRows.filter((row) => row.corrected), 3),
        limited(adminRows.filter((row) => row.has_attachment), 3),
        limited(adminRows, 5),
      ]
      selected = roundRobinStrata(strata, parsed.maximumSamples)
    }

    const binding = config.getBinding("answer")
    const modelSnapshot = config.getModelInstanceSnapshot(binding.modelInstanceId)
    const operatorStyle = database.readActiveOperatorStyle()
    const report = {
      generatedAt: new Date().toISOString(),
      schemaVersion,
      replayMode: "historical_input_current_code_model",
      corpus: {
        supportCompleted: supportRows.length,
        adminCompleted: adminRows.length,
        supportCorrected: supportRows.filter((row) => row.corrected).length,
        adminCorrected: adminRows.filter((row) => row.corrected).length,
      },
      requestedSamples: parsed.focusCaseIds.length || parsed.maximumSamples,
      focused: parsed.focusCaseIds.length > 0,
      cases: [],
    }

    async function compare(row, result) {
      const prompt = [
        "你是客服回复回归评测员，只输出结构化 JSON。比较同一个历史问题的历史有效回复和新流水线回复。",
        "证据包和新调查结果优先于历史客服判断；历史回复只作为当前版本表现基线，不能冒充本轮运行证据。",
        "每个维度填 -1 表示新回复更差，0 表示相当，1 表示更好。只有出现明确、可复核的退步时 regression=true；不能因措辞不同判退步。preferred=historical 或 factualGrounding、completeness、requestFit、recipientClarity、evidenceUse、safetyBoundary 任一维度为 -1 都属于明确退步，此时 regression 必须为 true。",
        "重点检查事实来源、已确认与推断边界、必要原因和当前状态是否完整、是否回应最新诉求、第三方沟通是否明确接收方并包含我方证据、是否只追问最少信息、是否泄漏敏感信息或越权承诺。",
        `问题：${row.question}`,
        `历史有效回复：${row.answer}`,
        `新流水线回复：${result.decision.answer}`,
        `新证据包：${JSON.stringify(result.pipelineAudit.evidencePacket)}`,
        `新业务判断：${JSON.stringify({
          decision: result.decision.decision,
          escalationType: result.decision.escalationType,
          responsibility: result.decision.responsibility,
        })}`,
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

    for (let index = 0; index < selected.length; index += 1) {
      const row = selected[index]
      const startedAt = Date.now()
      const caseId = regressionCaseId(row)
      try {
        const question = String(row.question)
        const replayContext = buildReplayRequestContext(database, row, {
          fallbackOperatorStyleProfile: operatorStyle.profile,
          fallbackAnswerBindingEnabled: binding.enabled,
          latestAdminChatMessage,
        })
        row.has_attachment = replayContext.attachments.length > 0 ? 1 : 0
        const result = await investigation.investigate({
          serviceId: String(row.service_id),
          groupName: String(row.group_name || "历史客服群"),
          question,
          latestMessage: replayContext.latestMessage,
          ...(replayContext.conversationContext ? { conversationContext: replayContext.conversationContext } : {}),
          responseDepth: replayContext.responseDepth,
          senderRole: row.sender_role || null,
          scope: String(row.knowledge_scope || "global"),
          attachments: replayContext.attachments,
          answerTimeoutSeconds: binding.timeoutSeconds,
          operatorStyleProfile: replayContext.operatorStyleProfile,
          modelInstanceId: binding.modelInstanceId,
          modelSnapshot,
          answerMaxConcurrency: binding.maxConcurrency,
          answerBindingEnabled: replayContext.answerBindingEnabled,
          includeAiMemory: replayContext.includeAiMemory,
          includeInterfaceDocs: replayContext.includeInterfaceDocs,
          includeMagicBook: replayContext.includeMagicBook,
          replyStyle: replayContext.replyStyle,
        }, new AbortController().signal)
        const comparison = await compare(row, result)
        report.cases.push(buildSuccessfulRegressionCase({
          row,
          caseId,
          result,
          comparison,
          durationMs: Date.now() - startedAt,
        }))
      } catch (error) {
        report.cases.push(buildFailedRegressionCase({
          row,
          caseId,
          error,
          durationMs: Date.now() - startedAt,
        }))
      }
      process.stdout.write(`CASE ${index + 1}/${selected.length} ${caseId} completed\n`)
    }

    report.summary = summarizeRegressionCases(report.cases)
    await finalizeRegressionReport(report, parsed.reportPath, selected.length, parsed)
    process.stdout.write(`SUMMARY ${JSON.stringify(report.summary)}\n`)
  } finally {
    try {
      if (executor) await executor.shutdown()
    } finally {
      try {
        if (database) database.close()
      } finally {
        await runtime.cleanup()
      }
    }
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  runRegression().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "未知错误"}\n`)
    process.exitCode = 1
  })
}
