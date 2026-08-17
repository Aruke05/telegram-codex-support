import { createHash, randomUUID } from "node:crypto"

import { z } from "zod"

import type { RuntimeDatabase } from "../runtime/database.js"
import { isSafeSshHost, isSafeSshUsername } from "../security/ssh-target.js"
import type {
  DatabaseResourceRecord,
  ProjectRecord,
  ProjectRepositoryRecord,
  ProjectServiceRecord,
  ServerResourceRecord,
} from "../runtime/types.js"

const projectInputSchema = z.object({
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
  defaultKnowledgeScope: z.string().trim().min(1).max(120).default("global"),
}).strict()
const projectUpdateSchema = z.object({
  key: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  defaultKnowledgeScope: z.string().trim().min(1).max(120).optional(),
}).strict()

const repositoryInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  remoteUrl: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
}).strict()
const repositoryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  remoteUrl: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  clearRemoteCredentials: z.boolean().optional(),
}).strict()

const serviceInputSchema = z.object({
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).default(""),
  timezone: z.string().trim().max(120).default(""),
  backendRepositoryId: z.string().uuid(),
  frontendRepositoryId: z.string().uuid(),
  branch: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(true),
}).strict()
const serviceUpdateSchema = z.object({
  key: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  region: z.string().trim().max(120).optional(),
  timezone: z.string().trim().max(120).optional(),
  backendRepositoryId: z.string().uuid().optional(),
  frontendRepositoryId: z.string().uuid().optional(),
  branch: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
}).strict()

const serverInputSchema = z.object({
  serviceId: z.string().uuid(),
  alias: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255).refine(isSafeSshHost, "SSH 主机格式无效"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(120).refine(isSafeSshUsername, "SSH 用户名格式无效"),
  privateKey: z.string().min(1).max(100000),
  workdir: z.string().trim().min(1).max(1000).default("/opt/sfzf-service"),
  enabled: z.boolean().default(true),
}).strict()
const serverUpdateSchema = z.object({
  serviceId: z.string().uuid().optional(),
  alias: z.string().trim().min(1).max(120).optional(),
  host: z.string().trim().min(1).max(255).refine(isSafeSshHost, "SSH 主机格式无效").optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(120).refine(isSafeSshUsername, "SSH 用户名格式无效").optional(),
  privateKey: z.string().min(1).max(100000).optional(),
  workdir: z.string().trim().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
}).strict()

const databaseInputSchema = z.object({
  serviceId: z.string().uuid(),
  alias: z.string().trim().min(1).max(120),
  engine: z.literal("mysql").default("mysql"),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(3306),
  database: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(10000),
  timezone: z.string().trim().max(120).default(""),
  enabled: z.boolean().default(true),
}).strict()
const databaseUpdateSchema = z.object({
  serviceId: z.string().uuid().optional(),
  alias: z.string().trim().min(1).max(120).optional(),
  engine: z.literal("mysql").optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().min(1).max(10000).optional(),
  timezone: z.string().trim().max(120).optional(),
  enabled: z.boolean().optional(),
}).strict()

type PublicServerResource = Omit<ServerResourceRecord, "privateKey"> & {
  privateKeyConfigured: boolean
}

type PublicDatabaseResource = Omit<DatabaseResourceRecord, "password"> & {
  passwordConfigured: boolean
}

export type PublicProjectRepository = Omit<ProjectRepositoryRecord, "localPath" | "branch">

export type ProjectServiceView = ProjectServiceRecord & {
  repositories: {
    backend: { repositoryId: string; name: string } | null
    frontend: { repositoryId: string; name: string } | null
  }
  codeSync: {
    status: "healthy" | "failed" | "never"
    snapshotPublishedAt: string | null
    backendCommit: string | null
    frontendCommit: string | null
    safeSummary: string | null
  }
}

export type ProjectView = ProjectRecord & {
  repositories: PublicProjectRepository[]
  services: ProjectServiceView[]
  servers: PublicServerResource[]
  databases: PublicDatabaseResource[]
}

