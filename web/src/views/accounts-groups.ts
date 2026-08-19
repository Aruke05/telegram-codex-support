import { api } from "../api.js"
import { actionButton, badge, emptyState, formField, loadingState, openDialog, pageHeader, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { icon } from "../icons.js"
import { roleLearningSourceLabel } from "../learning-source-labels.js"
import { accountOptions, allGroupsSelected, buildBatchGroupPatch, groupBatchActionBlocked, partitionGroupsForEnable, performGroupQuickToggle, selectedGroups, sharedAccessMode } from "../group-batch.js"
import { optionalTelegramChatId, validateGroupForm } from "../group-form.js"
import type { ModelInstance, ProjectView, TelegramAccount, TelegramGroup, TelegramLoginState, TelegramRole } from "../types.js"

type ConnectionsData = {
  accounts: TelegramAccount[]
  groups: TelegramGroup[]
  roles: TelegramRole[]
  projects: ProjectView[]
  models: ModelInstance[]
}

type Notify = (message: string) => void

export function replyStyleLabel(style: TelegramGroup["replyStyle"]): string {
  return style === "human" ? "真人口吻" : "AI 原始回复"
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试"
}

function formError(): HTMLElement {
  return element("p", "form-error")
}

function confirmDelete(
  title: string,
  description: string,
  remove: () => Promise<void>,
  onRemoved: () => Promise<void>,
  notify: Notify,
): void {
  const warning = element("div", "inline-alert inline-alert--danger", description)
  const cancel = actionButton("取消")
  const confirm = actionButton("确认删除", "danger")
  const modal = openDialog({ eyebrow: "删除确认", title, content: warning, actions: [cancel, confirm] })
  cancel.addEventListener("click", modal.close)
  confirm.addEventListener("click", () => {
    setButtonBusy(confirm, true)
    void remove().then(async () => {
      notify("已删除")
      modal.close()
      await onRemoved()
    }).catch((cause: unknown) => notify(errorText(cause))).finally(() => setButtonBusy(confirm, false))
  })
}

function group(className: string, ...children: Node[]): HTMLElement {
  const node = element("div", className)
  node.append(...children)
  return node
}

function accountStatus(account: TelegramAccount): ReturnType<typeof badge> {
  if (account.status === "ready") return badge("连接正常", "success")
  if (account.status === "error") return badge("连接失败", "danger")
  if (account.status === "login_required") return badge("需要登录", "warning")
  return badge("尚未检测", "neutral")
}

function accountForm(existing: TelegramAccount | undefined, onSaved: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const name = textInput("name", "例如：MercuryClawBot")
  name.required = true
  name.value = existing?.name ?? ""
  const type = selectInput("type", [
    { value: "bot", label: "Bot（优先）" },
    { value: "user", label: "个人账号" },
  ])
  type.value = existing?.type ?? "bot"
  type.disabled = Boolean(existing)
  const credentials = element("div", "form-grid form-grid--credentials")
  const renderCredentials = () => {
    credentials.replaceChildren()
    if (type.value === "bot") {
      const token = textInput("botToken", existing ? "留空表示不更换" : "粘贴 Bot Token")
      token.type = "password"
      token.required = !existing
      credentials.append(formField(existing ? "新 Token" : "Bot Token", token, "只在本机加密保存，不进入迁移库。"))
    } else {
      const apiId = textInput("apiId", existing ? "留空表示不更换" : "Telegram API ID")
      const apiHash = textInput("apiHash", existing ? "留空表示不更换" : "Telegram API Hash")
      const phone = textInput("phone", existing ? "留空表示不更换" : "+国家码手机号")
      apiHash.type = "password"
      if (!existing) { apiId.required = true; apiHash.required = true; phone.required = true }
      credentials.append(formField("API ID", apiId), formField("API Hash", apiHash), formField("手机号", phone))
    }
  }
  type.addEventListener("change", renderCredentials)
  renderCredentials()
  const enabled = element("input")
  enabled.type = "checkbox"
  enabled.name = "enabled"
  enabled.checked = existing?.enabled ?? false
  const toggle = element("label", "toggle-row")
  toggle.append(enabled, element("span", "toggle-row__track"), element("span", "toggle-row__copy", "启用这个客服账号"))
  const error = formError()
  form.append(group("form-grid", formField("账号名称", name), formField("接入方式", type)), credentials, toggle, error)
  const cancel = actionButton("取消")
  const save = actionButton(existing ? "保存修改" : "添加账号", "primary")
  const modal = openDialog({
    eyebrow: "群与账号",
    title: existing ? "编辑客服账号" : "添加客服账号",
    description: "凭据只保存在当前电脑；迁移到新电脑后需要重新配置。",
    content: form,
    actions: [cancel, save],
  })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    const data = new FormData(form)
    const payload: Record<string, unknown> = { name: String(data.get("name") ?? "").trim(), enabled: enabled.checked }
    if (!existing) payload.type = type.value
    for (const key of ["botToken", "apiId", "apiHash", "phone"] as const) {
      const value = String(data.get(key) ?? "").trim()
      if (value) payload[key] = value
    }
    setButtonBusy(save, true)
    void (existing ? api.updateAccount(existing.id, payload) : api.createAccount(payload)).then(async () => {
      notify(existing ? "账号已更新" : "账号已添加")
      modal.close()
      await onSaved()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function userLoginDialog(account: TelegramAccount, onCompleted: () => Promise<void>, notify: Notify): void {
  let state: TelegramLoginState | null = null
  const flow = element("div", "login-flow")
  const stateIcon = element("span", "login-flow__icon")
  stateIcon.append(icon("user"))
  const stateTitle = element("h3", "login-flow__title", "准备登录 Telegram")
  const stateMessage = element("p", "login-flow__message", "系统会向这个账号发送验证码，可能还需要两步验证密码。")
  const status = element("div", "login-flow__status")
  status.append(stateIcon, group("", stateTitle, stateMessage))
  const input = textInput("loginValue", "")
  const inputWrap = formField("验证码", input)
  inputWrap.hidden = true
  const error = formError()
  flow.append(status, inputWrap, error)

  const cancel = actionButton("取消")
  const next = actionButton("发送验证码", "primary")
  const modal = openDialog({
    eyebrow: "个人账号",
    title: `登录 ${account.name}`,
    description: "验证码和两步验证密码只用于本次登录，不写入迁移库。",
    content: flow,
    actions: [cancel, next],
  })
  cancel.addEventListener("click", modal.close)
  modal.dialog.addEventListener("close", () => { void api.cancelUserLogin(account.id).catch(() => undefined) }, { once: true })

  const renderState = () => {
    if (!state) return
    stateMessage.textContent = state.message
    input.value = ""
    inputWrap.hidden = state.stage !== "waiting_code" && state.stage !== "waiting_password"
    if (state.stage === "waiting_code") {
      input.type = "text"
      input.inputMode = "numeric"
      input.autocomplete = "one-time-code"
      input.placeholder = "输入 Telegram 验证码"
      inputWrap.querySelector("span")!.textContent = "Telegram 验证码"
      next.textContent = "提交验证码"
      input.focus()
    } else if (state.stage === "waiting_password") {
      input.type = "password"
      input.autocomplete = "current-password"
      input.placeholder = "输入两步验证密码"
      inputWrap.querySelector("span")!.textContent = "两步验证密码"
      next.textContent = "完成登录"
      input.focus()
    } else if (state.stage === "error") {
      next.textContent = "重新开始"
    } else if (state.stage === "ready") {
      next.textContent = "已登录"
      next.disabled = true
    }
  }

  next.addEventListener("click", () => {
    error.textContent = ""
    const action = !state || state.stage === "error"
      ? api.startUserLogin(account.id)
      : state.stage === "waiting_code"
        ? api.continueUserLogin(account.id, { code: input.value.trim() })
        : state.stage === "waiting_password"
          ? api.continueUserLogin(account.id, { password: input.value })
          : Promise.resolve(state)
    setButtonBusy(next, true)
    void action.then(async (result) => {
      state = result
      renderState()
      if (result.stage === "ready") {
        notify("个人账号登录完成")
        await onCompleted()
        window.setTimeout(modal.close, 450)
      }
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => {
      if (state?.stage !== "ready") setButtonBusy(next, false)
    })
  })
}

function groupForm(existing: TelegramGroup | undefined, accounts: TelegramAccount[], projects: ProjectView[], models: ModelInstance[], onSaved: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  form.noValidate = true
  const key = textInput("key", "唯一英文标识")
  key.value = existing?.key ?? ""
  key.required = true
  const name = textInput("name", "Telegram 群名称")
  name.value = existing?.name ?? ""
  name.required = true
  const chatId = textInput("telegramChatId", "例如 -1001234567890")
  chatId.value = existing?.telegramChatId ?? ""
  const project = selectInput("projectId", [{ value: "", label: "暂不绑定项目" }, ...projects.map((item) => ({ value: item.id, label: item.name }))])
  project.value = existing?.projectId ?? projects[0]?.id ?? ""
  const service = selectInput("serviceId", [])
  const refreshServices = (selected = service.value) => {
    service.replaceChildren()
    const selectedProject = projects.find((item) => item.id === project.value)
    if (!selectedProject) {
      const empty = element("option", "", "暂不绑定服务"); empty.value = ""; service.append(empty); return
    }
    selectedProject.services.forEach((item) => {
      const option = element("option", "", `${item.name} · ${item.region || "未配置地区"}`); option.value = item.id; service.append(option)
    })
    service.value = selectedProject.services.some((item) => item.id === selected) ? selected : selectedProject.services[0]?.id ?? ""
  }
  project.addEventListener("change", () => refreshServices())
  refreshServices(existing?.serviceId ?? "")
  const accessMode = selectInput("accessMode", [{ value: "bot", label: "Bot" }, { value: "user", label: "个人账号" }])
  accessMode.value = existing?.accessMode ?? "bot"
  const account = selectInput("accountId", [{ value: "", label: "暂不绑定" }])
  const refreshAccounts = (selected = account.value) => {
    account.replaceChildren()
    const empty = element("option", "", "暂不绑定")
    empty.value = ""
    account.append(empty)
    accounts.filter((item) => item.type === accessMode.value).forEach((item) => {
      const option = element("option", "", item.name)
      option.value = item.id
      account.append(option)
    })
    account.value = selected
  }
  accessMode.addEventListener("change", () => refreshAccounts())
  refreshAccounts(existing?.accountId ?? "")
  const triggerMode = selectInput("triggerMode", [{ value: "all", label: "每条文字都判断" }, { value: "command", label: "不处理群消息" }])
  triggerMode.value = existing?.triggerMode ?? "all"
  const purpose = selectInput("purpose", [{ value: "support", label: "客服群" }, { value: "technical_alert", label: "技术告警群" }])
  purpose.value = existing?.purpose ?? "support"
  const aiModel = selectInput("aiModelInstanceId", [
    { value: "", label: "选择模型别名" },
    ...models.map((item) => ({ value: item.id, label: `${item.alias} · ${item.modelId}${item.enabled ? "" : " · 已停用"}` })),
  ])
  aiModel.value = existing?.aiModelInstanceId ?? ""
  const replyStyle = selectInput("replyStyle", [
    { value: "human", label: "真人口吻" },
    { value: "unrestricted", label: "AI 原始回复" },
  ])
  replyStyle.value = existing?.replyStyle ?? "unrestricted"
  const operationMode = selectInput("operationMode", [
    { value: "live", label: "正式回复" },
    { value: "learning", label: "学习模式（只生成不发送）" },
  ])
  operationMode.value = existing?.operationMode ?? "live"
  const projectSection = group("form-section", element("h3", "form-section__title", "项目归属"), group("form-grid", formField("项目（必选）", project), formField("服务（必选）", service)), element("p", "form-section__note", "客服群固定使用这里绑定的服务。消息里的上游名称不会改变服务。"))
  const modelSection = group("form-section", element("h3", "form-section__title", "技术群用途"), element("p", "form-section__note", "只接收运营问题原消息转发 目前不处理 /ai 或其他消息"))
  const enabled = element("input")
  enabled.type = "checkbox"; enabled.name = "enabled"; enabled.checked = existing?.enabled ?? false
  const syncPurpose = () => {
    const technicalAlert = purpose.value === "technical_alert"
    triggerMode.value = technicalAlert ? "command" : "all"
    project.disabled = service.disabled = technicalAlert
    project.required = service.required = !technicalAlert
    chatId.required = !existing || enabled.checked
    projectSection.hidden = technicalAlert
    modelSection.hidden = !technicalAlert
    aiModel.required = false
    operationMode.disabled = technicalAlert
    if (technicalAlert) operationMode.value = "live"
    if (!technicalAlert && !project.value) { project.value = projects[0]?.id ?? ""; refreshServices() }
  }
  purpose.addEventListener("change", syncPurpose)
  enabled.addEventListener("change", syncPurpose)
  triggerMode.disabled = true
  syncPurpose()
  const toggle = element("label", "toggle-row")
  toggle.append(enabled, element("span", "toggle-row__track"), element("span", "toggle-row__copy", "保存后立即启用监听"))
  const error = formError()
  form.append(
    group("form-section", element("h3", "form-section__title", "Telegram 群"), group("form-grid", formField("群名称", name), formField("群 ID", chatId), formField("唯一标识", key))),
    group("form-section", element("h3", "form-section__title", "接入与用途"), group("form-grid", formField("接入方式", accessMode), formField("客服账号", account), formField("触发方式", triggerMode), formField("群用途", purpose))),
    projectSection,
    modelSection,
    group("form-section", element("h3", "form-section__title", "回复方式"), group("form-grid",
      formField("回答风格", replyStyle, "AI 原始回复不会套用真人口吻、长度、标点或技术词限制；安全和只读边界始终保留。"),
      formField("运行模式", operationMode, "学习模式会完整生成并与可信真人回复对比，但不会向群或技术群发送客服消息。切回正式回复只影响之后的新问题。"),
    )),
    toggle,
    error,
  )
  const cancel = actionButton("取消")
  const save = actionButton(existing ? "保存修改" : "添加群", "primary")
  const modal = openDialog({ eyebrow: "群与账号", title: existing ? "编辑白名单群" : "添加白名单群", description: "只有这里启用的群会进入 AI 判断。", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    const technicalAlert = purpose.value === "technical_alert"
    const issue = validateGroupForm({
      key: key.value,
      name: name.value,
      telegramChatId: chatId.value,
      accountId: account.value,
      projectId: technicalAlert ? "" : project.value,
      serviceId: technicalAlert ? "" : service.value,
      enabled: enabled.checked,
      existing: Boolean(existing),
      purpose: purpose.value as TelegramGroup["purpose"],
    })
    ;[key, name, chatId, account, project, service].forEach((control) => control.removeAttribute("aria-invalid"))
    if (issue) {
      error.textContent = issue.message
      const control = { key, name, telegramChatId: chatId, accountId: account, projectId: project, serviceId: service }[issue.field]
      control?.setAttribute("aria-invalid", "true")
      control?.focus()
      return
    }
    const selectedProject = technicalAlert ? undefined : projects.find((item) => item.id === project.value)
    const selectedService = selectedProject?.services.find((item) => item.id === service.value)
    const repositories: Array<"java-project" | "sfzf-web"> = []
    const serverResource = selectedProject?.servers.find((item) => item.serviceId === selectedService?.id)
    const databaseResource = selectedProject?.databases.find((item) => item.serviceId === selectedService?.id)
    const payload = {
      key: key.value.trim(), name: name.value.trim(), telegramChatId: optionalTelegramChatId(chatId.value),
      accountId: account.value || null, enabled: enabled.checked, accessMode: accessMode.value,
      projectId: selectedProject?.id ?? null, serviceId: selectedService?.id ?? null,
      triggerMode: triggerMode.value, platform: selectedService?.key ?? "internal", repositories,
      branch: null,
      serverAlias: serverResource?.alias ?? null, databaseAlias: databaseResource?.alias ?? "none",
      knowledgeScope: selectedProject?.defaultKnowledgeScope ?? "technical-alert", purpose: purpose.value,
      aiModelInstanceId: technicalAlert ? aiModel.value || null : null,
      replyStyle: replyStyle.value,
      operationMode: operationMode.value,
    }
    setButtonBusy(save, true)
    void (existing ? api.updateGroup(existing.id, payload) : api.createGroup(payload)).then(async () => {
      notify(existing ? "群配置已更新" : "群已加入白名单")
      modal.close()
      await onSaved()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function roleForm(existing: TelegramRole | undefined, onSaved: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const userId = textInput("telegramUserId", "Telegram 数字用户 ID")
  userId.value = existing?.telegramUserId ?? ""; userId.required = true
  const username = textInput("username", "不带 @，可留空")
  username.value = existing?.username ?? ""
  const displayName = textInput("displayName", "后台显示名称")
  displayName.value = existing?.displayName ?? ""; displayName.required = true
  const role = selectInput("role", [
    { value: "operator", label: "运营" }, { value: "technical", label: "技术" },
    { value: "reviewer", label: "审核员" }, { value: "ignored", label: "忽略用户" },
  ])
  role.value = existing?.role ?? "operator"
  const canCorrect = element("input"); canCorrect.type = "checkbox"; canCorrect.checked = existing?.canCorrect ?? false
  const enabled = element("input"); enabled.type = "checkbox"; enabled.checked = existing?.enabled ?? true
  const learningSourceEnabled = element("input"); learningSourceEnabled.type = "checkbox"; learningSourceEnabled.checked = existing?.learningSourceEnabled ?? false
  const correctionToggle = element("label", "toggle-row"); correctionToggle.append(canCorrect, element("span", "toggle-row__track"), element("span", "toggle-row__copy", "允许通过 Telegram 快速纠正"))
  const enabledToggle = element("label", "toggle-row"); enabledToggle.append(enabled, element("span", "toggle-row__track"), element("span", "toggle-row__copy", "启用这个角色"))
  const learningToggle = element("label", "toggle-row"); learningToggle.append(learningSourceEnabled, element("span", "toggle-row__track"), element("span", "toggle-row__copy", "将这个数字 ID 作为学习来源"))
  const error = formError()
  form.append(group("form-grid", formField("用户 ID", userId), formField("用户名", username), formField("显示名称", displayName), formField("角色", role)), correctionToggle, enabledToggle, learningToggle, error)
  const cancel = actionButton("取消")
  const save = actionButton(existing ? "保存修改" : "添加角色", "primary")
  const modal = openDialog({ eyebrow: "用户与角色", title: existing ? "编辑角色" : "添加角色白名单", description: "群管理员身份只作为参考，实际权限以这里为准。", content: form, actions: [cancel, save] })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    const payload = { telegramUserId: userId.value.trim(), username: username.value.trim() || null, displayName: displayName.value.trim(), role: role.value as TelegramRole["role"], canCorrect: canCorrect.checked, enabled: enabled.checked, learningSourceEnabled: learningSourceEnabled.checked }
    setButtonBusy(save, true)
    void (existing ? api.updateRole(existing.id, payload) : api.createRole(payload)).then(async () => {
      notify(existing ? "角色已更新" : "角色已添加")
      modal.close()
      await onSaved()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function accountCard(account: TelegramAccount, refresh: () => Promise<void>, notify: Notify): HTMLElement {
  const card = element("article", "entity-card")
  const identity = element("div", "entity-card__identity")
  const avatar = element("span", "entity-avatar"); avatar.append(icon(account.type === "bot" ? "bot" : "user"))
  const copy = element("div"); copy.append(element("h3", "entity-card__title", account.name), element("p", "entity-card__subtitle", account.botUsername ? `@${account.botUsername}` : account.secretHint))
  identity.append(avatar, copy)
  const head = element("div", "entity-card__head"); head.append(identity, accountStatus(account))
  const meta = element("div", "entity-meta")
  meta.append(element("span", "", account.type === "bot" ? "Bot" : "个人账号"), element("span", "", account.enabled ? "已启用" : "未启用"), element("span", "", account.statusMessage))
  const actions = element("div", "entity-actions")
  const test = actionButton("检测连接")
  const edit = actionButton("编辑")
  const remove = actionButton("删除", "danger")
  test.addEventListener("click", () => { setButtonBusy(test, true); void api.testAccount(account.id).then(async () => { notify("连接检测完成"); await refresh() }).catch((error: unknown) => notify(errorText(error))).finally(() => setButtonBusy(test, false)) })
  edit.addEventListener("click", () => accountForm(account, refresh, notify))
  remove.addEventListener("click", () => confirmDelete(`删除 ${account.name}`, "已绑定白名单群的账号不能删除，请先修改群配置。", () => api.deleteAccount(account.id), refresh, notify))
  actions.append(test, edit, remove)
  if (account.type === "bot") {
    const commands = actionButton("同步中文命令")
    commands.addEventListener("click", () => { setButtonBusy(commands, true); void api.syncCommands(account.id).then(() => notify("中文命令说明已同步")).catch((error: unknown) => notify(errorText(error))).finally(() => setButtonBusy(commands, false)) })
    actions.prepend(commands)
  } else {
    const login = actionButton(account.status === "ready" ? "重新登录" : "登录 Telegram")
    login.addEventListener("click", () => userLoginDialog(account, refresh, notify))
    actions.prepend(login)
  }
  card.append(head, meta, actions)
  return card
}

type GroupRowActions = {
  selected: boolean
  busy: boolean
  onSelectionChanged: (checked: boolean) => void
  onQuickToggle: (enabled: boolean) => void
}

function groupRow(
  group: TelegramGroup,
  accounts: TelegramAccount[],
  projects: ProjectView[],
  models: ModelInstance[],
  refresh: () => Promise<void>,
  notify: Notify,
  rowActions: GroupRowActions,
): HTMLElement {
  const row = element("article", "list-row")
  const selection = element("label", "group-selection")
  const selectionInput = element("input", "group-selection__input")
  selectionInput.type = "checkbox"
  selectionInput.checked = rowActions.selected
  selectionInput.disabled = rowActions.busy
  selectionInput.setAttribute("aria-label", `选择 ${group.name}`)
  selectionInput.addEventListener("change", () => rowActions.onSelectionChanged(selectionInput.checked))
  selection.append(selectionInput)
  const main = element("div", "list-row__main")
  const title = element("div", "list-row__title-row")
  title.append(element("h3", "list-row__title", group.name), badge(group.enabled ? "已启用" : "未启用", group.enabled ? "success" : "neutral"), badge(group.purpose === "technical_alert" ? "技术告警" : "客服群", group.purpose === "technical_alert" ? "warning" : "accent"), group.purpose === "support" ? badge(group.operationMode === "learning" ? "学习模式" : "正式回复", group.operationMode === "learning" ? "warning" : "success") : document.createTextNode(""))
  const account = accounts.find((item) => item.id === group.accountId)
  const route = group.purpose === "technical_alert" ? "只接收运营原消息转发" : "运行配置回答模型"
  main.append(title, element("p", "list-row__description", `${group.platform} · ${group.telegramChatId ?? "未填写群 ID"} · ${account?.name ?? "未绑定账号"}`), element("p", "list-row__meta", `${group.branch ?? "无代码分支"} · ${group.purpose === "technical_alert" ? "不处理群消息" : "每条文字都判断"} · ${route} · ${replyStyleLabel(group.replyStyle)}`))
  const edit = actionButton("编辑")
  const remove = actionButton("删除", "danger")
  edit.disabled = remove.disabled = rowActions.busy
  edit.addEventListener("click", () => groupForm(group, accounts, projects, models, refresh, notify))
  remove.addEventListener("click", () => confirmDelete(`删除 ${group.name}`, "删除后该群将不再进入 AI 判断。", () => api.deleteGroup(group.id), refresh, notify))
  const actions = element("div", "entity-actions")
  if (group.purpose === "support") {
    const enableReady = partitionGroupsForEnable([group], accounts, models).eligible.length === 1
    const quickEnabled = element("input")
    quickEnabled.type = "checkbox"
    quickEnabled.checked = group.enabled
    quickEnabled.disabled = rowActions.busy || (!group.enabled && !enableReady)
    quickEnabled.setAttribute("aria-label", `启用客服群 ${group.name}`)
    quickEnabled.addEventListener("change", () => {
      quickEnabled.disabled = true
      rowActions.onQuickToggle(quickEnabled.checked)
    })
    const quickToggle = element("label", "toggle-row group-quick-toggle")
    if (!group.enabled && !enableReady) quickToggle.title = "先完成群 ID 项目服务和已启用客服账号配置"
    quickToggle.append(
      quickEnabled,
      element("span", "toggle-row__track"),
      element("span", "toggle-row__copy", !group.enabled && !enableReady ? "未满足启用条件" : "启用客服群"),
    )
    actions.append(quickToggle)
  }
  actions.append(edit, remove)
  row.append(selection, main, actions)
  return row
}

function batchGroupDialog(
  groups: TelegramGroup[],
  accounts: TelegramAccount[],
  onSaved: (groups: TelegramGroup[]) => Promise<void>,
  notify: Notify,
): void {
  const form = element("form", "dialog-form")
  const accessMode = selectInput("accessMode", [
    { value: "", label: "不修改接入方式" },
    { value: "bot", label: "Bot" },
    { value: "user", label: "个人账号" },
  ])
  const account = selectInput("accountId", [{ value: "", label: "不修改客服账号" }])
  const replyStyle = selectInput("replyStyle", [
    { value: "", label: "不修改回复方式" },
    { value: "human", label: "真人口吻" },
    { value: "unrestricted", label: "AI 原始回复" },
  ])
  const operationMode = selectInput("operationMode", [
    { value: "", label: "不修改运行模式" },
    { value: "live", label: "正式回复" },
    { value: "learning", label: "学习模式（只生成不发送）" },
  ])
  const commonAccessMode = sharedAccessMode(groups)
  const refreshAccounts = () => {
    const resolvedMode = accessMode.value === "bot" || accessMode.value === "user"
      ? accessMode.value
      : commonAccessMode
    const options = accountOptions(accounts, resolvedMode)
    account.replaceChildren()
    const placeholder = element("option", "", resolvedMode ? "不修改客服账号" : "先统一接入方式")
    placeholder.value = ""
    account.append(placeholder)
    options.forEach((item) => {
      const option = element("option", "", `${item.name}${item.enabled ? "" : " · 已停用"}`)
      option.value = item.id
      account.append(option)
    })
    account.disabled = !resolvedMode
  }
  accessMode.addEventListener("change", () => {
    refreshAccounts()
    account.value = ""
  })
  refreshAccounts()

  const triggerSummary = element("div", "batch-trigger-summary")
  triggerSummary.append(element("h3", "batch-trigger-summary__title", "触发方式按群用途固定"))
  if (groups.some((item) => item.purpose === "support")) {
    triggerSummary.append(element("p", "batch-trigger-summary__item", "客服群 · 每条文字都判断"))
  }
  if (groups.some((item) => item.purpose === "technical_alert")) {
    triggerSummary.append(element("p", "batch-trigger-summary__item", "技术告警群 · 只接收运营原消息转发"))
  }
  const error = formError()
  form.append(
    group("form-grid", formField("接入方式", accessMode), formField("客服账号", account), formField("回复方式", replyStyle),
      formField("运行模式", operationMode, "可批量开启学习模式；系统仍会拆分问题和完整排查，但不会向任何群发送客服输出。")),
    triggerSummary,
    error,
  )
  const cancel = actionButton("取消")
  const save = actionButton(`应用到 ${groups.length} 个群`, "primary")
  const modal = openDialog({
    eyebrow: "批量配置",
    title: "统一白名单群配置",
    description: "只修改选择的配置项，不会改变项目归属、群用途或技术群模型。",
    content: form,
    actions: [cancel, save],
    width: "wide",
  })
  cancel.addEventListener("click", modal.close)
  save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    error.textContent = ""
    const result = buildBatchGroupPatch({
      groups,
      accessMode: accessMode.value === "bot" || accessMode.value === "user" ? accessMode.value : "",
      accountId: account.value,
      replyStyle: replyStyle.value === "human" || replyStyle.value === "unrestricted" ? replyStyle.value : "",
      operationMode: operationMode.value === "live" || operationMode.value === "learning" ? operationMode.value : "",
    }, accounts)
    if (!result.ok) {
      error.textContent = result.error
      return
    }
    setButtonBusy(save, true)
    cancel.disabled = true
    void api.updateGroups({ ids: groups.map((item) => item.id), patch: result.patch }).then(async (response) => {
      notify(`已更新 ${response.groups.length} 个群`)
      modal.close()
      await onSaved(response.groups)
    }).catch((cause: unknown) => {
      error.textContent = errorText(cause)
    }).finally(() => {
      setButtonBusy(save, false)
      cancel.disabled = false
    })
  })
}

function roleRow(role: TelegramRole, refresh: () => Promise<void>, notify: Notify): HTMLElement {
  const row = element("article", "list-row")
  const main = element("div", "list-row__main")
  const title = element("div", "list-row__title-row")
  title.append(element("h3", "list-row__title", role.displayName), badge(role.enabled ? "已启用" : "已停用", role.enabled ? "success" : "neutral"), role.canCorrect ? badge("可纠正", "accent") : badge("只读", "neutral"), badge(role.learningSourceEnabled ? "学习来源" : "不学习", role.learningSourceEnabled ? "accent" : "neutral"))
  main.append(title, element("p", "list-row__description", `${roleLearningSourceLabel(role)} · ${role.username ? `@${role.username}` : "无用户名"}`), element("p", "list-row__meta", role.role))
  const edit = actionButton("编辑")
  const remove = actionButton("删除", "danger")
  edit.addEventListener("click", () => roleForm(role, refresh, notify))
  remove.addEventListener("click", () => confirmDelete(`删除 ${role.displayName}`, "删除后该用户不再拥有后台配置的 Telegram 角色。", () => api.deleteRole(role.id), refresh, notify))
  const actions = element("div", "entity-actions")
  actions.append(edit, remove)
  row.append(main, actions)
  return row
}

export function renderConnections(container: HTMLElement, notify: Notify, onChanged: () => void): void {
  let active: "accounts" | "groups" | "roles" = "accounts"
  let data: ConnectionsData = { accounts: [], groups: [], roles: [], projects: [], models: [] }
  const selectedGroupIds = new Set<string>()
  const busyGroupIds = new Set<string>()
  let groupActionBusy = false
  const content = element("section", "page-content connections-page")
  const header = element("div", "page-header-row")
  const add = actionButton("添加客服账号", "primary")
  header.append(pageHeader("Telegram", "群与账号", "更换客服号后，只需重新配置账号并导入 SQLite。"), add)
  const tabs = element("div", "segmented page-tabs")
  const body = element("div", "entity-list")
  content.append(header, tabs, body)
  replaceChildren(container, content)

  const mergeGroups = (groups: TelegramGroup[]) => {
    const updates = new Map(groups.map((item) => [item.id, item]))
    data.groups = data.groups.map((item) => updates.get(item.id) ?? item)
  }

  const runBatchEnabled = (enabled: boolean) => {
    if (groupBatchActionBlocked(groupActionBusy, busyGroupIds.size) || selectedGroupIds.size === 0) return
    const selected = data.groups.filter((item) => selectedGroupIds.has(item.id))
    const partition = enabled ? partitionGroupsForEnable(selected, data.accounts, data.models) : { eligible: selected, skipped: [] }
    if (partition.eligible.length === 0) {
      notify(`所选 ${partition.skipped.length} 个群未满足启用条件`)
      return
    }
    const ids = partition.eligible.map((item) => item.id)
    groupActionBusy = true
    render()
    void api.updateGroups({ ids, patch: { enabled } }).then((response) => {
      mergeGroups(response.groups)
      notify(enabled
        ? `已启用 ${response.groups.length} 个群${partition.skipped.length ? ` ${partition.skipped.length} 个未满足条件的群已跳过` : ""}`
        : `已停用 ${response.groups.length} 个群`)
      onChanged()
    }).catch((cause: unknown) => notify(errorText(cause))).finally(() => {
      groupActionBusy = false
      render()
    })
  }

  const runQuickToggle = (group: TelegramGroup, enabled: boolean) => {
    if (groupActionBusy || busyGroupIds.has(group.id)) return
    busyGroupIds.add(group.id)
    void performGroupQuickToggle({
      group,
      enabled,
      update: (input) => api.updateGroups(input),
      onSuccess: (groups) => {
        mergeGroups(groups)
        notify(enabled ? `${group.name} 已启用` : `${group.name} 已停用`)
        onChanged()
      },
      onFailure: (cause) => notify(errorText(cause)),
      onSettled: () => {
        busyGroupIds.delete(group.id)
        render()
      },
    })
  }

  const renderGroupList = () => {
    const groups = data.groups
    const chosen = selectedGroups(groups, selectedGroupIds)
    const batchActionBlocked = groupBatchActionBlocked(groupActionBusy, busyGroupIds.size)
    const toolbar = element("div", "group-batch-toolbar")
    const selectAllLabel = element("label", "group-batch-toolbar__select")
    const selectAll = element("input", "group-selection__input")
    selectAll.type = "checkbox"
    selectAll.checked = allGroupsSelected(groups, selectedGroupIds)
    selectAll.indeterminate = chosen.length > 0 && chosen.length < groups.length
    selectAll.disabled = batchActionBlocked
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) groups.forEach((item) => selectedGroupIds.add(item.id))
      else groups.forEach((item) => selectedGroupIds.delete(item.id))
      render()
    })
    selectAllLabel.append(selectAll, element("span", "", "全选当前群"))
    toolbar.append(selectAllLabel, element("span", "group-batch-toolbar__count", `已选 ${chosen.length} 个群`))
    if (chosen.length > 0) {
      const actions = element("div", "group-batch-toolbar__actions")
      const enable = actionButton("批量启用", "primary")
      const disable = actionButton("批量停用")
      const configure = actionButton("批量配置")
      const clear = actionButton("取消选择")
      enable.disabled = disable.disabled = configure.disabled = clear.disabled = batchActionBlocked
      enable.addEventListener("click", () => runBatchEnabled(true))
      disable.addEventListener("click", () => runBatchEnabled(false))
      configure.addEventListener("click", () => {
        if (groupBatchActionBlocked(groupActionBusy, busyGroupIds.size)) return
        batchGroupDialog(chosen, data.accounts, async (updated) => {
          mergeGroups(updated)
          onChanged()
          render()
        }, notify)
      })
      clear.addEventListener("click", () => {
        selectedGroupIds.clear()
        render()
      })
      actions.append(enable, disable, configure, clear)
      toolbar.append(actions)
    }
    const rows = groups.map((item) => groupRow(
      item,
      data.accounts,
      data.projects,
      data.models,
      refresh,
      notify,
      {
        selected: selectedGroupIds.has(item.id),
        busy: groupActionBusy || busyGroupIds.has(item.id),
        onSelectionChanged: (checked) => {
          if (checked) selectedGroupIds.add(item.id)
          else selectedGroupIds.delete(item.id)
          render()
        },
        onQuickToggle: (enabled) => runQuickToggle(item, enabled),
      },
    ))
    replaceChildren(body, toolbar, ...rows)
  }

  const render = () => {
    tabs.replaceChildren()
    ;([
      ["accounts", `客服账号 ${data.accounts.length}`],
      ["groups", `白名单群 ${data.groups.length}`],
      ["roles", `用户与角色 ${data.roles.length}`],
    ] as const).forEach(([value, label]) => {
      const button = element("button", `segmented__item${active === value ? " is-active" : ""}`, label)
      button.type = "button"; button.setAttribute("aria-pressed", String(active === value))
      button.addEventListener("click", () => { active = value; render() })
      tabs.append(button)
    })
    add.textContent = active === "accounts" ? "添加客服账号" : active === "groups" ? "添加白名单群" : "添加角色"
    if (active === "accounts") replaceChildren(body, ...(data.accounts.length ? data.accounts.map((item) => accountCard(item, refresh, notify)) : [emptyState("还没有客服账号", "先添加 Bot；特殊群再配置个人账号。", "bot")]))
    else if (active === "groups") {
      if (data.groups.length) renderGroupList()
      else replaceChildren(body, emptyState("还没有白名单群", "添加测试群后才能开始监听。", "groups"))
    }
    else replaceChildren(body, ...(data.roles.length ? data.roles.map((item) => roleRow(item, refresh, notify)) : [emptyState("还没有角色白名单", "添加运营、技术或审核员。", "user")]))
  }

  const refresh = async () => {
    replaceChildren(body, loadingState(3))
    const [accounts, groups, roles, projects, models] = await Promise.all([api.getAccounts(), api.getGroups(), api.getRoles(), api.getProjects(), api.getModels()])
    data = { accounts: accounts.accounts, groups: groups.groups, roles: roles.roles, projects: projects.projects, models: models.models }
    const availableGroupIds = new Set(data.groups.map((item) => item.id))
    selectedGroupIds.forEach((id) => { if (!availableGroupIds.has(id)) selectedGroupIds.delete(id) })
    onChanged()
    render()
  }
  add.addEventListener("click", () => {
    if (active === "accounts") accountForm(undefined, refresh, notify)
    else if (active === "groups") groupForm(undefined, data.accounts, data.projects, data.models, refresh, notify)
    else roleForm(undefined, refresh, notify)
  })
  void refresh().catch((error: unknown) => replaceChildren(body, emptyState("加载失败", errorText(error), "refresh")))
}
