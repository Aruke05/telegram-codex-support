import { api } from "../api.js"
import { actionButton, badge, formField, openDialog, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime } from "../format.js"
import { icon } from "../icons.js"
import { learningObservationFacts } from "../learning-source-labels.js"
import type {
  ProjectView,
  LearningObservationAudit,
  ReplyRecord,
  SupportThreadDetail,
  SupportThreadListItem,
  SupportThreadStatus,
  TelegramGroup,
} from "../types.js"

type Notify = (message: string) => void
type QuickStatus = "all" | SupportThreadStatus | "superseded"
type AppliedThreadFilters = {
  projectId: string
  serviceId: string
  groupId: string
  senderQ: string
  timePreset: string
  from: string
  to: string
  limit: number
}

type TimingThread = Pick<SupportThreadListItem, "status" | "settleAt" | "updatedAt">

let liveEvents: EventSource | null = null
let renderGeneration = 0
let liveRefreshTimer = 0
let detailRequestGeneration = 0

export function stopReplyEvents(): void {
  renderGeneration += 1
  detailRequestGeneration += 1
  window.clearTimeout(liveRefreshTimer)
  liveRefreshTimer = 0
  liveEvents?.close()
  liveEvents = null
  document.body.classList.remove("support-overlay-open")
  document.querySelectorAll(".support-overlay-root").forEach((node) => node.remove())
}

export function threadStatusLabel(status: SupportThreadStatus): string {
  return {
    collecting: "等待补充",
    generating: "生成中",
    answered: "已回复",
    escalated: "已升级",
    closed: "已关闭",
  }[status]
}

export function threadTimingText(thread: TimingThread, now = Date.now()): string {
  if (thread.status === "collecting") {
    const seconds = Math.max(0, Math.ceil((Date.parse(thread.settleAt) - now) / 1000))
    return seconds > 0 ? `${seconds} 秒后生成` : "即将生成"
  }
  if (thread.status === "generating") {
    const seconds = Math.max(0, Math.floor((now - Date.parse(thread.updatedAt)) / 1000))
    return `已处理 ${seconds} 秒`
  }
  return threadStatusLabel(thread.status)
}

function group(className: string, ...children: Node[]): HTMLElement {
  const node = element("div", className)
  node.append(...children)
  return node
}

function senderName(thread: Pick<SupportThreadListItem, "senderDisplayName" | "senderUsername" | "senderUserId">): string {
  return thread.senderDisplayName || (thread.senderUsername ? `@${thread.senderUsername}` : thread.senderUserId) || "发送人未采集"
}

function supportStatusBadge(status: SupportThreadStatus): HTMLSpanElement {
  const tone = status === "answered" ? "success" : status === "escalated" ? "danger" : status === "generating" ? "accent" : status === "collecting" ? "warning" : "neutral"
  return badge(threadStatusLabel(status), tone)
}

function replyStatusLabel(status: ReplyRecord["status"]): string {
  return {
    pending: "待判断",
    queued: "排队中",
    generating: "正在生成",
    sending: "正在发送",
    replied: "已回复",
    ignored: "无需回复",
    escalated: "已升级",
    failed: "处理失败",
    correcting: "正在纠正",
    corrected: "已纠正",
    superseded: "旧结果已作废",
  }[status]
}

function shortDate(value: string): string {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
}

function compactEmpty(title: string, description: string): HTMLElement {
  const node = element("div", "support-compact-empty")
  node.append(icon("reply"), group("", element("strong", "", title), element("span", "", description)))
  return node
}

function compactLoading(): HTMLElement {
  const wrapper = element("div", "support-thread-loading")
  for (let index = 0; index < 6; index += 1) {
    const row = element("div", "support-thread-skeleton")
    row.append(element("span", "skeleton skeleton--short"), element("span", "skeleton skeleton--tall"), element("span", "skeleton"))
    wrapper.append(row)
  }
  wrapper.setAttribute("aria-label", "正在加载客服线程")
  return wrapper
}

function threadRow(thread: SupportThreadListItem, active: boolean, onOpen: () => void): HTMLButtonElement {
  const button = element("button", `support-thread-row${active ? " is-active" : ""}`)
  button.type = "button"
  button.dataset.threadId = thread.id
  button.addEventListener("click", onOpen)

  const head = element("div", "support-thread-row__head")
  const identity = group("support-thread-row__identity", element("span", "support-thread-row__service", thread.serviceName || thread.service), supportStatusBadge(thread.status))
  head.append(identity, element("time", "support-thread-row__time", shortDate(thread.latestMessageAt)))

  const question = element("strong", "support-thread-row__question", thread.summary || "未提取到文字内容")
  const context = element("div", "support-thread-row__context")
  context.append(element("span", "", senderName(thread)), element("span", "", thread.groupName))
  const timing = element("span", `support-thread-row__timing support-thread-row__timing--${thread.status}`, threadTimingText(thread))
  if (thread.hasSuperseded && thread.status !== "collecting" && thread.status !== "generating") timing.textContent = "包含已作废结果"
  context.append(timing)
  button.append(head, question, context)
  return button
}

