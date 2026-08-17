import type {
  CodexCommandRunner,
  CodexRunnerResult,
  CodexStatus,
} from "../codex/executor.js"
import type { ModelInstanceSnapshot } from "../runtime/model-config-service.js"
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
    catch { throw new Error("Codex 返回格式错误") }
    return { value: input.validator.parse(parsed), toolCallCount: invoked.observations.length }
  }
}
