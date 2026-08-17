import type { RuntimeDatabase } from "../runtime/database.js"
import type { DatabaseResourceRecord, ProjectRecord, ProjectRepositoryRecord, ProjectServiceRecord, ServerResourceRecord } from "../runtime/types.js"

export type ResolvedServiceResources = {
  project: ProjectRecord
  service: ProjectServiceRecord
  repositories: {
    backend: Omit<ProjectRepositoryRecord, "localPath" | "branch"> | null
    frontend: Omit<ProjectRepositoryRecord, "localPath" | "branch"> | null
  }
  servers: Array<Omit<ServerResourceRecord, "privateKey">>
  databases: Array<Omit<DatabaseResourceRecord, "password">>
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s_-]+/g, "")
}

function publicRepository(repository: ProjectRepositoryRecord | null): Omit<ProjectRepositoryRecord, "localPath" | "branch"> | null {
  if (!repository) return null
  const { localPath: _localPath, branch: _branch, ...safe } = repository
  try {
    const remote = new URL(repository.remoteUrl)
    remote.username = ""
    remote.password = ""
    remote.search = ""
    remote.hash = ""
    return { ...safe, remoteUrl: remote.toString() }
  } catch {
    return { ...safe, remoteUrl: repository.remoteUrl.replace(/[?#].*$/u, "") }
  }
}

export class ResourceResolver {
  constructor(private readonly database: RuntimeDatabase) {}

  resolveService(serviceName: string): ResolvedServiceResources {
    const needle = normalize(serviceName)
    if (!needle || needle === "peakpay" || needle === "peak") throw new Error("未找到服务资源")
    const projects = this.database.readProjects("WHERE enabled=1")
    const services = this.database.readProjectServices("WHERE enabled=1")
    const servers = this.database.readServerResources("WHERE enabled=1")
    const databases = this.database.readDatabaseResources("WHERE enabled=1")
    const matchingServiceIds = new Set<string>()

    services.forEach((service) => {
      if ([service.key, service.name].some((value) => normalize(value) === needle)) matchingServiceIds.add(service.id)
    })
    servers.forEach((server) => {
      if (normalize(server.alias) === needle) matchingServiceIds.add(server.serviceId)
    })
    databases.forEach((database) => {
      if (normalize(database.alias) === needle) matchingServiceIds.add(database.serviceId)
    })
    projects.forEach((project) => {
      if (normalize(project.key) !== needle && normalize(project.name) !== needle) return
      const projectServices = services.filter((service) => service.projectId === project.id)
      if (projectServices.length === 1) matchingServiceIds.add(projectServices[0]!.id)
    })

    const matches = services.filter((service) => matchingServiceIds.has(service.id))
    if (matches.length === 0) throw new Error("未找到服务资源")
    if (matches.length > 1) throw new Error("服务资源匹配不唯一")
    const service = matches[0]!
    const project = projects.find((item) => item.id === service.projectId)
    if (!project) throw new Error("未找到服务资源")
    const bindings = this.database.readProjectServiceRepositories("WHERE service_id=?", [service.id])
    const repositories = this.database.readProjectRepositories("WHERE project_id=? AND enabled=1", [service.projectId])
    const repositoryFor = (role: "backend" | "frontend") => {
      const repositoryId = bindings.find((binding) => binding.role === role)?.repositoryId
      return repositoryId ? repositories.find((repository) => repository.id === repositoryId) ?? null : null
    }
    return {
      project,
      service,
      repositories: {
        backend: publicRepository(repositoryFor("backend")),
        frontend: publicRepository(repositoryFor("frontend")),
      },
      servers: servers.filter((server) => server.serviceId === service.id).map(({ privateKey: _privateKey, ...server }) => server),
      databases: databases.filter((database) => database.serviceId === service.id).map(({ password: _password, ...database }) => database),
    }
  }
}
