import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"

import type { ReplyService } from "../replies/reply-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeGroup, SupportMessageEvent, SupportThread } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import { TelegramDeliveryError, type TelegramOutputOwnership } from "../telegram/runtime.js"
import type { ResourceWorkspace } from "./resource-workspace.js"

type TransportPort = {
  sendMessage(
    accountId: string | null,
    chatId: string,
    text: string,
    replyToMessageId?: string,
    quote?: string | null,
    ownership?: TelegramOutputOwnership,
  ): Promise<string>
}

type UserUnfreezeActionRow = {
  id: string
  thread_id: string
  input_revision: number
  group_id: string
  project_id: string
  service_id: string
  server_resource_id: string
  database_resource_id: string
  request_message_event_id: string
  confirmation_reply_id: string
  username: string
  sys_user_id: string
  resource_fingerprint: string
  status: string
  confirmation_telegram_message_id: string | null
  expires_at: string
}

type ResourceManifest = {
  sshConfigPath: string
  servers: Array<{ id: string; alias: string; sshAlias: string }>
  databases: Array<{
    id: string
    alias: string
    host: string
    port: number
    database: string
    username: string
    password: string
  }>
}

export type RemoteUnfreezeResult = {
  ok: boolean
  resultCode: string
  sysUserId?: string
  beforeStatus?: number | null
  afterStatus?: number | null
  affectedRows?: number
}

export type UserUnfreezeOperationExecutor = (input: {
  groupId: string
  projectId: string
  serviceId: string
  serverResourceId: string
  databaseResourceId: string
  username: string
  sysUserId: string
  resourceFingerprint: string
}) => Promise<RemoteUnfreezeResult>

export type UserUnfreezePreflightExecutor = (input: {
  groupId: string
  projectId: string
  serviceId: string
  serverResourceId: string
  databaseResourceId: string
  username: string
  resourceFingerprint: string
}) => Promise<RemoteUnfreezeResult>

export type UserUnfreezeConfirmationMatch = {
  actionId: string
  decision: "approve" | "reject"
}

export type UserUnfreezeConfirmationInput = {
  group: RuntimeGroup
  text: string
  replyToMessageId: string | null
  hasAttachments: boolean
  now?: string
}

const confirmationTtlMs = 10 * 60 * 1000
export const userUnfreezeUpdateSql = "UPDATE sys_user SET status=1 WHERE id=%s AND status=2 AND del_flag=0"
const affirmativeReplies = new Set([
  "嗯", "嗯嗯", "好", "好的", "行", "可以", "可以的", "确认", "确认解冻", "解冻吧", "处理吧",
  "是", "是的", "对", "对的", "ok", "okay", "yes",
])
const negativeReplies = new Set([
  "不", "不用", "不用了", "取消", "先不用", "暂时不用", "别解冻", "算了", "算了吧", "no",
])

function normalizeConfirmation(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[?？!！。.,，~～]+$/gu, "").replace(/\s+/gu, "")
}

function validUsername(value: string): boolean {
  return /^[\p{L}\p{N}_.@+\-]{1,120}$/u.test(value)
}

function resourceFingerprint(server: {
  id: string; alias: string; host: string; port: number; username: string; privateKey: string; workdir: string
}, database: {
  id: string; alias: string; host: string; port: number; database: string; username: string; password: string
}): string {
  return createHash("sha256").update(JSON.stringify({
    server: [server.id, server.alias, server.host, server.port, server.username, server.privateKey, server.workdir],
    database: [database.id, database.alias, database.host, database.port, database.database, database.username, database.password],
  })).digest("hex")
}

function sourceContainsUsername(source: string, username: string): boolean {
  if (!/^[A-Za-z0-9_.@+\-]+$/u.test(username)) return source.includes(username)
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return new RegExp(`(?<![A-Za-z0-9_.@+\\-])${escaped}(?![A-Za-z0-9_.@+\\-])`, "u").test(source)
}

