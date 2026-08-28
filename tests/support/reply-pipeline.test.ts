import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { AnswerDecision, ComposedReply, ReplyReview } from "../../src/codex/schemas.js"
import { ModelExecutionError } from "../../src/models/errors.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import type { ModelInstanceSnapshot } from "../../src/runtime/model-config-service.js"
import type { MemoryView } from "../../src/runtime/types.js"
import { ConfiguredSecretRedactor } from "../../src/security/dlp.js"
import type {
  SupportAttachmentContext,
  SupportDecisionAgentPort,
  SupportReplyCompositionInput,
  SupportReplyReviewInput,
} from "../../src/support/agent.js"
import { CodexSupportDecisionAgent } from "../../src/support/agent.js"
import {
  SupportInvestigationService,
  SupportModelOutputRejectedError,
  type SupportInvestigationServiceDependencies,
} from "../../src/support/investigation-service.js"
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

function transactionDecision(options: {
  leftIdentifier?: string
  rightIdentifier?: string
  matchedIdentifier?: string
  usedMemoryVersionIds?: string[]
} = {}): AnswerDecision {
  const leftIdentifier = options.leftIdentifier ?? "MERCHANT-ORDER-001"
  const rightIdentifier = options.rightIdentifier ?? leftIdentifier
  const matchedIdentifier = options.matchedIdentifier ?? leftIdentifier
  return {
    decision: "reply",
    escalationType: "none",
    humanOperation: null,
    answer: "我方收到订单，当前发布代码会记录处理结果，请上游核对。",
    quote: null,
    reason: "已读取消息和当前代码",
    confidence: 0.9,
    usedMemoryVersionIds: options.usedMemoryVersionIds ?? [],
    answerClaims: [{
      factId: "F1",
      statement: "我方收到订单",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "运营提供了商户订单号",
    }, {
      factId: "F2",
      statement: "当前发布代码会记录处理结果",
      provenance: "code",
      evidenceSource: "code",
      evidence: "当前发布代码快照",
    }],
    responsibility: { party: "unknown", certainty: "unknown", evidenceSources: [], factIds: [] },
    interaction: {
      sentiment: "neutral",
      situation: "followup",
      underlyingNeed: "取得可以安全发送的核对结论",
      responseStrategy: "direct_answer",
    },
    investigation: {
      summary: "模型工作轨迹",
      steps: [{
        source: "message",
        title: "模型读取消息",
        status: "confirmed",
        evidence: "运营提供了商户订单号",
        conclusion: "已取得订单标识",
      }],
    },
    evidencePacket: {
      version: "2",
      communication: {
        intent: "direct_answer",
        recipient: null,
        desiredOutcome: "说明当前能够确认的处理事实",
      },
      facts: [{
        id: "F1",
        statement: "我方收到订单",
        provenance: "user_report",
        evidenceSource: "message",
        evidence: "运营提供了商户订单号",
        certainty: "reported",
        outboundSafe: true,
        subjectKind: "transaction",
        businessType: "payment",
        identifiers: [{ kind: "merchant_order_no", value: leftIdentifier }],
        associationId: "A1",
        dependsOnFactIds: [],
      }, {
        id: "F2",
        statement: "当前发布代码会记录处理结果",
        provenance: "code",
        evidenceSource: "code",
        evidence: "当前发布代码快照",
        certainty: "confirmed",
        outboundSafe: true,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }, {
        id: "F3",
        statement: "继续核对需要准确的订单标识",
        provenance: "code",
        evidenceSource: "code",
        evidence: "当前发布代码的查询入口",
        certainty: "confirmed",
        outboundSafe: true,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }, {
        id: "F4",
        statement: "内部连接信息",
        provenance: "code",
        evidenceSource: "code",
        evidence: "仅供内部定位",
        certainty: "confirmed",
        outboundSafe: false,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }, {
        id: "F6",
        statement: "运行记录包含这笔订单",
        provenance: "runtime",
        evidenceSource: "log",
        evidence: "绑定服务器限量日志包含订单记录",
        certainty: "confirmed",
        outboundSafe: true,
        subjectKind: "transaction",
        businessType: "payment",
        identifiers: [{ kind: "merchant_order_no", value: rightIdentifier }],
        associationId: "A1",
        dependsOnFactIds: [],
      }],
      associations: [{
        id: "A1",
        subjectKind: "transaction",
        status: "confirmed",
        factIds: ["F1", "F6"],
        matchedIdentifiers: [{
          kind: "merchant_order_no",
          value: matchedIdentifier,
          factIds: ["F1", "F6"],
        }],
        lookupHints: [],
        conflicts: [],
      }],
      requiredAnswerPoints: ["只陈述当前已绑定到同一订单的事实"],
      unknowns: ["尚未确认上游内部处理结果"],
      handlingNotes: ["不能把不同交易对象的事实拼接到同一答复"],
      reviewLevel: "standard",
    },
  }
}

function generalDecision(): AnswerDecision {
  return {
    decision: "reply",
    escalationType: "none",
    humanOperation: null,
    answer: "当前代码显示这是正常处理流程。",
    quote: null,
    reason: "当前问题只涉及一般代码解释",
    confidence: 0.9,
    usedMemoryVersionIds: [],
    answerClaims: [{
      factId: "F1",
      statement: "这是正常处理流程",
      provenance: "code",
      evidenceSource: "code",
      evidence: "当前发布代码快照",
    }],
    responsibility: { party: "not_applicable", certainty: "not_applicable", evidenceSources: [], factIds: [] },
    interaction: {
      sentiment: "neutral",
      situation: "new_request",
      underlyingNeed: "了解正常流程",
      responseStrategy: "direct_answer",
    },
    investigation: {
      summary: "模型工作轨迹",
      steps: [{
        source: "code",
        title: "读取当前代码",
        status: "confirmed",
        evidence: "当前发布代码快照",
        conclusion: "已确认正常流程",
      }],
    },
    evidencePacket: {
      version: "2",
      communication: { intent: "direct_answer", recipient: null, desiredOutcome: "解释正常流程" },
      facts: [{
        id: "F1",
        statement: "这是正常处理流程",
        provenance: "code",
        evidenceSource: "code",
        evidence: "当前发布代码快照",
        certainty: "confirmed",
        outboundSafe: true,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }],
      associations: [],
      requiredAnswerPoints: ["解释正常流程"],
      unknowns: [],
      handlingNotes: [],
      reviewLevel: "standard",
    },
  }
}

function displayGeneralDecision(certainty: "reported" | "confirmed" = "reported"): AnswerDecision {
  const decision = generalDecision()
  decision.answer = "截图显示页面状态为处理中。"
  decision.answerClaims[0] = {
    factId: "F1",
    statement: "截图显示页面状态为处理中",
    provenance: "display",
    evidenceSource: "message",
    evidence: "页面状态为处理中",
  }
  decision.evidencePacket.facts[0] = {
    ...decision.evidencePacket.facts[0]!,
    statement: "截图显示页面状态为处理中",
    provenance: "display",
    evidenceSource: "message",
    evidence: "页面状态为处理中",
    certainty,
  }
  return decision
}

function memoryGeneralDecision(memoryId: string, evidence: string): AnswerDecision {
  const decision = generalDecision()
  decision.answer = "这是一条需要独立证据支撑的一般结论。"
  decision.usedMemoryVersionIds = [memoryId]
  decision.answerClaims[0] = {
    factId: "F1",
    statement: "这是一条需要独立证据支撑的一般结论",
    provenance: "memory",
    evidenceSource: "memory",
    evidence,
  }
  decision.responsibility = {
    party: "not_applicable",
    certainty: "not_applicable",
    evidenceSources: [],
    factIds: [],
  }
  decision.evidencePacket.facts[0] = {
    ...decision.evidencePacket.facts[0]!,
    statement: "这是一条需要独立证据支撑的一般结论",
    provenance: "memory",
    evidenceSource: "memory",
    evidence,
    certainty: "confirmed",
  }
  return decision
}

