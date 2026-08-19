import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { z } from "zod"

import type { CodexExecutor } from "../codex/executor.js"

const boundedTexts = z.array(z.string().trim().min(1).max(1000)).max(20)

export const shadowComparisonSchema = z.object({
  sampleId: z.string().min(1).max(120),
  accuracyScore: z.number().int().min(0).max(100),
  reliabilityScore: z.number().int().min(0).max(100),
  humanLikenessScore: z.number().int().min(0).max(100),
  sharedConclusions: boundedTexts,
  factualGaps: boundedTexts,
  reliabilityFindings: boundedTexts,
  styleFindings: boundedTexts,
  recommendations: boundedTexts,
}).strict()

export const shadowReportResultSchema = z.object({
  summary: z.object({
    headline: z.string().trim().min(1).max(1000),
    strengths: boundedTexts,
    gaps: boundedTexts,
    recommendations: boundedTexts,
  }).strict(),
  comparisons: z.array(shadowComparisonSchema).max(1000),
}).strict()

export type ShadowReportResult = z.infer<typeof shadowReportResultSchema>

export type ShadowReportSample = {
  sampleId: string
  threadId: string
  inputRevision: number
  question: string
  shadowOutcome: "completed" | "failed"
  shadowDecision: "reply" | "ignore" | "escalate" | null
  shadowAnswer: string
  shadowReason: string | null
  humanAnswers: Array<{ messageEventId: string; text: string; confidence: number }>
}

export type ShadowReportAgentPort = {
  generate(samples: ShadowReportSample[]): Promise<ShadowReportResult>
}

const shadowReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "comparisons"],
  properties: {
    summary: {
      type: "object", additionalProperties: false,
      required: ["headline", "strengths", "gaps", "recommendations"],
      properties: {
        headline: { type: "string" }, strengths: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "string" } },
        recommendations: { type: "array", items: { type: "string" } },
      },
    },
    comparisons: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["sampleId", "accuracyScore", "reliabilityScore", "humanLikenessScore", "sharedConclusions", "factualGaps", "reliabilityFindings", "styleFindings", "recommendations"],
        properties: {
          sampleId: { type: "string" },
          accuracyScore: { type: "integer", minimum: 0, maximum: 100 },
          reliabilityScore: { type: "integer", minimum: 0, maximum: 100 },
          humanLikenessScore: { type: "integer", minimum: 0, maximum: 100 },
          sharedConclusions: { type: "array", items: { type: "string" } },
          factualGaps: { type: "array", items: { type: "string" } },
          reliabilityFindings: { type: "array", items: { type: "string" } },
          styleFindings: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const

export class CodexShadowReportAgent implements ShadowReportAgentPort {
  constructor(private readonly codex: CodexExecutor) {}

  async generate(samples: ShadowReportSample[]): Promise<ShadowReportResult> {
    if (samples.length === 0) return {
      summary: { headline: "当前没有可比较样本", strengths: [], gaps: [], recommendations: [] },
      comparisons: [],
    }
    const directory = await mkdtemp(path.join(tmpdir(), "shadow-learning-report-"))
    try {
      const prompt = [
        "你是客服影子学习报告分析器，只输出结构化 JSON，不调用工具、不执行操作、不发送消息、不更新记忆。",
        "按每个拆分后的问题单元判断候选真人回复是否真的回答了该问题，再比较影子回答。拆分线程族的候选回复可能只覆盖一个问题，也可能覆盖多个；不相关内容不得当作标准答案。人工回答只是参考证据，不自动视为绝对正确。",
        "分别评价事实准确性、可靠性和真人群聊口吻；没有真人回答时也必须覆盖样本，并明确缺少对照。",
        "建议只写入报告供人工审核，禁止提出自动写入规则、记忆、风格或生产配置。",
        `样本：${JSON.stringify(samples)}`,
      ].join("\n\n")
      const result = await this.codex.execute("memory", {
        cwd: directory,
        prompt,
        outputSchema: shadowReportJsonSchema as unknown as Record<string, unknown>,
        validator: shadowReportResultSchema,
        accessMode: "shadow-report",
        readableRoots: [],
        concurrencyGroup: "shadow-learning-report",
        maxConcurrency: 1,
      })
      const expected = new Set(samples.map((sample) => sample.sampleId))
      const actual = result.comparisons.map((comparison) => comparison.sampleId)
      if (actual.length !== expected.size || new Set(actual).size !== actual.length
        || actual.some((id) => !expected.has(id))) {
        throw new Error("影子学习报告没有完整覆盖本批问题单元")
      }
      return result
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
