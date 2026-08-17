import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { GitSyncService } from "../../src/git-sync/service.js"
import type { CommandRunner, RunOptions, RunResult } from "../../src/git-sync/types.js"

const temporaryDirectories: string[] = []
const commit = "a".repeat(40)

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options: RunOptions }> = []

  constructor(private readonly failFetch = false) {}

  async run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
    this.calls.push({ command, args: [...args], options: { ...options } })
    if (args.includes("fetch") && this.failFetch) return { exitCode: 1, stdout: "", stderr: "restricted detail" }
    if (args.includes("rev-parse")) return { exitCode: 0, stdout: `${commit}\n`, stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

async function fixture(failFetch = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "git-sync-"))
  temporaryDirectories.push(dataDir)
  const runner = new FakeRunner(failFetch)
  const service = new GitSyncService({
    dataDir,
    repositories: {
      "java-project": { remote: "private-remote-ref-java", allowedBranches: ["prod-pkr", "uat"] },
      "sfzf-web": { remote: "private-remote-ref-web", allowedBranches: ["prod-pkr", "uat"] },
    },
    runner,
  })
  return { dataDir, runner, service }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("专用镜像 Git 同步屏障", () => {
  it("使用参数数组同步并返回专用目录中的不可变提交快照", async () => {
    const { dataDir, runner, service } = await fixture()

    const snapshot = await service.sync({ repository: "java-project", branch: "prod-pkr" })

    expect(snapshot).toEqual({
      repository: "java-project",
      branch: "prod-pkr",
      commit,
      snapshotPath: path.join(dataDir, "git-snapshots", "java-project", "prod-pkr", commit),
    })
    expect(runner.calls.every((call) => call.command === "git" && Array.isArray(call.args))).toBe(true)
    expect(runner.calls.some((call) => call.args[0] === "clone" && call.args.includes("private-remote-ref-java"))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes("fetch") && call.args.includes("prod-pkr"))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes("worktree") && call.args.includes("--detach"))).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("private-remote-ref")
    expect(path.resolve(snapshot.snapshotPath).startsWith(path.join(path.resolve(dataDir), "git-snapshots") + path.sep)).toBe(true)
  })

  it("拒绝未配置仓库、分支和路径穿越", async () => {
    const { runner, service } = await fixture()

    await expect(service.sync({ repository: "unknown" as "java-project", branch: "prod-pkr" })).rejects.toThrow("仓库未授权")
    await expect(service.sync({ repository: "java-project", branch: "main" })).rejects.toThrow("分支未授权")
    await expect(service.sync({ repository: "java-project", branch: "../prod-pkr" })).rejects.toThrow("分支未授权")
    expect(runner.calls).toHaveLength(0)
  })

  it("同步失败时不返回旧提交或命令原始错误", async () => {
    const { service } = await fixture(true)

    await expect(service.sync({ repository: "java-project", branch: "prod-pkr" })).rejects.toThrow("Git 同步失败")
    await expect(service.sync({ repository: "java-project", branch: "prod-pkr" })).rejects.not.toThrow("restricted detail")
  })
})
