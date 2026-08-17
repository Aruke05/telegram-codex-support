import { api } from "../api.js"
import { actionButton, badge, emptyState, errorState, formField, loadingState, openDialog, pageHeader, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime } from "../format.js"
import { icon } from "../icons.js"
import type { ModelCatalogEntry, ModelInstance, ModelProvider, ModelTransport, ReasoningEffort } from "../types.js"

type Notify = (message: string) => void
type Option = { value: string; label: string }

const providerOptions: Array<{ value: ModelProvider; label: string }> = [
  { value: "openai", label: "ChatGPT / OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "anthropic", label: "Claude / Anthropic" },
  { value: "glm", label: "GLM / 智谱" },
]

const effortLabels: Record<ReasoningEffort, string> = {
  none: "不启用推理",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最大",
  ultra: "Ultra",
}

const tierLabels = { standard: "标准", fast: "Fast 加速", priority: "Priority 加速" } as const

function group(className: string, ...children: Node[]): HTMLElement {
  const node = element("div", className)
  node.append(...children)
  return node
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试"
}

export function transportOptionsFor(provider: ModelProvider): Array<{ value: ModelTransport; label: string }> {
  return provider === "openai"
    ? [{ value: "codex_cli", label: "Codex CLI（本机登录）" }, { value: "direct_api", label: "API 密钥" }]
    : [{ value: "direct_api", label: "API 密钥" }]
}

export function reasoningOptionsFor(entry: ModelCatalogEntry | undefined): Option[] {
  const values = entry?.capabilities.supportedReasoningEfforts
    ?? (["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] satisfies ReasoningEffort[])
  return values.map((value) => ({ value, label: effortLabels[value] }))
}

export function catalogModelLabel(entry: ModelCatalogEntry): string {
  const flags = [entry.hidden ? "隐藏" : "", entry.deprecated ? "已弃用" : ""].filter(Boolean)
  return flags.length ? `${entry.displayName} · ${flags.join(" · ")}` : entry.displayName
}

export function resolveCatalogSelection(
  entries: ModelCatalogEntry[],
  provider: ModelProvider,
  transport: ModelTransport,
  currentModelId: string,
  configured?: Pick<ModelInstance, "provider" | "transport" | "modelId">,
): { preset: string; custom: string } {
  const matches = entries.filter((item) => item.provider === provider && item.transport === transport)
  if (configured?.provider === provider && configured.transport === transport) {
    return matches.some((item) => item.modelId === configured.modelId)
      ? { preset: configured.modelId, custom: "" }
      : { preset: "__custom__", custom: configured.modelId }
  }
  if (matches.some((item) => item.modelId === currentModelId)) return { preset: currentModelId, custom: "" }
  return matches[0] ? { preset: matches[0].modelId, custom: "" } : { preset: "__custom__", custom: "" }
}

function refillSelect(select: HTMLSelectElement, options: Option[], value: string): void {
  select.replaceChildren()
  options.forEach((item) => {
    const option = element("option", "", item.label)
    option.value = item.value
    select.append(option)
  })
  select.value = options.some((item) => item.value === value) ? value : options[0]?.value ?? ""
}

function toggle(label: string, checked: boolean): { row: HTMLLabelElement; input: HTMLInputElement } {
  const input = element("input")
  input.type = "checkbox"
  input.checked = checked
  const row = element("label", "toggle-row")
  row.append(input, element("span", "toggle-row__track"), element("span", "toggle-row__copy", label))
  return { row, input }
}

function modelForm(
  existing: ModelInstance | undefined,
  catalog: ModelCatalogEntry[],
  onSaved: () => Promise<void>,
  notify: Notify,
): void {
  const form = element("form", "dialog-form model-dialog-form")
  const alias = textInput("alias", "例如：客服主模型")
  alias.value = existing?.alias ?? ""
  alias.required = true
  const provider = selectInput("provider", providerOptions)
  provider.value = existing?.provider ?? "openai"
  const transport = selectInput("transport", [])
  const modelPreset = selectInput("modelPreset", [])
  const customModel = textInput("modelId", "输入官方模型 ID")
  const modelPicker = group("runtime-model-picker", modelPreset, customModel)
  const reasoning = selectInput("reasoningEffort", [])
  const serviceTier = selectInput("serviceTier", [])
  const apiKey = textInput("apiKey", existing ? "留空表示不更换" : "粘贴 API 密钥")
  apiKey.type = "password"
  const credentialField = formField("API 密钥", apiKey, "只在本机加密保存，不进入迁移库、提示词或日志。")
  const maxOutputTokens = textInput("maxOutputTokens", "使用厂商默认值")
  maxOutputTokens.type = "number"; maxOutputTokens.min = "1"; maxOutputTokens.max = "262144"
  maxOutputTokens.value = existing?.parameters.maxOutputTokens == null ? "" : String(existing.parameters.maxOutputTokens)
  const temperature = textInput("temperature", "使用厂商默认值")
  temperature.type = "number"; temperature.min = "0"; temperature.max = "2"; temperature.step = "0.1"
  temperature.value = existing?.parameters.temperature == null ? "" : String(existing.parameters.temperature)
  const topP = textInput("topP", "使用厂商默认值")
  topP.type = "number"; topP.min = "0"; topP.max = "1"; topP.step = "0.05"
  topP.value = existing?.parameters.topP == null ? "" : String(existing.parameters.topP)
  const verbosity = selectInput("verbosity", [
    { value: "", label: "使用厂商默认值" }, { value: "low", label: "简洁" },
    { value: "medium", label: "适中" }, { value: "high", label: "详细" },
  ])
  verbosity.value = typeof existing?.parameters.verbosity === "string" ? existing.parameters.verbosity : ""
  const thinking = toggle("启用厂商思考参数", existing?.parameters.thinking === true)
  const enabled = toggle("启用这个模型别名", existing?.enabled ?? false)

  const selectedCatalog = (): ModelCatalogEntry | undefined => catalog.find((item) => (
    item.provider === provider.value && item.transport === transport.value && item.modelId === modelPreset.value
  ))
  const syncCapabilities = () => {
    const entry = selectedCatalog()
    const effortOptions = reasoningOptionsFor(entry)
    refillSelect(reasoning, [{ value: "", label: "不传推理强度" }, ...effortOptions], existing?.reasoningEffort ?? entry?.capabilities.defaultReasoningEffort ?? "")
    const tiers = entry?.capabilities.serviceTiers ?? (transport.value === "codex_cli"
      ? ["standard", "fast"] as const
      : provider.value === "openai" ? ["standard", "priority"] as const : ["standard"] as const)
    refillSelect(serviceTier, [
      { value: "", label: "不加速" },
      ...tiers.map((value) => ({ value, label: tierLabels[value] })),
    ], existing?.serviceTier ?? "")
  }
  const syncModels = () => {
    const matches = catalog.filter((item) => item.provider === provider.value && item.transport === transport.value)
    const selected = resolveCatalogSelection(
      catalog,
      provider.value as ModelProvider,
      transport.value as ModelTransport,
      modelPreset.value,
      existing,
    )
    refillSelect(modelPreset, [
      ...matches.map((item) => ({ value: item.modelId, label: catalogModelLabel(item) })),
      { value: "__custom__", label: "自定义模型 ID" },
    ], selected.preset)
    customModel.value = selected.custom
    customModel.hidden = modelPreset.value !== "__custom__"
    customModel.required = modelPreset.value === "__custom__"
    syncCapabilities()
  }
  const syncTransport = () => {
    const selected = existing?.provider === provider.value ? existing.transport : transport.value
    refillSelect(transport, transportOptionsFor(provider.value as ModelProvider), selected)
    credentialField.hidden = transport.value !== "direct_api"
    apiKey.required = transport.value === "direct_api" && (!existing?.credentialsConfigured || existing.provider !== provider.value)
    syncModels()
  }
  provider.addEventListener("change", syncTransport)
  transport.addEventListener("change", () => { credentialField.hidden = transport.value !== "direct_api"; syncModels() })
  modelPreset.addEventListener("change", () => {
    customModel.hidden = modelPreset.value !== "__custom__"
    customModel.required = modelPreset.value === "__custom__"
    syncCapabilities()
  })
  syncTransport()

  const basic = group("form-section",
    element("h3", "form-section__title", "身份与接入"),
    group("form-grid", formField("模型别名", alias), formField("模型厂商", provider), formField("接入方式", transport), formField("模型", modelPicker, "模型列表来自当前 Codex 安装或厂商官方目录；也可填写自定义 ID。")),
  )
  const generation = group("form-section",
    element("h3", "form-section__title", "生成参数"),
    group("form-grid", formField("推理强度", reasoning), formField("加速等级", serviceTier), formField("最大输出 Token", maxOutputTokens), formField("温度", temperature), formField("Top P", topP), formField("回答详细度", verbosity)),
    thinking.row,
  )
  const error = element("p", "form-error")
  form.append(basic, credentialField, generation, enabled.row, error)
  const cancel = actionButton("取消")
  const save = actionButton(existing ? "保存修改" : "添加模型", "primary")
  const modal = openDialog({
    eyebrow: "模型管理",
    title: existing ? `编辑 ${existing.alias}` : "添加模型别名",
    description: "运行配置和技术告警群只引用这里的模型别名。",
    content: form,
    actions: [cancel, save],
    width: "wide",
  })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    const numberValue = (input: HTMLInputElement): number | undefined => input.value === "" ? undefined : Number(input.value)
    const parameters: Record<string, unknown> = {}
    const maxTokens = numberValue(maxOutputTokens); if (maxTokens !== undefined) parameters.maxOutputTokens = maxTokens
    const temperatureValue = numberValue(temperature); if (temperatureValue !== undefined) parameters.temperature = temperatureValue
    const topPValue = numberValue(topP); if (topPValue !== undefined) parameters.topP = topPValue
    if (verbosity.value) parameters.verbosity = verbosity.value
    if (thinking.input.checked) parameters.thinking = true
    const payload: Record<string, unknown> = {
      alias: alias.value.trim(), provider: provider.value, transport: transport.value,
      modelId: modelPreset.value === "__custom__" ? customModel.value.trim() : modelPreset.value,
      reasoningEffort: reasoning.value || null, serviceTier: serviceTier.value || null,
      parameters, enabled: enabled.input.checked,
    }
    if (existing && transport.value === "codex_cli" && existing.credentialsConfigured) payload.clearCredentials = true
    if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim()
    setButtonBusy(save, true)
    void (existing ? api.updateModel(existing.id, payload) : api.createModel(payload)).then(async () => {
      notify(existing ? "模型别名已更新" : "模型别名已添加")
      modal.close()
      await onSaved()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function healthBadge(model: ModelInstance): HTMLElement {
  if (model.healthStatus === "ready") return badge("连接正常", "success")
  if (model.healthStatus === "error") return badge("连接失败", "danger")
  return badge("尚未检测", "neutral")
}

function modelCard(model: ModelInstance, catalog: ModelCatalogEntry[], refresh: () => Promise<void>, notify: Notify): HTMLElement {
  const card = element("article", "entity-card model-instance-card")
  const identity = element("div", "entity-card__identity")
  const avatar = element("span", "entity-avatar model-instance-card__avatar")
  avatar.append(icon(model.transport === "codex_cli" ? "cpu" : "sparkles"))
  const copy = element("div")
  copy.append(element("h3", "entity-card__title", model.alias), element("p", "entity-card__subtitle", `${providerOptions.find((item) => item.value === model.provider)?.label} · ${model.transport === "codex_cli" ? "Codex CLI" : "API 密钥"}`))
  identity.append(avatar, copy)
  const state = element("div", "model-instance-card__state")
  state.append(healthBadge(model), badge(model.enabled ? "已启用" : "已停用", model.enabled ? "success" : "neutral"))
  const head = element("div", "entity-card__head")
  head.append(identity, state)
  const meta = element("div", "entity-meta")
  meta.append(
    element("span", "", model.modelId),
    element("span", "", `推理 ${model.reasoningEffort ? effortLabels[model.reasoningEffort] : "默认"}`),
    element("span", "", model.serviceTier ? tierLabels[model.serviceTier] : "不加速"),
    element("span", "", model.transport === "direct_api" ? (model.credentialsConfigured ? `密钥 ${model.credentialHint}` : "未配置密钥") : "使用本机登录"),
  )
  const status = element("p", "model-instance-card__message", model.healthMessage)
  if (model.lastCheckedAt) status.append(document.createTextNode(` · ${formatDateTime(model.lastCheckedAt)}`))
  const actions = element("div", "entity-actions")
  const test = actionButton("检测连接")
  const edit = actionButton("编辑")
  const remove = actionButton("删除", "danger")
  test.addEventListener("click", () => {
    setButtonBusy(test, true)
    void api.testModel(model.id).then(async () => { notify("模型连接检测完成"); await refresh() })
      .catch((cause: unknown) => notify(errorText(cause))).finally(() => setButtonBusy(test, false))
  })
  edit.addEventListener("click", () => modelForm(model, catalog, refresh, notify))
  remove.addEventListener("click", () => {
    const content = element("div", "inline-alert inline-alert--danger", "回答模型、记忆模型或白名单群仍在使用时不能删除。")
    const cancel = actionButton("取消")
    const confirm = actionButton("确认删除", "danger")
    const modal = openDialog({ eyebrow: "删除确认", title: `删除 ${model.alias}`, content, actions: [cancel, confirm] })
    cancel.addEventListener("click", modal.close)
    confirm.addEventListener("click", () => {
      setButtonBusy(confirm, true)
      void api.deleteModel(model.id).then(async () => { notify("模型别名已删除"); modal.close(); await refresh() })
        .catch((cause: unknown) => notify(errorText(cause))).finally(() => setButtonBusy(confirm, false))
    })
  })
  actions.append(test, edit, remove)
  card.append(head, meta, status, actions)
  return card
}

export function renderModels(container: HTMLElement, notify: Notify): void {
  let catalog: ModelCatalogEntry[] = []
  const content = element("section", "page-content models-page")
  const header = element("div", "page-header-row models-page__header")
  const headerActions = element("div", "entity-actions")
  const refreshCatalog = actionButton("刷新模型目录")
  const add = actionButton("添加模型别名", "primary")
  headerActions.append(refreshCatalog, add)
  header.append(pageHeader("多厂商模型", "模型管理", "统一配置模型别名、厂商、接入方式、推理强度和加速参数。"), headerActions)
  const catalogState = element("div", "models-page__catalog-state")
  const body = element("div", "model-instance-grid")
  content.append(header, catalogState, body)
  replaceChildren(container, content)

  const load = async (): Promise<void> => {
    replaceChildren(body, loadingState(3))
    try {
      const [{ models }, catalogResult] = await Promise.all([api.getModels(), api.getModelCatalog({ includeHidden: true })])
      catalog = catalogResult.entries
      if (catalogResult.stale || catalogResult.error) {
        catalogState.textContent = catalogResult.error ? `正在使用上次模型目录 · ${catalogResult.error}` : "正在使用缓存模型目录"
        catalogState.className = "inline-alert inline-alert--warning models-page__catalog-state"
      } else {
        catalogState.className = "models-page__catalog-state"
        catalogState.textContent = catalogResult.refreshedAt ? `模型目录更新于 ${formatDateTime(catalogResult.refreshedAt)} · 共 ${catalog.length} 个模型` : "模型目录等待首次刷新"
      }
      replaceChildren(body, ...(models.length ? models.map((item) => modelCard(item, catalog, load, notify)) : [emptyState("还没有模型别名", "先添加回答模型和记忆模型，再到运行配置绑定。", "cpu")]))
    } catch (cause) {
      replaceChildren(body, errorState(errorText(cause), () => { void load() }))
    }
  }
  add.addEventListener("click", () => modelForm(undefined, catalog, load, notify))
  refreshCatalog.addEventListener("click", () => {
    setButtonBusy(refreshCatalog, true)
    void api.refreshModelCatalog().then(async (result) => {
      await load()
      if (result.stale) {
        catalogState.textContent = result.error ?? "Codex 模型目录刷新失败，正在使用缓存"
        catalogState.className = "inline-alert inline-alert--warning models-page__catalog-state"
        notify(result.error ?? "Codex 模型目录刷新失败")
      } else notify(`已拉取 ${result.entries.length} 个 Codex 模型`)
    }).catch((cause: unknown) => notify(errorText(cause))).finally(() => setButtonBusy(refreshCatalog, false))
  })
  void load()
}
