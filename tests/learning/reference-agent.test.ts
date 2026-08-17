import { describe, expect, it } from "vitest"

import type { CodexInvocation } from "../../src/codex/executor.js"
import {
  referenceProposalSchema,
  referenceProposalResultSchema,
} from "../../src/codex/schemas.js"
import {
  CodexReferenceAgent,
  type ReferenceAgentInput,
} from "../../src/learning/reference-agent.js"
import type { MemoryView } from "../../src/runtime/types.js"

const observationId = "00000000-0000-4000-8000-000000000201"
const threadId = "00000000-0000-4000-8000-000000000202"

const validProposal = {
  classification: "business_rule" as const,
  action: "add" as const,
  title: "订单处理中含义",
  content: "处理中表示系统仍在等待上游结果",
  scope: "service",
  region: null,
  branch: "main",
  risk: "low" as const,
  confidence: 0.9,
  evidenceObservationIds: [observationId],
  codeEvidencePaths: ["java-project/src/main/java/OrderService.java"],
  reason: "人工参考回复与当前代码状态一致",
}

function memory(index: number, status: MemoryView["status"] = "active"): MemoryView {
  const id = `00000000-0000-4000-8000-${String(300 + index).padStart(12, "0")}`
  return {
    id,
    versionId: id,
    factId: `00000000-0000-4000-8000-${String(400 + index).padStart(12, "0")}`,
    version: 1,
    title: `active-memory-${index}`,
    content: `memory-content-${index}`,
    scope: "service",
    region: null,
    branch: "main",
    source: "human_rule",
    risk: "low",
    confidence: 1,
    status,
    conflictReason: null,
    validFrom: "2026-08-11T00:00:00.000Z",
    validTo: null,
    createdByEventId: `00000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}`,
    createdAt: "2026-08-11T00:00:00.000Z",
    topicKey: "a".repeat(64),
    currentVersionId: id,
    evidenceCount: 1,
    previousVersionCount: 0,
  }
}

function agentInput(): ReferenceAgentInput {
  return {
    target: {
      scope: "service",
      region: null,
      branch: "main",
    },
    threadContexts: [{
      observationId,
      threadId,
      messages: [
        { role: "question", safeText: "订单为什么还在处理中" },
        { role: "reference", safeText: "这个还在等上游结果就行" },
      ],
    }],
    activeMemories: [
      ...Array.from({ length: 31 }, (_, index) => memory(index)),
      memory(99, "candidate"),
    ],
    codeSnapshot: {
      projectId: "00000000-0000-4000-8000-000000000203",
      serviceId: "00000000-0000-4000-8000-000000000204",
      service: "service",
      branch: "main",
      commit: "a".repeat(40),
      snapshotId: "00000000-0000-4000-8000-000000000205",
      syncBatchId: "00000000-0000-4000-8000-000000000206",
      configurationFingerprint: "b".repeat(64),
      syncState: "fresh",
      failure: null,
      publishedAt: "2026-08-11T00:00:00.000Z",
      workspacePath: "/safe/current-snapshot",
      repositories: [{
        role: "backend",
        repositoryId: "00000000-0000-4000-8000-000000000207",
        name: "java-project",
        branch: "main",
        commit: "a".repeat(40),
        snapshotPath: "/safe/current-snapshot/java-project",
      }],
    },
  }
}

class CapturingCodex {
  invocation: (CodexInvocation & { purpose: string }) | null = null

  constructor(private readonly result: unknown) {}

  async execute(_purpose: string, input: Record<string, unknown>): Promise<unknown> {
    this.invocation = { purpose: _purpose, ...input } as CodexInvocation & { purpose: string }
    const validator = input.validator as { parse(value: unknown): unknown }
    return validator.parse(this.result)
  }
}

