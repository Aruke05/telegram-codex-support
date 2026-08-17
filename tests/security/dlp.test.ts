import { describe, expect, it } from "vitest"

import { assertSafeOutbound, redactText } from "../../src/security/dlp.js"
import { isMagicBookFieldAllowed } from "../../src/security/policy.js"

describe("敏感信息双层拦截", () => {
  it("脱敏凭据、私钥、连接串、IP和接口敏感参数", () => {
    const botToken = `${"1".repeat(9)}:${"A".repeat(35)}`
    const input = [
      "password=example-pass",
      `token=${botToken}`,
      "-----BEGIN PRIVATE KEY-----",
      "mysql://demo:demo@db.invalid/example",
      "服务器 10.20.30.40",
      "merchantNo=M000001",
      "sign=0123456789abcdef",
    ].join("\n")

    const result = redactText(input)

    expect(result.changed).toBe(true)
    expect(result.text).not.toContain("example-pass")
    expect(result.text).not.toContain(botToken)
    expect(result.text).not.toContain("10.20.30.40")
    expect(result.text).not.toContain("M000001")
    expect(result.categories).toEqual(expect.arrayContaining([
      "credential",
      "private-key",
      "connection-string",
      "ip-address",
      "business-identifier",
    ]))
  })

  it("识别高置信银行卡号但保留订单号和业务编码", () => {
    const input = "银行卡 4111 1111 1111 1111，订单 DF202608090001，交易类型 0001，银行编码 PKRBANK001"
    const result = redactText(input)

    expect(result.text).toContain("[已脱敏]")
    expect(result.text).toContain("DF202608090001")
    expect(result.text).toContain("交易类型 0001")
    expect(result.text).toContain("PKRBANK001")
    expect(result.categories).toContain("bank-card")
  })

  it("出站发现敏感信息时阻止发送且不回显原值", () => {
    const blocked = assertSafeOutbound("服务器是 10.0.0.8")
    const allowed = assertSafeOutbound("交易类型 0001 是 JAZZ，后台菜单：通道配置 → 自动派发")

    expect(blocked).toEqual({ allowed: false, categories: ["ip-address"], safeText: "服务器是 [已脱敏]" })
    expect(allowed).toEqual({ allowed: true, categories: [], safeText: allowed.safeText })
    expect(allowed.safeText).toContain("通道配置 → 自动派发")
  })

  it("MagicBook只允许五个安全字段进入知识层", () => {
    expect(isMagicBookFieldAllowed("bankCode")).toBe(true)
    expect(isMagicBookFieldAllowed("sourceService")).toBe(true)
    expect(isMagicBookFieldAllowed("baseUrl")).toBe(false)
    expect(isMagicBookFieldAllowed("documentationUrl")).toBe(false)
  })
})
