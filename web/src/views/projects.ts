import { api } from "../api.js"
import { actionButton, badge, emptyState, formField, loadingState, openDialog, pageHeader, selectInput, setButtonBusy, textInput } from "../components.js"
import { element, replaceChildren } from "../dom.js"
import { formatDateTime, shortHash } from "../format.js"
import { icon } from "../icons.js"
import type { ProjectDatabase, ProjectRepository, ProjectServer, ProjectService, ProjectView } from "../types.js"

type Notify = (message: string) => void
type ResourceTab = "code" | "servers" | "databases"

function group(className: string, ...children: Node[]): HTMLElement {
  const node = element("div", className)
  node.append(...children)
  return node
}

function formError(): HTMLParagraphElement {
  return element("p", "form-error")
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "保存失败，请重试"
}

function toggle(label: string, checked: boolean): { row: HTMLLabelElement; input: HTMLInputElement } {
  const input = element("input"); input.type = "checkbox"; input.checked = checked
  const row = element("label", "toggle-row")
  row.append(input, element("span", "toggle-row__track"), element("span", "toggle-row__copy", label))
  return { row, input }
}

function confirmAction(title: string, description: string, action: () => Promise<void>, refresh: () => Promise<void>, notify: Notify): void {
  const body = element("p", "dialog-message", description)
  const cancel = actionButton("取消")
  const confirm = actionButton("确认删除", "danger")
  const modal = openDialog({ eyebrow: "项目管理", title, content: body, actions: [cancel, confirm] })
  cancel.addEventListener("click", modal.close)
  confirm.addEventListener("click", () => {
    setButtonBusy(confirm, true)
    void action().then(async () => { modal.close(); notify("已删除"); await refresh() })
      .catch((error: unknown) => notify(errorText(error))).finally(() => setButtonBusy(confirm, false))
  })
}

