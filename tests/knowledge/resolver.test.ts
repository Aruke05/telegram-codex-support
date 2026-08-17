import { beforeAll, describe, expect, it } from "vitest"

import { KnowledgeResolver } from "../../src/knowledge/resolver.js"
import { StaticMagicBookKnowledgeSource } from "../../src/magicbook/json-source.js"
import type { SafeMagicBookSnapshot } from "../../src/magicbook/types.js"

let snapshot: SafeMagicBookSnapshot

beforeAll(async () => {
  snapshot = await new StaticMagicBookKnowledgeSource(
    "config/magicbook-safe-bootstrap.json",
    "knowledge/bootstrap/magicbook-bank-codes-sanitized.json",
  ).load()
})

describe("服务和地区知识查询", () => {
  it("返回MCBPay对应的巴基斯坦参数", () => {
    const result = new KnowledgeResolver(snapshot).lookupService("MCBPAY")

    expect(result).toMatchObject({
      found: true,
      service: "mcbpay",
      region: "巴基斯坦",
      branch: "prod-pkr",
      indiaIfscNotice: false,
    })
    if (!result.found) throw new Error("预期找到MCBPay知识")
    expect(result.transactionTypes.map((option) => option.value)).toEqual(["0001", "0002", "0003"])
    expect(result.bankCodes).toHaveLength(32)
  })

  it("忽略服务大小写但不做模糊猜测", () => {
    const resolver = new KnowledgeResolver(snapshot)

    expect(resolver.lookupService("dapay")).toMatchObject({ found: true, service: "DApay", region: "越南" })
    expect(resolver.lookupService("mcb")).toEqual({ found: false, service: "mcb" })
  })

  it("印度不返回其他地区枚举并保留IFSC提醒", () => {
    const result = new KnowledgeResolver(snapshot).lookupService("nine")

    expect(result).toMatchObject({
      found: true,
      region: "印度",
      branch: "uat",
      transactionTypes: [],
      bankCodes: [],
      indiaIfscNotice: true,
    })
    if (!result.found) throw new Error("预期找到Nine知识")
  })

  it("可直接查询地区且带知识版本", () => {
    const result = new KnowledgeResolver(snapshot).lookupRegion("菲律宾")

    expect(result).toMatchObject({ found: true, region: "菲律宾", indiaIfscNotice: false })
    if (!result.found) throw new Error("预期找到菲律宾知识")
    expect(result.transactionTypes).toHaveLength(5)
    expect(result.bankCodes).toHaveLength(88)
    expect(result.sourceVersion).toBe(snapshot.sourceVersion)
    expect(result.contentHash).toBe(snapshot.contentHash)
  })
})
