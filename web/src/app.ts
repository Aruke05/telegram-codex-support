import { api } from "./api.js"
import { errorState, loadTheme, loadingState, setButtonBusy, setTheme } from "./components.js"
import { element, replaceChildren } from "./dom.js"
import { formatDateTime } from "./format.js"
import { icon, type IconName } from "./icons.js"
import { watchRoutes } from "./router.js"
import { AppStore, type OverviewState } from "./store.js"
import type { MenuKey, RouteKey, ThemePreference } from "./types.js"
import { renderConnections } from "./views/accounts-groups.js"
import { renderDocs } from "./views/docs.js"
import { renderMemories } from "./views/memories.js"
import { renderModels } from "./views/models.js"
import { renderOverview } from "./views/overview.js"
import { renderProjects } from "./views/projects.js"
import { renderReplies, stopReplyEvents } from "./views/replies.js"
import { renderAdminChat, stopAdminChatEvents } from "./views/admin-chat.js"
import { renderSettings } from "./views/settings.js"
import { renderTransfer } from "./views/transfer.js"
import { renderRuntime } from "./views/runtime.js"
import { renderAccessControl } from "./views/access-control.js"

type NavigationItem = { route: MenuKey; label: string; title?: string; section: string; icon: IconName }

const items: NavigationItem[] = [
  { route: "overview", label: "运行概览", section: "控制台", icon: "dashboard" },
  { route: "projects", label: "项目管理", section: "AI 客服", icon: "server" },
  { route: "connections", label: "群与账号", section: "AI 客服", icon: "groups" },
  { route: "replies", label: "客服记录", section: "AI 客服", icon: "reply" },
  { route: "chat", label: "AI 对话", title: "AI 客服对话", section: "AI 客服", icon: "chat" },
  { route: "memories", label: "AI 记忆库", section: "知识", icon: "memory" },
  { route: "docs", label: "接口文档", section: "知识", icon: "document" },
  { route: "models", label: "模型管理", section: "运行", icon: "sparkles" },
  { route: "runtime", label: "运行配置", section: "运行", icon: "cpu" },
  { route: "transfer", label: "导入导出", section: "数据", icon: "transfer" },
  { route: "settings", label: "系统设置", section: "数据", icon: "settings" },
  { route: "access", label: "账号与角色", section: "数据", icon: "shield" },
]

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error("页面结构不完整")
  return node
}

const shell = required<HTMLElement>("#app")
const loginScreen = required<HTMLElement>("#login-screen")
const loginForm = required<HTMLFormElement>("#login-form")
const loginUsername = required<HTMLInputElement>("#login-username")
const loginPassword = required<HTMLInputElement>("#login-secret")
loginPassword.type = "password"
const loginError = required<HTMLElement>("#login-error")
const loginSubmit = required<HTMLButtonElement>("#login-submit")
const navigation = required<HTMLElement>("#navigation")
const main = required<HTMLElement>("#main-content")
const topbarTitle = required<HTMLElement>("#topbar-title")
const lastUpdated = required<HTMLElement>("#last-updated")
const refreshButton = required<HTMLButtonElement>("#refresh-button")
const themeSelect = required<HTMLSelectElement>("#theme-select")
const mobileMenu = required<HTMLButtonElement>("#mobile-menu")
const sidebarScrim = required<HTMLButtonElement>("#sidebar-scrim")
const toast = required<HTMLElement>("#toast")
const logoutButton = required<HTMLButtonElement>("#logout-button")

const store = new AppStore(api)
let overview: OverviewState | undefined
let currentRoute: RouteKey = "overview"
let toastTimer: number | undefined
let pageTitleBase = "AI 客服控制台"
let adminChatTitleTimer = 0
let adminChatTitleFlip = false
let authenticated = false
let notificationsStarted = false
let notificationListenersInstalled = false
let notificationEvents: EventSource | null = null
let grantedMenus = new Set<MenuKey>()
const adminChatUnreadStorageKey = "mercuryclaw.admin-chat.unread-sessions"

function adminChatUnreadSessions(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(adminChatUnreadStorageKey) || "[]") as unknown
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

function saveAdminChatUnreadSessions(sessionIds: Set<string>): void {
  try { localStorage.setItem(adminChatUnreadStorageKey, JSON.stringify([...sessionIds])) } catch { /* 无痕模式下仍可使用当前页面。 */ }
}

