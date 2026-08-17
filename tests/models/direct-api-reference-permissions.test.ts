import { randomUUID } from "node:crypto"

import { z } from "zod"
import { describe, expect, it, vi } from "vitest"

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
            arguments: JSON.stringify(argumentsValue),
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
                  function: { name, arguments: JSON.stringify(argumentsValue) },
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

function executionInput(accessMode?: "reference-classifier" | "diagnostic") {
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

describe("Direct API reference classifier permissions", () => {
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
