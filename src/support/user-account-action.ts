import type { RuntimeDatabase } from "../runtime/database.js"

// 审批只能用于仍然有效的原问题版本；确认消息本身不延长原问题寿命。
export function currentAccountAction(database: RuntimeDatabase, action: {
  thread_id: string
  input_revision: number
  group_id: string
  service_id: string
}, now = new Date().toISOString()): boolean {
  const cutoff = new Date(new Date(now).getTime() - 30 * 60 * 1000).toISOString()
  return Boolean(database.prepare(`SELECT 1 FROM support_threads
    WHERE id=? AND revision=? AND group_id=? AND service_id=? AND status<>'closed' AND latest_message_at>?`).get(
    action.thread_id, action.input_revision, action.group_id, action.service_id, cutoff,
  ))
}

export function invalidateStaleAccountActions(
  database: RuntimeDatabase,
  table: "user_unfreeze_actions" | "user_credential_reset_actions",
  now = new Date().toISOString(),
): void {
  const cutoff = new Date(new Date(now).getTime() - 30 * 60 * 1000).toISOString()
  database.prepare(`UPDATE ${table} SET status='superseded',result_code='request_changed',
    safe_summary='原问题已更新或关闭，旧审批失效',completed_at=?,updated_at=?
    WHERE status IN ('awaiting_confirmation_delivery','pending_confirmation') AND NOT EXISTS (
      SELECT 1 FROM support_threads thread WHERE thread.id=${table}.thread_id
        AND thread.revision=${table}.input_revision AND thread.group_id=${table}.group_id
        AND thread.service_id=${table}.service_id AND thread.status<>'closed' AND thread.latest_message_at>?
    )`).run(now, now, cutoff)
}

export function boundAccountActionGroup(database: RuntimeDatabase, action: {
  group_id: string
  project_id: string
  service_id: string
  server_resource_id: string
  database_resource_id: string
  resource_fingerprint: string
}, fingerprint: (
  server: ReturnType<RuntimeDatabase["readServerResources"]>[number],
  resource: ReturnType<RuntimeDatabase["readDatabaseResources"]>[number],
  group: ReturnType<RuntimeDatabase["readGroups"]>[number],
) => string) {
  const group = database.readGroups().find((candidate) => candidate.id === action.group_id)
  if (!group?.enabled || !group.telegramChatId || group.projectId !== action.project_id || group.serviceId !== action.service_id) return undefined
  const server = database.readServerResources("WHERE id=? AND service_id=? AND enabled=1", [action.server_resource_id, action.service_id])[0]
  const resource = database.readDatabaseResources("WHERE id=? AND service_id=? AND enabled=1", [action.database_resource_id, action.service_id])[0]
  if (!server || !resource || (group.serverAlias && group.serverAlias !== server.alias)
    || group.databaseAlias !== resource.alias || fingerprint(server, resource, group) !== action.resource_fingerprint) return undefined
  return group
}
