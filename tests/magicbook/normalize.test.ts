import { describe, expect, it } from "vitest"

import {
  normalizeMagicBookRows,
  parseMappedOptions,
} from "../../src/magicbook/normalize.js"
import type { RawMagicBookRow } from "../../src/magicbook/types.js"

function row(overrides: Partial<RawMagicBookRow> & Pick<RawMagicBookRow, "key" | "label" | "kind">): RawMagicBookRow {
  const { key, label, kind, ...rest } = overrides
  return {
    key,
    label,
    kind,
    valueType: "text",
    value: "",
    options: "[]",
    sourceParameterKey: null,
    mappingRules: "[]",
    fallback: "",
    enabled: 1,
    sortOrder: 0,
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...rest,
  }
}

describe("parseMappedOptions", () => {
  it("解析常见的编码和名称格式", () => {
    expect(parseMappedOptions("0001=JAZZ\n0002 | EP\n0003 BANK")).toEqual([
      { value: "0001", label: "JAZZ" },
      { value: "0002", label: "EP" },
      { value: "0003", label: "BANK" },
    ])
  })
})

describe("normalizeMagicBookRows", () => {
  it("只保留五种安全参数并彻底丢弃受限原值", () => {
    const rows: RawMagicBookRow[] = [
      row({
        key: "sourceService",
        label: "服务",
        kind: "select",
        options: JSON.stringify([
          { label: "MCBPay", value: "mcbpay" },
          { label: "NinePay", value: "nine" },
        ]),
      }),
      row({
        key: "targetRegion",
        label: "地区",
        kind: "mapping",
        sourceParameterKey: "sourceService",
        mappingRules: JSON.stringify([
          { sourceValues: ["mcbpay"], output: "巴基斯坦" },
          { sourceValues: ["nine"], output: "印度" },
        ]),
      }),
      row({
        key: "branch",
        label: "分支",
        kind: "mapping",
        sourceParameterKey: "sourceService",
        mappingRules: JSON.stringify([
          { sourceValues: ["mcbpay"], output: "prod-pkr" },
          { sourceValues: ["nine"], output: "uat" },
        ]),
      }),
      row({
        key: "transactionType",
        label: "交易类型",
        kind: "mapping",
        sourceParameterKey: "targetRegion",
        mappingRules: JSON.stringify([
          { sourceValues: ["巴基斯坦"], output: "0001=JAZZ\n0002=EP" },
          { sourceValues: ["印度"], output: "" },
        ]),
      }),
      row({
        key: "bankCode",
        label: "银行编码",
        kind: "mapping",
        sourceParameterKey: "targetRegion",
        mappingRules: JSON.stringify([
          { sourceValues: ["巴基斯坦"], output: "PKRBANK001=示例银行" },
          { sourceValues: ["印度"], output: "" },
        ]),
      }),
      row({ key: "baseUrl", label: "服务地址", kind: "fixed", value: "https://restricted.example" }),
      row({ key: "callbackIp", label: "回调IP", kind: "fixed", value: "10.0.0.8" }),
    ]

    const snapshot = normalizeMagicBookRows(rows, new Date("2026-08-09T01:00:00.000Z"))
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.parameters.map((parameter) => parameter.key).sort()).toEqual([
      "bankCode",
      "branch",
      "sourceService",
      "targetRegion",
      "transactionType",
    ])
    expect(serialized).not.toContain("restricted.example")
    expect(serialized).not.toContain("10.0.0.8")
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })
})
