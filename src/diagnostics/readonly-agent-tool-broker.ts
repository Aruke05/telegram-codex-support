import { spawn } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import type { CodexCommandObservation } from "../codex/executor.js"
import type { AgentToolBroker, AgentToolCall, AgentToolDefinition, AgentToolResult, AgentToolScope } from "../models/types.js"
import { validateTrustedCommandObservation } from "../support/trusted-command-observation.js"

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict()
const readSchema = z.object({
  path: z.string().min(1).max(1000),
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(500).default(200),
}).strict()
const gitSchema = z.object({
  repository: z.string().min(1).max(1000),
  operation: z.enum(["log", "show", "diff"]),
  revision: z.string().regex(/^[A-Za-z0-9._~^/-]{1,160}$/).optional(),
  path: z.string().max(1000).optional(),
}).strict()
const databaseSchema = z.object({
  databaseAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
  serverAlias: z.string().regex(/^support-[1-9]\d*$/).nullable().default(null),
  sql: z.string().min(1).max(20_000),
  rows: z.number().int().min(1).max(100).default(30),
}).strict()
const serverSchema = z.object({
  serverAlias: z.string().regex(/^support-[1-9]\d*$/),
  check: z.enum(["uptime", "memory", "disk", "load", "network", "service_status"]),
  service: z.string().regex(/^[A-Za-z0-9@_.-]{1,160}$/).optional(),
}).strict()
const logSchema = z.object({
  serverAlias: z.string().regex(/^support-[1-9]\d*$/),
  service: z.string().regex(/^[A-Za-z0-9@_.-]{1,160}$/),
  since: z.string().regex(/^[A-Za-z0-9: +._-]{1,80}$/).default("30 minutes ago"),
  lines: z.number().int().min(1).max(1000).default(300),
}).strict()
const redisSchema = z.object({
  serverAlias: z.string().regex(/^support-[1-9]\d*$/),
  operation: z.enum(["GET", "MGET", "HGET", "HMGET", "HGETALL", "EXISTS", "TTL", "PTTL", "TYPE", "SCAN"]),
  arguments: z.array(z.string().regex(/^[A-Za-z0-9:_*?.-]{1,256}$/)).min(1).max(21),
  database: z.number().int().min(0).max(65535).default(0),
}).strict()

async function safeRealPath(candidate: string, roots: string[], cwd: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(cwd, candidate))
    const realRoots = await Promise.all(roots.map(async (root) => {
      try { return await realpath(path.resolve(root)) } catch { return null }
    }))
    return realRoots.some((root) => {
      if (!root) return false
      const relative = path.relative(root, resolved)
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    }) ? resolved : null
  } catch { return null }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function commandText(argv: string[]): string {
  return argv.map((value) => /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : shellQuote(value)).join(" ")
}

function run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CodexCommandObservation> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("只读工具已取消")); return }
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
    let stdout = ""
    let stderr = ""
    let settled = false
    const terminate = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { /* 子进程已经退出。 */ }
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => { terminate(); finish(() => reject(new Error("只读工具已取消"))) }
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => { terminate(); finish(() => reject(new Error("只读工具执行超时"))) }, timeoutMs)
    timer.unref()
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 64_000) })
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, 16_000) })
    child.once("error", () => finish(() => reject(new Error("只读工具命令不可用"))))
    child.once("close", (code) => finish(() => resolve({
      command: commandText([command, ...args]).slice(0, 2000),
      output: `${stdout}${stderr ? `\n${stderr}` : ""}`.slice(0, 32_000),
      exitCode: code,
    })))
  })
}

const definitions: AgentToolDefinition[] = [
  { name: "search_code", description: "在当前服务的代码快照中限量搜索文本", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
  { name: "read_code", description: "读取当前代码快照中的指定行", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 500 } } } },
  { name: "read_git", description: "读取当前代码快照的 Git 日志、提交或差异", inputSchema: { type: "object", additionalProperties: false, required: ["repository", "operation"], properties: { repository: { type: "string" }, operation: { type: "string", enum: ["log", "show", "diff"] }, revision: { type: "string" }, path: { type: "string" } } } },
  { name: "server_check", description: "通过绑定服务器执行预定义只读状态检查", inputSchema: { type: "object", additionalProperties: false, required: ["serverAlias", "check"], properties: { serverAlias: { type: "string" }, check: { type: "string", enum: ["uptime", "memory", "disk", "load", "network", "service_status"] }, service: { type: "string" } } } },
  { name: "read_recent_logs", description: "读取绑定服务器的限量近期服务日志", inputSchema: { type: "object", additionalProperties: false, required: ["serverAlias", "service"], properties: { serverAlias: { type: "string" }, service: { type: "string" }, since: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 1000 } } } },
  { name: "database_query", description: "通过当前资源工作区的数据库只读助手查询", inputSchema: { type: "object", additionalProperties: false, required: ["databaseAlias", "sql"], properties: { databaseAlias: { type: "string" }, serverAlias: { type: ["string", "null"] }, sql: { type: "string" }, rows: { type: "integer", minimum: 1, maximum: 100 } } } },
  { name: "redis_read", description: "在绑定服务器上执行 Redis 白名单只读命令", inputSchema: { type: "object", additionalProperties: false, required: ["serverAlias", "operation", "arguments"], properties: { serverAlias: { type: "string" }, operation: { type: "string", enum: ["GET", "MGET", "HGET", "HMGET", "HGETALL", "EXISTS", "TTL", "PTTL", "TYPE", "SCAN"] }, arguments: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 21 }, database: { type: "integer", minimum: 0, maximum: 65535 } } } },
]

