import { readFile } from "node:fs/promises"

import type { ModelInstanceSnapshot } from "../../runtime/model-config-service.js"
import { ModelExecutionError, providerHttpError } from "../errors.js"
import type {
  AdapterExecutionInput,
  AdapterExecutionResult,
  AgentToolBroker,
  AgentToolCall,
  AgentToolDefinition,
} from "../types.js"

type JsonRecord = Record<string, unknown>
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type PreparedImage = { dataUrl: string; mimeType: string }

const endpoints = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
  deepseek: "https://api.deepseek.com/chat/completions",
  glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
} as const

const referenceClassifierTools = new Set(["search_code", "read_code"])

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { throw new ModelExecutionError("structured_output_invalid", "模型工具参数格式错误") }
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value
  return array(value).flatMap((item) => {
    const part = record(item)
    if (!part) return []
    if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") return [part.text]
    return []
  }).join("\n")
}

function finalTool(definition: Record<string, unknown>): AgentToolDefinition {
  return { name: "submit_result", description: "提交最终结构化结果。完成排查后必须调用。", inputSchema: definition }
}

function openAiTool(tool: AgentToolDefinition): JsonRecord {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true }
}

function chatTool(tool: AgentToolDefinition): JsonRecord {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
}

function anthropicTool(tool: AgentToolDefinition): JsonRecord {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
}

function normalizedEffort(effort: ModelInstanceSnapshot["reasoningEffort"]): "low" | "medium" | "high" | "xhigh" | "max" | null {
  if (!effort || effort === "none") return null
  if (effort === "minimal") return "low"
  if (effort === "ultra") return "max"
  return effort
}

function adaptiveClaude(modelId: string): boolean {
  return /^claude-(?:fable-5|mythos(?:-5|-preview)|(?:opus|sonnet)-5|opus-4-[678]|sonnet-4-6)(?:-|$)/u.test(modelId)
}

function chatAssistantMessage(message: JsonRecord): JsonRecord {
  return {
    role: "assistant",
    content: message.content ?? null,
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  }
}

