import { createHash } from "node:crypto"

import { z } from "zod"

import {
  SAFE_MAGICBOOK_KEYS,
  type MagicBookMappingRule,
  type MagicBookOption,
  type RawMagicBookRow,
  type SafeMagicBookKey,
  type SafeMagicBookParameter,
  type SafeMagicBookSnapshot,
} from "./types.js"

const optionSchema = z.object({
  label: z.string(),
  value: z.string(),
}).strict()

const rawMappingRuleSchema = z.object({
  sourceValues: z.array(z.string()),
  output: z.string(),
}).strict()

const safeKeys = new Set<string>(SAFE_MAGICBOOK_KEYS)
const restrictedScalarPattern = /https?:\/\/|(?:mysql|postgres(?:ql)?|redis):\/\/|BEGIN [A-Z ]*PRIVATE KEY|\b(?:\d{1,3}\.){3}\d{1,3}\b/i

function safeScalar(value: string): string | null {
  const normalized = value.trim()
  if (!normalized || restrictedScalarPattern.test(normalized)) return null
  return normalized
}

function parseJsonArray<T>(value: string, schema: z.ZodType<T[]>): T[] {
  try {
    return schema.parse(JSON.parse(value))
  } catch {
    return []
  }
}

function normalizeOption(option: MagicBookOption): MagicBookOption | null {
  const value = safeScalar(option.value)
  const label = safeScalar(option.label)
  return value && label ? { value, label } : null
}

export function parseMappedOptions(output: string): MagicBookOption[] {
  const trimmed = output.trim()
  if (!trimmed) return []

  if (trimmed.startsWith("[")) {
    const parsed = parseJsonArray(trimmed, z.array(optionSchema))
    return parsed.map(normalizeOption).filter((option): option is MagicBookOption => option !== null)
  }

  const options: MagicBookOption[] = []
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "")
    if (!line) continue

    const separated = line.match(/^(\S+?)\s*(?:=|\||:|：)\s*(.+)$/)
      ?? line.match(/^(\S+)\s+-\s+(.+)$/)
      ?? line.match(/^(\S+)\s+(.+)$/)
    const option = separated
      ? normalizeOption({ value: separated[1] ?? "", label: separated[2] ?? "" })
      : normalizeOption({ value: line, label: line })
    if (option) options.push(option)
  }
  return options
}

function normalizeSelectOptions(raw: string): MagicBookOption[] {
  return parseJsonArray(raw, z.array(optionSchema))
    .map(normalizeOption)
    .filter((option): option is MagicBookOption => option !== null)
}

function normalizeMappingRules(raw: string): MagicBookMappingRule[] {
  return parseJsonArray(raw, z.array(rawMappingRuleSchema)).map((rule) => ({
    sourceValues: rule.sourceValues.map(safeScalar).filter((value): value is string => value !== null),
    values: parseMappedOptions(rule.output),
  })).filter((rule) => rule.sourceValues.length > 0)
}

function sourceVersion(rows: RawMagicBookRow[]): string {
  const versions = rows.map((row) => {
    if (typeof row.updatedAt === "number") return new Date(row.updatedAt).toISOString()
    return row.updatedAt?.trim() ?? ""
  }).filter(Boolean).sort()
  return versions.at(-1) ?? "unknown"
}

export function calculateMagicBookContentHash(parameters: SafeMagicBookParameter[]): string {
  return createHash("sha256").update(JSON.stringify(parameters), "utf8").digest("hex")
}

export function normalizeMagicBookRows(rows: RawMagicBookRow[], now: Date): SafeMagicBookSnapshot {
  const safeRows = rows
    .filter((row) => Boolean(row.enabled) && safeKeys.has(row.key))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key))

  const parameters: SafeMagicBookParameter[] = safeRows.map((row) => ({
    key: row.key as SafeMagicBookKey,
    label: safeScalar(row.label) ?? row.key,
    kind: row.kind === "select" ? "select" : "mapping",
    sourceParameterKey: row.kind === "mapping" ? safeScalar(row.sourceParameterKey ?? "") : null,
    options: row.kind === "select" ? normalizeSelectOptions(row.options) : [],
    mappingRules: row.kind === "mapping" ? normalizeMappingRules(row.mappingRules) : [],
  }))

  return {
    sourceVersion: sourceVersion(safeRows),
    syncedAt: now.toISOString(),
    contentHash: calculateMagicBookContentHash(parameters),
    parameters,
  }
}
