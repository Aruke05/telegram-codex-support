import { readFile } from "node:fs/promises"

import { z } from "zod"

import { calculateMagicBookContentHash, parseMappedOptions } from "./normalize.js"
import {
  SAFE_MAGICBOOK_KEYS,
  type MagicBookSource,
  type SafeMagicBookParameter,
  type SafeMagicBookSnapshot,
} from "./types.js"

const REGIONS = ["印度", "巴基斯坦", "巴西", "泰国", "越南", "印尼", "菲律宾"] as const
const EXPECTED_BANK_CODE_COUNTS: Record<(typeof REGIONS)[number], number> = {
  印度: 0,
  巴基斯坦: 32,
  巴西: 6,
  泰国: 42,
  越南: 123,
  印尼: 166,
  菲律宾: 88,
}

const optionSchema = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict()

const mappingRuleSchema = z.object({
  sourceValues: z.array(z.string().trim().min(1)).min(1),
  values: z.array(optionSchema),
}).strict()

const parameterSchema = z.object({
  key: z.enum(SAFE_MAGICBOOK_KEYS),
  label: z.string().trim().min(1),
  kind: z.enum(["select", "mapping"]),
  sourceParameterKey: z.string().trim().min(1).nullable(),
  options: z.array(optionSchema),
  mappingRules: z.array(mappingRuleSchema),
}).strict()

const parameterDocumentSchema = z.object({
  sourceVersion: z.string().trim().min(1),
  syncedAt: z.iso.datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  parameters: z.array(parameterSchema).length(SAFE_MAGICBOOK_KEYS.length),
}).strict()

const bankCodeDocumentSchema = z.object({
  sourceVersion: z.string().trim().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  source: z.string().trim().min(1),
  regions: z.object({
    印度: z.string(),
    巴基斯坦: z.string(),
    巴西: z.string(),
    泰国: z.string(),
    越南: z.string(),
    印尼: z.string(),
    菲律宾: z.string(),
  }).strict(),
}).strict()

const restrictedContentPattern = /https?:\/\/|(?:mysql|postgres(?:ql)?|redis):\/\/|BEGIN [A-Z ]*PRIVATE KEY|\b(?:\d{1,3}\.){3}\d{1,3}\b/i

function parseDocument<T>(raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    throw new Error("MagicBook JSON 快照格式错误")
  }
}

function assertParameterSet(parameters: SafeMagicBookParameter[]): void {
  const keys = parameters.map((parameter) => parameter.key)
  if (new Set(keys).size !== SAFE_MAGICBOOK_KEYS.length || SAFE_MAGICBOOK_KEYS.some((key) => !keys.includes(key))) {
    throw new Error("MagicBook JSON 快照格式错误")
  }
  const services = parameters.find((parameter) => parameter.key === "sourceService")
  if (services?.options.length !== 13) throw new Error("MagicBook JSON 快照格式错误")
}

export function validateSafeMagicBookSnapshot(snapshot: SafeMagicBookSnapshot): SafeMagicBookSnapshot {
  const parsed = parameterDocumentSchema.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(snapshot)
  assertParameterSet(parsed.parameters)
  if (calculateMagicBookContentHash(parsed.parameters) !== parsed.contentHash) {
    throw new Error("MagicBook JSON 快照哈希不匹配")
  }
  if (restrictedContentPattern.test(JSON.stringify(parsed))) {
    throw new Error("MagicBook JSON 快照包含受限内容")
  }
  return structuredClone(parsed)
}

export class StaticMagicBookKnowledgeSource implements MagicBookSource {
  constructor(
    private readonly parameterPath: string,
    private readonly bankCodePath: string,
  ) {}

  async load(): Promise<SafeMagicBookSnapshot> {
    let parameterRaw: string
    let bankCodeRaw: string
    try {
      [parameterRaw, bankCodeRaw] = await Promise.all([
        readFile(this.parameterPath, "utf8"),
        readFile(this.bankCodePath, "utf8"),
      ])
    } catch {
      throw new Error("MagicBook 本地知识快照读取失败")
    }

    const parameterDocument = parseDocument(parameterRaw, parameterDocumentSchema)
    const bankCodeDocument = parseDocument(bankCodeRaw, bankCodeDocumentSchema)
    assertParameterSet(parameterDocument.parameters)

    if (
      parameterDocument.contentHash
      && calculateMagicBookContentHash(parameterDocument.parameters) !== parameterDocument.contentHash
    ) {
      throw new Error("MagicBook JSON 快照哈希不匹配")
    }

    const mappingRules = REGIONS.map((region) => {
      const values = parseMappedOptions(bankCodeDocument.regions[region])
      if (values.length !== EXPECTED_BANK_CODE_COUNTS[region]) {
        throw new Error("MagicBook JSON 快照格式错误")
      }
      return { sourceValues: [region], values }
    })
    const codes = mappingRules.flatMap((rule) => rule.values.map((option) => option.value))
    if (new Set(codes).size !== codes.length) throw new Error("MagicBook JSON 快照格式错误")

    const parameters = parameterDocument.parameters.map((parameter) => parameter.key === "bankCode"
      ? { ...parameter, mappingRules }
      : structuredClone(parameter))
    const syncedAt = new Date(Math.max(
      Date.parse(parameterDocument.syncedAt),
      Date.parse(bankCodeDocument.capturedAt),
    )).toISOString()
    const snapshot: SafeMagicBookSnapshot = {
      sourceVersion: `${parameterDocument.sourceVersion}+${bankCodeDocument.sourceVersion}`,
      syncedAt,
      contentHash: calculateMagicBookContentHash(parameters),
      parameters,
    }
    return validateSafeMagicBookSnapshot(snapshot)
  }
}