function validatedRemoteResult(result: RemoteUnfreezeResult, expectedUserId?: string): RemoteUnfreezeResult {
  if (result.resultCode === "eligible") {
    return result.ok === true && typeof result.sysUserId === "string" && result.beforeStatus === 2
      && result.afterStatus === 2 && result.affectedRows === 0
      ? result
      : { ok: false, resultCode: "invalid_remote_result" }
  }
  if (result.resultCode === "unfrozen") {
    return result.ok === true && result.sysUserId === expectedUserId
      && result.beforeStatus === 2 && result.afterStatus === 1 && result.affectedRows === 1
      ? result
      : { ok: false, resultCode: "invalid_remote_result" }
  }
  if (result.resultCode === "already_unfrozen") {
    return result.ok === true && result.sysUserId === expectedUserId
      && result.beforeStatus === 1 && result.afterStatus === 1
      && (result.affectedRows === undefined || result.affectedRows === 0)
      ? result
      : { ok: false, resultCode: "invalid_remote_result" }
  }
  return result.ok === false ? result : { ok: false, resultCode: "invalid_remote_result" }
}

function actionResultMessage(username: string, resultCode: string): string {
  switch (resultCode) {
    case "unfrozen": return `账号 ${username} 的冻结状态已经解除了，可以重新尝试登录；如果之前连续输错过密码，原来的十分钟登录限制不会被这次解冻清掉`
    case "already_unfrozen": return `账号 ${username} 现在已经是正常状态，不用再解冻了`
    case "cancelled": return `好，账号 ${username} 先不解冻`
    case "not_found": return `没有查到账号 ${username}，这次没有做修改`
    case "deleted": return `账号 ${username} 已经是删除状态，这次不能解冻`
    case "invalid_status": return `账号 ${username} 当前不是冻结状态，这次没有做修改`
    case "conflict": return `账号 ${username} 的状态刚刚发生了变化，这次没有做修改，你再发我确认一下`
    case "ssh_failed":
    case "execution_timeout":
    case "invalid_remote_result":
    case "database_error":
    case "execution_unknown":
      return `账号 ${username} 的解冻结果暂时无法确认，先不要重复操作；需要按这次记录核对清楚后再处理`
    default: return `账号 ${username} 这次没能解冻成功，没有执行新的修改`
  }
}

export class UserUnfreezeService {
  constructor(private readonly deps: {
    database: RuntimeDatabase
    replies: ReplyService
    redactor: ConfiguredSecretRedactor
    transport: TransportPort
    resourceWorkspace: Pick<ResourceWorkspace, "open">
    operationExecutor?: UserUnfreezeOperationExecutor
    preflightExecutor?: UserUnfreezePreflightExecutor
  }) {
    const now = new Date().toISOString()
    deps.database.prepare(`UPDATE user_unfreeze_actions SET status='execution_unknown',result_code='process_interrupted',
      safe_summary='执行期间进程中断，未自动重试',completed_at=?,updated_at=? WHERE status='executing'`).run(now, now)
    deps.database.prepare(`UPDATE user_unfreeze_actions SET status='expired',result_code='confirmation_expired',
      safe_summary='确认已过期',completed_at=?,updated_at=?
      WHERE status='pending_confirmation' AND expires_at<=?`).run(now, now, now)
    deps.database.prepare(`UPDATE user_unfreeze_actions SET
      status='pending_confirmation',confirmation_telegram_message_id=(
        SELECT telegram_reply_message_id FROM support_replies WHERE id=confirmation_reply_id
      ),updated_at=? WHERE status='awaiting_confirmation_delivery' AND EXISTS (
        SELECT 1 FROM support_replies WHERE id=confirmation_reply_id AND status='replied'
          AND telegram_reply_message_id IS NOT NULL
      )`).run(now)
    deps.database.prepare(`UPDATE user_unfreeze_actions SET status='failed',result_code='confirmation_delivery_failed',
      safe_summary='确认消息未成功进入已发送状态',completed_at=?,updated_at=?
      WHERE status='awaiting_confirmation_delivery' AND EXISTS (
        SELECT 1 FROM support_replies WHERE id=confirmation_reply_id AND status IN ('failed','ignored','superseded')
      )`).run(now, now)
  }

