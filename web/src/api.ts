import type {
  AccessControlState,
  AccessRole,
  AccessUser,
  AdminChatSession,
  AdminChatSessionDetail,
  AdminChatTurn,
  AuthContext,
  Directive,
  HealthStatus,
  InterfaceDocumentSearch,
  InterfaceDocumentSummary,
  MagicBookStatus,
  MenuKey,
  ModelCatalogResult,
  ModelInstance,
  ModelProfile,
  ModelPurpose,
  MemoryEvent,
  MemoryEvidenceSummary,
  MemoryStatus,
  MemoryView,
  LearningObservation,
  OperatorStyleVersion,
  ProjectDatabase,
  ProjectRepository,
  ProjectServer,
  ProjectService,
  ProjectView,
  ReplyListItem,
  ReplyRecord,
  SupportThreadDetail,
  SupportThreadListItem,
  SupportThreadStatus,
  TelegramAccount,
  TelegramAccountsResponse,
  BatchGroupUpdateInput,
  TelegramGroup,
  TelegramGroupsResponse,
  TelegramLoginState,
  TelegramRole,
  TelegramRoleInput,
  RuntimeSettings,
  RuntimeModelBinding,
  RuntimeStatus,
  ShadowLearningReport,
} from "./types.js"

type Fetcher = typeof fetch
let csrfToken = ""
let unauthorizedHandler: (() => void) | null = null

function secured(init?: RequestInit): RequestInit | undefined {
  if (!init || !init.method || ["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase()) || !csrfToken) return init
  const headers = new Headers(init.headers)
  headers.set("X-CSRF-Token", csrfToken)
  return { ...init, headers }
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: string }
    if (body.error) return new Error(body.error)
  } catch {
    // 非 JSON 错误使用统一中文提示。
  }
  if (response.status === 404) return new Error("没有找到相关数据")
  if (response.status === 400) return new Error("请检查输入内容")
  return new Error("加载失败，请重试")
}

async function requestJson<T>(fetcher: Fetcher, url: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(url, secured(init))
  if (response.status === 401 && url !== "/api/auth/login") unauthorizedHandler?.()
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}

async function requestVoid(fetcher: Fetcher, url: string, init?: RequestInit): Promise<void> {
  const response = await fetcher(url, secured(init))
  if (response.status === 401 && url !== "/api/auth/login") unauthorizedHandler?.()
  if (!response.ok) throw await responseError(response)
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) }
}

function adminChatMessage(fields: Record<string, string>, files: File[]): RequestInit {
  if (!files.length) return json("POST", fields)
  const body = new FormData()
  Object.entries(fields).forEach(([key, value]) => body.append(key, value))
  files.forEach((file) => body.append("files", file, file.name))
  return { method: "POST", body }
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value))
  })
  const result = query.toString()
  return result ? `?${result}` : ""
}

