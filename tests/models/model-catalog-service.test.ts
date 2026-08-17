import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { CodexCatalogClient } from "../../src/models/codex-catalog-client.js"
import { ModelCatalogService } from "../../src/models/model-catalog-service.js"
import { RuntimeDatabase } from "../../src/runtime/database.js"

const temporaryDirectories: string[] = []
const refreshFailureMessage = "Codex 模型目录刷新失败，已保留最近一次成功结果"

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openDatabase(): Promise<RuntimeDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "model-catalog-service-"))
  temporaryDirectories.push(directory)
  return await RuntimeDatabase.open(path.join(directory, "runtime.sqlite"))
}

function failingCodexClient(): CodexCatalogClient {
  return {
    listAll: vi.fn().mockRejectedValue(new Error("app-server unavailable")),
  } as unknown as CodexCatalogClient
}

function successfulCodexClient(): CodexCatalogClient {
  return {
    listAll: vi.fn().mockResolvedValue([{
      id: "gpt-current",
      model: "gpt-current",
      displayName: "GPT Current",
      hidden: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      isDefault: true,
      upgrade: null,
    }]),
  } as unknown as CodexCatalogClient
}

function seedCachedCodexModel(database: RuntimeDatabase): void {
  database.prepare(`INSERT INTO model_catalog_entries(
    provider,transport,model_id,display_name,capabilities_json,hidden,deprecated,upgrade_model_id,refreshed_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "openai",
    "codex_cli",
    "gpt-cached",
    "GPT Cached",
    JSON.stringify({
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
      serviceTiers: ["standard", "fast"],
      inputModalities: ["text", "image"],
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsCustomModelId: false,
    }),
    0,
    0,
    null,
    "2026-08-11T00:00:00.000Z",
  )
}

describe("Codex 模型目录缓存状态", () => {
  it("刷新失败后重新创建服务仍把最近一次成功缓存标记为过期", async () => {
    const database = await openDatabase()
    seedCachedCodexModel(database)

    const refreshResult = await new ModelCatalogService(database, failingCodexClient()).refreshCodex()
    expect(refreshResult.stale).toBe(true)
    expect(refreshResult.error).toBe(refreshFailureMessage)

    const filePath = database.filePath
    database.close()
    const reopened = await RuntimeDatabase.open(filePath)
    try {
      const listed = new ModelCatalogService(reopened, failingCodexClient()).list({
        provider: "openai",
        transport: "codex_cli",
        includeHidden: true,
      })

      expect(listed.entries.map((entry) => entry.modelId)).toEqual(["gpt-cached"])
      expect(listed.refreshedAt).toBe("2026-08-11T00:00:00.000Z")
      expect(listed.stale).toBe(true)
      expect(listed.error).toBe(refreshFailureMessage)
    } finally {
      reopened.close()
    }
  })

  it("失败后的下一次成功刷新会持久清除过期状态", async () => {
    const database = await openDatabase()
    seedCachedCodexModel(database)

    await new ModelCatalogService(database, failingCodexClient()).refreshCodex()
    const refreshResult = await new ModelCatalogService(database, successfulCodexClient()).refreshCodex()
    expect(refreshResult.stale).toBe(false)
    expect(refreshResult.error).toBeNull()

    const filePath = database.filePath
    database.close()
    const reopened = await RuntimeDatabase.open(filePath)
    try {
      const listed = new ModelCatalogService(reopened, failingCodexClient()).list({
        provider: "openai",
        transport: "codex_cli",
        includeHidden: true,
      })

      expect(listed.entries.map((entry) => entry.modelId)).toEqual(["gpt-current"])
      expect(listed.stale).toBe(false)
      expect(listed.error).toBeNull()
    } finally {
      reopened.close()
    }
  })
})
