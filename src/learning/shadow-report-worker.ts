import type { ClaimedShadowReport, ShadowLearningReport, ShadowReportStore } from "./shadow-report-store.js"
import type { ShadowReportAgentPort, ShadowReportSample } from "./shadow-report-agent.js"

export type ShadowReportBatchLimits = { maxSamples: number; maxBytes: number }
const defaultBatchLimits: ShadowReportBatchLimits = { maxSamples: 8, maxBytes: 24_000 }

export function partitionShadowReportSamples(
  samples: ShadowReportSample[],
  limits: ShadowReportBatchLimits = defaultBatchLimits,
): ShadowReportSample[][] {
  if (!Number.isInteger(limits.maxSamples) || limits.maxSamples < 1 || !Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error("学习报告批次限制无效")
  }
  const batches: ShadowReportSample[][] = []
  let current: ShadowReportSample[] = []
  for (const sample of samples) {
    const candidate = [...current, sample]
    if (current.length > 0 && (candidate.length > limits.maxSamples
      || Buffer.byteLength(JSON.stringify(candidate), "utf8") > limits.maxBytes)) {
      batches.push(current)
      current = [sample]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export class ShadowReportWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private active: Promise<boolean> | null = null

  constructor(
    private readonly store: ShadowReportStore,
    private readonly agent: ShadowReportAgentPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly batchLimits: ShadowReportBatchLimits = defaultBatchLimits,
  ) {}

  start(): void {
    if (this.timer) return
    this.store.recoverStale()
    this.timer = setInterval(() => { void this.tick() }, 30_000)
    this.timer.unref()
    void this.tick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.active?.catch(() => undefined)
  }

  async runDue(now = new Date()): Promise<boolean> {
    this.store.recoverStale(now)
    const claim = this.store.claimDue(now)
    if (!claim) return false
    await this.process(claim)
    return true
  }

  async runNow(now = new Date()): Promise<ShadowLearningReport> {
    const pending = this.store.createManual(now)
    const claim = this.store.claimDue(now, pending.id)
    if (!claim) throw new Error("手动学习报告无法领取")
    return this.process(claim)
  }

  async retry(id: string, now = new Date()): Promise<ShadowLearningReport> {
    const claim = this.store.retryFailed(id, now)
    if (!claim) throw new Error("只有失败的学习报告可以继续生成")
    return this.process(claim)
  }

  private tick(): Promise<boolean> {
    if (this.active) return this.active
    this.active = this.runDue().finally(() => { this.active = null })
    return this.active
  }

  private async process(claim: ClaimedShadowReport): Promise<ShadowLearningReport> {
    try {
      const collected = this.store.samples(claim.cutoffAt)
      const samples = collected.filter((sample) => sample.humanAnswers.length > 0)
      if (samples.length === 0) {
        return this.store.complete(claim, [], {
          summary: {
            headline: `采集到 ${collected.length} 个影子问题，但没有关联到可信真人回复`,
            strengths: [],
            gaps: ["当前没有可用于准确性、可靠性和拟人性对比的真人答案"],
            recommendations: ["请先在 群与账号 > 用户与角色 中启用实际客服的学习来源"],
          },
          comparisons: [],
        }, this.clock())
      }
      const completed = this.store.comparedSampleIds(claim.id)
      const remaining = samples.filter((sample) => !completed.has(sample.sampleId))
      for (const batch of partitionShadowReportSamples(remaining, this.batchLimits)) {
        const result = await this.agent.generate(batch)
        this.store.appendBatch(claim, batch, result, this.clock())
      }
      return this.store.finalize(
        claim,
        samples,
        `共比较 ${samples.length} 个有可信真人回复的拆分问题，以下结论仅供人工审核`,
        this.clock(),
      )
    } catch (error) {
      this.store.fail(claim, error, this.clock())
      return this.store.get(claim.id)
    }
  }
}
