import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { z } from "zod"
import { afterEach, describe, expect, it } from "vitest"

import { CodexCliAdapter } from "../../src/models/codex-cli-adapter.js"
import { ModelGateway } from "../../src/models/model-gateway.js"
import type { ModelAdapter } from "../../src/models/types.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { ModelConfigService, type ModelInstanceSnapshot } from "../../src/runtime/model-config-service.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("模型任务快照", () => {
  it("Codex 原始 ZodError 转换成可重试的结构输出错误并保留字段路径", async () => {
    const adapter = new CodexCliAdapter({
      invoke: async () => ({ output: JSON.stringify({ answer: 1 }), observations: [] }),
    } as never)

    await expect(adapter.execute({ modelId: "test-model" } as ModelInstanceSnapshot, {
      prompt: "test",
      outputSchema: { type: "object" },
      validator: z.object({ answer: z.string() }),
      timeoutMs: 1_000,
      toolScope: { cwd: process.cwd(), codeRoots: [] },
    })).rejects.toMatchObject({
      name: "ModelExecutionError",
      code: "structured_output_invalid",
      message: expect.stringContaining("answer"),
    })
  })

  it("同一任务多次执行不受模型别名或回答绑定运行中变更影响", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "model-gateway-snapshot-"))
    temporaryDirectories.push(directory)
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    try {
      const config = new ModelConfigService(database)
      const binding = config.getBinding("answer")
      const modelSnapshot = config.getModelInstanceSnapshot(binding.modelInstanceId)
      const seen: Array<{ model: ModelInstanceSnapshot; timeoutMs: number }> = []
      const adapter: ModelAdapter = {
        execute: async (model, input) => {
          seen.push({ model, timeoutMs: input.timeoutMs })
          return { value: input.validator.parse("ok"), toolCallCount: 0 }
        },
      }
      const gateway = new ModelGateway(config, {
        ...adapter,
        status: async () => ({ available: true, authenticated: true, version: "test", message: "ok" }),
        shutdown: async () => undefined,
      }, adapter)
      const execute = () => gateway.execute("answer", {
        cwd: directory,
        modelInstanceId: modelSnapshot.id,
        modelSnapshot,
        bindingSnapshot: {
          enabled: binding.enabled,
          timeoutSeconds: binding.timeoutSeconds,
          maxConcurrency: binding.maxConcurrency,
        },
        prompt: "test",
        outputSchema: { type: "string" },
        validator: z.string(),
      })

      await expect(execute()).resolves.toBe("ok")
      config.updateBinding("answer", { timeoutSeconds: 30, maxConcurrency: 1, enabled: false })
      config.updateModelInstance(modelSnapshot.id, { modelId: "gpt-5.6-sol", enabled: false })
      await expect(execute()).resolves.toBe("ok")

      expect(seen.map((item) => item.model.modelId)).toEqual([modelSnapshot.modelId, modelSnapshot.modelId])
      expect(seen.map((item) => item.model.enabled)).toEqual([true, true])
      expect(seen.map((item) => item.timeoutMs)).toEqual([
        binding.timeoutSeconds * 1000,
        binding.timeoutSeconds * 1000,
      ])
    } finally {
      database.close()
    }
  })

  it("同一回答模型的默认任务共用配置的并发上限", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "model-gateway-concurrency-"))
    temporaryDirectories.push(directory)
    const database = await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
    try {
      const config = new ModelConfigService(database)
      const binding = config.getBinding("answer")
      const modelSnapshot = config.getModelInstanceSnapshot(binding.modelInstanceId)
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      let notifyFirstStarted!: () => void
      const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve })
      let started = 0
      let active = 0
      let maximumActive = 0
      const adapter: ModelAdapter = {
        execute: async (_model, input) => {
          started += 1
          active += 1
          maximumActive = Math.max(maximumActive, active)
          if (started === 1) {
            notifyFirstStarted()
            await firstGate
          }
          active -= 1
          return { value: input.validator.parse("ok"), toolCallCount: 0 }
        },
      }
      const gateway = new ModelGateway(config, {
        ...adapter,
        status: async () => ({ available: true, authenticated: true, version: "test", message: "ok" }),
        shutdown: async () => undefined,
      }, adapter)
      const execute = () => gateway.execute("answer", {
        cwd: directory,
        modelInstanceId: modelSnapshot.id,
        modelSnapshot,
        bindingSnapshot: { enabled: true, timeoutSeconds: 60, maxConcurrency: 1 },
        prompt: "test",
        outputSchema: { type: "string" },
        validator: z.string(),
        maxConcurrency: 1,
      })

      const first = execute()
      await firstStarted
      const second = execute()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(started).toBe(1)
      releaseFirst()
      await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"])
      expect(maximumActive).toBe(1)
    } finally {
      database.close()
    }
  })
})