function databaseTransactionDecision(identifier: string, databaseEvidence: string): AnswerDecision {
  return {
    decision: "reply",
    escalationType: "none",
    humanOperation: null,
    answer: "数据库记录显示这笔订单当前已创建。",
    quote: null,
    reason: "消息订单号与父进程数据库结果完全一致",
    confidence: 0.9,
    usedMemoryVersionIds: [],
    answerClaims: [{
      factId: "F2",
      statement: "数据库记录显示这笔订单当前已创建",
      provenance: "runtime",
      evidenceSource: "database",
      evidence: databaseEvidence,
    }],
    responsibility: { party: "unknown", certainty: "unknown", evidenceSources: [], factIds: [] },
    interaction: {
      sentiment: "neutral",
      situation: "new_request",
      underlyingNeed: "核对当前订单",
      responseStrategy: "direct_answer",
    },
    investigation: {
      summary: "模型自报调查轨迹",
      steps: [{
        source: "database",
        title: "模型自报数据库结果",
        status: "confirmed",
        evidence: databaseEvidence,
        conclusion: "模型自报已核对",
      }],
    },
    evidencePacket: {
      version: "2",
      communication: { intent: "direct_answer", recipient: null, desiredOutcome: "说明当前订单状态" },
      facts: [{
        id: "F1",
        statement: `运营提供的商户订单号为 ${identifier}`,
        provenance: "user_report",
        evidenceSource: "message",
        evidence: `请核对商户订单 ${identifier}`,
        certainty: "reported",
        outboundSafe: true,
        subjectKind: "transaction",
        businessType: "payment",
        identifiers: [{ kind: "merchant_order_no", value: identifier }],
        associationId: "A1",
        dependsOnFactIds: [],
      }, {
        id: "F2",
        statement: "数据库记录显示这笔订单当前已创建",
        provenance: "runtime",
        evidenceSource: "database",
        evidence: databaseEvidence,
        certainty: "confirmed",
        outboundSafe: true,
        subjectKind: "transaction",
        businessType: "payment",
        identifiers: [{ kind: "merchant_order_no", value: identifier }],
        associationId: "A1",
        dependsOnFactIds: [],
      }],
      associations: [{
        id: "A1",
        subjectKind: "transaction",
        status: "confirmed",
        factIds: ["F1", "F2"],
        matchedIdentifiers: [{ kind: "merchant_order_no", value: identifier, factIds: ["F1", "F2"] }],
        lookupHints: [],
        conflicts: [],
      }],
      requiredAnswerPoints: ["说明当前订单状态"],
      unknowns: [],
      handlingNotes: ["只使用父进程实际复核的记录"],
      reviewLevel: "strict",
    },
  }
}

function revisedCandidate(answer = "我方收到订单，当前发布代码会记录处理结果，请上游核对。"): ComposedReply {
  return {
    answer,
    quote: null,
    claims: [{ factId: "F1", statement: "我方收到订单" }, {
      factId: "F2", statement: "当前发布代码会记录处理结果",
    }],
    usedMemoryVersionIds: [],
  }
}

function clarificationCandidate(): ComposedReply {
  return {
    answer: "继续核对需要准确的订单标识，请补充准确的系统订单号。",
    quote: null,
    claims: [{ factId: "F3", statement: "继续核对需要准确的订单标识" }],
    usedMemoryVersionIds: [],
  }
}

function activeMemory(id: string, content: string): MemoryView {
  const now = "2026-08-22T00:00:00.000Z"
  return {
    id,
    versionId: id,
    factId: "00000000-0000-4000-8000-000000000712",
    version: 1,
    title: "第三方沟通规则",
    content,
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
    currentVersionId: id,
    evidenceCount: 1,
    previousVersionCount: 0,
  }
}

async function harness(
  runningAgent: SupportDecisionAgentPort,
  memories: MemoryView[] = [],
  additionalSecrets: string[] = [],
  options: {
    question?: string
    latestMessage?: string
    attachments?: SupportAttachmentContext[]
    resourceBroker?: SupportInvestigationServiceDependencies["resourceBroker"]
    staticDocuments?: Array<{
      source: string
      title: string
      scope: string
      content: string
      capturedAt: string
    }>
  } = {},
) {
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
    repositories: [{
      role: "backend" as const,
      repositoryId: "00000000-0000-4000-8000-000000000705",
      name: "java-project",
      branch: "main",
      commit: "a".repeat(40),
      snapshotPath: directory,
    }],
  }
  const investigation = new SupportInvestigationService({
    database,
    codeSync: { readCurrentSnapshot: () => snapshot, currentServiceForSnapshot: () => service },
    knowledge: {
      listDirectives: () => [],
      listAnswerMemories: () => memories,
      searchStaticKnowledge: () => options.staticDocuments ?? [],
    },
    resourceWorkspace: {
      open: async () => ({
        path: directory,
        manifestPath: path.join(directory, "manifest.json"),
        databaseQueryAuditPath: path.join(directory, "audit.jsonl"),
        networkHosts: [],
        cleanup: async () => undefined,
      }),
    },
    redactor: new ConfiguredSecretRedactor(database, () => additionalSecrets),
    agent: runningAgent,
    ...(options.resourceBroker ? { resourceBroker: options.resourceBroker } : {}),
  })
  const input = {
    serviceId,
    groupName: "客服群",
    question: options.question ?? "运营提供了商户订单号 MERCHANT-ORDER-001，这个情况应该怎么处理",
    latestMessage: options.latestMessage ?? options.question ?? "运营提供了商户订单号 MERCHANT-ORDER-001，这个情况应该怎么处理",
    responseDepth: "followup" as const,
    senderRole: null,
    scope: "global",
    attachments: options.attachments ?? [],
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
  decide?: SupportDecisionAgentPort["decide"]
  compose?: (input: SupportReplyCompositionInput, signal?: AbortSignal) => Promise<ComposedReply>
  review?: (input: SupportReplyReviewInput, signal?: AbortSignal) => Promise<ReplyReview>
  codeObservation?: boolean
  runtimeObservation?: boolean
} = {}): SupportDecisionAgentPort {
  const decide = options.decide ?? (async () => transactionDecision())
  return {
    decide: vi.fn(async (input, signal) => {
      const generated = await decide(input, signal)
      const codeRoot = input.codeSnapshot?.repositories[0]?.snapshotPath
      if (options.codeObservation !== false && codeRoot) {
        const output = generated.evidencePacket.facts
          .filter((fact) => fact.evidenceSource === "code")
          .flatMap((fact) => [fact.evidence, ...fact.identifiers.map((identifier) => identifier.value)])
          .join("\n") || "src/OrderService.java"
        await input.onCommandObservations?.([{
          command: `rg --files ${codeRoot}`,
          output,
          exitCode: 0,
        }])
      }
      if (options.runtimeObservation !== false) {
        const output = generated.evidencePacket.facts
          .filter((fact) => fact.evidenceSource === "log")
          .flatMap((fact) => [fact.evidence, ...fact.identifiers.map((identifier) => identifier.value)])
          .join("\n") || "matched order record"
        await input.onCommandObservations?.([{
          command: `ssh -F ${input.resourceWorkspacePath}/ssh_config -- support-1 'journalctl -u support --since 2026-08-22 -n 10 -o cat --no-pager'`,
          output,
          exitCode: 0,
        }])
      }
      return generated
    }),
    composeReply: vi.fn(async (input: SupportReplyCompositionInput, signal?: AbortSignal) => (
      (options.compose ?? (async () => revisedCandidate()))(input, signal)
    )),
    reviewReply: vi.fn(async (input: SupportReplyReviewInput, signal?: AbortSignal) => (
      (options.review ?? (async () => (
        { outcome: "approve", issues: [], reason: "候选已通过独立审核" }
      )))(input, signal)
    )),
  }
}

function auditStages(errorOrResult: {
  pipelineAudit?: { reviews: Array<{ stage?: string }> } | undefined
}): Array<string | undefined> {
  return errorOrResult.pipelineAudit?.reviews.map((review) => review.stage) ?? []
}

