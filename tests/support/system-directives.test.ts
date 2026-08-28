import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { systemDirectivesPrompt, systemDirectiveSeeds } from "../../src/support/system-directives.js"

const transactionAssociationTitle = "交易事实稳定关联"
const durableRuleOpening = "具体交易事实必须先完成稳定标识关联"

describe("transaction evidence fixed directive", () => {
  it("defines the complete stable-association rule in exactly one seed", () => {
    const matchingSeeds = systemDirectiveSeeds.filter((seed) => seed.title === transactionAssociationTitle)
    expect(matchingSeeds).toHaveLength(1)

    const content = matchingSeeds[0]!.content
    expect(content).toContain("金额 时间 收款人 账户 商户和通道只能作为寻找候选的查找线索")
    expect(content).toContain("不能单独证明")
    expect(content).toContain("两个不同且均非推断的可信来源")
    expect(content).toContain("类型和值逐字一致")
    expect(content).toContain("银行交易参考号")
    expect(content).toContain("当前代码或接口契约证据确认字段含义")
    expect(content).toContain("dependsOnFactIds")
    expect(content).toContain("code 或 document 事实")
    expect(content).toContain("业务类型 服务 商户 通道或标识存在未解除冲突")
    expect(content).toContain("配置生效")
    expect(content).toContain("外部页面处理错误")
    expect(content).toContain("一项最少稳定标识")
  })

  it("compiles the single fixed-rule seed into every system-directive prompt", () => {
    const prompt = systemDirectivesPrompt()
    expect(prompt.match(new RegExp(`【${transactionAssociationTitle}】`, "gu")) ?? []).toHaveLength(1)
    expect(prompt).toContain(durableRuleOpening)
  })

  it("keeps the project memory aligned without product-specific production branches", () => {
    const projectMemory = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8")
    const directiveSource = readFileSync(new URL("../../src/support/system-directives.ts", import.meta.url), "utf8")
    const gateSource = readFileSync(new URL("../../src/support/evidence-binding-gate.ts", import.meta.url), "utf8")
    const productionRuleText = `${projectMemory}\n${directiveSource}\n${gateSource}`

    expect(projectMemory.match(new RegExp(durableRuleOpening, "gu")) ?? []).toHaveLength(1)
    expect(productionRuleText).not.toMatch(/(?:XDPay|AOHPay|DevaPay)/u)
    expect(productionRuleText).not.toMatch(/\bDF(?:\.{3}|[A-Z0-9_-])/u)
  })
})
