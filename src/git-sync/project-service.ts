import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"

import type { RuntimeDatabase } from "../runtime/database.js"
import type { CodeRepositoryRole, ProjectRepositoryRecord, ProjectServiceRecord } from "../runtime/types.js"
import { NodeCommandRunner } from "./command-runner.js"
import {
  classifyCommandFailure,
  CodeSyncOperationError,
  failure,
  ProjectCodeSyncUnavailableError,
  type CodeSyncFailure,
  type CodeSyncStage,
} from "./project-errors.js"
import type { CommandRunner } from "./types.js"
import {
  assertNoSymlinkDirectoryPath,
  assertSafeCodeIdentifier,
  isExistingSafeDirectoryPath,
  assertTreeHasNoSymlinks,
  isExistingTreeWithoutSymlinks,
} from "./path-safety.js"

const safeBranchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const commitPattern = /^[a-f0-9]{40}$/
const scheduledSyncIntervalMs = 30 * 60 * 1000

export type CodeSyncTrigger = "answer" | "hourly" | "manual" | "learning"

export type ProjectRepositorySnapshot = {
  role: CodeRepositoryRole
  repositoryId: string
  name: string
  branch: string
  commit: string
  snapshotPath: string
}

export type ProjectCodeSnapshot = {
  projectId: string
  serviceId: string
  service: string
  branch: string
  commit: string
  snapshotId: string
  syncBatchId: string
  configurationFingerprint: string
  syncState: "fresh" | "fallback"
  failure: CodeSyncFailure | null
  publishedAt: string
  workspacePath: string
  repositories: ProjectRepositorySnapshot[]
}

type SyncOptions = {
  trigger?: CodeSyncTrigger
  attemptRemote?: boolean
}

type BoundRepository = {
  role: CodeRepositoryRole
  repository: ProjectRepositoryRecord
}

type SyncedRepository = BoundRepository & {
  commit: string
  sourcePath: string
}

type SnapshotRow = {
  id: string
  project_id: string
  service_id: string
  branch: string
  repository_pair_fingerprint: string
  commit_pair_fingerprint: string
  published_at: string
}