function messageTimelineItem(message: SupportThreadDetail["messages"][number]): HTMLElement {
  const relation = { origin: "起始问题", supplement: "后续补充", reopen: "重新打开" }[message.relation]
  const sender = message.event.senderDisplayName || (message.event.senderUsername ? `@${message.event.senderUsername}` : message.event.senderUserId)
  const item = element("article", "support-timeline-item support-timeline-item--message")
  const marker = element("span", "support-timeline-item__marker")
  marker.append(icon(message.relation === "origin" ? "user" : "reply"))
  const card = element("div", "support-timeline-card")
  const head = element("header", "support-timeline-card__head")
  head.append(group("", element("strong", "", sender), element("span", "support-timeline-card__kind", relation)), element("time", "", formatDateTime(message.event.createdAt)))
  const text = message.event.safeText || message.questionFragment || "（仅包含附件）"
  card.append(head, element("p", "support-timeline-card__text", text))

  if (message.attachments.length > 0) {
    const attachments = element("div", "support-attachments")
    message.attachments.forEach((attachment) => {
      const row = element("div", "support-attachment")
      row.append(icon(attachment.kind === "image" || attachment.kind === "video" ? "document" : "download"), group("", element("strong", "", attachment.fileName || "未命名附件"), element("span", "", `${attachment.kind.toUpperCase()} · ${Math.max(1, Math.ceil(attachment.fileSize / 1024))} KB`)))
      if (attachment.extractedText) row.append(element("p", "support-attachment__extract", attachment.extractedText))
      attachments.append(row)
    })
    card.append(attachments)
  } else if (message.event.attachmentSummary) {
    card.append(element("p", "support-timeline-card__attachment-summary", message.event.attachmentSummary))
  }

  if (message.event.skipReason) card.append(element("p", "support-timeline-card__reason", message.event.skipReason))
  item.append(marker, card)
  return item
}

function replyTimelineItem(reply: ReplyRecord): HTMLElement {
  const item = element("article", `support-timeline-item support-timeline-item--reply support-timeline-item--${reply.status}`)
  const marker = element("span", "support-timeline-item__marker")
  marker.append(icon(reply.status === "escalated" ? "shield" : reply.status === "superseded" ? "refresh" : "sparkles"))
  const card = element("div", "support-timeline-card")
  const head = element("header", "support-timeline-card__head")
  const title = reply.status === "superseded" ? "这版回答已失效" : reply.status === "generating" || reply.status === "queued" ? "AI 正在处理" : "AI 处理结果"
  const statusText = reply.status === "escalated" && reply.telegramReplyMessageId
    ? "已回复并请求支援"
    : replyStatusLabel(reply.status)
  head.append(group("", element("strong", "", title), element("span", "support-timeline-card__kind", statusText)), element("time", "", formatDateTime(reply.updatedAt)))
  card.append(head)
  if (reply.answer) card.append(element("p", "support-timeline-card__text support-timeline-card__answer", reply.answer))
  else if (reply.status === "generating" || reply.status === "queued" || reply.status === "pending") card.append(element("p", "support-timeline-card__text support-timeline-card__muted", "回复正在生成，消息补充后旧结果会自动作废。"))
  else card.append(element("p", "support-timeline-card__text support-timeline-card__muted", "这次没有向群里发送回复。"))
  if (reply.quote) card.append(element("blockquote", "support-timeline-card__quote", reply.quote))
  if (reply.decisionReason) card.append(element("p", "support-timeline-card__reason", reply.decisionReason))

  const metadata = element("details", "support-reply-metadata")
  const summary = element("summary", "", "处理依据")
  const facts = element("dl", "support-reply-facts")
  const values: Array<[string, string]> = [
    ["问题版本", reply.inputRevision ? `v${reply.inputRevision}` : "未记录"],
    ["判断置信度", reply.decisionConfidence === null ? "未记录" : `${Math.round(reply.decisionConfidence * 100)}%`],
    ["代码提交", reply.codeRevision ?? "未记录"],
    ["使用记忆", `${reply.memoryVersionRefs.length} 条`],
  ]
  values.forEach(([label, value]) => {
    const row = element("div", "")
    row.append(element("dt", "", label), element("dd", "", value))
    facts.append(row)
  })
  metadata.append(summary, facts)
  card.append(metadata)
  item.append(marker, card)
  return item
}

function learningObservationTimelineItem(observation: LearningObservationAudit): HTMLElement {
  const item = element("article", "support-timeline-item support-timeline-item--observation")
  const marker = element("span", "support-timeline-item__marker")
  marker.append(icon("user"))
  const card = element("div", "support-timeline-card")
  const head = element("header", "support-timeline-card__head")
  head.append(group("", element("strong", "", `学习来源观察 · ID ${observation.sourceTelegramUserId}`), element("span", "support-timeline-card__kind", observation.sourceRole)), element("time", "", formatDateTime(observation.createdAt)))
  const facts = element("dl", "support-learning-observation__facts")
  learningObservationFacts(observation).forEach(([label, value]) => {
    const row = element("div", "")
    row.append(element("dt", "", label), element("dd", "", value))
    facts.append(row)
  })
  card.append(head, facts)
  item.append(marker, card)
  return item
}

