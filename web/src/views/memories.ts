import { api } from "../api.js"
import { actionButton, badge, emptyState, formField, loadingState, openDialog, pageHeader, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { directiveDeleteConfirmation, directivePresentation } from "../directive-presentation.js"
import { formatDateTime } from "../format.js"
import { icon } from "../icons.js"
import { learningObservationFacts } from "../learning-source-labels.js"
import type {
  Directive,
  LearningObservation,
  MemoryEvent,
  MemoryEvidenceSummary,
  MemoryStatus,
  MemoryView,
  OperatorStyleVersion,
  ShadowLearningReport,
} from "../types.js"

type MemoryTab = MemoryStatus | "observations" | "styles" | "directives" | "reports"
type Notify = (message: string) => void

const labels: Record<MemoryTab, string> = {
  active: "当前",
  candidate: "候选",
  conflict: "冲突",
  superseded: "已替代",
  disabled: "已停用",
  observations: "学习观察",
  styles: "风格版本",
  directives: "固定规则",
  reports: "学习报告",
}

function reportCard(report: ShadowLearningReport, notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const row = element("article", "memory-card")
  const title = element("div", "memory-card__title-row")
  title.append(element("h3", "memory-card__title", report.triggerType === "scheduled" ? "首份学习报告" : "手动学习报告"),
    badge(report.status === "completed" ? "已完成" : report.status === "failed" ? "失败" : report.status === "running" ? "生成中" : "等待生成",
      report.status === "completed" ? "success" : report.status === "failed" ? "danger" : "warning"))
  row.append(title, element("p", "memory-card__content", `截止 ${formatDateTime(report.cutoffAt)} · ${report.sampleCount} 个拆分问题`))
  if (report.renderedMarkdown) row.append(element("pre", "memory-card__content", report.renderedMarkdown))
  if (report.errorMessage) row.append(element("p", "form-error", report.errorMessage))
  if (report.status === "failed") {
    const actions = element("div", "memory-card__footer")
    const retry = actionButton("继续生成", "primary")
    retry.addEventListener("click", () => {
      setButtonBusy(retry, true)
      void api.retryLearningReport(report.id).then(async (result) => {
        if (result.status === "failed") throw new Error(result.errorMessage ?? "报告生成失败")
        notify("学习报告已从上次完成的批次继续生成")
        await refresh()
      }).catch((error: unknown) => notify(error instanceof Error ? error.message : "报告生成失败"))
        .finally(() => setButtonBusy(retry, false))
    })
    actions.append(retry)
    row.append(actions)
  }
  return row
}

function memoryStatus(memory: MemoryView): ReturnType<typeof badge> {
  if (memory.status === "active") return badge("当前有效", "success")
  if (memory.status === "candidate") return badge("候选", "warning")
  if (memory.status === "conflict") return badge("有冲突", "danger")
  if (memory.status === "superseded") return badge("已替代", "neutral")
  return badge("已停用", "neutral")
}

function sourceLabel(source: MemoryView["source"]): string {
  const values: Partial<Record<MemoryView["source"], string>> = {
    human_rule: "人工新增", correction: "人工纠正", code: "代码证据", document: "接口文档",
    magicbook: "MagicBook", ai_observation: "AI 观察", reply: "历史回复", attachment: "附件",
  }
  return values[source] ?? source
}

function addMemoryDialog(tab: MemoryTab, notify: Notify, refresh: () => Promise<void>): void {
  const form = element("form", "dialog-form")
  const kind = selectInput("kind", [
    { value: "memory", label: "普通记忆（可版本化）" },
    { value: "directive", label: "强制规则（AI 不可修改）" },
  ])
  kind.value = tab === "directives" ? "directive" : "memory"
  const title = textInput("title", "一句话说明主题")
  title.required = true
  const content = element("textarea", "input-control textarea-control")
  content.name = "content"; content.rows = 7; content.required = true; content.placeholder = "写清楚正确结论、适用条件和后台菜单路径"
  const scope = textInput("scope", "global 或服务名")
  scope.value = "global"; scope.required = true
  const region = textInput("region", "可留空")
  const branch = textInput("branch", "可留空")
  const risk = selectInput("risk", [{ value: "low", label: "低风险" }, { value: "medium", label: "中风险" }, { value: "high", label: "高风险" }])
  const priority = selectInput("priority", [{ value: "100", label: "最高" }, { value: "80", label: "高" }, { value: "60", label: "普通" }])
  priority.value = "80"
  const conditional = element("div", "form-grid")
  const renderConditional = () => {
    conditional.replaceChildren()
    if (kind.value === "directive") conditional.append(formField("优先级", priority), formField("适用范围", scope))
    else conditional.append(formField("风险", risk), formField("适用范围", scope), formField("地区", region), formField("Git 分支", branch))
  }
  kind.addEventListener("change", renderConditional)
  renderConditional()
  const error = element("p", "form-error")
  form.append(formField("记忆类型", kind), formField("标题", title), formField("内容", content), conditional, error)
  const cancel = actionButton("取消")
  const save = actionButton("保存", "primary")
  const modal = openDialog({ eyebrow: "AI 记忆库", title: "新增记忆", description: "普通记忆保留版本；强制规则只有人工可以启停。", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    const operation = kind.value === "directive"
      ? api.createDirective({ title: title.value.trim(), content: content.value.trim(), scope: scope.value.trim(), source: "human", priority: Number(priority.value), actor: "后台管理员" })
      : api.createMemory({ title: title.value.trim(), content: content.value.trim(), scope: scope.value.trim(), region: region.value.trim() || null, branch: branch.value.trim() || null, risk: risk.value, confidence: 1, source: "human_rule", actor: "后台管理员" })
    setButtonBusy(save, true)
    void operation.then(async () => {
      notify(kind.value === "directive" ? "强制规则已保存" : "记忆已保存为当前版本")
      modal.close()
      await refresh()
    }).catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : "保存失败，请重试" }).finally(() => setButtonBusy(save, false))
  })
}