export class ReadonlyAgentToolBroker implements AgentToolBroker {
  constructor(private readonly redact: (value: string) => string = (value) => value) {}

  definitions(): AgentToolDefinition[] {
    return definitions
  }

  async execute(call: AgentToolCall, scope: AgentToolScope, signal?: AbortSignal): Promise<AgentToolResult> {
    if (call.name === "search_code") return this.search(call.arguments, scope, signal)
    if (call.name === "read_code") return this.read(call.arguments, scope)
    if (call.name === "read_git") return this.git(call.arguments, scope, signal)
    if (call.name === "database_query") {
      const input = databaseSchema.parse(call.arguments)
      const argv = ["node", path.join(scope.cwd, "query-database.mjs"), "--database", input.databaseAlias,
        ...(input.serverAlias ? ["--server", input.serverAlias] : []), "--sql", input.sql, "--rows", String(input.rows)]
      return this.validatedRun(argv[0]!, argv.slice(1), scope, signal, 60_000)
    }
    if (call.name === "server_check") {
      const input = serverSchema.parse(call.arguments)
      const remote = input.check === "uptime" ? "uptime"
        : input.check === "memory" ? "free -m"
          : input.check === "disk" ? "df -h"
            : input.check === "load" ? "cat /proc/loadavg"
              : input.check === "network" ? "ip -s link"
                : `systemctl is-active ${input.service ?? "sfzf-service"}`
      return this.validatedRun("ssh", ["-F", path.join(scope.cwd, "ssh_config"), input.serverAlias, remote], scope, signal)
    }
    if (call.name === "read_recent_logs") {
      const input = logSchema.parse(call.arguments)
      const remote = commandText(["journalctl", "--no-pager", "-u", input.service, "--since", input.since, "-n", String(input.lines), "-o", "cat"])
      return this.validatedRun("ssh", ["-F", path.join(scope.cwd, "ssh_config"), input.serverAlias, remote], scope, signal)
    }
    if (call.name === "redis_read") {
      const input = redisSchema.parse(call.arguments)
      const remote = commandText(["redis-cli", "--raw", "-n", String(input.database), input.operation, ...input.arguments])
      return this.validatedRun("ssh", ["-F", path.join(scope.cwd, "ssh_config"), input.serverAlias, remote], scope, signal)
    }
    throw new Error("未知只读工具")
  }

  private async search(value: unknown, scope: AgentToolScope, signal?: AbortSignal): Promise<AgentToolResult> {
    const input = searchSchema.parse(value)
    const target = input.path ?? scope.codeRoots[0]
    const safeTarget = target ? await safeRealPath(target, scope.codeRoots, scope.cwd) : null
    if (!safeTarget) throw new Error("代码搜索路径超出当前快照")
    const observation = await run("rg", ["-n", "--no-heading", "--color=never", "--", input.query, safeTarget], scope.cwd, 15_000, signal)
    const lines = observation.output.split(/\r?\n/u).slice(0, input.limit).join("\n")
    return { content: this.redact(lines), observation: { ...observation, output: lines } }
  }

  private async read(value: unknown, scope: AgentToolScope): Promise<AgentToolResult> {
    const input = readSchema.parse(value)
    const absolute = await safeRealPath(input.path, scope.codeRoots, scope.cwd)
    if (!absolute) throw new Error("代码读取路径超出当前快照")
    const metadata = await stat(absolute)
    if (!metadata.isFile() || metadata.size > 2_000_000) throw new Error("代码文件无法安全读取")
    const contents = await readFile(absolute, "utf8")
    const selected = contents.split(/\r?\n/u).slice(input.startLine - 1, input.startLine - 1 + input.lineCount)
      .map((line, index) => `${input.startLine + index}: ${line}`).join("\n")
    const output = this.redact(selected.slice(0, 32_000))
    const endLine = input.startLine + input.lineCount - 1
    return { content: output, observation: { command: commandText(["sed", "-n", `${input.startLine},${endLine}p`, absolute]), output, exitCode: 0 } }
  }

  private async git(value: unknown, scope: AgentToolScope, signal?: AbortSignal): Promise<AgentToolResult> {
    const input = gitSchema.parse(value)
    const repository = await safeRealPath(input.repository, scope.codeRoots, scope.cwd)
    if (!repository) throw new Error("Git 路径超出当前快照")
    const args = ["-C", repository, input.operation]
    if (input.operation === "log") args.push("--oneline", "--no-decorate", "--max-count=100")
    if (input.operation === "show") args.push("--no-ext-diff", "--no-textconv", input.revision ?? "HEAD")
    if (input.operation === "diff") args.push("--no-ext-diff", "--no-textconv", ...(input.revision ? [input.revision] : []))
    if (input.path) args.push("--", input.path)
    const observation = await run("git", args, scope.cwd, 20_000, signal)
    const output = this.redact(observation.output)
    return { content: output, observation: { ...observation, output } }
  }

  private async validatedRun(
    executable: string,
    args: string[],
    scope: AgentToolScope,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<AgentToolResult> {
    const command = commandText([executable, ...args])
    const validation = validateTrustedCommandObservation({ command, output: "", exitCode: null }, {
      workspacePath: scope.cwd,
      codeRoots: scope.codeRoots,
    })
    if (!validation) throw new Error("只读工具命令不被允许")
    const observation = await run(executable, args, scope.cwd, timeoutMs, signal)
    const output = this.redact(observation.output)
    return { content: output, observation: { ...observation, output } }
  }
}