describe("交易证据门禁、独立成稿和质量审核流水线", () => {
  it("严格场景先独立审核基线；审核通过时不调用成稿模型", async () => {
    const compose = vi.fn(async () => revisedCandidate())
    const review = vi.fn(async (input: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(input.attempt).toBe(1)
      expect(input.candidate.answer).toBe(transactionDecision().answer)
      expect(input.evidencePacket.facts.map((fact) => fact.id)).toEqual(["F1", "F2", "F3", "F4", "F6"])
      expect(input.trustedInvestigation.summary).not.toContain("模型工作轨迹")
      expect(input.trustedInvestigation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "code",
          status: "confirmed",
          evidence: expect.stringContaining("实际命令=rg --files"),
        }),
      ]))
      return { outcome: "approve", issues: [], reason: "基线事实与交易对象一致" }
    })
    const { database, investigation, input } = await harness(agent({ compose, review }))
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(transactionDecision().answer)
      expect(result.pipelineAudit).toMatchObject({
        version: "evidence-binding-review-v2",
        mode: "multi_stage",
        finalSource: "baseline",
        fallbackReason: null,
      })
      expect(auditStages(result)).toEqual(["gate", "baseline_review"])
      expect(compose).not.toHaveBeenCalled()
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("稳定标识不能精确绑定时禁止回退基线，只允许成稿一次并复核", async () => {
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput) => {
      expect(compositionInput.revisionFeedback?.join("\n")).toMatch(/稳定标识|不可出站/u)
      expect(compositionInput.evidencePacket.associations[0]?.status).toBe("unconfirmed")
      expect(compositionInput.evidencePacket.facts.filter((fact) => fact.subjectKind === "transaction")
        .every((fact) => !fact.outboundSafe)).toBe(true)
      return clarificationCandidate()
    })
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.attempt).toBe(2)
      return { outcome: "approve", issues: [], reason: "修订稿没有拼接未绑定交易事实" }
    })
    const decision = transactionDecision({
      leftIdentifier: "MERCHANT-ORDER-001",
      rightIdentifier: "MERCHANT-ORDER-002",
      matchedIdentifier: "MERCHANT-ORDER-001",
    })
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      compose,
      review,
    }))
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(clarificationCandidate().answer)
      expect(result.pipelineAudit).toMatchObject({
        finalSource: "revised_candidate",
        firstCandidateAnswer: null,
        revisedCandidateAnswer: clarificationCandidate().answer,
      })
      expect(auditStages(result)).toEqual(["gate", "revision_review"])
      expect(compose).toHaveBeenCalledOnce()
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("基线审核要求修改时只改一次，并在二审通过后采用修订稿", async () => {
    let reviewCount = 0
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput) => {
      expect(compositionInput.revisionFeedback).toEqual(["补充边界说明"])
      return revisedCandidate("我方收到订单，当前发布代码会记录处理结果；上游内部结果暂未确认。")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => {
      reviewCount += 1
      return reviewCount === 1
        ? { outcome: "revise", issues: ["补充边界说明"], reason: "基线需要收窄结论" }
        : { outcome: "approve", issues: [], reason: "修订稿已通过" }
    })
    const { database, investigation, input } = await harness(agent({ compose, review }))
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.pipelineAudit.finalSource).toBe("revised_candidate")
      expect(auditStages(result)).toEqual(["gate", "baseline_review", "revision_review"])
      expect(compose).toHaveBeenCalledOnce()
      expect(review).toHaveBeenCalledTimes(2)
    } finally {
      database.close()
    }
  })

  it("基线 reviewer 不能一边 approve 一边报告明确问题", async () => {
    const compose = vi.fn(async () => revisedCandidate())
    const { database, investigation, input } = await harness(agent({
      compose,
      review: async () => ({
        outcome: "approve",
        issues: ["候选仍遗漏必答事实"],
        reason: "审核输出自相矛盾",
      }),
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(auditStages(caught as SupportModelOutputRejectedError)).toEqual(["gate", "blocked"])
      expect(compose).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("修订稿 reviewer 不能一边 approve 一边报告明确问题", async () => {
    let reviewCount = 0
    const { database, investigation, input } = await harness(agent({
      compose: async () => revisedCandidate(),
      review: async () => {
        reviewCount += 1
        return reviewCount === 1
          ? { outcome: "revise", issues: ["需要修订"], reason: "基线未通过" }
          : { outcome: "approve", issues: ["修订稿仍有问题"], reason: "审核输出自相矛盾" }
      },
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(auditStages(caught as SupportModelOutputRejectedError)).toEqual(["gate", "baseline_review", "blocked"])
    } finally {
      database.close()
    }
  })

  it("成稿 claims 为空时在二审前结构拒绝并阻断发送", async () => {
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "revise", issues: ["需要修订"], reason: "基线未通过" }
    ))
    const { database, investigation, input } = await harness(agent({
      compose: async () => ({
        answer: "请补充准确的系统订单号，我继续核对。",
        quote: null,
        claims: [],
        usedMemoryVersionIds: [],
      }),
      review,
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(auditStages(caught as SupportModelOutputRejectedError)).toEqual(["gate", "baseline_review", "blocked"])
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it.each(["revise", "prefer_baseline"] as const)(
    "二审返回 %s 时阻断发送，绝不退回未经本轮批准的基线",
    async (outcome) => {
      let reviewCount = 0
      const runningAgent = agent({
        compose: async () => revisedCandidate(),
        review: async (): Promise<ReplyReview> => {
          reviewCount += 1
          if (reviewCount === 1) {
            return { outcome: "revise", issues: ["需要修订"], reason: "基线未通过" }
          }
          return outcome === "revise"
            ? { outcome, issues: ["仍未通过"], reason: "修订稿仍有风险" }
            : { outcome, issues: ["修订稿弱于基线"], reason: "不能采用修订稿" }
        },
      })
      const { database, investigation, input } = await harness(runningAgent)
      try {
        const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

        expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
        const rejected = caught as SupportModelOutputRejectedError
        expect(rejected.pipelineAudit).toMatchObject({
          finalSource: "baseline",
          fallbackReason: expect.stringContaining("blocked_not_sent"),
        })
        expect(auditStages(rejected)).toEqual(["gate", "baseline_review", "revision_review", "blocked"])
      } finally {
        database.close()
      }
    },
  )

  it("成稿模型异常时阻断发送并保留阶段审计", async () => {
    const runningAgent = agent({
      compose: async () => { throw new Error("composer unavailable") },
      review: async () => ({ outcome: "revise", issues: ["需要修订"], reason: "基线未通过" }),
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      const rejected = caught as SupportModelOutputRejectedError
      expect(rejected.pipelineAudit?.fallbackReason).toContain("blocked_not_sent")
      expect(auditStages(rejected)).toEqual(["gate", "baseline_review", "blocked"])
    } finally {
      database.close()
    }
  })

  it("审核模型异常时阻断发送且不调用成稿模型", async () => {
    const compose = vi.fn(async () => revisedCandidate())
    const runningAgent = agent({
      compose,
      review: async () => { throw new Error("reviewer unavailable") },
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      const rejected = caught as SupportModelOutputRejectedError
      expect(compose).not.toHaveBeenCalled()
      expect(auditStages(rejected)).toEqual(["gate", "blocked"])
    } finally {
      database.close()
    }
  })

  it("审核模型结构无效时保留 structured_output_invalid 分类并附带阻断审计", async () => {
    const compose = vi.fn(async () => revisedCandidate())
    const runningAgent = agent({
      compose,
      review: async () => {
        throw new ModelExecutionError("structured_output_invalid", "审核模型结构无效")
      },
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(ModelExecutionError)
      expect(caught).toMatchObject({
        code: "structured_output_invalid",
        pipelineAudit: {
          finalSource: "baseline",
          fallbackReason: expect.stringContaining("blocked_not_sent"),
        },
      })
      expect(auditStages(caught as ModelExecutionError & {
        pipelineAudit: { reviews: Array<{ stage?: string }> }
      })).toEqual(["gate", "blocked"])
      expect(compose).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("成稿模型结构无效时保留 structured_output_invalid 分类并附带阻断审计", async () => {
    const runningAgent = agent({
      compose: async () => {
        throw new ModelExecutionError("structured_output_invalid", "成稿模型结构无效")
      },
      review: async () => ({ outcome: "revise", issues: ["需要修订"], reason: "基线未通过" }),
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(ModelExecutionError)
      expect(caught).toMatchObject({
        code: "structured_output_invalid",
        pipelineAudit: {
          finalSource: "baseline",
          fallbackReason: expect.stringContaining("blocked_not_sent"),
        },
      })
      expect(auditStages(caught as ModelExecutionError & {
        pipelineAudit: { reviews: Array<{ stage?: string }> }
      })).toEqual(["gate", "baseline_review", "blocked"])
    } finally {
      database.close()
    }
  })

  it("修订稿引用不可出站事实时阻断发送且不进入二审", async () => {
    const invalid = revisedCandidate("内部连接信息")
    invalid.claims = [{ factId: "F4", statement: "内部连接信息" }]
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "revise", issues: ["需要修订"], reason: "基线未通过" }
    ))
    const { database, investigation, input } = await harness(agent({ compose: async () => invalid, review }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      const rejected = caught as SupportModelOutputRejectedError
      expect(review).toHaveBeenCalledOnce()
      expect(auditStages(rejected)).toEqual(["gate", "baseline_review", "blocked"])
    } finally {
      database.close()
    }
  })

  it("严格场景缺少成稿或审核能力时失败关闭", async () => {
    const runningAgent: SupportDecisionAgentPort = {
      decide: vi.fn(async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot?.repositories[0]?.snapshotPath
        if (codeRoot) {
          await decisionInput.onCommandObservations?.([{
            command: `rg --files ${codeRoot}`,
            output: "src/OrderService.java",
            exitCode: 0,
          }])
        }
        return transactionDecision()
      }),
    }
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      const rejected = caught as SupportModelOutputRejectedError
      expect(rejected.pipelineAudit?.fallbackReason).toContain("blocked_not_sent")
    } finally {
      database.close()
    }
  })

  it("普通非交易解释也必须经独立 reviewer 批准后采用基线", async () => {
    const compose = vi.fn(async () => revisedCandidate())
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.reviewLevel).toBe("standard")
      return { outcome: "approve", issues: [], reason: "一般解释的事实引用完整" }
    })
    const runningAgent = agent({ decide: async () => generalDecision(), compose, review })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(generalDecision().answer)
      expect(result.pipelineAudit).toMatchObject({
        version: "evidence-binding-review-v2",
        mode: "multi_stage",
        finalSource: "baseline",
      })
      expect(auditStages(result)).toEqual(["gate", "baseline_review"])
      expect(compose).not.toHaveBeenCalled()
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("runtime 事实即使模型声明 standard 也以 strict 级别交给 reviewer", async () => {
    const decision = generalDecision()
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      provenance: "runtime",
      evidenceSource: "log",
      evidence: "本轮日志确认正常处理",
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      provenance: "runtime",
      evidenceSource: "log",
      evidence: "本轮日志确认正常处理",
    }
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.reviewLevel).toBe("strict")
      return { outcome: "approve", issues: [], reason: "运行事实已按严格级别审核" }
    })
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      review,
    }))
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.evidencePacket.reviewLevel).toBe("strict")
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("模型自报 database 来源但本轮没有数据库结果时不能确认责任", async () => {
    const decision = generalDecision()
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      provenance: "runtime",
      evidenceSource: "database",
      evidence: '"status":"UNVERIFIED"',
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      provenance: "runtime",
      evidenceSource: "database",
      evidence: '"status":"UNVERIFIED"',
    }
    decision.responsibility = {
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["database"],
      factIds: ["F1"],
    }
    const compose = vi.fn(async (_input: SupportReplyCompositionInput): Promise<ComposedReply> => {
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核没有真实数据库结果的责任结论" }
    ))
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      compose,
      review,
      runtimeObservation: false,
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(compose.mock.calls[0]![0].revisionFeedback?.join("\n")).toContain("responsibility_source_unbound")
      expect(compose.mock.calls[0]![0].decision.responsibility).toEqual({
        party: "unknown",
        certainty: "unknown",
        evidenceSources: [],
        factIds: [],
      })
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("推断责任任一 factId 未绑定时整体降级而不是静默丢弃", async () => {
    const decision = generalDecision()
    decision.evidencePacket.facts.push({
      id: "F2",
      statement: "未绑定的文档事实",
      provenance: "document",
      evidenceSource: "document",
      evidence: "不存在于本轮可信文档正文",
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    })
    decision.responsibility = {
      party: "upstream",
      certainty: "inference",
      evidenceSources: ["code", "document"],
      factIds: ["F1", "F2"],
    }
    const compose = vi.fn(async (_input: SupportReplyCompositionInput): Promise<ComposedReply> => {
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未绑定事实支持的推断责任" }
    ))
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      compose,
      review,
      runtimeObservation: false,
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(compose.mock.calls[0]![0].revisionFeedback?.join("\n")).toContain("responsibility_source_unbound")
      expect(compose.mock.calls[0]![0].decision.responsibility).toEqual({
        party: "unknown",
        certainty: "unknown",
        evidenceSources: [],
        factIds: [],
      })
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("推断责任保留全部逐字绑定且来源允许的 factIds", async () => {
    const decision = generalDecision()
    decision.responsibility = {
      party: "merchant",
      certainty: "inference",
      evidenceSources: ["code"],
      factIds: ["F1"],
    }
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.decision.responsibility).toEqual({
        party: "merchant",
        certainty: "inference",
        evidenceSources: ["code"],
        factIds: ["F1"],
      })
      return { outcome: "approve", issues: [], reason: "推断责任事实引用完整且仍需语义审核" }
    })
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      review,
      runtimeObservation: false,
    }))
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.responsibility).toEqual(decision.responsibility)
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("代码快照和未命中命令元数据不能确认责任", async () => {
    const decision = generalDecision()
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      evidence: "src/MissingRule.java",
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      evidence: "src/MissingRule.java",
    }
    decision.evidencePacket.facts.push({
      id: "F2",
      statement: "模型自报数据库责任记录",
      provenance: "runtime",
      evidenceSource: "database",
      evidence: '"status":"MISSING"',
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    })
    decision.responsibility = {
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code", "database"],
      factIds: ["F1", "F2"],
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("responsibility_source_unbound")
      expect(compositionInput.decision.responsibility).toMatchObject({ party: "unknown", certainty: "unknown" })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核只有快照和命令元数据的责任结论" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot!.repositories[0]!.snapshotPath
        await decisionInput.onCommandObservations?.([{
          command: `rg --files ${codeRoot}`,
          output: "",
          exitCode: 0,
        }, {
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT status FROM orders WHERE merchant_order_no='M-NOT-FOUND' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
      codeObservation: false,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      resourceBroker: {
        verifyDatabaseQuery: async () => ({ columns: ["status"], rows: [], truncated: false }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("trace 有实际代码和数据库结果但证据包没有对应运行事实时仍不能确认责任", async () => {
    const codeEvidence = "src/ResponsibilityRule.java"
    const decision = generalDecision()
    decision.answerClaims[0] = { ...decision.answerClaims[0]!, evidence: codeEvidence }
    decision.evidencePacket.facts[0] = { ...decision.evidencePacket.facts[0]!, evidence: codeEvidence }
    decision.responsibility = {
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code"],
      factIds: ["F1"],
    }
    const compose = vi.fn(async (_input: SupportReplyCompositionInput): Promise<ComposedReply> => {
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未与证据包事实相连的责任来源" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot!.repositories[0]!.snapshotPath
        await decisionInput.onCommandObservations?.([{
          command: `rg --files ${codeRoot}`,
          output: codeEvidence,
          exitCode: 0,
        }, {
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT status FROM orders WHERE merchant_order_no='M-UNRELATED' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
      codeObservation: false,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["status"],
          rows: [{ status: "CONFIRMED" }],
          truncated: false,
        }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(compose.mock.calls[0]![0].revisionFeedback?.join("\n")).toContain("responsibility_source_unbound")
      expect(compose.mock.calls[0]![0].decision.responsibility).toEqual({
        party: "unknown",
        certainty: "unknown",
        evidenceSources: [],
        factIds: [],
      })
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("已确认责任任一 factId 未绑定时整体降级而不是保留其余有效引用", async () => {
    const codeEvidence = "src/ResponsibilityRule.java"
    const databaseEvidence = '"status":"CONFIRMED"'
    const decision = generalDecision()
    decision.answerClaims[0] = { ...decision.answerClaims[0]!, evidence: codeEvidence }
    decision.evidencePacket.facts[0] = { ...decision.evidencePacket.facts[0]!, evidence: codeEvidence }
    decision.evidencePacket.facts.push({
      id: "F2",
      statement: "数据库存在另一条已核验记录",
      provenance: "runtime",
      evidenceSource: "database",
      evidence: databaseEvidence,
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    }, {
      id: "F3",
      statement: "未绑定的文档责任事实",
      provenance: "document",
      evidenceSource: "document",
      evidence: "不存在于本轮可信文档正文",
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    })
    decision.responsibility = {
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code", "database", "document"],
      factIds: ["F1", "F2", "F3"],
    }
    const compose = vi.fn(async (_input: SupportReplyCompositionInput): Promise<ComposedReply> => {
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应静默丢弃未绑定的责任引用" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot!.repositories[0]!.snapshotPath
        await decisionInput.onCommandObservations?.([{
          command: `rg --files ${codeRoot}`,
          output: codeEvidence,
          exitCode: 0,
        }, {
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT status FROM orders WHERE merchant_order_no='M-CONFIRMED' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
      codeObservation: false,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["status"],
          rows: [{ status: "CONFIRMED" }],
          truncated: false,
        }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(compose.mock.calls[0]![0].revisionFeedback?.join("\n")).toContain("responsibility_source_unbound")
      expect(compose.mock.calls[0]![0].decision.responsibility).toEqual({
        party: "unknown",
        certainty: "unknown",
        evidenceSources: [],
        factIds: [],
      })
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("证据包内实际代码事实和数据库事实共同绑定时由宿主重建已确认责任来源", async () => {
    const codeEvidence = "src/ResponsibilityRule.java"
    const databaseEvidence = '"status":"CONFIRMED"'
    const decision = generalDecision()
    decision.answerClaims[0] = { ...decision.answerClaims[0]!, evidence: codeEvidence }
    decision.evidencePacket.facts[0] = { ...decision.evidencePacket.facts[0]!, evidence: codeEvidence }
    decision.evidencePacket.facts.push({
      id: "F2",
      statement: "数据库存在本轮已确认的责任核验记录",
      provenance: "runtime",
      evidenceSource: "database",
      evidence: databaseEvidence,
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    })
    decision.responsibility = {
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code", "database"],
      factIds: ["F1", "F2"],
    }
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.decision.responsibility).toEqual({
        party: "our_side",
        certainty: "confirmed",
        evidenceSources: ["code", "database"],
        factIds: ["F1", "F2"],
      })
      return { outcome: "approve", issues: [], reason: "代码与数据库结果共同支撑责任结论" }
    })
    const runningAgent = agent({
      decide: async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot!.repositories[0]!.snapshotPath
        await decisionInput.onCommandObservations?.([{
          command: `rg --files ${codeRoot}`,
          output: codeEvidence,
          exitCode: 0,
        }, {
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT status FROM orders WHERE merchant_order_no='M-CONFIRMED' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      review,
      codeObservation: false,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["status"],
          rows: [{ status: "CONFIRMED" }],
          truncated: false,
        }),
      },
    })
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.responsibility).toEqual({
        party: "our_side",
        certainty: "confirmed",
        evidenceSources: ["code", "database"],
        factIds: ["F1", "F2"],
      })
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("责任 factId 的依赖闭包含 recommendation memory 时整体降级", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000729"
    const memoryEvidence = "一般处理建议应保留可复核证据"
    const codeEvidence = "src/ResponsibilityRule.java"
    const databaseEvidence = '"status":"CONFIRMED"'
    const decision = generalDecision()
    decision.usedMemoryVersionIds = [memoryId]
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      factId: "F2",
      evidence: codeEvidence,
    }
    decision.evidencePacket.facts = [{
      id: "F1",
      statement: "一般处理建议应保留可复核证据",
      provenance: "recommendation",
      evidenceSource: "memory",
      evidence: memoryEvidence,
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    }, {
      id: "F2",
      statement: "这是正常处理流程",
      provenance: "code",
      evidenceSource: "code",
      evidence: codeEvidence,
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: ["F1"],
    }, {
      id: "F3",
      statement: "数据库存在本轮责任核验记录",
      provenance: "runtime",
      evidenceSource: "database",
      evidence: databaseEvidence,
      certainty: "confirmed",
      outboundSafe: true,
      subjectKind: "general",
      businessType: "not_applicable",
      identifiers: [],
      associationId: null,
      dependsOnFactIds: [],
    }]
    decision.responsibility = {
      party: "our_side",
      certainty: "confirmed",
      evidenceSources: ["code", "database"],
      factIds: ["F2", "F3"],
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("responsibility_source_unbound")
      expect(compositionInput.decision.responsibility).toEqual({
        party: "unknown",
        certainty: "unknown",
        evidenceSources: [],
        factIds: [],
      })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核依赖记忆建议的责任结论" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT status FROM orders LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(
      runningAgent,
      [activeMemory(memoryId, memoryEvidence)],
      [],
      {
        resourceBroker: {
          verifyDatabaseQuery: async () => ({
            columns: ["status"],
            rows: [{ status: "CONFIRMED" }],
            truncated: false,
          }),
        },
      },
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("仅取得代码快照不能验证模型自报的 code fact", async () => {
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未经实际代码读取验证的事实" }
    ))
    const { database, investigation, input } = await harness(agent({
      decide: async () => generalDecision(),
      review,
      codeObservation: false,
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(auditStages(caught as SupportModelOutputRejectedError)).toEqual(["gate", "blocked"])
      expect((caught as SupportModelOutputRejectedError).pipelineAudit?.reviews[0]?.issues.join("\n"))
        .toContain("observation_unbound")
      expect((caught as SupportModelOutputRejectedError).pipelineAudit?.evidencePacket?.facts[0])
        .toMatchObject({ id: "F1", outboundSafe: false })
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("不能通过把代码结论伪装成 recommendation 来绑定通用快照元数据", async () => {
    const decision = generalDecision()
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      provenance: "recommendation",
      evidence: "branch=main",
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      provenance: "recommendation",
      evidence: "branch=main",
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核伪装来源" }
    ))
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      compose,
      review,
      codeObservation: false,
    }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("父进程数据库 observation 与模型自报值不一致时保留事实引用但标记 observation_unbound", async () => {
    const identifier = "M-ASKED"
    const databaseEvidence = `"merchant_order_no":"${identifier}","status":"SUCCESS"`
    const decision = databaseTransactionDecision(identifier, databaseEvidence)
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts.map((fact) => fact.id)).toEqual(["F1", "F2"])
      expect(compositionInput.evidencePacket.facts.find((fact) => fact.id === "F2")?.outboundSafe).toBe(false)
      expect(compositionInput.evidencePacket.associations[0]?.factIds).toEqual(["F1", "F2"])
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未绑定事实" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT merchant_order_no,status FROM orders WHERE merchant_order_no='${identifier}' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: `请核对商户订单 ${identifier}`,
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["merchant_order_no", "status"],
          rows: [{ merchant_order_no: "M-WRONG", status: "SUCCESS" }],
          truncated: false,
        }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
      expect((caught as SupportModelOutputRejectedError).pipelineAudit?.reviews[0]?.issues.join("\n"))
        .toContain("observation_unbound")
    } finally {
      database.close()
    }
  })

  it("数据库查询条件和返回行数元数据不能伪装成实际结果中的稳定标识", async () => {
    const queriedIdentifier = "M-QUERY-METADATA"
    const decision = databaseTransactionDecision(queriedIdentifier, "返回行数=1")
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[1]).toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核仅命中查询元数据的数据库事实" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT merchant_order_no,status FROM orders WHERE merchant_order_no='${queriedIdentifier}' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: `请核对商户订单 ${queriedIdentifier}`,
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["merchant_order_no", "status"],
          rows: [{ merchant_order_no: "M-ACTUAL-RESULT", status: "SUCCESS" }],
          truncated: false,
        }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("只读命令和退出码元数据不能伪装成日志结果中的稳定标识", async () => {
    const queriedIdentifier = "M-QUERY-METADATA"
    const decision = transactionDecision({
      leftIdentifier: queriedIdentifier,
      rightIdentifier: queriedIdentifier,
      matchedIdentifier: queriedIdentifier,
    })
    decision.answer = "运行记录确认了这笔订单。"
    decision.answerClaims = [{
      factId: "F6",
      statement: "运行记录确认了这笔订单",
      provenance: "runtime",
      evidenceSource: "log",
      evidence: "退出码=0",
    }]
    decision.evidencePacket.facts = decision.evidencePacket.facts
      .filter((fact) => fact.id === "F1" || fact.id === "F6")
    decision.evidencePacket.facts.find((fact) => fact.id === "F1")!.evidence = `请核对商户订单 ${queriedIdentifier}`
    decision.evidencePacket.facts.find((fact) => fact.id === "F6")!.evidence = "退出码=0"
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts.find((fact) => fact.id === "F6"))
        .toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核仅命中命令元数据的日志事实" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `ssh -F ${decisionInput.resourceWorkspacePath}/ssh_config -- support-1 'journalctl -u ${queriedIdentifier} --since 2026-08-22 -n 10 -o cat --no-pager'`,
          output: "merchant_order_no=M-ACTUAL-RESULT status=SUCCESS",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
      codeObservation: false,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: `请核对商户订单 ${queriedIdentifier}`,
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("日志结果正文同时包含逐字证据和稳定标识时仍可确认", async () => {
    const identifier = "M-ACTUAL-RESULT"
    const logEvidence = `merchant_order_no=${identifier} status=SUCCESS`
    const decision = transactionDecision({
      leftIdentifier: identifier,
      rightIdentifier: identifier,
      matchedIdentifier: identifier,
    })
    decision.answer = "运行记录确认了这笔订单。"
    decision.answerClaims = [{
      factId: "F6",
      statement: "运行记录确认了这笔订单",
      provenance: "runtime",
      evidenceSource: "log",
      evidence: logEvidence,
    }]
    decision.evidencePacket.facts = decision.evidencePacket.facts
      .filter((fact) => fact.id === "F1" || fact.id === "F6")
    decision.evidencePacket.facts.find((fact) => fact.id === "F1")!.evidence = `请核对商户订单 ${identifier}`
    decision.evidencePacket.facts.find((fact) => fact.id === "F6")!.evidence = logEvidence
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts.find((fact) => fact.id === "F6"))
        .toMatchObject({ outboundSafe: true })
      return { outcome: "approve", issues: [], reason: "日志结果正文逐字支撑事实和稳定标识" }
    })
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `ssh -F ${decisionInput.resourceWorkspacePath}/ssh_config -- support-1 'journalctl -u support --since 2026-08-22 -n 10 -o cat --no-pager'`,
          output: logEvidence,
          exitCode: 0,
        }])
        return decision
      },
      review,
      codeObservation: false,
      runtimeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: `请核对商户订单 ${identifier}`,
    })
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("不能用 inferred certainty 绕过 runtime 数据库事实的 observation 绑定", async () => {
    const identifier = "M-INFERRED-BYPASS"
    const databaseEvidence = `"merchant_order_no":"${identifier}","status":"SUCCESS"`
    const decision = databaseTransactionDecision(identifier, databaseEvidence)
    decision.evidencePacket.facts[1] = {
      ...decision.evidencePacket.facts[1]!,
      certainty: "inferred",
      dependsOnFactIds: ["F1"],
    }
    const compose = vi.fn(async (_compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核混搭推断来源" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT merchant_order_no,status FROM orders WHERE merchant_order_no='${identifier}' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: `请核对商户订单 ${identifier}`,
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["merchant_order_no", "status"],
          rows: [{ merchant_order_no: "M-WRONG", status: "SUCCESS" }],
          truncated: false,
        }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      const compositionInput = compose.mock.calls[0]![0]
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[1]).toMatchObject({ outboundSafe: false })
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("同一父进程数据库 observation 的逐字证据和标识仍可确认并回答", async () => {
    const identifier = "M-ASKED"
    const databaseEvidence = `"merchant_order_no":"${identifier}","status":"SUCCESS"`
    const decision = databaseTransactionDecision(identifier, databaseEvidence)
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts.map((fact) => fact.outboundSafe)).toEqual([true, true])
      expect(reviewInput.trustedInvestigation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "database", evidence: expect.stringContaining(databaseEvidence) }),
      ]))
      return { outcome: "approve", issues: [], reason: "逐字证据与标识均来自同一数据库 observation" }
    })
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT merchant_order_no,status FROM orders WHERE merchant_order_no='${identifier}' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      review,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: `请核对商户订单 ${identifier}`,
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["merchant_order_no", "status"],
          rows: [{ merchant_order_no: identifier, status: "SUCCESS" }],
          truncated: false,
        }),
      },
    })
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(auditStages(result)).toEqual(["gate", "baseline_review"])
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("普通无标识事实也必须逐字绑定到同一可信 observation", async () => {
    const decision = generalDecision()
    decision.answer = "模型概括的普通事实。"
    decision.answerClaims[0] = {
      factId: "F1",
      statement: "模型概括的普通事实",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "模型概括的普通事实",
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      statement: "模型概括的普通事实",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: "模型概括的普通事实",
      certainty: "reported",
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ id: "F1", outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未绑定事实" }
    ))
    const { database, investigation, input } = await harness(agent({ decide: async () => decision, compose, review }), [], [], {
      question: "请解释普通流程",
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("普通无标识事实逐字来自消息 observation 时保留 reviewer 正常路径", async () => {
    const question = "请解释普通流程"
    const decision = generalDecision()
    decision.answer = "运营正在询问普通流程。"
    decision.answerClaims[0] = {
      factId: "F1",
      statement: "运营正在询问普通流程",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: question,
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      statement: "运营正在询问普通流程",
      provenance: "user_report",
      evidenceSource: "message",
      evidence: question,
      certainty: "reported",
    }
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts[0]).toMatchObject({ id: "F1", outboundSafe: true })
      return { outcome: "approve", issues: [], reason: "普通事实已逐字绑定消息" }
    })
    const { database, investigation, input } = await harness(agent({ decide: async () => decision, review }), [], [], {
      question,
    })
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(auditStages(result)).toEqual(["gate", "baseline_review"])
    } finally {
      database.close()
    }
  })

  it("接口文档标题元数据不能伪装成字段契约正文", async () => {
    const documentTitle = "bank_reference 字段契约"
    const decision = generalDecision()
    decision.answer = "bank_reference 的字段含义已经确认。"
    decision.answerClaims[0] = {
      factId: "F1",
      statement: "bank_reference 的字段含义已经确认",
      provenance: "document",
      evidenceSource: "document",
      evidence: documentTitle,
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      statement: "bank_reference 的字段含义已经确认",
      provenance: "document",
      evidenceSource: "document",
      evidence: documentTitle,
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核仅命中文档标题的契约事实" }
    ))
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, compose, review }),
      [],
      [],
      {
        question: "bank_reference 字段怎么填写",
        staticDocuments: [{
          source: "interface_non_india",
          title: documentTitle,
          scope: "non_india",
          content: "本节正文只说明请求追踪流程，没有定义该字段语义。",
          capturedAt: "2026-08-22T00:00:00.000Z",
        }],
      },
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("接口文档结果正文逐字包含字段契约时仍可作为一般契约事实", async () => {
    const documentEvidence = "bank_reference 表示银行返回的交易参考号"
    const decision = generalDecision()
    decision.answer = "bank_reference 表示银行返回的交易参考号。"
    decision.answerClaims[0] = {
      factId: "F1",
      statement: documentEvidence,
      provenance: "document",
      evidenceSource: "document",
      evidence: documentEvidence,
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      statement: documentEvidence,
      provenance: "document",
      evidenceSource: "document",
      evidence: documentEvidence,
    }
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: true })
      return { outcome: "approve", issues: [], reason: "字段含义逐字来自文档正文" }
    })
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, review }),
      [],
      [],
      {
        question: "bank_reference 字段怎么填写",
        staticDocuments: [{
          source: "interface_non_india",
          title: "交易字段说明",
          scope: "non_india",
          content: documentEvidence,
          capturedAt: "2026-08-22T00:00:00.000Z",
        }],
      },
    )
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("截图展示的稳定标识没有宿主视觉文本 observation 时不得成为交易匹配端点", async () => {
    const identifier = "M-SCREEN"
    const databaseEvidence = `"merchant_order_no":"${identifier}","status":"SUCCESS"`
    const decision = databaseTransactionDecision(identifier, databaseEvidence)
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      provenance: "display",
      evidence: `截图显示 ${identifier}`,
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ id: "F1", outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未绑定截图事实" }
    ))
    const runningAgent = agent({
      decide: async (decisionInput) => {
        await decisionInput.onCommandObservations?.([{
          command: `node ${decisionInput.resourceWorkspacePath}/query-database.mjs --database primary --sql "SELECT merchant_order_no,status FROM orders WHERE merchant_order_no='${identifier}' LIMIT 1" --rows 3`,
          output: "模型助手自报查询成功",
          exitCode: 0,
        }])
        return decision
      },
      compose,
      review,
    })
    const { database, investigation, input } = await harness(runningAgent, [], [], {
      question: "请看附件",
      attachments: [{
        name: "synthetic-screen.png",
        kind: "image",
        mimeType: "image/png",
        size: 128,
        extractedText: `截图显示 ${identifier}`,
        localPath: "/synthetic/synthetic-screen.png",
      }],
      resourceBroker: {
        verifyDatabaseQuery: async () => ({
          columns: ["merchant_order_no", "status"],
          rows: [{ merchant_order_no: identifier, status: "SUCCESS" }],
          truncated: false,
        }),
      },
    })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("真实原图允许无稳定标识的 reported display 事实按截图显示限定语回答", async () => {
    const decision = displayGeneralDecision()
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts[0]).toMatchObject({
        provenance: "display",
        certainty: "reported",
        outboundSafe: true,
        identifiers: [],
      })
      expect(reviewInput.trustedInvestigation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "message",
          title: "读取本轮附件",
          evidence: expect.stringContaining("visualInputAttached=true"),
        }),
      ]))
      return { outcome: "approve", issues: [], reason: "仅按截图显示描述且未用于交易绑定" }
    })
    const { database, investigation, input } = await harness(agent({ decide: async () => decision, review }), [], [], {
      question: "请看截图",
      attachments: [{
        name: "synthetic-screen.png",
        kind: "image",
        mimeType: "image/png",
        size: 128,
        extractedText: "图片附件：synthetic-screen.png；本机路径 /synthetic/synthetic-screen.png",
        localPath: "/synthetic/synthetic-screen.png",
      }],
    })
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("display 候选的独立 reviewer 收到本轮全部真实原图且拒绝后不出站", async () => {
    const imageDirectory = await mkdtemp(path.join(tmpdir(), "reply-review-images-"))
    temporaryDirectories.push(imageDirectory)
    const successImage = path.join(imageDirectory, "success.png")
    const failedImage = path.join(imageDirectory, "failed.png")
    await writeFile(successImage, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ))
    await writeFile(failedImage, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
      "base64",
    ))
    const execute = vi.fn(async (_purpose: string, _execution: {
      validator: unknown
      images?: Array<{ path: string; mimeType: string; name: string }>
    }) => {
      const callIndex = execute.mock.calls.length
      if (callIndex === 1) return displayGeneralDecision()
      if (callIndex === 2) return { outcome: "revise", issues: ["截图内容与候选结论冲突"], reason: "原图复核未通过" }
      if (callIndex === 3) {
        return {
          answer: "截图显示页面状态为处理中。",
          quote: null,
          claims: [{ factId: "F1", statement: "截图显示页面状态为处理中" }],
          usedMemoryVersionIds: [],
        }
      }
      return { outcome: "revise", issues: ["两张原图显示相反状态"], reason: "不能批准出站" }
    })
    const attachments: SupportAttachmentContext[] = [{
      name: "success.png",
      kind: "image",
      mimeType: "image/png",
      size: 68,
      extractedText: "不可信提取文本：成功",
      localPath: successImage,
    }, {
      name: "failed.png",
      kind: "image",
      mimeType: "image/png",
      size: 68,
      extractedText: "不可信提取文本：失败",
      localPath: failedImage,
    }]
    const { database, investigation, input } = await harness(
      new CodexSupportDecisionAgent({ execute } as never),
      [],
      [],
      { question: "请按两张截图核对状态", attachments },
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(execute).toHaveBeenCalledTimes(4)
      for (const callIndex of [1, 3]) {
        expect(execute.mock.calls[callIndex]?.[1].images).toEqual([
          { path: successImage, mimeType: "image/png", name: "success.png" },
          { path: failedImage, mimeType: "image/png", name: "failed.png" },
        ])
      }
    } finally {
      database.close()
    }
  })

  it.each([
    ["没有真实原图", [] as SupportAttachmentContext[], "reported" as const],
    ["把截图事实自报为 confirmed", [{
      name: "synthetic-screen.png",
      kind: "image" as const,
      mimeType: "image/png",
      size: 128,
      extractedText: "仅有文件元数据",
      localPath: "/synthetic/synthetic-screen.png",
    }], "confirmed" as const],
  ])("%s 时 display 事实仍须 observation_unbound", async (_label, attachments, certainty) => {
    const decision = displayGeneralDecision(certainty)
    const compose = vi.fn(async (_input: SupportReplyCompositionInput): Promise<ComposedReply> => {
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核不可信截图事实" }
    ))
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, compose, review }),
      [],
      [],
      { question: "请看截图", attachments },
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(compose.mock.calls[0]![0].revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("仅把本轮实际引用且已检索的 memory 作为普通事实可信 observation", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000721"
    const memory = activeMemory(memoryId, "对外沟通需要提供我方证据")
    const decision = {
      ...generalDecision(),
      answer: "对外沟通需要提供我方证据。",
      usedMemoryVersionIds: [memoryId],
      answerClaims: [{
        factId: "F1",
        statement: "对外沟通需要提供我方证据",
        provenance: "memory",
        evidenceSource: "memory",
        evidence: "对外沟通需要提供我方证据",
      }],
      responsibility: { party: "not_applicable", certainty: "not_applicable", evidenceSources: [], factIds: [] },
      evidencePacket: {
        ...generalDecision().evidencePacket,
        facts: [{
          id: "F1",
          statement: "对外沟通需要提供我方证据",
          provenance: "memory",
          evidenceSource: "memory",
          evidence: "对外沟通需要提供我方证据",
          certainty: "confirmed",
          outboundSafe: true,
          subjectKind: "general",
          businessType: "not_applicable",
          identifiers: [],
          associationId: null,
          dependsOnFactIds: [],
        }],
      },
    } as unknown as AnswerDecision
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: true, evidenceSource: "memory" })
      expect(reviewInput.trustedInvestigation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "memory",
          status: "confirmed",
          evidence: expect.stringContaining('逐字摘录JSON=["对外沟通需要提供我方证据"]'),
        }),
      ]))
      return { outcome: "approve", issues: [], reason: "一般记忆事实已逐字绑定本轮检索结果" }
    })
    const { database, investigation, input } = await harness(agent({ decide: async () => decision, review }), [memory])
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.usedMemoryVersionIds).toEqual([memoryId])
      expect(auditStages(result)).toEqual(["gate", "baseline_review"])
    } finally {
      database.close()
    }
  })

  it("本轮实际引用的 memory 可逐字支撑一般处理建议但不能伪装运行事实", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000722"
    const evidence = "对外沟通前保留可复核证据"
    const memory = activeMemory(memoryId, evidence)
    const decision = memoryGeneralDecision(memoryId, evidence)
    decision.answerClaims[0] = { ...decision.answerClaims[0]!, provenance: "recommendation" }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      provenance: "recommendation",
    }
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts[0]).toMatchObject({
        provenance: "recommendation",
        evidenceSource: "memory",
        outboundSafe: true,
      })
      return { outcome: "approve", issues: [], reason: "一般建议逐字绑定到本轮实际引用记忆" }
    })
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, review }),
      [memory],
    )
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.usedMemoryVersionIds).toEqual([memoryId])
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it.each([
    ["memoryVersionId", (memory: MemoryView) => memory.id],
    ["title", (memory: MemoryView) => memory.title],
  ] as const)("memory 的 %s 元数据不能伪装成已核验正文摘录", async (_label, evidenceFor) => {
    const memoryId = "00000000-0000-4000-8000-000000000726"
    const memory = activeMemory(memoryId, "对外沟通需要提供我方证据")
    const decision = memoryGeneralDecision(memoryId, evidenceFor(memory))
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核仅命中记忆元数据的事实" }
    ))
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, compose, review }),
      [memory],
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("已检索但模型未声明 usedMemoryVersionIds 的 memory 不能生成可绑定摘录", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000727"
    const memoryEvidence = "对外沟通需要提供我方证据"
    const memory = activeMemory(memoryId, memoryEvidence)
    const decision = memoryGeneralDecision(memoryId, memoryEvidence)
    decision.usedMemoryVersionIds = []
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核未声明实际引用版本的 memory 事实" }
    ))
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, compose, review }),
      [memory],
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("高步骤调查仍为实际引用 memory 预留可信轨迹槽位且保留运行证据", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000725"
    const memory = activeMemory(memoryId, "对外沟通需要提供我方证据")
    const decision = generalDecision()
    decision.answer = "对外沟通需要提供我方证据。"
    decision.usedMemoryVersionIds = [memoryId]
    decision.answerClaims = [{
      factId: "F1",
      statement: "对外沟通需要提供我方证据",
      provenance: "memory",
      evidenceSource: "memory",
      evidence: "对外沟通需要提供我方证据",
    }]
    decision.responsibility = {
      party: "not_applicable",
      certainty: "not_applicable",
      evidenceSources: [],
      factIds: [],
    }
    decision.evidencePacket = {
      ...decision.evidencePacket,
      facts: [{
        id: "F1",
        statement: "对外沟通需要提供我方证据",
        provenance: "memory",
        evidenceSource: "memory",
        evidence: "对外沟通需要提供我方证据",
        certainty: "confirmed",
        outboundSafe: true,
        subjectKind: "general",
        businessType: "not_applicable",
        identifiers: [],
        associationId: null,
        dependsOnFactIds: [],
      }],
      associations: [],
    }
    const compose = vi.fn(async (): Promise<ComposedReply> => {
      throw new Error("实际引用 memory 不应因轨迹截断进入修订")
    })
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.trustedInvestigation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "memory", evidence: expect.stringContaining(memoryId) }),
        expect.objectContaining({ source: "code", evidence: expect.stringContaining("实际命令=rg --files") }),
      ]))
      expect(reviewInput.trustedInvestigation.steps).toHaveLength(24)
      return { outcome: "approve", issues: [], reason: "记忆和实际运行证据均被确定性保留" }
    })
    const runningAgent = agent({
      decide: async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot!.repositories[0]!.snapshotPath
        await decisionInput.onCommandObservations?.(Array.from({ length: 24 }, (_, index) => ({
          command: `rg --files ${codeRoot}`,
          output: `src/Synthetic${index}.java`,
          exitCode: 0,
        })))
        return decision
      },
      compose,
      review,
    })
    const { database, investigation, input } = await harness(runningAgent, [memory])
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(compose).not.toHaveBeenCalled()
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("高步骤调查优先保留唯一逐字支撑出站事实的末尾 observation", async () => {
    const relevantEvidence = "src/RelevantLast.java"
    const decision = generalDecision()
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      evidence: relevantEvidence,
    }
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      evidence: relevantEvidence,
    }
    const compose = vi.fn(async (): Promise<ComposedReply> => {
      throw new Error("实际引用 observation 不应因同级轨迹截断进入修订")
    })
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: true })
      expect(reviewInput.trustedInvestigation.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "code", evidence: expect.stringContaining(relevantEvidence) }),
      ]))
      return { outcome: "approve", issues: [], reason: "唯一相关的末尾 observation 已被优先保留" }
    })
    const runningAgent = agent({
      decide: async (decisionInput) => {
        const codeRoot = decisionInput.codeSnapshot!.repositories[0]!.snapshotPath
        await decisionInput.onCommandObservations?.(Array.from({ length: 24 }, (_, index) => ({
          command: `rg --files ${codeRoot}`,
          output: index === 23 ? relevantEvidence : `src/Unrelated${index}.java`,
          exitCode: 0,
        })))
        return decision
      },
      compose,
      review,
      codeObservation: false,
    })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.answer).toBe(decision.answer)
      expect(compose).not.toHaveBeenCalled()
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("模型自报未检索 memory id 时不能制造可信 memory observation", async () => {
    const retrievedId = "00000000-0000-4000-8000-000000000722"
    const untrustedId = "00000000-0000-4000-8000-000000000723"
    const memory = activeMemory(retrievedId, "对外沟通需要提供我方证据")
    const decision = {
      ...generalDecision(),
      answer: "对外沟通需要提供我方证据。",
      usedMemoryVersionIds: [untrustedId],
      answerClaims: [{
        factId: "F1",
        statement: "对外沟通需要提供我方证据",
        provenance: "memory",
        evidenceSource: "memory",
        evidence: "对外沟通需要提供我方证据",
      }],
      responsibility: { party: "not_applicable", certainty: "not_applicable", evidenceSources: [], factIds: [] },
      evidencePacket: {
        ...generalDecision().evidencePacket,
        facts: [{
          id: "F1",
          statement: "对外沟通需要提供我方证据",
          provenance: "memory",
          evidenceSource: "memory",
          evidence: "对外沟通需要提供我方证据",
          certainty: "confirmed",
          outboundSafe: true,
          subjectKind: "general",
          businessType: "not_applicable",
          identifiers: [],
          associationId: null,
          dependsOnFactIds: [],
        }],
      },
    } as unknown as AnswerDecision
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.facts[0]).toMatchObject({ outboundSafe: false })
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核伪造的记忆引用" }
    ))
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, compose, review }),
      [memory],
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("memory 即使逐字含订单状态和稳定标识也不能成为当前交易匹配端点", async () => {
    const memoryId = "00000000-0000-4000-8000-000000000724"
    const identifier = "M-MEMORY"
    const memoryEvidence = `历史记忆记录 ${identifier} 状态为 SUCCESS`
    const memory = activeMemory(memoryId, memoryEvidence)
    const decision = databaseTransactionDecision(identifier, memoryEvidence)
    decision.usedMemoryVersionIds = [memoryId]
    decision.answerClaims[0] = {
      ...decision.answerClaims[0]!,
      provenance: "memory",
      evidenceSource: "memory",
    }
    decision.evidencePacket.facts[1] = {
      ...decision.evidencePacket.facts[1]!,
      provenance: "memory",
      evidenceSource: "memory",
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toMatch(/稳定标识|交易关联/u)
      expect(compositionInput.revisionFeedback?.join("\n")).not.toContain("observation_unbound")
      expect(compositionInput.evidencePacket.associations[0]).toMatchObject({ status: "unconfirmed" })
      expect(compositionInput.evidencePacket.facts.filter((fact) => fact.subjectKind === "transaction")
        .every((fact) => !fact.outboundSafe)).toBe(true)
      throw new Error("测试在审核前停止")
    })
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应审核 memory 当前交易结论" }
    ))
    const { database, investigation, input } = await harness(
      agent({ decide: async () => decision, compose, review }),
      [memory],
      [],
      { question: `请核对商户订单 ${identifier}` },
    )
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      expect(compose).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("reviewer 批准后被出站校验阻断时审计明确记录 blocked_not_sent", async () => {
    const decision = generalDecision()
    decision.answer = `${decision.answer}\uFFFD`
    const { database, investigation, input } = await harness(agent({ decide: async () => decision }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SupportModelOutputRejectedError)
      const rejected = caught as SupportModelOutputRejectedError
      expect(auditStages(rejected)).toEqual(["gate", "baseline_review", "blocked"])
      expect(rejected.pipelineAudit?.fallbackReason).toContain("blocked_not_sent")
      expect(rejected.pipelineAudit?.reviews.at(-1)).toMatchObject({
        stage: "blocked",
        outcome: "blocked",
      })
    } finally {
      database.close()
    }
  })

  it("非 ignore 即使自报空 claims 和 facts 也不能绕过 reviewer", async () => {
    const decision = generalDecision()
    decision.answerClaims = []
    decision.evidencePacket.facts = []
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "已独立检查无声明基线" }
    ))
    const runningAgent = agent({ decide: async () => decision, review })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.pipelineAudit.mode).toBe("multi_stage")
      expect(auditStages(result)).toEqual(["gate", "baseline_review"])
      expect(review).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("ignore 保留唯一无需 reviewer 的快速路径", async () => {
    const decision = generalDecision()
    decision.decision = "ignore"
    decision.answer = ""
    decision.answerClaims = []
    decision.evidencePacket = {
      ...decision.evidencePacket,
      communication: { ...decision.evidencePacket.communication, intent: "ignore" },
      facts: [],
      requiredAnswerPoints: [],
    }
    const compose = vi.fn(async () => revisedCandidate())
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应调用" }
    ))
    const runningAgent = agent({ decide: async () => decision, compose, review })
    const { database, investigation, input } = await harness(runningAgent)
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.decision.decision).toBe("ignore")
      expect(result.pipelineAudit.mode).toBe("legacy")
      expect(auditStages(result)).toEqual(["gate"])
      expect(compose).not.toHaveBeenCalled()
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("来源过滤不能把模型声明的交易场景降级成普通快速路径", async () => {
    const decision = transactionDecision()
    decision.answerClaims = []
    decision.evidencePacket.facts[0] = {
      ...decision.evidencePacket.facts[0]!,
      provenance: "runtime",
      evidenceSource: "server",
      certainty: "confirmed",
    }
    decision.evidencePacket.facts[1] = {
      ...decision.evidencePacket.facts[1]!,
      provenance: "runtime",
      evidenceSource: "log",
      certainty: "confirmed",
    }
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput): Promise<ComposedReply> => {
      expect(compositionInput.revisionFeedback?.join("\n")).toContain("observation_unbound")
      expect(compositionInput.evidencePacket.associations[0]).toMatchObject({ id: "A1", status: "unconfirmed" })
      expect(compositionInput.evidencePacket.facts.filter((fact) => fact.subjectKind === "transaction")
        .every((fact) => !fact.outboundSafe)).toBe(true)
      return clarificationCandidate()
    })
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(reviewInput.attempt).toBe(2)
      return { outcome: "approve", issues: [], reason: "已独立检查收窄后的候选" }
    })
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      compose,
      review,
      runtimeObservation: false,
    }))
    try {
      const result = await investigation.investigate(input, new AbortController().signal)

      expect(result.pipelineAudit.mode).toBe("multi_stage")
      expect(compose).toHaveBeenCalledOnce()
      expect(review).toHaveBeenCalledOnce()
      expect(auditStages(result)).toEqual(["gate", "revision_review"])
    } finally {
      database.close()
    }
  })

  it.each([
    ["runtime", "message"],
    ["code", "database"],
  ] as const)("不能用错误来源配对 %s/%s 洗白事实", async (provenance, evidenceSource) => {
    const question = "请解释普通流程"
    const invalid = generalDecision()
    invalid.answer = "运营原话被错误标成运行事实。"
    invalid.answerClaims[0] = {
      factId: "F1",
      statement: "运营原话被错误标成运行事实",
      provenance,
      evidenceSource,
      evidence: question,
    }
    invalid.evidencePacket.facts[0] = {
      ...invalid.evidencePacket.facts[0]!,
      statement: "运营原话被错误标成运行事实",
      provenance,
      evidenceSource,
      evidence: question,
      certainty: "confirmed",
    }
    const review = vi.fn(async (): Promise<ReplyReview> => (
      { outcome: "approve", issues: [], reason: "不应进入审核" }
    ))
    const { database, investigation, input } = await harness(agent({
      decide: async () => invalid,
      review,
      codeObservation: false,
      runtimeObservation: false,
    }), [], [], { question })
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(ModelExecutionError)
      expect(caught).toMatchObject({ code: "structured_output_invalid" })
      expect(auditStages(caught as SupportModelOutputRejectedError)).toEqual(["gate", "blocked"])
      expect(review).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it("事实引用结构错误映射为 structured_output_invalid 以触发整轮重试", async () => {
    const invalid = transactionDecision()
    invalid.answerClaims[0] = { ...invalid.answerClaims[0]!, factId: "F24" }
    const { database, investigation, input } = await harness(agent({ decide: async () => invalid }))
    try {
      const caught = await investigation.investigate(input, new AbortController().signal).catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(ModelExecutionError)
      const rejected = caught as ModelExecutionError & {
        pipelineAudit: NonNullable<SupportModelOutputRejectedError["pipelineAudit"]>
      }
      expect(rejected).toMatchObject({ code: "structured_output_invalid" })
      expect(rejected.pipelineAudit.fallbackReason).toContain("blocked_not_sent")
      expect(auditStages(rejected)).toEqual(["gate", "blocked"])
    } finally {
      database.close()
    }
  })

  it("先按原始值判定不同订单，再脱敏交给成稿模型和审计", async () => {
    const leftSecret = "ORDER-SECRET-ALPHA"
    const rightSecret = "ORDER-SECRET-BRAVO"
    const decision = transactionDecision({
      leftIdentifier: leftSecret,
      rightIdentifier: rightSecret,
      matchedIdentifier: leftSecret,
    })
    decision.evidencePacket.associations[0]!.lookupHints = [{
      kind: "account",
      value: rightSecret,
      factIds: ["F2"],
    }]
    decision.evidencePacket.associations[0]!.conflicts = [{
      field: "identifier",
      leftFactId: "F1",
      rightFactId: "F2",
      summary: `${leftSecret} 与 ${rightSecret} 不一致`,
    }]
    const compose = vi.fn(async (compositionInput: SupportReplyCompositionInput) => {
      const serialized = JSON.stringify(compositionInput.evidencePacket)
      expect(serialized).not.toContain(leftSecret)
      expect(serialized).not.toContain(rightSecret)
      expect(serialized).toContain("[已脱敏]")
      expect(compositionInput.evidencePacket.associations[0]?.matchedIdentifiers).toEqual([])
      return clarificationCandidate()
    })
    const { database, investigation, input } = await harness(agent({
      decide: async () => decision,
      compose,
      review: async () => ({ outcome: "approve", issues: [], reason: "没有混用交易事实" }),
    }), [], [leftSecret, rightSecret])
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      const serializedAudit = JSON.stringify(result.pipelineAudit)

      expect(serializedAudit).not.toContain(leftSecret)
      expect(serializedAudit).not.toContain(rightSecret)
      expect(serializedAudit).toContain("[已脱敏]")
      expect(compose).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it("有效匹配的嵌套标识在审核输入和审计中也不保留原值", async () => {
    const secret = "ORDER-SECRET-SHARED"
    const decision = transactionDecision({
      leftIdentifier: secret,
      rightIdentifier: secret,
      matchedIdentifier: secret,
    })
    decision.evidencePacket.associations[0]!.lookupHints = [{ kind: "account", value: secret, factIds: ["F1"] }]
    const review = vi.fn(async (reviewInput: SupportReplyReviewInput): Promise<ReplyReview> => {
      expect(JSON.stringify(reviewInput.evidencePacket)).not.toContain(secret)
      expect(reviewInput.evidencePacket.associations[0]?.matchedIdentifiers[0]?.value).toBe("[已脱敏]")
      expect(reviewInput.evidencePacket.associations[0]?.lookupHints[0]?.value).toBe("[已脱敏]")
      return { outcome: "approve", issues: [], reason: "通过" }
    })
    const { database, investigation, input } = await harness(agent({ decide: async () => decision, review }), [], [secret], {
      question: `运营提供了商户订单号 ${secret}`,
    })
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(JSON.stringify(result.pipelineAudit)).not.toContain(secret)
    } finally {
      database.close()
    }
  })

  it("采用经审核修订稿时继承调查阶段真实使用的记忆引用", async () => {
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
    let reviewCount = 0
    const compose = vi.fn(async () => ({ ...revisedCandidate(), usedMemoryVersionIds: [memoryId] }))
    const runningAgent = agent({
      decide: async () => transactionDecision({ usedMemoryVersionIds: [memoryId] }),
      compose,
      review: async () => {
        reviewCount += 1
        return reviewCount === 1
          ? { outcome: "revise", issues: ["收窄结论"], reason: "需要修订" }
          : { outcome: "approve", issues: [], reason: "通过" }
      },
    })
    const { database, investigation, input } = await harness(runningAgent, [memory])
    try {
      const result = await investigation.investigate(input, new AbortController().signal)
      expect(result.pipelineAudit.finalSource).toBe("revised_candidate")
      expect(result.decision.usedMemoryVersionIds).toEqual([memoryId])
    } finally {
      database.close()
    }
  })
})
