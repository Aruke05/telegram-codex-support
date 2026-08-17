import { api } from "../api.js"
import { actionButton, badge, errorState, formField, loadingState, pageHeader, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { icon } from "../icons.js"
import { formatDateTime, shortHash } from "../format.js"
import type { ModelInstance, ModelPurpose, ProjectView, RuntimeModelBinding, RuntimeSettings, RuntimeStatus } from "../types.js"

type Notify = (message: string) => void

function toggle(label: string, checked: boolean): { row: HTMLLabelElement; input: HTMLInputElement } {
  const input = element("input"); input.type = "checkbox"; input.checked = checked
  const row = element("label", "toggle-row")
  row.append(input, element("span", "toggle-row__track"), element("span", "toggle-row__copy", label))
  return { row, input }
}

function bindingCard(binding: RuntimeModelBinding, models: ModelInstance[], notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const isAnswer = binding.purpose === "answer"
  const selectedModel = models.find((item) => item.id === binding.modelInstanceId)
  const card = element("article", "runtime-model-card")
  const head = element("div", "runtime-model-card__head")
  const marker = element("span", `runtime-model-card__icon runtime-model-card__icon--${binding.purpose}`)
  marker.append(icon(isAnswer ? "reply" : "memory"))
  const copy = element("div", "runtime-model-card__copy")
  copy.append(
    element("p", "eyebrow", isAnswer ? "实时链路" : "后台链路"),
    element("h2", "runtime-model-card__title", isAnswer ? "回答模型" : "记忆模型"),
    element("p", "runtime-model-card__description", isAnswer
      ? "判断是否回复、分析代码、生成中文答复。"
      : "整理人工纠错、增加记忆、自动学习和冲突判断。"),
  )
  head.append(marker, copy, badge(binding.enabled ? "已启用" : "已停用", binding.enabled ? "success" : "neutral"))

  const form = element("form", "runtime-model-form")
  const availableModels = models.filter((item) => item.enabled)
  const model = selectInput("modelInstanceId", availableModels.map((item) => ({
    value: item.id,
    label: `${item.alias} · ${item.modelId} · ${item.transport === "codex_cli" ? "Codex CLI" : "API"}`,
  })))
  model.required = true
  model.value = binding.modelInstanceId
  const timeout = textInput("timeoutSeconds", "180"); timeout.type = "number"; timeout.min = "30"; timeout.max = "3600"; timeout.value = String(binding.timeoutSeconds)
  const concurrency = textInput("maxConcurrency", "2"); concurrency.type = "number"; concurrency.min = "1"; concurrency.max = "8"; concurrency.value = String(binding.maxConcurrency)
  const enabled = toggle("启用这条运行链路", binding.enabled)
  const save = actionButton("保存运行绑定", "primary"); save.type = "submit"
  const error = element("p", "form-error")
  form.append(
    element("div", "form-grid runtime-model-form__grid"),
  )
  form.firstElementChild?.append(
    formField("模型别名", model, selectedModel ? `当前使用 ${selectedModel.modelId}，模型参数请到模型管理修改。` : "当前绑定模型不可用，请重新选择。"),
    formField("超时（秒）", timeout),
    formField("最大并发", concurrency),
  )
  const footer = element("div", "runtime-model-form__footer"); footer.append(enabled.row, save)
  form.append(footer, error)
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    void api.updateModelBinding(binding.purpose, {
      modelInstanceId: model.value,
      timeoutSeconds: Number(timeout.value),
      maxConcurrency: Number(concurrency.value),
      enabled: enabled.input.checked,
    }).then(async () => { notify(isAnswer ? "回答模型绑定已保存" : "记忆模型绑定已保存"); await refresh() })
      .catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : "保存失败" })
      .finally(() => setButtonBusy(save, false))
  })
  card.append(head, form)
  return card
}