function refreshAdminChatNotifications(): void {
  const count = adminChatUnreadSessions().size
  const chatLink = navigation.querySelector<HTMLAnchorElement>('a[data-route="chat"]')
  let unread = chatLink?.querySelector<HTMLElement>(".navigation__unread-count") ?? null
  if (chatLink && count > 0 && !unread) {
    unread = element("span", "navigation__unread-count")
    chatLink.insertBefore(unread, chatLink.querySelector(".navigation__chevron"))
  }
  if (unread) {
    unread.textContent = count > 99 ? "99+" : String(count)
    unread.hidden = count === 0
  }

  window.clearInterval(adminChatTitleTimer)
  adminChatTitleTimer = 0
  const renderTitle = () => {
    document.title = count === 0
      ? pageTitleBase
      : document.hidden
        ? (adminChatTitleFlip ? `● ${count} 条新回复` : `${count} 条未读 · AI 客服`)
        : `(${count}) ${pageTitleBase}`
    adminChatTitleFlip = !adminChatTitleFlip
  }
  renderTitle()
  if (count > 0 && document.hidden) adminChatTitleTimer = window.setInterval(renderTitle, 1200)
}

function startAdminChatNotifications(): void {
  if (notificationsStarted || !grantedMenus.has("chat") || typeof EventSource === "undefined") return
  notificationsStarted = true
  notificationEvents = new EventSource("/api/replies/events")
  notificationEvents.addEventListener("admin-chat-turn", (event) => {
    let update: { sessionId?: string; status?: string } | null = null
    try { update = JSON.parse((event as MessageEvent<string>).data) as { sessionId?: string; status?: string } } catch { return }
    if (!update?.sessionId || !["completed", "failed", "cancelled"].includes(update.status || "")) return
    const unread = adminChatUnreadSessions()
    unread.add(update.sessionId)
    saveAdminChatUnreadSessions(unread)
    document.dispatchEvent(new CustomEvent("admin-chat-turn-notification", { detail: update }))
    refreshAdminChatNotifications()
  })
  if (!notificationListenersInstalled) {
    notificationListenersInstalled = true
    document.addEventListener("admin-chat-unread-changed", refreshAdminChatNotifications)
    document.addEventListener("visibilitychange", refreshAdminChatNotifications)
  }
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add("is-visible")
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600)
}

function markChanged(): void {
  store.invalidate()
  overview = undefined
}

function closeSidebar(): void {
  shell.classList.remove("sidebar-open")
  mobileMenu.setAttribute("aria-expanded", "false")
}

function buildNavigation(): void {
  replaceChildren(navigation)
  let activeSection = ""
  items.filter((item) => grantedMenus.has(item.route)).forEach((item) => {
    if (item.section !== activeSection) {
      navigation.append(element("p", "navigation__section", item.section))
      activeSection = item.section
    }
    const link = element("a", "navigation__item")
    link.href = `#/${item.route}`
    link.dataset.route = item.route
    link.append(icon(item.icon, "navigation__icon"), element("span", "navigation__label", item.label), icon("chevron", "navigation__chevron"))
    link.addEventListener("click", closeSidebar)
    navigation.append(link)
  })
}

function updateNavigation(route: RouteKey): void {
  navigation.querySelectorAll<HTMLAnchorElement>("a[data-route]").forEach((link) => {
    const active = link.dataset.route === route
    link.classList.toggle("is-active", active)
    if (active) link.setAttribute("aria-current", "page")
    else link.removeAttribute("aria-current")
  })
  const item = items.find((candidate) => candidate.route === route)
  topbarTitle.textContent = item?.title ?? item?.label ?? "运行概览"
  pageTitleBase = `${topbarTitle.textContent} · AI 客服控制台`
  refreshAdminChatNotifications()
}

function renderCurrentRoute(): void {
  if (!grantedMenus.has(currentRoute)) return
  updateNavigation(currentRoute)
  if (currentRoute !== "replies") stopReplyEvents()
  if (currentRoute !== "chat") stopAdminChatEvents()
  if ((currentRoute === "overview" || currentRoute === "settings") && !overview) {
    replaceChildren(main, loadingState())
    return
  }
  if (currentRoute === "overview") renderOverview(main, overview!)
  else if (currentRoute === "projects") renderProjects(main, showToast, markChanged)
  else if (currentRoute === "connections") renderConnections(main, showToast, markChanged)
  else if (currentRoute === "replies") renderReplies(main, showToast, markChanged)
  else if (currentRoute === "chat") renderAdminChat(main, showToast)
  else if (currentRoute === "memories") renderMemories(main, showToast, markChanged)
  else if (currentRoute === "docs") renderDocs(main)
  else if (currentRoute === "models") renderModels(main, showToast)
  else if (currentRoute === "runtime") renderRuntime(main, showToast)
  else if (currentRoute === "transfer") renderTransfer(main, showToast, markChanged)
  else if (currentRoute === "access") renderAccessControl(main, showToast)
  else renderSettings(main, overview!)
}