function eventTimeline(events: MemoryEvent[]): HTMLElement {
  const timeline = element("div", "evidence-timeline")
  if (!events.length) return emptyState("没有证据记录", "这条记忆还没有关联事件。", "clock")
  events.forEach((event) => {
    const item = element("article", "evidence-item")
    const marker = element("span", "evidence-item__marker")
    const body = element("div", "evidence-item__body")
    const head = element("div", "evidence-item__head")
    head.append(badge(sourceLabel(event.type), event.type === "correction" || event.type === "human_rule" ? "accent" : "neutral"), element("time", "", formatDateTime(event.occurredAt)))
    body.append(head, element("p", "evidence-item__text", event.content), element("span", "evidence-item__actor", `${event.actor}${event.codeRevision ? ` · ${event.codeRevision}` : ""}`))
    item.append(marker, body)
    timeline.append(item)
  })
  return timeline
}

function evidenceReferences(evidence: MemoryEvidenceSummary): HTMLElement {
  const section = element("section", "memory-evidence-references")
  section.append(element("h3", "section-title", "可追溯来源"))
  if (!evidence.codeEvidence.length && !evidence.sourceThreads.length) {
    section.append(emptyState("没有关联来源", "这条记忆尚未关联代码位置或客服问题。", "branch"))
    return section
  }
  const grid = element("div", "memory-evidence-reference-grid")
  evidence.codeEvidence.forEach((item) => {
    const card = element("article", "memory-evidence-reference")
    card.append(
      badge("代码证据", "accent"),
      element("strong", "memory-evidence-reference__title", item.path),
      element("span", "memory-evidence-reference__meta", `${item.codeRevision ?? "未记录提交"} · 快照 ${item.snapshotId}`),
    )
    grid.append(card)
  })
  evidence.sourceThreads.forEach((item) => {
    const card = element("article", "memory-evidence-reference")
    card.append(
      badge("来源问题", "neutral"),
      element("strong", "memory-evidence-reference__title", `问题线程 ${item.threadId}`),
      element("span", "memory-evidence-reference__meta", `学习观察 ${item.observationId}`),
    )
    grid.append(card)
  })
  section.append(grid)
  return section
}

