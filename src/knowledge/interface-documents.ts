import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export type InterfaceDocumentSection = {
  title: string
  content: string
  endpoints: string[]
  writeOperation: boolean
  explainOnly: boolean
}

export type InterfaceDocumentScope = "india" | "non_india"

export type InterfaceDocumentSnapshot = {
  title: string
  scope: InterfaceDocumentScope | "legacy"
  applicableRegions: string[]
  capturedAt: string
  contentHash: string
  endpoints: string[]
  sections: InterfaceDocumentSection[]
  rawText: string
}

const restrictedContentPattern = /https?:\/\/|(?:mysql|postgres(?:ql)?|redis):\/\/|BEGIN [A-Z ]*PRIVATE KEY|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-f0-9]{32}\b/i
const endpointPattern = /\/api\/xd\/[A-Za-z0-9]+/g
const writeEndpoints = new Set(["/api/xd/collectionOrder", "/api/xd/paymentOrder", "/api/xd/bindUtr"])

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
  return match?.[1]?.trim() ?? null
}

function parseSections(rawText: string): InterfaceDocumentSection[] {
  const headings = [...rawText.matchAll(/^# (.+)$/gm)]
  return headings.map((heading, index) => {
    const start = heading.index ?? 0
    const end = headings[index + 1]?.index ?? rawText.length
    const content = rawText.slice(start, end).trim()
    const endpoints = unique(content.match(endpointPattern) ?? [])
    const writeOperation = endpoints.some((endpoint) => writeEndpoints.has(endpoint))
    return {
      title: heading[1]?.trim() ?? "",
      content,
      endpoints,
      writeOperation,
      explainOnly: writeOperation,
    }
  })
}

export async function loadInterfaceDocument(filePath: string): Promise<InterfaceDocumentSnapshot> {
  let rawText: string
  try {
    rawText = await readFile(filePath, "utf8")
  } catch {
    throw new Error("接口文档读取失败")
  }

  if (restrictedContentPattern.test(rawText)) throw new Error("接口文档包含受限内容")
  const frontmatterMatch = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const title = frontmatterMatch ? frontmatterValue(frontmatterMatch[1] ?? "", "title") : null
  const capturedAt = frontmatterMatch ? frontmatterValue(frontmatterMatch[1] ?? "", "captured_at") : null
  const scopeValue = frontmatterMatch ? frontmatterValue(frontmatterMatch[1] ?? "", "scope") : null
  const regionsValue = frontmatterMatch ? frontmatterValue(frontmatterMatch[1] ?? "", "applicable_regions") : null
  if (!title || !capturedAt || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("接口文档格式错误")
  }

  const sections = parseSections(rawText)
  const endpoints = unique(sections.flatMap((section) => section.endpoints))
  if (sections.length === 0 || endpoints.length === 0) throw new Error("接口文档格式错误")

  return {
    title,
    scope: scopeValue === "india" || scopeValue === "non_india" ? scopeValue : "legacy",
    applicableRegions: regionsValue ? regionsValue.split(",").map((region) => region.trim()).filter(Boolean) : [],
    capturedAt: new Date(capturedAt).toISOString(),
    contentHash: createHash("sha256").update(rawText, "utf8").digest("hex"),
    endpoints,
    sections,
    rawText,
  }
}

export function lookupInterfaceSections(
  snapshot: InterfaceDocumentSnapshot,
  query: string,
): InterfaceDocumentSection[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN")
  if (!normalized) return []
  const searchTerms = unique([normalized, normalized.replaceAll("下单", "创建订单")])

  return snapshot.sections
    .map((section) => {
      const exactEndpoint = searchTerms.some((term) => section.endpoints.some((endpoint) => endpoint.toLocaleLowerCase("zh-CN") === term))
      const titleMatch = searchTerms.some((term) => section.title.toLocaleLowerCase("zh-CN").includes(term))
      const contentMatch = searchTerms.some((term) => section.content.toLocaleLowerCase("zh-CN").includes(term))
      return { section, score: exactEndpoint ? 3 : titleMatch ? 2 : contentMatch ? 1 : 0 }
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((result) => structuredClone(result.section))
}