function runtimeCard(settings: RuntimeSettings, notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const card = element("article", "panel runtime-settings-card")
  const head = element("div", "panel__header")
  const title = element("div"); title.append(element("p", "eyebrow", "运行闭环"), element("h2", "panel__title", "自动客服开关"))
  head.append(title, badge(settings.telegramEnabled ? "监听已开启" : "监听已关闭", settings.telegramEnabled ? "success" : "warning"))
  const form = element("form", "runtime-settings-form")
  const telegram = toggle("Telegram 消息监听", settings.telegramEnabled)
  const sync = toggle("每 30 分钟错峰同步双仓（固定开启）", true); sync.input.disabled = true
  const learning = toggle("后台自动学习", settings.autoLearningEnabled)
  const groupShutdown = toggle("每日自动关闭所有群", settings.dailyGroupShutdownEnabled)
  const interval = textInput("learningIntervalSeconds"); interval.type = "number"; interval.min = "30"; interval.max = "86400"; interval.value = String(settings.learningIntervalSeconds)
  const batch = textInput("learningBatchSize"); batch.type = "number"; batch.min = "2"; batch.max = "50"; batch.value = String(settings.learningBatchSize)
  const debounce = textInput("messageDebounceMs"); debounce.type = "number"; debounce.min = "0"; debounce.max = "300000"; debounce.value = String(settings.messageDebounceMs)
  const progressNotification = textInput("progressNotificationSeconds"); progressNotification.type = "number"; progressNotification.min = "30"; progressNotification.max = "3600"; progressNotification.value = String(settings.progressNotificationSeconds)
  const groupShutdownTime = textInput("dailyGroupShutdownTime"); groupShutdownTime.type = "time"; groupShutdownTime.value = settings.dailyGroupShutdownTime
  const lastShutdown = settings.dailyGroupShutdownLastRunAt
    ? `上次执行 ${formatDateTime(settings.dailyGroupShutdownLastRunAt)}，停用 ${settings.dailyGroupShutdownLastDisabledCount} 个群`
    : "尚未执行"
  const toggles = element("div", "runtime-toggle-grid"); toggles.append(telegram.row, sync.row, learning.row, groupShutdown.row)
  const fields = element("div", "form-grid"); fields.append(
    formField("学习间隔（秒）", interval),
    formField("每批记录数", batch),
    formField("合并补充消息（毫秒）", debounce, "同一群连续补充会先短暂合并"),
    formField("排查提示等待（秒）", progressNotification, "生成超过该时间仍未完成时，在原消息下发送一次提示"),
    formField("每日关闭时间", groupShutdownTime, `中国标准时间（${settings.dailyGroupShutdownTimezone}）· ${lastShutdown}`),
  )
  const save = actionButton("保存运行配置", "primary"); save.type = "submit"
  const error = element("p", "form-error")
  const footer = element("div", "runtime-settings-form__footer"); footer.append(element("p", "runtime-settings-form__note", "配置保存后运行管理器会自动读取，无需改代码。"), save)
  form.append(toggles, fields, footer, error)
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    void api.updateRuntimeSettings({
      telegramEnabled: telegram.input.checked,
      codeSyncEnabled: true,
      autoLearningEnabled: learning.input.checked,
      learningIntervalSeconds: Number(interval.value),
      learningBatchSize: Number(batch.value),
      messageDebounceMs: Number(debounce.value),
      progressNotificationSeconds: Number(progressNotification.value),
      dailyGroupShutdownEnabled: groupShutdown.input.checked,
      dailyGroupShutdownTime: groupShutdownTime.value,
    }).then(async () => { notify("运行配置已保存"); await refresh() })
      .catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : "保存失败" })
      .finally(() => setButtonBusy(save, false))
  })
  card.append(head, form)
  return card
}

