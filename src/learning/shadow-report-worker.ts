import type { ShadowLearningReport, ShadowReportStore } from "./shadow-report-store.js"
import type { ShadowReportAgentPort, ShadowReportResult, ShadowReportSample } from "./shadow-report-agent.js"

const reportBatchSize = 50

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, 20)
}

export class ShadowReportWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private active: Promise<boolean> | null = null

  constructor(
    private readonly store: ShadowReportStore,
    private readonly agent: ShadowReportAgentPort,
    private readonly clock: () => Date = () => new Date(),
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
    try {
      const samples = this.store.samples(claim.cutoffAt)
      const result = await this.generate(samples, () => this.store.heartbeat(claim))
      this.store.complete(claim, samples, result, this.clock())
    } catch (error) {
      this.store.fail(claim, error, this.clock())
    }
    return true
  }

  async runNow(now = new Date()): Promise<ShadowLearningReport> {
    const pending = this.store.createManual(now)
    const claim = this.store.claimDue(now, pending.id)
    if (!claim) throw new Error("手动学习报告无法领取")
    try {
      const samples = this.store.samples(claim.cutoffAt)
      const result = await this.generate(samples, () => this.store.heartbeat(claim))
      return this.store.complete(claim, samples, result, this.clock())
    } catch (error) {
      this.store.fail(claim, error, this.clock())
      return this.store.get(claim.id)
    }
  }

  private tick(): Promise<boolean> {
    if (this.active) return this.active
    this.active = this.runDue().finally(() => { this.active = null })
    return this.active
  }

  private async generate(samples: ShadowReportSample[], heartbeat: () => boolean): Promise<ShadowReportResult> {
    if (samples.length === 0) return this.agent.generate([])
    const results: ShadowReportResult[] = []
    for (let index = 0; index < samples.length; index += reportBatchSize) {
      results.push(await this.agent.generate(samples.slice(index, index + reportBatchSize)))
      if (!heartbeat()) throw new Error("学习报告 claim 已失效")
    }
    return {
      summary: {
        headline: `共比较 ${samples.length} 个拆分问题，以下结论仅供人工审核`,
        strengths: unique(results.flatMap((result) => result.summary.strengths)),
        gaps: unique(results.flatMap((result) => result.summary.gaps)),
        recommendations: unique(results.flatMap((result) => result.summary.recommendations)),
      },
      comparisons: results.flatMap((result) => result.comparisons),
    }
  }
}