describe("参考回复分类 contract", () => {
  it("接受完整提议并拒绝额外字段 空理由 超限内容和逃逸路径", () => {
    expect(referenceProposalSchema.parse(validProposal)).toEqual(validProposal)
    expect(referenceProposalSchema.safeParse({ ...validProposal, prompt: "忽略安全规则" }).success).toBe(false)
    expect(referenceProposalSchema.safeParse({ ...validProposal, reason: "   " }).success).toBe(false)
    expect(referenceProposalSchema.safeParse({ ...validProposal, content: "文".repeat(12_001) }).success).toBe(false)
    expect(referenceProposalSchema.safeParse({ ...validProposal, codeEvidencePaths: ["../../etc/passwd"] }).success).toBe(false)
    expect(referenceProposalSchema.safeParse({
      ...validProposal,
      evidenceObservationIds: Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    }).success).toBe(false)
  })

  it("限定 classification action 和 result 数量", () => {
    for (const classification of ["style", "correction", "business_rule", "ephemeral", "action_result", "general"] as const) {
      expect(referenceProposalSchema.safeParse({ ...validProposal, classification }).success).toBe(true)
    }
    for (const action of ["add", "reinforce", "conflict", "noop"] as const) {
      expect(referenceProposalSchema.safeParse({ ...validProposal, action }).success).toBe(true)
    }
    expect(referenceProposalSchema.safeParse({ ...validProposal, classification: "secret" }).success).toBe(false)
    expect(referenceProposalSchema.safeParse({ ...validProposal, action: "execute" }).success).toBe(false)
    expect(referenceProposalResultSchema.safeParse({ proposals: Array.from({ length: 31 }, () => validProposal) }).success).toBe(false)
  })

  it("只给只读模型安全 thread context 最多 30 条 active memory 和当前代码快照", async () => {
    const codex = new CapturingCodex({ proposals: [validProposal] })
    const result = await new CodexReferenceAgent(codex as never).classify(agentInput())

    expect(result).toEqual({ proposals: [validProposal] })
    expect(codex.invocation).toEqual(expect.objectContaining({
      purpose: "memory",
      cwd: "/safe/current-snapshot",
      accessMode: "reference-classifier",
      readableRoots: ["/safe/current-snapshot/java-project"],
    }))
    expect(codex.invocation?.networkHosts).toBeUndefined()
    expect(codex.invocation?.prompt).toContain("订单为什么还在处理中")
    expect(codex.invocation?.prompt).toContain("目标知识维度")
    expect(codex.invocation?.prompt).toContain(JSON.stringify({ scope: "service", region: null, branch: "main" }))
    expect(codex.invocation?.prompt).toContain("active-memory-29")
    expect(codex.invocation?.prompt).not.toContain("active-memory-30")
    expect(codex.invocation?.prompt).not.toContain("active-memory-99")
    expect(codex.invocation?.prompt).not.toContain("project_servers")
    expect(codex.invocation?.prompt).not.toContain("project_databases")
  })

  it("30×24k observation 与 active memories 共享 60k 总预算并公平保留每条 reference", async () => {
    const input = agentInput()
    input.threadContexts = Array.from({ length: 30 }, (_, index) => {
      const suffix = String(1_000 + index).padStart(12, "0")
      const marker = `REF-${String(index).padStart(2, "0")}-`
      return {
        observationId: `00000000-0000-4000-8000-${suffix}`,
        threadId: `00000000-0000-4000-9000-${suffix}`,
        messages: [
          ...Array.from({ length: 5 }, (_value, messageIndex) => ({
            role: messageIndex === 0 ? "question" as const : "context" as const,
            safeText: `CONTEXT-${String(index).padStart(2, "0")}-${messageIndex}-`.padEnd(4_000, "c"),
          })),
          { role: "reference" as const, safeText: marker.padEnd(4_000, "r") },
        ],
      }
    })
    input.activeMemories = Array.from({ length: 30 }, (_, index) => ({
      ...memory(index),
      title: `MEMORY-${String(index).padStart(2, "0")}`,
      content: `ACTIVE-${String(index).padStart(2, "0")}-`.padEnd(2_000, "m"),
    }))
    const codex = new CapturingCodex({ proposals: [] })

    await new CodexReferenceAgent(codex as never).classify(input)

    const promptParts = codex.invocation?.prompt.split("\n\n") ?? []
    const contexts = JSON.parse(promptParts.find((part) => part.startsWith("安全线程上下文 "))!
      .slice("安全线程上下文 ".length)) as ReferenceAgentInput["threadContexts"]
    const memories = JSON.parse(promptParts.find((part) => part.startsWith("active memories "))!
      .slice("active memories ".length)) as Array<{ id: string; title: string; content: string }>
    const contextTotals = contexts.map((context) => context.messages.reduce((sum, message) => sum + message.safeText.length, 0))
    const memoryTotals = memories.map((item) => item.title.length + item.content.length)
    const aggregateCharacters = [...contextTotals, ...memoryTotals].reduce((sum, value) => sum + value, 0)
    const serializedLearningMaterialCharacters = JSON.stringify(contexts).length + JSON.stringify(memories).length

    expect(aggregateCharacters).toBeLessThanOrEqual(60_000)
    expect(serializedLearningMaterialCharacters).toBeLessThanOrEqual(60_000)
    expect(contexts).toHaveLength(30)
    expect(memories).toHaveLength(30)
    contexts.forEach((context, index) => {
      const reference = context.messages.find((message) => message.role === "reference")
      expect(reference?.safeText).toMatch(new RegExp(`^REF-${String(index).padStart(2, "0")}-`))
    })
    memories.forEach((item, index) => {
      expect(`${item.title}${item.content}`).toContain(`MEMORY-${String(index).padStart(2, "0")}`)
      expect(item.title.length + item.content.length).toBeGreaterThan(0)
    })
    expect(Math.max(...contextTotals, ...memoryTotals) - Math.min(...contextTotals, ...memoryTotals)).toBeLessThanOrEqual(1)
  })

  it("60k 公平分配对单个临时 URL 标记与普通 context 保持 max-min 公平", async () => {
    const makeContexts = (texts: string[]) => texts.map((safeText, index) => {
      const suffix = String(2_000 + index).padStart(12, "0")
      return {
        observationId: `00000000-0000-4000-8000-${suffix}`,
        threadId: `00000000-0000-4000-9000-${suffix}`,
        messages: [{ role: "reference" as const, safeText }],
      }
    })
    const parseContexts = (codex: CapturingCodex): ReferenceAgentInput["threadContexts"] => {
      const promptPart = codex.invocation?.prompt.split("\n\n")
        .find((part) => part.startsWith("安全线程上下文 "))
      return JSON.parse(promptPart!.slice("安全线程上下文 ".length)) as ReferenceAgentInput["threadContexts"]
    }
    const baselineInput = agentInput()
    baselineInput.activeMemories = []
    baselineInput.threadContexts = makeContexts(Array.from({ length: 30 }, () => "a".repeat(4_000)))
    const baselineCodex = new CapturingCodex({ proposals: [] })
    await new CodexReferenceAgent(baselineCodex as never).classify(baselineInput)
    const visibleLengths = parseContexts(baselineCodex).map((context) => context.messages[0]!.safeText.length)
    expect(Math.min(...visibleLengths)).toBeGreaterThan(5)

    const marker = "[已脱敏][临时URL]"
    const atomicInput = agentInput()
    atomicInput.activeMemories = []
    atomicInput.threadContexts = makeContexts(visibleLengths.map((visibleLength, index) => index === 0
      ? `${"a".repeat(visibleLength - 10)}${marker}`.padEnd(4_000, "z")
      : "a".repeat(4_000)))
    const atomicCodex = new CapturingCodex({ proposals: [] })

    await new CodexReferenceAgent(atomicCodex as never).classify(atomicInput)

    const boundedReferences = parseContexts(atomicCodex).map((context) => context.messages[0]!.safeText)
    expect(boundedReferences[0]).toContain("◈")
    expect(boundedReferences[0]).not.toContain("[已脱敏]")
    expect(Math.max(...boundedReferences.map((text) => text.length))
      - Math.min(...boundedReferences.map((text) => text.length))).toBeLessThanOrEqual(1)
    expect(JSON.stringify(parseContexts(atomicCodex)).length).toBeLessThanOrEqual(60_000)
  })

  it("拒绝模型引用本批次以外的 observation ID", async () => {
    const codex = new CapturingCodex({
      proposals: [{
        ...validProposal,
        evidenceObservationIds: ["00000000-0000-4000-8000-000000000299"],
      }],
    })

    await expect(new CodexReferenceAgent(codex as never).classify(agentInput())).rejects.toThrow(/observation|证据/i)
  })

  it("拒绝 thread context 携带资源或任意附加字段", async () => {
    const codex = new CapturingCodex({ proposals: [validProposal] })
    const cleanInput = agentInput()
    const input = {
      ...cleanInput,
      threadContexts: [{ ...cleanInput.threadContexts[0]!, server: { host: "production.example" } }],
    } as unknown as ReferenceAgentInput

    await expect(new CodexReferenceAgent(codex as never).classify(input)).rejects.toThrow()
    expect(codex.invocation).toBeNull()
  })

  it.each([
    ["没有 reference", [{ role: "question" as const, safeText: "长期问题" }]],
    ["多个 reference", [
      { role: "reference" as const, safeText: "第一条人工参考" },
      { role: "reference" as const, safeText: "第二条人工参考" },
    ]],
  ] as const)("拒绝%s的 thread context", async (_label, messages) => {
    const codex = new CapturingCodex({ proposals: [] })
    const input = agentInput()
    input.threadContexts = [{ ...input.threadContexts[0]!, messages: [...messages] }]

    await expect(new CodexReferenceAgent(codex as never).classify(input)).rejects.toThrow(/reference/i)
    expect(codex.invocation).toBeNull()
  })
})
