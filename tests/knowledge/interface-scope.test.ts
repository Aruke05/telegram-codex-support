import { describe, expect, it } from "vitest"

import { buildApp } from "../../src/app.js"
import { loadInterfaceDocument } from "../../src/knowledge/interface-documents.js"

describe("印度与非印度接口文档", () => {
  it("按地区隔离专属接口", async () => {
    const india = await loadInterfaceDocument("knowledge/bootstrap/interface-docs-india-sanitized.md")
    const nonIndia = await loadInterfaceDocument("knowledge/bootstrap/interface-docs-non-india-sanitized.md")
    expect(india.scope).toBe("india")
    expect(india.endpoints).toContain("/api/xd/queryUtr")
    expect(india.endpoints).not.toContain("/api/xd/queryTransactionType")
    expect(nonIndia.scope).toBe("non_india")
    expect(nonIndia.endpoints).toContain("/api/xd/queryTransactionType")
    expect(nonIndia.endpoints).not.toContain("/api/xd/queryUtr")

    const app = buildApp({ interfaceDocuments: { india, non_india: nonIndia } })
    const response = await app.inject({ method: "GET", url: "/api/interface-docs/search?scope=india&q=UTR" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ scope: "india" })
  })
})
