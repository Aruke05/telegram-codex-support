import { api } from "../api.js"
import { actionButton, badge, emptyState, errorState, loadingState, openDialog, setButtonBusy } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime } from "../format.js"
import { icon } from "../icons.js"
import type {
  AdminChatAttachment,
  AdminChatSession,
  AdminChatSessionDetail,
  AdminChatTurn,
  InvestigationSource,
  InvestigationStatus,
  ProjectView,
} from "../types.js"

type Notify = (message: string) => void

let liveEvents: EventSource | null = null
let renderGeneration = 0
let selectedServiceId = ""
let refreshTimer = 0
let sessionRefreshTimer = 0
let pollTimer = 0
let drawerKeydownListener: ((event: KeyboardEvent) => void) | null = null
let visibilityChangeListener: (() => void) | null = null
let globalNotificationListener: ((event: Event) => void) | null = null
const previewUrls = new Set<string>()
const unreadStorageKey = "mercuryclaw.admin-chat.unread-sessions"

const sourceLabels: Record<InvestigationSource, string> = {
  message: "问题证据",
  document: "接口文档",
  code: "当前代码",
  server: "服务器状态",
  log: "应用日志",
  database: "数据库",
  redis: "Redis",
  inference: "综合判断",
}

const statusLabels: Record<InvestigationStatus, string> = {
  confirmed: "已确认",
  not_found: "未找到",
  failed: "检查失败",
  skipped: "未检查",
}

type InvestigationStepView = {
  source: InvestigationSource | "unknown"
  sourceLabel: string
  status: InvestigationStatus
  statusLabel: string
  title: string
  evidence: string
  conclusion: string
}

type InvestigationView = { summary: string; steps: InvestigationStepView[] }
type SelectedFile = { file: File; previewUrl: string | null }
type AdminChatLiveEvent = {
  kind: "admin-chat-turn"
  id: string
  sessionId: string
  status: AdminChatTurn["status"]
  updatedAt: string
}

function readUnreadSessions(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(unreadStorageKey) || "[]") as unknown
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

function writeUnreadSessions(sessionIds: Set<string>): void {
  try { localStorage.setItem(unreadStorageKey, JSON.stringify([...sessionIds])) } catch { /* 无痕模式下仍保留本页未读状态。 */ }
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback
}

function knownSource(value: unknown): value is InvestigationSource {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(sourceLabels, value)
}

function knownStatus(value: unknown): value is InvestigationStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(statusLabels, value)
}

export function adminChatInvestigationView(trace: unknown): InvestigationView {
  const record = trace && typeof trace === "object" ? trace as Record<string, unknown> : {}
  const summary = typeof record.summary === "string" ? record.summary : ""
  const rawSteps = Array.isArray(record.steps) ? record.steps : []
  const steps = rawSteps.flatMap((rawStep): InvestigationStepView[] => {
    if (!rawStep || typeof rawStep !== "object") return []
    const step = rawStep as Record<string, unknown>
    const source = knownSource(step.source) ? step.source : "unknown"
    const validStatus = knownStatus(step.status)
    const status: InvestigationStatus = validStatus ? step.status as InvestigationStatus : "skipped"
    return [{
      source,
      sourceLabel: source === "unknown" ? "其他证据" : sourceLabels[source],
      status,
      statusLabel: source === "inference" && status === "skipped"
        ? "模型推断"
        : validStatus ? statusLabels[status] : "未确认",
      title: source === "inference" && status === "skipped"
        ? "判断依据"
        : textValue(step.title, "未命名检查"),
      evidence: textValue(step.evidence, "没有取得可展示的原始证据"),
      conclusion: textValue(step.conclusion, "本步骤没有可展示的结论"),
    }]
  })
  return { summary, steps }
}

export function hasRenderableAdminChatInvestigation(trace: unknown): boolean {
  const view = adminChatInvestigationView(trace)
  return Boolean(view.summary.trim()) || view.steps.length > 0
}

export function adminChatAnswerText(turn: AdminChatTurn): string {
  const correction = turn.corrections.at(-1)
  if (correction) return correction.correctedAnswer
  if (turn.answer.trim()) return turn.answer
  if ((turn.decision === "ignore" || turn.decision === "escalate") && turn.decisionReason?.trim()) return turn.decisionReason
  if (turn.decision === "ignore") return "本轮判断为不需要客服回复"
  if (turn.decision === "escalate") return "本轮判断需要技术处理"
  return "本轮没有生成可发送的回答"
}

async function copyAdminChatAnswer(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 非安全上下文或浏览器拒绝权限时继续尝试兼容复制。
    }
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = "fixed"
  textarea.style.inset = "0 auto auto 0"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  document.body.append(textarea)
  let copied = false
  try {
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    copied = document.execCommand("copy")
  } finally {
    textarea.remove()
    activeElement?.focus()
  }
  if (!copied) throw new Error("浏览器未允许复制")
}

export function adminChatFocusTarget(current: number, length: number, reverse: boolean): number | null {
  if (length <= 0) return null
  if (current < 0) return reverse ? length - 1 : 0
  if (reverse && current === 0) return length - 1
  if (!reverse && current === length - 1) return 0
  return null
}

export function adminChatScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth"
}

function activeTurn(detail: AdminChatSessionDetail | null): AdminChatTurn | undefined {
  return detail?.turns.find((turn) => turn.status === "pending" || turn.status === "generating")
}

export function needsAdminChatPolling(activeSessionId: string, detail: AdminChatSessionDetail | null): boolean {
  return Boolean(activeSessionId) && Boolean(activeTurn(detail))
}

function statusTone(status: InvestigationStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "confirmed") return "success"
  if (status === "failed") return "danger"
  if (status === "not_found") return "warning"
  return "neutral"
}

function releasePreview(url: string | null): void {
  if (!url) return
  URL.revokeObjectURL(url)
  previewUrls.delete(url)
}