export function createApiClient(fetcher: Fetcher = globalThis.fetch.bind(globalThis)) {
  return {
    onUnauthorized: (handler: () => void) => { unauthorizedHandler = handler },
    getAuthContext: async () => {
      const context = await requestJson<AuthContext>(fetcher, "/api/auth/me")
      csrfToken = context.csrfToken
      return context
    },
    login: async (username: string, password: string) => {
      const context = await requestJson<AuthContext>(fetcher, "/api/auth/login", json("POST", { username, password }))
      csrfToken = context.csrfToken
      return context
    },
    logout: async () => {
      await requestVoid(fetcher, "/api/auth/logout", { method: "POST" })
      csrfToken = ""
    },
    getAccessControl: () => requestJson<AccessControlState>(fetcher, "/api/access-control"),
    createAccessUser: (input: { username: string; password: string; roleId: string; enabled: boolean }) =>
      requestJson<AccessUser>(fetcher, "/api/access-control/users", json("POST", input)),
    updateAccessUser: (id: string, input: { username?: string; password?: string; roleId?: string; enabled?: boolean }) =>
      requestJson<AccessUser>(fetcher, `/api/access-control/users/${encodeURIComponent(id)}`, json("PATCH", input)),
    updateAccessRole: (id: string, input: { name: string; menus: MenuKey[] }) =>
      requestJson<AccessRole>(fetcher, `/api/access-control/roles/${encodeURIComponent(id)}`, json("PATCH", input)),
    getHealth: () => requestJson<HealthStatus>(fetcher, "/health"),
    getAccounts: () => requestJson<TelegramAccountsResponse>(fetcher, "/api/telegram/accounts"),
    createAccount: (input: Record<string, unknown>) => requestJson<TelegramAccount>(fetcher, "/api/telegram/accounts", json("POST", input)),
    updateAccount: (id: string, input: Record<string, unknown>) => requestJson<TelegramAccount>(fetcher, `/api/telegram/accounts/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteAccount: (id: string) => requestVoid(fetcher, `/api/telegram/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    testAccount: (id: string) => requestJson<TelegramAccount>(fetcher, `/api/telegram/accounts/${encodeURIComponent(id)}/test`, { method: "POST" }),
    syncCommands: (id: string) => requestJson<{ synced: true }>(fetcher, `/api/telegram/accounts/${encodeURIComponent(id)}/commands`, { method: "POST" }),
    startUserLogin: (id: string) => requestJson<TelegramLoginState>(fetcher, `/api/telegram/accounts/${encodeURIComponent(id)}/login/start`, { method: "POST" }),
    continueUserLogin: (id: string, input: { code?: string; password?: string }) => requestJson<TelegramLoginState>(
      fetcher,
      `/api/telegram/accounts/${encodeURIComponent(id)}/login/continue`,
      json("POST", input),
    ),
    cancelUserLogin: (id: string) => requestVoid(fetcher, `/api/telegram/accounts/${encodeURIComponent(id)}/login/cancel`, { method: "POST" }),

    getGroups: () => requestJson<TelegramGroupsResponse>(fetcher, "/api/telegram/groups"),
    createGroup: (input: Record<string, unknown>) => requestJson<TelegramGroup>(fetcher, "/api/telegram/groups", json("POST", input)),
    updateGroups: (input: BatchGroupUpdateInput) => requestJson<{ groups: TelegramGroup[] }>(fetcher, "/api/telegram/groups", json("PATCH", input)),
    updateGroup: (id: string, input: Record<string, unknown>) => requestJson<TelegramGroup>(fetcher, `/api/telegram/groups/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteGroup: (id: string) => requestVoid(fetcher, `/api/telegram/groups/${encodeURIComponent(id)}`, { method: "DELETE" }),

    getLearningReports: () => requestJson<{ items: ShadowLearningReport[] }>(fetcher, "/api/learning-reports"),
    getLearningReport: (id: string) => requestJson<{ report: ShadowLearningReport; comparisons: Array<Record<string, unknown>> }>(fetcher, `/api/learning-reports/${encodeURIComponent(id)}`),
    createLearningReport: () => requestJson<ShadowLearningReport>(fetcher, "/api/learning-reports", { method: "POST" }),
    retryLearningReport: (id: string) => requestJson<ShadowLearningReport>(
      fetcher,
      `/api/learning-reports/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    ),

    getRoles: () => requestJson<{ roles: TelegramRole[] }>(fetcher, "/api/telegram/roles"),
    createRole: (input: TelegramRoleInput) => requestJson<TelegramRole>(fetcher, "/api/telegram/roles", json("POST", input)),
    updateRole: (id: string, input: Partial<TelegramRoleInput>) => requestJson<TelegramRole>(fetcher, `/api/telegram/roles/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteRole: (id: string) => requestVoid(fetcher, `/api/telegram/roles/${encodeURIComponent(id)}`, { method: "DELETE" }),

    getProjects: () => requestJson<{ projects: ProjectView[] }>(fetcher, "/api/projects"),
    getAdminChatServices: () => requestJson<{ projects: ProjectView[] }>(fetcher, "/api/admin-chat/services"),

    getAdminChatSessions: (serviceId?: string) => requestJson<{ sessions: AdminChatSession[] }>(
      fetcher,
      `/api/admin-chat/sessions${queryString({ serviceId })}`,
    ),
    createAdminChatSession: (serviceId: string) => requestJson<AdminChatSession>(
      fetcher,
      "/api/admin-chat/sessions",
      json("POST", { serviceId }),
    ),
    createAdminChatConversation: (serviceId: string, question: string, files: File[] = []) => requestJson<{
      session: AdminChatSession
      turn: AdminChatTurn
    }>(fetcher, "/api/admin-chat/turns", adminChatMessage({ serviceId, question }, files)),
    getAdminChatSession: (id: string) => requestJson<AdminChatSessionDetail>(
      fetcher,
      `/api/admin-chat/sessions/${encodeURIComponent(id)}`,
    ),
    createAdminChatTurn: (sessionId: string, question: string, files: File[] = []) => requestJson<AdminChatTurn>(
      fetcher,
      `/api/admin-chat/sessions/${encodeURIComponent(sessionId)}/turns`,
      adminChatMessage({ question }, files),
    ),
    retryAdminChatTurn: (turnId: string) => requestJson<AdminChatTurn>(
      fetcher,
      `/api/admin-chat/turns/${encodeURIComponent(turnId)}/retry`,
      { method: "POST" },
    ),
    cancelAdminChatTurn: (turnId: string) => requestJson<AdminChatTurn>(
      fetcher,
      `/api/admin-chat/turns/${encodeURIComponent(turnId)}/cancel`,
      { method: "POST" },
    ),
    correctAdminChatTurn: (turnId: string, input: { correctedAnswer: string; reason: string }) => requestJson<AdminChatTurn>(
      fetcher,
      `/api/admin-chat/turns/${encodeURIComponent(turnId)}/corrections`,
      json("POST", { ...input, correctedBy: "后台管理员" }),
    ),

    getModelConfig: () => requestJson<{ profiles: ModelProfile[] }>(fetcher, "/api/model-config"),
    updateModelProfile: (purpose: ModelPurpose, input: Partial<ModelProfile>) => requestJson<ModelProfile>(
      fetcher,
      `/api/model-config/${encodeURIComponent(purpose)}`,
      json("PATCH", input),
    ),
    getModels: () => requestJson<{ models: ModelInstance[] }>(fetcher, "/api/models"),
    createModel: (input: Record<string, unknown>) => requestJson<ModelInstance>(fetcher, "/api/models", json("POST", input)),
    updateModel: (id: string, input: Record<string, unknown>) => requestJson<ModelInstance>(fetcher, `/api/models/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteModel: (id: string) => requestVoid(fetcher, `/api/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
    testModel: (id: string) => requestJson<ModelInstance>(fetcher, `/api/models/${encodeURIComponent(id)}/test`, { method: "POST" }),
    getModelBindings: () => requestJson<{ bindings: RuntimeModelBinding[] }>(fetcher, "/api/model-bindings"),
    updateModelBinding: (purpose: ModelPurpose, input: Partial<RuntimeModelBinding>) => requestJson<RuntimeModelBinding>(
      fetcher,
      `/api/model-bindings/${encodeURIComponent(purpose)}`,
      json("PATCH", input),
    ),
    getModelCatalog: (filters: { provider?: string; transport?: string; includeHidden?: boolean } = {}) => requestJson<ModelCatalogResult>(
      fetcher,
      `/api/model-catalog${queryString(filters)}`,
    ),
    refreshModelCatalog: () => requestJson<ModelCatalogResult>(fetcher, "/api/model-catalog/refresh", { method: "POST" }),
    getRuntimeSettings: () => requestJson<RuntimeSettings>(fetcher, "/api/runtime-settings"),
    updateRuntimeSettings: (input: Partial<RuntimeSettings>) => requestJson<RuntimeSettings>(fetcher, "/api/runtime-settings", json("PATCH", input)),
    getRuntimeStatus: () => requestJson<RuntimeStatus>(fetcher, "/api/runtime-status"),
    checkCodex: () => requestJson<RuntimeStatus["codex"]>(fetcher, "/api/runtime/codex/check", { method: "POST" }),
    runCodeSync: (serviceId: string) => requestJson<{
      commit: string
      branch: string
      syncState: "fresh" | "fallback"
      repositories: Array<{ role: "backend" | "frontend"; commit: string }>
    }>(fetcher, "/api/runtime/code-sync", json("POST", { serviceId })),
    runLearning: () => requestJson<{ processed: number; createdVersions: number; conflicts: number; styleVersions: number }>(fetcher, "/api/runtime/learning", { method: "POST" }),
    getProject: (id: string) => requestJson<ProjectView>(fetcher, `/api/projects/${encodeURIComponent(id)}`),
    createProject: (input: Record<string, unknown>) => requestJson<ProjectView>(fetcher, "/api/projects", json("POST", input)),
    updateProject: (id: string, input: Record<string, unknown>) => requestJson<ProjectView>(fetcher, `/api/projects/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteProject: (id: string) => requestVoid(fetcher, `/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
    createProjectRepository: (projectId: string, input: Record<string, unknown>) => requestJson<ProjectRepository>(fetcher, `/api/projects/${encodeURIComponent(projectId)}/repositories`, json("POST", input)),
    updateProjectRepository: (id: string, input: Record<string, unknown>) => requestJson<ProjectRepository>(fetcher, `/api/project-repositories/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteProjectRepository: (id: string) => requestVoid(fetcher, `/api/project-repositories/${encodeURIComponent(id)}`, { method: "DELETE" }),
    createProjectService: (projectId: string, input: Record<string, unknown>) => requestJson<ProjectService>(fetcher, `/api/projects/${encodeURIComponent(projectId)}/services`, json("POST", input)),
    updateProjectService: (id: string, input: Record<string, unknown>) => requestJson<ProjectService>(fetcher, `/api/project-services/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteProjectService: (id: string) => requestVoid(fetcher, `/api/project-services/${encodeURIComponent(id)}`, { method: "DELETE" }),
    createProjectServer: (projectId: string, input: Record<string, unknown>) => requestJson<ProjectServer>(fetcher, `/api/projects/${encodeURIComponent(projectId)}/servers`, json("POST", input)),
    updateProjectServer: (id: string, input: Record<string, unknown>) => requestJson<ProjectServer>(fetcher, `/api/project-servers/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteProjectServer: (id: string) => requestVoid(fetcher, `/api/project-servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    createProjectDatabase: (projectId: string, input: Record<string, unknown>) => requestJson<ProjectDatabase>(fetcher, `/api/projects/${encodeURIComponent(projectId)}/databases`, json("POST", input)),
    updateProjectDatabase: (id: string, input: Record<string, unknown>) => requestJson<ProjectDatabase>(fetcher, `/api/project-databases/${encodeURIComponent(id)}`, json("PATCH", input)),
    deleteProjectDatabase: (id: string) => requestVoid(fetcher, `/api/project-databases/${encodeURIComponent(id)}`, { method: "DELETE" }),

    getMemories: (filters: { status?: MemoryStatus; scope?: string; q?: string; factId?: string; limit?: number } = {}) => (
      requestJson<{ generation: number; items: MemoryView[] }>(fetcher, `/api/memories${queryString(filters)}`)
    ),
    getMemory: (id: string) => requestJson<{ memory: MemoryView; events: MemoryEvent[]; evidence: MemoryEvidenceSummary }>(fetcher, `/api/memories/${encodeURIComponent(id)}`),
    getLearningObservations: (filters: {
      processingStatus?: LearningObservation["processingStatus"]
      classification?: NonNullable<LearningObservation["terminalResult"]>["classification"]
      risk?: NonNullable<LearningObservation["terminalResult"]>["risk"]
      limit?: number
    } = {}) => (
      requestJson<{ items: LearningObservation[] }>(fetcher, `/api/learning-observations${queryString(filters)}`)
    ),
    getOperatorStyleVersions: () => requestJson<{ items: OperatorStyleVersion[] }>(fetcher, "/api/operator-style-versions"),
    createMemory: (input: Record<string, unknown>) => requestJson<MemoryView>(fetcher, "/api/memories", json("POST", input)),
    setMemoryStatus: (id: string, status: MemoryStatus) => requestJson<MemoryView>(fetcher, `/api/memories/${encodeURIComponent(id)}/status`, json("PATCH", { status, actor: "后台管理员" })),
    getDirectives: () => requestJson<{ directives: Directive[] }>(fetcher, "/api/directives"),
    createDirective: (input: Record<string, unknown>) => requestJson<Directive>(fetcher, "/api/directives", json("POST", input)),
    updateDirective: (id: string, input: Record<string, unknown>) => requestJson<Directive>(
      fetcher,
      `/api/directives/${encodeURIComponent(id)}/content`,
      json("PATCH", { ...input, actor: "后台管理员" }),
    ),
    setDirectiveEnabled: (id: string, enabled: boolean) => requestJson<Directive>(fetcher, `/api/directives/${encodeURIComponent(id)}`, json("PATCH", { enabled, actor: "后台管理员" })),
    deleteDirective: (id: string) => requestVoid(
      fetcher,
      `/api/directives/${encodeURIComponent(id)}`,
      json("DELETE", { actor: "后台管理员" }),
    ),

    getReplies: (filters: { status?: ReplyRecord["status"]; groupId?: string; projectId?: string; serviceId?: string; senderQ?: string; role?: NonNullable<ReplyRecord["senderRole"]>; decision?: ReplyRecord["decision"]; from?: string; to?: string; q?: string; cursor?: string; limit?: number } = {}) => (
      requestJson<{ items: ReplyListItem[]; nextCursor: string | null }>(fetcher, `/api/replies${queryString(filters)}`)
    ),
    getReplyWorkQueue: () => requestJson<{ items: ReplyListItem[] }>(fetcher, "/api/replies/work"),
    getReply: (id: string) => requestJson<{ record: ReplyRecord }>(fetcher, `/api/replies/${encodeURIComponent(id)}`),
    correctReply: (id: string, input: Record<string, unknown>) => requestJson<{ memory: MemoryView; reply: ReplyRecord }>(
      fetcher,
      `/api/replies/${encodeURIComponent(id)}/corrections`,
      json("POST", input),
    ),
    getSupportThreadWorkQueue: () => requestJson<{ items: SupportThreadListItem[] }>(fetcher, "/api/support-threads/work"),
    getSupportThreads: (filters: { projectId?: string; serviceId?: string; groupId?: string; status?: SupportThreadStatus; hasSuperseded?: boolean; excludeActive?: boolean; senderQ?: string; from?: string; to?: string; q?: string; cursor?: string; limit?: number } = {}) => (
      requestJson<{ items: SupportThreadListItem[]; nextCursor: string | null }>(fetcher, `/api/support-threads${queryString(filters)}`)
    ),
    getSupportThread: (id: string) => requestJson<SupportThreadDetail>(fetcher, `/api/support-threads/${encodeURIComponent(id)}`),
    closeSupportThread: (id: string) => requestJson<SupportThreadDetail>(
      fetcher,
      `/api/support-threads/${encodeURIComponent(id)}/close`,
      { method: "POST" },
    ),

    getMagicBookStatus: () => requestJson<MagicBookStatus>(fetcher, "/api/magicbook/status"),
    getInterfaceDocuments: () => requestJson<{ documents: InterfaceDocumentSummary[] }>(fetcher, "/api/interface-docs"),
    searchInterfaceDocs: (scope: "india" | "non_india", search: string) => requestJson<InterfaceDocumentSearch>(
      fetcher,
      `/api/interface-docs/search${queryString({ scope, q: search })}`,
    ),

    exportDatabase: async () => {
      const response = await fetcher("/api/transfer/export")
      if (!response.ok) throw await responseError(response)
      return response.blob()
    },
    importDatabase: async (file: File) => {
      const response = await fetcher("/api/transfer/import", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.sqlite3" },
        body: file,
      })
      if (!response.ok) throw await responseError(response)
      return response.json() as Promise<{ imported: true }>
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
export const api = createApiClient()
