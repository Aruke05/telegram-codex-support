import { randomUUID } from "node:crypto"

import type { RuntimeDatabase } from "../runtime/database.js"
import { redactText } from "../security/dlp.js"
import type { ShadowReportResult, ShadowReportSample } from "./shadow-report-agent.js"

type SqlRow = Record<string, unknown>
export type ShadowReportStatus = "pending" | "running" | "completed" | "failed"
export type ShadowLearningReport = {
  id: string
  triggerType: "scheduled" | "manual"
  dueAt: string
  cutoffAt: string
  status: ShadowReportStatus
  sampleCount: number
  renderedMarkdown: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}
export type ClaimedShadowReport = ShadowLearningReport & { claimToken: string }

function reportFromRow(row: SqlRow): ShadowLearningReport {
  return {
    id: String(row.id), triggerType: row.trigger_type as "scheduled" | "manual",
    dueAt: String(row.due_at), cutoffAt: String(row.cutoff_at), status: row.status as ShadowReportStatus,
    sampleCount: Number(row.sample_count), renderedMarkdown: row.rendered_markdown === null ? null : String(row.rendered_markdown),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function render(result: ShadowReportResult, samples: ShadowReportSample[]): string {
  const byId = new Map(samples.map((sample) => [sample.sampleId, sample]))
  const lines = [`# 学习模式对比报告`, "", result.summary.headline]
  if (result.summary.strengths.length) lines.push("", "## 已有优势", ...result.summary.strengths.map((item) => `- ${item}`))
  if (result.summary.gaps.length) lines.push("", "## 主要差距", ...result.summary.gaps.map((item) => `- ${item}`))
  if (result.summary.recommendations.length) lines.push("", "## 人工审核建议", ...result.summary.recommendations.map((item) => `- ${item}`))
  for (const comparison of result.comparisons) {
    const sample = byId.get(comparison.sampleId)
    lines.push("", `## 问题：${sample?.question ?? comparison.sampleId}`,
      "", `准确性 ${comparison.accuracyScore} / 可靠性 ${comparison.reliabilityScore} / 拟人性 ${comparison.humanLikenessScore}`,
      "", `影子回答：${sample?.shadowAnswer || "无"}`,
      "", `真人参考：${sample?.humanAnswers.map((answer) => answer.text).join("\n") || "无"}`)
    const findings = [...comparison.sharedConclusions, ...comparison.factualGaps, ...comparison.reliabilityFindings, ...comparison.styleFindings]
    if (findings.length) lines.push("", ...findings.map((item) => `- ${item}`))
    if (comparison.recommendations.length) lines.push("", ...comparison.recommendations.map((item) => `- 建议：${item}`))
  }
  return lines.join("\n")
}

function sanitizeResult(result: ShadowReportResult): ShadowReportResult {
  const texts = (values: string[]) => values.map((value) => redactText(value).text)
  return {
    summary: {
      headline: redactText(result.summary.headline).text,
      strengths: texts(result.summary.strengths),
      gaps: texts(result.summary.gaps),
      recommendations: texts(result.summary.recommendations),
    },
    comparisons: result.comparisons.map((comparison) => ({
      ...comparison,
      sharedConclusions: texts(comparison.sharedConclusions),
      factualGaps: texts(comparison.factualGaps),
      reliabilityFindings: texts(comparison.reliabilityFindings),
      styleFindings: texts(comparison.styleFindings),
      recommendations: texts(comparison.recommendations),
    })),
  }
}

export class ShadowReportStore {
  constructor(private readonly database: RuntimeDatabase) {}

  list(): ShadowLearningReport[] {
    return (this.database.prepare("SELECT * FROM shadow_learning_reports ORDER BY created_at DESC,id DESC").all() as SqlRow[])
      .map(reportFromRow)
  }

  get(id: string): ShadowLearningReport {
    const row = this.database.prepare("SELECT * FROM shadow_learning_reports WHERE id=?").get(id) as SqlRow | undefined
    if (!row) throw new Error("学习报告不存在")
    return reportFromRow(row)
  }

  detail(id: string): { report: ShadowLearningReport; comparisons: Array<Record<string, unknown>> } {
    const report = this.get(id)
    const rows = this.database.prepare(`SELECT comparison.* FROM shadow_comparisons comparison
      WHERE comparison.report_id=? ORDER BY comparison.created_at,comparison.id`).all(id) as SqlRow[]
    return {
      report,
      comparisons: rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        inputRevision: Number(row.input_revision),
        question: row.question_snapshot,
        shadowAnswer: row.shadow_answer_snapshot,
        humanAnswers: JSON.parse(String(row.human_answers_json)) as unknown,
        humanMessageEventIds: JSON.parse(String(row.human_message_event_ids_json)) as unknown,
        comparison: JSON.parse(String(row.comparison_json)) as unknown,
      })),
    }
  }

  createManual(now: Date): ShadowLearningReport {
    const timestamp = now.toISOString()
    const id = randomUUID()
    this.database.prepare(`INSERT INTO shadow_learning_reports(
      id,trigger_type,due_at,cutoff_at,status,claim_token,attempt_count,sample_count,
      summary_json,rendered_markdown,error_message,started_at,completed_at,created_at,updated_at
    ) VALUES (?,'manual',?,?,'pending',NULL,0,0,NULL,NULL,NULL,NULL,NULL,?,?)`)
      .run(id, timestamp, timestamp, timestamp, timestamp)
    return this.get(id)
  }

  recoverStale(now = new Date(), leaseMs = 2 * 60 * 60 * 1000): number {
    const timestamp = now.toISOString()
    const staleBefore = new Date(now.getTime() - leaseMs).toISOString()
    const changed = this.database.prepare(`UPDATE shadow_learning_reports SET status='pending',claim_token=NULL,
      error_message='上次生成进程中断，已重新排队',started_at=NULL,updated_at=?
      WHERE status='running' AND updated_at<?`).run(timestamp, staleBefore)
    return Number(changed.changes)
  }

  heartbeat(claim: ClaimedShadowReport, now = new Date()): boolean {
    const changed = this.database.prepare(`UPDATE shadow_learning_reports SET updated_at=?
      WHERE id=? AND status='running' AND claim_token=?`).run(now.toISOString(), claim.id, claim.claimToken)
    return Number(changed.changes) === 1
  }

  claimDue(now: Date, reportId?: string): ClaimedShadowReport | null {
    const timestamp = now.toISOString()
    return this.database.transaction(() => {
      const row = this.database.prepare(`SELECT * FROM shadow_learning_reports
        WHERE status='pending' AND due_at<=? ${reportId ? "AND id=?" : ""}
        ORDER BY due_at,id LIMIT 1`).get(...(reportId ? [timestamp, reportId] : [timestamp])) as SqlRow | undefined
      if (!row) return null
      const token = randomUUID()
      const changed = this.database.prepare(`UPDATE shadow_learning_reports SET status='running',claim_token=?,
        attempt_count=attempt_count+1,started_at=?,updated_at=?,error_message=NULL WHERE id=? AND status='pending'`)
        .run(token, timestamp, timestamp, String(row.id))
      if (Number(changed.changes) !== 1) return null
      return { ...this.get(String(row.id)), claimToken: token }
    })
  }

  samples(cutoffAt: string): ShadowReportSample[] {
    const results = this.database.prepare(`SELECT result.*,payload.question FROM shadow_answer_results result
      JOIN support_threads thread ON thread.id=result.thread_id AND thread.answer_operation_mode='learning'
      JOIN support_reply_payloads payload ON payload.reply_id=result.reply_id
      WHERE result.created_at<=? ORDER BY result.created_at,result.id`).all(cutoffAt) as SqlRow[]
    return results.map((row) => {
      const human = this.database.prepare(`SELECT link.human_message_event_id,event.safe_text,link.match_confidence
        FROM shadow_human_answer_links link JOIN support_message_events event ON event.id=link.human_message_event_id
        WHERE link.thread_id=? AND link.input_revision=? AND link.created_at<=?
        ORDER BY event.created_at,event.id`).all(String(row.thread_id), Number(row.input_revision), cutoffAt) as SqlRow[]
      return {
        sampleId: String(row.id), threadId: String(row.thread_id), inputRevision: Number(row.input_revision),
        question: redactText(String(row.question)).text, shadowOutcome: row.outcome_status as "completed" | "failed",
        shadowDecision: row.decision as ShadowReportSample["shadowDecision"], shadowAnswer: String(row.answer),
        shadowReason: row.reason === null ? null : String(row.reason),
        humanAnswers: human.map((item) => ({
          messageEventId: String(item.human_message_event_id), text: redactText(String(item.safe_text)).text,
          confidence: Number(item.match_confidence),
        })),
      }
    })
  }

  complete(claim: ClaimedShadowReport, samples: ShadowReportSample[], result: ShadowReportResult, now = new Date()): ShadowLearningReport {
    result = sanitizeResult(result)
    const timestamp = now.toISOString()
    const markdown = render(result, samples)
    this.database.transaction(() => {
      const insert = this.database.prepare(`INSERT INTO shadow_comparisons(
        id,report_id,shadow_result_id,thread_id,input_revision,question_snapshot,shadow_answer_snapshot,
        human_answers_json,human_message_event_ids_json,comparison_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      const samplesById = new Map(samples.map((sample) => [sample.sampleId, sample]))
      result.comparisons.forEach((comparison) => {
        const sample = samplesById.get(comparison.sampleId)
        if (!sample) throw new Error("学习报告引用了未知样本")
        insert.run(randomUUID(), claim.id, sample.sampleId, sample.threadId, sample.inputRevision,
          sample.question, sample.shadowAnswer, JSON.stringify(sample.humanAnswers),
          JSON.stringify(sample.humanAnswers.map((answer) => answer.messageEventId)), JSON.stringify(comparison), timestamp)
      })
      const changed = this.database.prepare(`UPDATE shadow_learning_reports SET status='completed',claim_token=NULL,
        sample_count=?,summary_json=?,rendered_markdown=?,completed_at=?,updated_at=?
        WHERE id=? AND status='running' AND claim_token=?`).run(
        samples.length, JSON.stringify(result.summary), markdown, timestamp, timestamp, claim.id, claim.claimToken,
      )
      if (Number(changed.changes) !== 1) throw new Error("学习报告 claim 已失效")
    })
    return this.get(claim.id)
  }

  fail(claim: ClaimedShadowReport, error: unknown, now = new Date()): void {
    const timestamp = now.toISOString()
    this.database.prepare(`UPDATE shadow_learning_reports SET status='failed',claim_token=NULL,error_message=?,
      completed_at=?,updated_at=? WHERE id=? AND status='running' AND claim_token=?`).run(
      (error instanceof Error ? error.message : "学习报告生成失败").slice(0, 1000), timestamp, timestamp, claim.id, claim.claimToken,
    )
  }
}