function detailTimeline(detail: SupportThreadDetail): HTMLElement {
  const timeline = element("div", "support-timeline")
  const entries: Array<{ time: string; position: number; node: HTMLElement }> = []
  detail.messages.forEach((message) => entries.push({ time: message.event.createdAt, position: message.position * 2, node: messageTimelineItem(message) }))
  detail.replies.forEach((reply, index) => entries.push({ time: reply.createdAt, position: index * 2 + 1, node: replyTimelineItem(reply) }))
  detail.learningObservations.forEach((observation, index) => entries.push({ time: observation.createdAt, position: index * 2 + 1.5, node: learningObservationTimelineItem(observation) }))
  entries.sort((left, right) => left.time.localeCompare(right.time) || left.position - right.position)
  timeline.append(...entries.map((entry) => entry.node))
  return timeline
}

function correctableReply(detail: SupportThreadDetail): ReplyRecord | null {
  const latest = [...detail.replies].sort((left, right) => (
    (left.inputRevision ?? 0) - (right.inputRevision ?? 0) || left.createdAt.localeCompare(right.createdAt)
  )).at(-1)
  if (!latest || latest.inputRevision !== detail.thread.revision) return null
  return ["replied", "ignored", "escalated", "corrected"].includes(latest.status) ? latest : null
}

function correctionPanel(detail: SupportThreadDetail, notify: Notify, refresh: () => Promise<void>): HTMLElement {
  const panel = element("section", "support-correction")
  const reply = correctableReply(detail)
  if (!reply) {
    panel.append(element("p", "support-correction__hint", detail.thread.status === "generating" || detail.thread.status === "collecting" ? "回复完成后可直接在这里纠正。" : "当前没有可纠正的回复。"))
    return panel
  }

  const top = element("div", "support-correction__top")
  top.append(group("", element("strong", "", "这次回答不对？"), element("span", "", "纠正后会立刻进入 AI 记忆。")))
  const toggle = actionButton("纠正这次回复", "primary")
  top.append(toggle)

  const form = element("form", "support-correction__form")
  form.hidden = true
  const answer = element("textarea", "input-control textarea-control")
  answer.name = "correctedAnswer"
  answer.required = true
  answer.rows = 3
  answer.value = reply.answer
  answer.placeholder = "输入以后应该怎么回复"
  const reason = element("textarea", "input-control textarea-control")
  reason.name = "reason"
  reason.required = true
  reason.rows = 2
  reason.placeholder = "说明原回答哪里不对，方便 AI 理解适用条件"
  const scope = textInput("scope", "例如 poppay 或 global")
  scope.required = true
  scope.value = detail.context.knowledgeScope || detail.context.service || "global"
  const region = textInput("region", "全部地区")
  region.value = detail.context.region
  const branch = textInput("branch", "全部分支")
  branch.value = detail.context.branch
  const advanced = element("details", "support-correction__advanced")
  advanced.append(element("summary", "", "适用范围（高级）"), group("support-correction__scope", formField("知识范围", scope), formField("地区", region), formField("Git 分支", branch)))
  const error = element("p", "form-error")
  const cancel = actionButton("取消")
  const save = actionButton("保存纠正", "primary")
  const actions = group("support-correction__actions", cancel, save)
  form.append(formField("正确回答", answer), formField("纠正原因", reason), advanced, error, actions)

  const setOpen = (open: boolean) => {
    panel.classList.toggle("is-editing", open)
    form.hidden = !open
    top.hidden = open
    if (open) answer.focus()
  }
  toggle.addEventListener("click", () => setOpen(true))
  cancel.addEventListener("click", () => setOpen(false))
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    setButtonBusy(save, true)
    void api.correctReply(reply.id, {
      correctedAnswer: answer.value.trim(),
      reason: reason.value.trim(),
      scope: scope.value.trim(),
      region: region.value.trim() || null,
      branch: branch.value.trim() || null,
      correctedBy: "后台管理员",
    }).then(async () => {
      notify("纠正已保存，后续近义问题会优先使用这条记忆")
      await refresh()
    }).catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "保存失败，请重试"
    }).finally(() => setButtonBusy(save, false))
  })
  panel.append(top, form)
  return panel
}

