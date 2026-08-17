import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  loadInterfaceDocument,
  lookupInterfaceSections,
} from "../../src/knowledge/interface-documents.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("脱敏接口文档知识", () => {
  it("加载10个相对接口并支持按路径和字段检索", async () => {
    const snapshot = await loadInterfaceDocument("knowledge/bootstrap/interface-docs-sanitized.md")

    expect(snapshot.title).toBe("商户接口文档脱敏快照")
    expect(snapshot.endpoints).toHaveLength(10)
    expect(snapshot.endpoints).toContain("/api/xd/paymentOrder")
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.rawText).not.toMatch(/https?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|\b[a-f0-9]{32}\b/i)
    expect(lookupInterfaceSections(snapshot, "/api/xd/paymentOrder")[0]?.title).toBe("代付下单")
    expect(lookupInterfaceSections(snapshot, "bankCode").length).toBeGreaterThan(0)
    expect(lookupInterfaceSections(snapshot, "UTR").length).toBeGreaterThanOrEqual(2)
  })

  it("把UTR补单标记为只解释的写操作", async () => {
    const snapshot = await loadInterfaceDocument("knowledge/bootstrap/interface-docs-sanitized.md")
    const section = lookupInterfaceSections(snapshot, "/api/xd/bindUtr")[0]

    expect(section).toMatchObject({ title: "UTR 补单", writeOperation: true, explainOnly: true })
  })

  it("拒绝包含绝对网址或疑似签名原值的文档", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "interface-docs-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "unsafe.md")
    await writeFile(file, [
      "---",
      "title: 不安全文档",
      "captured_at: 2026-08-09T00:00:00+08:00",
      "---",
      "# 接口",
      "地址：https://example.invalid/api",
      "sign=0123456789abcdef0123456789abcdef",
    ].join("\n"), "utf8")

    await expect(loadInterfaceDocument(file)).rejects.toThrow("接口文档包含受限内容")
  })
})