function memoryDetail(memory: MemoryView, notify: Notify, refresh: () => Promise<void>): void {
  const body = element("div", "memory-detail")
  const conclusion = element("section", "memory-conclusion")
  conclusion.append(element("span", "memory-conclusion__label", `当前查看 · v${memory.version}`), element("p", "memory-conclusion__text", memory.content))
  const metadata = element("div", "memory-detail__meta")
  metadata.append(memoryStatus(memory), badge(sourceLabel(memory.source), "accent"), badge(memory.risk === "high" ? "高风险" : memory.risk === "medium" ? "中风险" : "低风险", memory.risk === "high" ? "danger" : memory.risk === "medium" ? "warning" : "neutral"))
  body.append(metadata, conclusion)
  if (memory.conflictReason) body.append(element("div", "inline-alert inline-alert--danger", memory.conflictReason))
  if (memory.risk === "high") body.append(element("div", "inline-alert inline-alert--danger", "高风险记忆不会自动生效；设为当前必须由管理员明确审核。"))
  const info = element("dl", "compact-details")
  ;[
    ["适用范围", memory.scope], ["地区", memory.region ?? "全部"], ["Git 分支", memory.branch ?? "全部"],
    ["证据数量", String(memory.evidenceCount)], ["历史版本", String(memory.previousVersionCount)], ["生效时间", formatDateTime(memory.validFrom)],
  ].forEach(([label, value]) => { const item = element("div", "compact-details__item"); item.append(element("dt", "", label), element("dd", "", value)); info.append(item) })
  body.append(info, element("h3", "section-title", "证据和修改记录"))
  const timeline = element("div", "evidence-loading"); timeline.append(loadingState(2)); body.append(timeline)
  const close = actionButton("关闭")
  const actionLabel = memory.status === "active"
    ? "停用"
    : memory.status === "candidate" || memory.status === "conflict"
      ? "审核并设为当前"
      : "恢复为当前"
  const change = actionButton(actionLabel, memory.status === "active" ? "danger" : "primary")
  const modal = openDialog({ eyebrow: "AI 记忆库", title: memory.title, description: `版本 ${memory.version} · ${memory.topicKey.slice(0, 10)}`, content: body, actions: [close, change], width: "wide" })
  close.addEventListener("click", modal.close)
  change.addEventListener("click", () => {
    setButtonBusy(change, true)
    void api.setMemoryStatus(memory.id, memory.status === "active" ? "disabled" : "active").then(async () => {
      notify(memory.status === "active" ? "记忆已停用" : "已设为当前版本")
      modal.close()
      await refresh()
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "操作失败")).finally(() => setButtonBusy(change, false))
  })
  void api.getMemory(memory.id).then((result) => replaceChildren(timeline, eventTimeline(result.events), evidenceReferences(result.evidence))).catch(() => replaceChildren(timeline, emptyState("证据加载失败", "关闭后重试。", "refresh")))
}

function memoryCard(memory: MemoryView, notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const card = element("article", "memory-card")
  const head = element("div", "memory-card__head")
  const title = element("div", "memory-card__identity")
  title.append(element("span", "memory-card__version", `v${memory.version}`), element("h3", "memory-card__title", memory.title))
  head.append(title, memoryStatus(memory))
  const text = element("p", "memory-card__content", memory.content)
  const meta = element("div", "memory-card__meta")
  meta.append(badge(sourceLabel(memory.source), "neutral"), element("span", "", memory.scope), element("span", "", memory.branch ?? "全部分支"), element("span", "", `${memory.evidenceCount} 条证据`))
  const footer = element("div", "memory-card__footer")
  footer.append(element("time", "", formatDateTime(memory.createdAt)))
  const open = actionButton("查看证据")
  open.addEventListener("click", () => memoryDetail(memory, notify, refresh))
  footer.append(open)
  card.append(head, text, meta, footer)
  return card
}

