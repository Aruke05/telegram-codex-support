import type { FastifyInstance } from "fastify"

import type { ProjectAdminService } from "../projects/project-admin-service.js"

export function registerProjectRoutes(app: FastifyInstance, service: ProjectAdminService): void {
  app.get("/api/projects", async () => ({ projects: service.listProjects() }))
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => service.getProject(request.params.id))
  app.post<{ Body: unknown }>("/api/projects", async (request, reply) => (
    reply.code(201).send(service.createProject(request.body))
  ))
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/projects/:id", async (request) => (
    service.updateProject(request.params.id, request.body)
  ))
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    service.deleteProject(request.params.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/repositories", async (request, reply) => (
    reply.code(201).send(service.createRepository(request.params.id, request.body))
  ))
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/project-repositories/:id", async (request) => (
    service.updateRepository(request.params.id, request.body)
  ))
  app.delete<{ Params: { id: string } }>("/api/project-repositories/:id", async (request, reply) => {
    service.deleteRepository(request.params.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/services", async (request, reply) => (
    reply.code(201).send(service.createService(request.params.id, request.body))
  ))
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/project-services/:id", async (request) => (
    service.updateService(request.params.id, request.body)
  ))
  app.delete<{ Params: { id: string } }>("/api/project-services/:id", async (request, reply) => {
    service.deleteService(request.params.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/servers", async (request, reply) => (
    reply.code(201).send(service.createServer(request.params.id, request.body))
  ))
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/project-servers/:id", async (request) => (
    service.updateServer(request.params.id, request.body)
  ))
  app.delete<{ Params: { id: string } }>("/api/project-servers/:id", async (request, reply) => {
    service.deleteServer(request.params.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/databases", async (request, reply) => (
    reply.code(201).send(service.createDatabase(request.params.id, request.body))
  ))
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/project-databases/:id", async (request) => (
    service.updateDatabase(request.params.id, request.body)
  ))
  app.delete<{ Params: { id: string } }>("/api/project-databases/:id", async (request, reply) => {
    service.deleteDatabase(request.params.id)
    return reply.code(204).send()
  })
}
