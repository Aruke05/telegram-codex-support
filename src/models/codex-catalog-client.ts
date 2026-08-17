import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import readline from "node:readline"

import { z } from "zod"

import { reasoningEffortSchema } from "../runtime/types.js"
import { APP_VERSION } from "../version.js"

const codexReasoningEffortSchema = z.object({
  reasoningEffort: reasoningEffortSchema,
  description: z.string().default(""),
}).passthrough()

const codexModelSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1),
  hidden: z.boolean().default(false),
  defaultReasoningEffort: reasoningEffortSchema.nullable().optional().default(null),
  supportedReasoningEfforts: z.array(codexReasoningEffortSchema).default([]),
  inputModalities: z.array(z.enum(["text", "image"])).optional().default(["text", "image"]),
  supportsPersonality: z.boolean().optional().default(false),
  isDefault: z.boolean().optional().default(false),
  upgrade: z.union([z.string(), z.object({ model: z.string().optional(), id: z.string().optional() }).passthrough()]).nullable().optional(),
}).passthrough()

const modelListResultSchema = z.object({
  data: z.array(codexModelSchema),
  nextCursor: z.string().nullable().optional().default(null),
}).passthrough()

export type CodexCatalogModel = z.infer<typeof codexModelSchema>

export type CodexCatalogClientOptions = {
  command?: string
  args?: string[]
  timeoutMs?: number
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: { message?: string }
}

export class CodexCatalogClient {
  private readonly command: string
  private readonly args: string[]
  private readonly timeoutMs: number

  constructor(options: CodexCatalogClientOptions = {}) {
    this.command = options.command ?? "codex"
    this.args = options.args ?? ["app-server"]
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async listAll(): Promise<CodexCatalogModel[]> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      detached: process.platform !== "win32",
    })
    return await this.readCatalog(child)
  }

  private async readCatalog(child: ChildProcessWithoutNullStreams): Promise<CodexCatalogModel[]> {
    let nextId = 1
    let stderr = ""
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    const lines = readline.createInterface({ input: child.stdout })
    const terminate = () => {
      lines.close()
      if (child.exitCode !== null || child.pid === undefined) return
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { /* 进程可能已经退出。 */ }
    }
    const failPending = (error: Error) => {
      pending.forEach(({ reject }) => reject(error))
      pending.clear()
    }
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000) })
    child.on("error", (error) => failPending(error))
    child.on("exit", (code) => {
      if (pending.size > 0) failPending(new Error(`Codex App Server 已退出 (${code ?? "unknown"}) ${stderr}`.trim()))
    })
    lines.on("line", (line) => {
      let message: JsonRpcResponse
      try { message = JSON.parse(line) as JsonRpcResponse } catch { return }
      if (typeof message.id !== "number") return
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message ?? "Codex App Server 请求失败"))
      else request.resolve(message.result)
    })
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ method, id, params })
      })
    }
    const operation = (async () => {
      await request("initialize", {
        clientInfo: { name: "telegram_codex_support", title: "Telegram Codex AI 客服", version: APP_VERSION },
        capabilities: { optOutNotificationMethods: [] },
      })
      send({ method: "initialized", params: {} })
      const result: CodexCatalogModel[] = []
      let cursor: string | null = null
      do {
        const page = modelListResultSchema.parse(await request("model/list", {
          limit: 100,
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        }))
        result.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      return result
    })()
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex 模型目录刷新超时")), this.timeoutMs)
      timer.unref()
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      terminate()
    }
  }
}
