import type { RuntimeDatabase } from "../runtime/database.js"
import type { ModelProvider, ModelTransport } from "../runtime/types.js"
import { modelCatalogEntrySchema, type ModelCatalogEntry, type ModelCatalogResult } from "./catalog-types.js"
import type { CodexCatalogClient, CodexCatalogModel } from "./codex-catalog-client.js"

type Row = Record<string, unknown>

const codexCatalogErrorMetadataKey = "model_catalog_codex_error"
const codexCatalogRefreshFailureMessage = "Codex 模型目录刷新失败，已保留最近一次成功结果"

const apiModels: Array<Omit<ModelCatalogEntry, "refreshedAt">> = [
  { provider: "openai", transport: "direct_api", modelId: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "medium", supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"], serviceTiers: ["standard", "priority"], inputModalities: ["text", "image"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "deepseek", transport: "direct_api", modelId: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "low", "high", "xhigh", "max"], serviceTiers: ["standard"], inputModalities: ["text"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "deepseek", transport: "direct_api", modelId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "low", "high", "xhigh", "max"], serviceTiers: ["standard"], inputModalities: ["text"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "anthropic", transport: "direct_api", modelId: "claude-fable-5", displayName: "Claude Fable 5", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], serviceTiers: ["standard"], inputModalities: ["text", "image"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "anthropic", transport: "direct_api", modelId: "claude-opus-5", displayName: "Claude Opus 5", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], serviceTiers: ["standard"], inputModalities: ["text", "image"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "anthropic", transport: "direct_api", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], serviceTiers: ["standard"], inputModalities: ["text", "image"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "anthropic", transport: "direct_api", modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "medium", supportedReasoningEfforts: ["none", "low", "medium", "high"], serviceTiers: ["standard"], inputModalities: ["text", "image"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "glm", transport: "direct_api", modelId: "glm-5.2", displayName: "GLM-5.2", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "high"], serviceTiers: ["standard"], inputModalities: ["text"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "glm", transport: "direct_api", modelId: "glm-5.1", displayName: "GLM-5.1", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "high"], serviceTiers: ["standard"], inputModalities: ["text"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "glm", transport: "direct_api", modelId: "glm-5", displayName: "GLM-5", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "high"], serviceTiers: ["standard"], inputModalities: ["text"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
  { provider: "glm", transport: "direct_api", modelId: "glm-4.7", displayName: "GLM-4.7", hidden: false, deprecated: false, upgradeModelId: null,
    capabilities: { defaultReasoningEffort: "high", supportedReasoningEfforts: ["none", "high"], serviceTiers: ["standard"], inputModalities: ["text"], supportsTools: true, supportsStructuredOutput: true, supportsCustomModelId: true } },
]

function upgradeModelId(model: CodexCatalogModel): string | null {
  if (typeof model.upgrade === "string") return model.upgrade
  return model.upgrade?.model ?? model.upgrade?.id ?? null
}

function rowToEntry(row: Row): ModelCatalogEntry {
  return modelCatalogEntrySchema.parse({
    provider: row.provider,
    transport: row.transport,
    modelId: row.model_id,
    displayName: row.display_name,
    capabilities: JSON.parse(String(row.capabilities_json)),
    hidden: Number(row.hidden) === 1,
    deprecated: Number(row.deprecated) === 1,
    upgradeModelId: row.upgrade_model_id,
    refreshedAt: row.refreshed_at,
  })
}

export class ModelCatalogService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly codex: CodexCatalogClient,
  ) {}

  list(input: { provider?: ModelProvider | undefined; transport?: ModelTransport | undefined; includeHidden?: boolean | undefined } = {}): ModelCatalogResult {
    const clauses: string[] = []
    const parameters: string[] = []
    if (input.provider) { clauses.push("provider=?"); parameters.push(input.provider) }
    if (input.transport) { clauses.push("transport=?"); parameters.push(input.transport) }
    if (!input.includeHidden) clauses.push("hidden=0")
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const cached = (this.database.prepare(`SELECT * FROM model_catalog_entries ${where} ORDER BY model_id`).all(...parameters) as Row[]).map(rowToEntry)
    const now = new Date().toISOString()
    const builtins = apiModels
      .filter((entry) => (!input.provider || entry.provider === input.provider) && (!input.transport || entry.transport === input.transport))
      .filter((entry) => input.includeHidden || !entry.hidden)
      .map((entry) => modelCatalogEntrySchema.parse({ ...entry, refreshedAt: now }))
    const deduplicated = new Map<string, ModelCatalogEntry>()
    ;[...builtins, ...cached].forEach((entry) => deduplicated.set(`${entry.provider}:${entry.transport}:${entry.modelId}`, entry))
    const entries = [...deduplicated.values()].sort((left, right) => left.modelId.localeCompare(right.modelId))
    const refreshedAt = cached.map((entry) => entry.refreshedAt).sort().at(-1) ?? null
    const includesCodexCatalog = (!input.provider || input.provider === "openai")
      && (!input.transport || input.transport === "codex_cli")
    const error = includesCodexCatalog
      ? (this.database.prepare("SELECT value FROM metadata WHERE key=?").get(codexCatalogErrorMetadataKey) as Row | undefined)?.value
      : null
    return { entries, refreshedAt, stale: typeof error === "string" && error.length > 0, error: typeof error === "string" ? error : null }
  }

  async refreshCodex(): Promise<ModelCatalogResult> {
    try {
      const models = await this.codex.listAll()
      const refreshedAt = new Date().toISOString()
      const entries = models.map((model) => modelCatalogEntrySchema.parse({
        provider: "openai",
        transport: "codex_cli",
        modelId: model.model,
        displayName: model.displayName,
        capabilities: {
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
          serviceTiers: ["standard", "fast"],
          inputModalities: model.inputModalities,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsCustomModelId: false,
        },
        hidden: model.hidden,
        deprecated: Boolean(model.upgrade),
        upgradeModelId: upgradeModelId(model),
        refreshedAt,
      }))
      this.database.transaction(() => {
        this.database.prepare("DELETE FROM model_catalog_entries WHERE provider='openai' AND transport='codex_cli'").run()
        const insert = this.database.prepare(`INSERT INTO model_catalog_entries(
          provider,transport,model_id,display_name,capabilities_json,hidden,deprecated,upgrade_model_id,refreshed_at
        ) VALUES (?,?,?,?,?,?,?,?,?)`)
        entries.forEach((entry) => insert.run(
          entry.provider, entry.transport, entry.modelId, entry.displayName, JSON.stringify(entry.capabilities),
          Number(entry.hidden), Number(entry.deprecated), entry.upgradeModelId, entry.refreshedAt,
        ))
        this.database.prepare("DELETE FROM metadata WHERE key=?").run(codexCatalogErrorMetadataKey)
      })
      return { entries: entries.sort((left, right) => left.modelId.localeCompare(right.modelId)), refreshedAt, stale: false, error: null }
    } catch {
      this.database.prepare(`INSERT INTO metadata(key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(codexCatalogErrorMetadataKey, codexCatalogRefreshFailureMessage)
      const cached = this.list({ provider: "openai", transport: "codex_cli", includeHidden: true })
      return cached
    }
  }
}