function projectForm(existing: ProjectView | undefined, refresh: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const key = textInput("key", "例如 sfzf"); key.required = true; key.value = existing?.key ?? ""
  const name = textInput("name", "项目显示名称"); name.required = true; name.value = existing?.name ?? ""
  const description = element("textarea", "input-control textarea-control"); description.rows = 3; description.value = existing?.description ?? ""
  const scope = textInput("defaultKnowledgeScope", "例如 global"); scope.required = true; scope.value = existing?.defaultKnowledgeScope ?? "global"
  const enabled = toggle("启用这个项目", existing?.enabled ?? true)
  const error = formError()
  form.append(group("form-grid", formField("项目标识", key), formField("项目名称", name), formField("默认知识范围", scope)), formField("项目说明", description), enabled.row, error)
  const cancel = actionButton("取消")
  const save = actionButton(existing ? "保存修改" : "创建项目", "primary")
  const modal = openDialog({ eyebrow: "项目管理", title: existing ? "编辑项目" : "新增项目", description: "项目统一管理代码、服务、服务器和数据库。", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close); save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    const payload = { key: key.value.trim(), name: name.value.trim(), description: description.value.trim(), defaultKnowledgeScope: scope.value.trim(), enabled: enabled.input.checked }
    void (existing ? api.updateProject(existing.id, payload) : api.createProject(payload)).then(async () => {
      modal.close(); notify(existing ? "项目已更新" : "项目已创建"); await refresh()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function repositoryForm(project: ProjectView, existing: ProjectRepository | undefined, refresh: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const name = textInput("name", "例如 java-project"); name.required = true; name.value = existing?.name ?? ""
  const remoteUrl = textInput("remoteUrl", "Git 远程地址"); remoteUrl.value = existing?.remoteUrl ?? ""
  const enabled = toggle("启用这个代码仓库", existing?.enabled ?? true)
  const clearCredentials = toggle("清除远程地址中已保存的凭据", false)
  const error = formError()
  form.append(
    group("form-grid", formField("仓库名称", name, "后端固定 java-project，前端固定 sfzf-web")),
    formField("远程地址", remoteUrl, existing ? "页面不会显示已保存的远程凭据；不改地址则保持原值。" : "服务分支会统一应用到前后端仓库。"),
    enabled.row,
  )
  if (existing) form.append(clearCredentials.row)
  form.append(error)
  const cancel = actionButton("取消"); const save = actionButton(existing ? "保存修改" : "添加仓库", "primary")
  const modal = openDialog({ eyebrow: project.name, title: existing ? "编辑代码仓库" : "添加代码仓库", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close); save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    const payload: Record<string, unknown> = { name: name.value.trim(), enabled: enabled.input.checked }
    if (!existing || remoteUrl.value.trim() !== existing.remoteUrl) payload.remoteUrl = remoteUrl.value.trim()
    if (existing && clearCredentials.input.checked) payload.clearRemoteCredentials = true
    void (existing ? api.updateProjectRepository(existing.id, payload) : api.createProjectRepository(project.id, payload)).then(async () => {
      modal.close(); notify(existing ? "仓库已更新" : "仓库已添加"); await refresh()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function serviceForm(project: ProjectView, existing: ProjectService | undefined, refresh: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const key = textInput("key", "例如 nine"); key.required = true; key.value = existing?.key ?? ""
  const name = textInput("name", "服务显示名称"); name.required = true; name.value = existing?.name ?? ""
  const region = textInput("region", "例如 印度"); region.value = existing?.region ?? ""
  const timezone = textInput("timezone", "例如 Asia/Kolkata"); timezone.value = existing?.timezone ?? ""
  const branch = textInput("branch", "例如 pord-pkr"); branch.required = true; branch.value = existing?.branch ?? ""
  const backendRepository = selectInput("backendRepositoryId", [
    { value: "", label: "选择 java-project" },
    ...project.repositories.filter((item) => item.name === "java-project" && item.enabled).map((item) => ({ value: item.id, label: item.name })),
  ])
  backendRepository.required = true
  backendRepository.value = existing?.repositories.backend?.repositoryId ?? ""
  const frontendRepository = selectInput("frontendRepositoryId", [
    { value: "", label: "选择 sfzf-web" },
    ...project.repositories.filter((item) => item.name === "sfzf-web" && item.enabled).map((item) => ({ value: item.id, label: item.name })),
  ])
  frontendRepository.required = true
  frontendRepository.value = existing?.repositories.frontend?.repositoryId ?? ""
  const enabled = toggle("启用这个服务", existing?.enabled ?? true)
  const error = formError()
  form.append(group(
    "form-grid",
    formField("服务标识", key),
    formField("服务名称", name),
    formField("地区", region),
    formField("时区", timezone),
    formField("后端仓库", backendRepository),
    formField("前端仓库", frontendRepository),
    formField("共同分支", branch, "java-project 与 sfzf-web 使用同一个服务分支"),
  ), enabled.row, error)
  const cancel = actionButton("取消"); const save = actionButton(existing ? "保存修改" : "添加服务", "primary")
  const modal = openDialog({ eyebrow: project.name, title: existing ? "编辑服务" : "添加服务", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close); save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    const payload = {
      key: key.value.trim(),
      name: name.value.trim(),
      region: region.value.trim(),
      timezone: timezone.value.trim(),
      backendRepositoryId: backendRepository.value,
      frontendRepositoryId: frontendRepository.value,
      branch: branch.value.trim(),
      enabled: enabled.input.checked,
    }
    void (existing ? api.updateProjectService(existing.id, payload) : api.createProjectService(project.id, payload)).then(async () => {
      modal.close(); notify(existing ? "服务已更新" : "服务已添加"); await refresh()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function serviceSelect(project: ProjectView, selected: string | undefined): HTMLSelectElement {
  const input = selectInput("serviceId", project.services.map((service) => ({ value: service.id, label: `${service.name} · ${service.region || "未配置地区"}` })))
  input.value = selected ?? project.services[0]?.id ?? ""
  input.required = true
  return input
}

function serverForm(project: ProjectView, existing: ProjectServer | undefined, refresh: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const serviceId = serviceSelect(project, existing?.serviceId)
  const alias = textInput("alias", "例如 nine"); alias.required = true; alias.value = existing?.alias ?? ""
  const host = textInput("host", "服务器 IP"); host.required = true; host.value = existing?.host ?? ""
  const port = textInput("port", "22"); port.type = "number"; port.required = true; port.value = String(existing?.port ?? 22)
  const username = textInput("username", "SSH 用户"); username.required = true; username.value = existing?.username ?? "root"
  const workdir = textInput("workdir", "/opt/sfzf-service"); workdir.required = true; workdir.value = existing?.workdir ?? "/opt/sfzf-service"
  const privateKey = element("textarea", "input-control textarea-control secret-editor"); privateKey.rows = 7; privateKey.placeholder = existing ? "留空保持当前私钥不变" : "粘贴完整私钥"; privateKey.required = !existing
  const enabled = toggle("启用这台服务器", existing?.enabled ?? true)
  const error = formError()
  form.append(group("form-grid", formField("所属服务", serviceId), formField("资源别名", alias), formField("服务器 IP", host), formField("SSH 端口", port), formField("SSH 用户", username), formField("工作目录", workdir)), formField("完整私钥", privateKey, existing ? "已配置私钥；留空不会覆盖。" : "私钥只写入本机 SQLite，不会返回到页面。"), enabled.row, error)
  const cancel = actionButton("取消"); const save = actionButton(existing ? "保存修改" : "添加服务器", "primary")
  const modal = openDialog({ eyebrow: project.name, title: existing ? "编辑服务器" : "添加服务器", description: "连接只用于受控只读排错。", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close); save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    const payload: Record<string, unknown> = { serviceId: serviceId.value, alias: alias.value.trim(), host: host.value.trim(), port: Number(port.value), username: username.value.trim(), workdir: workdir.value.trim(), enabled: enabled.input.checked }
    if (privateKey.value.trim()) payload.privateKey = privateKey.value
    void (existing ? api.updateProjectServer(existing.id, payload) : api.createProjectServer(project.id, payload)).then(async () => {
      privateKey.value = ""; modal.close(); notify(existing ? "服务器已更新" : "服务器已添加"); await refresh()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function databaseForm(project: ProjectView, existing: ProjectDatabase | undefined, refresh: () => Promise<void>, notify: Notify): void {
  const form = element("form", "dialog-form")
  const serviceId = serviceSelect(project, existing?.serviceId)
  const alias = textInput("alias", "例如 db-nine"); alias.required = true; alias.value = existing?.alias ?? ""
  const host = textInput("host", "数据库地址"); host.required = true; host.value = existing?.host ?? ""
  const port = textInput("port", "3306"); port.type = "number"; port.required = true; port.value = String(existing?.port ?? 3306)
  const database = textInput("database", "数据库名"); database.required = true; database.value = existing?.database ?? ""
  const username = textInput("username", "数据库用户"); username.required = true; username.value = existing?.username ?? ""
  const password = textInput("password", existing ? "留空保持当前密码不变" : "数据库密码"); password.type = "password"; password.required = !existing; password.autocomplete = "new-password"
  const timezone = textInput("timezone", "例如 Asia/Kolkata"); timezone.value = existing?.timezone ?? ""
  const enabled = toggle("启用这个数据库", existing?.enabled ?? true)
  const error = formError()
  form.append(group("form-grid", formField("所属服务", serviceId), formField("资源别名", alias), formField("数据库地址", host), formField("端口", port), formField("数据库名", database), formField("数据库用户", username), formField("时区", timezone)), formField("数据库密码", password, existing ? "已配置密码；留空不会覆盖。" : "密码只写入本机 SQLite，不会返回到页面。"), enabled.row, error)
  const cancel = actionButton("取消"); const save = actionButton(existing ? "保存修改" : "添加数据库", "primary")
  const modal = openDialog({ eyebrow: project.name, title: existing ? "编辑数据库" : "添加数据库", description: "AI 只允许执行 SELECT、SHOW 和 EXPLAIN。", content: form, actions: [cancel, save], width: "wide" })
  cancel.addEventListener("click", modal.close); save.addEventListener("click", () => form.requestSubmit())
  form.addEventListener("submit", (event) => {
    event.preventDefault(); error.textContent = ""; setButtonBusy(save, true)
    const payload: Record<string, unknown> = { serviceId: serviceId.value, alias: alias.value.trim(), engine: "mysql", host: host.value.trim(), port: Number(port.value), database: database.value.trim(), username: username.value.trim(), timezone: timezone.value.trim(), enabled: enabled.input.checked }
    if (password.value) payload.password = password.value
    void (existing ? api.updateProjectDatabase(existing.id, payload) : api.createProjectDatabase(project.id, payload)).then(async () => {
      password.value = ""; modal.close(); notify(existing ? "数据库已更新" : "数据库已添加"); await refresh()
    }).catch((cause: unknown) => { error.textContent = errorText(cause) }).finally(() => setButtonBusy(save, false))
  })
}

function resourceRow(iconName: "branch" | "server" | "database", title: string, description: string, meta: string, edit: () => void, remove: () => void): HTMLElement {
  const row = element("article", "project-resource-row")
  const resourceIcon = element("span", "project-resource-row__icon"); resourceIcon.append(icon(iconName))
  const copy = element("div", "project-resource-row__copy")
  copy.append(element("h3", "project-resource-row__title", title), element("p", "project-resource-row__description", description), element("p", "project-resource-row__meta", meta))
  const actions = element("div", "entity-actions")
  const editButton = actionButton("编辑"); editButton.addEventListener("click", edit)
  const deleteButton = actionButton("删除", "danger"); deleteButton.addEventListener("click", remove)
  actions.append(editButton, deleteButton); row.append(resourceIcon, copy, actions)
  return row
}

function serviceCodeRow(service: ProjectService, edit: () => void, remove: () => void): HTMLElement {
  const row = element("article", "project-resource-row project-service-code-row")
  const resourceIcon = element("span", "project-resource-row__icon"); resourceIcon.append(icon("server"))
  const copy = element("div", "project-resource-row__copy")
  const heading = element("div", "project-service-code-row__heading")
  const state = service.codeSync.status === "healthy" ? "同步正常" : service.codeSync.status === "failed" ? "同步失败" : "尚未同步"
  const tone = service.codeSync.status === "healthy" ? "success" : service.codeSync.status === "failed" ? "warning" : "neutral"
  heading.append(element("h3", "project-resource-row__title", service.name), badge(state, tone))
  const description = element("p", "project-resource-row__description", `${service.region || "未配置地区"} · ${service.timezone || "未配置时区"} · 分支 ${service.branch}`)
  const repositories = element("div", "service-code-grid")
  const repository = (label: string, name: string | undefined, commit: string | null) => {
    const item = element("div", "service-code-repository")
    item.append(element("span", "service-code-repository__label", label), element("strong", "", name ?? "未绑定"), element("code", "", commit ? shortHash(commit) : "尚无提交"))
    return item
  }
  repositories.append(
    repository("后端", service.repositories.backend?.name, service.codeSync.backendCommit),
    repository("前端", service.repositories.frontend?.name, service.codeSync.frontendCommit),
  )
  const snapshot = service.codeSync.snapshotPublishedAt
    ? `完整快照 ${formatDateTime(service.codeSync.snapshotPublishedAt)}`
    : "还没有完整双仓快照"
  const summary = element("p", `project-resource-row__meta${service.codeSync.safeSummary ? " is-warning" : ""}`,
    service.codeSync.safeSummary ? `${snapshot} · ${service.codeSync.safeSummary}` : snapshot)
  copy.append(heading, description, repositories, summary)
  const actions = element("div", "entity-actions")
  const editButton = actionButton("编辑"); editButton.addEventListener("click", edit)
  const deleteButton = actionButton("删除", "danger"); deleteButton.addEventListener("click", remove)
  actions.append(editButton, deleteButton)
  row.append(resourceIcon, copy, actions)
  return row
}

export function renderProjects(container: HTMLElement, notify: Notify, onChanged: () => void): void {
  let projects: ProjectView[] = []
  let selectedId: string | null = null
  let activeTab: ResourceTab = "code"
  const content = element("section", "page-content projects-page")
  const headerRow = element("div", "page-header-row")
  const addProject = actionButton("新增项目", "primary")
  headerRow.append(pageHeader("AI 客服", "项目管理", "一个服务名即可定位对应代码、服务器和数据库。"), addProject)
  const workspace = element("div", "projects-workspace")
  const sidebar = element("aside", "project-picker")
  const detail = element("section", "project-detail-panel")
  workspace.append(sidebar, detail); content.append(headerRow, workspace); replaceChildren(container, content)

  const refresh = async () => {
    replaceChildren(sidebar, loadingState(2)); replaceChildren(detail, loadingState(3))
    projects = (await api.getProjects()).projects
    if (!projects.some((project) => project.id === selectedId)) selectedId = projects[0]?.id ?? null
    onChanged(); render()
  }

  const render = () => {
    sidebar.replaceChildren()
    sidebar.append(element("p", "project-picker__label", `项目 ${projects.length}`))
    projects.forEach((project) => {
      const button = element("button", `project-picker__item${project.id === selectedId ? " is-active" : ""}`)
      button.type = "button"
      const mark = element("span", "project-picker__mark", project.name.slice(0, 1).toUpperCase())
      const copy = element("span", "project-picker__copy")
      copy.append(element("strong", "", project.name), element("small", "", `${project.services.length} 服务 · ${project.servers.length} 服务器`))
      button.append(mark, copy, badge(project.enabled ? "启用" : "停用", project.enabled ? "success" : "neutral"))
      button.addEventListener("click", () => { selectedId = project.id; render() })
      sidebar.append(button)
    })
    const project = projects.find((item) => item.id === selectedId)
    if (!project) {
      replaceChildren(detail, emptyState("还没有项目", "先创建项目，再添加代码仓库、服务、服务器和数据库。", "server"))
      return
    }
    detail.replaceChildren()
    const top = element("div", "project-detail__top")
    const title = element("div")
    const titleRow = element("div", "project-detail__title-row")
    titleRow.append(element("h2", "project-detail__title", project.name), badge(project.enabled ? "运行中" : "已停用", project.enabled ? "success" : "neutral"))
    title.append(titleRow, element("p", "project-detail__description", project.description || `${project.key} · ${project.defaultKnowledgeScope}`))
    const topActions = element("div", "entity-actions")
    const editProject = actionButton("编辑项目"); editProject.addEventListener("click", () => projectForm(project, refresh, notify))
    const deleteProject = actionButton("删除", "danger"); deleteProject.addEventListener("click", () => confirmAction(`删除 ${project.name}`, "需要先删除项目内的服务和连接资源。", () => api.deleteProject(project.id), refresh, notify))
    topActions.append(editProject, deleteProject); top.append(title, topActions)
    const metrics = element("div", "project-mini-metrics")
    ;[["服务", project.services.length], ["代码仓库", project.repositories.length], ["服务器", project.servers.length], ["数据库", project.databases.length]].forEach(([label, value]) => {
      const item = element("div", "project-mini-metric"); item.append(element("strong", "", String(value)), element("span", "", String(label))); metrics.append(item)
    })
    const tabs = element("div", "segmented project-tabs")
    ;([["code", "代码与服务"], ["servers", "服务器"], ["databases", "数据库"]] as const).forEach(([value, label]) => {
      const button = element("button", `segmented__item${activeTab === value ? " is-active" : ""}`, label); button.type = "button"
      button.addEventListener("click", () => { activeTab = value; render() }); tabs.append(button)
    })
    const sectionHeader = element("div", "project-resource-header")
    const resourceList = element("div", "project-resource-list")
    if (activeTab === "code") {
      sectionHeader.append(element("div", "", "代码仓库与服务"))
      const addRepository = actionButton("添加仓库"); addRepository.addEventListener("click", () => repositoryForm(project, undefined, refresh, notify))
      const addService = actionButton("添加服务", "primary"); addService.addEventListener("click", () => serviceForm(project, undefined, refresh, notify))
      sectionHeader.append(group("entity-actions", addRepository, addService))
      project.repositories.forEach((repository) => resourceList.append(resourceRow(
        "branch",
        repository.name,
        repository.enabled ? "已启用" : "已停用",
        repository.remoteUrl || "未配置远程地址",
        () => repositoryForm(project, repository, refresh, notify),
        () => confirmAction(`删除 ${repository.name}`, "仍被服务使用的仓库不能删除。", () => api.deleteProjectRepository(repository.id), refresh, notify),
      )))
      project.services.forEach((service) => {
        resourceList.append(serviceCodeRow(
          service,
          () => serviceForm(project, service, refresh, notify),
          () => confirmAction(`删除 ${service.name}`, "仍有关联服务器、数据库或群的服务不能删除。", () => api.deleteProjectService(service.id), refresh, notify),
        ))
      })
    } else if (activeTab === "servers") {
      sectionHeader.append(element("div", "", "服务器连接"))
      const add = actionButton("添加服务器", "primary"); add.disabled = project.services.length === 0; add.addEventListener("click", () => serverForm(project, undefined, refresh, notify)); sectionHeader.append(add)
      project.servers.forEach((server) => {
        const service = project.services.find((item) => item.id === server.serviceId)
        resourceList.append(resourceRow("server", server.alias, `${server.host}:${server.port} · ${server.username}`, `${service?.name ?? "未知服务"} · 私钥已配置 · ${server.workdir}`, () => serverForm(project, server, refresh, notify), () => confirmAction(`删除 ${server.alias}`, "删除后 AI 无法通过该服务器排错。", () => api.deleteProjectServer(server.id), refresh, notify)))
      })
    } else {
      sectionHeader.append(element("div", "", "数据库连接"))
      const add = actionButton("添加数据库", "primary"); add.disabled = project.services.length === 0; add.addEventListener("click", () => databaseForm(project, undefined, refresh, notify)); sectionHeader.append(add)
      project.databases.forEach((database) => {
        const service = project.services.find((item) => item.id === database.serviceId)
        resourceList.append(resourceRow("database", database.alias, `${database.host}:${database.port}/${database.database}`, `${service?.name ?? "未知服务"} · ${database.username} · 密码已配置`, () => databaseForm(project, database, refresh, notify), () => confirmAction(`删除 ${database.alias}`, "删除后 AI 无法通过该数据库排错。", () => api.deleteProjectDatabase(database.id), refresh, notify)))
      })
    }
    if (resourceList.childElementCount === 0) resourceList.append(emptyState("这里还是空的", "使用右上角按钮添加资源。", activeTab === "databases" ? "database" : activeTab === "servers" ? "server" : "branch"))
    detail.append(top, metrics, tabs, sectionHeader, resourceList)
  }

  addProject.addEventListener("click", () => projectForm(undefined, refresh, notify))
  void refresh().catch((error: unknown) => replaceChildren(detail, emptyState("加载失败", errorText(error), "refresh")))
}
