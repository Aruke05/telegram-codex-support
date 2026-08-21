import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { AnswerDecision, ComposedReply, ReplyReview } from "../../src/codex/schemas.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import type { ModelInstanceSnapshot } from "../../src/runtime/model-config-service.js"
import type { MemoryView } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import type {
  SupportDecisionAgentPort,
  SupportReplyCompositionInput,
  SupportReplyReviewInput,
} from "../../src/support/agent.js"
import { SupportInvestigationService } from "../../src/support/investigation-service.js"
import { baselineOperatorStyleProfile } from "../../src/support/operator-style.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const modelSnapshot: ModelInstanceSnapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  alias: "测试回答模型",
  provider: "openai",
  transport: "codex_cli",
  modelId: "gpt-5.6-terra",
  reasoningEffort: "medium",
  serviceTier: "standard",
  parameters: {},
  apiKey: null,
  enabled: true,
  healthStatus: "not_tested",
  healthMessage: "尚未检测",
  lastCheckedAt: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
}

function baselineDecision(usedMemoryVersionIds: string[] = []): AnswerDecision {
  return {
    decision: "reply",
    escalationType: "none",
    humanOperation: null,
    answer: "当前版本基线：我方已收到订单，请上游核对。",
    quote: null,
    reason: "已读取消息和当前代码",
    confidence: 0.9,
    usedMemoryVersionIds,
    answerClaims: [{
      statement: "我方已收到订单",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "运营提供了系统订单号",
    }],
    responsibility: { party: "unknown", certainty: "unknown", evidenceSources: ["message"] },
    interaction: {
      sentiment: "neutral",
      situation: "followup",
      underlyingNeed: "取得可直接发给上游的证据说明",
      responseStrategy: "direct_answer",
    },
    investigation: {
      summary: "模型工作轨迹",
      steps: [{
        source: "message",
        title: "模型读取消息",
        status: "confirmed",
        evidence: "系统订单号 SO-1",
        conclusion: "已取得订单号",
      }],
    },
    evidencePacket: {
      version: "1",
      communication: {
        intent: "copyable_message",
        recipient: "上游",
        desiredOutcome: "核对是否收到并处理订单",
      },
      facts: [{
        id: "F1",
        statement: "我方订单号为 SO-1",
        provenance: "user_report",
        evidenceSource: "message",
        evidence: "运营消息提供 SO-1",
        certainty: "reported",
        outboundSafe: true,
      }, {
        id: "F2",
        statement: "当前代码会保存上游响应",
        provenance: "code",
        evidenceSource: "code",
        evidence: "当前发布代码快照",
        certainty: "confirmed",
        outboundSafe: true,
      }, {
        id: "F3",
        statement: "内部连接信息",
        provenance: "runtime",
        evidenceSource: "server",
        evidence: "仅供内部定位",
        certainty: "confirmed",
        outboundSafe: false,
      }],
      requiredAnswerPoints: ["明确可直接发给上游并提供我方订单证据", "说明希望上游核对的事项"],
      unknowns: ["尚未确认上游内部处理结果"],
      handlingNotes: ["明确标注可直接发给上游；不能猜测上游内部原因"],
      reviewLevel: "strict",
    },
  }
}

function candidate(answer = "下面这段可直接发给上游：\n我方订单号为 SO-1，请核对是否收到并处理。\n当前代码会保存上游响应。"):
ComposedReply {
  return {
    answer,
    quote: null,
    claims: [{ factId: "F1", statement: "我方订单号为 SO-1" }, {
      factId: "F2", statement: "当前代码会保存上游响应",
    }],
    usedMemoryVersionIds: [],
  }
}

