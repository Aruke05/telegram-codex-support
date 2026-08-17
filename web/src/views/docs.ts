import { api } from "../api.js"
import { badge, emptyState, errorState, loadingState, pageHeader, selectInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { icon } from "../icons.js"
import type { InterfaceDocumentSearch, InterfaceDocumentSummary } from "../types.js"

const suggestions = ["代收下单", "代付下单", "订单查询", "UTR 补单", "签名"]

function renderResults(target: HTMLElement, result: InterfaceDocumentSearch): void {
  const wrapper = element("div", "docs-results")
  const summary = element("div", "docs-summary")
  summary.append(
    element("span", "docs-summary__count", `${result.title} · 找到 ${result.sections.length} 个章节`),
    element("code", "docs-summary__version", result.sourceVersion.slice(0, 8)),
  )
  wrapper.append(summary)
  if (!result.sections.length) {
    wrapper.append(emptyState("没有匹配内容", "换一个接口名称、路径或业务关键词。", "search"))
    replaceChildren(target, wrapper)
    return
  }
  result.sections.forEach((section) => {
    const card = element("article", "doc-card")
    const head = element("header", "doc-card__head")
    const title = element("div")
    title.append(element("p", "eyebrow", result.scope === "india" ? "印度接口" : "非印度接口"), element("h2", "doc-card__title", section.title))
    head.append(title, section.writeOperation && section.explainOnly ? badge("只解释，不执行", "warning") : badge("本地快照", "success"))
    card.append(head)
    if (section.endpoints.length) {
      const endpoints = element("div", "endpoint-list")
      section.endpoints.forEach((endpoint) => endpoints.append(element("code", "endpoint-chip", endpoint)))
      card.append(endpoints)
    }
    const content = element("pre", "doc-content")
    content.textContent = section.content
    card.append(content)
    wrapper.append(card)
  })
  replaceChildren(target, wrapper)
}

function documentCards(documents: InterfaceDocumentSummary[]): HTMLElement {
  const grid = element("div", "document-scope-grid")
  documents.forEach((document) => {
    const card = element("article", "scope-card")
    card.append(
      badge(document.scope === "india" ? "印度" : "非印度", document.scope === "india" ? "accent" : "success"),
      element("h3", "scope-card__title", document.title),
      element("p", "scope-card__text", document.scope === "india" ? "UTR、UPI 和印度下单规则；不套用银行编码与交易类型。" : "交易类型、银行编码和非印度下单规则。"),
      element("span", "scope-card__meta", `${document.endpointCount} 个接口章节 · ${document.applicableRegions.join("、")}`),
    )
    grid.append(card)
  })
  return grid
}

export function renderDocs(container: HTMLElement): void {
  const content = element("section", "page-content docs-page")
  content.append(pageHeader("本地知识快照", "接口文档", "印度和非印度是两套独立文档，搜索时必须先选范围。"))
  const scopeArea = element("div", "document-scope-area")
  scopeArea.append(loadingState(2))
  content.append(scopeArea)

  const searchPanel = element("section", "search-panel")
  const form = element("form", "docs-search docs-search--scoped")
  const scope = selectInput("scope", [{ value: "india", label: "印度接口" }, { value: "non_india", label: "非印度接口" }])
  const field = element("label", "search-field search-field--large")
  field.append(icon("search", "search-field__icon"))
  const input = element("input", "search-field__input")
  input.type = "search"; input.placeholder = "输入接口名称、相对路径或业务关键词"; input.autocomplete = "off"; input.setAttribute("aria-label", "搜索接口文档")
  field.append(input)
  const submit = element("button", "button button--primary", "搜索")
  submit.type = "submit"
  form.append(scope, field, submit)
  const suggestionRow = element("div", "suggestion-row")
  suggestionRow.append(element("span", "suggestion-row__label", "常用："))
  suggestions.forEach((suggestion) => {
    const button = element("button", "suggestion-chip", suggestion)
    button.type = "button"
    button.addEventListener("click", () => { input.value = suggestion; form.requestSubmit() })
    suggestionRow.append(button)
  })
  searchPanel.append(form, suggestionRow)
  content.append(searchPanel)
  const results = element("div", "docs-result-area")
  results.append(emptyState("先选范围再搜索", "印度不使用非印度的交易类型和银行编码。", "document"))
  content.append(results)
  replaceChildren(container, content)

  void api.getInterfaceDocuments().then((result) => replaceChildren(scopeArea, documentCards(result.documents))).catch((error: unknown) => replaceChildren(scopeArea, errorState(error instanceof Error ? error.message : "加载失败", () => renderDocs(container))))
  let requestSequence = 0
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    const query = input.value.trim()
    if (!query) { input.focus(); return }
    const sequence = ++requestSequence
    submit.disabled = true
    replaceChildren(results, loadingState(2))
    void api.searchInterfaceDocs(scope.value as "india" | "non_india", query).then((response) => {
      if (sequence === requestSequence) renderResults(results, response)
    }).catch((error: unknown) => {
      if (sequence === requestSequence) replaceChildren(results, errorState(error instanceof Error ? error.message : "加载失败，请重试", () => form.requestSubmit()))
    }).finally(() => { if (sequence === requestSequence) submit.disabled = false })
  })
}