function observationStatus(observation: LearningObservation): ReturnType<typeof badge> {
  if (observation.processingStatus === "completed") return badge("学习完成", "success")
  if (observation.processingStatus === "failed") return badge("处理失败", "danger")
  if (observation.processingStatus === "running") return badge("处理中", "accent")
  if (observation.processingStatus === "ignored") return badge("已忽略", "neutral")
  return badge("等待学习", "warning")
}

function observationCard(observation: LearningObservation): HTMLElement {
  const card = element("article", "learning-observation-card")
  const head = element("div", "learning-observation-card__head")
  const identity = element("div", "learning-observation-card__identity")
  identity.append(element("h3", "memory-card__title", `学习观察 · ${observation.sourceRole}`), element("span", "learning-observation-card__id", observation.id))
  head.append(identity, observationStatus(observation))
  const facts = element("dl", "learning-observation-card__facts")
  learningObservationFacts(observation).forEach(([label, value]) => {
    const item = element("div", "")
    item.append(element("dt", "", label), element("dd", "", value))
    facts.append(item)
  })
  const footer = element("div", "learning-observation-card__footer")
  const risk = observation.terminalResult?.risk ?? null
  footer.append(
    badge(risk === "high" ? "高风险" : risk === "medium" ? "中风险" : risk === "low" ? "低风险" : "风险待评估", risk === "high" ? "danger" : risk === "medium" ? "warning" : "neutral"),
    element("span", "", `来源用户 ID ${observation.sourceTelegramUserId}`),
    element("time", "", formatDateTime(observation.createdAt)),
  )
  card.append(head, facts, footer)
  return card
}

function styleStatus(style: OperatorStyleVersion): ReturnType<typeof badge> {
  if (style.status === "active") return badge("当前生效", "success")
  if (style.status === "candidate") return badge("候选", "warning")
  return badge("已替代", "neutral")
}

function styleVersionCard(style: OperatorStyleVersion): HTMLElement {
  const card = element("article", "operator-style-card")
  const head = element("div", "operator-style-card__head")
  const title = element("div", "operator-style-card__title")
  title.append(element("span", "memory-card__version", `v${style.version}`), element("h3", "memory-card__title", "客服回复风格"))
  head.append(title, styleStatus(style))
  const profile = element("dl", "operator-style-card__profile")
  const facts: Array<[string, string]> = [
    ["沟通姿态", style.profile.interactionStyle.collaboration === "shared_problem_solving" ? "一起解决" : "直接交付"],
    ["行动表达", style.profile.interactionStyle.actionLayout === "conversational" ? "自然群聊" : "需要时列步骤"],
    ["语气柔化", style.profile.interactionStyle.softening === "contextual" ? "按语境自然使用" : "不刻意添加"],
    ["短句上限", `${style.profile.shortSentenceMaxChars} 字`],
    ["简单回复", `${style.profile.simpleReply.maxLines} 行内`],
    ["复杂回复", `${style.profile.complexReply.maxMessages} 条消息 · 每条 ${style.profile.complexReply.maxLinesPerMessage} 行`],
    ["分段方式", style.profile.segmentation === "line_break" ? "换行分段" : "单条消息"],
    ["允许短语", style.profile.allowedPhrases.length ? style.profile.allowedPhrases.join("、") : "无"],
    ["样本范围", `${style.sampleCount} 条 · ${style.sourceUserCount} 位来源 · ${style.threadCount} 个问题`],
  ]
  facts.forEach(([label, value]) => {
    const item = element("div", "")
    item.append(element("dt", "", label), element("dd", "", value))
    profile.append(item)
  })
  const footer = element("div", "operator-style-card__footer")
  footer.append(element("span", "", `创建 ${formatDateTime(style.createdAt)}`))
  if (style.activatedAt) footer.append(element("span", "", `生效 ${formatDateTime(style.activatedAt)}`))
  card.append(head, profile, footer)
  return card
}

