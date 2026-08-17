import { z } from "zod"

import { modelProviderSchema, modelTransportSchema, reasoningEffortSchema } from "../runtime/types.js"

export const modelCatalogCapabilitiesSchema = z.object({
  defaultReasoningEffort: reasoningEffortSchema.nullable(),
  supportedReasoningEfforts: z.array(reasoningEffortSchema),
  serviceTiers: z.array(z.enum(["standard", "fast", "priority"])),
  inputModalities: z.array(z.enum(["text", "image"])),
  supportsTools: z.boolean(),
  supportsStructuredOutput: z.boolean(),
  supportsCustomModelId: z.boolean(),
}).strict()

export const modelCatalogEntrySchema = z.object({
  provider: modelProviderSchema,
  transport: modelTransportSchema,
  modelId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(200),
  capabilities: modelCatalogCapabilitiesSchema,
  hidden: z.boolean(),
  deprecated: z.boolean(),
  upgradeModelId: z.string().max(160).nullable(),
  refreshedAt: z.string().datetime(),
}).strict()

export type ModelCatalogCapabilities = z.infer<typeof modelCatalogCapabilitiesSchema>
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>

export type ModelCatalogResult = {
  entries: ModelCatalogEntry[]
  refreshedAt: string | null
  stale: boolean
  error: string | null
}