function publicServer(server: ServerResourceRecord): PublicServerResource {
  const { privateKey: _privateKey, ...safe } = server
  return { ...safe, privateKeyConfigured: true }
}

function publicDatabase(database: DatabaseResourceRecord): PublicDatabaseResource {
  const { password: _password, ...safe } = database
  return { ...safe, passwordConfigured: true }
}

function parseRemoteUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function publicRemoteUrl(value: string): string {
  const remote = parseRemoteUrl(value)
  if (!remote) return value.replace(/[?#].*$/u, "")
  remote.username = ""
  remote.password = ""
  remote.search = ""
  remote.hash = ""
  return remote.toString()
}

function remoteUrlHasCredentials(value: string): boolean {
  const remote = parseRemoteUrl(value)
  if (!remote) return /[?#]/u.test(value)
  return Boolean(remote.username || remote.password || remote.search || remote.hash)
}

function repositoryPairFingerprint(bindings: Array<{ role: "backend" | "frontend"; repositoryId: string; name: string }>): string {
  return createHash("sha256").update(bindings
    .sort((left, right) => left.role === right.role ? 0 : left.role === "backend" ? -1 : 1)
    .map((item) => `${item.role}:${item.repositoryId}:${item.name}`)
    .join("|"), "utf8").digest("hex")
}

function publicRepository(repository: ProjectRepositoryRecord): PublicProjectRepository {
  const { localPath: _localPath, branch: _branch, ...safe } = repository
  return { ...safe, remoteUrl: publicRemoteUrl(repository.remoteUrl) }
}

export class ProjectAdminService {
  constructor(readonly database: RuntimeDatabase) {}

  listProjects(): ProjectView[] {
    return this.database.readProjects("ORDER BY created_at").map((project) => this.view(project))
  }

  getProject(id: string): ProjectView {
    return this.view(this.requireProject(id))
  }

  createProject(input: unknown): ProjectView {
    const parsed = projectInputSchema.parse(input)
    if (parsed.key.toLocaleLowerCase("en-US") === "peakpay") throw new Error("Peakpay 不允许配置")
    if (this.database.readProjects("WHERE project_key=?", [parsed.key]).length > 0) throw new Error("项目标识不能重复")
    const now = new Date().toISOString()
    const project: ProjectRecord = { ...parsed, id: randomUUID(), createdAt: now, updatedAt: now }
    this.database.insertProject(project)
    return this.view(project)
  }

  updateProject(id: string, input: unknown): ProjectView {
    const found = this.requireProject(id)
    const parsed = projectUpdateSchema.parse(input)
    const updated = projectInputSchema.parse({ ...found, ...parsed })
    if (updated.key.toLocaleLowerCase("en-US") === "peakpay") throw new Error("Peakpay 不允许配置")
    const duplicate = this.database.readProjects("WHERE project_key=? AND id!=?", [updated.key, id])
    if (duplicate.length > 0) throw new Error("项目标识不能重复")
    const updatedAt = new Date().toISOString()
    this.database.prepare(`UPDATE projects SET project_key=?,name=?,description=?,enabled=?,default_knowledge_scope=?,updated_at=? WHERE id=?`).run(
      updated.key, updated.name, updated.description, Number(updated.enabled), updated.defaultKnowledgeScope, updatedAt, id,
    )
    return this.getProject(id)
  }

  deleteProject(id: string): void {
    this.requireProject(id)
    if (this.database.readProjectServices("WHERE project_id=?", [id]).length > 0) throw new Error("项目仍有服务资源")
    if (this.database.readGroups().some((group) => group.projectId === id)) throw new Error("项目仍被群配置使用")
    const reply = this.database.prepare("SELECT 1 FROM support_replies WHERE project_id=? LIMIT 1").get(id)
    if (reply) throw new Error("项目仍有客服记录，只能停用")
    this.database.prepare("DELETE FROM projects WHERE id=?").run(id)
  }

  createRepository(projectId: string, input: unknown): PublicProjectRepository {
    this.requireProject(projectId)
    const parsed = repositoryInputSchema.parse(input)
    const now = new Date().toISOString()
    const repository: ProjectRepositoryRecord = {
      ...parsed, localPath: "", branch: "main", id: randomUUID(), projectId, createdAt: now, updatedAt: now,
    }
    this.database.insertProjectRepository(repository)
    return publicRepository(repository)
  }

  updateRepository(id: string, input: unknown): PublicProjectRepository {
    const found = this.requireRepository(id)
    const parsed = repositoryUpdateSchema.parse(input)
    const { clearRemoteCredentials, ...changes } = parsed
    const submittedRemote = parsed.remoteUrl
    const submittedHasCredentials = submittedRemote ? remoteUrlHasCredentials(submittedRemote) : false
    const remoteUrl = clearRemoteCredentials
      ? publicRemoteUrl(submittedRemote ?? found.remoteUrl)
      : submittedRemote === undefined
        ? found.remoteUrl
        : !submittedHasCredentials && publicRemoteUrl(found.remoteUrl) === publicRemoteUrl(submittedRemote)
          ? found.remoteUrl
          : submittedRemote
    const updated = repositoryInputSchema.parse({
      name: changes.name ?? found.name,
      remoteUrl,
      enabled: changes.enabled ?? found.enabled,
    })
    const bindings = this.database.readProjectServiceRepositories("WHERE repository_id=?", [id])
    if (bindings.some((binding) => (
      binding.role === "backend" ? updated.name !== "java-project" : updated.name !== "sfzf-web"
    ))) throw new Error("已绑定的前后端仓库不能修改为其他名称")
    const boundServices = bindings.map((binding) => this.requireService(binding.serviceId))
    if (!updated.enabled && boundServices.some((service) => service.enabled)) {
      throw new Error("代码仓库仍被启用服务使用，请先停用或调整服务")
    }
    const updatedAt = new Date().toISOString()
    this.database.transaction(() => {
      this.database.prepare(`UPDATE project_repositories SET name=?,local_path='',remote_url=?,branch='main',enabled=?,updated_at=? WHERE id=?`).run(
        updated.name, updated.remoteUrl, Number(updated.enabled), updatedAt, id,
      )
      if (updated.remoteUrl !== found.remoteUrl || updated.enabled !== found.enabled || updated.name !== found.name) {
        boundServices.forEach((service) => this.resetCodeSyncSchedule(service.id, updatedAt))
      }
    })
    return publicRepository(this.requireRepository(id))
  }

  deleteRepository(id: string): void {
    this.requireRepository(id)
    if (this.database.readProjectServiceRepositories("WHERE repository_id=?", [id]).length > 0) throw new Error("代码仓库仍被服务使用")
    this.database.prepare("DELETE FROM project_repositories WHERE id=?").run(id)
  }

  createService(projectId: string, input: unknown): ProjectServiceView {
    this.requireProject(projectId)
    const parsed = serviceInputSchema.parse(input)
    if (parsed.key.toLocaleLowerCase("en-US") === "peakpay") throw new Error("Peakpay 不允许配置")
    this.validateServiceRepositories(projectId, parsed.backendRepositoryId, parsed.frontendRepositoryId)
    const now = new Date().toISOString()
    const service: ProjectServiceRecord = {
      id: randomUUID(), projectId, key: parsed.key, name: parsed.name, region: parsed.region, timezone: parsed.timezone,
      repositoryId: parsed.backendRepositoryId, branch: parsed.branch, enabled: parsed.enabled, createdAt: now, updatedAt: now,
    }
    this.database.transaction(() => {
      this.database.insertProjectService(service)
      this.replaceServiceRepositories(service.id, parsed.backendRepositoryId, parsed.frontendRepositoryId, now)
    })
    return this.serviceView(service)
  }

  updateService(id: string, input: unknown): ProjectServiceView {
    const found = this.requireService(id)
    const parsed = serviceUpdateSchema.parse(input)
    const bindings = this.serviceRepositoryIds(id)
    const updated = serviceInputSchema.parse({
      key: parsed.key ?? found.key,
      name: parsed.name ?? found.name,
      region: parsed.region ?? found.region,
      timezone: parsed.timezone ?? found.timezone,
      backendRepositoryId: parsed.backendRepositoryId ?? bindings.backend,
      frontendRepositoryId: parsed.frontendRepositoryId ?? bindings.frontend,
      branch: parsed.branch ?? found.branch,
      enabled: parsed.enabled ?? found.enabled,
    })
    if (updated.key.toLocaleLowerCase("en-US") === "peakpay") throw new Error("Peakpay 不允许配置")
    this.validateServiceRepositories(found.projectId, updated.backendRepositoryId, updated.frontendRepositoryId)
    const updatedAt = new Date().toISOString()
    const codeConfigurationChanged = updated.branch !== found.branch
      || updated.backendRepositoryId !== bindings.backend
      || updated.frontendRepositoryId !== bindings.frontend
      || updated.enabled !== found.enabled
    this.database.transaction(() => {
      this.database.prepare(`UPDATE project_services SET service_key=?,name=?,region=?,timezone=?,repository_id=?,branch=?,enabled=?,updated_at=? WHERE id=?`).run(
        updated.key, updated.name, updated.region, updated.timezone, updated.backendRepositoryId,
        updated.branch, Number(updated.enabled), updatedAt, id,
      )
      this.replaceServiceRepositories(id, updated.backendRepositoryId, updated.frontendRepositoryId, updatedAt)
      if (codeConfigurationChanged) this.resetCodeSyncSchedule(id, updatedAt)
    })
    return this.serviceView(this.requireService(id))
  }

  deleteService(id: string): void {
    this.requireService(id)
    if (this.database.readServerResources("WHERE service_id=?", [id]).length > 0
      || this.database.readDatabaseResources("WHERE service_id=?", [id]).length > 0) throw new Error("服务仍有连接资源")
    if (this.database.readGroups().some((group) => group.serviceId === id)) throw new Error("服务仍被群配置使用")
    const reply = this.database.prepare("SELECT 1 FROM support_replies WHERE service_id=? LIMIT 1").get(id)
    if (reply) throw new Error("服务仍有客服记录，只能停用")
    this.database.prepare("DELETE FROM project_services WHERE id=?").run(id)
  }

  createServer(projectId: string, input: unknown): PublicServerResource {
    this.requireProject(projectId)
    const parsed = serverInputSchema.parse(input)
    this.validateService(projectId, parsed.serviceId)
    const now = new Date().toISOString()
    const server: ServerResourceRecord = { ...parsed, id: randomUUID(), projectId, createdAt: now, updatedAt: now }
    this.database.insertServerResource(server)
    return publicServer(server)
  }

  updateServer(id: string, input: unknown): PublicServerResource {
    const found = this.requireServer(id)
    const parsed = serverUpdateSchema.parse(input)
    const updated = serverInputSchema.parse({ ...found, ...parsed, privateKey: parsed.privateKey?.trim() || found.privateKey })
    this.validateService(found.projectId, updated.serviceId)
    const updatedAt = new Date().toISOString()
    this.database.prepare(`UPDATE project_servers SET service_id=?,alias=?,host=?,port=?,username=?,private_key=?,workdir=?,enabled=?,updated_at=? WHERE id=?`).run(
      updated.serviceId, updated.alias, updated.host, updated.port, updated.username, updated.privateKey, updated.workdir,
      Number(updated.enabled), updatedAt, id,
    )
    return publicServer(this.requireServer(id))
  }

  deleteServer(id: string): void {
    this.requireServer(id)
    this.database.prepare("DELETE FROM project_servers WHERE id=?").run(id)
  }

  createDatabase(projectId: string, input: unknown): PublicDatabaseResource {
    this.requireProject(projectId)
    const parsed = databaseInputSchema.parse(input)
    this.validateService(projectId, parsed.serviceId)
    const now = new Date().toISOString()
    const database: DatabaseResourceRecord = { ...parsed, id: randomUUID(), projectId, createdAt: now, updatedAt: now }
    this.database.insertDatabaseResource(database)
    return publicDatabase(database)
  }

  updateDatabase(id: string, input: unknown): PublicDatabaseResource {
    const found = this.requireDatabase(id)
    const parsed = databaseUpdateSchema.parse(input)
    const updated = databaseInputSchema.parse({ ...found, ...parsed, password: parsed.password || found.password })
    this.validateService(found.projectId, updated.serviceId)
    const updatedAt = new Date().toISOString()
    this.database.prepare(`UPDATE project_databases SET service_id=?,alias=?,engine=?,host=?,port=?,database_name=?,username=?,password=?,timezone=?,enabled=?,updated_at=? WHERE id=?`).run(
      updated.serviceId, updated.alias, updated.engine, updated.host, updated.port, updated.database, updated.username,
      updated.password, updated.timezone, Number(updated.enabled), updatedAt, id,
    )
    return publicDatabase(this.requireDatabase(id))
  }

  deleteDatabase(id: string): void {
    this.requireDatabase(id)
    this.database.prepare("DELETE FROM project_databases WHERE id=?").run(id)
  }

  private view(project: ProjectRecord): ProjectView {
    return {
      ...project,
      repositories: this.database.readProjectRepositories("WHERE project_id=? ORDER BY created_at", [project.id]).map(publicRepository),
      services: this.database.readProjectServices("WHERE project_id=? ORDER BY created_at", [project.id]).map((service) => this.serviceView(service)),
      servers: this.database.readServerResources("WHERE project_id=? ORDER BY created_at", [project.id]).map(publicServer),
      databases: this.database.readDatabaseResources("WHERE project_id=? ORDER BY created_at", [project.id]).map(publicDatabase),
    }
  }

  private requireProject(id: string): ProjectRecord {
    const project = this.database.readProjects("WHERE id=?", [id])[0]
    if (!project) throw new Error("项目不存在")
    return project
  }

  private requireRepository(id: string): ProjectRepositoryRecord {
    const repository = this.database.readProjectRepositories("WHERE id=?", [id])[0]
    if (!repository) throw new Error("代码仓库不存在")
    return repository
  }

  private requireService(id: string): ProjectServiceRecord {
    const service = this.database.readProjectServices("WHERE id=?", [id])[0]
    if (!service) throw new Error("项目服务不存在")
    return service
  }

  private requireServer(id: string): ServerResourceRecord {
    const server = this.database.readServerResources("WHERE id=?", [id])[0]
    if (!server) throw new Error("服务器资源不存在")
    return server
  }

  private requireDatabase(id: string): DatabaseResourceRecord {
    const database = this.database.readDatabaseResources("WHERE id=?", [id])[0]
    if (!database) throw new Error("数据库资源不存在")
    return database
  }

  private serviceView(service: ProjectServiceRecord): ProjectServiceView {
    const bindings = this.database.readProjectServiceRepositories("WHERE service_id=?", [service.id])
    const repositories = this.database.readProjectRepositories("WHERE project_id=?", [service.projectId])
    const bound = (role: "backend" | "frontend") => {
      const binding = bindings.find((item) => item.role === role)
      const repository = binding ? repositories.find((item) => item.id === binding.repositoryId) : undefined
      return binding && repository ? { repositoryId: binding.repositoryId, name: repository.name } : null
    }
    const backend = bound("backend")
    const frontend = bound("frontend")
    const pairFingerprint = backend && frontend ? repositoryPairFingerprint([
      { role: "backend", repositoryId: backend.repositoryId, name: backend.name },
      { role: "frontend", repositoryId: frontend.repositoryId, name: frontend.name },
    ]) : null
    const schedule = this.database.prepare(`SELECT health_status,last_success_at FROM service_code_sync_schedule WHERE service_id=?`).get(service.id) as {
      health_status: "healthy" | "failed" | "never"
      last_success_at: string | null
    } | undefined
    const snapshot = pairFingerprint && schedule?.last_success_at ? this.database.prepare(`SELECT id,published_at FROM service_code_snapshots
      WHERE service_id=? AND branch=? AND repository_pair_fingerprint=? AND status='published' AND published_at<=?
      ORDER BY published_at DESC LIMIT 1`).get(service.id, service.branch, pairFingerprint, schedule.last_success_at) as {
        id: string
        published_at: string
      } | undefined : undefined
    const items = snapshot ? this.database.prepare(`SELECT role,commit_hash FROM service_code_snapshot_items
      WHERE snapshot_id=?`).all(snapshot.id) as Array<{ role: "backend" | "frontend"; commit_hash: string }> : []
    const lastBatch = this.database.prepare(`SELECT safe_summary FROM service_code_sync_batches
      WHERE service_id=? AND branch=? AND repository_pair_fingerprint IS ? ORDER BY started_at DESC LIMIT 1`).get(
      service.id, service.branch, pairFingerprint,
    ) as { safe_summary: string | null } | undefined
    return {
      ...service,
      repositories: { backend, frontend },
      codeSync: {
        status: schedule?.health_status ?? "never",
        snapshotPublishedAt: snapshot?.published_at ?? null,
        backendCommit: items.find((item) => item.role === "backend")?.commit_hash ?? null,
        frontendCommit: items.find((item) => item.role === "frontend")?.commit_hash ?? null,
        safeSummary: lastBatch?.safe_summary ?? null,
      },
    }
  }

  private serviceRepositoryIds(serviceId: string): { backend: string | null; frontend: string | null } {
    const bindings = this.database.readProjectServiceRepositories("WHERE service_id=?", [serviceId])
    return {
      backend: bindings.find((binding) => binding.role === "backend")?.repositoryId ?? null,
      frontend: bindings.find((binding) => binding.role === "frontend")?.repositoryId ?? null,
    }
  }

  private replaceServiceRepositories(serviceId: string, backendRepositoryId: string, frontendRepositoryId: string, now: string): void {
    this.database.prepare("DELETE FROM project_service_repositories WHERE service_id=?").run(serviceId)
    const insert = this.database.prepare(`INSERT INTO project_service_repositories(service_id,repository_id,role,created_at,updated_at)
      VALUES (?,?,?,?,?)`)
    insert.run(serviceId, backendRepositoryId, "backend", now, now)
    insert.run(serviceId, frontendRepositoryId, "frontend", now, now)
  }

  private resetCodeSyncSchedule(serviceId: string, now: string): void {
    this.database.prepare(`INSERT INTO service_code_sync_schedule(
      service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,failure_count,last_alert_fingerprint,created_at,updated_at
    ) VALUES (?,?,'never',NULL,NULL,0,NULL,?,?) ON CONFLICT(service_id) DO UPDATE SET
      next_hourly_sync_at=excluded.next_hourly_sync_at,health_status='never',last_success_at=NULL,last_failure_at=NULL,
      failure_count=0,last_alert_fingerprint=NULL,updated_at=excluded.updated_at`).run(serviceId, now, now, now)
  }

  private validateServiceRepositories(projectId: string, backendRepositoryId: string, frontendRepositoryId: string): void {
    if (backendRepositoryId === frontendRepositoryId) throw new Error("前后端代码仓库不能相同")
    const backend = this.requireRepository(backendRepositoryId)
    const frontend = this.requireRepository(frontendRepositoryId)
    if (backend.projectId !== projectId || frontend.projectId !== projectId) throw new Error("代码仓库不属于该项目")
    if (!backend.enabled || !frontend.enabled) throw new Error("服务代码仓库必须启用")
    if (backend.name !== "java-project") throw new Error("后端仓库必须是 java-project")
    if (frontend.name !== "sfzf-web") throw new Error("前端仓库必须是 sfzf-web")
  }

  private validateService(projectId: string, serviceId: string): void {
    if (this.requireService(serviceId).projectId !== projectId) throw new Error("服务不属于该项目")
  }
}