function editDirectiveDialog(directive: Directive, notify: Notify, refresh: () => Promise<void>): void {
  const form = element("form", "dialog-form")
  const title = textInput("title", "一句话说明规则")
  title.value = directive.title; title.required = true
  const content = element("textarea", "input-control textarea-control")
  content.name = "content"; content.rows = 7; content.required = true; content.value = directive.content
  const scope = textInput("scope", "global 或服务名")
  scope.value = directive.scope; scope.required = true
  const priority = textInput("priority", "1-100")
  priority.type = "number"; priority.min = "1"; priority.max = "100"; priority.step = "1"; priority.value = String(directive.priority); priority.required = true
  const fields = element("div", "form-grid")
  fields.append(formField("优先级", priority), formField("适用范围", scope))
  const error = element("p", "form-error")
  form.append(formField("标题", title), formField("内容", content), fields, error)
  const cancel = actionButton("取消")
  const save = actionButton("保存修改", "primary")
  const state = directivePresentation(directive.enabled).status
  const modal = openDialog({
    eyebrow: "固定规则",
    title: "编辑人工规则",
    description: `${state}，保存修改不会改变启停状态`,
    content: form,
    actions: [cancel, save],
    width: "wide",
  })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    setButtonBusy(save, true)
    void api.updateDirective(directive.id, {
      title: title.value.trim(),
      content: content.value.trim(),
      scope: scope.value.trim(),
      priority: Number(priority.value),
    }).then(async () => {
      notify("固定规则已更新")
      modal.close()
      await refresh()
    }).catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "保存失败，请重试"
    }).finally(() => setButtonBusy(save, false))
  })
}

function deleteDirectiveDialog(directive: Directive, notify: Notify, refresh: () => Promise<void>): void {
  const copy = directiveDeleteConfirmation(directive.title)
  const warning = element("div", "inline-alert inline-alert--danger", copy.warning)
  const error = element("p", "form-error")
  const content = element("div", "dialog-form")
  content.append(warning, error)
  const cancel = actionButton("取消")
  const confirm = actionButton("确认删除", "danger")
  const modal = openDialog({ eyebrow: "删除确认", title: copy.title, content, actions: [cancel, confirm] })
  cancel.addEventListener("click", modal.close)
  confirm.addEventListener("click", () => {
    error.textContent = ""
    setButtonBusy(confirm, true)
    void api.deleteDirective(directive.id).then(async () => {
      notify("规则已删除")
      modal.close()
      await refresh()
    }).catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "删除失败，请重试"
    }).finally(() => setButtonBusy(confirm, false))
  })
}

function directiveRow(directive: Directive, notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const row = element("article", "directive-card")
  const marker = element("span", "directive-card__marker"); marker.append(icon("shield"))
  const main = element("div", "directive-card__main")
  const head = element("div", "directive-card__head")
  const presentation = directivePresentation(directive.enabled)
  head.append(element("h3", "directive-card__title", directive.title), badge(presentation.status, directive.enabled ? "success" : "neutral"), badge(`优先级 ${directive.priority}`, "accent"))
  main.append(head, element("p", "directive-card__content", directive.content), element("span", "directive-card__scope", `${directive.scope} · ${directive.source === "system" ? "项目固定" : "人工规则"}`))
  if (directive.source === "system") {
    row.append(marker, main, badge("系统锁定", "neutral"))
  } else {
    const actions = element("div", "directive-card__actions")
    const edit = actionButton("编辑规则")
    edit.addEventListener("click", () => editDirectiveDialog(directive, notify, refresh))
    const toggle = actionButton(presentation.toggleAction, directive.enabled ? "danger" : "primary")
    toggle.addEventListener("click", () => { setButtonBusy(toggle, true); void api.setDirectiveEnabled(directive.id, !directive.enabled).then(async () => { notify(directive.enabled ? "规则已停用" : "规则已启用"); await refresh() }).catch((error: unknown) => notify(error instanceof Error ? error.message : "操作失败")).finally(() => setButtonBusy(toggle, false)) })
    const remove = actionButton("删除规则", "danger")
    remove.addEventListener("click", () => deleteDirectiveDialog(directive, notify, refresh))
    actions.append(edit, toggle, remove)
    row.append(marker, main, actions)
  }
  return row
}

