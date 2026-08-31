import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { z } from "zod"

import type { ModelConfigService, ModelInstanceSnapshot } from "../runtime/model-config-service.js"
import type { ModelPurpose, ModelServiceTier, ReasoningEffort } from "../runtime/types.js"
import { CodexCliAdapter } from "../models/codex-cli-adapter.js"
import { DirectApiAdapter } from "../models/direct-api/direct-api-adapter.js"
import { ModelGateway } from "../models/model-gateway.js"
import type { ModelImageInput } from "../models/types.js"
import { ReadonlyAgentToolBroker } from "../diagnostics/readonly-agent-tool-broker.js"

export type CodexAccessMode = "read-only" | "diagnostic" | "reference-classifier" | "shadow-report" | "text-only"

export type CodexInvocation = {
  cwd: string
  model: string
  reasoningEffort: ReasoningEffort
  serviceTier?: ModelServiceTier
  timeoutMs: number
  prompt: string
  outputSchema: Record<string, unknown>
  accessMode: CodexAccessMode
  imagePaths?: string[]
  readableRoots?: string[]
  networkHosts?: string[]
  signal?: AbortSignal
}

export type CodexStatus = {
  available: boolean
  authenticated: boolean
  version: string
  message: string
}

export type CodexCommandObservation = {
  command: string
  output: string
  exitCode: number | null
}

export type CodexRunnerResult = {
  output: string
  observations: CodexCommandObservation[]
}

export class CodexExecutionTimeoutError extends Error {
  constructor(readonly observations: CodexCommandObservation[] = []) {
    super("Codex 执行超时")
    this.name = "CodexExecutionTimeoutError"
  }
}

export class CodexExecutionError extends Error {
  constructor(message: string, readonly observations: CodexCommandObservation[] = []) {
    super(message)
    this.name = "CodexExecutionError"
  }
}

export type CodexCommandRunner = {
  invoke(invocation: CodexInvocation): Promise<string | CodexRunnerResult>
  status(): Promise<CodexStatus>
  shutdown?(): Promise<void>
}

type ProcessResult = { code: number; stdout: string; stderr: string }

const REFERENCE_CLASSIFIER_PROFILE = "reference-classifier"
const SHADOW_REPORT_PROFILE = "shadow-report"
const TEXT_ONLY_PROFILE = "text-only"
const REFERENCE_CLASSIFIER_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "workspace_dependencies",
] as const

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseCodexCommandObservations(output: string): CodexCommandObservation[] {
  const observations: CodexCommandObservation[] = []
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event: Record<string, unknown> | null = null
    try { event = record(JSON.parse(line)) } catch { continue }
    if (event?.type !== "item.completed") continue
    const item = record(event.item)
    if (item?.type !== "command_execution") continue
    const command = typeof item.command === "string"
      ? item.command
      : Array.isArray(item.command) && item.command.every((part) => typeof part === "string")
        ? item.command.join(" ")
        : null
    if (!command) continue
    const rawExitCode = item.exit_code ?? item.exitCode
    const commandOutput = typeof item.aggregated_output === "string"
      ? item.aggregated_output
      : typeof item.output === "string"
        ? item.output
        : typeof item.stdout === "string" ? item.stdout : ""
    observations.push({
      command: command.slice(0, 2000),
      output: commandOutput.slice(0, 8000),
      exitCode: typeof rawExitCode === "number" && Number.isInteger(rawExitCode) ? rawExitCode : null,
    })
    if (observations.length >= 24) break
  }
  return observations
}

function executionObservations(error: unknown): CodexCommandObservation[] {
  if (!error || typeof error !== "object" || !("observations" in error)) return []
  const value = (error as { observations?: unknown }).observations
  return Array.isArray(value) ? value.filter((item): item is CodexCommandObservation => (
    Boolean(item) && typeof item === "object"
    && typeof (item as CodexCommandObservation).command === "string"
    && typeof (item as CodexCommandObservation).output === "string"
  )) : []
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("参考分类只读路径必须是绝对目录")
  let canonical: string
  try {
    canonical = await realpath(value)
    if (!(await stat(canonical)).isDirectory()) throw new Error("not-directory")
  } catch {
    throw new Error("参考分类只读目录不存在或不可用")
  }
  if (value !== canonical) throw new Error("参考分类只读路径必须是 realpath")
  return canonical
}

