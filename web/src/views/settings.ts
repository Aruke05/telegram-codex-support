import { badge, pageHeader } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime, shortHash } from "../format.js"
import { icon, type IconName } from "../icons.js"
import type { OverviewState } from "../store.js"

function settingCard(iconName: IconName, title: string, description: string, rows: Array<[string, string, "success" | "warning" | "neutral" | "accent"]>): HTMLElement {
  const card = element("article", "setting-card")
  const head = element("div", "setting-card__head")
  const marker = element("span", "setting-card__icon"); marker.append(icon(iconName))
  const copy = element("div"); copy.append(element("h2", "setting-card__title", title), element("p", "setting-card__description", description))
  head.append(marker, copy)
  const list = element("div", "setting-list")
  rows.forEach(([label, value, tone]) => {
    const row = element("div", "setting-row")
    row.append(element("span", "setting-row__label", label), badge(value, tone))
    list.append(row)
  })
  card.append(head, list)
  return card
}

export function renderSettings(container: HTMLElement, state: OverviewState): void {
  const content = element("section", "page-content settings-page")
  content.append(pageHeader("运行方式", "系统设置", "这里只显示会影响客服判断的全局配置；账号和群在“群与账号”维护。"))
  const grid = element("div", "settings-grid")
  grid.append(
    settingCard("sparkles", "Codex 执行", "本机 Codex 已使用临时无状态会话和结构化输出。", [
      ["当前状态", "已接入", "success"], ["会话", "临时无状态", "neutral"], ["回答语言", "简体中文", "success"],
    ]),
    settingCard("branch", "代码同步", "后台每 30 分钟分批拉取服务双仓 回答直接读取当前已发布快照", [
      ["当前状态", "错峰串行", "success"], ["仓库权限", "只读快照", "success"], ["接入范围", "项目配置驱动", "neutral"],
    ]),
    settingCard("memory", "自动学习", "问答事件后台批量整理，重复低风险知识按证据自动生效。", [
      ["版本记忆", "已运行", "success"], ["后台整理", "自动", "success"], ["高风险", "必须人工确认", "warning"],
    ]),
    settingCard("document", "文件与乱码", "文本、图片、PDF、压缩包和视频元数据已进入判断链路。", [
      ["当前状态", "已接入", "success"], ["无法解析", "明确说明", "neutral"], ["乱码阻断", "已开启", "success"],
    ]),
  )
  content.append(grid)

  const magicBook = element("article", "panel settings-snapshot")
  const head = element("div", "panel__header")
  const title = element("div"); title.append(element("p", "eyebrow", "MagicBook 本地快照"), element("h2", "panel__title", "不会每次在线读取"))
  head.append(title, badge(`${state.magicBook.serviceCount} 个服务`, "success"))
  const facts = element("div", "setting-facts")
  ;[
    ["服务 / 地区", `${state.magicBook.serviceCount} / ${state.magicBook.regionCount}`],
    ["内容摘要", shortHash(state.magicBook.contentHash)],
    ["导入时间", formatDateTime(state.magicBook.importedAt)],
    ["提示词兜底", state.magicBook.promptFallback.enabled ? "已开启" : "默认关闭，必要时再用"],
  ].forEach(([label, value]) => { const item = element("div", "setting-fact"); item.append(element("span", "", label), element("strong", "", value)); facts.append(item) })
  magicBook.append(head, facts)
  content.append(magicBook)
  replaceChildren(container, content)
}