function closeLiveUpdates(): void {
  window.clearTimeout(refreshTimer)
  window.clearTimeout(sessionRefreshTimer)
  window.clearTimeout(pollTimer)
  refreshTimer = 0
  sessionRefreshTimer = 0
  pollTimer = 0
  liveEvents?.close()
  liveEvents = null
  previewUrls.forEach((url) => URL.revokeObjectURL(url))
  previewUrls.clear()
  if (drawerKeydownListener && typeof document !== "undefined") document.removeEventListener("keydown", drawerKeydownListener)
  drawerKeydownListener = null
  if (visibilityChangeListener && typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityChangeListener)
  visibilityChangeListener = null
  if (globalNotificationListener && typeof document !== "undefined") document.removeEventListener("admin-chat-turn-notification", globalNotificationListener)
  globalNotificationListener = null
  if (typeof document !== "undefined") document.body?.classList.remove("admin-chat-drawer-open")
}

export function stopAdminChatEvents(): void {
  renderGeneration += 1
  closeLiveUpdates()
}

function serviceOptions(projects: ProjectView[]): Array<{ project: ProjectView; service: ProjectView["services"][number] }> {
  return projects.flatMap((project) => project.enabled
    ? project.services.filter((service) => service.enabled).map((service) => ({ project, service }))
    : [])
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function clientAttachmentKind(file: File): AdminChatAttachment["kind"] {
  const lower = file.name.toLocaleLowerCase("en-US")
  if (file.type.startsWith("image/")) return "image"
  if (file.type.startsWith("video/")) return "video"
  if (file.type.startsWith("text/") || /\.(txt|log|json|xml|csv|md|yaml|yml)$/i.test(lower)) return "text"
  if (file.type === "application/pdf" || lower.endsWith(".pdf")) return "pdf"
  if (/(zip|compressed|archive|tar|gzip|7z)/i.test(file.type) || /\.(zip|tar|tgz|gz|7z|rar)$/i.test(lower)) return "archive"
  return "other"
}

function attachmentCards(attachments: AdminChatAttachment[], className = ""): HTMLElement {
  const list = element("div", `admin-chat-attachments${className ? ` ${className}` : ""}`)
  attachments.forEach((attachment) => {
    const tag = attachment.url ? "a" : "div"
    const item = element(tag, `admin-chat-attachment admin-chat-attachment--${attachment.kind}`)
    if (item instanceof HTMLAnchorElement && attachment.url) {
      item.href = attachment.kind === "image" ? attachment.url : `${attachment.url}?download=1`
      item.target = attachment.kind === "image" ? "_blank" : "_self"
      item.rel = "noopener"
    }
    if (attachment.kind === "image" && attachment.url) {
      const image = element("img", "admin-chat-attachment__preview")
      image.src = attachment.url
      image.alt = attachment.name
      image.loading = "lazy"
      item.append(image)
    } else {
      item.append(icon(attachment.kind === "image" ? "upload" : "file", "admin-chat-attachment__icon"))
    }
    const copy = element("span", "admin-chat-attachment__copy")
    copy.append(
      element("strong", "admin-chat-attachment__name", attachment.name),
      element("span", "admin-chat-attachment__meta", attachment.url
        ? `${attachment.kind === "image" ? "图片" : "文件"} · ${formatBytes(attachment.size)}`
        : `${attachment.kind === "image" ? "图片" : "文件"} · ${formatBytes(attachment.size)} · 本地文件已清理`),
    )
    item.append(copy)
    list.append(item)
  })
  return list
}

function renderInvestigation(turn: AdminChatTurn): HTMLDetailsElement {
  const trace = adminChatInvestigationView(turn.investigation)
  const details = element("details", "admin-chat-trace")
  details.open = false
  const summary = element("summary", "admin-chat-trace__summary")
  const summaryCopy = element("span")
  summaryCopy.append(
    element("strong", "admin-chat-trace__title", "排查过程"),
    element("span", "admin-chat-trace__description", trace.steps.length ? `${trace.steps.length} 个步骤 · 展开复核依据` : "展开查看本轮依据"),
  )
  summary.append(icon("chevron", "admin-chat-trace__chevron"), summaryCopy)
  const steps = element("div", "admin-chat-trace__steps")
  if (!trace.steps.length) {
    steps.append(element("p", "admin-chat-trace__empty", "本轮没有可展示的排查步骤"))
  } else {
    trace.steps.forEach((step, index) => {
      const card = element("article", `admin-chat-step admin-chat-step--${step.status}`)
      const head = element("header", "admin-chat-step__head")
      const identity = element("div", "admin-chat-step__identity")
      identity.append(element("span", "admin-chat-step__index", String(index + 1)), element("span", "admin-chat-step__source", step.sourceLabel))
      head.append(identity, badge(step.statusLabel, statusTone(step.status)))
      card.append(head, element("h4", "admin-chat-step__title", step.title))
      const evidence = element("div", "admin-chat-step__block")
      evidence.append(element("span", "admin-chat-step__label", "证据"), element("pre", "admin-chat-step__evidence", step.evidence))
      const conclusion = element("div", "admin-chat-step__block")
      conclusion.append(element("span", "admin-chat-step__label", "结论"), element("p", "admin-chat-step__conclusion", step.conclusion))
      card.append(evidence, conclusion)
      steps.append(card)
    })
  }
  details.append(summary, steps)
  return details
}

function pendingAnswer(
  turn: AdminChatTurn,
  queuedAhead: number,
  cancel: (turn: AdminChatTurn, button: HTMLButtonElement) => void,
): HTMLElement {
  const card = element("article", `admin-chat-answer admin-chat-answer--${turn.status}`)
  const pulse = element("span", "admin-chat-answer__pulse")
  pulse.append(icon("sparkles"))
  const state = turn.status === "generating"
    ? "正在读取代码和业务证据"
    : queuedAhead > 0 ? `已收到 · 前面还有 ${queuedAhead} 条消息` : "已收到 · 等待开始排查"
  const copy = element("div", "admin-chat-answer__progress")
  copy.append(element("strong", "", turn.status === "generating" ? "AI 正在排查" : "消息已排队"), element("span", "", state))
  const cancelButton = element("button", "admin-chat-inline-action", "终止")
  cancelButton.type = "button"
  cancelButton.addEventListener("click", () => cancel(turn, cancelButton))
  card.append(pulse, copy, cancelButton)
  return card
}

function terminalAnswer(
  turn: AdminChatTurn,
  retry: (turn: AdminChatTurn, button: HTMLButtonElement) => void,
): HTMLElement {
  const card = element("article", `admin-chat-answer admin-chat-answer--${turn.status}`)
  const copy = element("div")
  const modelOutputRejected = turn.status === "failed" && turn.errorCode === "admin_chat_model_output_rejected"
  const superseded = turn.status === "cancelled" && turn.errorCode === "admin_chat_superseded"
  copy.append(
    element("strong", "", superseded
      ? "已按新消息重新排查"
      : modelOutputRejected
      ? "模型回答已被发送前校验拦截"
      : turn.status === "failed" ? "这次排查没有完成" : "这次排查已终止"),
    element("p", "admin-chat-answer__failure", turn.decisionReason || (turn.status === "failed" ? "运行暂时不可用" : "需要时可以重新发送")),
  )
  const button = element("button", "admin-chat-inline-action", "重新排查")
  button.type = "button"
  button.addEventListener("click", () => retry(turn, button))
  card.append(copy)
  if (!superseded) card.append(button)
  if (hasRenderableAdminChatInvestigation(turn.investigation)) card.append(renderInvestigation(turn))
  return card
}

function completedAnswer(
  turn: AdminChatTurn,
  correct: (turn: AdminChatTurn) => void,
  notify: Notify,
): HTMLElement {
  const card = element("article", "admin-chat-answer admin-chat-answer--completed")
  const correction = turn.corrections.at(-1)
  const head = element("header", "admin-chat-answer__head")
  const identity = element("div", "admin-chat-answer__identity")
  const styleBadge = badge("真人口吻", "accent")
  styleBadge.title = "使用当前已生效的真人口吻风格"
  identity.append(icon("sparkles"), element("strong", "", "AI 客服"), styleBadge)
  const actions = element("div", "admin-chat-answer__state-actions")
  if (correction) actions.append(badge("已纠正", "accent"))
  const copyButton = element("button", "admin-chat-inline-action")
  copyButton.type = "button"
  copyButton.setAttribute("aria-label", "复制 AI 回答")
  copyButton.append(icon("copy"), document.createTextNode("复制"))
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true
    try {
      await copyAdminChatAnswer(adminChatAnswerText(turn))
      copyButton.replaceChildren(icon("check"), document.createTextNode("已复制"))
      notify("AI 回答已复制")
      window.setTimeout(() => {
        if (copyButton.isConnected) copyButton.replaceChildren(icon("copy"), document.createTextNode("复制"))
      }, 1600)
    } catch {
      notify("复制失败 请重试")
    } finally {
      copyButton.disabled = false
    }
  })
  const correctButton = element("button", "admin-chat-inline-action")
  correctButton.type = "button"
  correctButton.append(icon("edit"), document.createTextNode(correction ? "再次纠正" : "纠正"))
  correctButton.addEventListener("click", () => correct(turn))
  actions.append(copyButton, correctButton)
  head.append(identity, actions)
  card.append(head, element("p", "admin-chat-answer__text", adminChatAnswerText(turn)))
  if (correction) {
    const history = element("details", "admin-chat-correction-history")
    history.append(
      element("summary", "", `已由 ${correction.correctedBy} 纠正 · ${formatDateTime(correction.createdAt)}`),
      element("p", "", `原回答：${turn.answer || "无"}`),
      element("p", "", `纠正原因：${correction.reason}`),
    )
    card.append(history)
  }
  card.append(renderInvestigation(turn))
  return card
}