  async prepareConfirmation(input: {
    replyId: string
    thread: SupportThread
    inputRevision: number
    group: RuntimeGroup
    username: string
  }): Promise<string> {
    const username = input.username.trim()
    if (!validUsername(username)) throw new Error("解冻账号格式不安全")
    if (username.toLocaleLowerCase("en-US") === "admin") throw new Error("受保护账号不允许通过群审批解冻")
    if (!input.group.projectId || input.group.serviceId !== input.thread.serviceId) {
      throw new Error("解冻请求的群与服务绑定不一致")
    }
    const projectId = input.group.projectId
    const databases = this.deps.database.readDatabaseResources(
      "WHERE service_id=? AND enabled=1 AND alias=?", [input.thread.serviceId, input.group.databaseAlias],
    )
    const servers = this.deps.database.readServerResources(
      "WHERE service_id=? AND enabled=1 ORDER BY created_at,id", [input.thread.serviceId],
    )
    const database = databases.length === 1 ? databases[0] : undefined
    const server = input.group.serverAlias
      ? servers.find((candidate) => candidate.alias === input.group.serverAlias)
      : servers.length === 1 ? servers[0] : undefined
    if (!database || !server) throw new Error("解冻请求缺少唯一的服务器或数据库绑定")
    const databaseId = database.id
    const serverId = server.id
    const fingerprint = resourceFingerprint(server, database)
    const event = this.deps.database.prepare(`SELECT event.id FROM support_thread_messages linked
      JOIN support_message_events event ON event.id=linked.message_event_id
      WHERE linked.thread_id=? ORDER BY event.created_at DESC,linked.position DESC LIMIT 1`).get(
      input.thread.id,
    ) as { id?: string } | undefined
    if (!event?.id) throw new Error("解冻请求缺少原始消息")
    const eventId = event.id
    const sourceMessages = this.deps.database.prepare(`SELECT event.safe_text FROM support_thread_messages linked
      JOIN support_message_events event ON event.id=linked.message_event_id
      WHERE linked.thread_id=? ORDER BY linked.position,event.created_at`).all(input.thread.id) as Array<{ safe_text: string }>
    if (!sourceMessages.some((message) => sourceContainsUsername(message.safe_text, username))) {
      throw new Error("解冻目标没有出现在用户原始消息中")
    }
    const preflight = validatedRemoteResult(await this.preflight({
      groupId: input.group.id,
      projectId,
      serviceId: input.thread.serviceId,
      serverResourceId: serverId,
      databaseResourceId: databaseId,
      username,
      resourceFingerprint: fingerprint,
    }))
    if (!preflight.ok || preflight.resultCode !== "eligible" || !preflight.sysUserId
      || preflight.beforeStatus !== 2 || preflight.afterStatus !== 2 || preflight.affectedRows !== 0) {
      throw new Error(`服务器侧解冻预检未通过：${preflight.resultCode}`)
    }
    const sysUserId = String(preflight.sysUserId)
    if (!/^[1-9]\d{0,79}$/u.test(sysUserId)) throw new Error("服务器侧解冻预检返回了无效用户 ID")
    return this.deps.database.transaction(() => {
      const currentThread = this.deps.database.prepare(
        "SELECT revision,status,group_id,service_id FROM support_threads WHERE id=?",
      ).get(input.thread.id) as { revision: number; status: string; group_id: string; service_id: string } | undefined
      if (!currentThread || Number(currentThread.revision) !== input.inputRevision || currentThread.status === "archived"
        || currentThread.group_id !== input.group.id || currentThread.service_id !== input.thread.serviceId) {
        throw new Error("解冻请求在预检期间已经发生变化")
      }
      const existing = this.deps.database.prepare(`SELECT * FROM user_unfreeze_actions
        WHERE thread_id=? AND input_revision=?`).get(
        input.thread.id, input.inputRevision,
      ) as UserUnfreezeActionRow | undefined
      if (existing) {
        if (existing.confirmation_reply_id !== input.replyId || existing.username !== username
          || existing.sys_user_id !== sysUserId || existing.resource_fingerprint !== fingerprint) {
          throw new Error("同一问题版本的解冻目标不一致")
        }
        return existing.id
      }
      const now = new Date().toISOString()
      this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status='superseded',
        result_code='superseded_by_new_revision',safe_summary='同一问题的新版本已替代旧审批',completed_at=?,updated_at=?
        WHERE thread_id=? AND input_revision<? AND status IN ('awaiting_confirmation_delivery','pending_confirmation')`).run(
        now, now, input.thread.id, input.inputRevision,
      )
      const id = randomUUID()
      this.deps.database.prepare(`INSERT INTO user_unfreeze_actions(
        id,thread_id,input_revision,group_id,project_id,service_id,server_resource_id,database_resource_id,request_message_event_id,
        confirmation_reply_id,username,sys_user_id,resource_fingerprint,preflight_checked_at,status,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_confirmation_delivery',?,?,?)`).run(
        id, input.thread.id, input.inputRevision, input.group.id, projectId,
        input.thread.serviceId, serverId, databaseId, eventId, input.replyId, username, sysUserId, fingerprint, now,
        new Date(Date.now() + confirmationTtlMs).toISOString(), now, now,
      )
      return id
    })
  }

