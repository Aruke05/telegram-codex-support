import { api } from "../api.js"
import { actionButton, badge, openDialog, pageHeader, setButtonBusy } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { icon } from "../icons.js"

type Notify = (message: string) => void

function startDownload(): void {
  const link = document.createElement("a")
  link.href = "/api/transfer/export"
  link.download = `telegram-support-${new Date().toISOString().slice(0, 10)}.sqlite`
  document.body.append(link)
  link.click()
  link.remove()
}

export function renderTransfer(container: HTMLElement, notify: Notify, onChanged: () => void): void {
  const content = element("section", "page-content transfer-page")
  content.append(pageHeader("电脑迁移", "导入导出", "导出文件就是 SQLite；新电脑先配置客服号，再导入这个文件。"))
  const grid = element("div", "transfer-grid")
  const exportCard = element("article", "transfer-card")
  const exportIcon = element("span", "transfer-card__icon"); exportIcon.append(icon("download"))
  const exportButton = actionButton("导出 SQLite", "primary")
  exportCard.append(exportIcon, badge("可直接读取", "success"), element("h2", "transfer-card__title", "带走全部客服记忆"), element("p", "transfer-card__text", "包含真实群 ID、角色、固定规则、证据、全部版本、回复和审核轨迹。"), exportButton)

  const importCard = element("article", "transfer-card")
  const importIcon = element("span", "transfer-card__icon"); importIcon.append(icon("upload"))
  const file = element("input", "visually-hidden")
  file.type = "file"; file.accept = ".sqlite,.db,application/vnd.sqlite3,application/octet-stream"
  const importButton = actionButton("选择 SQLite 文件")
  importCard.append(importIcon, badge("保留本机客服号", "accent"), element("h2", "transfer-card__title", "导入到这台电脑"), element("p", "transfer-card__text", "导入会替换群、角色和记忆数据，再按 Bot / 个人账号类型重新绑定本机客服号。"), importButton, file)
  grid.append(exportCard, importCard)
  content.append(grid)

  const note = element("article", "panel transfer-note")
  const noteTitle = element("div", "panel__header")
  const title = element("div"); title.append(element("p", "eyebrow", "迁移文件安全范围"), element("h2", "panel__title", "基础设施凭据会明文导出"))
  noteTitle.append(title, badge("需安全保管", "warning"))
  const list = element("ul", "plain-list")
  ;[
    "会明文导出：服务器 IP、SSH 私钥、数据库地址、账号和密码",
    "不会导出：Bot Token、API Hash、Telegram Session 和本机主密钥",
    "不会导出：商户密钥；代码仓库 URL 在普通页面只显示去凭据版本",
    "迁移文件等同生产密钥文件，只能放在受控设备，导入后及时删除副本",
  ].forEach((value) => list.append(element("li", "", value)))
  note.append(noteTitle, list)
  content.append(note)
  replaceChildren(container, content)

  exportButton.addEventListener("click", () => {
    startDownload()
    notify("已开始导出 SQLite")
  })
  importButton.addEventListener("click", () => file.click())
  file.addEventListener("change", () => {
    const selected = file.files?.[0]
    if (!selected) return
    const warning = element("div", "import-warning")
    warning.append(element("p", "", `文件：${selected.name}`), element("p", "", "现有群、角色、记忆和回复会被迁移库替换；本机客服账号及凭据保留。"))
    const cancel = actionButton("取消")
    const confirm = actionButton("确认导入", "danger")
    const modal = openDialog({ eyebrow: "导入 SQLite", title: "确认替换可迁移数据？", description: "数据库校验失败会整笔回滚。", content: warning, actions: [cancel, confirm] })
    cancel.addEventListener("click", () => { file.value = ""; modal.close() })
    confirm.addEventListener("click", () => {
      setButtonBusy(confirm, true)
      void api.importDatabase(selected).then(() => {
        notify("SQLite 已导入并重新绑定客服号")
        onChanged()
        modal.close()
      }).catch((error: unknown) => notify(error instanceof Error ? error.message : "导入失败")).finally(() => { file.value = ""; setButtonBusy(confirm, false) })
    })
  })
}