function statusPanel(status: RuntimeStatus, projects: ProjectView[], notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const card = element("article", "panel runtime-status-card")
  const head = element("div", "panel__header")
  const title = element("div"); title.append(element("p", "eyebrow", "实时检查"), element("h2", "panel__title", "运行状态"))
  head.append(title, badge(status.telegram.running ? "客服循环运行中" : "客服循环未启动", status.telegram.running ? "success" : "danger"))
  const facts = element("div", "runtime-status-grid")
  const fact = (label: string, value: string, detail: string, tone: "success" | "warning" | "neutral") => {
    const node = element("div", "runtime-status-fact")
    node.append(element("span", "runtime-status-fact__label", label), badge(value, tone), element("small", "runtime-status-fact__detail", detail))
    return node
  }
  const syncRun = status.codeSync.lastRun
  const syncHealthy = syncRun?.status === "published"
  const syncState = syncRun?.status === "fallback" ? "使用旧快照" : syncHealthy ? "同步正常" : syncRun ? "需检查" : "尚无记录"
  const syncDetail = syncRun
    ? syncRun.safeSummary
      ? `${syncRun.branch} · ${syncRun.safeSummary}`
      : `${syncRun.branch} · 后端 ${shortHash(syncRun.backendCommit ?? "")} · 前端 ${shortHash(syncRun.frontendCommit ?? "")}`
    : "每个启用服务每 30 分钟错峰自动同步"
  facts.append(
    fact("Codex", status.codex.available && status.codex.authenticated ? "可用" : "需处理", status.codex.version || status.codex.message, status.codex.available && status.codex.authenticated ? "success" : "warning"),
    fact("Telegram", `${status.telegram.botLoops} Bot · ${status.telegram.userConnections} 个人号`, status.telegram.lastUpdateAt ? `最近消息 ${formatDateTime(status.telegram.lastUpdateAt)}` : "等待白名单群消息", status.telegram.running ? "success" : "warning"),
    fact("代码同步", syncState, syncDetail, syncHealthy ? "success" : syncRun ? "warning" : "neutral"),
    fact("自动学习", `${status.learning.pending} 待整理`, status.learning.reference.lastRun?.summary ?? `${status.learning.completed} 条已完成`, status.learning.reference.lastRun?.status === "failed" ? "warning" : "success"),
  )
  const learningBoard = element("section", "runtime-learning-board")
  const learningHead = element("div", "runtime-learning-board__head")
  const styleLabel = status.learning.activeStyle ? `风格 v${status.learning.activeStyle.version}` : "基线风格"
  const learningCopy = element("div")
  learningCopy.append(element("p", "eyebrow", "学习运行态"), element("h3", "runtime-learning-board__title", "参考回复与旧队列分开追踪"))
  learningHead.append(learningCopy, badge(styleLabel, status.learning.activeStyle ? "success" : "neutral"))
  const queues = element("div", "runtime-learning-queues")
  const queueCard = (title: string, description: string, counts: { pending: number; processing: number; failed: number; completed: number }) => {
    const node = element("article", "runtime-learning-queue")
    const heading = element("div", "runtime-learning-queue__heading")
    heading.append(element("strong", "", title), element("span", "", description))
    node.append(heading)
    const values = element("dl", "runtime-learning-queue__facts")
    ;[["待处理", counts.pending], ["处理中", counts.processing], ["失败", counts.failed], ["完成", counts.completed]].forEach(([label, value]) => {
      const row = element("div", "")
      row.append(element("dt", "", String(label)), element("dd", "", String(value)))
      values.append(row)
    })
    node.append(values)
    return node
  }
  queues.append(
    queueCard("参考回复队列", status.learning.reference.busy ? "当前批次处理中" : status.learning.reference.running ? "调度已启动 · 等待下一轮" : "调度未启动", status.learning.reference),
    queueCard("旧学习队列", "兼容保留，不参与参考回复分类", status.learning.legacy),
  )
  const runState = element("p", "runtime-learning-board__last-run")
  const referenceRun = status.learning.reference.lastRun
  runState.textContent = referenceRun
    ? `最近运行：${formatDateTime(referenceRun.startedAt)} · ${referenceRun.status === "failed" ? "失败" : referenceRun.status === "running" ? "运行中" : "完成"} · ${referenceRun.summary}`
    : "最近运行：尚无参考回复学习记录"
  learningBoard.append(learningHead, queues, runState)
  const actions = element("div", "runtime-status-actions")
  const service = selectInput("syncService", projects.flatMap((project) => project.services.filter((item) => item.enabled).map((item) => ({ value: item.id, label: `${item.name} · ${item.branch}` }))))
  const check = actionButton("检测 Codex")
  const sync = actionButton("同步所选代码")
  const learn = actionButton("立即自动学习", "primary")
  actions.append(formField("手动同步服务", service), check, sync, learn)
  const run = <T>(button: HTMLButtonElement, action: () => Promise<T>, success: (value: T) => string) => {
    setButtonBusy(button, true)
    void action().then(async (value) => { notify(success(value)); await refresh() })
      .catch((cause: unknown) => notify(cause instanceof Error ? cause.message : "执行失败"))
      .finally(() => setButtonBusy(button, false))
  }
  check.addEventListener("click", () => run(check, () => api.checkCodex(), (value) => value.authenticated ? "Codex 可用并已登录" : value.message))
  sync.addEventListener("click", () => {
    if (!service.value) return notify("先选择服务")
    run(sync, () => api.runCodeSync(service.value), (value) => {
      const backend = value.repositories.find((item) => item.role === "backend")
      const frontend = value.repositories.find((item) => item.role === "frontend")
      const state = value.syncState === "fresh" ? "已同步" : "远端同步失败，已使用历史完整快照"
      return `${state} ${value.branch} · 后端 ${shortHash(backend?.commit ?? "")} · 前端 ${shortHash(frontend?.commit ?? "")}`
    })
  })
  learn.addEventListener("click", () => run(learn, () => api.runLearning(), (value) => `已整理 ${value.processed} 条，新增 ${value.createdVersions} 条记忆候选、${value.styleVersions} 个风格版本`))
  card.append(head, facts, learningBoard, actions)
  return card
}

export function renderRuntime(container: HTMLElement, notify: Notify): void {
  const content = element("section", "page-content runtime-page")
  content.append(pageHeader("运行闭环", "运行配置", "回答和记忆分别选择模型管理中的别名；新配置只影响之后开始的任务。"))
  const body = element("div", "runtime-page__body")
  content.append(body); replaceChildren(container, content)

  const load = async (): Promise<void> => {
    replaceChildren(body, loadingState(3))
    try {
      const [{ bindings }, { models }, settings, status, { projects }] = await Promise.all([
        api.getModelBindings(), api.getModels(), api.getRuntimeSettings(), api.getRuntimeStatus(), api.getProjects(),
      ])
      const grid = element("div", "runtime-model-grid")
      ;(["answer", "memory"] as ModelPurpose[]).forEach((purpose) => {
        const binding = bindings.find((item) => item.purpose === purpose)
        if (binding) grid.append(bindingCard(binding, models, notify, load))
      })
      replaceChildren(body, statusPanel(status, projects, notify, load), grid, runtimeCard(settings, notify, load))
    } catch (cause) {
      replaceChildren(body, errorState(cause instanceof Error ? cause.message : "配置加载失败", () => { void load() }))
    }
  }
  void load()
}
