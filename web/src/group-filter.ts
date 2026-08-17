import type { GroupCatalogEntry } from "./types.js"

export type GroupFilter = "all" | "enabled" | "disabled" | "bot" | "user"

export function filterGroups(groups: GroupCatalogEntry[], query: string, filter: GroupFilter): GroupCatalogEntry[] {
  const search = query.trim().toLocaleLowerCase("zh-CN")
  return groups.filter((group) => {
    const matchesFilter = filter === "all"
      || (filter === "enabled" && group.enabled)
      || (filter === "disabled" && !group.enabled)
      || group.accessMode === filter
    if (!matchesFilter) return false
    if (!search) return true
    return [group.key, group.name, group.platform, group.branch, group.serverAlias, group.databaseAlias, group.knowledgeScope]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(search))
  })
}