type SnapshotItemRow = {
  role: CodeRepositoryRole
  repository_id: string
  repository_name: string
  commit_hash: string
  relative_path: string
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeBranch(branch: string): string {
  if (!safeBranchPattern.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new CodeSyncOperationError(failure({
      repositoryRole: null,
      repositoryName: null,
      stage: "validate_config",
      errorType: "configuration_invalid",
      exitCode: null,
      safeSummary: "服务代码分支格式错误",
    }))
  }
  return branch
}

function fingerprint(values: string[]): string {
  return createHash("sha256").update(values.join("|"), "utf8").digest("hex")
}

function safeRemote(value: string): string {
  return value.trim().replace(/\/+$/u, "")
}

function codeRevision(items: Array<Pick<ProjectRepositorySnapshot, "name" | "commit">>): string {
  return items.map((item) => `${item.name}@${item.commit.slice(0, 8)}`).join(", ")
}

function duration(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
}

export class ProjectCodeSyncService {
  private readonly dataDir: string
  private readonly serviceCodeRoot: string
  private readonly runner: CommandRunner
  private readonly inFlight = new Map<string, Promise<ProjectCodeSnapshot>>()
  private remoteSyncTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: RuntimeDatabase,
    dataDir: string,
    runner: CommandRunner = new NodeCommandRunner(),
  ) {
    this.dataDir = path.resolve(dataDir)
    this.serviceCodeRoot = path.join(this.dataDir, "service-code")
    this.runner = runner
  }

  async syncService(serviceId: string, options: SyncOptions = {}): Promise<ProjectCodeSnapshot> {
    const current = this.inFlight.get(serviceId)
    if (current) return current
    const pending = this.serializeRemoteSync(() => this.syncLatest(serviceId, {
      trigger: options.trigger ?? "manual",
      attemptRemote: options.attemptRemote ?? true,
    })).finally(() => this.inFlight.delete(serviceId))
    this.inFlight.set(serviceId, pending)
    return pending
  }

  readCurrentSnapshot(serviceId: string): ProjectCodeSnapshot {
    assertSafeCodeIdentifier(serviceId)
    const service = this.database.readProjectServices("WHERE id=? AND enabled=1", [serviceId])[0]
    if (!service) throw new Error("项目服务不存在")
    if (service.key.toLocaleLowerCase("en-US") === "peakpay") throw new Error("Peakpay 不允许配置")
    const branch = safeBranch(service.branch)
    const bindings = this.boundRepositories(service)
    const bindingFailure = this.validateBindings(bindings)
    if (bindingFailure) throw new Error(bindingFailure.safeSummary)
    const pairFingerprint = fingerprint(bindings.map((item) => `${item.role}:${item.repository.id}:${item.repository.name}`))
    const configurationFingerprint = this.configurationFingerprint(service, bindings)
    const schedule = this.database.prepare(`SELECT last_success_at FROM service_code_sync_schedule
      WHERE service_id=?`).get(service.id) as { last_success_at: string | null } | undefined
    if (!schedule?.last_success_at) throw new Error("当前服务还没有可用的完整代码快照")
    const rows = this.database.prepare(`SELECT * FROM service_code_snapshots
      WHERE service_id=? AND branch=? AND repository_pair_fingerprint=? AND status='published' AND published_at<=?
      ORDER BY published_at DESC,id DESC LIMIT 100`).all(
      service.id, branch, pairFingerprint, schedule.last_success_at,
    ) as SnapshotRow[]
    for (const row of rows) {
      const batch = this.database.prepare(`SELECT id FROM service_code_sync_batches
        WHERE service_id=? AND snapshot_id=? AND status='published'
        ORDER BY finished_at DESC,id DESC LIMIT 1`).get(service.id, row.id) as { id: string } | undefined
      if (!batch) continue
      const snapshot = this.snapshotFromRow(service, row, configurationFingerprint, batch.id, "fresh", null)
      if (snapshot) return snapshot
    }
    throw new Error("当前服务还没有可用的完整代码快照")
  }

  recordAlert(batchId: string, delivery: {
    status: "sent" | "not_configured" | "failed" | "uncertain" | "suppressed"
    errorType?: string | null
    summary: string
    fingerprint?: string | null
  }): void {
    this.database.prepare(`UPDATE service_code_sync_batches SET alert_status=?,alert_error_type=?,alert_summary=?,
      alert_fingerprint=?,alerted_at=? WHERE id=?`).run(
      delivery.status,
      delivery.errorType ?? null,
      delivery.summary.slice(0, 500),
      delivery.fingerprint ?? null,
      new Date().toISOString(),
      batchId,
    )
  }

  currentServiceForSnapshot(snapshot: ProjectCodeSnapshot): ProjectServiceRecord | null {
    const current = this.database.readProjectServices("WHERE id=? AND enabled=1", [snapshot.serviceId])[0]
    if (!current || this.configurationFingerprint(current) !== snapshot.configurationFingerprint) return null
    return current
  }

  private async syncLatest(
    serviceId: string,
    options: Required<SyncOptions>,
    configurationRestarts = 0,
  ): Promise<ProjectCodeSnapshot> {
    await mkdir(this.serviceCodeRoot, { recursive: true })
    await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, this.serviceCodeRoot)
    assertSafeCodeIdentifier(serviceId)
    const service = this.database.readProjectServices("WHERE id=? AND enabled=1", [serviceId])[0]
    if (!service) throw new Error("项目服务不存在")
    if (service.key.toLocaleLowerCase("en-US") === "peakpay") throw new Error("Peakpay 不允许配置")

    let branch = service.branch
    let configurationFailure: CodeSyncFailure | null = null
    try {
      branch = safeBranch(service.branch)
    } catch (error) {
      configurationFailure = this.operationFailure(error, null, null, "validate_config")
    }
    const bindings = this.boundRepositories(service)
    const configurationFingerprint = this.configurationFingerprint(service, bindings)
    if (!configurationFailure) configurationFailure = this.validateBindings(bindings)
    const pairFingerprint = bindings.length === 2
      ? fingerprint(bindings.map((item) => `${item.role}:${item.repository.id}:${item.repository.name}`))
      : fingerprint([service.id, branch, "incomplete"])
    const batchId = randomUUID()
    const startedAt = new Date().toISOString()
    this.database.prepare(`INSERT INTO service_code_sync_batches(
      id,project_id,service_id,trigger_source,branch,repository_pair_fingerprint,status,snapshot_id,fallback_snapshot_id,
      error_repository_role,error_repository_name,error_stage,error_type,exit_code,safe_summary,alert_status,alert_error_type,
      alert_summary,alert_fingerprint,alerted_at,started_at,finished_at,duration_ms
    ) VALUES (?,?,?,?,?,?,'running',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL)`).run(
      batchId, service.projectId, service.id, options.trigger, branch, pairFingerprint, startedAt,
    )

    if (configurationFailure) {
      if (this.configurationChanged(service, configurationFingerprint)) {
        return this.restartAfterConfigurationChange(service.id, options, batchId, startedAt, configurationRestarts)
      }
      return this.fallbackOrThrow(
        service, branch, pairFingerprint, configurationFingerprint, batchId, startedAt, configurationFailure,
      )
    }
    if (!options.attemptRemote) {
      if (this.configurationChanged(service, configurationFingerprint)) {
        return this.restartAfterConfigurationChange(service.id, options, batchId, startedAt, configurationRestarts)
      }
      return this.fallbackOrThrow(service, branch, pairFingerprint, configurationFingerprint, batchId, startedAt, failure({
        repositoryRole: null,
        repositoryName: null,
        stage: "validate_config",
        errorType: "configuration_invalid",
        exitCode: null,
        safeSummary: "远端代码同步已关闭",
      }))
    }

    const repositories: SyncedRepository[] = []
    for (const binding of bindings) {
      try {
        repositories.push(await this.syncRepository(service, binding, branch, batchId))
      } catch (error) {
        const syncFailure = this.operationFailure(
          error,
          binding.role,
          binding.repository.name,
          "fetch",
        )
        if (this.configurationChanged(service, configurationFingerprint)) {
          return this.restartAfterConfigurationChange(service.id, options, batchId, startedAt, configurationRestarts)
        }
        return this.fallbackOrThrow(
          service, branch, pairFingerprint, configurationFingerprint, batchId, startedAt, syncFailure,
        )
      }
    }
    if (this.configurationChanged(service, configurationFingerprint)) {
      return this.restartAfterConfigurationChange(service.id, options, batchId, startedAt, configurationRestarts)
    }
    try {
      const snapshot = await this.publish(
        service, branch, pairFingerprint, configurationFingerprint, batchId, startedAt, repositories,
      )
      this.markScheduleSuccess(service.id, new Date().toISOString())
      return snapshot
    } catch (error) {
      const syncFailure = this.operationFailure(error, null, null, "publish_snapshot")
      if (this.configurationChanged(service, configurationFingerprint)) {
        return this.restartAfterConfigurationChange(service.id, options, batchId, startedAt, configurationRestarts)
      }
      return this.fallbackOrThrow(
        service, branch, pairFingerprint, configurationFingerprint, batchId, startedAt, syncFailure,
      )
    }
  }

  private boundRepositories(service: ProjectServiceRecord): BoundRepository[] {
    const bindings = this.database.readProjectServiceRepositories("WHERE service_id=? ORDER BY CASE role WHEN 'backend' THEN 0 ELSE 1 END", [service.id])
    const repositories = this.database.readProjectRepositories("WHERE project_id=?", [service.projectId])
    return bindings.flatMap((binding) => {
      const repository = repositories.find((item) => item.id === binding.repositoryId)
      return repository ? [{ role: binding.role, repository }] : []
    })
  }

  private configurationFingerprint(service: ProjectServiceRecord, bindings = this.boundRepositories(service)): string {
    return fingerprint([
      service.updatedAt,
      service.branch,
      String(service.enabled),
      ...bindings.map((binding) => [
        binding.role,
        binding.repository.id,
        binding.repository.name,
        binding.repository.remoteUrl,
        String(binding.repository.enabled),
        binding.repository.updatedAt,
      ].join(":")),
    ])
  }

  private configurationChanged(service: ProjectServiceRecord, expected: string): boolean {
    const current = this.database.readProjectServices("WHERE id=? AND enabled=1", [service.id])[0]
    return !current || this.configurationFingerprint(current) !== expected
  }

  private restartAfterConfigurationChange(
    serviceId: string,
    options: Required<SyncOptions>,
    batchId: string,
    startedAt: string,
    restarts: number,
  ): Promise<ProjectCodeSnapshot> {
    const finishedAt = new Date().toISOString()
    this.database.prepare(`UPDATE service_code_sync_batches SET status=?,error_stage='validate_config',
      error_type='process_interrupted',safe_summary='同步期间服务代码配置发生变化，旧批次已作废',finished_at=?,duration_ms=?
      WHERE id=? AND status='running'`).run(
      restarts >= 2 ? "failed" : "interrupted", finishedAt, duration(startedAt, finishedAt), batchId,
    )
    if (restarts >= 2) throw new ProjectCodeSyncUnavailableError(batchId, failure({
      repositoryRole: null,
      repositoryName: null,
      stage: "validate_config",
      errorType: "process_interrupted",
      exitCode: null,
      safeSummary: "服务代码配置连续变化，暂未形成稳定快照",
    }))
    return this.syncLatest(serviceId, options, restarts + 1)
  }

  private validateBindings(bindings: BoundRepository[]): CodeSyncFailure | null {
    const backend = bindings.find((item) => item.role === "backend")
    const frontend = bindings.find((item) => item.role === "frontend")
    if (!backend || !frontend) return failure({
      repositoryRole: null, repositoryName: null, stage: "validate_config", errorType: "configuration_invalid",
      exitCode: null, safeSummary: "服务必须同时绑定后端 java-project 和前端 sfzf-web",
    })
    if (backend.repository.name !== "java-project" || frontend.repository.name !== "sfzf-web") return failure({
      repositoryRole: null, repositoryName: null, stage: "validate_config", errorType: "configuration_invalid",
      exitCode: null, safeSummary: "服务前后端仓库角色配置错误",
    })
    const disabled = bindings.find((item) => !item.repository.enabled || !item.repository.remoteUrl.trim())
    if (disabled) return failure({
      repositoryRole: disabled.role, repositoryName: disabled.repository.name, stage: "validate_config",
      errorType: "configuration_invalid", exitCode: null,
      safeSummary: `${disabled.role === "backend" ? "后端" : "前端"} ${disabled.repository.name} 未启用或未配置远端`,
    })
    return null
  }

  private async syncRepository(
    service: ProjectServiceRecord,
    binding: BoundRepository,
    branch: string,
    batchId: string,
  ): Promise<SyncedRepository> {
    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    this.database.prepare(`INSERT INTO code_sync_runs(
      id,batch_id,project_id,service_id,repository_id,repository_role,branch,commit_hash,status,duration_ms,error_code,
      stage,error_type,safe_summary,started_at,finished_at
    ) VALUES (?,?,?,?,?,?,?,NULL,'running',NULL,NULL,NULL,NULL,NULL,?,NULL)`).run(
      runId, batchId, service.projectId, service.id, binding.repository.id, binding.role, branch, startedAt,
    )
    try {
      const sourcePath = await this.prepareRepository(service.id, binding)
      await this.runCommand("git", [
        "-C", sourcePath, "fetch", "--prune", "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ], this.dataDir, binding, "fetch")
      const commit = (await this.runCommand("git", [
        "-C", sourcePath, "rev-parse", `refs/remotes/origin/${branch}^{commit}`,
      ], this.dataDir, binding, "resolve_commit")).toLowerCase()
      if (!commitPattern.test(commit)) throw new CodeSyncOperationError(failure({
        repositoryRole: binding.role,
        repositoryName: binding.repository.name,
        stage: "resolve_commit",
        errorType: "invalid_commit",
        exitCode: null,
      }))
      const finishedAt = new Date().toISOString()
      this.database.prepare(`UPDATE code_sync_runs SET commit_hash=?,status='completed',duration_ms=?,stage='resolve_commit',
        error_code=NULL,error_type=NULL,safe_summary=NULL,finished_at=? WHERE id=?`).run(
        commit, duration(startedAt, finishedAt), finishedAt, runId,
      )
      return { ...binding, commit, sourcePath }
    } catch (error) {
      const syncFailure = this.operationFailure(error, binding.role, binding.repository.name, "fetch")
      const finishedAt = new Date().toISOString()
      this.database.prepare(`UPDATE code_sync_runs SET status='failed',duration_ms=?,error_code='git_sync_failed',stage=?,
        error_type=?,safe_summary=?,finished_at=? WHERE id=?`).run(
        duration(startedAt, finishedAt), syncFailure.stage, syncFailure.errorType,
        syncFailure.safeSummary, finishedAt, runId,
      )
      throw new CodeSyncOperationError(syncFailure)
    }
  }

  private async prepareRepository(serviceId: string, binding: BoundRepository): Promise<string> {
    const serviceRoot = path.join(this.serviceCodeRoot, serviceId)
    const repositoriesRoot = path.join(serviceRoot, "repositories")
    const repositoryPath = path.join(repositoriesRoot, binding.repository.name)
    if (!inside(repositoryPath, this.serviceCodeRoot)) throw new CodeSyncOperationError(failure({
      repositoryRole: binding.role, repositoryName: binding.repository.name, stage: "prepare_repository",
      errorType: "configuration_invalid", exitCode: null, safeSummary: "服务代码目录无效",
    }))
    await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, repositoryPath)
    await mkdir(repositoriesRoot, { recursive: true })
    await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, repositoriesRoot)
    if (!existsSync(repositoryPath)) {
      try {
        await this.runCommand("git", [
          "clone", "--no-checkout", "--filter=blob:none", "--origin", "origin", binding.repository.remoteUrl, repositoryPath,
        ], repositoriesRoot, binding, "prepare_repository")
      } catch (error) {
        if (!existsSync(path.join(repositoryPath, ".git"))) await rm(repositoryPath, { recursive: true, force: true })
        throw error
      }
    }
    if (!existsSync(path.join(repositoryPath, ".git"))) throw new CodeSyncOperationError(failure({
      repositoryRole: binding.role, repositoryName: binding.repository.name, stage: "prepare_repository",
      errorType: "not_git_repository", exitCode: null,
    }))
    await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, repositoryPath)
    const currentRemote = await this.runCommand(
      "git", ["-C", repositoryPath, "remote", "get-url", "origin"], this.dataDir, binding, "resolve_remote",
    )
    if (safeRemote(currentRemote) !== safeRemote(binding.repository.remoteUrl)) throw new CodeSyncOperationError(failure({
      repositoryRole: binding.role, repositoryName: binding.repository.name, stage: "resolve_remote",
      errorType: "remote_mismatch", exitCode: null,
    }))
    return repositoryPath
  }

  private async publish(
    service: ProjectServiceRecord,
    branch: string,
    pairFingerprint: string,
    configurationFingerprint: string,
    batchId: string,
    startedAt: string,
    repositories: SyncedRepository[],
  ): Promise<ProjectCodeSnapshot> {
    const commitPairFingerprint = fingerprint(repositories.map((item) => `${item.role}:${item.commit}`))
    const existing = this.database.prepare(`SELECT * FROM service_code_snapshots
      WHERE service_id=? AND branch=? AND repository_pair_fingerprint=? AND commit_pair_fingerprint=? AND status='published'
      LIMIT 1`).get(service.id, branch, pairFingerprint, commitPairFingerprint) as SnapshotRow | undefined
    if (existing) {
      const snapshot = this.snapshotFromRow(
        service, existing, configurationFingerprint, batchId, "fresh", null,
      )
      if (snapshot) {
        const finishedAt = new Date().toISOString()
        this.database.prepare(`UPDATE service_code_sync_batches SET status='published',snapshot_id=?,finished_at=?,duration_ms=? WHERE id=?`).run(
          existing.id, finishedAt, duration(startedAt, finishedAt), batchId,
        )
        return snapshot
      }
      this.database.prepare(`UPDATE service_code_snapshots
        SET commit_pair_fingerprint=commit_pair_fingerprint || ':metadata-only:' || id WHERE id=?`).run(existing.id)
    }

    const serviceRoot = path.join(this.serviceCodeRoot, service.id)
    const stagingRoot = path.join(serviceRoot, "staging")
    const stagingPath = path.join(stagingRoot, batchId)
    if (!inside(stagingPath, this.serviceCodeRoot)) throw new CodeSyncOperationError(failure({
      repositoryRole: null, repositoryName: null, stage: "export_snapshot", errorType: "configuration_invalid",
      exitCode: null, safeSummary: "快照暂存目录无效",
    }))
    await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, stagingPath)
    await mkdir(stagingPath, { recursive: true })
    await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, stagingPath)
    let renamedSnapshotPath: string | null = null
    try {
      for (const repository of repositories) {
        const destination = path.join(stagingPath, repository.repository.name)
        const archivePath = path.join(stagingPath, `${repository.role}.tar`)
        await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, destination)
        await mkdir(destination, { recursive: true })
        await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, destination)
        await this.runCommand("git", [
          "-C", repository.sourcePath, "archive", "--format=tar", `--output=${archivePath}`, repository.commit,
        ], this.dataDir, repository, "export_snapshot")
        try {
          await this.runCommand("tar", ["-xf", archivePath, "-C", destination], this.dataDir, repository, "export_snapshot")
        } finally {
          await rm(archivePath, { force: true })
        }
        if (!existsSync(destination) || existsSync(path.join(destination, ".git"))) throw new CodeSyncOperationError(failure({
          repositoryRole: repository.role, repositoryName: repository.repository.name, stage: "validate_snapshot",
          errorType: "snapshot_invalid", exitCode: null,
        }))
        try {
          await assertTreeHasNoSymlinks(destination)
        } catch {
          throw new CodeSyncOperationError(failure({
            repositoryRole: repository.role, repositoryName: repository.repository.name, stage: "validate_snapshot",
            errorType: "snapshot_invalid", exitCode: null, safeSummary: "代码快照包含不允许的符号链接",
          }))
        }
      }
      const snapshotId = randomUUID()
      const snapshotsRoot = path.join(serviceRoot, "snapshots")
      const snapshotPath = path.join(snapshotsRoot, snapshotId)
      if (!inside(snapshotPath, this.serviceCodeRoot)) throw new CodeSyncOperationError(failure({
        repositoryRole: null, repositoryName: null, stage: "publish_snapshot", errorType: "configuration_invalid",
        exitCode: null, safeSummary: "快照发布目录无效",
      }))
      await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, snapshotPath)
      await mkdir(snapshotsRoot, { recursive: true })
      await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, snapshotsRoot)
      if (this.configurationChanged(service, configurationFingerprint)) throw new CodeSyncOperationError(failure({
        repositoryRole: null,
        repositoryName: null,
        stage: "validate_config",
        errorType: "process_interrupted",
        exitCode: null,
        safeSummary: "同步期间服务代码配置发生变化，旧快照未发布",
      }))
      await rename(stagingPath, snapshotPath)
      renamedSnapshotPath = snapshotPath
      await assertNoSymlinkDirectoryPath(this.serviceCodeRoot, snapshotPath)
      if (this.configurationChanged(service, configurationFingerprint)) throw new CodeSyncOperationError(failure({
        repositoryRole: null,
        repositoryName: null,
        stage: "validate_config",
        errorType: "process_interrupted",
        exitCode: null,
        safeSummary: "发布前服务代码配置发生变化，旧快照已丢弃",
      }))
      const publishedAt = new Date().toISOString()
      try {
        this.database.transaction(() => {
          this.database.prepare(`INSERT INTO service_code_snapshots(
            id,project_id,service_id,branch,repository_pair_fingerprint,commit_pair_fingerprint,status,created_at,published_at
          ) VALUES (?,?,?,?,?,?,'published',?,?)`).run(
            snapshotId, service.projectId, service.id, branch, pairFingerprint, commitPairFingerprint, publishedAt, publishedAt,
          )
          const insert = this.database.prepare(`INSERT INTO service_code_snapshot_items(
            snapshot_id,role,repository_id,repository_name,commit_hash,relative_path
          ) VALUES (?,?,?,?,?,?)`)
          repositories.forEach((repository) => insert.run(
            snapshotId, repository.role, repository.repository.id, repository.repository.name,
            repository.commit, repository.repository.name,
          ))
          this.database.prepare(`UPDATE service_code_sync_batches SET status='published',snapshot_id=?,finished_at=?,duration_ms=? WHERE id=?`).run(
            snapshotId, publishedAt, duration(startedAt, publishedAt), batchId,
          )
        })
      } catch (error) {
        throw new CodeSyncOperationError(failure({
          repositoryRole: null, repositoryName: null, stage: "publish_snapshot", errorType: "unknown",
          exitCode: null, safeSummary: "完整代码快照发布失败",
        }))
      }
      return {
        projectId: service.projectId,
        serviceId: service.id,
        service: service.key,
        branch,
        commit: codeRevision(repositories.map((repository) => ({ name: repository.repository.name, commit: repository.commit }))),
        snapshotId,
        syncBatchId: batchId,
        configurationFingerprint,
        syncState: "fresh",
        failure: null,
        publishedAt,
        workspacePath: snapshotPath,
        repositories: repositories.map((repository) => ({
          role: repository.role,
          repositoryId: repository.repository.id,
          name: repository.repository.name,
          branch,
          commit: repository.commit,
          snapshotPath: path.join(snapshotPath, repository.repository.name),
        })),
      }
    } catch (error) {
      if (renamedSnapshotPath) await rm(renamedSnapshotPath, { recursive: true, force: true })
      await rm(stagingPath, { recursive: true, force: true })
      throw error
    }
  }

  private fallbackOrThrow(
    service: ProjectServiceRecord,
    branch: string,
    pairFingerprint: string,
    configurationFingerprint: string,
    batchId: string,
    startedAt: string,
    syncFailure: CodeSyncFailure,
  ): ProjectCodeSnapshot {
    let cursorPublishedAt: string | null = null
    let cursorId: string | null = null
    while (true) {
      const rows = this.database.prepare(`SELECT * FROM service_code_snapshots
        WHERE service_id=? AND branch=? AND repository_pair_fingerprint=? AND status='published'
          AND (? IS NULL OR published_at<? OR (published_at=? AND id<?))
        ORDER BY published_at DESC,id DESC LIMIT 100`).all(
        service.id, branch, pairFingerprint,
        cursorPublishedAt, cursorPublishedAt, cursorPublishedAt, cursorId,
      ) as SnapshotRow[]
      for (const row of rows) {
        const snapshot = this.snapshotFromRow(
          service, row, configurationFingerprint, batchId, "fallback", syncFailure,
        )
        if (!snapshot) continue
        const finishedAt = new Date().toISOString()
        this.database.prepare(`UPDATE service_code_sync_batches SET status='fallback',fallback_snapshot_id=?,
          error_repository_role=?,error_repository_name=?,error_stage=?,error_type=?,exit_code=?,safe_summary=?,finished_at=?,duration_ms=?
          WHERE id=?`).run(
          row.id, syncFailure.repositoryRole, syncFailure.repositoryName, syncFailure.stage, syncFailure.errorType,
          syncFailure.exitCode, syncFailure.safeSummary, finishedAt, duration(startedAt, finishedAt), batchId,
        )
        return snapshot
      }
      if (rows.length < 100) break
      const last = rows.at(-1)!
      cursorPublishedAt = last.published_at
      cursorId = last.id
    }
    const finishedAt = new Date().toISOString()
    this.database.prepare(`UPDATE service_code_sync_batches SET status='failed',error_repository_role=?,error_repository_name=?,
      error_stage=?,error_type=?,exit_code=?,safe_summary=?,finished_at=?,duration_ms=? WHERE id=?`).run(
      syncFailure.repositoryRole, syncFailure.repositoryName, syncFailure.stage, syncFailure.errorType,
      syncFailure.exitCode, syncFailure.safeSummary, finishedAt, duration(startedAt, finishedAt), batchId,
    )
    throw new ProjectCodeSyncUnavailableError(batchId, syncFailure)
  }

  private snapshotFromRow(
    service: ProjectServiceRecord,
    row: SnapshotRow,
    configurationFingerprint: string,
    batchId: string,
    syncState: "fresh" | "fallback",
    syncFailure: CodeSyncFailure | null,
  ): ProjectCodeSnapshot | null {
    const items = this.database.prepare(`SELECT role,repository_id,repository_name,commit_hash,relative_path
      FROM service_code_snapshot_items WHERE snapshot_id=? ORDER BY CASE role WHEN 'backend' THEN 0 ELSE 1 END`).all(row.id) as SnapshotItemRow[]
    if (items.length !== 2 || !items.some((item) => item.role === "backend") || !items.some((item) => item.role === "frontend")) return null
    const snapshotPath = path.join(this.serviceCodeRoot, service.id, "snapshots", row.id)
    if (!inside(snapshotPath, this.serviceCodeRoot)
      || !isExistingSafeDirectoryPath(this.serviceCodeRoot, snapshotPath)) return null
    const repositories: ProjectRepositorySnapshot[] = []
    for (const item of items) {
      if (!commitPattern.test(item.commit_hash) || !["java-project", "sfzf-web"].includes(item.relative_path)) return null
      const itemPath = path.join(snapshotPath, item.relative_path)
      if (!inside(itemPath, snapshotPath) || !isExistingSafeDirectoryPath(snapshotPath, itemPath)
        || !isExistingTreeWithoutSymlinks(itemPath) || existsSync(path.join(itemPath, ".git"))) return null
      repositories.push({
        role: item.role,
        repositoryId: item.repository_id,
        name: item.repository_name,
        branch: row.branch,
        commit: item.commit_hash,
        snapshotPath: itemPath,
      })
    }
    return {
      projectId: service.projectId,
      serviceId: service.id,
      service: service.key,
      branch: row.branch,
      commit: codeRevision(repositories),
      snapshotId: row.id,
      syncBatchId: batchId,
      configurationFingerprint,
      syncState,
      failure: syncFailure,
      publishedAt: row.published_at,
      workspacePath: snapshotPath,
      repositories,
    }
  }

  private markScheduleSuccess(serviceId: string, now: string): void {
    const next = new Date(Date.parse(now) + scheduledSyncIntervalMs).toISOString()
    this.database.prepare(`INSERT INTO service_code_sync_schedule(
      service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,failure_count,last_alert_fingerprint,created_at,updated_at
    ) VALUES (?,?,'healthy',?,NULL,0,NULL,?,?) ON CONFLICT(service_id) DO UPDATE SET
      next_hourly_sync_at=excluded.next_hourly_sync_at,health_status='healthy',last_success_at=excluded.last_success_at,
      last_failure_at=NULL,failure_count=0,last_alert_fingerprint=NULL,updated_at=excluded.updated_at`).run(
      serviceId, next, now, now, now,
    )
  }

  private async serializeRemoteSync<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.remoteSyncTail
    let release: () => void = () => undefined
    this.remoteSyncTail = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async runCommand(
    command: string,
    args: string[],
    cwd: string,
    binding: Pick<BoundRepository, "role" | "repository">,
    stage: CodeSyncStage,
  ): Promise<string> {
    try {
      const result = await this.runner.run(command, args, { cwd, timeoutMs: 180_000 })
      if (result.exitCode !== 0) throw new CodeSyncOperationError(classifyCommandFailure(
        binding.role, binding.repository.name, stage, result,
      ))
      return result.stdout.trim()
    } catch (error) {
      if (error instanceof CodeSyncOperationError) throw error
      throw new CodeSyncOperationError(failure({
        repositoryRole: binding.role,
        repositoryName: binding.repository.name,
        stage,
        errorType: "unknown",
        exitCode: null,
      }))
    }
  }

  private operationFailure(
    error: unknown,
    role: CodeRepositoryRole | null,
    repositoryName: string | null,
    stage: CodeSyncStage,
  ): CodeSyncFailure {
    if (error instanceof CodeSyncOperationError) return error.failure
    return failure({ repositoryRole: role, repositoryName, stage, errorType: "unknown", exitCode: null })
  }
}

export { ProjectCodeSyncUnavailableError } from "./project-errors.js"
