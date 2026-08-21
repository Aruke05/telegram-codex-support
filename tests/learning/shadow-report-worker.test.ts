import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ShadowReportStore } from "../../src/learning/shadow-report-store.js"
import type { ShadowReportResult, ShadowReportSample } from "../../src/learning/shadow-report-agent.js"
import { partitionShadowReportSamples, ShadowReportWorker } from "../../src/learning/shadow-report-worker.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const databases: RuntimeDatabase[] = []
const directories: string[] = []

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "shadow-report-"))
  directories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  databases.push(database)
  return database
}

const fixtureTimestamp = "2026-08-19T10:00:00.000Z"
const fixtureCutoff = new Date("2026-08-19T10:30:00.000Z")

function seedReportScope(database: RuntimeDatabase): void {
  database.prepare(`INSERT INTO projects(
    id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at
  ) VALUES ('project','project','项目','',1,'default',?,?)`).run(fixtureTimestamp, fixtureTimestamp)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES ('service','project','service','服务','','Asia/Shanghai',NULL,'main',1,?,?)`)
    .run(fixtureTimestamp, fixtureTimestamp)
  database.prepare(`INSERT INTO telegram_groups(
    id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,
    platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,ai_model_instance_id,
    reply_style,operation_mode,created_at,updated_at
  ) VALUES ('group','group','学习群','-1001',NULL,'project','service',0,'bot','all',
    'service','[]',NULL,NULL,'none','default','support',NULL,'human','learning',?,?)`)
    .run(fixtureTimestamp, fixtureTimestamp)
}

function seedShadowSample(
  database: RuntimeDatabase,
  index: number,
  input: { question?: string; humanAnswer?: string | null } = {},
): string {
  const suffix = String(index).padStart(4, "0")
  const threadId = `thread-${suffix}`
  const replyId = `reply-${suffix}`
  const resultId = `result-${suffix}`
  database.prepare(`INSERT INTO support_threads(
    id,group_id,project_id,service_id,status,revision,settle_at,anchor_message_id,latest_message_at,
    summary,answer_operation_mode,created_at,updated_at
  ) VALUES (?,'group','project','service','answered',1,? ,?,?,'问题','learning',?,?)`)
    .run(threadId, fixtureTimestamp, `message-${suffix}`, fixtureTimestamp, fixtureTimestamp, fixtureTimestamp)
  database.prepare(`INSERT INTO support_replies(
    id,thread_id,input_revision,group_id,project_id,service_id,service,service_source,decision,status,
    created_at,updated_at
  ) VALUES (?,?,1,'group','project','service','service','group_binding','reply','replied',?,?)`)
    .run(replyId, threadId, fixtureTimestamp, fixtureTimestamp)
  database.prepare(`INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text,has_attachment)
    VALUES (?,?,'影子回答',NULL,0)`).run(replyId, input.question ?? `问题 ${index}`)
  database.prepare(`INSERT INTO shadow_answer_results(
    id,reply_id,thread_id,input_revision,outcome_status,decision,answer,quote_text,reason,confidence,
    code_revision,memory_version_refs_json,simulated_action,output_redacted,error_code,created_at,updated_at
  ) VALUES (?,?,?,1,'completed','reply','影子回答',NULL,'依据',0.8,NULL,'[]','reply',0,NULL,?,?)`)
    .run(resultId, replyId, threadId, fixtureTimestamp, fixtureTimestamp)
  if (input.humanAnswer !== null) {
    const eventId = `event-${suffix}`
    const observationId = `observation-${suffix}`
    database.prepare(`INSERT INTO support_message_events(
      id,group_id,account_id,telegram_message_id,reply_to_message_id,message_thread_id,media_group_id,
      sender_user_id,sender_username,sender_display_name,sender_role,safe_text,attachment_summary,
      ingest_batch_id,route_status,skip_reason,created_at
    ) VALUES (?,'group',NULL,?,NULL,NULL,NULL,?,'operator','客服','operator',?,'',NULL,'role_skipped','configured_role',?)`)
      .run(eventId, `human-message-${suffix}`, String(10_000 + index), input.humanAnswer ?? `真人回答 ${index}`, fixtureTimestamp)
    database.prepare(`INSERT INTO learning_source_observations(
      id,message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,
      association_confidence,takeover_status,classification,risk,processing_status,attempt_count,
      lock_token,locked_at,current_run_id,created_at,updated_at
    ) VALUES (?,?,?,'operator',?,'service','direct_question',1,'thread_already_terminal',
      'shadow_reference_reply','low','ignored',0,NULL,NULL,NULL,?,?)`)
      .run(observationId, eventId, String(10_000 + index), threadId, fixtureTimestamp, fixtureTimestamp)
    database.prepare(`INSERT INTO shadow_human_answer_links(
      id,observation_id,human_message_event_id,thread_id,input_revision,shadow_result_id,
      match_reason,match_confidence,created_at
    ) VALUES (?,?,?,?,1,?,'direct',1,?)`)
      .run(`link-${suffix}`, observationId, eventId, threadId, resultId, fixtureTimestamp)
  }
  return resultId
}

function generatedReport(samples: ShadowReportSample[]): ShadowReportResult {
  return {
    summary: { headline: "批次完成", strengths: ["准确"], gaps: [], recommendations: [] },
    comparisons: samples.map((sample) => ({
      sampleId: sample.sampleId,
      accuracyScore: 90,
      reliabilityScore: 85,
      humanLikenessScore: 80,
      sharedConclusions: [],
      factualGaps: [],
      reliabilityFindings: [],
      styleFindings: [],
      recommendations: [],
    })),
  }
}

describe("影子学习报告调度", () => {
  it("首份报告只在 2026-08-20 23:00 Asia/Shanghai 到期一次", async () => {
    const database = await openDatabase()
    const store = new ShadowReportStore(database)
    const generate = vi.fn(async () => ({
      summary: {
        headline: "当前没有可比较样本",
        strengths: [],
        gaps: [],
        recommendations: [],
      },
      comparisons: [],
    }))
    const worker = new ShadowReportWorker(store, { generate })

    expect(await worker.runDue(new Date("2026-08-20T14:59:59.999Z"))).toBe(false)
    expect(generate).not.toHaveBeenCalled()
    expect(await worker.runDue(new Date("2026-08-20T15:00:00.000Z"))).toBe(true)
    expect(await worker.runDue(new Date("2026-08-21T15:00:00.000Z"))).toBe(false)
    expect(generate).not.toHaveBeenCalled()
    expect(store.list()[0]).toMatchObject({
      triggerType: "scheduled",
      dueAt: "2026-08-20T15:00:00.000Z",
      cutoffAt: "2026-08-20T15:00:00.000Z",
      status: "completed",
    })
  })

  it("手动生成另建报告且不修改固定计划", async () => {
    const database = await openDatabase()
    const store = new ShadowReportStore(database)
    const worker = new ShadowReportWorker(store, {
      generate: async () => ({
        summary: { headline: "手动报告", strengths: [], gaps: [], recommendations: [] },
        comparisons: [],
      }),
    })
    const at = new Date("2026-08-19T10:00:00.000Z")

    const report = await worker.runNow(at)

    expect(report.status).toBe("completed")
    expect(store.list().map((item) => item.triggerType).sort()).toEqual(["manual", "scheduled"])
    expect(store.list().find((item) => item.triggerType === "scheduled")).toMatchObject({ status: "pending" })
  })

  it("报告完成时间使用生成结束时钟而不是领取时间", async () => {
    const database = await openDatabase()
    const store = new ShadowReportStore(database)
    const startedAt = new Date("2026-08-19T10:00:00.000Z")
    const completedAt = new Date("2026-08-19T10:05:00.000Z")
    const worker = new ShadowReportWorker(store, {
      generate: async () => ({
        summary: { headline: "完成", strengths: [], gaps: [], recommendations: [] },
        comparisons: [],
      }),
    }, () => completedAt)

    const report = await worker.runNow(startedAt)

    expect(report.updatedAt).toBe(completedAt.toISOString())
    expect(database.prepare("SELECT started_at,completed_at FROM shadow_learning_reports WHERE id=?").get(report.id))
      .toEqual({ started_at: startedAt.toISOString(), completed_at: completedAt.toISOString() })
  })

  it("没有可信真人回复时直接完成说明报告且不调用模型", async () => {
    const database = await openDatabase()
    seedReportScope(database)
    seedShadowSample(database, 1, { humanAnswer: null })
    const store = new ShadowReportStore(database)
    const generate = vi.fn(async () => { throw new Error("不应调用模型") })
    const worker = new ShadowReportWorker(store, { generate })

    const report = await worker.runNow(fixtureCutoff)

    expect(generate).not.toHaveBeenCalled()
    expect(report).toMatchObject({ status: "completed", sampleCount: 0, errorMessage: null })
    expect(report.renderedMarkdown).toContain("采集到 1 个影子问题，但没有关联到可信真人回复")
    expect(report.renderedMarkdown).toContain("群与账号 > 用户与角色")
  })

  it("同时按样本数和 JSON 字节数切分报告批次", () => {
    const sample = (id: string, question: string): ShadowReportSample => ({
      sampleId: id,
      threadId: `thread-${id}`,
      inputRevision: 1,
      question,
      shadowOutcome: "completed",
      shadowDecision: "reply",
      shadowAnswer: "回答",
      shadowReason: null,
      humanAnswers: [{ messageEventId: `event-${id}`, text: "真人回答", confidence: 1 }],
    })
    const shortSamples = [sample("1", "一"), sample("2", "二"), sample("3", "三")]
    const largeSamples = [sample("a", "中".repeat(600)), sample("b", "中".repeat(600))]

    expect(partitionShadowReportSamples(shortSamples, { maxSamples: 2, maxBytes: 1_000_000 })
      .map((batch) => batch.map((item) => item.sampleId))).toEqual([["1", "2"], ["3"]])
    expect(partitionShadowReportSamples(largeSamples, { maxSamples: 10, maxBytes: 2_500 })
      .map((batch) => batch.map((item) => item.sampleId))).toEqual([["a"], ["b"]])
  })

  it("每批持久化并在失败报告重试时只生成尚未完成的样本", async () => {
    const database = await openDatabase()
    seedReportScope(database)
    const ids = [
      seedShadowSample(database, 1),
      seedShadowSample(database, 2),
      seedShadowSample(database, 3),
    ]
    const store = new ShadowReportStore(database)
    let failLastBatch = true
    const calls: string[][] = []
    const worker = new ShadowReportWorker(store, {
      generate: async (samples) => {
        calls.push(samples.map((sample) => sample.sampleId))
        if (failLastBatch && samples.some((sample) => sample.sampleId === ids[2])) throw new Error("批次超时")
        return generatedReport(samples)
      },
    }, () => fixtureCutoff, { maxSamples: 2, maxBytes: 1_000_000 })

    const failed = await worker.runNow(fixtureCutoff)

    expect(failed).toMatchObject({ status: "failed", sampleCount: 2, errorMessage: "批次超时" })
    expect(store.detail(failed.id).comparisons).toHaveLength(2)

    failLastBatch = false
    const completed = await worker.retry(failed.id, new Date("2026-08-19T10:31:00.000Z"))

    expect(completed).toMatchObject({ status: "completed", sampleCount: 3, errorMessage: null })
    expect(store.detail(failed.id).comparisons).toHaveLength(3)
    expect(calls).toEqual([[ids[0]!, ids[1]!], [ids[2]!], [ids[2]!]])
  })
})