function turnCard(
  turn: AdminChatTurn,
  turns: AdminChatTurn[],
  retry: (turn: AdminChatTurn, button: HTMLButtonElement) => void,
  cancel: (turn: AdminChatTurn, button: HTMLButtonElement) => void,
  correct: (turn: AdminChatTurn) => void,
  notify: Notify,
): HTMLElement {
  const group = element("section", "admin-chat-turn")
  const questionRow = element("div", "admin-chat-message-row admin-chat-message-row--user")
  const question = element("article", "admin-chat-question")
  if (turn.question) question.append(element("p", "admin-chat-question__text", turn.question))
  if (turn.attachments.length) question.append(attachmentCards(turn.attachments, "admin-chat-attachments--question"))
  const meta = element("div", "admin-chat-question__meta")
  meta.append(element("time", "admin-chat-question__time", formatDateTime(turn.createdAt)))
  if (turn.status === "pending") meta.append(element("span", "", "已发送"))
  question.append(meta)
  questionRow.append(question)
  const answerRow = element("div", "admin-chat-message-row admin-chat-message-row--assistant")
  const queuedAhead = turns.filter((item) => item.position < turn.position && (item.status === "pending" || item.status === "generating")).length
  if (turn.status === "completed") answerRow.append(completedAnswer(turn, correct, notify))
  else if (turn.status === "failed" || turn.status === "cancelled") answerRow.append(terminalAnswer(turn, retry))
  else answerRow.append(pendingAnswer(turn, queuedAhead, cancel))
  group.append(questionRow, answerRow)
  return group
}

