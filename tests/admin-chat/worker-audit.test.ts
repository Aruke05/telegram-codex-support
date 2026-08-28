import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { AdminChatStore } from "../../src/admin-chat/store.js"
import { AdminChatWorker } from "../../src/admin-chat/worker.js"
import { ModelExecutionError } from "../../src/models/errors.js"
import { ReplyEventBus } from "../../src/replies/reply-event-bus.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { ModelConfigService } from "../../src/runtime/model-config-service.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import {
  SupportEvidenceStructureError,
  SupportModelOutputRejectedError,
  type SupportReplyPipelineAudit,
} from "../../src/support/investigation-service.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openHarness(): Promise<{
  database: RuntimeDatabase
  store: AdminChatStore
  serviceId: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "admin-worker-audit-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const now = "2026-08-27T00:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000901"
  const serviceId = "00000000-0000-4000-8000-000000000902"
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "admin-audit", "后台审计项目", "", 1, "global", now, now)
  database.prepare(`INSERT INTO project_services(
    id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    serviceId, projectId, "admin-audit-service", "后台审计服务", "", "Asia/Shanghai", null, "main", 1, now, now,
  )
  return { database, store: new AdminChatStore(database), serviceId }
}

function rejectedPipelineAudit(secret: string): SupportReplyPipelineAudit {
  return {
    version: "evidence-binding-review-v2",
    mode: "multi_stage",
    evidencePacket: {
      version: "2",
      communication: { intent: "direct_answer", recipient: null, desiredOutcome: `password=${secret}` },
      facts: [],
      associations: [],
      requiredAnswerPoints: [],
      unknowns: [],
      handlingNotes: [],
      reviewLevel: "strict",
    },
    baselineAnswer: `password=${secret}`,
    firstCandidateAnswer: null,
    revisedCandidateAnswer: null,
    reviews: [],
    finalSource: "baseline",
    fallbackReason: `password=${secret}`,
  }
}

function withPipelineAudit<T extends Error>(error: T, audit: SupportReplyPipelineAudit): T {
  return Object.assign(error, { pipelineAudit: audit })
}

describe("后台 AI 对话失败流水线审计", () => {
  it("严格审核拒绝携带 pipelineAudit 时先持久化脱敏审计再记录轮次失败", async () => {
    const { database, store, serviceId } = await openHarness()
    const { turn } = store.createSessionWithTurn(serviceId, "帮忙核对这笔订单")
    const secret = "admin-audit-secret"
    const redactor = new ConfiguredSecretRedactor(database)
    const worker = new AdminChatWorker({
      store,
      database,
      config: new ModelConfigService(database),
      investigation: {
        investigate: async () => {
          throw withPipelineAudit(
            new SupportModelOutputRejectedError(["第二轮审核仍未通过"]),
            rejectedPipelineAudit(secret),
          )
        },
      },
      redactor,
      events: new ReplyEventBus(),
    })

    try {
      worker.start()
      await vi.waitFor(() => expect(store.getTurn(turn.id).status).toBe("failed"))

      const row = database.prepare(`SELECT evidence_packet_json,baseline_answer,fallback_reason
        FROM reply_generation_audits WHERE admin_chat_turn_id=?`).get(turn.id)
      expect(row).toBeTruthy()
      expect(JSON.stringify(row)).not.toContain(secret)
      expect(JSON.stringify(row)).toContain("[已脱敏]")
    } finally {
      await worker.stop()
      database.close()
    }
  })

  it.each<[
    string,
    (audit: SupportReplyPipelineAudit) => Error,
  ]>([
    ["ModelExecutionError", (audit) => withPipelineAudit(
      new ModelExecutionError("structured_output_invalid", "回答结构无效"), audit,
    )],
    ["SupportEvidenceStructureError", (audit) => new SupportEvidenceStructureError(
      [{ code: "unknown_claim_fact", message: "回答声明引用未知事实" }], audit,
    )],
  ])("%s 自动重试一次、每次保存审计且第二次失败后不再无限重试", async (label, createError) => {
    const { database, store, serviceId } = await openHarness()
    const { turn } = store.createSessionWithTurn(serviceId, `帮忙核对结构错误 ${label}`)
    let attempts = 0
    const worker = new AdminChatWorker({
      store,
      database,
      config: new ModelConfigService(database),
      investigation: {
        investigate: async () => {
          attempts += 1
          throw createError(rejectedPipelineAudit(`admin-structured-secret-${label}-${attempts}`))
        },
      },
      redactor: new ConfiguredSecretRedactor(database),
      events: new ReplyEventBus(),
    })

    try {
      worker.start()
      await vi.waitFor(() => expect(attempts).toBe(2))
      await vi.waitFor(() => {
        const turns = store.getSession(turn.sessionId).turns
        expect(turns).toHaveLength(2)
        expect(turns).toEqual(expect.arrayContaining([
          expect.objectContaining({ position: 1, status: "failed", errorCode: "admin_chat_model_structured_output_invalid" }),
          expect.objectContaining({ position: 2, status: "failed", errorCode: "admin_chat_model_structured_output_invalid" }),
        ]))
      })
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(attempts).toBe(2)
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reply_generation_audits audit
        JOIN admin_chat_turns turn ON turn.id=audit.admin_chat_turn_id
        WHERE turn.session_id=?`).get(turn.sessionId)).toEqual({ count: 2 })
      const audits = database.prepare(`SELECT evidence_packet_json,baseline_answer,fallback_reason
        FROM reply_generation_audits audit JOIN admin_chat_turns turn ON turn.id=audit.admin_chat_turn_id
        WHERE turn.session_id=? ORDER BY turn.position`).all(turn.sessionId)
      expect(JSON.stringify(audits)).not.toContain("admin-structured-secret")
      expect(JSON.stringify(audits)).toContain("[已脱敏]")
    } finally {
      await worker.stop()
      database.close()
    }
  })

  it.each([
    ["相同问题已有 completed 结果", "completed_same_question"],
    ["中间出现不同问题", "different_question"],
  ] as const)("历史同问失败后%s，新的同问仍获得独立一次结构重试", async (_label, separator) => {
    const { database, store, serviceId } = await openHarness()
    const question = "再次核对同一笔订单"
    const { session, turn: first } = store.createSessionWithTurn(serviceId, question)
    expect(store.claimNext()?.id).toBe(first.id)
    store.failTurn(first.id, "admin_chat_model_structured_output_invalid", "历史首次结构错误")
    const historicalRetry = store.retryTurn(first.id)
    expect(store.claimNext()?.id).toBe(historicalRetry.id)
    store.failTurn(historicalRetry.id, "admin_chat_model_structured_output_invalid", "历史第二次结构错误")

    const separatorTurn = store.createTurn(
      session.id,
      separator === "completed_same_question" ? question : "核对另一笔完全不同的订单",
    )
    expect(store.claimNext()?.id).toBe(separatorTurn.id)
    if (separator === "completed_same_question") {
      store.completeTurn(separatorTurn.id, {
        answer: "历史同问已经完成",
        decision: "reply",
        investigation: {},
        decisionReason: "历史轮次正常完成",
        decisionConfidence: 1,
        codeRevision: null,
        codeSnapshotId: null,
        codeSyncBatchId: null,
        memoryVersionRefs: [],
      })
    } else {
      store.failTurn(separatorTurn.id, "admin_chat_investigation_failed", "不同问题独立失败")
    }

    store.createTurn(session.id, question)
    let attempts = 0
    const worker = new AdminChatWorker({
      store,
      database,
      config: new ModelConfigService(database),
      investigation: {
        investigate: async () => {
          attempts += 1
          throw withPipelineAudit(
            new ModelExecutionError("structured_output_invalid", "新逻辑问题结构无效"),
            rejectedPipelineAudit(`admin-new-logical-attempt-${attempts}`),
          )
        },
      },
      redactor: new ConfiguredSecretRedactor(database),
      events: new ReplyEventBus(),
    })

    try {
      worker.start()
      await vi.waitFor(() => expect(attempts).toBe(2))
      const latest = store.getSession(session.id).turns.slice(-2)
      expect(latest).toEqual([
        expect.objectContaining({ status: "failed", errorCode: "admin_chat_model_structured_output_invalid" }),
        expect.objectContaining({ status: "failed", errorCode: "admin_chat_model_structured_output_invalid" }),
      ])
    } finally {
      await worker.stop()
      database.close()
    }
  })

  it("错误携带畸形 pipelineAudit 时忽略审计并按原错误记录轮次失败", async () => {
    const { database, store, serviceId } = await openHarness()
    const { turn } = store.createSessionWithTurn(serviceId, "帮忙核对这笔订单")
    const worker = new AdminChatWorker({
      store,
      database,
      config: new ModelConfigService(database),
      investigation: {
        investigate: async () => {
          throw Object.assign(new SupportModelOutputRejectedError(["原始严格审核拒绝"]), {
            pipelineAudit: { version: "unexpected-version" },
          })
        },
      },
      redactor: new ConfiguredSecretRedactor(database),
      events: new ReplyEventBus(),
    })

    try {
      worker.start()
      await vi.waitFor(() => expect(store.getTurn(turn.id).status).toBe("failed"))

      expect(store.getTurn(turn.id)).toMatchObject({ errorCode: "admin_chat_model_output_rejected" })
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reply_generation_audits
        WHERE admin_chat_turn_id=?`).get(turn.id)).toEqual({ count: 0 })
    } finally {
      await worker.stop()
      database.close()
    }
  })
})
