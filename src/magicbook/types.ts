export const SAFE_MAGICBOOK_KEYS = [
  "sourceService",
  "targetRegion",
  "branch",
  "transactionType",
  "bankCode",
] as const

export type SafeMagicBookKey = (typeof SAFE_MAGICBOOK_KEYS)[number]

export type MagicBookOption = {
  value: string
  label: string
}

export type MagicBookMappingRule = {
  sourceValues: string[]
  values: MagicBookOption[]
}

export type SafeMagicBookParameter = {
  key: SafeMagicBookKey
  label: string
  kind: "select" | "mapping"
  sourceParameterKey: string | null
  options: MagicBookOption[]
  mappingRules: MagicBookMappingRule[]
}

export type SafeMagicBookSnapshot = {
  sourceVersion: string
  syncedAt: string
  contentHash: string
  parameters: SafeMagicBookParameter[]
}

export type RawMagicBookRow = {
  key: string
  label: string
  kind: "fixed" | "select" | "mapping"
  valueType: "text" | "url" | "multiline"
  value: string
  options: string
  sourceParameterKey: string | null
  mappingRules: string
  fallback: string
  enabled: number | boolean
  sortOrder: number
  updatedAt: string | number | null
}

export interface MagicBookSource {
  load(): Promise<SafeMagicBookSnapshot>
}