export function renderAdminChat(container: HTMLElement, notify: Notify): void {
  const generation = ++renderGeneration
  closeLiveUpdates()

  const content = element("section", "admin-chat-page")
  const consoleShell = element("section", "admin-chat-console")
  consoleShell.setAttribute("aria-label", "AI 客服对话")
  const workbench = element("div", "admin-chat-workbench")
  const sessionPane = element("aside", "admin-chat-sessions")
  sessionPane.id = "admin-chat-session-drawer"
  sessionPane.tabIndex = -1
  sessionPane.setAttribute("aria-label", "全部对话")
  const serviceControl = element("label", "admin-chat-service admin-chat-composer__service")
  serviceControl.append(element("span", "admin-chat-service__label visually-hidden", "对话服务"))
  const serviceSelect = element("select", "input-control admin-chat-service__select")
  serviceSelect.name = "serviceId"
  serviceSelect.setAttribute("aria-label", "选择新对话所属服务")
  const defaultOption = element("option", "", "正在加载服务…")
  defaultOption.value = ""
  serviceSelect.append(defaultOption)
  serviceControl.append(serviceSelect)
  const sessionHead = element("header", "admin-chat-sessions__head")
  sessionHead.append(element("strong", "", "全部对话"), element("span", "admin-chat-sessions__count", "0"))
  const sessionList = element("div", "admin-chat-sessions__list")
  sessionList.tabIndex = -1
  sessionList.append(emptyState("暂无对话", "从发送框选择服务后开始对话", "chat"))
  sessionPane.append(sessionHead, sessionList)

  const drawerScrim = element("button", "admin-chat-drawer-scrim")
  drawerScrim.type = "button"
  drawerScrim.setAttribute("aria-label", "关闭全部对话")

  const conversationPane = element("div", "admin-chat-conversation is-starting")
  const conversationHeader = element("header", "admin-chat-conversation__header")
  const drawerButton = element("button", "button button--secondary admin-chat-drawer-button")
  drawerButton.type = "button"
  drawerButton.setAttribute("aria-label", "打开全部对话")
  drawerButton.setAttribute("aria-expanded", "false")
  drawerButton.setAttribute("aria-controls", "admin-chat-session-drawer")
  drawerButton.append(icon("chat"))
  const context = element("div", "admin-chat-context")
  context.append(element("strong", "admin-chat-context__title", "还没有选择服务"), element("span", "admin-chat-context__meta", "从下方发送框选择服务"))
  const newSession = element("button", "button button--secondary admin-chat-new")
  newSession.type = "button"
  newSession.disabled = true
  newSession.append(icon("edit"), document.createTextNode("新对话"))
  conversationHeader.append(drawerButton, context, newSession)
  const messages = element("div", "admin-chat-messages")
  const starter = element("div", "admin-chat-starter")
  starter.append(
    icon("sparkles", "admin-chat-starter__icon"),
    element("h2", "admin-chat-starter__title", "直接发消息开始排查"),
    element("p", "admin-chat-starter__text", "写下问题或粘贴截图 生成期间也可以继续补充下一条"),
  )
  const preview = element("div", "admin-chat-starter__preview")
  preview.append(element("span", "", "连续对话"), element("span", "", "图片与文件"), element("span", "", "回答纠正"))
  starter.append(preview)
  messages.append(starter)

  const composer = element("form", "admin-chat-composer")
  const attachmentTray = element("div", "admin-chat-composer__attachments")
  attachmentTray.hidden = true
  const input = element("input", "admin-chat-file-input")
  input.type = "file"
  input.multiple = true
  input.tabIndex = -1
  input.setAttribute("aria-hidden", "true")
  const composerSurface = element("div", "admin-chat-composer__surface")
  const attach = element("button", "admin-chat-composer__attach")
  attach.type = "button"
  attach.setAttribute("aria-label", "添加图片或文件")
  attach.title = "添加图片或文件"
  attach.append(icon("paperclip"))
  const question = element("textarea", "admin-chat-composer__input")
  question.name = "question"
  question.placeholder = "发消息或粘贴截图…"
  question.maxLength = 12000
  question.rows = 1
  question.disabled = true
  question.setAttribute("aria-label", "输入消息")
  const submit = element("button", "admin-chat-send")
  submit.type = "submit"
  submit.disabled = true
  submit.setAttribute("aria-label", "发送消息")
  submit.title = "发送消息"
  submit.append(icon("send"))
  composerSurface.append(serviceControl, attach, question, submit)
  const composerFooter = element("div", "admin-chat-composer__footer")
  const composerNote = element("span", "admin-chat-composer__note", "可直接粘贴截图或拖入文件")
  composerFooter.append(
    composerNote,
    element("span", "admin-chat-composer__shortcut", "Enter 发送 · Shift Enter 换行"),
  )
  const dropHint = element("div", "admin-chat-drop-hint")
  dropHint.append(icon("upload"), element("strong", "", "松开即可添加到消息"))
  composer.append(input, attachmentTray, composerSurface, composerFooter, dropHint)
  conversationPane.append(conversationHeader, messages, composer)
  workbench.append(sessionPane, drawerScrim, conversationPane)
  consoleShell.append(workbench)
  content.append(consoleShell)
  replaceChildren(container, content)

  let projects: ProjectView[] = []
  let sessions: AdminChatSession[] = []
  let detail: AdminChatSessionDetail | null = null
  let activeSessionId = ""
  let sessionLoadSequence = 0
  let detailLoadSequence = 0
  let drawerOpen = false
  let draftingNewSession = false
  let submitting = false
  let selectedFiles: SelectedFile[] = []
  let dragDepth = 0
  const unreadSessionIds = readUnreadSessions()

  const isActive = () => generation === renderGeneration
  const notifyUnreadChanged = () => document.dispatchEvent(new CustomEvent("admin-chat-unread-changed"))
  const markSessionRead = (sessionId: string) => {
    if (!unreadSessionIds.delete(sessionId)) return
    writeUnreadSessions(unreadSessionIds)
    notifyUnreadChanged()
    renderSessionList()
  }
  const markSessionUnread = (sessionId: string) => {
    if (unreadSessionIds.has(sessionId)) return
    unreadSessionIds.add(sessionId)
    writeUnreadSessions(unreadSessionIds)
    notifyUnreadChanged()
    renderSessionList()
  }
  visibilityChangeListener = () => {
    if (!document.hidden && activeSessionId) markSessionRead(activeSessionId)
  }
  document.addEventListener("visibilitychange", visibilityChangeListener)
  globalNotificationListener = (event) => {
    const update = (event as CustomEvent<{ sessionId?: string }>).detail
    if (!update?.sessionId) return
    if (update.sessionId === activeSessionId && !document.hidden) markSessionRead(update.sessionId)
    else markSessionUnread(update.sessionId)
  }
  document.addEventListener("admin-chat-turn-notification", globalNotificationListener)
  const setDrawerOpen = (open: boolean) => {
    const narrow = window.matchMedia?.("(max-width: 820px)").matches ?? false
    if (open && !narrow) return
    const restoreFocus = drawerOpen && !open
    drawerOpen = open
    consoleShell.classList.toggle("is-session-drawer-open", open)
    drawerButton.setAttribute("aria-expanded", String(open))
    document.body.classList.toggle("admin-chat-drawer-open", open)
    if (open) {
      sessionPane.setAttribute("role", "dialog")
      sessionPane.setAttribute("aria-modal", "true")
      requestAnimationFrame(() => (sessionList.querySelector<HTMLButtonElement>(".admin-chat-session") ?? sessionPane).focus())
    } else {
      sessionPane.removeAttribute("role")
      sessionPane.removeAttribute("aria-modal")
      if (restoreFocus) drawerButton.focus()
    }
  }

  const resizeComposer = () => {
    question.style.height = "auto"
    question.style.height = `${Math.min(Math.max(question.scrollHeight, 28), 156)}px`
  }

  const setComposerState = () => {
    const ready = Boolean(selectedServiceId) && (Boolean(question.value.trim()) || selectedFiles.length > 0)
    const investigating = Boolean(activeTurn(detail))
    question.disabled = !selectedServiceId
    attach.disabled = !selectedServiceId
    submit.disabled = !ready || submitting
    submit.title = investigating ? "发送并按最新消息重新排查" : "发送消息"
    submit.setAttribute("aria-label", submit.title)
    composerNote.textContent = investigating
      ? "继续发送会自动停止当前排查并按最新内容重新开始"
      : "可直接粘贴截图或拖入文件"
    composer.classList.toggle("is-disabled", !selectedServiceId)
    composer.classList.toggle("is-submitting", submitting)
  }

  const renderSelectedFiles = () => {
    attachmentTray.hidden = selectedFiles.length === 0
    const fragment = document.createDocumentFragment()
    selectedFiles.forEach((selected, index) => {
      const chip = element("div", "admin-chat-file-chip")
      if (selected.previewUrl) {
        const image = element("img", "admin-chat-file-chip__preview")
        image.src = selected.previewUrl
        image.alt = ""
        chip.append(image)
      } else chip.append(icon("file", "admin-chat-file-chip__icon"))
      const copy = element("span", "admin-chat-file-chip__copy")
      copy.append(element("strong", "", selected.file.name), element("span", "", formatBytes(selected.file.size)))
      const remove = element("button", "admin-chat-file-chip__remove")
      remove.type = "button"
      remove.setAttribute("aria-label", `移除 ${selected.file.name}`)
      remove.append(icon("close"))
      remove.addEventListener("click", () => {
        const removed = selectedFiles.splice(index, 1)[0]
        releasePreview(removed?.previewUrl ?? null)
        renderSelectedFiles()
      })
      chip.append(copy, remove)
      fragment.append(chip)
    })
    replaceChildren(attachmentTray, fragment)
    setComposerState()
  }

  const addFiles = (files: File[]) => {
    const accepted: File[] = []
    let totalSize = selectedFiles.reduce((total, item) => total + item.file.size, 0)
    for (const file of files) {
      if (selectedFiles.length + accepted.length >= 8) break
      if (file.size > 20 * 1024 * 1024) {
        notify(`${file.name} 超过 20MB 没有添加`)
        continue
      }
      if (totalSize + file.size > 40 * 1024 * 1024) {
        notify("单条消息附件总大小不能超过 40MB")
        continue
      }
      accepted.push(file)
      totalSize += file.size
    }
    if (files.length > accepted.length && selectedFiles.length + accepted.length >= 8) notify("每条消息最多添加 8 个附件")
    accepted.forEach((file) => {
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null
      if (previewUrl) previewUrls.add(previewUrl)
      selectedFiles.push({ file, previewUrl })
    })
    if (accepted.length) notify(`已添加 ${accepted.length} 个附件`)
    renderSelectedFiles()
  }

  const schedulePolling = () => {
    if (!isActive()) return
    const activeNeedsPolling = needsAdminChatPolling(activeSessionId, detail)
    const inboxNeedsPolling = sessions.some((session) => session.latestTurnStatus === "pending" || session.latestTurnStatus === "generating")
    if (!activeNeedsPolling && !inboxNeedsPolling) {
      window.clearTimeout(pollTimer)
      pollTimer = 0
      return
    }
    if (pollTimer) return
    pollTimer = window.setTimeout(() => {
      pollTimer = 0
      const refreshes: Array<Promise<void>> = [loadSessions(activeSessionId, false)]
      if (activeNeedsPolling) refreshes.push(refreshDetail(false))
      void Promise.allSettled(refreshes).finally(schedulePolling)
    }, 4000)
  }

  const retryTurn = (turn: AdminChatTurn, button: HTMLButtonElement) => {
    if (!detail) return
    const requestedSessionId = turn.sessionId
    setButtonBusy(button, true)
    void api.retryAdminChatTurn(turn.id).then((retry) => {
      if (!isActive() || !detail || activeSessionId !== requestedSessionId) return
      detail = { ...detail, turns: [...detail.turns, retry] }
      renderConversation(true)
      notify("已重新发起排查")
      schedulePolling()
    }).catch((cause: unknown) => {
      if (isActive()) notify(cause instanceof Error ? cause.message : "重试失败")
    }).finally(() => {
      if (isActive()) setButtonBusy(button, false)
    })
  }

  const cancelTurn = (turn: AdminChatTurn, button: HTMLButtonElement) => {
    const requestedSessionId = turn.sessionId
    setButtonBusy(button, true)
    void api.cancelAdminChatTurn(turn.id).then((cancelled) => {
      if (!isActive() || !detail || activeSessionId !== requestedSessionId) return
      detail = { ...detail, turns: detail.turns.map((item) => item.id === cancelled.id ? cancelled : item) }
      renderConversation(false)
      notify(cancelled.status === "cancelled" ? "已终止本轮排查" : "本轮排查已经结束")
      schedulePolling()
    }).catch((cause: unknown) => {
      if (isActive()) notify(cause instanceof Error ? cause.message : "终止失败")
    }).finally(() => {
      if (isActive()) setButtonBusy(button, false)
    })
  }

  const correctTurn = (turn: AdminChatTurn) => {
    const content = element("form", "admin-chat-correction-form")
    const answerLabel = element("label", "form-field")
    answerLabel.append(element("span", "form-field__label", "正确回答"))
    const answer = element("textarea", "input-control textarea-control")
    answer.rows = 5
    answer.maxLength = 12000
    answer.value = adminChatAnswerText(turn)
    answer.required = true
    answerLabel.append(answer)
    const reasonLabel = element("label", "form-field")
    reasonLabel.append(element("span", "form-field__label", "纠正原因"))
    const reason = element("textarea", "input-control textarea-control")
    reason.rows = 3
    reason.maxLength = 1000
    reason.placeholder = "说明哪里不准确 方便以后复核"
    reason.required = true
    reasonLabel.append(reason)
    const error = element("p", "form-error")
    content.append(answerLabel, reasonLabel, error)
    const cancel = actionButton("取消")
    const save = actionButton("保存纠正", "primary")
    const opened = openDialog({
      eyebrow: "回答纠正",
      title: "把正确答案留在对话里",
      description: "原回答会保留 纠正会进入 AI 记忆并用于后续对话",
      content,
      actions: [cancel, save],
    })
    cancel.addEventListener("click", opened.close)
    save.addEventListener("click", () => content.requestSubmit())
    content.addEventListener("submit", (event) => {
      event.preventDefault()
      error.textContent = ""
      if (!answer.value.trim() || !reason.value.trim()) {
        error.textContent = "正确回答和纠正原因都要填写"
        return
      }
      setButtonBusy(save, true)
      void api.correctAdminChatTurn(turn.id, {
        correctedAnswer: answer.value.trim(),
        reason: reason.value.trim(),
      }).then((corrected) => {
        if (!isActive()) return
        if (detail && activeSessionId === turn.sessionId) {
          detail = { ...detail, turns: detail.turns.map((item) => item.id === corrected.id ? corrected : item) }
          renderConversation(false)
        }
        opened.close()
        notify("纠正已保存并进入 AI 记忆")
      }).catch((cause: unknown) => {
        error.textContent = cause instanceof Error ? cause.message : "保存失败"
      }).finally(() => setButtonBusy(save, false))
    })
    requestAnimationFrame(() => answer.focus())
  }

  const renderConversation = (forceBottom = false) => {
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140
    conversationPane.classList.toggle("is-starting", !detail || detail.turns.length === 0)
    if (!detail) {
      replaceChildren(messages, starter)
      setComposerState()
      return
    }
    const fragment = document.createDocumentFragment()
    if (!detail.turns.length) fragment.append(emptyState("可以开始了", "发文字 粘贴截图或添加文件", "sparkles"))
    else detail.turns.forEach((turn) => fragment.append(turnCard(turn, detail!.turns, retryTurn, cancelTurn, correctTurn, notify)))
    replaceChildren(messages, fragment)
    setComposerState()
    if ((forceBottom || nearBottom) && typeof requestAnimationFrame === "function") requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
      messages.scrollTo({ top: messages.scrollHeight, behavior: adminChatScrollBehavior(reducedMotion) })
    })
  }

  async function refreshDetail(showLoading: boolean): Promise<void> {
    if (!activeSessionId) return
    const requestedSession = activeSessionId
    const sequence = ++detailLoadSequence
    if (showLoading) replaceChildren(messages, loadingState(3))
    try {
      const response = await api.getAdminChatSession(requestedSession)
      if (!isActive() || sequence !== detailLoadSequence || requestedSession !== activeSessionId) return
      detail = response
      renderConversation(false)
      const listed = sessions.find((session) => session.id === response.session.id)
      const latestTurn = response.turns.at(-1)
      const refreshedSession: AdminChatSession = {
        ...response.session,
        latestTurnStatus: latestTurn?.status ?? null,
        latestTurnUpdatedAt: latestTurn?.updatedAt ?? null,
      }
      if (listed && (
        listed.title !== refreshedSession.title
        || listed.updatedAt !== refreshedSession.updatedAt
        || listed.latestTurnStatus !== refreshedSession.latestTurnStatus
        || listed.latestTurnUpdatedAt !== refreshedSession.latestTurnUpdatedAt
      )) {
        sessions = sessions.map((session) => session.id === response.session.id ? refreshedSession : session)
        renderSessionList()
      }
    } catch (cause) {
      if (!isActive() || sequence !== detailLoadSequence) return
      replaceChildren(messages, errorState(cause instanceof Error ? cause.message : "加载失败", () => { void refreshDetail(true) }))
    } finally {
      if (isActive()) schedulePolling()
    }
  }

  const openSession = (session: AdminChatSession) => {
    draftingNewSession = false
    activeSessionId = session.id
    detail = null
    if (serviceOptions(projects).some((item) => item.service.id === session.serviceId)) {
      selectedServiceId = session.serviceId
      serviceSelect.value = session.serviceId
    }
    context.replaceChildren(
      element("strong", "admin-chat-context__title", session.title),
      element("span", "admin-chat-context__meta", `${session.project.name} · ${session.service.name} · ${session.service.branch} · ${session.createdByUsername}`),
    )
    markSessionRead(session.id)
    renderSessionList()
    setDrawerOpen(false)
    void refreshDetail(true)
  }

  function renderSessionList(): void {
    const unreadCount = sessions.filter((session) => unreadSessionIds.has(session.id)).length
    sessionHead.querySelector(".admin-chat-sessions__count")!.textContent = unreadCount
      ? `${sessions.length} 个 · ${unreadCount} 未读`
      : `${sessions.length} 个`
    drawerButton.classList.toggle("has-unread", unreadCount > 0)
    drawerButton.dataset.unread = String(unreadCount)
    if (!sessions.length) {
      replaceChildren(sessionList, emptyState("暂无对话", "点击新对话开始第一次排查", "chat"))
      return
    }
    const fragment = document.createDocumentFragment()
    sessions.forEach((session) => {
      const unread = unreadSessionIds.has(session.id)
      const running = session.latestTurnStatus === "pending" || session.latestTurnStatus === "generating"
      const stateLabel = unread
        ? "新回复"
        : session.latestTurnStatus === "generating"
          ? "排查中"
          : session.latestTurnStatus === "pending"
            ? "排队中"
            : session.latestTurnStatus === "failed"
              ? "未完成"
              : session.latestTurnStatus === "cancelled"
                ? "已终止"
                : ""
      const button = element("button", `admin-chat-session${session.id === activeSessionId ? " is-active" : ""}${unread ? " is-unread" : ""}${running ? " is-running" : ""}`)
      button.type = "button"
      button.setAttribute("aria-label", `${session.title} ${session.service.name}${stateLabel ? ` ${stateLabel}` : ""}`)
      const copy = element("span", "admin-chat-session__copy")
      const meta = element("span", "admin-chat-session__meta")
      meta.append(
        element("span", "admin-chat-session__service", `${session.service.name} · ${session.createdByUsername}`),
        element("time", "admin-chat-session__time", formatDateTime(session.updatedAt)),
      )
      copy.append(element("strong", "admin-chat-session__title", session.title), meta)
      const state = element("span", `admin-chat-session__state admin-chat-session__state--${unread ? "unread" : session.latestTurnStatus || "idle"}`)
      state.append(element("span", "admin-chat-session__state-dot"), document.createTextNode(stateLabel))
      state.hidden = !stateLabel
      button.append(copy, state)
      button.addEventListener("click", () => openSession(session))
      fragment.append(button)
    })
    replaceChildren(sessionList, fragment)
  }

  async function loadSessions(preferredSessionId = "", showLoading = true): Promise<void> {
    const sequence = ++sessionLoadSequence
    if (showLoading && !sessions.length) replaceChildren(sessionList, loadingState(3))
    try {
      const response = await api.getAdminChatSessions()
      if (!isActive() || sequence !== sessionLoadSequence) return
      sessions = response.sessions
      const knownSessionIds = new Set(sessions.map((session) => session.id))
      let prunedUnread = false
      unreadSessionIds.forEach((sessionId) => {
        if (!knownSessionIds.has(sessionId)) {
          unreadSessionIds.delete(sessionId)
          prunedUnread = true
        }
      })
      if (prunedUnread) {
        writeUnreadSessions(unreadSessionIds)
        notifyUnreadChanged()
      }
      renderSessionList()
      const nextId = preferredSessionId
        || (sessions.some((session) => session.id === activeSessionId) ? activeSessionId : "")
        || (!draftingNewSession ? sessions[0]?.id : "")
        || ""
      const next = sessions.find((session) => session.id === nextId)
      if (next && (next.id !== activeSessionId || !detail)) openSession(next)
      else {
        if (next) return
        activeSessionId = ""
        detail = null
        context.replaceChildren(
          element("strong", "admin-chat-context__title", "新对话"),
          element("span", "admin-chat-context__meta", "选择服务后发送第一条消息"),
        )
        renderConversation(false)
      }
    } catch (cause) {
      if (!isActive() || sequence !== sessionLoadSequence) return
      replaceChildren(sessionList, errorState(cause instanceof Error ? cause.message : "加载失败", () => { void loadSessions() }))
    }
  }

  const startNewSession = () => {
    if (!selectedServiceId) return
    draftingNewSession = true
    activeSessionId = ""
    detail = null
    const selected = serviceOptions(projects).find((item) => item.service.id === selectedServiceId)
    context.replaceChildren(
      element("strong", "admin-chat-context__title", "新对话"),
      element("span", "admin-chat-context__meta", selected ? `${selected.project.name} · ${selected.service.name} · ${selected.service.branch}` : "发送第一条消息时自动创建"),
    )
    renderSessionList()
    renderConversation(false)
    setDrawerOpen(false)
    question.focus()
  }

  const chooseService = () => {
    const previousServiceId = detail?.session.serviceId ?? sessions.find((session) => session.id === activeSessionId)?.serviceId ?? ""
    selectedServiceId = serviceSelect.value
    newSession.disabled = !selectedServiceId
    if (!selectedServiceId) {
      if (!activeSessionId) context.replaceChildren(element("strong", "admin-chat-context__title", "还没有选择服务"), element("span", "admin-chat-context__meta", "选择后可以开始对话"))
      setComposerState()
      return
    }
    if (activeSessionId && previousServiceId && previousServiceId !== selectedServiceId) {
      startNewSession()
      return
    }
    const selected = serviceOptions(projects).find((item) => item.service.id === selectedServiceId)
    if (selected && draftingNewSession) context.replaceChildren(
      element("strong", "admin-chat-context__title", `${selected.project.name} · ${selected.service.name}`),
      element("span", "admin-chat-context__meta", `${selected.service.branch} · 发送后开始独立排查`),
    )
    setComposerState()
  }

  const scheduleDetailRefresh = (delay: number) => {
    if (!isActive() || !activeSessionId || refreshTimer) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0
      if (isActive()) void refreshDetail(false)
    }, delay)
  }

  const scheduleSessionRefresh = (delay: number) => {
    if (!isActive() || sessionRefreshTimer) return
    sessionRefreshTimer = window.setTimeout(() => {
      sessionRefreshTimer = 0
      if (isActive()) void loadSessions(activeSessionId, false)
    }, delay)
  }

  const startLiveUpdates = () => {
    if (typeof EventSource === "undefined") return
    liveEvents = new EventSource("/api/replies/events")
    liveEvents.addEventListener("open", schedulePolling)
    liveEvents.addEventListener("admin-chat-turn", (event) => {
      let update: AdminChatLiveEvent | null = null
      try { update = JSON.parse((event as MessageEvent<string>).data) as AdminChatLiveEvent } catch { return }
      if (!update?.sessionId) return
      const terminal = update.status === "completed" || update.status === "failed" || update.status === "cancelled"
      if (terminal) {
        if (update.sessionId === activeSessionId && !document.hidden) markSessionRead(update.sessionId)
        else markSessionUnread(update.sessionId)
      }
      scheduleSessionRefresh(180)
      if (update.sessionId === activeSessionId) scheduleDetailRefresh(180)
      schedulePolling()
    })
    liveEvents.addEventListener("error", schedulePolling)
  }

  drawerButton.addEventListener("click", () => setDrawerOpen(true))
  drawerScrim.addEventListener("click", () => setDrawerOpen(false))
  drawerKeydownListener = (event) => {
    if (!drawerOpen) return
    if (event.key === "Escape") {
      event.preventDefault()
      setDrawerOpen(false)
      return
    }
    if (event.key !== "Tab") return
    const focusable = Array.from(sessionPane.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )).filter((candidate) => candidate.getAttribute("aria-hidden") !== "true")
    const target = adminChatFocusTarget(focusable.indexOf(document.activeElement as HTMLElement), focusable.length, event.shiftKey)
    if (target === null) {
      if (!focusable.length) { event.preventDefault(); sessionPane.focus() }
      return
    }
    event.preventDefault()
    focusable[target]?.focus()
  }
  document.addEventListener("keydown", drawerKeydownListener)
  serviceSelect.addEventListener("change", chooseService)
  question.addEventListener("input", () => { resizeComposer(); setComposerState() })
  question.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    if (!submit.disabled) composer.requestSubmit()
  })
  question.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length) addFiles(files)
  })
  attach.addEventListener("click", () => input.click())
  input.addEventListener("change", () => {
    addFiles(Array.from(input.files ?? []))
    input.value = ""
  })
  composer.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return
    event.preventDefault()
    dragDepth += 1
    composer.classList.add("is-dragging")
  })
  composer.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
  })
  composer.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) composer.classList.remove("is-dragging")
  })
  composer.addEventListener("drop", (event) => {
    event.preventDefault()
    dragDepth = 0
    composer.classList.remove("is-dragging")
    addFiles(Array.from(event.dataTransfer?.files ?? []))
  })

  newSession.addEventListener("click", startNewSession)

  composer.addEventListener("submit", (event) => {
    event.preventDefault()
    const value = question.value.trim()
    if (!selectedServiceId || submitting || (!value && !selectedFiles.length)) return
    const requestedServiceId = selectedServiceId
    const requestedSessionId = activeSessionId
    const filesToSend = selectedFiles
    selectedFiles = []
    question.value = ""
    resizeComposer()
    renderSelectedFiles()
    submitting = true
    setComposerState()

    let optimisticId = ""
    let optimisticallySuperseded: AdminChatTurn[] = []
    if (detail && requestedSessionId) {
      optimisticId = `pending-${Date.now()}`
      const now = new Date().toISOString()
      optimisticallySuperseded = detail.turns.filter((turn) => turn.status === "pending" || turn.status === "generating")
      const optimistic: AdminChatTurn = {
        id: optimisticId,
        sessionId: requestedSessionId,
        position: Math.max(0, ...detail.turns.map((turn) => turn.position)) + 1,
        question: value,
        answer: "",
        decision: null,
        status: "pending",
        investigation: {},
        decisionReason: null,
        decisionConfidence: null,
        codeRevision: null,
        codeSnapshotId: null,
        codeSyncBatchId: null,
        memoryVersionRefs: [],
        errorCode: null,
        createdAt: now,
        updatedAt: now,
        generationStartedAt: null,
        completedAt: null,
        corrections: [],
        attachments: filesToSend.map((selected, index) => ({
          id: `${optimisticId}-${index}`,
          turnId: optimisticId,
          name: selected.file.name,
          mimeType: selected.file.type,
          size: selected.file.size,
          kind: clientAttachmentKind(selected.file),
          createdAt: now,
          url: selected.previewUrl,
        })),
      }
      detail = {
        ...detail,
        turns: [...detail.turns.map((turn) => (
          turn.status === "pending" || turn.status === "generating"
            ? {
                ...turn,
                status: "cancelled" as const,
                errorCode: "admin_chat_superseded",
                decisionReason: "已有新消息 本轮结果已作废并按最新内容重新排查",
                updatedAt: now,
                completedAt: now,
              }
            : turn
        )), optimistic],
      }
      sessions = sessions.map((session) => session.id === requestedSessionId ? {
        ...session,
        updatedAt: now,
        latestTurnStatus: "pending",
        latestTurnUpdatedAt: now,
      } : session)
      renderSessionList()
      renderConversation(true)
    }

    const request = requestedSessionId
      ? api.createAdminChatTurn(requestedSessionId, value, filesToSend.map((item) => item.file)).then((turn) => ({ turn, session: null }))
      : api.createAdminChatConversation(requestedServiceId, value, filesToSend.map((item) => item.file))

    void request.then((created) => {
      filesToSend.forEach((item) => releasePreview(item.previewUrl))
      if (!isActive()) return
      if (created.session) {
        draftingNewSession = false
        activeSessionId = created.session.id
        const liveSession: AdminChatSession = {
          ...created.session,
          latestTurnStatus: created.turn.status,
          latestTurnUpdatedAt: created.turn.updatedAt,
        }
        sessions = [liveSession, ...sessions.filter((item) => item.id !== created.session!.id)]
        detail = { session: created.session, turns: [created.turn] }
        context.replaceChildren(
          element("strong", "admin-chat-context__title", created.session.title),
          element("span", "admin-chat-context__meta", `${created.session.project.name} · ${created.session.service.name} · ${created.session.service.branch} · ${created.session.createdByUsername}`),
        )
      } else if (detail && activeSessionId === requestedSessionId) {
        detail = {
          ...detail,
          turns: detail.turns.some((turn) => turn.id === optimisticId)
            ? detail.turns.map((turn) => turn.id === optimisticId ? created.turn : turn)
            : [...detail.turns.filter((turn) => turn.id !== created.turn.id), created.turn].sort((left, right) => left.position - right.position),
        }
      }
      renderSessionList()
      renderConversation(true)
      notify(optimisticallySuperseded.length > 0 ? "已按最新消息重新开始排查" : "消息已发送")
      schedulePolling()
      void loadSessions(activeSessionId, false)
    }).catch((cause: unknown) => {
      if (!isActive()) return
      if (detail && activeSessionId === requestedSessionId && optimisticId) {
        const previousById = new Map(optimisticallySuperseded.map((turn) => [turn.id, turn]))
        detail = {
          ...detail,
          turns: detail.turns
            .filter((turn) => turn.id !== optimisticId)
            .map((turn) => turn.errorCode === "admin_chat_superseded" ? previousById.get(turn.id) ?? turn : turn),
        }
      }
      question.value = [value, question.value.trim()].filter(Boolean).join("\n")
      selectedFiles = [...filesToSend, ...selectedFiles]
      resizeComposer()
      renderSelectedFiles()
      renderConversation(false)
      notify(cause instanceof Error ? cause.message : "发送失败")
      if (requestedSessionId === activeSessionId) void refreshDetail(false)
    }).finally(() => {
      if (!isActive()) return
      submitting = false
      setComposerState()
      question.focus()
    })
  })

  startLiveUpdates()
  void api.getAdminChatServices().then((response) => {
    if (!isActive()) return
    projects = response.projects
    const options = serviceOptions(projects)
    replaceChildren(serviceSelect)
    if (!options.length) {
      const option = element("option", "", "没有已启用服务")
      option.value = ""
      serviceSelect.append(option)
      serviceSelect.disabled = true
      setComposerState()
      return
    }
    options.forEach(({ project, service }) => {
      const option = element("option", "", `${project.name} · ${service.name} · ${service.branch}`)
      option.value = service.id
      serviceSelect.append(option)
    })
    const preferred = options.some((item) => item.service.id === selectedServiceId) ? selectedServiceId : options[0]!.service.id
    serviceSelect.value = preferred
    serviceSelect.disabled = false
    chooseService()
    void loadSessions()
  }).catch((cause: unknown) => {
    if (!isActive()) return
    const option = element("option", "", "服务加载失败")
    option.value = ""
    replaceChildren(serviceSelect, option)
    serviceSelect.disabled = true
    notify(cause instanceof Error ? cause.message : "服务加载失败")
  })
}