function loadCurrentRoute(force = false): void {
  if (!authenticated) return
  if (currentRoute === "overview" || currentRoute === "settings") void loadOverview(force)
  else {
    lastUpdated.textContent = ""
    renderCurrentRoute()
  }
}

async function loadOverview(force = false): Promise<void> {
  setButtonBusy(refreshButton, true)
  if (!overview) replaceChildren(main, loadingState())
  try {
    overview = await store.loadOverview(force)
    lastUpdated.textContent = `更新于 ${formatDateTime(overview.loadedAt)}`
    renderCurrentRoute()
    if (force) showToast("已刷新")
  } catch (error) {
    const message = error instanceof Error ? error.message : "加载失败，请重试"
    stopAdminChatEvents()
    replaceChildren(main, errorState(message, () => { void loadOverview(true) }))
    lastUpdated.textContent = "加载失败"
  } finally {
    setButtonBusy(refreshButton, false)
  }
}

mobileMenu.append(icon("menu"))
required<HTMLElement>(".refresh-button__icon").append(icon("refresh"))
const initialTheme = loadTheme()
themeSelect.value = initialTheme
setTheme(initialTheme)
themeSelect.addEventListener("change", () => setTheme(themeSelect.value as ThemePreference))
mobileMenu.setAttribute("aria-expanded", "false")
mobileMenu.addEventListener("click", () => {
  const open = shell.classList.toggle("sidebar-open")
  mobileMenu.setAttribute("aria-expanded", String(open))
})
sidebarScrim.addEventListener("click", closeSidebar)
refreshButton.addEventListener("click", () => {
  store.invalidate()
  overview = undefined
  loadCurrentRoute(true)
})
watchRoutes({
  location: window.location,
  addEventListener: (_type, listener) => window.addEventListener("hashchange", listener),
  removeEventListener: (_type, listener) => window.removeEventListener("hashchange", listener),
}, (route) => {
  currentRoute = route
  if (!authenticated) return
  if (!grantedMenus.has(route)) {
    const fallback = items.find((item) => grantedMenus.has(item.route))?.route ?? "chat"
    if (window.location.hash !== `#/${fallback}`) window.location.hash = `#/${fallback}`
    return
  }
  loadCurrentRoute()
  main.scrollTo({ top: 0, behavior: "instant" })
})

function showLogin(message = ""): void {
  authenticated = false
  grantedMenus.clear()
  stopAdminChatEvents()
  stopReplyEvents()
  notificationEvents?.close()
  notificationEvents = null
  notificationsStarted = false
  shell.hidden = true
  loginScreen.hidden = false
  loginError.textContent = message
  loginPassword.value = ""
  window.setTimeout(() => loginUsername.focus(), 0)
}

function enterConsole(menus: MenuKey[]): void {
  grantedMenus = new Set(menus)
  authenticated = true
  loginScreen.hidden = true
  shell.hidden = false
  shell.dataset.ready = "true"
  buildNavigation()
  startAdminChatNotifications()
  const fallback = items.find((item) => grantedMenus.has(item.route))?.route
  if (!fallback) {
    showLogin("当前账号没有可用功能")
    return
  }
  if (!grantedMenus.has(currentRoute)) {
    window.location.hash = `#/${fallback}`
  } else loadCurrentRoute()
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault()
  loginError.textContent = ""
  setButtonBusy(loginSubmit, true)
  void api.login(loginUsername.value, loginPassword.value).then((context) => {
    loginPassword.value = ""
    enterConsole(context.menus)
  }).catch((error: unknown) => {
    loginError.textContent = error instanceof Error ? error.message : "登录失败，请稍后再试"
    loginPassword.select()
  }).finally(() => setButtonBusy(loginSubmit, false))
})

logoutButton.addEventListener("click", () => {
  setButtonBusy(logoutButton, true)
  void api.logout().catch(() => undefined).finally(() => {
    setButtonBusy(logoutButton, false)
    showLogin()
  })
})

api.onUnauthorized(() => showLogin("登录已失效，请重新登录"))

void api.getAuthContext().then((context) => enterConsole(context.menus)).catch(() => showLogin())
