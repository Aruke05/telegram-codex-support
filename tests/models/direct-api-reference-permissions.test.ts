import { randomUUID } from "node:crypto"

import { z } from "zod"
import { describe, expect, it, vi } from "vitest"

import { ReadonlyAgentToolBroker } from "../../src/diagnostics/readonly-agent-tool-broker.js"
import { DirectApiAdapter } from "../../src/models/direct-api/direct-api-adapter.js"
import type { AgentToolBroker, AgentToolDefinition } from "../../src/models/types.js"
import type { ModelInstanceSnapshot } from "../../src/runtime/model-config-service.js"

const timestamp = "2026-08-12T00:00:00.000Z"
const productionDiagnosticTools: AgentToolDefinition[] = [
  { name: "search_code", description: "search", inputSchema: { type: "object" } },
  { name: "read_code", description: "read", inputSchema: { type: "object" } },
  { name: "read_git", description: "git", inputSchema: { type: "object" } },
  { name: "server_check", description: "server", inputSchema: { type: "object" } },
  { name: "read_recent_logs", description: "logs", inputSchema: { type: "object" } },
  { name: "database_query", description: "database", inputSchema: { type: "object" } },
  { name: "redis_read", description: "redis", inputSchema: { type: "object" } },
]
const genericCommandTool: AgentToolDefinition = {
  name: "run_readonly_command", description: "generic", inputSchema: { type: "object" },
}

function directModel(provider: ModelInstanceSnapshot["provider"] = "openai"): ModelInstanceSnapshot {
  return {
    id: randomUUID(),
    alias: "direct-test",
    provider,
    transport: "direct_api",
    modelId: "gpt-test",
    reasoningEffort: null,
    serviceTier: null,
    parameters: {},
    enabled: true,
    healthStatus: "ready",
    healthMessage: "",
    lastCheckedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    apiKey: "test-api-key",
  }
}

function providerScript(
  provider: ModelInstanceSnapshot["provider"],
  advertised: string[][],
  requestBodies: string[],
  calledTool = "database_query",
  malformedFirstArguments = false,
) {
  let round = 0
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const rawBody = String(init?.body)
    requestBodies.push(rawBody)
    const body = JSON.parse(rawBody) as { tools: Array<{ name?: string; function?: { name?: string } }> }
    advertised.push(body.tools.map((tool) => tool.name ?? tool.function?.name ?? ""))
    round += 1
    const name = round === 1 ? calledTool : "submit_result"
    const argumentsValue = round === 1 ? { sql: "SELECT 1" } : { ok: true }
    const responseBody = provider === "openai"
      ? {
          id: `response-${round}`,
          output: [{
            type: "function_call",
            call_id: `call-${round}`,
            name,
            arguments: round === 1 && malformedFirstArguments ? "{" : JSON.stringify(argumentsValue),
          }],
        }
      : provider === "anthropic"
        ? {
            content: [{ type: "tool_use", id: `call-${round}`, name, input: argumentsValue }],
          }
        : {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: `call-${round}`,
                  type: "function",
                  function: {
                    name,
                    arguments: round === 1 && malformedFirstArguments ? "{" : JSON.stringify(argumentsValue),
                  },
                }],
              },
            }],
          }
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
}

function executionInput(accessMode?: "reference-classifier" | "diagnostic" | "text-only") {
  return {
    prompt: "classify",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean", const: true } },
    },
    validator: z.object({ ok: z.literal(true) }).strict(),
    timeoutMs: 5_000,
    toolScope: { cwd: process.cwd(), codeRoots: [process.cwd()] },
    ...(accessMode ? { accessMode } : {}),
  }
}

function openAiStrictSchemaIssues(schema: unknown, path = "root"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return []
  const value = schema as Record<string, unknown>
  const issues: string[] = []
  if (value.type === "object") {
    if (value.additionalProperties !== false) issues.push(`${path}.additionalProperties`)
    const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
      ? value.properties as Record<string, unknown>
      : {}
    const required = new Set(Array.isArray(value.required) ? value.required : [])
    for (const [name, property] of Object.entries(properties)) {
      if (!required.has(name)) issues.push(`${path}.${name}.required`)
      issues.push(...openAiStrictSchemaIssues(property, `${path}.${name}`))
    }
  }
  if (value.items) issues.push(...openAiStrictSchemaIssues(value.items, `${path}[]`))
  if (Array.isArray(value.anyOf)) {
    value.anyOf.forEach((item, index) => issues.push(...openAiStrictSchemaIssues(item, `${path}.anyOf[${index}]`)))
  }
  return issues
}

