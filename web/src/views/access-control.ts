import { api } from "../api.js"
import { actionButton, badge, emptyState, formField, loadingState, openDialog, pageHeader, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime } from "../format.js"
import { icon } from "../icons.js"
import type { AccessControlState, AccessRole, AccessUser, MenuKey } from "../types.js"

type Notify = (message: string) => void

const menuOptions: Array<{ key: MenuKey; label: string }> = [
  { key: "overview", label: "运行概览" },
  { key: "projects", label: "项目管理" },
  { key: "connections", label: "群与账号" },
  { key: "replies", label: "客服记录" },
  { key: "chat", label: "AI 对话" },
  { key: "memories", label: "AI 记忆库" },
  { key: "docs", label: "接口文档" },
  { key: "models", label: "模型管理" },
  { key: "runtime", label: "运行配置" },
  { key: "transfer", label: "导入导出" },
  { key: "settings", label: "系统设置" },
  { key: "access", label: "账号与角色" },
]

function permissionLabel(role: AccessRole | undefined): string {
  if (!role) return "未配置"
  if (role.menus.length === menuOptions.length) return "全部功能"
  if (role.menus.length === 1 && role.menus[0] === "chat") return "仅 AI 对话"
  return `${role.menus.length} 个菜单`
}

function editRole(role: AccessRole, refresh: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const name = textInput("name", "角色名称")
  name.required = true
  name.value = role.name
  const menuGrid = element("div", "access-menu-grid")
  const controls = menuOptions.map((option) => {
    const item = element("label", "access-menu-option")
    const input = element("input")
    input.type = "checkbox"
    input.value = option.key
    input.checked = role.menus.includes(option.key)
    input.disabled = !role.menusEditable
    item.append(input, element("span", "", option.label))
    menuGrid.append(item)
    return { key: option.key, input }
  })
  const hint = role.menusEditable
    ? "勾选后，该角色下的账号才能看到并调用对应功能。"
    : "全部功能角色固定拥有所有菜单，可修改显示名称。"
  const error = element("p", "form-error")
  form.append(formField("角色名称", name), formField("菜单权限", menuGrid, hint), error)
  const cancel = actionButton("取消")
  const save = actionButton("保存角色", "primary")
  const modal = openDialog({ eyebrow: "角色配置", title: `编辑 ${role.name}`, content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close)
  const submit = () => {
    error.textContent = ""
    if (!form.reportValidity()) return
    const menus = controls.filter((control) => control.input.checked).map((control) => control.key)
    if (!menus.length) { error.textContent = "角色至少保留一个菜单"; return }
    setButtonBusy(save, true)
    void api.updateAccessRole(role.id, { name: name.value.trim(), menus }).then(async () => {
      modal.close()
      notify("角色与菜单权限已更新")
      await refresh()
    }).catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "保存失败，请重试"
    }).finally(() => setButtonBusy(save, false))
  }
  save.addEventListener("click", submit)
  form.addEventListener("submit", (event) => { event.preventDefault(); submit() })
  requestAnimationFrame(() => name.focus())
}

function editAccount(
  state: AccessControlState,
  existing: AccessUser | undefined,
  refresh: () => Promise<void>,
  notify: Notify,
): void {
  const form = element("form", "dialog-form")
  const username = textInput("username", "请输入登录账号")
  username.required = true
  username.value = existing?.username ?? ""
  const password = textInput("password", existing ? "留空表示不修改" : "至少 8 位")
  password.type = "password"
  password.autocomplete = "new-password"
  password.required = !existing
  password.minLength = 8
  const role = selectInput("roleId", state.roles.map((item) => ({
    value: item.id,
    label: `${item.name} · ${permissionLabel(item)}`,
  })))
  role.value = existing?.roleIds[0] ?? state.roles[0]?.id ?? ""
  const enabledRow = element("label", "toggle-row")
  const enabled = element("input")
  enabled.type = "checkbox"
  enabled.checked = existing?.enabled ?? true
  enabled.disabled = existing?.id === state.currentUserId
  enabledRow.append(enabled, element("span", "toggle-row__track"), element("span", "toggle-row__copy", "允许登录"))
  const error = element("p", "form-error")
  const fields = element("div", "form-grid")
  fields.append(formField("登录账号", username), formField("权限方案", role))
  form.append(
    fields,
    formField(existing ? "重置密码" : "登录密码", password, existing ? "不修改密码时保持留空。" : "新账号密码至少 8 位。"),
    enabledRow,
    error,
  )
  const cancel = actionButton("取消")
  const save = actionButton(existing ? "保存修改" : "新增账号", "primary")
  const modal = openDialog({
    eyebrow: "账号权限",
    title: existing ? `编辑 ${existing.username}` : "新增登录账号",
    description: "权限在接口和页面两层同时生效。",
    content: form,
    actions: [cancel, save],
  })
  cancel.addEventListener("click", modal.close)
  const submit = () => {
    error.textContent = ""
    if (!form.reportValidity()) return
    setButtonBusy(save, true)
    const input = {
      username: username.value.trim(),
      ...(password.value ? { password: password.value } : {}),
      roleId: role.value,
      enabled: enabled.checked,
    }
    const request = existing
      ? api.updateAccessUser(existing.id, input)
      : api.createAccessUser({ ...input, password: password.value })
    void request.then(async () => {
      modal.close()
      notify(existing ? "账号权限已更新" : "账号已新增")
      await refresh()
    }).catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "保存失败，请重试"
    }).finally(() => setButtonBusy(save, false))
  }
  save.addEventListener("click", submit)
  form.addEventListener("submit", (event) => { event.preventDefault(); submit() })
  requestAnimationFrame(() => username.focus())
}