  confirmationDelivered(actionId: string, telegramMessageId: string): void {
    const now = new Date().toISOString()
    this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status='pending_confirmation',
      confirmation_telegram_message_id=?,expires_at=?,updated_at=?
      WHERE id=? AND status='awaiting_confirmation_delivery'`).run(
      telegramMessageId, new Date(Date.now() + confirmationTtlMs).toISOString(), now, actionId,
    )
  }

  confirmationDeliveryFailed(actionId: string, uncertain: boolean): void {
    const now = new Date().toISOString()
    this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status=?,result_code=?,safe_summary=?,
      completed_at=?,updated_at=? WHERE id=? AND status='awaiting_confirmation_delivery'`).run(
      uncertain ? "delivery_unknown" : "failed",
      uncertain ? "confirmation_delivery_unknown" : "confirmation_delivery_failed",
      uncertain ? "确认消息投递结果未知，禁止继续执行" : "确认消息发送失败",
      now, now, actionId,
    )
  }

  matchConfirmation(input: UserUnfreezeConfirmationInput): UserUnfreezeConfirmationMatch | null {
    if (input.group.purpose !== "support" || !input.group.serviceId || input.hasAttachments) return null
    const normalized = normalizeConfirmation(input.text)
    const decision = affirmativeReplies.has(normalized) ? "approve" : negativeReplies.has(normalized) ? "reject" : null
    if (!decision) return null
    const now = input.now ?? new Date().toISOString()
    this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status='expired',result_code='confirmation_expired',
      safe_summary='确认已过期',completed_at=?,updated_at=?
      WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at<=?`).run(
      now, now, input.group.id, input.group.serviceId, now,
    )
    const rows = input.replyToMessageId
      ? this.deps.database.prepare(`SELECT id FROM user_unfreeze_actions
          WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at>?
            AND confirmation_telegram_message_id=? LIMIT 2`).all(
          input.group.id, input.group.serviceId, now, input.replyToMessageId,
        ) as Array<{ id: string }>
      : this.deps.database.prepare(`SELECT id FROM user_unfreeze_actions
          WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at>?
          ORDER BY created_at DESC,id DESC LIMIT 2`).all(input.group.id, input.group.serviceId, now) as Array<{ id: string }>
    return rows.length === 1 ? { actionId: rows[0]!.id, decision } : null
  }

  async handleConfirmation(
    match: UserUnfreezeConfirmationMatch,
    event: SupportMessageEvent,
  ): Promise<void> {
    if (match.decision === "reject") {
      const now = new Date().toISOString()
      const changed = this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status='cancelled',
        confirmer_message_event_id=?,confirmer_user_id=?,confirmer_username=?,result_code='cancelled',
        safe_summary='群成员取消解冻',completed_at=?,updated_at=?
        WHERE id=? AND status='pending_confirmation' AND expires_at>?`).run(
        event.id, event.senderUserId, event.senderUsername, now, now, match.actionId, now,
      )
      if (Number(changed.changes) !== 1) return
      const action = this.readAction(match.actionId)
      await this.sendResult(action, event, "cancelled")
      return
    }

    const now = new Date().toISOString()
    const claimed = this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status='executing',
      confirmer_message_event_id=?,confirmer_user_id=?,confirmer_username=?,execution_started_at=?,updated_at=?
      WHERE id=? AND status='pending_confirmation' AND expires_at>?`).run(
      event.id, event.senderUserId, event.senderUsername, now, now, match.actionId, now,
    )
    if (Number(claimed.changes) !== 1) return
    const action = this.readAction(match.actionId)
    let result: RemoteUnfreezeResult
    try {
      result = validatedRemoteResult(await this.execute(action), action.sys_user_id)
    } catch {
      result = { ok: false, resultCode: "execution_unknown" }
    }
    const completedAt = new Date().toISOString()
    const status = result.resultCode === "unfrozen" ? "succeeded"
      : result.resultCode === "already_unfrozen" ? "already_unfrozen"
        : ["ssh_failed", "execution_timeout", "invalid_remote_result", "database_error", "execution_unknown"]
            .includes(result.resultCode) ? "execution_unknown" : "failed"
    this.deps.database.prepare(`UPDATE user_unfreeze_actions SET status=?,before_status=?,after_status=?,
      affected_rows=?,result_code=?,safe_summary=?,completed_at=?,updated_at=?
      WHERE id=? AND status='executing'`).run(
      status, result.beforeStatus ?? null, result.afterStatus ?? null, result.affectedRows ?? 0,
      result.resultCode, actionResultMessage(action.username, result.resultCode), completedAt, completedAt, action.id,
    )
    await this.sendResult(action, event, result.resultCode)
  }

  private readAction(id: string): UserUnfreezeActionRow {
    const action = this.deps.database.prepare("SELECT * FROM user_unfreeze_actions WHERE id=?").get(id) as
      UserUnfreezeActionRow | undefined
    if (!action) throw new Error("解冻审批记录不存在")
    return action
  }

  private async execute(action: UserUnfreezeActionRow): Promise<RemoteUnfreezeResult> {
    const group = this.deps.database.readGroups().find((candidate) => candidate.id === action.group_id)
    if (!group?.enabled || !group.telegramChatId || group.projectId !== action.project_id
      || group.serviceId !== action.service_id || !validUsername(action.username)) {
      return { ok: false, resultCode: "binding_changed" }
    }
    const configuredDatabases = this.deps.database.readDatabaseResources(
      "WHERE service_id=? AND enabled=1 AND alias=?", [action.service_id, group.databaseAlias],
    )
    const configuredService = this.deps.database.readProjectServices(
      "WHERE id=? AND project_id=? AND enabled=1", [action.service_id, action.project_id],
    )[0]
    const configuredServers = this.deps.database.readServerResources(
      "WHERE service_id=? AND enabled=1 ORDER BY created_at,id", [action.service_id],
    )
    const configuredServer = group.serverAlias
      ? configuredServers.find((candidate) => candidate.alias === group.serverAlias)
      : configuredServers.length === 1 ? configuredServers[0] : undefined
    if (!configuredService || configuredDatabases.length !== 1 || configuredDatabases[0]!.id !== action.database_resource_id
      || !configuredServer || configuredServer.id !== action.server_resource_id) {
      return { ok: false, resultCode: "binding_changed" }
    }
    if (resourceFingerprint(configuredServer, configuredDatabases[0]!) !== action.resource_fingerprint) {
      return { ok: false, resultCode: "binding_changed" }
    }
    if (this.deps.operationExecutor) {
      return this.deps.operationExecutor({
        groupId: action.group_id,
        projectId: action.project_id,
        serviceId: action.service_id,
        serverResourceId: action.server_resource_id,
        databaseResourceId: action.database_resource_id,
        username: action.username,
        sysUserId: action.sys_user_id,
        resourceFingerprint: action.resource_fingerprint,
      })
    }
    const workspace = await this.deps.resourceWorkspace.open(action.service_id, null)
    try {
      const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as ResourceManifest
      const database = manifest.databases.find((candidate) => candidate.id === action.database_resource_id)
      const server = manifest.servers.find((candidate) => candidate.id === action.server_resource_id)
      if (!database || !server) return { ok: false, resultCode: "resource_binding_unavailable" }
      const payload = Buffer.from(JSON.stringify({
        host: database.host,
        port: database.port,
        database: database.database,
        username: database.username,
        password: database.password,
        targetUsername: action.username,
        targetUserId: action.sys_user_id,
      }), "utf8").toString("base64")
      return await this.runRemote(workspace.path, manifest.sshConfigPath, server.sshAlias, payload, "execute")
    } finally {
      await workspace.cleanup()
    }
  }

  private async preflight(input: Parameters<UserUnfreezePreflightExecutor>[0]): Promise<RemoteUnfreezeResult> {
    if (this.deps.preflightExecutor) return this.deps.preflightExecutor(input)
    const workspace = await this.deps.resourceWorkspace.open(input.serviceId, null)
    try {
      const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as ResourceManifest
      const database = manifest.databases.find((candidate) => candidate.id === input.databaseResourceId)
      const server = manifest.servers.find((candidate) => candidate.id === input.serverResourceId)
      if (!database || !server) return { ok: false, resultCode: "resource_binding_unavailable" }
      const payload = Buffer.from(JSON.stringify({
        host: database.host,
        port: database.port,
        database: database.database,
        username: database.username,
        password: database.password,
        targetUsername: input.username,
      }), "utf8").toString("base64")
      return await this.runRemote(workspace.path, manifest.sshConfigPath, server.sshAlias, payload, "preflight")
    } finally {
      await workspace.cleanup()
    }
  }

  private runRemote(
    cwd: string,
    sshConfigPath: string,
    sshAlias: string,
    payload: string,
    mode: "preflight" | "execute",
  ): Promise<RemoteUnfreezeResult> {
    const program = [
      "import base64,json,sys",
      "connection=None",
      "try:",
      " import pymysql",
      ` payload=json.loads(base64.b64decode(${JSON.stringify(payload)}).decode(\"utf-8\"))`,
      " connection=pymysql.connect(host=payload['host'],port=int(payload['port']),user=payload['username'],password=payload['password'],database=payload['database'],charset='utf8mb4',connect_timeout=8,read_timeout=20,write_timeout=20,autocommit=False,cursorclass=pymysql.cursors.DictCursor)",
      " with connection.cursor() as cursor:",
      mode === "execute"
        ? "  cursor.execute('SELECT id,username,user_type,status,del_flag FROM sys_user WHERE id=%s AND username=%s LIMIT 2 FOR UPDATE',(payload['targetUserId'],payload['targetUsername']))"
        : "  cursor.execute('SELECT id,username,user_type,status,del_flag FROM sys_user WHERE username=%s LIMIT 2',(payload['targetUsername'],))",
      "  rows=cursor.fetchall()",
      "  if len(rows)==0: result={'ok':False,'resultCode':'not_found'}",
      "  elif len(rows)>1: result={'ok':False,'resultCode':'ambiguous'}",
      "  else:",
      "   row=rows[0]",
      "   before=int(row['status']) if row['status'] is not None else None",
      "   if str(row.get('username') or '')!=payload['targetUsername']: result={'ok':False,'resultCode':'target_mismatch','beforeStatus':before}",
      "   elif str(row.get('username') or '').lower()=='admin' or str(row.get('user_type') or '')=='CG_YH': result={'ok':False,'resultCode':'protected_user','beforeStatus':before}",
      "   elif int(row['del_flag'] or 0)!=0: result={'ok':False,'resultCode':'deleted','beforeStatus':before}",
      "   elif before==1: result={'ok':True,'resultCode':'already_unfrozen','sysUserId':str(row['id']),'beforeStatus':1,'afterStatus':1,'affectedRows':0}",
      "   elif before!=2: result={'ok':False,'resultCode':'invalid_status','beforeStatus':before}",
      "   elif " + JSON.stringify(mode) + "=='preflight': result={'ok':True,'resultCode':'eligible','sysUserId':str(row['id']),'beforeStatus':2,'afterStatus':2,'affectedRows':0}",
      "   else:",
      `    cursor.execute(${JSON.stringify(userUnfreezeUpdateSql)},(row['id'],))`,
      "    affected=int(cursor.rowcount)",
      "    if affected!=1: result={'ok':False,'resultCode':'conflict','beforeStatus':before,'affectedRows':affected}",
      "    else:",
      "     cursor.execute('SELECT status FROM sys_user WHERE id=%s',(row['id'],))",
      "     checked=cursor.fetchone()",
      "     after=int(checked['status']) if checked and checked['status'] is not None else None",
      "     result={'ok':after==1,'resultCode':'unfrozen' if after==1 else 'verification_failed','sysUserId':str(row['id']),'beforeStatus':before,'afterStatus':after,'affectedRows':affected}",
      " if result.get('resultCode') in ('unfrozen',): connection.commit()",
      " else: connection.rollback()",
      " print(json.dumps(result,ensure_ascii=False))",
      "except Exception as error:",
      " if connection:",
      "  try: connection.rollback()",
      "  except Exception: pass",
      " print(json.dumps({'ok':False,'resultCode':'database_error','errorType':type(error).__name__},ensure_ascii=False))",
      " sys.exit(1)",
      "finally:",
      " if connection:",
      "  try: connection.close()",
      "  except Exception: pass",
    ].join("\n")
    return new Promise((resolve) => {
      const child = spawn("ssh", [
        "-F", sshConfigPath, "--", sshAlias, "timeout", "35s", "python3", "-",
      ], { cwd, stdio: ["pipe", "pipe", "pipe"] })
      let stdout = ""
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: RemoteUnfreezeResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 16_384) stdout += chunk.toString("utf8")
      })
      child.once("error", () => finish({ ok: false, resultCode: "ssh_failed" }))
      child.once("close", () => {
        try {
          const line = stdout.trim().split(/\r?\n/u).at(-1) ?? ""
          const parsed = JSON.parse(line) as RemoteUnfreezeResult
          if (typeof parsed.ok !== "boolean" || typeof parsed.resultCode !== "string") throw new Error()
          finish(parsed)
        } catch {
          finish({ ok: false, resultCode: "invalid_remote_result" })
        }
      })
      child.stdin.end(program)
      timer = setTimeout(() => {
        child.kill("SIGKILL")
        finish({ ok: false, resultCode: "execution_timeout" })
      }, 40_000)
      timer.unref()
    })
  }

  private async sendResult(
    action: UserUnfreezeActionRow,
    event: SupportMessageEvent,
    resultCode: string,
  ): Promise<void> {
    const group = this.deps.database.readGroups().find((candidate) => candidate.id === action.group_id)
    const service = this.deps.database.readProjectServices("WHERE id=?", [action.service_id])[0]
    if (!group?.enabled || !group.telegramChatId || !service) return
    const answer = actionResultMessage(action.username, resultCode)
    const outbound = this.deps.redactor.assertSafeOutbound(answer)
    if (!outbound.allowed || outbound.safeText !== answer) throw new Error("解冻结果未通过发送前安全校验")
    const reply = this.deps.replies.createPending({
      threadId: null,
      inputRevision: null,
      groupId: group.id,
      accountId: group.accountId,
      projectId: action.project_id,
      serviceId: action.service_id,
      telegramMessageId: event.telegramMessageId,
      senderUserId: event.senderUserId,
      senderUsername: event.senderUsername,
      senderDisplayName: event.senderDisplayName,
      senderRole: event.senderRole,
      service: service.key,
      serviceSource: "group_binding",
      question: event.safeText || "确认解冻",
    })
    this.deps.replies.transition(reply.id, "generating")
    const sending = this.deps.replies.claimUnthreadedSending(reply.id, {
      answer,
      decisionReason: `受限操作结果：${resultCode}`,
      decisionConfidence: 1,
    })
    if (!sending) return
    try {
      const messageId = await this.deps.transport.sendMessage(
        group.accountId, group.telegramChatId, answer, event.telegramMessageId, null,
        { groupId: group.id, serviceId: action.service_id, replyId: reply.id, kind: "user_unfreeze_result" },
      )
      this.deps.replies.transition(reply.id, "replied", { telegramReplyMessageId: messageId })
    } catch (error) {
      this.deps.replies.transition(reply.id, "failed", {
        errorCode: "user_unfreeze_result_delivery_failed",
        decisionReason: "解冻结果发送失败",
        operatorDeliveryStatus: error instanceof TelegramDeliveryError && error.state === "uncertain" ? "uncertain" : "failed",
      })
    }
  }
}
