import { badge, labeledValue, metricCard, pageHeader } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime, shortHash } from "../format.js"
import { icon } from "../icons.js"
import type { OverviewState } from "../store.js"

export function renderOverview(container: HTMLElement, state: OverviewState): void {
  const configuredGroups = state.groups.groups.filter((group) => group.configured).length
  const enabledGroups = state.groups.groups.filter((group) => group.enabled).length
  const readyAccounts = state.accounts.accounts.filter((account) => account.status === "ready").length
  const activeMemories = state.memories.filter((memory) => memory.status === "active").length
  const pending = state.memories.filter((memory) => memory.status === "candidate" || memory.status === "conflict").length

  const content = element("section", "page-content overview-page")
  content.append(pageHeader("运行概览", "今天需要看的，都在这里", "群、客服账号、AI 记忆和纠正记录使用同一个本机 SQLite。"))

  const hero = element("article", "hero-card")
  const heroCopy = element("div", "hero-card__copy")
  heroCopy.append(
    badge(state.health.status === "ok" ? "管理基础正常 · 监听待接入" : "服务异常", state.health.status === "ok" ? "warning" : "danger"),
    element("h2", "hero-card__title", configuredGroups ? "客服配置可以继续完善" : "先配置客服账号和测试群"),
    element("p", "hero-card__text", "接入 Telegram 监听与 Codex 调度后，每次回答必须先核对群对应分支的最新代码；记忆只负责快速定位和复用。"),
  )
  const heroVisual = element("div", "hero-visual")
  const orb = element("div", "hero-orb")
  orb.append(icon("memory", "hero-orb__icon"))
  heroVisual.append(element("span", "hero-orb__pulse"), orb, badge(`记忆代次 ${state.memoryGeneration}`, "accent"))
  hero.append(heroCopy, heroVisual)
  content.append(hero)

  const metrics = element("div", "metric-grid")
  metrics.append(
    metricCard("客服账号", `${readyAccounts} / ${state.accounts.accounts.length}`, "连接正常 / 已配置", "bot", readyAccounts ? "success" : "warning"),
    metricCard("白名单群", `${enabledGroups} / ${state.groups.groups.length}`, `${configuredGroups} 个已完成配置`, "groups", enabledGroups ? "success" : "accent"),
    metricCard("当前记忆", String(activeMemories), `${pending} 条待处理或冲突`, "memory", pending ? "warning" : "success"),
    metricCard("最近回复", String(state.replies.length), "后台可直接纠正", "reply", "neutral"),
  )
  content.append(metrics)

  const lowerGrid = element("div", "overview-grid")
  const memoryPanel = element("article", "panel")
  const memoryHead = element("div", "panel__header")
  const memoryTitle = element("div")
  memoryTitle.append(element("p", "eyebrow", "AI 记忆"), element("h2", "panel__title", "追加证据，保留旧版本"))
  memoryHead.append(memoryTitle, badge(`${state.directives.filter((item) => item.enabled).length} 条固定规则`, "accent"))
  const memoryDetails = element("div", "detail-list")
  memoryDetails.append(
    labeledValue("当前有效", `${activeMemories} 条`, "check"),
    labeledValue("候选与冲突", `${pending} 条`, "clock"),
    labeledValue("整理原则", "AI 只新增版本，不覆盖历史", "memory"),
  )
  memoryPanel.append(memoryHead, memoryDetails)

  const sourcePanel = element("article", "panel panel--safety")
  const sourceHead = element("div", "panel__header")
  const sourceTitle = element("div")
  sourceTitle.append(element("p", "eyebrow", "本地知识"), element("h2", "panel__title", "MagicBook 与接口文档"))
  sourceHead.append(sourceTitle, badge("只读快照", "success"))
  const sourceDetails = element("div", "detail-list")
  sourceDetails.append(
    labeledValue("服务 / 地区", `${state.magicBook.serviceCount} / ${state.magicBook.regionCount}`, "book"),
    labeledValue("内容摘要", shortHash(state.magicBook.contentHash), "shield"),
    labeledValue("导入时间", formatDateTime(state.magicBook.importedAt), "clock"),
  )
  sourcePanel.append(sourceHead, sourceDetails)
  lowerGrid.append(memoryPanel, sourcePanel)
  content.append(lowerGrid)

  replaceChildren(container, content)
}
