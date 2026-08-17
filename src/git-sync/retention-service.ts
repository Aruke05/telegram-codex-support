import { lstat, readdir, rm } from "node:fs/promises"
import path from "node:path"

import type { RuntimeDatabase } from "../runtime/database.js"
import { assertNoSymlinkDirectoryPath, assertSafeCodeIdentifier, pathInside } from "./path-safety.js"

type SnapshotCandidate = { id: string; serviceId: string }
type DirectoryEntry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }

const dayMs = 24 * 60 * 60 * 1000

export type CodeSnapshotRetentionResult = {
  deletedSnapshots: number
  deletedStagingDirectories: number
  deletedOrphanSnapshotDirectories: number
  failedPaths: number
}

export class CodeSnapshotRetentionService {
  private readonly serviceCodeRoot: string

  constructor(private readonly database: RuntimeDatabase, dataDir: string) {
    this.serviceCodeRoot = path.join(path.resolve(dataDir), "service-code")
  }

  async run(now = new Date(), batchSize = 50): Promise<CodeSnapshotRetentionResult> {
    const bounded = Math.min(Math.max(batchSize, 1), 200)
    const snapshotCutoff = new Date(now.getTime() - 7 * dayMs).toISOString()
    const candidates = this.database.prepare(`SELECT snapshot.id,snapshot.service_id AS serviceId
      FROM service_code_snapshots snapshot
      WHERE snapshot.status='published' AND snapshot.published_at<?
        AND (SELECT COUNT(*) FROM service_code_snapshots newer
          WHERE newer.service_id=snapshot.service_id AND newer.status='published'
            AND (newer.published_at>snapshot.published_at
              OR (newer.published_at=snapshot.published_at AND newer.id>snapshot.id)))>=3
        AND NOT EXISTS (SELECT 1 FROM support_replies reply WHERE reply.code_snapshot_id=snapshot.id)
      ORDER BY snapshot.published_at,snapshot.id LIMIT ?`).all(snapshotCutoff, bounded) as SnapshotCandidate[]
    let deletedSnapshots = 0
    let deletedStagingDirectories = 0
    let deletedOrphanSnapshotDirectories = 0
    let failedPaths = 0
    for (const candidate of candidates) {
      const snapshotPath = path.join(this.serviceCodeRoot, candidate.serviceId, "snapshots", candidate.id)
      try {
        assertSafeCodeIdentifier(candidate.serviceId)
        assertSafeCodeIdentifier(candidate.id)
        await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, snapshotPath)
      } catch {
        failedPaths += 1
        continue
      }
      this.database.prepare("UPDATE service_code_snapshots SET status='deleting' WHERE id=? AND status='published'").run(candidate.id)
      try {
        await rm(snapshotPath, { recursive: true, force: true })
        this.database.prepare("DELETE FROM service_code_snapshots WHERE id=? AND status='deleting'").run(candidate.id)
        deletedSnapshots += 1
      } catch {
        this.database.prepare("UPDATE service_code_snapshots SET status='published' WHERE id=? AND status='deleting'").run(candidate.id)
        failedPaths += 1
      }
    }

    const staging = await this.cleanupStaging(now)
    deletedStagingDirectories += staging.deleted
    failedPaths += staging.failed
    const orphanSnapshots = await this.cleanupOrphanSnapshots(now)
    deletedOrphanSnapshotDirectories += orphanSnapshots.deleted
    failedPaths += orphanSnapshots.failed
    return { deletedSnapshots, deletedStagingDirectories, deletedOrphanSnapshotDirectories, failedPaths }
  }

  private async cleanupStaging(now: Date): Promise<{ deleted: number; failed: number }> {
    let services: DirectoryEntry[]
    try {
      services = await readdir(this.serviceCodeRoot, { withFileTypes: true }) as DirectoryEntry[]
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { deleted: 0, failed: 0 } : { deleted: 0, failed: 1 }
    }
    const cutoff = now.getTime() - dayMs
    let deleted = 0
    let failed = 0
    for (const service of services) {
      if (!service.isDirectory() || service.isSymbolicLink()) continue
      try { assertSafeCodeIdentifier(service.name) } catch { failed += 1; continue }
      const stagingRoot = path.join(this.serviceCodeRoot, service.name, "staging")
      try { await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, stagingRoot) } catch { failed += 1; continue }
      let batches: DirectoryEntry[]
      try {
        batches = await readdir(stagingRoot, { withFileTypes: true }) as DirectoryEntry[]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed += 1
        continue
      }
      for (const batch of batches) {
        const candidate = path.join(stagingRoot, batch.name)
        if (!pathInside(candidate, this.serviceCodeRoot) || batch.isSymbolicLink() || !batch.isDirectory()) continue
        try {
          assertSafeCodeIdentifier(batch.name)
          await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, candidate)
          const stat = await lstat(candidate)
          if (stat.mtimeMs >= cutoff) continue
          const running = this.database.prepare("SELECT 1 FROM service_code_sync_batches WHERE id=? AND status='running'").get(batch.name)
          if (running) continue
          await rm(candidate, { recursive: true, force: true })
          deleted += 1
        } catch {
          failed += 1
        }
      }
    }
    return { deleted, failed }
  }

  private async cleanupOrphanSnapshots(now: Date): Promise<{ deleted: number; failed: number }> {
    let services: DirectoryEntry[]
    try {
      services = await readdir(this.serviceCodeRoot, { withFileTypes: true }) as DirectoryEntry[]
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { deleted: 0, failed: 0 } : { deleted: 0, failed: 1 }
    }
    const cutoff = now.getTime() - dayMs
    let deleted = 0
    let failed = 0
    for (const service of services) {
      if (!service.isDirectory() || service.isSymbolicLink()) continue
      try { assertSafeCodeIdentifier(service.name) } catch { failed += 1; continue }
      const snapshotsRoot = path.join(this.serviceCodeRoot, service.name, "snapshots")
      try { await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, snapshotsRoot) } catch { failed += 1; continue }
      let snapshots: DirectoryEntry[]
      try {
        snapshots = await readdir(snapshotsRoot, { withFileTypes: true }) as DirectoryEntry[]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed += 1
        continue
      }
      for (const snapshot of snapshots) {
        if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) continue
        const candidate = path.join(snapshotsRoot, snapshot.name)
        try {
          assertSafeCodeIdentifier(snapshot.name)
          await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, candidate)
          if (this.database.prepare("SELECT 1 FROM service_code_snapshots WHERE id=?").get(snapshot.name)) continue
          if ((await lstat(candidate)).mtimeMs >= cutoff) continue
          await rm(candidate, { recursive: true, force: true })
          deleted += 1
        } catch {
          failed += 1
        }
      }
    }
    return { deleted, failed }
  }
}
