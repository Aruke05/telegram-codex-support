import { z } from "zod"

import type { CodexExecutor } from "../codex/executor.js"
import type { ProjectCodeSyncService } from "../git-sync/project-service.js"
import type { ReferenceLearningWorker } from "../learning/reference-worker.js"
import type { MemoryLearningWorker } from "../learning/worker.js"
import type { TelegramRuntime } from "../telegram/runtime.js"
import type { RuntimeDatabase } from "./database.js"

const syncInputSchema = z.object({ serviceId: z.string().uuid() }).strict()

export class RuntimeControlService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly codex: CodexExecutor,
    private readonly telegram: TelegramRuntime,
    private readonly codeSync: ProjectCodeSyncService,
    private readonly learning: MemoryLearningWorker,
    private readonly referenceLearning: ReferenceLearningWorker,
  ) {}

  async status() {
    const queue = this.database.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
      FROM memory_learning_queue`).get() as {
      pending: number | null
      processing: number | null
      failed: number | null
      completed: number | null
    }
    const lastSync = this.database.prepare(`SELECT batch.status,batch.trigger_source AS triggerSource,batch.branch,
      batch.safe_summary AS safeSummary,batch.error_type AS errorType,batch.snapshot_id AS snapshotId,
      batch.fallback_snapshot_id AS fallbackSnapshotId,batch.started_at AS startedAt,batch.finished_at AS finishedAt,
      backend.commit_hash AS backendCommit,frontend.commit_hash AS frontendCommit
      FROM service_code_sync_batches batch
      LEFT JOIN service_code_snapshot_items backend
        ON backend.snapshot_id=COALESCE(batch.snapshot_id,batch.fallback_snapshot_id) AND backend.role='backend'
      LEFT JOIN service_code_snapshot_items frontend
        ON frontend.snapshot_id=COALESCE(batch.snapshot_id,batch.fallback_snapshot_id) AND frontend.role='frontend'
      ORDER BY batch.started_at DESC LIMIT 1`).get() ?? null
    const lastLearning = this.database.prepare(`SELECT status,scanned_events AS scannedEvents,created_versions AS createdVersions,
      conflict_count AS conflictCount,summary,started_at AS startedAt,finished_at AS finishedAt
      FROM memory_maintenance_runs ORDER BY started_at DESC LIMIT 1`).get() ?? null
    const reference = this.referenceLearning.status()
    const activeStylePin = this.database.readActiveOperatorStyle()
    const activeStyle = activeStylePin.versionId
      ? this.database.readOperatorStyleVersions("WHERE id=?", [activeStylePin.versionId])[0] ?? null
      : null
    return {
      codex: await this.codex.status(),
      telegram: this.telegram.status(),
      codeSync: { lastRun: lastSync },
      learning: {
        pending: reference.pending + reference.processing + reference.failed
          + Number(queue.pending ?? 0) + Number(queue.processing ?? 0) + Number(queue.failed ?? 0),
        completed: reference.completed,
        lastRun: lastLearning,
        activeStyle,
        reference: { ...reference, lastRun: lastLearning },
        legacy: {
          pending: Number(queue.pending ?? 0),
          processing: Number(queue.processing ?? 0),
          failed: Number(queue.failed ?? 0),
          completed: Number(queue.completed ?? 0),
        },
      },
    }
  }

  checkCodex() { return this.codex.status() }

  async sync(input: unknown) {
    const snapshot = await this.codeSync.syncService(syncInputSchema.parse(input).serviceId, { trigger: "manual" })
    return {
      service: snapshot.service,
      branch: snapshot.branch,
      syncState: snapshot.syncState,
      syncBatchId: snapshot.syncBatchId,
      snapshotId: snapshot.snapshotId,
      publishedAt: snapshot.publishedAt,
      repositories: snapshot.repositories.map((repository) => ({
        role: repository.role,
        name: repository.name,
        commit: repository.commit,
      })),
    }
  }

  async runLearning() {
    await this.learning.runOnce()
    return this.referenceLearning.runOnce()
  }
}
