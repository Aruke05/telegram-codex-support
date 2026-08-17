import type { RepositoryName } from "../catalog/schema.js"

export type RunOptions = {
  cwd: string
  timeoutMs?: number
}

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface CommandRunner {
  run(command: string, args: string[], options: RunOptions): Promise<RunResult>
}

export type GitRepositoryConfig = {
  remote: string
  allowedBranches: string[]
}

export type GitSyncRequest = {
  repository: RepositoryName
  branch: string
}

export type GitSnapshot = {
  repository: RepositoryName
  branch: string
  commit: string
  snapshotPath: string
}
