import type { CodexStatus } from "../codex/executor.js"
import type { ModelConfigService, ModelInstanceSnapshot } from "../runtime/model-config-service.js"
import type { ModelPurpose } from "../runtime/types.js"
import { ModelExecutionError } from "./errors.js"
import type { AdapterExecutionInput, ModelAdapter } from "./types.js"

export type ModelGatewayExecutionInput<T> = Omit<AdapterExecutionInput<T>, "timeoutMs" | "toolScope"> & {
  cwd: string
  modelInstanceId?: string
  modelSnapshot?: ModelInstanceSnapshot
  bindingSnapshot?: { enabled: boolean; timeoutSeconds: number; maxConcurrency: number }
  codeRoots?: string[]
  executionTimeoutMs?: number
  concurrencyGroup?: string
  maxConcurrency?: number
}

type CodexAdapter = ModelAdapter & {
  status(): Promise<CodexStatus>
  shutdown(): Promise<void>
}

type DirectAdapter = ModelAdapter & {
  check?(model: ReturnType<ModelConfigService["getModelInstanceSnapshot"]>, timeoutMs?: number): Promise<void>
}

export class ModelGateway {
  private readonly running = new Map<string, number>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private readonly activeModels = new Map<string, number>()

  constructor(
    private readonly config: ModelConfigService,
    private readonly codex: CodexAdapter,
    private readonly direct: DirectAdapter,
  ) {
    this.config.setActiveExecutionChecker((id) => (this.activeModels.get(id) ?? 0) > 0)
  }

  status(): Promise<CodexStatus> {
    return this.codex.status()
  }

  shutdown(): Promise<void> {
    return this.codex.shutdown()
  }

  async testConnection(id: string): Promise<void> {
    const model = this.config.getModelInstanceSnapshot(id)
    try {
      if (model.transport === "codex_cli") {
        const status = await this.codex.status()
        if (!status.available || !status.authenticated) throw new Error(status.message)
      } else {
        if (!this.direct.check) throw new Error("API 模型检测不可用")
        await this.direct.check(model)
      }
      this.config.updateModelHealth(id, { status: "ready", message: "连接正常" })
    } catch (error) {
      const failure = error instanceof ModelExecutionError
        ? error
        : new ModelExecutionError("provider_unavailable", "模型连接检测失败")
      this.config.updateModelHealth(id, { status: "error", message: failure.message })
      throw failure
    }
  }

  async execute<T>(purpose: ModelPurpose, input: ModelGatewayExecutionInput<T>): Promise<T> {
    const binding = input.bindingSnapshot ?? this.config.getBinding(purpose)
    if (!binding.enabled) throw new ModelExecutionError("model_disabled", purpose === "answer" ? "回答运行已停用" : "记忆运行已停用")
    const bindingModelInstanceId = "modelInstanceId" in binding && typeof binding.modelInstanceId === "string"
      ? binding.modelInstanceId
      : undefined
    const requestedModelInstanceId = input.modelInstanceId ?? bindingModelInstanceId
    if (!input.modelSnapshot && !requestedModelInstanceId) {
      throw new ModelExecutionError("model_not_found", "模型任务快照缺少模型别名")
    }
    const model = input.modelSnapshot
      ?? this.config.getModelInstanceSnapshot(requestedModelInstanceId!)
    if (input.modelInstanceId && model.id !== input.modelInstanceId) {
      throw new ModelExecutionError("model_not_found", "模型任务快照与模型别名不一致")
    }
    if (!model.enabled) throw new ModelExecutionError("model_disabled", "模型别名已停用")
    if (model.transport === "direct_api" && !model.apiKey) throw new ModelExecutionError("credentials_missing", "模型 API 密钥未配置")
    const group = `${model.id}:${purpose}:${input.concurrencyGroup ?? "default"}`
    const maximum = input.maxConcurrency ?? binding.maxConcurrency
    const timeoutMs = input.executionTimeoutMs ?? binding.timeoutSeconds * 1000
    this.activeModels.set(model.id, (this.activeModels.get(model.id) ?? 0) + 1)
    let acquired = false
    try {
      await this.acquire(group, maximum, input.signal)
      acquired = true
      if (input.signal?.aborted) throw new Error("模型执行已取消")
      const adapter = model.transport === "codex_cli" ? this.codex : this.direct
      const result = await adapter.execute(model, {
        prompt: input.prompt,
        ...(input.images?.length ? { images: input.images } : {}),
        outputSchema: input.outputSchema,
        validator: input.validator,
        timeoutMs,
        toolScope: { cwd: input.cwd, codeRoots: input.codeRoots ?? [] },
        ...(input.accessMode ? { accessMode: input.accessMode } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onCommandObservations ? { onCommandObservations: input.onCommandObservations } : {}),
      })
      return result.value
    } finally {
      this.activeModels.set(model.id, Math.max(0, (this.activeModels.get(model.id) ?? 1) - 1))
      if (acquired) this.release(group)
    }
  }

  private async acquire(group: string, maximum: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("模型执行已取消")
    if ((this.running.get(group) ?? 0) < maximum) {
      this.running.set(group, (this.running.get(group) ?? 0) + 1)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(group) ?? []
      const resume = () => { signal?.removeEventListener("abort", cancel); resolve() }
      const cancel = () => {
        const index = queue.indexOf(resume)
        if (index >= 0) queue.splice(index, 1)
        reject(new Error("模型执行已取消"))
      }
      signal?.addEventListener("abort", cancel, { once: true })
      queue.push(resume)
      this.waiters.set(group, queue)
    })
    this.running.set(group, (this.running.get(group) ?? 0) + 1)
  }

  private release(group: string): void {
    this.running.set(group, Math.max(0, (this.running.get(group) ?? 1) - 1))
    this.waiters.get(group)?.shift()?.()
  }
}