export class DirectApiAdapter {
  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly tools: AgentToolBroker,
  ) {}

  async execute<T>(model: ModelInstanceSnapshot, input: AdapterExecutionInput<T>): Promise<AdapterExecutionResult<T>> {
    this.assertExecutable(model)
    return this.executeWithinDeadline(model, input, true)
  }

  async check(model: ModelInstanceSnapshot, timeoutMs = 15_000): Promise<void> {
    this.assertExecutable(model)
    const validator = { parse: (value: unknown) => value } as AdapterExecutionInput<unknown>["validator"]
    await this.executeWithinDeadline(model, {
      prompt: "只调用 submit_result 返回 {\"ok\":true}",
      outputSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean", const: true } } },
      validator,
      timeoutMs,
      toolScope: { cwd: process.cwd(), codeRoots: [] },
    }, false)
  }

  private assertExecutable(model: ModelInstanceSnapshot): void {
    if (!model.apiKey) throw new ModelExecutionError("credentials_missing", "模型 API 密钥未配置")
    if (model.transport !== "direct_api") throw new ModelExecutionError("parameter_unsupported", "模型接入方式不支持 API 调用")
  }

  private async executeWithinDeadline<T>(
    model: ModelInstanceSnapshot,
    input: AdapterExecutionInput<T>,
    includeDiagnosticTools: boolean,
  ): Promise<AdapterExecutionResult<T>> {
    const controller = new AbortController()
    let deadlineExpired = false
    const timeout = setTimeout(() => {
      deadlineExpired = true
      controller.abort()
    }, input.timeoutMs)
    timeout.unref()
    const abort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener("abort", abort, { once: true })
    const boundedInput = { ...input, signal: controller.signal }
    try {
      if (input.signal?.aborted) throw new Error("模型执行已取消")
      if (model.provider === "openai") return await this.executeOpenAi(model, boundedInput, includeDiagnosticTools)
      if (model.provider === "anthropic") return await this.executeAnthropic(model, boundedInput, includeDiagnosticTools)
      return await this.executeChatCompatible(model, boundedInput, includeDiagnosticTools)
    } catch (error) {
      if (deadlineExpired) throw new ModelExecutionError("provider_timeout", "模型厂商请求超时")
      if (input.signal?.aborted) throw new Error("模型执行已取消")
      throw error
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
    }
  }

  private async executeOpenAi<T>(model: ModelInstanceSnapshot, input: AdapterExecutionInput<T>, includeDiagnosticTools: boolean): Promise<AdapterExecutionResult<T>> {
    const brokerTools = this.availableTools(input, includeDiagnosticTools)
    const definitions = [...brokerTools, finalTool(input.outputSchema)]
    const executableTools = new Set(brokerTools.map((tool) => tool.name))
    let previousResponseId: string | null = null
    const images = await this.prepareImages(input)
    let nextInput: unknown = images.length > 0
      ? [{
          role: "user",
          content: [
            { type: "input_text", text: input.prompt },
            ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl })),
          ],
        }]
      : input.prompt
    let toolCallCount = 0
    let validationFailures = 0
    for (let round = 0; round < 24; round += 1) {
      const body: JsonRecord = {
        model: model.modelId,
        input: nextInput,
        tools: definitions.map(openAiTool),
        tool_choice: "auto",
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...this.openAiParameters(model),
      }
      const response = await this.request(model, body, input)
      previousResponseId = typeof response.id === "string" ? response.id : previousResponseId
      const calls = array(response.output).flatMap((item, index) => {
        const part = record(item)
        if (part?.type !== "function_call" || typeof part.name !== "string") return []
        return [{ id: typeof part.call_id === "string" ? part.call_id : `call-${round}-${index}`, name: part.name, arguments: parseArguments(part.arguments) }]
      })
      const submitted = calls.find((call) => call.name === "submit_result")
      if (submitted) {
        const parsed = this.tryValidateValue(submitted.arguments, input)
        if (parsed.ok) return { value: parsed.value, toolCallCount }
        validationFailures += 1
        if (validationFailures >= 3) throw new ModelExecutionError("structured_output_invalid", "模型最终结果不符合 Schema")
        nextInput = calls.map((call) => ({
          type: "function_call_output",
          call_id: call.id,
          output: call.id === submitted.id ? `提交无效 请按原 Schema 重交 ${parsed.error}` : "本轮最终提交无效 该工具未执行",
        }))
        continue
      }
      if (calls.length > 0) {
        const outputs = []
        for (const call of calls) {
          const result = await this.executeTool(call, input, executableTools)
          toolCallCount += 1
          outputs.push({ type: "function_call_output", call_id: call.id, output: result })
        }
        nextInput = outputs
        continue
      }
      const text = array(response.output).flatMap((item) => outputText(record(item)?.content)).join("\n") || outputText(response.output_text)
      const parsed = this.tryValidateText(text, input)
      if (parsed.ok) return { value: parsed.value, toolCallCount }
      validationFailures += 1
      if (validationFailures >= 3) throw new ModelExecutionError("structured_output_invalid", "模型未返回有效结构化结果")
      nextInput = `上一次输出不符合 JSON Schema。不要解释，调用 submit_result 重新提交。错误：${parsed.error}`
    }
    throw new ModelExecutionError("tool_loop_exhausted", "模型工具调用轮数已达上限")
  }

  private async executeAnthropic<T>(model: ModelInstanceSnapshot, input: AdapterExecutionInput<T>, includeDiagnosticTools: boolean): Promise<AdapterExecutionResult<T>> {
    const brokerTools = this.availableTools(input, includeDiagnosticTools)
    const definitions = [...brokerTools, finalTool(input.outputSchema)]
    const executableTools = new Set(brokerTools.map((tool) => tool.name))
    const images = await this.prepareImages(input)
    const messages: JsonRecord[] = [{
      role: "user",
      content: images.length > 0
        ? [
            { type: "text", text: input.prompt },
            ...images.map((image) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: image.mimeType,
                data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
              },
            })),
          ]
        : input.prompt,
    }]
    let toolCallCount = 0
    let validationFailures = 0
    for (let round = 0; round < 24; round += 1) {
      const response = await this.request(model, {
        model: model.modelId,
        max_tokens: Number(model.parameters.maxOutputTokens ?? 8192),
        messages,
        tools: definitions.map(anthropicTool),
        tool_choice: { type: "auto" },
        ...this.anthropicParameters(model),
      }, input)
      const content = array(response.content)
      const calls = content.flatMap((item, index) => {
        const part = record(item)
        if (part?.type !== "tool_use" || typeof part.name !== "string") return []
        return [{ id: typeof part.id === "string" ? part.id : `call-${round}-${index}`, name: part.name, arguments: part.input }]
      })
      const submitted = calls.find((call) => call.name === "submit_result")
      if (submitted) {
        const parsed = this.tryValidateValue(submitted.arguments, input)
        if (parsed.ok) return { value: parsed.value, toolCallCount }
        validationFailures += 1
        if (validationFailures >= 3) throw new ModelExecutionError("structured_output_invalid", "模型最终结果不符合 Schema")
        messages.push({ role: "assistant", content }, { role: "user", content: calls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: call.id === submitted.id ? `提交无效 请按原 Schema 重交 ${parsed.error}` : "本轮最终提交无效 该工具未执行",
        })) })
        continue
      }
      if (calls.length > 0) {
        messages.push({ role: "assistant", content })
        const results = []
        for (const call of calls) {
          const result = await this.executeTool(call, input, executableTools)
          toolCallCount += 1
          results.push({ type: "tool_result", tool_use_id: call.id, content: result })
        }
        messages.push({ role: "user", content: results })
        continue
      }
      const parsed = this.tryValidateText(outputText(content), input)
      if (parsed.ok) return { value: parsed.value, toolCallCount }
      validationFailures += 1
      if (validationFailures >= 3) throw new ModelExecutionError("structured_output_invalid", "模型未返回有效结构化结果")
      messages.push({ role: "assistant", content }, { role: "user", content: `输出不符合 Schema。调用 submit_result 重交：${parsed.error}` })
    }
    throw new ModelExecutionError("tool_loop_exhausted", "模型工具调用轮数已达上限")
  }

  private async executeChatCompatible<T>(model: ModelInstanceSnapshot, input: AdapterExecutionInput<T>, includeDiagnosticTools: boolean): Promise<AdapterExecutionResult<T>> {
    const brokerTools = this.availableTools(input, includeDiagnosticTools)
    const definitions = [...brokerTools, finalTool(input.outputSchema)]
    const executableTools = new Set(brokerTools.map((tool) => tool.name))
    const images = await this.prepareImages(input)
    const messages: JsonRecord[] = [{
      role: "user",
      content: images.length > 0
        ? [
            { type: "text", text: input.prompt },
            ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
          ]
        : input.prompt,
    }]
    let toolCallCount = 0
    let validationFailures = 0
    for (let round = 0; round < 24; round += 1) {
      const response = await this.request(model, {
        model: model.modelId,
        messages,
        tools: definitions.map(chatTool),
        tool_choice: "auto",
        ...this.chatParameters(model),
      }, input)
      const message = record(record(array(response.choices)[0])?.message) ?? {}
      const calls = array(message.tool_calls).flatMap((item, index) => {
        const call = record(item)
        const fn = record(call?.function)
        if (!fn || typeof fn.name !== "string") return []
        return [{ id: typeof call?.id === "string" ? call.id : `call-${round}-${index}`, name: fn.name, arguments: parseArguments(fn.arguments) }]
      })
      const submitted = calls.find((call) => call.name === "submit_result")
      if (submitted) {
        const parsed = this.tryValidateValue(submitted.arguments, input)
        if (parsed.ok) return { value: parsed.value, toolCallCount }
        validationFailures += 1
        if (validationFailures >= 3) throw new ModelExecutionError("structured_output_invalid", "模型最终结果不符合 Schema")
        messages.push(chatAssistantMessage(message), ...calls.map((call) => ({
          role: "tool",
          tool_call_id: call.id,
          content: call.id === submitted.id ? `提交无效 请按原 Schema 重交 ${parsed.error}` : "本轮最终提交无效 该工具未执行",
        })))
        continue
      }
      if (calls.length > 0) {
        messages.push(chatAssistantMessage(message))
        for (const call of calls) {
          const result = await this.executeTool(call, input, executableTools)
          toolCallCount += 1
          messages.push({ role: "tool", tool_call_id: call.id, content: result })
        }
        continue
      }
      const parsed = this.tryValidateText(outputText(message.content), input)
      if (parsed.ok) return { value: parsed.value, toolCallCount }
      validationFailures += 1
      if (validationFailures >= 3) throw new ModelExecutionError("structured_output_invalid", "模型未返回有效结构化结果")
      messages.push(chatAssistantMessage(message), { role: "user", content: `输出不符合 Schema。调用 submit_result 重交：${parsed.error}` })
    }
    throw new ModelExecutionError("tool_loop_exhausted", "模型工具调用轮数已达上限")
  }

  private async request<T>(model: ModelInstanceSnapshot, body: JsonRecord, input: AdapterExecutionInput<T>): Promise<JsonRecord> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
    timeout.unref()
    const abort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener("abort", abort, { once: true })
    try {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (model.provider === "anthropic") {
        headers["x-api-key"] = model.apiKey!
        headers["anthropic-version"] = "2023-06-01"
      } else headers.authorization = `Bearer ${model.apiKey}`
      const response = await this.fetcher(endpoints[model.provider], { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal })
      if (!response.ok) throw providerHttpError(response.status)
      const raw = await response.text()
      if (Buffer.byteLength(raw, "utf8") > 512_000) throw new ModelExecutionError("provider_unavailable", "模型厂商响应过大")
      const parsed = record(JSON.parse(raw) as unknown)
      if (!parsed) throw new ModelExecutionError("provider_unavailable", "模型厂商响应格式错误")
      return parsed
    } catch (error) {
      if (error instanceof ModelExecutionError) throw error
      if (controller.signal.aborted) throw new ModelExecutionError("provider_timeout", "模型厂商请求超时")
      throw new ModelExecutionError("provider_unavailable", "模型厂商请求失败")
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
    }
  }

  private async executeTool<T>(
    call: AgentToolCall,
    input: AdapterExecutionInput<T>,
    executableTools: ReadonlySet<string>,
  ): Promise<string> {
    let result: Awaited<ReturnType<AgentToolBroker["execute"]>>
    try {
      if (!executableTools.has(call.name)) throw new Error("模型工具未在本轮授权")
      result = await this.tools.execute(call, input.toolScope, input.signal)
    } catch (error) {
      if (input.signal?.aborted) throw error
      return "工具调用失败或不被允许 请检查参数并改用当前服务范围内的只读工具"
    }
    if (result.observation) await input.onCommandObservations?.([result.observation])
    return result.content.slice(0, 32_000)
  }

  private availableTools<T>(input: AdapterExecutionInput<T>, includeDiagnosticTools: boolean): AgentToolDefinition[] {
    if (!includeDiagnosticTools) return []
    return this.tools.definitions(input.toolScope).filter((tool) => this.isToolAllowed(tool.name, input))
  }

  private isToolAllowed<T>(name: string, input: AdapterExecutionInput<T>): boolean {
    return input.accessMode !== "reference-classifier" || referenceClassifierTools.has(name)
  }

  private async prepareImages<T>(input: AdapterExecutionInput<T>): Promise<PreparedImage[]> {
    const prepared: PreparedImage[] = []
    let totalBytes = 0
    for (const image of input.images ?? []) {
      const mimeType = image.mimeType.toLocaleLowerCase("en-US") === "image/jpg"
        ? "image/jpeg"
        : image.mimeType.toLocaleLowerCase("en-US")
      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)) {
        throw new ModelExecutionError("parameter_unsupported", "图片格式不受当前模型输入链路支持")
      }
      let bytes: Buffer
      try { bytes = await readFile(image.path) }
      catch { throw new ModelExecutionError("provider_unavailable", "图片附件无法读取") }
      totalBytes += bytes.byteLength
      if (bytes.byteLength > 20 * 1024 * 1024 || totalBytes > 40 * 1024 * 1024) {
        throw new ModelExecutionError("parameter_unsupported", "图片附件大小超过模型输入限制")
      }
      prepared.push({ mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` })
    }
    return prepared
  }

  private tryValidateText<T>(text: string, input: AdapterExecutionInput<T>): { ok: true; value: T } | { ok: false; error: string } {
    try { return { ok: true, value: input.validator.parse(JSON.parse(text)) } }
    catch { return { ok: false, error: "必须提交符合 Schema 的 JSON" } }
  }

  private tryValidateValue<T>(value: unknown, input: AdapterExecutionInput<T>): { ok: true; value: T } | { ok: false; error: string } {
    try { return { ok: true, value: input.validator.parse(value) } }
    catch { return { ok: false, error: "字段缺失或类型不正确" } }
  }

  private openAiParameters(model: ModelInstanceSnapshot): JsonRecord {
    return {
      ...(model.reasoningEffort && model.reasoningEffort !== "none" ? { reasoning: { effort: model.reasoningEffort } } : {}),
      ...(model.serviceTier === "priority" ? { service_tier: "priority" } : {}),
      ...(model.parameters.maxOutputTokens ? { max_output_tokens: model.parameters.maxOutputTokens } : {}),
      ...(model.parameters.temperature !== undefined ? { temperature: model.parameters.temperature } : {}),
      ...(model.parameters.verbosity ? { text: { verbosity: model.parameters.verbosity } } : {}),
    }
  }

  private anthropicParameters(model: ModelInstanceSnapshot): JsonRecord {
    const effort = normalizedEffort(model.reasoningEffort)
    const adaptive = adaptiveClaude(model.modelId)
    const maximum = Number(model.parameters.maxOutputTokens ?? 8192)
    if (effort && !adaptive && maximum <= 1024) {
      throw new ModelExecutionError("parameter_unsupported", "Claude 推理模式的最大输出 Token 必须大于 1024")
    }
    const thinking = model.reasoningEffort === "none"
      ? { type: "disabled" }
      : effort && adaptive
        ? { type: "adaptive" }
        : effort
          ? { type: "enabled", budget_tokens: Math.max(1024, Math.min(32_000, Math.floor(maximum / 2))) }
          : null
    return {
      ...(model.parameters.temperature !== undefined && !thinking && !adaptive ? { temperature: model.parameters.temperature } : {}),
      ...(model.parameters.topP !== undefined ? { top_p: model.parameters.topP } : {}),
      ...(thinking ? { thinking } : {}),
      ...(effort && adaptive ? { output_config: { effort } } : {}),
    }
  }

  private chatParameters(model: ModelInstanceSnapshot): JsonRecord {
    const effort = normalizedEffort(model.reasoningEffort)
    const configuredThinking = typeof model.parameters.thinking === "boolean" ? model.parameters.thinking : null
    const thinkingEnabled = configuredThinking ?? (model.reasoningEffort ? model.reasoningEffort !== "none" : null)
    const thinking = thinkingEnabled === null ? null : { type: thinkingEnabled ? "enabled" : "disabled" }
    const providerThinking = model.provider === "glm" && thinkingEnabled ? { ...thinking, clear_thinking: false } : thinking
    const deepSeekEffort = effort === "medium" ? "high" : effort
    return {
      ...(model.parameters.maxOutputTokens ? { max_tokens: model.parameters.maxOutputTokens } : {}),
      ...(model.parameters.temperature !== undefined && !(model.provider === "deepseek" && thinkingEnabled) ? { temperature: model.parameters.temperature } : {}),
      ...(model.parameters.topP !== undefined && !(model.provider === "deepseek" && thinkingEnabled) ? { top_p: model.parameters.topP } : {}),
      ...(providerThinking ? { thinking: providerThinking } : {}),
      ...(model.provider === "deepseek" && thinkingEnabled !== false && deepSeekEffort ? { reasoning_effort: deepSeekEffort } : {}),
    }
  }
}
