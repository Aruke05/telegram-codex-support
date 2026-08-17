import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"

import { NodeCommandRunner } from "./command-runner.js"
import type {
  CommandRunner,
  GitRepositoryConfig,
  GitSnapshot,
  GitSyncRequest,
} from "./types.js"

const repositoryNames = ["java-project", "sfzf-web"] as const
const safeBranchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export type GitSyncServiceOptions = {
  dataDir: string
  repositories: Record<(typeof repositoryNames)[number], GitRepositoryConfig>
  runner?: CommandRunner
}

function isRepositoryName(value: string): value is (typeof repositoryNames)[number] {
  return repositoryNames.includes(value as (typeof repositoryNames)[number])
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

export class GitSyncService {
  private readonly dataDir: string
  private readonly repositories: GitSyncServiceOptions["repositories"]
  private readonly runner: CommandRunner
  private readonly inFlight = new Map<string, Promise<GitSnapshot>>()

  constructor(options: GitSyncServiceOptions) {
    this.dataDir = path.resolve(options.dataDir)
    this.repositories = options.repositories
    this.runner = options.runner ?? new NodeCommandRunner()
  }

  async sync(request: GitSyncRequest): Promise<GitSnapshot> {
    if (!isRepositoryName(request.repository)) throw new Error("仓库未授权")
    const repository = this.repositories[request.repository]
    if (
      !safeBranchPattern.test(request.branch)
      || request.branch.includes("..")
      || !repository.allowedBranches.includes(request.branch)
    ) {
      throw new Error("分支未授权")
    }

    const key = `${request.repository}:${request.branch}`
    const current = this.inFlight.get(key)
    if (current) return current
    const pending = this.syncLatest(request, repository).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, pending)
    return pending
  }

  private async runGit(args: string[], cwd: string): Promise<string> {
    try {
      const result = await this.runner.run("git", args, { cwd, timeoutMs: 120_000 })
      if (result.exitCode !== 0) throw new Error("Git 同步失败")
      return result.stdout.trim()
    } catch {
      throw new Error("Git 同步失败")
    }
  }

  private async syncLatest(request: GitSyncRequest, repository: GitRepositoryConfig): Promise<GitSnapshot> {
    const mirrorsRoot = path.join(this.dataDir, "git-mirrors")
    const snapshotsRoot = path.join(this.dataDir, "git-snapshots")
    const mirrorPath = path.join(mirrorsRoot, `${request.repository}.git`)
    if (!isPathInside(mirrorPath, mirrorsRoot)) throw new Error("Git 同步路径无效")
    await Promise.all([mkdir(mirrorsRoot, { recursive: true }), mkdir(snapshotsRoot, { recursive: true })])

    if (!existsSync(mirrorPath)) {
      await this.runGit(["clone", "--mirror", "--filter=blob:none", repository.remote, mirrorPath], mirrorsRoot)
    }
    await this.runGit(["--git-dir", mirrorPath, "fetch", "--prune", "origin", request.branch], mirrorsRoot)
    const commit = (await this.runGit([
      "--git-dir",
      mirrorPath,
      "rev-parse",
      "FETCH_HEAD^{commit}",
    ], mirrorsRoot)).toLowerCase()
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Git 同步失败")

    const snapshotPath = path.join(snapshotsRoot, request.repository, request.branch, commit)
    if (!isPathInside(snapshotPath, snapshotsRoot)) throw new Error("Git 同步路径无效")
    if (!existsSync(snapshotPath)) {
      await mkdir(path.dirname(snapshotPath), { recursive: true })
      await this.runGit([
        "--git-dir",
        mirrorPath,
        "worktree",
        "add",
        "--detach",
        snapshotPath,
        commit,
      ], snapshotsRoot)
    }

    return { repository: request.repository, branch: request.branch, commit, snapshotPath }
  }
}