export function renderMemories(container: HTMLElement, notify: Notify, onChanged: () => void): void {
  let active: MemoryTab = "active"
  const content = element("section", "page-content memories-page")
  const header = element("div", "page-header-row")
  const add = actionButton("新增记忆", "primary")
  header.append(pageHeader("知识与纠正", "AI 记忆库", "人工规则、人工纠正和 AI 学习统一检索，但每条来源和历史版本都保留。"), add)
  const toolbar = element("div", "toolbar memory-toolbar")
  const tabs = element("div", "segmented page-tabs")
  const searchWrap = element("label", "search-field")
  searchWrap.append(icon("search", "search-field__icon"))
  const search = textInput("search", "搜索标题或结论")
  search.className = "search-field__input"; search.type = "search"; searchWrap.append(search)
  toolbar.append(tabs, searchWrap)
  const list = element("div", "memory-grid")
  content.append(header, toolbar, list)
  replaceChildren(container, content)

  const renderTabs = () => {
    tabs.replaceChildren()
    ;(["active", "candidate", "conflict", "superseded", "disabled", "observations", "reports", "styles", "directives"] as MemoryTab[]).forEach((value) => {
      const button = element("button", `segmented__item${active === value ? " is-active" : ""}`, labels[value])
      button.type = "button"; button.setAttribute("aria-pressed", String(active === value))
      button.addEventListener("click", () => { active = value; renderTabs(); void refresh() })
      tabs.append(button)
    })
  }
  const refresh = async () => {
    replaceChildren(list, loadingState(4))
    searchWrap.hidden = active === "observations" || active === "reports" || active === "styles" || active === "directives"
    add.hidden = active === "observations" || active === "styles"
    add.textContent = active === "reports" ? "立即生成报告" : "新增记忆"
    if (active === "directives") {
      const result = await api.getDirectives()
      replaceChildren(list, ...(result.directives.length ? result.directives.map((item) => directiveRow(item, notify, refresh)) : [emptyState("还没有固定规则", "安全边界和必须遵守的规则放在这里。", "shield")]))
    } else if (active === "observations") {
      const result = await api.getLearningObservations({ limit: 200 })
      replaceChildren(list, ...(result.items.length ? result.items.map(observationCard) : [emptyState("还没有学习观察", "授权来源的回复只会显示分类、关联和学习结果。", "memory")]))
    } else if (active === "reports") {
      const result = await api.getLearningReports()
      replaceChildren(list, ...(result.items.length ? result.items.map((item) => reportCard(item, notify, refresh)) : [emptyState("还没有学习报告", "首份报告将在 2026-08-20 23:00 自动生成，也可以通过接口手动生成。", "memory")]))
    } else if (active === "styles") {
      const result = await api.getOperatorStyleVersions()
      replaceChildren(list, ...(result.items.length ? result.items.map(styleVersionCard) : [emptyState("当前使用基线风格", "形成足够、有效的授权样本后会生成候选风格版本。", "sparkles")]))
    } else {
      const result = await api.getMemories({ status: active, ...(search.value.trim() ? { q: search.value.trim() } : {}) })
      replaceChildren(list, ...(result.items.length ? result.items.map((item) => memoryCard(item, notify, refresh)) : [emptyState(`没有${labels[active]}记忆`, "新增规则或等待 AI 从真实问题中学习。", "memory")]))
    }
    onChanged()
  }
  let timer = 0
  search.addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void refresh() }, 250) })
  add.addEventListener("click", () => {
    if (active !== "reports") {
      addMemoryDialog(active, notify, refresh)
      return
    }
    setButtonBusy(add, true)
    void api.createLearningReport().then(async () => {
      notify("学习报告已生成，不会自动更新记忆或回复规则")
      await refresh()
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "报告生成失败"))
      .finally(() => setButtonBusy(add, false))
  })
  renderTabs()
  void refresh().catch((error: unknown) => replaceChildren(list, emptyState("加载失败", error instanceof Error ? error.message : "请稍后重试", "refresh")))
}