function accountRow(
  state: AccessControlState,
  user: AccessUser,
  refresh: () => Promise<void>,
  notify: Notify,
): HTMLElement {
  const row = element("article", "access-account")
  const marker = element("span", "access-account__icon")
  marker.append(icon("user"))
  const copy = element("div", "access-account__copy")
  const heading = element("div", "access-account__heading")
  heading.append(element("strong", "access-account__name", user.username))
  if (user.id === state.currentUserId) heading.append(badge("当前账号", "accent"))
  const assigned = state.roles.find((role) => user.roleIds.includes(role.id))
  copy.append(
    heading,
    element("p", "access-account__meta", `${permissionLabel(assigned)} · ${user.enabled ? "允许登录" : "已停用"} · 更新于 ${formatDateTime(user.updatedAt)}`),
  )
  const status = badge(user.enabled ? "已启用" : "已停用", user.enabled ? "success" : "neutral")
  const edit = actionButton("编辑", "secondary")
  edit.addEventListener("click", () => editAccount(state, user, refresh, notify))
  row.append(marker, copy, status, edit)
  return row
}

function roleRow(role: AccessRole, refresh: () => Promise<void>, notify: Notify): HTMLElement {
  const row = element("article", "access-account")
  const marker = element("span", "access-account__icon")
  marker.append(icon("shield"))
  const copy = element("div", "access-account__copy")
  copy.append(
    element("strong", "access-account__name", role.name),
    element("p", "access-account__meta", `${permissionLabel(role)} · ${role.menus.map((menu) => menuOptions.find((option) => option.key === menu)?.label).filter(Boolean).join("、")}`),
  )
  const status = badge(role.menusEditable ? "可配置" : "全部功能", role.menusEditable ? "neutral" : "accent")
  const edit = actionButton("编辑角色", "secondary")
  edit.addEventListener("click", () => editRole(role, refresh, notify))
  row.append(marker, copy, status, edit)
  return row
}

export function renderAccessControl(container: HTMLElement, notify: Notify): void {
  const content = element("section", "page-content access-page")
  const header = element("div", "page-heading-row")
  const add = actionButton("新增账号", "primary")
  header.append(pageHeader("访问控制", "账号与角色", "配置登录账号、角色以及每个角色可使用的菜单。"), add)
  const tabs = element("div", "segmented access-tabs")
  const accountTab = element("button", "segmented__item is-active", "账号")
  const roleTab = element("button", "segmented__item", "角色与菜单")
  accountTab.type = "button"
  roleTab.type = "button"
  tabs.append(accountTab, roleTab)
  const body = element("section", "panel access-panel")
  body.append(loadingState(3))
  content.append(header, tabs, body)
  replaceChildren(container, content)

  let state: AccessControlState | null = null
  let active: "accounts" | "roles" = "accounts"
  const render = (): void => {
    if (!state) return
    accountTab.classList.toggle("is-active", active === "accounts")
    roleTab.classList.toggle("is-active", active === "roles")
    add.hidden = active !== "accounts"
    if (active === "roles") {
      replaceChildren(body, ...state.roles.map((role) => roleRow(role, refresh, notify)))
      return
    }
    replaceChildren(body, ...state.users.map((user) => accountRow(state!, user, refresh, notify)))
  }
  const refresh = async (): Promise<void> => {
    try {
      state = await api.getAccessControl()
      const current = state
      if (!current.users.length && active === "accounts") {
        replaceChildren(body, emptyState("还没有账号", "新增第一个登录账号。", "user"))
        return
      }
      render()
    } catch (cause) {
      replaceChildren(body, emptyState("账号权限加载失败", cause instanceof Error ? cause.message : "请稍后重试", "refresh"))
    }
  }
  add.addEventListener("click", () => {
    if (state) editAccount(state, undefined, refresh, notify)
  })
  accountTab.addEventListener("click", () => { active = "accounts"; render() })
  roleTab.addEventListener("click", () => { active = "roles"; render() })
  void refresh()
}
