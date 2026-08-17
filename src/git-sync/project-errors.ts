import type { RunResult } from "./types.js"

export type CodeSyncStage =
  | "validate_config"
  | "prepare_repository"
  | "resolve_remote"
  | "fetch"
  | "resolve_commit"
  | "export_snapshot"
  | "validate_snapshot"
  | "publish_snapshot"

export type CodeSyncErrorType =
  | "configuration_invalid"
  | "directory_missing"
  | "not_git_repository"
  | "remote_mismatch"
  | "authentication_failed"
  | "dns_failed"
  | "network_unreachable"
  | "timeout"
  | "branch_not_found"
  | "repository_locked"
  | "disk_full"
  | "permission_denied"
  | "invalid_commit"
  | "snapshot_invalid"
  | "process_interrupted"
  | "unknown"

export type CodeSyncFailure = {
  repositoryRole: "backend" | "frontend" | null
  repositoryName: string | null
  stage: CodeSyncStage
  errorType: CodeSyncErrorType
  exitCode: number | null
  safeSummary: string
}

const stageLabels: Record<CodeSyncStage, string> = {
  validate_config: "校验配置",
  prepare_repository: "准备仓库",
  resolve_remote: "核对远端",
  fetch: "拉取远端",
  resolve_commit: "解析提交",
  export_snapshot: "导出快照",
  validate_snapshot: "校验快照",
  publish_snapshot: "发布快照",
}

const errorLabels: Record<CodeSyncErrorType, string> = {
  configuration_invalid: "配置不完整",
  directory_missing: "目录不存在",
  not_git_repository: "目录不是 Git 仓库",
  remote_mismatch: "仓库远端与配置不一致",
  authentication_failed: "仓库认证失败",
  dns_failed: "域名解析失败",
  network_unreachable: "网络无法连接",
  timeout: "操作超时",
  branch_not_found: "分支不存在",
  repository_locked: "仓库被其他任务锁定",
  disk_full: "磁盘空间不足",
  permission_denied: "目录权限不足",
  invalid_commit: "提交解析无效",
  snapshot_invalid: "快照内容不完整",
  process_interrupted: "同步进程中断",
  unknown: "未知错误",
}

export function codeSyncStageLabel(stage: CodeSyncStage): string {
  return stageLabels[stage]
}

export function codeSyncErrorLabel(errorType: CodeSyncErrorType): string {
  return errorLabels[errorType]
}

function component(role: CodeSyncFailure["repositoryRole"], name: string | null): string {
  if (!role) return "服务代码"
  return `${role === "backend" ? "后端" : "前端"}${name ? ` ${name}` : "仓库"}`
}

export function failure(input: Omit<CodeSyncFailure, "safeSummary"> & { safeSummary?: string }): CodeSyncFailure {
  return {
    ...input,
    safeSummary: input.safeSummary ?? `${component(input.repositoryRole, input.repositoryName)}在${stageLabels[input.stage]}阶段失败：${errorLabels[input.errorType]}`,
  }
}

export function classifyCommandFailure(
  role: CodeSyncFailure["repositoryRole"],
  repositoryName: string | null,
  stage: CodeSyncStage,
  result: RunResult,
): CodeSyncFailure {
  const detail = `${result.stderr}\n${result.stdout}`.toLocaleLowerCase("en-US")
  let errorType: CodeSyncErrorType = "unknown"
  if (result.timedOut) errorType = "timeout"
  else if (/could not resolve host|name or service not known|nodename nor servname provided/u.test(detail)) errorType = "dns_failed"
  else if (/couldn't find remote ref|remote ref does not exist|unknown revision|invalid refspec/u.test(detail)) errorType = "branch_not_found"
  else if (/authentication failed|could not read username|permission denied \(publickey\)|repository not found/u.test(detail)) errorType = "authentication_failed"
  else if (/index\.lock|cannot lock ref|unable to create .*\.lock|another git process/u.test(detail)) errorType = "repository_locked"
  else if (/no space left on device|disk full/u.test(detail)) errorType = "disk_full"
  else if (/permission denied|operation not permitted/u.test(detail)) errorType = "permission_denied"
  else if (/failed to connect|network is unreachable|connection refused|connection reset|connection timed out|could not read from remote repository/u.test(detail)) errorType = "network_unreachable"
  return failure({ repositoryRole: role, repositoryName, stage, errorType, exitCode: result.exitCode })
}

export class CodeSyncOperationError extends Error {
  constructor(readonly failure: CodeSyncFailure) {
    super(failure.safeSummary)
    this.name = "CodeSyncOperationError"
  }
}

export class ProjectCodeSyncUnavailableError extends Error {
  constructor(readonly batchId: string, readonly failure: CodeSyncFailure) {
    super("没有可用的完整代码快照")
    this.name = "ProjectCodeSyncUnavailableError"
  }
}
