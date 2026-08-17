import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { StaticMagicBookKnowledgeSource } from "../../src/magicbook/json-source.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function temporaryFile(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "magicbook-source-"))
  temporaryDirectories.push(directory)
  return path.join(directory, name)
}

function source(parameterPath = "config/magicbook-safe-bootstrap.json", bankCodePath = "knowledge/bootstrap/magicbook-bank-codes-sanitized.json") {
  return new StaticMagicBookKnowledgeSource(parameterPath, bankCodePath)
}

describe("StaticMagicBookKnowledgeSource", () => {
  it("只从本地加载13个服务和457个银行编码", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const snapshot = await source().load()
    const services = snapshot.parameters.find((parameter) => parameter.key === "sourceService")
    const transactionTypes = snapshot.parameters.find((parameter) => parameter.key === "transactionType")
    const bankCodes = snapshot.parameters.find((parameter) => parameter.key === "bankCode")
    const counts = Object.fromEntries(bankCodes?.mappingRules.map((rule) => [rule.sourceValues[0], rule.values.length]) ?? [])
    const allBankCodes = bankCodes?.mappingRules.flatMap((rule) => rule.values) ?? []

    expect(snapshot.parameters).toHaveLength(5)
    expect(services?.options).toHaveLength(13)
    expect(transactionTypes?.mappingRules.find((rule) => rule.sourceValues.includes("印度"))?.values).toEqual([])
    expect(counts).toEqual({ 印度: 0, 巴基斯坦: 32, 巴西: 6, 泰国: 42, 越南: 123, 印尼: 166, 菲律宾: 88 })
    expect(allBankCodes).toHaveLength(457)
    expect(new Set(allBankCodes.map((option) => option.value)).size).toBe(457)
    expect(allBankCodes.every((option) => option.value.length > 0 && option.label.length > 0)).toBe(true)
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(snapshot)).not.toMatch(/https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|BEGIN [A-Z ]*PRIVATE KEY|(?:mysql|redis|postgres(?:ql)?):\/\//i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("拒绝参数快照中的安全模型外字段", async () => {
    const parameterFile = await temporaryFile("unsafe.json")
    const bootstrap = JSON.parse(await readFile("config/magicbook-safe-bootstrap.json", "utf8")) as object
    await writeFile(parameterFile, JSON.stringify({ ...bootstrap, baseUrl: "restricted-value" }), "utf8")

    await expect(source(parameterFile).load()).rejects.toThrow("MagicBook JSON 快照格式错误")
  })

  it("拒绝银行编码快照中的安全模型外字段", async () => {
    const bankCodeFile = await temporaryFile("unsafe-bank-codes.json")
    const bankCodes = JSON.parse(await readFile("knowledge/bootstrap/magicbook-bank-codes-sanitized.json", "utf8")) as object
    await writeFile(bankCodeFile, JSON.stringify({ ...bankCodes, documentationUrl: "restricted-value" }), "utf8")

    await expect(source(undefined, bankCodeFile).load()).rejects.toThrow("MagicBook JSON 快照格式错误")
  })

  it("拒绝不匹配的内容哈希", async () => {
    const parameterFile = await temporaryFile("bad-hash.json")
    const bootstrap = JSON.parse(await readFile("config/magicbook-safe-bootstrap.json", "utf8")) as object
    await writeFile(parameterFile, JSON.stringify({ ...bootstrap, contentHash: "0".repeat(64) }), "utf8")

    await expect(source(parameterFile).load()).rejects.toThrow("MagicBook JSON 快照哈希不匹配")
  })
})
