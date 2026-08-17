import { createHash } from "node:crypto"

import type { RuntimeDatabase } from "../runtime/database.js"
import type {
  CodeSyncRecoveryInput,
  HourlyCodeSyncFailureInput,
  TechnicalAlertDelivery,
} from "../support/technical-alert-service.js"
import { ProjectCodeSyncUnavailableError, type ProjectCodeSnapshot } from "./project-service.js"

type CodeSyncPort = {
  syncService(serviceId: string, options: { trigger: "hourly" }): Promise<ProjectCodeSnapshot>
  recordAlert?(batchId: string, delivery: {
    status: TechnicalAlertDelivery["status"] | "suppressed"
    summary: string
    errorType: string | null
    fingerprint?: string | null
  }): void
}

type AlertPort = {
  sendHourlyCodeSyncFailure(input: HourlyCodeSyncFailureInput): Promise<TechnicalAlertDelivery>
  sendCodeSyncRecovery(input: CodeSyncRecoveryInput): Promise<TechnicalAlertDelivery>
}

export type HourlyCodeSyncWorkerDependencies = {
  database: RuntimeDatabase
  codeSync: CodeSyncPort
  alerts: AlertPort
}

type DueService = {
  serviceId: string
  service: string
  branch: string
  healthStatus: "healthy" | "failed" | "never"
  lastAlertFingerprint: string | null
}

const scheduledSyncIntervalMs = 30 * 60 * 1000
const maximumConcurrency = 1

function fingerprint(input: HourlyCodeSyncFailureInput["failure"]): string {
  return createHash("sha256").update([
    input.repositoryRole ?? "service",
    input.repositoryName ?? "",
    input.stage,
    input.errorType,
  ].join("|"), "utf8").digest("hex")
}

export class HourlyCodeSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly active = new Set<Promise<void>>()
  private running = false

  constructor(private readonly deps: HourlyCodeSyncWorkerDependencies) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => { void this.runDueOnce() }, 60_000)
    this.timer.unref()
    void this.runDueOnce()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.allSettled([...this.active])
  }

  async runDueOnce(now = new Date()): Promise<number> {
    const available = Math.max(0, maximumConcurrency - this.active.size)
    if (available === 0) return 0
    const claimed = this.claim(now, Math.min(1, available))
    const tasks = claimed.map((service) => {
      const task = this.process(service, now).finally(() => this.active.delete(task))
      this.active.add(task)
      return task
    })
    await Promise.allSettled(tasks)
    return claimed.length
  }

  private claim(now: Date, limit: number): DueService[] {
    const current = now.toISOString()
    const next = new Date(now.getTime() + scheduledSyncIntervalMs).toISOString()
    return this.deps.database.transaction(() => {
      const candidates = this.deps.database.prepare(`SELECT schedule.service_id AS serviceId,
        service.service_key AS service,service.branch,schedule.health_status AS healthStatus,
        schedule.last_alert_fingerprint AS lastAlertFingerprint
        FROM service_code_sync_schedule schedule
        JOIN project_services service ON service.id=schedule.service_id
        JOIN projects project ON project.id=service.project_id
        WHERE schedule.next_hourly_sync_at<=? AND service.enabled=1 AND project.enabled=1
          AND lower(service.service_key)<>'peakpay'
        ORDER BY schedule.next_hourly_sync_at,schedule.service_id LIMIT ?`).all(current, limit) as DueService[]
      const claimed: DueService[] = []
      for (const candidate of candidates) {
        const updated = this.deps.database.prepare(`UPDATE service_code_sync_schedule
          SET next_hourly_sync_at=?,updated_at=? WHERE service_id=? AND next_hourly_sync_at<=?`).run(
          next, current, candidate.serviceId, current,
        )
        if (Number(updated.changes) === 1) claimed.push(candidate)
      }
      return claimed
    })
  }

  private async process(service: DueService, now: Date): Promise<void> {
    try {
      const snapshot = await this.deps.codeSync.syncService(service.serviceId, { trigger: "hourly" })
      if (snapshot.syncState === "fallback" && snapshot.failure) {
        await this.recordFailure(service, now, snapshot.syncBatchId, snapshot.failure, snapshot)
        return
      }
      this.markHealthy(service.serviceId, now)
      if (service.healthStatus === "failed") {
        const delivery = await this.deps.alerts.sendCodeSyncRecovery({
          serviceId: service.serviceId,
          service: service.service,
          branch: snapshot.branch,
          batchId: snapshot.syncBatchId,
          repositories: snapshot.repositories,
        })
        this.deps.codeSync.recordAlert?.(snapshot.syncBatchId, delivery)
      }
    } catch (error) {
      if (error instanceof ProjectCodeSyncUnavailableError) {
        await this.recordFailure(service, now, error.batchId, error.failure, null)
        return
      }
      this.markUnknownFailure(service.serviceId, now)
    }
  }

  private async recordFailure(
    service: DueService,
    now: Date,
    batchId: string,
    syncFailure: HourlyCodeSyncFailureInput["failure"],
    snapshot: ProjectCodeSnapshot | null,
  ): Promise<void> {
    const currentFingerprint = fingerprint(syncFailure)
    this.deps.database.prepare(`UPDATE service_code_sync_schedule SET health_status='failed',last_failure_at=?,
      failure_count=failure_count+1,updated_at=? WHERE service_id=?`).run(
      now.toISOString(), now.toISOString(), service.serviceId,
    )
    if (service.healthStatus === "failed" && service.lastAlertFingerprint === currentFingerprint) {
      this.deps.codeSync.recordAlert?.(batchId, {
        status: "suppressed", summary: "相同同步失败已告警，本次不重复发送", errorType: null, fingerprint: currentFingerprint,
      })
      return
    }
    const delivery = await this.deps.alerts.sendHourlyCodeSyncFailure({
      serviceId: service.serviceId,
      service: service.service,
      branch: service.branch,
      batchId,
      failure: syncFailure,
      snapshot,
    })
    if (delivery.status === "sent" || delivery.status === "uncertain") {
      this.deps.database.prepare(`UPDATE service_code_sync_schedule SET last_alert_fingerprint=?,updated_at=?
        WHERE service_id=?`).run(currentFingerprint, now.toISOString(), service.serviceId)
    }
    this.deps.codeSync.recordAlert?.(batchId, { ...delivery, fingerprint: currentFingerprint })
  }

  private markHealthy(serviceId: string, now: Date): void {
    this.deps.database.prepare(`UPDATE service_code_sync_schedule SET health_status='healthy',last_success_at=?,
      last_failure_at=NULL,failure_count=0,last_alert_fingerprint=NULL,updated_at=? WHERE service_id=?`).run(
      now.toISOString(), now.toISOString(), serviceId,
    )
  }

  private markUnknownFailure(serviceId: string, now: Date): void {
    this.deps.database.prepare(`UPDATE service_code_sync_schedule SET health_status='failed',last_failure_at=?,
      failure_count=failure_count+1,updated_at=? WHERE service_id=?`).run(now.toISOString(), now.toISOString(), serviceId)
  }
}