function renderDetailPane(
  pane: HTMLElement,
  detail: SupportThreadDetail,
  notify: Notify,
  refresh: () => Promise<void>,
  close: () => void,
): void {
  const header = element("header", "support-detail__header")
  const copy = element("div", "support-detail__copy")
  const identity = element("div", "support-detail__identity")
  const styleBadge = badge(detail.thread.operatorStyleVersionId ? "风格快照已固定" : "基线风格", detail.thread.operatorStyleVersionId ? "accent" : "neutral")
  if (detail.thread.operatorStyleVersionId) styleBadge.title = `风格版本 ID ${detail.thread.operatorStyleVersionId}`
  identity.append(
    supportStatusBadge(detail.thread.status),
    styleBadge,
    element("span", "", `${detail.context.projectName} · ${detail.context.groupName}`),
  )
  copy.append(identity, element("h2", "", detail.thread.summary || "客服问题"), element("p", "", `${detail.context.serviceName || detail.context.service} · 问题版本 v${detail.thread.revision} · ${formatDateTime(detail.thread.latestMessageAt)}`))
  if (detail.thread.closedAt) {
    const audit = element("div", "support-detail__closed-audit")
    audit.append(
      icon("check"),
      element("span", "", `${detail.thread.closedBy || "系统"}于 ${formatDateTime(detail.thread.closedAt)} 关闭 · ${detail.thread.closedReason || "问题已结束"}`),
    )
    copy.append(audit)
  }
  const headerActions = element("div", "support-detail__actions")
  const closeThread = actionButton(detail.thread.status === "closed" ? "已关闭" : "关闭问题", detail.thread.status === "closed" ? "secondary" : "danger")
  closeThread.classList.add("support-close-thread")
  closeThread.prepend(icon(detail.thread.status === "closed" ? "check" : "trash"))
  closeThread.disabled = detail.thread.status === "closed"
  if (detail.thread.status !== "closed") closeThread.addEventListener("click", () => {
    const content = element("div", "support-close-confirm")
    const mark = element("div", "support-close-confirm__mark")
    mark.append(icon("trash"))
    const copy = element("div", "support-close-confirm__copy")
    copy.append(
      element("strong", "", detail.thread.status === "generating" ? "正在生成的回答会立即停止" : "这条问题会移出实时队列"),
      element("p", "", "未开始发送的内容不会再发；若消息已经进入 Telegram 发送阶段则无法撤回，但后台会保留真实发送结果。运营之后再发内容时会建立新问题。"),
    )
    content.append(mark, copy)
    const cancel = actionButton("暂不关闭")
    const confirm = actionButton("确认关闭", "danger")
    const modal = openDialog({
      eyebrow: "客服问题",
      title: "关闭这条问题？",
      description: `${detail.context.serviceName || detail.context.service} · ${detail.context.groupName}`,
      content,
      actions: [cancel, confirm],
    })
    cancel.addEventListener("click", modal.close)
    confirm.addEventListener("click", () => {
      setButtonBusy(confirm, true)
      cancel.disabled = true
      void api.closeSupportThread(detail.thread.id).then(async () => {
        modal.close()
        notify("问题已关闭")
        await refresh()
      }).catch((cause: unknown) => {
        notify(cause instanceof Error ? cause.message : "关闭失败，请重试")
      }).finally(() => {
        if (modal.dialog.isConnected) {
          setButtonBusy(confirm, false)
          cancel.disabled = false
        }
      })
    })
  })
  const closeButton = element("button", "icon-button support-detail__close")
  closeButton.type = "button"
  closeButton.setAttribute("aria-label", "关闭详情")
  closeButton.append(icon("close"))
  closeButton.addEventListener("click", close)
  headerActions.append(closeThread, closeButton)
  header.append(copy, headerActions)

  const body = element("div", "support-detail__body")
  body.append(detailTimeline(detail))
  const footer = element("footer", "support-detail__footer")
  footer.append(correctionPanel(detail, notify, refresh))
  replaceChildren(pane, header, body, footer)
}

function detailLoading(pane: HTMLElement): void {
  const loading = element("div", "support-detail-loading")
  loading.append(icon("sparkles"), element("strong", "", "正在整理完整对话"), element("span", "", "消息、补充和 AI 处理结果会按时间显示。"))
  replaceChildren(pane, loading)
}

