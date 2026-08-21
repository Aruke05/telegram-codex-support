import { describe, expect, it, vi } from "vitest"

import type { CodexExecutor } from "../../src/codex/executor.js"
import { CodexShadowReportAgent, shadowReportResultSchema } from "../../src/learning/shadow-report-agent.js"

describe("影子学习报告结构", () => {
  it("要求逐问题评分和可执行前先人工审核的改进建议", () => {
    expect(() => shadowReportResultSchema.parse({
      summary: { headline: "报告", strengths: [], gaps: [], recommendations: [] },
      comparisons: [{
        sampleId: "sample-1",
        accuracyScore: 101,
        reliabilityScore: 80,
        humanLikenessScore: 70,
        sharedConclusions: [],
        factualGaps: [],
        reliabilityFindings: [],
        styleFindings: [],
        recommendations: [],
      }],
    })).toThrow()
  })

  it("报告使用独立十五分钟执行上限而不受五分钟记忆任务限制", async () => {
    const execute = vi.fn(async () => ({
      summary: { headline: "报告", strengths: [], gaps: [], recommendations: [] },
      comparisons: [{
        sampleId: "sample-1",
        accuracyScore: 90,
        reliabilityScore: 85,
        humanLikenessScore: 80,
        sharedConclusions: [],
        factualGaps: [],
        reliabilityFindings: [],
        styleFindings: [],
        recommendations: [],
      }],
    }))
    const agent = new CodexShadowReportAgent({ execute } as unknown as CodexExecutor)

    await agent.generate([{
      sampleId: "sample-1",
      threadId: "thread-1",
      inputRevision: 1,
      question: "问题",
      shadowOutcome: "completed",
      shadowDecision: "reply",
      shadowAnswer: "影子回答",
      shadowReason: "依据",
      humanAnswers: [{ messageEventId: "event-1", text: "真人回答", confidence: 1 }],
    }])

    expect(execute).toHaveBeenCalledWith("memory", expect.objectContaining({ executionTimeoutMs: 15 * 60 * 1000 }))
  })
})