async function harness(agent: SupportDecisionAgentPort, memories: MemoryView[] = []) {
  const directory = await mkdtemp(path.join(tmpdir(), "reply-pipeline-"))
  temporaryDirectories.push(directory)
  const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
  const now = "2026-08-22T00:00:00.000Z"
  const projectId = "00000000-0000-4000-8000-000000000701"
  const serviceId = "00000000-0000-4000-8000-000000000702"
  database.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(projectId, "project", "项目", "", 1, "global", now, now)
  database.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(serviceId, projectId, "service", "服务", "", "Asia/Shanghai", null, "main", 1, now, now)
  const service = database.readProjectServices("WHERE id=?", [serviceId])[0]!
  const snapshot = {
    projectId,
    serviceId,
    service: "service",
    branch: "main",
    commit: "a".repeat(40),
    snapshotId: "00000000-0000-4000-8000-000000000703",
    syncBatchId: "00000000-0000-4000-8000-000000000704",
    configurationFingerprint: "test",
    syncState: "fresh" as const,
    failure: null,
    publishedAt: now,
    workspacePath: directory,
    repositories: [],
  }
  const investigation = new SupportInvestigationService({
    database,
    codeSync: { readCurrentSnapshot: () => snapshot, currentServiceForSnapshot: () => service },
    knowledge: { listDirectives: () => [], listAnswerMemories: () => memories, searchStaticKnowledge: () => [] },
    resourceWorkspace: {
      open: async () => ({
        path: directory,
        manifestPath: path.join(directory, "manifest.json"),
        databaseQueryAuditPath: path.join(directory, "audit.jsonl"),
        networkHosts: [],
        cleanup: async () => undefined,
      }),
    },
    redactor: new ConfiguredSecretRedactor(database),
    agent,
  })
  const input = {
    serviceId,
    groupName: "客服群",
    question: "这个可以发给上游吗",
    latestMessage: "这个可以发给上游吗",
    responseDepth: "followup" as const,
    senderRole: null,
    scope: "global",
    attachments: [],
    answerTimeoutSeconds: 60,
    operatorStyleProfile: baselineOperatorStyleProfile,
    modelInstanceId: modelSnapshot.id,
    modelSnapshot,
    answerMaxConcurrency: 2,
    answerBindingEnabled: true,
    includeAiMemory: true,
    includeInterfaceDocs: true,
    includeMagicBook: true,
    replyStyle: "human" as const,
  }
  return { database, investigation, input }
}

function agent(options: {
  decide?: () => Promise<AnswerDecision>
  compose?: (input: SupportReplyCompositionInput) => Promise<ComposedReply>
  review?: (input: SupportReplyReviewInput) => Promise<ReplyReview>
} = {}): SupportDecisionAgentPort {
  const composeReply = options.compose ?? vi.fn(async (): Promise<ComposedReply> => candidate())
  const reviewReply = options.review ?? vi.fn(async (): Promise<ReplyReview> => (
    { outcome: "approve", issues: [], reason: "候选不弱于基线" }
  ))
  return {
    decide: vi.fn(options.decide ?? (async () => baselineDecision())),
    composeReply,
    reviewReply,
  }
}

