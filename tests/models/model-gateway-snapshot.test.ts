import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { z } from "zod"
import { afterEach, describe, expect, it } from "vitest"

import { LocalCodexCommandRunner } from "../../src/codex/executor.js"
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

  it.skipIf(process.platform === "win32")(
    "Codex CLI 纯文本审核把显式图片传到最终 CLI 参数且保留严格权限",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "codex-cli-review-image-"))
      temporaryDirectories.push(directory)
      const binaryDirectory = path.join(directory, "bin")
      const executable = path.join(binaryDirectory, "codex")
      const capturedArgsPath = path.join(directory, "captured-args.txt")
      const imagePath = path.join(directory, "review.png")
      await mkdir(binaryDirectory)
      await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACo2l9QAAAABJRU5ErkJggg==", "base64"))
      await writeFile(executable, [
        "#!/usr/bin/env node",
        'const fs = require("node:fs")',
        "const args = process.argv.slice(2)",
        `fs.writeFileSync(${JSON.stringify(capturedArgsPath)}, args.join("\\n"))`,
        'const outputIndex = args.indexOf("--output-last-message")',
        'if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(2)',
        'fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ ok: true }))',
      ].join("\n"), { encoding: "utf8", mode: 0o700 })
      await chmod(executable, 0o700)

      const previousPath = process.env.PATH
      process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ""}`
      try {
        const adapter = new CodexCliAdapter(new LocalCodexCommandRunner())
        await expect(adapter.execute({ modelId: "test-model" } as ModelInstanceSnapshot, {
          prompt: "review screenshot",
          images: [{ path: imagePath, mimeType: "image/png", name: "review.png" }],
          outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean", const: true } },
          },
          validator: z.object({ ok: z.literal(true) }).strict(),
          timeoutMs: 5_000,
          toolScope: { cwd: directory, codeRoots: [] },
          accessMode: "text-only",
        })).resolves.toEqual({ value: { ok: true }, toolCallCount: 0 })
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
      }

      const args = (await readFile(capturedArgsPath, "utf8")).split("\n")
      const imageIndex = args.indexOf("--image")
      expect(args.slice(imageIndex, imageIndex + 2)).toEqual(["--image", imagePath])
      expect(args).toContain("--strict-config")
      expect(args).not.toContain("--sandbox")
      expect(args).toContain('default_permissions="text-only"')
      expect(args).toContain("permissions.text-only.network.enabled=false")
      expect(args.some((argument) => argument.startsWith("permissions.text-only.filesystem=")
        && argument.includes('\":root\"=\"deny\"')
        && !argument.includes(`${JSON.stringify(directory)}=\"read\"`))).toBe(true)
    },
  )

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
