import type { FastifyInstance } from "fastify"

import type { GroupCatalog } from "../catalog/schema.js"

export function registerCatalogRoutes(app: FastifyInstance, catalog: GroupCatalog): void {
  app.get("/api/groups", async () => ({
    version: catalog.version,
    technicalAlertGroup: {
      name: catalog.technicalAlertGroup.name,
      configured: catalog.technicalAlertGroup.telegramChatId !== null,
    },
    groups: catalog.groups.map((group) => ({
      key: group.key,
      name: group.name,
      enabled: group.enabled,
      configured: group.telegramChatId !== null,
      accessMode: group.accessMode,
      platform: group.platform,
      repositories: group.repositories,
      branch: group.branch,
      serverAlias: group.serverAlias,
      databaseAlias: group.databaseAlias,
      knowledgeScope: group.knowledgeScope,
    })),
  }))
}
