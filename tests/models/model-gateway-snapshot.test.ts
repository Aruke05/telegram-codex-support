import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { z } from "zod"
import { afterEach, describe, expect, it } from "vitest"

import { ModelGateway } from "../../src/models/model-gateway.js"
import type { ModelAdapter } from "../../src/models/types.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"
import { ModelConfigService, type ModelInstanceSnapshot } from "../../src/runtime/model-config-service.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("模型任务快照", () => {
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
})
