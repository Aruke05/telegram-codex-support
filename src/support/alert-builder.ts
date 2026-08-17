import { codeSyncErrorLabel, codeSyncStageLabel, type CodeSyncFailure } from "../git-sync/project-errors.js"
import type { ProjectCodeSnapshot } from "../git-sync/project-service.js"

export type TechnicalAlertDetail = {
  replyId: string
  service: string
  groupName: string
  operatorAnswer?: string
  messages: Array<{
    sender: string
    createdAt: string
    text: string
    attachmentSummary: string
  }>
}

export type CodeSyncTechnicalAlertDetail = TechnicalAlertDetail & {
  branch: string
  batchId: string
  failure: CodeSyncFailure
  snapshot: ProjectCodeSnapshot | null
  additionalReason?: string
}

const telegramMessageLimit = 3900
const bodyChunkSize = 2800

function time(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(11, 16) : "--:--"
}

function split(value: string): string[] {
  if (!value) return ["（无可展示内容）"]
  const chunks: string[] = []
  for (let offset = 0; offset < value.length; offset += bodyChunkSize) chunks.push(value.slice(offset, offset + bodyChunkSize))
  return chunks
}

export function buildTechnicalAlert(detail: TechnicalAlertDetail, reason: string): string[] {
  const original = detail.messages.map((message) => [
    `[${message.sender.slice(0, 120)} ${time(message.createdAt)}]`,
    message.text,
    message.attachmentSummary ? `附件：${message.attachmentSummary}` : "",
  ].filter(Boolean).join("\n")).join("\n\n")
  const parts = split(original)
  return parts.map((body, index) => {
    const heading = parts.length === 1 ? "原问题" : `原问题（续 ${index + 1}/${parts.length}）`
    const header = [
      "AI 客服告警",
      `服务：${detail.service.slice(0, 120)}`,
      `来源群：${detail.groupName.slice(0, 160)}`,
      `原因：${reason.slice(0, 500)}`,
      ...(detail.operatorAnswer ? [`运营回复：${detail.operatorAnswer.slice(0, 500)}`] : []),
      `记录：${detail.replyId.slice(0, 120)}`,
      `${heading}：`,
    ].join("\n")
    const remaining = Math.max(0, telegramMessageLimit - header.length - 1)
    return `${header}\n${body.slice(0, remaining)}`
  })
}

export function buildCodeSyncTechnicalAlert(detail: CodeSyncTechnicalAlertDetail): string[] {
  const original = detail.messages.map((message) => [
    `[${message.sender.slice(0, 120)} ${time(message.createdAt)}]`,
    message.text,
    message.attachmentSummary ? `附件：${message.attachmentSummary}` : "",
  ].filter(Boolean).join("\n")).join("\n\n")
  const parts = split(original)
  const repository = detail.failure.repositoryRole
    ? `${detail.failure.repositoryRole === "backend" ? "后端" : "前端"} ${detail.failure.repositoryName ?? "仓库"}`
    : "服务双仓"
  const snapshotLines = detail.snapshot ? [
    `旧快照：${detail.snapshot.publishedAt.replace("T", " ").slice(0, 16)}`,
    ...detail.snapshot.repositories.map((item) => `${item.role === "backend" ? "后端" : "前端"}：${item.commit.slice(0, 8)}`),
  ] : ["旧快照：未找到同服务、同分支、同仓库组合的完整历史快照，已停止代码回答"]
  return parts.map((body, index) => {
    const heading = parts.length === 1 ? "原问题" : `原问题（续 ${index + 1}/${parts.length}）`
    const header = [
      "代码同步失败",
      detail.snapshot ? "处理：已使用历史完整快照继续回答" : "处理：没有可用完整快照，已停止代码回答",
      `服务：${detail.service.slice(0, 120)}`,
      `来源群：${detail.groupName.slice(0, 160)}`,
      `分支：${detail.branch.slice(0, 160)}`,
      `失败组件：${repository}`,
      `失败阶段：${codeSyncStageLabel(detail.failure.stage)}`,
      `错误分类：${codeSyncErrorLabel(detail.failure.errorType)}`,
      `安全摘要：${detail.failure.safeSummary.slice(0, 500)}`,
      ...snapshotLines,
      ...(detail.additionalReason ? [`处理判断：${detail.additionalReason.slice(0, 500)}`] : []),
      `记录：${detail.replyId.slice(0, 120)}`,
      `同步批次：${detail.batchId.slice(0, 120)}`,
      `${heading}：`,
    ].join("\n")
    const remaining = Math.max(0, telegramMessageLimit - header.length - 1)
    return `${header}\n${body.slice(0, remaining)}`
  })
}