describe("Direct API reference classifier permissions", () => {
  it.each(["openai", "anthropic", "deepseek"] as const)(
    "%s 纯文本回复阶段不开放任何诊断工具",
    async (provider) => {
      const advertised: string[][] = []
      const requestBodies: string[] = []
      const broker: AgentToolBroker = {
        definitions: vi.fn(() => [...productionDiagnosticTools, genericCommandTool]),
        execute: vi.fn(async () => ({ content: "database secret" })),
      }
      const adapter = new DirectApiAdapter(providerScript(provider, advertised, requestBodies), broker)

      await expect(adapter.execute(directModel(provider), executionInput("text-only"))).resolves.toEqual({
        value: { ok: true },
        toolCallCount: 1,
      })
      expect(advertised).toEqual([["submit_result"], ["submit_result"]])
      expect(broker.execute).not.toHaveBeenCalled()
    },
  )

  it.each(["openai", "anthropic", "deepseek"] as const)(
    "%s reference-classifier 只 advertise snapshot tools 且执行层拒绝越权 database call",
    async (provider) => {
      const advertised: string[][] = []
      const requestBodies: string[] = []
      const broker: AgentToolBroker = {
        definitions: vi.fn(() => [...productionDiagnosticTools, genericCommandTool]),
        execute: vi.fn(async () => ({ content: "database secret" })),
      }
      const adapter = new DirectApiAdapter(providerScript(provider, advertised, requestBodies), broker)

      await expect(adapter.execute(directModel(provider), executionInput("reference-classifier"))).resolves.toEqual({
        value: { ok: true },
        toolCallCount: 1,
      })

      expect(advertised).toEqual([
        ["search_code", "read_code", "submit_result"],
        ["search_code", "read_code", "submit_result"],
      ])
      expect(broker.execute).not.toHaveBeenCalled()
      expect(requestBodies.join("\n")).not.toContain("database secret")
    },
  )

  it.each([
    "read_git",
    "server_check",
    "read_recent_logs",
    "database_query",
    "redis_read",
    "run_readonly_command",
  ])("reference-classifier 未 advertise 的 %s 无法直呼 broker", async (calledTool) => {
    const advertised: string[][] = []
    const requestBodies: string[] = []
    const broker: AgentToolBroker = {
      definitions: vi.fn(() => [...productionDiagnosticTools, genericCommandTool]),
      execute: vi.fn(async () => ({ content: "forbidden broker secret" })),
    }
    const adapter = new DirectApiAdapter(providerScript("openai", advertised, requestBodies, calledTool), broker)

    await expect(adapter.execute(directModel(), executionInput("reference-classifier"))).resolves.toEqual({
      value: { ok: true },
      toolCallCount: 1,
    })

    expect(broker.execute).not.toHaveBeenCalled()
    expect(requestBodies.join("\n")).not.toContain("forbidden broker secret")
  })

  it("普通 support agent 继续 advertise 并执行完整只读工具面", async () => {
    const advertised: string[][] = []
    const requestBodies: string[] = []
    const broker: AgentToolBroker = {
      definitions: vi.fn(() => productionDiagnosticTools),
      execute: vi.fn(async () => ({ content: "one row" })),
    }
    const adapter = new DirectApiAdapter(providerScript("openai", advertised, requestBodies), broker)

    await expect(adapter.execute(directModel(), executionInput("diagnostic"))).resolves.toEqual({
      value: { ok: true },
      toolCallCount: 1,
    })

    expect(advertised[0]).toEqual([...productionDiagnosticTools.map((tool) => tool.name), "submit_result"])
    expect(broker.execute).toHaveBeenCalledOnce()
    expect(broker.execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "database_query" }),
      expect.objectContaining({ codeRoots: [process.cwd()] }),
      expect.any(AbortSignal),
    )
  })

  it("OpenAI 仅对最终提交启用 strict 且诊断参数仍由本地 broker 拒绝", async () => {
    const requests: Array<Record<string, unknown>> = []
    let round = 0
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const tools = body.tools as Array<{
        name: string
        strict: boolean
        parameters: Record<string, unknown>
      }>
      const strictIssues = tools.flatMap((tool) => (
        tool.strict ? openAiStrictSchemaIssues(tool.parameters, tool.name) : []
      ))
      if (strictIssues.length > 0) {
        return new Response(JSON.stringify({ error: strictIssues }), { status: 400 })
      }
      round += 1
      const output = round === 1
        ? [{
            type: "function_call",
            call_id: "call-search",
            name: "search_code",
            arguments: JSON.stringify({ query: 42 }),
          }]
        : [{
            type: "function_call",
            call_id: "call-final",
            name: "submit_result",
            arguments: JSON.stringify({ ok: true }),
          }]
      return new Response(JSON.stringify({ id: `response-${round}`, output }), { status: 200 })
    })
    const adapter = new DirectApiAdapter(fetcher, new ReadonlyAgentToolBroker())

    await expect(adapter.execute(directModel(), executionInput("diagnostic"))).resolves.toEqual({
      value: { ok: true },
      toolCallCount: 1,
    })

    const advertised = requests[0]!.tools as Array<{ name: string; strict: boolean }>
    expect(advertised.find((tool) => tool.name === "submit_result")?.strict).toBe(true)
    expect(advertised.filter((tool) => tool.name !== "submit_result").every((tool) => tool.strict === false)).toBe(true)
    expect(JSON.stringify(requests[1]?.input)).toContain("工具调用失败或不被允许")
  })

  it("OpenAI non-strict 诊断工具返回无效 JSON 时回送失败并允许模型自纠", async () => {
    const requests: Array<Record<string, unknown>> = []
    let round = 0
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      round += 1
      const output = round === 1
        ? [{
            type: "function_call",
            call_id: "call-malformed-search",
            name: "search_code",
            arguments: "{",
          }]
        : [{
            type: "function_call",
            call_id: "call-final",
            name: "submit_result",
            arguments: JSON.stringify({ ok: true }),
          }]
      return new Response(JSON.stringify({ id: `response-${round}`, output }), { status: 200 })
    })
    const broker: AgentToolBroker = {
      definitions: vi.fn(() => productionDiagnosticTools),
      execute: vi.fn(async () => ({ content: "不应执行" })),
    }
    const adapter = new DirectApiAdapter(fetcher, broker)

    await expect(adapter.execute(directModel(), executionInput("diagnostic"))).resolves.toEqual({
      value: { ok: true },
      toolCallCount: 0,
    })

    expect(requests).toHaveLength(2)
    expect(broker.execute).not.toHaveBeenCalled()
    expect(JSON.stringify(requests[1]?.input)).toContain("工具调用失败或不被允许")
  })

  it("chat-compatible 诊断工具返回无效 JSON 时同样不会执行 broker", async () => {
    const advertised: string[][] = []
    const requestBodies: string[] = []
    const broker: AgentToolBroker = {
      definitions: vi.fn(() => productionDiagnosticTools),
      execute: vi.fn(async () => ({ content: "不应执行" })),
    }
    const adapter = new DirectApiAdapter(
      providerScript("deepseek", advertised, requestBodies, "search_code", true),
      broker,
    )

    await expect(adapter.execute(directModel("deepseek"), executionInput("diagnostic"))).resolves.toEqual({
      value: { ok: true },
      toolCallCount: 0,
    })

    expect(requestBodies).toHaveLength(2)
    expect(broker.execute).not.toHaveBeenCalled()
    expect(requestBodies[1]).toContain("工具调用失败或不被允许")
  })

  it.each([
    ["openai", "missing"],
    ["openai", "object"],
    ["openai", "array"],
    ["deepseek", "missing"],
    ["deepseek", "object"],
    ["deepseek", "array"],
  ] as const)("%s 诊断工具的 %s 参数不会进入 broker", async (provider, argumentKind) => {
    let round = 0
    const fetcher = vi.fn(async (_input: string | URL | Request) => {
      round += 1
      const firstArguments = argumentKind === "object"
        ? { query: "unsafe" }
        : argumentKind === "array"
          ? "[]"
          : undefined
      const functionCall = {
        name: round === 1 ? "search_code" : "submit_result",
        ...(round === 1
          ? argumentKind === "missing" ? {} : { arguments: firstArguments }
          : { arguments: JSON.stringify({ ok: true }) }),
      }
      const responseBody = provider === "openai"
        ? {
            id: `response-${round}`,
            output: [{
              type: "function_call",
              call_id: `call-${round}`,
              ...functionCall,
            }],
          }
        : {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: `call-${round}`,
                  type: "function",
                  function: functionCall,
                }],
              },
            }],
          }
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const broker: AgentToolBroker = {
      definitions: vi.fn(() => productionDiagnosticTools),
      execute: vi.fn(async () => ({ content: "不应执行" })),
    }
    const adapter = new DirectApiAdapter(fetcher, broker)

    await expect(adapter.execute(directModel(provider), executionInput("diagnostic"))).resolves.toEqual({
      value: { ok: true },
      toolCallCount: 0,
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(broker.execute).not.toHaveBeenCalled()
  })

  it("连接检测只 advertise submit_result 且拒绝厂商幻觉的 broker 工具", async () => {
    const advertised: string[][] = []
    const requestBodies: string[] = []
    const broker: AgentToolBroker = {
      definitions: vi.fn(() => productionDiagnosticTools),
      execute: vi.fn(async () => ({ content: "check broker secret" })),
    }
    const adapter = new DirectApiAdapter(providerScript("openai", advertised, requestBodies), broker)

    await expect(adapter.check(directModel(), 5_000)).resolves.toBeUndefined()

    expect(advertised).toEqual([["submit_result"], ["submit_result"]])
    expect(broker.execute).not.toHaveBeenCalled()
    expect(requestBodies.join("\n")).not.toContain("check broker secret")
  })
})