export async function resolveReferenceClassifierRoots(
  cwd: string,
  readableRoots: string[],
): Promise<{ cwd: string; readableRoots: string[] }> {
  if (readableRoots.length === 0) throw new Error("参考分类缺少只读代码快照")
  const canonicalCwd = await canonicalDirectory(cwd)
  const canonicalRoots = await Promise.all(readableRoots.map(canonicalDirectory))
  const uniqueRoots = [...new Set(canonicalRoots)].sort()
  for (const root of uniqueRoots) {
    const relative = path.relative(canonicalCwd, root)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("参考分类只允许读取当前代码快照内的仓库目录")
    }
  }
  return { cwd: canonicalCwd, readableRoots: uniqueRoots }
}

function sandboxPlatform(platform: NodeJS.Platform): "macos" | "linux" | "windows" {
  if (platform === "darwin") return "macos"
  if (platform === "linux") return "linux"
  if (platform === "win32") return "windows"
  throw new Error("当前平台不支持参考分类 Codex 权限沙箱")
}

export function validateReferenceClassifierCliCapabilities(
  execHelp: string,
  sandboxHelp: string,
  platform: NodeJS.Platform,
): void {
  sandboxPlatform(platform)
  for (const option of ["--strict-config", "--ephemeral", "--ignore-user-config", "--disable"]) {
    if (!execHelp.includes(option)) throw new Error("Codex CLI 缺少参考分类严格配置能力")
  }
  if (!sandboxHelp.includes("--permissions-profile") && !sandboxHelp.includes("--permission-profile")) {
    throw new Error("Codex CLI 缺少参考分类权限 profile 能力")
  }
}

type ReferenceSandboxCli = {
  commandPrefix: string[]
  permissionProfileOption: "--permission-profile" | "--permissions-profile"
  help: string
}

async function resolveReferenceSandboxCli(cwd: string): Promise<ReferenceSandboxCli> {
  const platform = sandboxPlatform(process.platform)
  const root = await runProcess("codex", ["sandbox", "--help"], "", cwd, 10_000)
  const rootHelp = `${root.stdout}\n${root.stderr}`
  if (rootHelp.includes("--permission-profile")) {
    return { commandPrefix: ["sandbox"], permissionProfileOption: "--permission-profile", help: rootHelp }
  }
  if (rootHelp.includes("--permissions-profile")) {
    return { commandPrefix: ["sandbox"], permissionProfileOption: "--permissions-profile", help: rootHelp }
  }
  const scoped = await runProcess("codex", ["sandbox", platform, "--help"], "", cwd, 10_000)
  const scopedHelp = `${scoped.stdout}\n${scoped.stderr}`
  if (scopedHelp.includes("--permission-profile")) {
    return { commandPrefix: ["sandbox", platform], permissionProfileOption: "--permission-profile", help: scopedHelp }
  }
  if (scopedHelp.includes("--permissions-profile")) {
    return { commandPrefix: ["sandbox", platform], permissionProfileOption: "--permissions-profile", help: scopedHelp }
  }
  throw new Error("Codex CLI 缺少参考分类权限 profile 能力")
}

function referenceClassifierConfig(readableRoots: string[]): string[] {
  if (readableRoots.length === 0) throw new Error("参考分类缺少只读代码快照")
  const filesystem = [
    [":root", "deny"],
    [":minimal", "read"],
    [":tmpdir", "deny"],
    ...(process.platform === "win32" ? [] : [[":slash_tmp", "deny"]]),
    ...readableRoots.map((root) => [root, "read"]),
  ].map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(",")
  return [
    `default_permissions=${JSON.stringify(REFERENCE_CLASSIFIER_PROFILE)}`,
    `permissions.${REFERENCE_CLASSIFIER_PROFILE}.filesystem={${filesystem}}`,
    `permissions.${REFERENCE_CLASSIFIER_PROFILE}.network.enabled=false`,
    "web_search=\"disabled\"",
  ]
}

function shadowReportConfig(cwd: string): string[] {
  const filesystem = [
    [":root", "deny"],
    [":minimal", "read"],
    [":tmpdir", "deny"],
    ...(process.platform === "win32" ? [] : [[":slash_tmp", "deny"]]),
    [cwd, "read"],
  ].map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(",")
  return [
    `default_permissions=${JSON.stringify(SHADOW_REPORT_PROFILE)}`,
    `permissions.${SHADOW_REPORT_PROFILE}.filesystem={${filesystem}}`,
    `permissions.${SHADOW_REPORT_PROFILE}.network.enabled=false`,
    "web_search=\"disabled\"",
  ]
}

