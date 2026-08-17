import { element } from "./dom.js"
import { icon, type IconName } from "./icons.js"
import { normalizeThemePreference } from "./theme.js"
import type { ThemePreference } from "./types.js"

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent"

export function badge(label: string, tone: Tone = "neutral"): HTMLSpanElement {
  const node = element("span", `badge badge--${tone}`)
  node.append(element("span", "badge__dot"), document.createTextNode(label))
  return node
}

export function pageHeader(eyebrow: string, title: string, description: string): HTMLElement {
  const wrapper = element("header", "page-header")
  wrapper.append(
    element("p", "eyebrow", eyebrow),
    element("h1", "page-title", title),
    element("p", "page-description", description),
  )
  return wrapper
}

export function metricCard(
  label: string,
  value: string,
  detail: string,
  iconName: IconName,
  tone: Tone = "neutral",
): HTMLElement {
  const card = element("article", `metric-card metric-card--${tone}`)
  const head = element("div", "metric-card__head")
  head.append(element("span", "metric-card__label", label), icon(iconName, "metric-card__icon"))
  card.append(head, element("strong", "metric-card__value", value), element("span", "metric-card__detail", detail))
  return card
}

export function labeledValue(label: string, value: string, iconName?: IconName): HTMLElement {
  const row = element("div", "detail-row")
  const key = element("span", "detail-row__key")
  if (iconName) key.append(icon(iconName), document.createTextNode(label))
  else key.textContent = label
  row.append(key, element("span", "detail-row__value", value))
  return row
}

export function loadingState(rows = 4): HTMLElement {
  const wrapper = element("div", "loading-grid")
  for (let index = 0; index < rows; index += 1) {
    const card = element("div", "skeleton-card")
    card.append(element("span", "skeleton skeleton--short"), element("span", "skeleton skeleton--tall"), element("span", "skeleton"))
    wrapper.append(card)
  }
  wrapper.setAttribute("aria-label", "正在加载")
  return wrapper
}

export function emptyState(title: string, description: string, iconName: IconName = "search"): HTMLElement {
  const wrapper = element("div", "empty-state")
  wrapper.append(icon(iconName, "empty-state__icon"), element("h2", "empty-state__title", title), element("p", "empty-state__text", description))
  return wrapper
}

export function errorState(message: string, retry: () => void): HTMLElement {
  const wrapper = emptyState("暂时没加载出来", message, "refresh")
  const button = element("button", "button button--secondary", "重新加载")
  button.type = "button"
  button.addEventListener("click", retry)
  wrapper.append(button)
  return wrapper
}

export function pendingPage(title: string): HTMLElement {
  const wrapper = element("section", "page-content")
  wrapper.append(
    pageHeader("功能接入中", title, "页面外壳已经准备好，真实数据接口接通后才会显示内容。"),
    emptyState("待接入", "这里不会用假数据占位。", "clock"),
  )
  return wrapper
}

export function loadTheme(): ThemePreference {
  return normalizeThemePreference(localStorage.getItem("ui-theme"))
}

export function setTheme(theme: ThemePreference): void {
  if (theme === "system") delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  localStorage.setItem("ui-theme", theme)
}

export function setButtonBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy
  button.classList.toggle("is-busy", busy)
  button.setAttribute("aria-busy", String(busy))
}

export function formField(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const field = element("label", "form-field")
  field.append(element("span", "form-field__label", label), control)
  if (hint) field.append(element("span", "form-field__hint", hint))
  return field
}

export function textInput(name: string, placeholder = ""): HTMLInputElement {
  const input = element("input", "input-control")
  input.name = name
  input.placeholder = placeholder
  input.autocomplete = "off"
  return input
}

export function selectInput(name: string, options: Array<{ value: string; label: string }>): HTMLSelectElement {
  const select = element("select", "input-control")
  select.name = name
  options.forEach((option) => {
    const node = element("option", "", option.label)
    node.value = option.value
    select.append(node)
  })
  return select
}

export type OpenDialogOptions = {
  eyebrow?: string
  title: string
  description?: string
  content: HTMLElement
  actions?: HTMLButtonElement[]
  width?: "normal" | "wide"
}

export function openDialog(options: OpenDialogOptions): { close(): void; dialog: HTMLDialogElement } {
  const dialog = element("dialog", `app-dialog${options.width === "wide" ? " app-dialog--wide" : ""}`)
  const shell = element("div", "app-dialog__shell")
  const header = element("header", "app-dialog__header")
  const copy = element("div", "app-dialog__copy")
  if (options.eyebrow) copy.append(element("p", "eyebrow", options.eyebrow))
  copy.append(element("h2", "app-dialog__title", options.title))
  if (options.description) copy.append(element("p", "app-dialog__description", options.description))
  const closeButton = element("button", "icon-button app-dialog__close")
  closeButton.type = "button"
  closeButton.setAttribute("aria-label", "关闭")
  closeButton.append(icon("close"))
  header.append(copy, closeButton)
  const body = element("div", "app-dialog__body")
  body.append(options.content)
  shell.append(header, body)
  if (options.actions?.length) {
    const footer = element("footer", "app-dialog__footer")
    options.actions.forEach((action) => footer.append(action))
    shell.append(footer)
  }
  dialog.append(shell)
  document.body.append(dialog)
  const close = () => dialog.close()
  closeButton.addEventListener("click", close)
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close()
  })
  dialog.addEventListener("close", () => dialog.remove(), { once: true })
  dialog.showModal()
  return { close, dialog }
}

export function actionButton(label: string, tone: "primary" | "secondary" | "danger" = "secondary"): HTMLButtonElement {
  const button = element("button", `button button--${tone}`, label)
  button.type = "button"
  return button
}