export function renderReplies(container: HTMLElement, notify: Notify, onChanged: () => void): void {
  stopReplyEvents()
  const generation = renderGeneration
  const isActive = () => generation === renderGeneration

  let projects: ProjectView[] = []
  let groups: TelegramGroup[] = []
  let quickStatus: QuickStatus = "all"
  let selectedThreadId: string | null = null
  let workItems: SupportThreadListItem[] = []
  let visibleItems: SupportThreadListItem[] = []
  let nextCursor: string | null = null
  let cursorHistory: Array<string | undefined> = [undefined]
  let pageIndex = 0
  let listRequestGeneration = 0
  let selectedDetailFingerprint: string | null = null
  let hasLoadedList = false
  let refreshRunning = false
  let refreshQueued = false
  let pendingPageReset = false
  let appliedFilters: AppliedThreadFilters = {
    projectId: "",
    serviceId: "",
    groupId: "",
    senderQ: "",
    timePreset: "90",
    from: "",
    to: "",
    limit: 50,
  }

  const content = element("section", "page-content replies-page support-page")
  const pageHead = element("header", "support-page-head")
  const heading = group("", element("p", "eyebrow", "AI 客服"), element("h1", "page-title", "客服问题"), element("p", "page-description", "先看正在处理的消息，再从右侧完整对话里直接纠正。"))
  const liveSummary = element("div", "support-live-summary")
  const liveDot = element("span", "support-live-summary__dot")
  const liveCopy = group("", element("strong", "", "实时队列"), element("span", "", "正在连接…"))
  liveSummary.append(liveDot, liveCopy)
  pageHead.append(heading, liveSummary)

  const console = element("section", "support-console")
  const toolbar = element("div", "support-toolbar")
  const searchWrap = element("label", "search-field support-search")
  searchWrap.append(icon("search", "search-field__icon"))
  const search = textInput("search", "搜索问题、消息或附件")
  search.className = "search-field__input"
  search.type = "search"
  searchWrap.append(search)
  const moreFilters = actionButton("更多筛选")
  moreFilters.prepend(icon("settings"))
  toolbar.append(searchWrap, moreFilters)

  const quickFilters = element("div", "support-quick-filters")
  quickFilters.setAttribute("role", "tablist")
  const quickOptions: Array<{ value: QuickStatus; label: string }> = [
    { value: "all", label: "全部" },
    { value: "collecting", label: "等待补充" },
    { value: "generating", label: "生成中" },
    { value: "answered", label: "已回复" },
    { value: "escalated", label: "已升级" },
    { value: "superseded", label: "已作废" },
  ]
  const quickButtons = quickOptions.map((option) => {
    const button = element("button", `support-quick-filter${option.value === "all" ? " is-active" : ""}`, option.label)
    button.type = "button"
    button.setAttribute("role", "tab")
    button.dataset.value = option.value
    quickFilters.append(button)
    return button
  })

  const workbench = element("div", "support-workbench")
  const listPane = element("aside", "support-list-pane")
  const listHeader = element("header", "support-list-pane__header")
  const listHeading = group("", element("strong", "", "问题列表"), element("span", "", "正在加载"))
  const refreshButton = element("button", "icon-button support-list-refresh")
  refreshButton.type = "button"
  refreshButton.setAttribute("aria-label", "刷新问题列表")
  refreshButton.append(icon("refresh"))
  listHeader.append(listHeading, refreshButton)
  const threadList = element("div", "support-thread-list")
  threadList.append(compactLoading())
  const previous = actionButton("上一页")
  const pageLabel = element("span", "support-page-label", "第 1 页")
  const next = actionButton("下一页")
  const pagination = element("nav", "support-pagination")
  pagination.append(previous, pageLabel, next)
  listPane.append(listHeader, threadList, pagination)

  const detailScrim = element("button", "support-detail-scrim")
  detailScrim.type = "button"
  detailScrim.setAttribute("aria-label", "关闭客服详情")
  const detailPane = element("section", "support-detail-pane")
  detailPane.append(compactEmpty("选择一个问题", "完整消息、补充内容和 AI 处理过程会显示在这里。"))
  workbench.append(listPane, detailScrim, detailPane)
  console.append(toolbar, quickFilters, workbench)
  content.append(pageHead, console)
  replaceChildren(container, content)

  const project = selectInput("projectId", [{ value: "", label: "全部项目" }])
  const service = selectInput("serviceId", [{ value: "", label: "全部服务" }])
  const telegramGroup = selectInput("groupId", [{ value: "", label: "全部群" }])
  const sender = textInput("senderQ", "姓名、用户名或 Telegram ID")
  sender.type = "search"
  const timePreset = selectInput("timePreset", [
    { value: "90", label: "近 90 天" },
    { value: "today", label: "今天" },
    { value: "7", label: "近 7 天" },
    { value: "30", label: "近 30 天" },
    { value: "all", label: "全部时间" },
    { value: "custom", label: "自定义时间" },
  ])
  const from = textInput("from")
  from.type = "datetime-local"
  from.hidden = true
  const to = textInput("to")
  to.type = "datetime-local"
  to.hidden = true
  const pageSize = selectInput("limit", [
    { value: "20", label: "每页 20 条" },
    { value: "50", label: "每页 50 条" },
    { value: "100", label: "每页 100 条" },
  ])
  pageSize.value = "50"

  const filterLayer = element("div", "support-overlay-root support-filter-layer")
  const filterScrim = element("button", "support-filter-scrim")
  filterScrim.type = "button"
  filterScrim.setAttribute("aria-label", "关闭筛选")
  const filterDrawer = element("aside", "support-filter-drawer")
  const filterHeader = element("header", "support-filter-drawer__header")
  const filterClose = element("button", "icon-button")
  filterClose.type = "button"
  filterClose.setAttribute("aria-label", "关闭筛选")
  filterClose.append(icon("close"))
  filterHeader.append(group("", element("p", "eyebrow", "记录查询"), element("h2", "", "更多筛选")), filterClose)
  const filterBody = element("div", "support-filter-drawer__body")
  filterBody.append(
    formField("项目", project),
    formField("服务", service),
    formField("Telegram 群", telegramGroup),
    formField("发送人", sender),
    formField("时间范围", timePreset),
    group("support-filter-dates", formField("开始时间", from), formField("结束时间", to)),
    formField("每页数量", pageSize),
  )
  const resetFilters = actionButton("重置")
  const applyFilters = actionButton("应用筛选", "primary")
  const filterFooter = element("footer", "support-filter-drawer__footer")
  filterFooter.append(resetFilters, applyFilters)
  filterDrawer.append(filterHeader, filterBody, filterFooter)
  filterLayer.append(filterScrim, filterDrawer)
  document.body.append(filterLayer)

  const closeFilters = () => {
    filterLayer.classList.remove("is-open")
    document.body.classList.toggle("support-overlay-open", detailPane.classList.contains("is-open"))
  }
  const openFilters = () => {
    syncDraftFilters()
    filterLayer.classList.add("is-open")
    document.body.classList.add("support-overlay-open")
  }
  const closeDetail = () => {
    detailPane.classList.remove("is-open")
    detailScrim.classList.remove("is-open")
    if (!filterLayer.classList.contains("is-open")) document.body.classList.remove("support-overlay-open")
  }
  const openDetail = () => {
    detailPane.classList.add("is-open")
    detailScrim.classList.add("is-open")
    if (window.matchMedia("(max-width: 1119px)").matches) document.body.classList.add("support-overlay-open")
  }

  moreFilters.addEventListener("click", openFilters)
  filterClose.addEventListener("click", closeFilters)
  filterScrim.addEventListener("click", closeFilters)
  detailScrim.addEventListener("click", closeDetail)

  const timeRange = (values: AppliedThreadFilters) => {
    if (values.timePreset === "all") return {}
    if (values.timePreset === "custom") return {
      ...(values.from ? { from: new Date(values.from).toISOString() } : {}),
      ...(values.to ? { to: new Date(values.to).toISOString() } : {}),
    }
    const start = new Date()
    if (values.timePreset === "today") start.setHours(0, 0, 0, 0)
    else start.setTime(Date.now() - Number(values.timePreset) * 24 * 60 * 60 * 1000)
    return { from: start.toISOString() }
  }

  const usesIndependentLiveSection = () => quickStatus === "all" && !appliedFilters.senderQ && !search.value.trim()

  const filters = () => ({
    ...(appliedFilters.projectId ? { projectId: appliedFilters.projectId } : {}),
    ...(appliedFilters.serviceId ? { serviceId: appliedFilters.serviceId } : {}),
    ...(appliedFilters.groupId ? { groupId: appliedFilters.groupId } : {}),
    ...(quickStatus !== "all" && quickStatus !== "superseded" ? { status: quickStatus } : {}),
    ...(quickStatus === "superseded" ? { hasSuperseded: true } : {}),
    ...(usesIndependentLiveSection() ? { excludeActive: true } : {}),
    ...(appliedFilters.senderQ ? { senderQ: appliedFilters.senderQ } : {}),
    ...(search.value.trim() ? { q: search.value.trim() } : {}),
    ...timeRange(appliedFilters),
    limit: appliedFilters.limit,
  })

  const updateLiveSummary = () => {
    const generating = workItems.filter((item) => item.status === "generating").length
    const collecting = workItems.filter((item) => item.status === "collecting").length
    liveCopy.querySelector("strong")!.textContent = generating > 0 ? `${generating} 个正在生成` : "实时队列正常"
    liveCopy.querySelector("span")!.textContent = collecting > 0 ? `${collecting} 个等待补充` : "当前没有积压"
    liveSummary.classList.toggle("is-busy", generating > 0 || collecting > 0)
  }

  const refreshRowSelection = () => {
    threadList.querySelectorAll<HTMLElement>("[data-thread-id]").forEach((node) => node.classList.toggle("is-active", node.dataset.threadId === selectedThreadId))
  }

  const detailFingerprint = (detail: SupportThreadDetail) => [
    detail.thread.revision,
    detail.thread.status,
    detail.thread.updatedAt,
    ...detail.replies.map((reply) => `${reply.id}:${reply.status}:${reply.updatedAt}`),
  ].join("|")

  const paintDetail = (detail: SupportThreadDetail, preserveScroll = false) => {
    const currentBody = detailPane.querySelector<HTMLElement>(".support-detail__body")
    const oldScrollTop = currentBody?.scrollTop ?? 0
    const wasNearBottom = currentBody ? currentBody.scrollHeight - currentBody.scrollTop - currentBody.clientHeight < 72 : false
    selectedDetailFingerprint = detailFingerprint(detail)
    renderDetailPane(detailPane, detail, notify, async () => {
      await openThread(detail.thread.id, false)
      await refreshAll(false)
    }, closeDetail)
    if (!preserveScroll) return
    const nextBody = detailPane.querySelector<HTMLElement>(".support-detail__body")
    if (nextBody) nextBody.scrollTop = wasNearBottom ? nextBody.scrollHeight : oldScrollTop
  }

  const openThread = async (id: string, reveal = true) => {
    const changedThread = selectedThreadId !== id
    selectedThreadId = id
    if (changedThread) selectedDetailFingerprint = null
    refreshRowSelection()
    if (reveal) openDetail()
    if (changedThread || !detailPane.querySelector(".support-detail__header")) detailLoading(detailPane)
    const requestGeneration = ++detailRequestGeneration
    try {
      const detail = await api.getSupportThread(id)
      if (!isActive() || requestGeneration !== detailRequestGeneration || selectedThreadId !== id) return
      paintDetail(detail)
    } catch (cause) {
      if (!isActive() || requestGeneration !== detailRequestGeneration) return
      if (changedThread) replaceChildren(detailPane, compactEmpty("详情加载失败", cause instanceof Error ? cause.message : "请稍后再试"))
    }
  }

  const refreshSelectedDetail = async () => {
    const id = selectedThreadId
    if (!id || detailPane.querySelector(".support-correction.is-editing")) return
    const requestGeneration = ++detailRequestGeneration
    try {
      const detail = await api.getSupportThread(id)
      if (!isActive() || requestGeneration !== detailRequestGeneration || selectedThreadId !== id) return
      if (detailPane.querySelector(".support-correction.is-editing")) return
      if (detailFingerprint(detail) === selectedDetailFingerprint) return
      paintDetail(detail, true)
    } catch {
      // 后台刷新失败时保留当前详情；下一次 SSE 或轮询继续补拉。
    }
  }

  const renderList = (items: SupportThreadListItem[]) => {
    visibleItems = items
    hasLoadedList = true
    const range = timeRange(appliedFilters)
    const senderQuery = appliedFilters.senderQ.toLocaleLowerCase("zh-CN")
    const query = search.value.trim().toLocaleLowerCase("zh-CN")
    const liveItems = usesIndependentLiveSection() ? workItems.filter((item) => {
      if (appliedFilters.projectId && item.projectId !== appliedFilters.projectId) return false
      if (appliedFilters.serviceId && item.serviceId !== appliedFilters.serviceId) return false
      if (appliedFilters.groupId && item.groupId !== appliedFilters.groupId) return false
      if (senderQuery && ![item.senderDisplayName, item.senderUsername, item.senderUserId].some((value) => value?.toLocaleLowerCase("zh-CN").includes(senderQuery))) return false
      if (query && !item.summary.toLocaleLowerCase("zh-CN").includes(query)) return false
      if (range.from && item.latestMessageAt < range.from) return false
      if (range.to && item.latestMessageAt > range.to) return false
      return true
    }) : []
    const rows: HTMLElement[] = []
    if (liveItems.length > 0) {
      rows.push(group("support-thread-section-label support-thread-section-label--live", element("strong", "", "正在处理"), element("span", "", `${liveItems.length} 条`)))
      rows.push(...liveItems.map((item) => threadRow(item, item.id === selectedThreadId, () => { void openThread(item.id) })))
    }
    if (items.length > 0) {
      if (liveItems.length > 0) rows.push(group("support-thread-section-label", element("strong", "", "近期记录"), element("span", "", `本页 ${items.length} 条`)))
      rows.push(...items.map((item) => threadRow(item, item.id === selectedThreadId, () => { void openThread(item.id) })))
    }
    listHeading.querySelector("strong")!.textContent = quickOptions.find((option) => option.value === quickStatus)?.label === "全部" ? "全部问题" : `${quickOptions.find((option) => option.value === quickStatus)?.label}问题`
    listHeading.querySelector("span")!.textContent = liveItems.length > 0
      ? `实时 ${liveItems.length} · 历史本页 ${items.length}`
      : items.length > 0 ? `本页 ${items.length} 条` : "没有符合条件的记录"
    replaceChildren(threadList, ...(rows.length > 0
      ? rows
      : [compactEmpty("没有符合条件的问题", "换个状态或清空筛选后再看。")]))
    previous.disabled = refreshRunning || pageIndex === 0
    next.disabled = refreshRunning || !nextCursor
    pageLabel.textContent = `第 ${pageIndex + 1} 页`
    const firstItem = liveItems[0] ?? items[0]
    if (!selectedThreadId && firstItem && window.matchMedia("(min-width: 1120px)").matches) void openThread(firstItem.id, false)
  }

  const refreshWork = async () => {
    const result = await api.getSupportThreadWorkQueue()
    if (!isActive()) return
    workItems = result.items
    updateLiveSummary()
  }

  const refreshRecent = async (resetPage: boolean) => {
    if (resetPage) {
      cursorHistory = [undefined]
      pageIndex = 0
    }
    const requestGeneration = ++listRequestGeneration
    const currentCursor = cursorHistory[pageIndex]
    if (!hasLoadedList) replaceChildren(threadList, compactLoading())
    const result = await api.getSupportThreads({ ...filters(), ...(currentCursor ? { cursor: currentCursor } : {}) })
    if (!isActive() || requestGeneration !== listRequestGeneration) return
    nextCursor = result.nextCursor
    renderList(result.items)
  }

  const setListBusy = (busy: boolean) => {
    listPane.classList.toggle("is-refreshing", busy)
    refreshButton.disabled = busy
    previous.disabled = busy || pageIndex === 0
    next.disabled = busy || !nextCursor
  }

  const refreshAll = async (resetPage = false): Promise<boolean> => {
    if (!isActive()) return false
    if (resetPage) pendingPageReset = true
    if (refreshRunning) {
      refreshQueued = true
      return true
    }
    refreshRunning = true
    setListBusy(true)
    let succeeded = true
    try {
      do {
        refreshQueued = false
        const shouldResetPage = pendingPageReset
        pendingPageReset = false
        await refreshWork()
        await refreshRecent(shouldResetPage)
        await refreshSelectedDetail()
      } while (isActive() && refreshQueued)
      if (isActive()) onChanged()
    } catch (cause) {
      succeeded = false
      if (isActive()) notify(cause instanceof Error ? cause.message : "客服记录刷新失败")
    } finally {
      refreshRunning = false
      setListBusy(false)
    }
    return succeeded
  }

  const refreshServiceOptions = () => {
    const selected = service.value
    service.replaceChildren()
    const all = element("option", "", "全部服务")
    all.value = ""
    service.append(all)
    projects.filter((item) => !project.value || item.id === project.value).flatMap((item) => item.services).forEach((item) => {
      const option = element("option", "", item.name)
      option.value = item.id
      service.append(option)
    })
    service.value = [...service.options].some((option) => option.value === selected) ? selected : ""
  }

  const syncDraftFilters = () => {
    project.value = appliedFilters.projectId
    refreshServiceOptions()
    service.value = [...service.options].some((option) => option.value === appliedFilters.serviceId) ? appliedFilters.serviceId : ""
    telegramGroup.value = appliedFilters.groupId
    sender.value = appliedFilters.senderQ
    timePreset.value = appliedFilters.timePreset
    from.value = appliedFilters.from
    to.value = appliedFilters.to
    from.hidden = to.hidden = timePreset.value !== "custom"
    pageSize.value = String(appliedFilters.limit)
  }

  const loadContext = async () => {
    const [projectResult, groupResult] = await Promise.all([api.getProjects(), api.getGroups()])
    projects = projectResult.projects
    groups = groupResult.groups
    if (!isActive()) return
    projects.forEach((item) => {
      const option = element("option", "", item.name)
      option.value = item.id
      project.append(option)
    })
    groups.forEach((item) => {
      const option = element("option", "", item.name)
      option.value = item.id
      telegramGroup.append(option)
    })
    refreshServiceOptions()
  }

  let searchTimer = 0
  const runFilter = () => {
    selectedThreadId = null
    selectedDetailFingerprint = null
    detailRequestGeneration += 1
    detailPane.replaceChildren(compactEmpty("选择一个问题", "完整消息、补充内容和 AI 处理过程会显示在这里。"))
    closeDetail()
    void refreshAll(true)
  }
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(runFilter, 260)
  })
  quickButtons.forEach((button) => button.addEventListener("click", () => {
    quickStatus = button.dataset.value as QuickStatus
    quickButtons.forEach((item) => item.classList.toggle("is-active", item === button))
    runFilter()
  }))
  project.addEventListener("change", refreshServiceOptions)
  timePreset.addEventListener("change", () => {
    from.hidden = to.hidden = timePreset.value !== "custom"
  })
  resetFilters.addEventListener("click", () => {
    project.value = service.value = telegramGroup.value = sender.value = ""
    timePreset.value = "90"
    from.value = to.value = ""
    from.hidden = to.hidden = true
    pageSize.value = "50"
    refreshServiceOptions()
  })
  applyFilters.addEventListener("click", () => {
    appliedFilters = {
      projectId: project.value,
      serviceId: service.value,
      groupId: telegramGroup.value,
      senderQ: sender.value.trim(),
      timePreset: timePreset.value,
      from: from.value,
      to: to.value,
      limit: Number(pageSize.value),
    }
    closeFilters()
    runFilter()
  })
  refreshButton.addEventListener("click", () => { void refreshAll(false) })
  previous.addEventListener("click", () => {
    if (pageIndex === 0 || refreshRunning) return
    const removedCursor = cursorHistory.pop()
    pageIndex -= 1
    void refreshAll(false).then((succeeded) => {
      if (succeeded) return
      if (removedCursor) cursorHistory.push(removedCursor)
      pageIndex += 1
      renderList(visibleItems)
    })
  })
  next.addEventListener("click", () => {
    if (!nextCursor || refreshRunning) return
    const requestedCursor = nextCursor
    cursorHistory.push(requestedCursor)
    pageIndex += 1
    void refreshAll(false).then((succeeded) => {
      if (succeeded) return
      cursorHistory.pop()
      pageIndex -= 1
      renderList(visibleItems)
    })
  })

  const scheduleLiveRefresh = () => {
    if (!isActive() || liveRefreshTimer) return
    liveRefreshTimer = window.setTimeout(() => {
      liveRefreshTimer = 0
      if (!isActive()) return
      void refreshAll(false).finally(() => scheduleLiveRefresh())
    }, 4000)
  }

  void loadContext().then(async () => {
    if (!isActive()) return
    liveEvents = new EventSource("/api/replies/events")
    liveEvents.addEventListener("reply-status", () => { void refreshAll(false) })
    await refreshAll(true)
    scheduleLiveRefresh()
  }).catch((cause: unknown) => {
    if (isActive()) replaceChildren(threadList, compactEmpty("加载失败", cause instanceof Error ? cause.message : "请稍后重试"))
  })
}