describe("证据收集、独立成稿和质量审核流水线", () => {
  it("审核通过时采用独立成稿，但保持调查阶段的决策和责任不变", async () => {
    const runningAgent = agent()
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toContain("下面这段可直接发给上游")
      expect(result.decision.decision).toBe("reply")
      expect(result.decision.responsibility).toEqual({ party: "unknown", certainty: "unknown", evidenceSources: ["message"] })
      expect(result.pipelineAudit).toMatchObject({ mode: "multi_stage", finalSource: "first_candidate" })
      expect(result.decision.answerClaims?.map((claim) => claim.provenance)).toEqual(["user_report", "code"])
    } finally {
      database.close()
    }
  })

  it("首次审核要求修改时最多重写一次，并在第二次通过后采用重写稿", async () => {
    let composeCount = 0
    let reviewCount = 0
    const runningAgent = agent({
      compose: vi.fn(async (input) => {
        composeCount += 1
        if (composeCount === 1) return candidate()
        expect(input.revisionFeedback).toEqual(["补充我方证据并明确接收方"])
        return candidate("下面这段可直接发给上游：\n我方订单号为 SO-1。当前代码会保存上游响应，请核对是否收到并处理。")
      }),
      review: vi.fn(async (): Promise<ReplyReview> => {
        reviewCount += 1
        return reviewCount === 1
          ? { outcome: "revise", issues: ["补充我方证据并明确接收方"], reason: "首次候选需要补齐" }
          : { outcome: "approve", issues: [], reason: "重写后不弱于基线" }
      }),
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.pipelineAudit).toMatchObject({ finalSource: "revised_candidate" })
      expect(result.pipelineAudit.reviews).toHaveLength(2)
      expect(composeCount).toBe(2)
    } finally {
      database.close()
    }
  })

  it("审核认为新稿退步时回退当前版本基线", async () => {
    const runningAgent = agent({
      review: vi.fn(async (): Promise<ReplyReview> => (
        { outcome: "prefer_baseline", issues: [], reason: "候选遗漏当前状态" }
      )),
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.decision.answer).toBe(baselineDecision().answer)
      expect(result.pipelineAudit).toMatchObject({ finalSource: "baseline", fallbackReason: "候选遗漏当前状态" })
    } finally {
      database.close()
    }
  })

  it("组合模型失败或引用不可出站事实时不影响当前版本基线", async () => {
    const invalid = candidate("内部连接信息")
    invalid.claims = [{ factId: "F3", statement: "内部连接信息" }]
    const runningAgent = agent({ compose: vi.fn(async () => invalid) })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.decision.answer).toBe(baselineDecision().answer)
      expect(result.pipelineAudit.finalSource).toBe("baseline")
      expect(result.pipelineAudit.fallbackReason).toContain("保留调查模型基线")
      expect(runningAgent.reviewReply).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("组合模型引用的片段不属于最新消息时回退当前版本基线", async () => {
    const invalid = candidate()
    invalid.quote = "这段文字不在运营最新消息里"
    const runningAgent = agent({ compose: vi.fn(async () => invalid) })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.decision.answer).toBe(baselineDecision().answer)
      expect(result.pipelineAudit.finalSource).toBe("baseline")
      expect(result.pipelineAudit.fallbackReason).toContain("保留调查模型基线")
      expect(runningAgent.reviewReply).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("父进程移除没有可信运行步骤支持的事实再交给回复模型", async () => {
    const compose = vi.fn(async (input: SupportReplyCompositionInput) => {
      expect(input.evidencePacket.facts.map((fact) => fact.id)).toEqual(["F1", "F2"])
      return candidate()
    })
    const { database, investigation, input } = await harness(agent({ compose }))
    try {
      await investigation.investigate(input, new AbortController().signal)
      expect(compose).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("采用独立成稿时继承调查阶段真实使用的记忆引用", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000711"
    const now = "2026-08-22T00:00:00.000Z"
    const memory: MemoryView = {
      id: memoryId,
      versionId: memoryId,
      factId: "00000000-0000-4000-8000-000000000712",
      version: 1,
      title: "第三方沟通规则",
      content: "对外沟通需要提供我方证据",
      scope: "global",
      region: null,
      branch: null,
      source: "human_rule",
      risk: "low",
      confidence: 1,
      status: "active",
      conflictReason: null,
      validFrom: now,
      validTo: null,
      createdByEventId: "00000000-0000-4000-8000-000000000713",
      createdAt: now,
      topicKey: "a".repeat(64),
      currentVersionId: memoryId,
      evidenceCount: 1,
      previousVersionCount: 0,
    }
    const runningAgent = agent({ decide: async () => baselineDecision([memoryId]) })
    const { database, investigation, input } = await harness(runningAgent, [memory])
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.pipelineAudit.finalSource).toBe("first_candidate")
      expect(result.decision.usedMemoryVersionIds).toEqual([memoryId])
    } finally {
      database.close()
    }
  })

  it("普通解释场景保留原基线，不增加独立成稿和审核时延", async () => {
    const baseline = baselineDecision()
    baseline.evidencePacket = {
      ...baseline.evidencePacket!,
      communication: {
        intent: "direct_answer",
        recipient: null,
        desiredOutcome: "直接解释当前状态",
      },
    }
    const runningAgent = agent({ decide: async () => baseline })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.decision.answer).toBe(baseline.answer)
      expect(result.pipelineAudit).toMatchObject({
        mode: "legacy",
        finalSource: "baseline",
        fallbackReason: "当前诉求不需要独立沟通成稿，保留调查模型基线",
      })
      expect(runningAgent.composeReply).not.toHaveBeenCalled()
      expect(runningAgent.reviewReply).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})
