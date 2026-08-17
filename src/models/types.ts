import type { z } from "zod"

import type { CodexAccessMode, CodexCommandObservation } from "../codex/executor.js"
import type { ModelInstanceSnapshot } from "../runtime/model-config-service.js"

export type AgentToolScope = {
  cwd: string
  codeRoots: string[]
}

export type AgentToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type AgentToolCall = {
  id: string
  name: string
  arguments: unknown
}

export type AgentToolResult = {
  content: string
  observation?: CodexCommandObservation
}

export type ModelImageInput = {
  path: string
  mimeType: string
  name: string
}

export type AgentToolBroker = {
  definitions(scope: AgentToolScope): AgentToolDefinition[]
  execute(call: AgentToolCall, scope: AgentToolScope, signal?: AbortSignal): Promise<AgentToolResult>
}

export type AdapterExecutionInput<T> = {
  prompt: string
  images?: ModelImageInput[]
  outputSchema: Record<string, unknown>
  validator: z.ZodType<T>
  timeoutMs: number
  toolScope: AgentToolScope
  accessMode?: CodexAccessMode
  signal?: AbortSignal
  onCommandObservations?: (observations: CodexCommandObservation[]) => void | Promise<void>
}

export type ModelAdapter = {
  execute<T>(model: ModelInstanceSnapshot, input: AdapterExecutionInput<T>): Promise<AdapterExecutionResult<T>>
}

export type AdapterExecutionResult<T> = {
  value: T
  toolCallCount: number
}
