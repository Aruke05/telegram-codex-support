import type {
  CodexCommandRunner,
  CodexRunnerResult,
  CodexStatus,
} from "../codex/executor.js"
import type { ModelInstanceSnapshot } from "../runtime/model-config-service.js"
import { ModelExecutionError } from "./errors.js"
import type { AdapterExecutionInput, AdapterExecutionResult, ModelAdapter } from "./types.js"

function resultOutput(value: string | CodexRunnerResult): { output: string; observations: CodexRunnerResult["observations"] } {
  return typeof value === "string" ? { output: value, observations: [] } : value
}

export class CodexCliAdapter implements ModelAdapter {
  constructor(private readonly runner: CodexCommandRunner) {}

  status(): Promise<CodexStatus> {
    return this.runner.status()
  }

  shutdown(): Promise<void> {
    return this.runner.shutdown?.() ?? Promise.resolve()
  }

  async execute<T>(model: ModelInstanceSnapshot, input: AdapterExecutionInput<T>): Promise<AdapterExecutionResult<T>> {
    const invoked = resultOutput(await this.runner.invoke({
      cwd: input.toolScope.cwd,
      model: model.modelId,
      reasoningEffort: model.reasoningEffort ?? "minimal",
      serviceTier: model.serviceTier,
      timeoutMs: input.timeoutMs,
      prompt: input.prompt,
      outputSchema: input.outputSchema,
      accessMode: input.accessMode ?? "read-only",
      ...(input.images?.length ? { imagePaths: input.images.map((image) => image.path) } : {}),
      readableRoots: input.toolScope.codeRoots,
      ...(input.signal ? { signal: input.signal } : {}),
    }))
    if (invoked.observations.length > 0) await input.onCommandObservations?.(invoked.observations)
    let parsed: unknown
    try { parsed = JSON.parse(invoked.output) }
    catch { throw new ModelExecutionError("structured_output_invalid", "回答模型返回的 JSON 格式无效") }
    try {
      return { value: input.validator.parse(parsed), toolCallCount: invoked.observations.length }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ZodError") throw error
      const issues = (error as Error & { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues ?? []
      const detail = issues.slice(0, 20).map((issue) => {
        const path = issue.path?.map(String).join(".") || "root"
        return `${path}: ${issue.message || "字段不符合结构要求"}`
      }).join("；")
      throw new ModelExecutionError(
        "structured_output_invalid",
        `回答模型结果未通过结构校验${detail ? `：${detail}` : ""}`.slice(0, 1_500),
      )
    }
  }
}