function textOnlyConfig(): string[] {
  const filesystem = [
    [":root", "deny"],
    [":minimal", "read"],
    [":tmpdir", "deny"],
    ...(process.platform === "win32" ? [] : [[":slash_tmp", "deny"]]),
  ].map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(",")
  return [
    `default_permissions=${JSON.stringify(TEXT_ONLY_PROFILE)}`,
    `permissions.${TEXT_ONLY_PROFILE}.filesystem={${filesystem}}`,
    `permissions.${TEXT_ONLY_PROFILE}.network.enabled=false`,
    "web_search=\"disabled\"",
  ]
}

function runProcess(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  registerStop?: (stop: () => void) => () => void,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Codex 执行已取消"))
      return
    }
    const grouped = process.platform !== "win32"
    const child = spawn(command, args, {
      cwd,
      env: minimalEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: grouped,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* 进程组已经退出。 */ }
    }
    const unregisterStop = registerStop?.(() => terminate("SIGKILL")) ?? (() => undefined)
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => {
      terminate("SIGKILL")
      finish(() => reject(new CodexExecutionError("Codex 执行已取消", parseCodexCommandObservations(stdout))))
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      signal?.removeEventListener("abort", onAbort)
      unregisterStop()
      callback()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      terminate("SIGTERM")
      hardKillTimer = setTimeout(() => {
        terminate("SIGKILL")
        finish(() => reject(new CodexExecutionTimeoutError(parseCodexCommandObservations(stdout))))
      }, 1500)
    }, timeoutMs)
    timer.unref()
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 128_000) stdout += chunk.slice(0, 128_000 - stdout.length)
    })
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 128_000) stderr += chunk.slice(0, 128_000 - stderr.length)
    })
    child.once("error", () => {
      terminate("SIGKILL")
      finish(() => reject(new Error("Codex 命令不可用")))
    })
    child.stdin.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return
      terminate("SIGKILL")
      finish(() => reject(new Error("Codex 输入传输失败")))
    })
    child.once("close", (code) => finish(() => {
      terminate("SIGKILL")
      const observations = parseCodexCommandObservations(stdout)
      if (timedOut) reject(new CodexExecutionTimeoutError(observations))
      else if (code !== 0) reject(new CodexExecutionError(stderr.length > 0 ? "Codex 执行失败" : "Codex 未返回结果", observations))
      else resolve({ code: code ?? 0, stdout, stderr })
    }))
    child.stdin.end(input, "utf8")
  })
}

