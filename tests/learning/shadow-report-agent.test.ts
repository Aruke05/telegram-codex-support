import { describe, expect, it } from "vitest"

import { shadowReportResultSchema } from "../../src/learning/shadow-report-agent.js"

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
})