export async function verifyReferenceClassifierSandboxCapabilities(
  cwd: string,
  readableRoots: string[],
  resolvedCli?: ReferenceSandboxCli,
): Promise<void> {
  const cli = resolvedCli ?? await resolveReferenceSandboxCli(cwd)
  const config = referenceClassifierConfig(readableRoots)
  const baseArgs = [
    ...cli.commandPrefix,
    cli.permissionProfileOption, REFERENCE_CLASSIFIER_PROFILE,
    "-C", cwd,
    ...config.flatMap((override) => ["-c", override]),
    "--",
  ]
  const directory = await mkdtemp(process.platform === "win32"
    ? path.join(tmpdir(), "telegram-support-codex-capability-")
    : "/tmp/telegram-support-codex-capability-")
  const marker = path.join(directory, "unreadable.marker")
  try {
    await chmod(directory, 0o700)
    await writeFile(marker, "permission-probe\n", { encoding: "utf8", mode: 0o600 })
    if (process.platform === "win32") {
      const script = [
        "$rootPath = $args[0]; $markerPath = $args[1]",
        "try { Get-ChildItem -LiteralPath $rootPath -ErrorAction Stop | Out-Null } catch { exit 42 }",
        "try { Get-Content -LiteralPath $markerPath -ErrorAction Stop | Out-Null } catch { exit 0 }",
        "exit 41",
      ].join("; ")
      await runProcess("codex", [
        ...baseArgs,
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
        readableRoots[0]!, marker,
      ], "", cwd, 10_000)
    } else {
      await runProcess("codex", [
        ...baseArgs,
        "/bin/sh", "-c", [
          "if ! /bin/ls \"$1\" >/dev/null 2>&1; then exit 42; fi",
          "if /bin/cat \"$2\" >/dev/null 2>&1; then exit 41; fi",
        ].join("\n"),
        "reference-classifier-capability-probe", readableRoots[0]!, marker,
      ], "", cwd, 10_000)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function buildCodexArgs(invocation: CodexInvocation, schemaFile: string, outputFile: string): string[] {
  const diagnostic = invocation.accessMode === "diagnostic"
  const referenceClassifier = invocation.accessMode === "reference-classifier"
  const shadowReport = invocation.accessMode === "shadow-report"
  const textOnly = invocation.accessMode === "text-only"
  const strictProfile = referenceClassifier || shadowReport || textOnly
  const commandPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  return [
    "--ask-for-approval", "never", "exec", "--ephemeral", "--skip-git-repo-check",
    ...(strictProfile ? ["--strict-config"] : []),
    "--json",
    ...(strictProfile ? [] : ["--sandbox", diagnostic ? "danger-full-access" : "read-only"]),
    "--ignore-user-config", "--ignore-rules",
    ...(strictProfile
      ? REFERENCE_CLASSIFIER_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature])
      : []),
    ...(referenceClassifier
      ? referenceClassifierConfig(invocation.readableRoots ?? []).flatMap((override) => ["-c", override])
      : []),
    ...(shadowReport
      ? shadowReportConfig(invocation.cwd).flatMap((override) => ["-c", override])
      : []),
    ...(textOnly
      ? textOnlyConfig().flatMap((override) => ["-c", override])
      : []),
    "-c", "shell_environment_policy.inherit=\"none\"",
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    "-c", `shell_environment_policy.set.PATH=${JSON.stringify(commandPath)}`,
    "-c", `shell_environment_policy.set.HOME=${JSON.stringify(invocation.cwd)}`,
    ...(strictProfile ? [] : (invocation.imagePaths ?? []).flatMap((imagePath) => ["--image", imagePath])),
    "--output-schema", schemaFile, "--output-last-message", outputFile, "-C", invocation.cwd, "-m", invocation.model,
    "-c", `model_reasoning_effort=${JSON.stringify(invocation.reasoningEffort)}`,
    ...(invocation.serviceTier === "fast" ? ["-c", "service_tier=\"fast\""] : []),
    "-",
  ]
}

export class LocalCodexCommandRunner implements CodexCommandRunner {
  private readonly activeStops = new Set<() => void>()
  private readonly activeInvocations = new Set<Promise<CodexRunnerResult>>()
  private stopping = false
  private referenceClassifierCapabilities: Promise<void> | null = null

  async invoke(invocation: CodexInvocation): Promise<CodexRunnerResult> {
    if (this.stopping) throw new Error("Codex 执行器已停止")
    const task = this.invokeOnce(invocation)
    this.activeInvocations.add(task)
    try { return await task }
    finally { this.activeInvocations.delete(task) }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    ;[...this.activeStops].forEach((stop) => stop())
    await Promise.allSettled([...this.activeInvocations])
  }

  private async invokeOnce(invocation: CodexInvocation): Promise<CodexRunnerResult> {
    const effectiveInvocation = invocation.accessMode === "reference-classifier"
      ? { ...invocation, ...await resolveReferenceClassifierRoots(invocation.cwd, invocation.readableRoots ?? []) }
      : invocation
    if (effectiveInvocation.accessMode === "reference-classifier") {
      await this.ensureReferenceClassifierCapabilities(
        effectiveInvocation.cwd,
        effectiveInvocation.readableRoots ?? [],
      )
    }
    const directory = await mkdtemp(path.join(tmpdir(), "telegram-support-codex-"))
    const schemaFile = path.join(directory, "output-schema.json")
    const outputFile = path.join(directory, "result.json")
    try {
      await chmod(directory, 0o700)
      await writeFile(schemaFile, JSON.stringify(effectiveInvocation.outputSchema), { encoding: "utf8", mode: 0o600 })
      const args = buildCodexArgs(effectiveInvocation, schemaFile, outputFile)
      const execution = await runProcess("codex", args, effectiveInvocation.prompt, effectiveInvocation.cwd, effectiveInvocation.timeoutMs, (stop) => {
        if (this.stopping) {
          stop()
          return () => undefined
        }
        this.activeStops.add(stop)
        return () => this.activeStops.delete(stop)
      }, effectiveInvocation.signal)
      const output = await readFile(outputFile, "utf8")
      if (Buffer.byteLength(output, "utf8") > 256_000) throw new Error("Codex 结果过大")
      return { output, observations: parseCodexCommandObservations(execution.stdout) }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private ensureReferenceClassifierCapabilities(cwd: string, readableRoots: string[]): Promise<void> {
    this.referenceClassifierCapabilities ??= (async () => {
      const [execHelp, sandboxCli] = await Promise.all([
        runProcess("codex", ["exec", "--help"], "", cwd, 10_000),
        resolveReferenceSandboxCli(cwd),
      ])
      validateReferenceClassifierCliCapabilities(
        `${execHelp.stdout}\n${execHelp.stderr}`,
        sandboxCli.help,
        process.platform,
      )
      await verifyReferenceClassifierSandboxCapabilities(cwd, readableRoots, sandboxCli)
    })().catch(() => {
      throw new CodexExecutionError("参考分类 Codex 最小权限能力不可用，请管理员升级 Codex CLI")
    })
    return this.referenceClassifierCapabilities
  }

  async status(): Promise<CodexStatus> {
    try {
      const version = (await runProcess("codex", ["--version"], "", process.cwd(), 10_000)).stdout.trim()
      const loginResult = await runProcess("codex", ["login", "status"], "", process.cwd(), 10_000)
      const login = `${loginResult.stdout}\n${loginResult.stderr}`.trim()
      const authenticated = /logged in/i.test(login)
      return { available: true, authenticated, version, message: authenticated ? "Codex 已登录" : "Codex 未登录" }
    } catch {
      return { available: false, authenticated: false, version: "", message: "Codex CLI 不可用" }
    }
  }
}

type ExecutionInput<T> = {
  cwd: string
  modelInstanceId?: string
  modelSnapshot?: ModelInstanceSnapshot
  bindingSnapshot?: { enabled: boolean; timeoutSeconds: number; maxConcurrency: number }
  prompt: string
  images?: ModelImageInput[]
  outputSchema: Record<string, unknown>
  validator: z.ZodType<T>
  accessMode?: CodexAccessMode
  readableRoots?: string[]
  networkHosts?: string[]
  signal?: AbortSignal
  executionTimeoutMs?: number
  concurrencyGroup?: string
  maxConcurrency?: number
  onCommandObservations?: (observations: CodexCommandObservation[]) => void | Promise<void>
}

export class CodexExecutor {
  private readonly gateway: ModelGateway

  constructor(
    config: ModelConfigService,
    runner: CodexCommandRunner = new LocalCodexCommandRunner(),
    directApi?: DirectApiAdapter,
  ) {
    this.gateway = new ModelGateway(
      config,
      new CodexCliAdapter(runner),
      directApi ?? new DirectApiAdapter(fetch, new ReadonlyAgentToolBroker()),
    )
  }

  status(): Promise<CodexStatus> {
    return this.gateway.status()
  }

  shutdown(): Promise<void> {
    return this.gateway.shutdown()
  }

  testModelConnection(id: string): Promise<void> {
    return this.gateway.testConnection(id)
  }

  async execute<T>(purpose: ModelPurpose, input: ExecutionInput<T>): Promise<T> {
    try {
      return await this.gateway.execute(purpose, {
        cwd: input.cwd,
        ...(input.modelInstanceId ? { modelInstanceId: input.modelInstanceId } : {}),
        ...(input.modelSnapshot ? { modelSnapshot: input.modelSnapshot } : {}),
        ...(input.bindingSnapshot ? { bindingSnapshot: input.bindingSnapshot } : {}),
        prompt: input.prompt,
        ...(input.images?.length ? { images: input.images } : {}),
        outputSchema: input.outputSchema,
        validator: input.validator,
        accessMode: input.accessMode ?? "read-only",
        codeRoots: input.readableRoots ?? [],
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.executionTimeoutMs ? { executionTimeoutMs: input.executionTimeoutMs } : {}),
        ...(input.concurrencyGroup ? { concurrencyGroup: input.concurrencyGroup } : {}),
        ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
        ...(input.onCommandObservations ? { onCommandObservations: input.onCommandObservations } : {}),
      })
    } catch (error) {
      const observations = executionObservations(error)
      if (observations.length > 0) await input.onCommandObservations?.(observations)
      throw error
    }
  }
}
