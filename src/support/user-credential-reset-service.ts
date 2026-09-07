import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"

import type { ReplyService } from "../replies/reply-service.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import type { RuntimeGroup, SupportMessageEvent, SupportThread } from "../runtime/types.js"
import type { ConfiguredSecretRedactor } from "../security/dlp.js"
import { TelegramDeliveryError, type TelegramOutputOwnership } from "../telegram/runtime.js"
import type { ResourceWorkspace } from "./resource-workspace.js"
import { boundAccountActionGroup, currentAccountAction, invalidateStaleAccountActions } from "./user-account-action.js"

type TransportPort = {
  sendMessage(
    accountId: string | null,
    chatId: string,
    text: string,
    replyToMessageId?: string,
    quote?: string | null,
    ownership?: TelegramOutputOwnership,
  ): Promise<string>
  deleteMessage(accountId: string, chatId: string, messageId: string): Promise<void>
}

type CredentialResetActionRow = {
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
  state_token: string
  resource_fingerprint: string
  reset_password: number
  reset_totp: number
  requester_user_id: string
  status: string
  confirmation_telegram_message_id: string | null
  expires_at: string
}

type ResourceManifest = {
  sshConfigPath: string
  servers: Array<{ id: string; alias: string; sshAlias: string }>
  databases: Array<{
    id: string
    host: string
    port: number
    database: string
    username: string
    password: string
  }>
}

export type RemoteCredentialResetResult = {
  ok: boolean
  resultCode: string
  sysUserId?: string
  stateToken?: string
  userType?: string
  status?: number
  delFlag?: number
  passwordReset?: boolean
  totpReset?: boolean
}

export type CredentialResetExecutor = (input: {
  mode: "inspect" | "reset"
  serviceId: string
  serverResourceId: string
  databaseResourceId: string
  username: string
  sysUserId?: string
  stateToken?: string
  operationId?: string
  resetPassword: boolean
  resetTotp: boolean
  passwordHash?: string
  passwordSalt?: string
  totpSecret?: string
}) => Promise<RemoteCredentialResetResult>

type ResetMaterial = {
  temporaryPassword: string | null
  passwordHash: string | null
  passwordSalt: string | null
  totpSecret: string | null
}

export type UserCredentialResetConfirmationMatch = {
  actionId: string
  decision: "approve" | "reject"
}

const confirmationTtlMs = 10 * 60 * 1000
const secretDeleteDelayMs = 3 * 60 * 1000
const affirmativeReplies = new Set([
  "嗯", "嗯嗯", "好", "好的", "行", "可以", "可以的", "确认", "确认重置", "重置吧", "处理吧",
  "是", "是的", "对", "对的", "ok", "okay", "yes",
])
const negativeReplies = new Set([
  "不", "不用", "不用了", "取消", "先不用", "暂时不用", "别重置", "算了", "算了吧", "no",
])
const passwordLower = "abcdefghijkmnopqrstuvwxyz"
const passwordUpper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
const passwordDigits = "23456789"
const passwordSpecial = "!@#$%^&*_-+="
const saltAlphabet = "qwertyuioplkjhgfdsazxcvbnmQAZWSXEDCRFVTGBYHNUJMIKLOP0123456789"
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function secureCharacter(alphabet: string): string {
  const ceiling = Math.floor(256 / alphabet.length) * alphabet.length
  while (true) {
    const value = randomBytes(1)[0]!
    if (value < ceiling) return alphabet[value % alphabet.length]!
  }
}

function secureString(length: number, alphabet: string): string {
  return Array.from({ length }, () => secureCharacter(alphabet)).join("")
}

function temporaryPassword(): string {
  const all = passwordLower + passwordUpper + passwordDigits + passwordSpecial
  const chars = [
    secureCharacter(passwordLower), secureCharacter(passwordUpper),
    secureCharacter(passwordDigits), secureCharacter(passwordSpecial),
    ...Array.from({ length: 12 }, () => secureCharacter(all)),
  ]
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = Number(BigInt(`0x${randomBytes(8).toString("hex")}`) % BigInt(index + 1))
    ;[chars[index], chars[swapIndex]] = [chars[swapIndex]!, chars[index]!]
  }
  return chars.join("")
}

function totpSecret(): string {
  const bytes = randomBytes(20)
  let bits = ""
  for (const value of bytes) bits += value.toString(2).padStart(8, "0")
  let encoded = ""
  for (let offset = 0; offset < bits.length; offset += 5) {
    encoded += base32Alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, "0"), 2)]!
  }
  return encoded
}

export function encryptLegacySysUserPassword(username: string, password: string, salt: string): Promise<string> {
  if (!validUsername(username) || !password || !/^[A-Za-z0-9]{8}$/u.test(salt)) {
    return Promise.reject(new Error("密码加密参数无效"))
  }
  const program = `const crypto=require("node:crypto");let input="";process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const value=JSON.parse(input);
let digest=Buffer.concat([Buffer.from(value.password,"utf8"),Buffer.from(value.salt,"utf8")]);
for(let i=0;i<1000;i++)digest=crypto.createHash("md5").update(digest).digest();
const cipher=crypto.createCipheriv("des-cbc",digest.subarray(0,8),digest.subarray(8,16));
process.stdout.write(Buffer.concat([cipher.update(Buffer.from(value.username,"utf8")),cipher.final()]).toString("hex"));});`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--openssl-legacy-provider", "-e", program], {
      stdio: ["pipe", "pipe", "ignore"],
    })
    let stdout = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const value = stdout.trim()
      if (error || !/^[a-f0-9]+$/u.test(value) || value.length % 16 !== 0) reject(error ?? new Error("密码加密结果无效"))
      else resolve(value)
    }
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8") })
    child.once("error", () => finish(new Error("密码加密进程启动失败")))
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("密码加密进程失败")))
    child.stdin.end(JSON.stringify({ username, password, salt }))
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new Error("密码加密超时"))
    }, 5_000)
    timer.unref()
  })
}

function normalizeConfirmation(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[?？!！。.,，~～]+$/gu, "").replace(/\s+/gu, "")
}

function validUsername(value: string): boolean {
  return /^[A-Za-z0-9_.@+\-]{1,120}$/u.test(value)
}

function sourceContainsUsername(source: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return new RegExp(`(?<![A-Za-z0-9_.@+\\-])${escaped}(?![A-Za-z0-9_.@+\\-])`, "u").test(source)
}

function resourceFingerprint(server: {
  id: string; alias: string; host: string; port: number; username: string; privateKey: string; workdir: string
}, database: {
  id: string; alias: string; engine: string; host: string; port: number; database: string; username: string; password: string
}, group: Pick<RuntimeGroup, "accountId" | "telegramChatId">): string {
  return createHash("sha256").update(JSON.stringify([
    group.accountId, group.telegramChatId,
    server.id, server.alias, server.host, server.port, server.username, server.privateKey, server.workdir,
    database.id, database.alias, database.engine, database.host, database.port,
    database.database, database.username, database.password,
  ])).digest("hex")
}

function operationLabel(resetPassword: boolean, resetTotp: boolean): string {
  if (resetPassword && resetTotp) return "密码和谷歌验证"
  return resetPassword ? "密码" : "谷歌验证"
}

function resultMessage(action: CredentialResetActionRow, resultCode: string): string {
  const label = operationLabel(Boolean(action.reset_password), Boolean(action.reset_totp))
  switch (resultCode) {
    case "reset":
      return action.reset_password
        ? `账号 ${action.username} 的${label}已经重置，临时密码已发在群里；登录后请马上在右上角修改密码`
        : `账号 ${action.username} 的谷歌验证已经重置，用原密码登录后按页面提示重新扫码绑定`
    case "reset_password_delivery_failed":
      return `账号 ${action.username} 已完成${label}重置，但临时密码发送失败；先不要反复尝试登录，需要重新发起一次密码重置`
    case "cancelled": return `好，账号 ${action.username} 先不重置`
    case "not_found": return `没有查到客服账号 ${action.username}，这次没有做修改`
    case "protected_user": return `账号 ${action.username} 不是可由群里审批重置的客服账号，这次没有做修改`
    case "conflict": return `账号 ${action.username} 的资料刚刚发生了变化，这次没有做修改，你重新发起一下`
    default: return `账号 ${action.username} 的重置结果暂时无法确认，先不要重复操作，需要按这次记录核对清楚`
  }
}

export class UserCredentialResetService {
  private deletionTimer: ReturnType<typeof setInterval> | null = null
  private deletionRunning = false

  constructor(private readonly deps: {
    database: RuntimeDatabase
    replies: ReplyService
    redactor: ConfiguredSecretRedactor
    transport: TransportPort
    resourceWorkspace: Pick<ResourceWorkspace, "open">
    executor?: CredentialResetExecutor
  }) {
    const now = new Date().toISOString()
    deps.database.prepare(`UPDATE user_credential_reset_actions SET status='execution_unknown',result_code='process_interrupted',
      password_delivery_status=CASE WHEN password_delivery_status='sending' THEN 'unknown' ELSE password_delivery_status END,
      safe_summary='执行期间进程中断，未自动重试',completed_at=?,updated_at=? WHERE status='executing'`).run(now, now)
    deps.database.prepare(`UPDATE user_credential_reset_actions SET
      status='pending_confirmation',confirmation_telegram_message_id=(
        SELECT telegram_reply_message_id FROM support_replies WHERE id=confirmation_reply_id
      ),updated_at=? WHERE status='awaiting_confirmation_delivery' AND EXISTS (
        SELECT 1 FROM support_replies WHERE id=confirmation_reply_id AND status='replied'
          AND telegram_reply_message_id IS NOT NULL
      )`).run(now)
    deps.database.prepare(`UPDATE user_credential_reset_actions SET status='failed',result_code='confirmation_delivery_failed',
      safe_summary='确认消息未成功进入已发送状态',completed_at=?,updated_at=?
      WHERE status='awaiting_confirmation_delivery' AND EXISTS (
        SELECT 1 FROM support_replies WHERE id=confirmation_reply_id AND status IN ('failed','ignored','superseded')
      )`).run(now, now)
    deps.database.prepare(`UPDATE user_credential_reset_actions SET status='expired',result_code='confirmation_expired',
      safe_summary='确认已过期',completed_at=?,updated_at=?
      WHERE status='pending_confirmation' AND expires_at<=?`).run(now, now, now)
    deps.database.prepare(`UPDATE secret_message_deletions SET status='pending',due_at=?,updated_at=?
      WHERE status='deleting'`).run(now, now)
    this.recoverSecretDeletions(now)
  }

  private recoverSecretDeletions(now: string): void {
    this.deps.database.prepare(`INSERT OR IGNORE INTO secret_message_deletions(
      id,action_id,account_id,telegram_chat_id,telegram_message_id,status,due_at,attempt_count,created_at,updated_at
    ) SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||
        '-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
        action.id,ownership.account_id,ownership.telegram_chat_id,ownership.telegram_message_id,'pending',
        strftime('%Y-%m-%dT%H:%M:%fZ',julianday(ownership.created_at)+3.0/1440.0),0,?,?
      FROM telegram_output_ownership ownership
      JOIN user_credential_reset_actions action ON action.confirmation_reply_id=ownership.reply_id
      WHERE ownership.output_kind='user_credential_secret' AND ownership.delivery_status='sent'
        AND ownership.telegram_message_id IS NOT NULL
        AND ownership.account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM secret_message_deletions deletion WHERE deletion.action_id=action.id)`).run(now, now)
  }

  start(): void {
    if (this.deletionTimer) return
    this.deletionTimer = setInterval(() => { void this.processDeletions() }, 5_000)
    this.deletionTimer.unref()
    void this.processDeletions()
  }

  stop(): void {
    if (this.deletionTimer) clearInterval(this.deletionTimer)
    this.deletionTimer = null
  }

  async prepareConfirmation(input: {
    replyId: string
    thread: SupportThread
    inputRevision: number
    group: RuntimeGroup
    username: string
    resetPassword: boolean
    resetTotp: boolean
  }): Promise<string> {
    const username = input.username.trim()
    if (!validUsername(username) || (!input.resetPassword && !input.resetTotp)) throw new Error("客服账号重置参数不安全")
    if (username.toLocaleLowerCase("en-US") === "admin") throw new Error("受保护账号不允许通过群审批重置")
    if (!input.group.projectId || input.group.serviceId !== input.thread.serviceId) throw new Error("客服账号重置群绑定不一致")
    const projectId = input.group.projectId
    const databases = this.deps.database.readDatabaseResources(
      "WHERE service_id=? AND enabled=1 AND alias=?", [input.thread.serviceId, input.group.databaseAlias],
    )
    const servers = this.deps.database.readServerResources(
      "WHERE service_id=? AND enabled=1 ORDER BY created_at,id", [input.thread.serviceId],
    )
    const server = input.group.serverAlias
      ? servers.find((candidate) => candidate.alias === input.group.serverAlias)
      : servers.length === 1 ? servers[0] : undefined
    const database = databases.length === 1 ? databases[0] : undefined
    if (!server || !database) throw new Error("客服账号重置缺少唯一服务器或数据库绑定")
    const fingerprint = resourceFingerprint(server, database, input.group)
    const event = this.deps.database.prepare(`SELECT event.id,event.sender_user_id FROM support_thread_messages linked
      JOIN support_message_events event ON event.id=linked.message_event_id
      WHERE linked.thread_id=? ORDER BY event.created_at DESC,linked.position DESC LIMIT 1`).get(
      input.thread.id,
    ) as { id?: string; sender_user_id?: string } | undefined
    if (!event?.id || !event.sender_user_id) throw new Error("客服账号重置缺少原始申请人")
    const requestEventId = event.id
    const requesterUserId = event.sender_user_id
    const sources = this.deps.database.prepare(`SELECT event.safe_text FROM support_thread_messages linked
      JOIN support_message_events event ON event.id=linked.message_event_id
      WHERE linked.thread_id=? ORDER BY linked.position,event.created_at`).all(input.thread.id) as Array<{ safe_text: string }>
    if (!sources.some((source) => sourceContainsUsername(source.safe_text, username))) {
      throw new Error("客服账号重置目标没有出现在用户原始消息中")
    }
    const preflight = await this.executeRemote({
      mode: "inspect", serviceId: input.thread.serviceId, serverResourceId: server.id,
      databaseResourceId: database.id,
      username, resetPassword: input.resetPassword, resetTotp: input.resetTotp,
    })
    if (!preflight.ok || preflight.resultCode !== "eligible" || !preflight.sysUserId || !preflight.stateToken
      || preflight.userType !== "KF_YH" || preflight.delFlag !== 0) {
      throw new Error(`服务器侧客服账号重置预检未通过：${preflight.resultCode}`)
    }
    const sysUserId = preflight.sysUserId
    const stateToken = preflight.stateToken
    return this.deps.database.transaction(() => {
      const current = this.deps.database.prepare(
        "SELECT revision,status,group_id,service_id FROM support_threads WHERE id=?",
      ).get(input.thread.id) as { revision: number; status: string; group_id: string; service_id: string } | undefined
      if (!current || Number(current.revision) !== input.inputRevision || current.status === "closed"
        || current.group_id !== input.group.id || current.service_id !== input.thread.serviceId) {
        throw new Error("客服账号重置请求在预检期间已经变化")
      }
      const now = new Date().toISOString()
      this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status='superseded',
        result_code='superseded_by_new_revision',safe_summary='新版本已替代旧审批',completed_at=?,updated_at=?
        WHERE thread_id=? AND input_revision<? AND status IN ('awaiting_confirmation_delivery','pending_confirmation')`).run(
        now, now, input.thread.id, input.inputRevision,
      )
      const existing = this.deps.database.prepare(`SELECT * FROM user_credential_reset_actions
        WHERE thread_id=? AND input_revision=?`).get(input.thread.id, input.inputRevision) as CredentialResetActionRow | undefined
      if (existing) {
        if (existing.username !== username || existing.sys_user_id !== sysUserId
          || existing.state_token !== stateToken || existing.reset_password !== Number(input.resetPassword)
          || existing.reset_totp !== Number(input.resetTotp) || existing.requester_user_id !== requesterUserId
          || existing.server_resource_id !== server.id || existing.database_resource_id !== database.id
          || existing.resource_fingerprint !== fingerprint) {
          throw new Error("同一问题版本的客服账号重置目标不一致")
        }
        return existing.id
      }
      const id = randomUUID()
      this.deps.database.prepare(`INSERT INTO user_credential_reset_actions(
        id,thread_id,input_revision,group_id,project_id,service_id,server_resource_id,database_resource_id,request_message_event_id,
        confirmation_reply_id,username,sys_user_id,state_token,resource_fingerprint,reset_password,reset_totp,
        requester_user_id,preflight_checked_at,status,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_confirmation_delivery',?,?,?)`).run(
        id, input.thread.id, input.inputRevision, input.group.id, projectId, input.thread.serviceId,
        server.id, database.id, requestEventId, input.replyId, username, sysUserId, stateToken, fingerprint,
        Number(input.resetPassword), Number(input.resetTotp), requesterUserId, now,
        new Date(Date.now() + confirmationTtlMs).toISOString(), now, now,
      )
      return id
    })
  }

  confirmationDelivered(actionId: string, telegramMessageId: string): void {
    const now = new Date().toISOString()
    this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status='pending_confirmation',
      confirmation_telegram_message_id=?,expires_at=?,updated_at=?
      WHERE id=? AND status='awaiting_confirmation_delivery'`).run(
      telegramMessageId, new Date(Date.now() + confirmationTtlMs).toISOString(), now, actionId,
    )
  }

  confirmationDeliveryFailed(actionId: string, uncertain: boolean): void {
    const now = new Date().toISOString()
    this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status=?,result_code=?,safe_summary=?,
      completed_at=?,updated_at=? WHERE id=? AND status='awaiting_confirmation_delivery'`).run(
      uncertain ? "delivery_unknown" : "failed",
      uncertain ? "confirmation_delivery_unknown" : "confirmation_delivery_failed",
      uncertain ? "确认消息投递结果未知，禁止执行" : "确认消息发送失败",
      now, now, actionId,
    )
  }

  matchConfirmation(input: {
    group: RuntimeGroup
    text: string
    replyToMessageId: string | null
    hasAttachments: boolean
    now?: string
  }): UserCredentialResetConfirmationMatch | null {
    if (input.group.purpose !== "support" || !input.group.serviceId || input.hasAttachments) return null
    const normalized = normalizeConfirmation(input.text)
    const decision = affirmativeReplies.has(normalized) ? "approve" : negativeReplies.has(normalized) ? "reject" : null
    if (!decision) return null
    const now = input.now ?? new Date().toISOString()
    invalidateStaleAccountActions(this.deps.database, "user_credential_reset_actions", now)
    this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status='expired',result_code='confirmation_expired',
      safe_summary='确认已过期',completed_at=?,updated_at=?
      WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at<=?`).run(
      now, now, input.group.id, input.group.serviceId, now,
    )
    if (input.replyToMessageId) {
      const row = this.deps.database.prepare(`SELECT id FROM user_credential_reset_actions
        WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at>?
          AND confirmation_telegram_message_id=? LIMIT 2`).all(
        input.group.id, input.group.serviceId, now, input.replyToMessageId,
      ) as Array<{ id: string }>
      return row.length === 1 ? { actionId: row[0]!.id, decision } : null
    }
    const resets = this.deps.database.prepare(`SELECT id FROM user_credential_reset_actions
      WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at>? LIMIT 2`).all(
      input.group.id, input.group.serviceId, now,
    ) as Array<{ id: string }>
    const unfreezes = this.deps.database.prepare(`SELECT id FROM user_unfreeze_actions
      WHERE group_id=? AND service_id=? AND status='pending_confirmation' AND expires_at>? LIMIT 2`).all(
      input.group.id, input.group.serviceId, now,
    ) as Array<{ id: string }>
    return resets.length === 1 && unfreezes.length === 0 ? { actionId: resets[0]!.id, decision } : null
  }

  async handleConfirmation(match: UserCredentialResetConfirmationMatch, event: SupportMessageEvent): Promise<void> {
    invalidateStaleAccountActions(this.deps.database, "user_credential_reset_actions")
    const matchedAction = this.readAction(match.actionId)
    if (matchedAction.group_id !== event.groupId || !currentAccountAction(this.deps.database, matchedAction)) return
    if (match.decision === "reject") {
      const now = new Date().toISOString()
      const changed = this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status='cancelled',
        confirmer_message_event_id=?,confirmer_user_id=?,confirmer_username=?,result_code='cancelled',
        safe_summary='群成员取消重置',completed_at=?,updated_at=?
        WHERE id=? AND status='pending_confirmation' AND expires_at>?`).run(
        event.id, event.senderUserId, event.senderUsername, now, now, match.actionId, now,
      )
      if (Number(changed.changes) === 1) await this.sendGroupResult(this.readAction(match.actionId), event, "cancelled")
      return
    }
    const now = new Date().toISOString()
    const claimed = this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status='executing',
      confirmer_message_event_id=?,confirmer_user_id=?,confirmer_username=?,execution_started_at=?,updated_at=?
      WHERE id=? AND status='pending_confirmation' AND expires_at>?`).run(
      event.id, event.senderUserId, event.senderUsername, now, now, match.actionId, now,
    )
    if (Number(claimed.changes) !== 1) return
    const action = this.readAction(match.actionId)
    let material: ResetMaterial | null = null
    let result: RemoteCredentialResetResult
    try {
      material = await this.buildResetMaterial(action)
      result = await this.executeAction(action, material)
    } catch {
      result = { ok: false, resultCode: "execution_unknown" }
    }
    const remoteFailures = new Set([
      "not_found", "protected_user", "conflict", "binding_changed", "request_changed", "ambiguous",
      "target_mismatch", "deleted", "invalid_reset_material", "verification_failed", "database_error",
      "resource_binding_unavailable", "execution_unknown", "ssh_failed", "execution_timeout", "invalid_remote_result",
    ])
    let resultCode = result.ok === true && result.resultCode === "reset" ? "reset"
      : result.ok === false && remoteFailures.has(result.resultCode) ? result.resultCode : "execution_unknown"
    if (resultCode === "reset" && (result.sysUserId !== action.sys_user_id
      || result.passwordReset !== Boolean(action.reset_password)
      || result.totpReset !== Boolean(action.reset_totp))) {
      resultCode = "execution_unknown"
    }
    let passwordDeliveryStatus: string = action.reset_password ? "unknown" : "not_required"
    if (resultCode === "reset" && action.reset_password) {
      if (!material?.temporaryPassword) {
        resultCode = "execution_unknown"
      } else {
        passwordDeliveryStatus = await this.deliverTemporaryPassword(action, material.temporaryPassword)
        if (passwordDeliveryStatus !== "sent") resultCode = "reset_password_delivery_failed"
      }
    }
    const completed = new Date().toISOString()
    const succeeded = resultCode === "reset" || resultCode === "reset_password_delivery_failed"
    this.deps.database.prepare(`UPDATE user_credential_reset_actions SET status=?,result_code=?,password_delivery_status=?,
      safe_summary=?,completed_at=?,updated_at=? WHERE id=? AND status='executing'`).run(
      succeeded ? "succeeded" : ["execution_unknown", "ssh_failed", "execution_timeout"].includes(resultCode)
        ? "execution_unknown" : "failed",
      resultCode, passwordDeliveryStatus, resultMessage(action, resultCode), completed, completed, action.id,
    )
    await this.sendGroupResult(action, event, resultCode)
  }

  private readAction(id: string): CredentialResetActionRow {
    const action = this.deps.database.prepare("SELECT * FROM user_credential_reset_actions WHERE id=?").get(id) as
      CredentialResetActionRow | undefined
    if (!action) throw new Error("客服账号重置审批不存在")
    return action
  }

  private async buildResetMaterial(action: CredentialResetActionRow): Promise<ResetMaterial> {
    const password = action.reset_password ? temporaryPassword() : null
    const passwordSalt = password ? secureString(8, saltAlphabet) : null
    return {
      temporaryPassword: password,
      passwordHash: password && passwordSalt
        ? await encryptLegacySysUserPassword(action.username, password, passwordSalt)
        : null,
      passwordSalt,
      totpSecret: action.reset_totp ? totpSecret() : null,
    }
  }

  private async executeAction(
    action: CredentialResetActionRow,
    material: ResetMaterial,
  ): Promise<RemoteCredentialResetResult> {
    if (!currentAccountAction(this.deps.database, action)) return { ok: false, resultCode: "request_changed" }
    if (!this.deps.database.readProjects("WHERE id=? AND enabled=1", [action.project_id])[0]) return { ok: false, resultCode: "binding_changed" }
    const group = boundAccountActionGroup(this.deps.database, action, resourceFingerprint)
    if (!group?.enabled || group.projectId !== action.project_id || group.serviceId !== action.service_id
      || !validUsername(action.username)) return { ok: false, resultCode: "binding_changed" }
    if (!this.deps.database.readProjectServices("WHERE id=? AND project_id=? AND enabled=1", [action.service_id, action.project_id])[0]) {
      return { ok: false, resultCode: "binding_changed" }
    }
    const servers = this.deps.database.readServerResources(
      "WHERE service_id=? AND enabled=1 ORDER BY created_at,id", [action.service_id],
    )
    const databases = this.deps.database.readDatabaseResources(
      "WHERE service_id=? AND enabled=1 AND alias=?", [action.service_id, group.databaseAlias],
    )
    const server = group.serverAlias
      ? servers.find((candidate) => candidate.alias === group.serverAlias)
      : servers.length === 1 ? servers[0] : undefined
    const database = databases.length === 1 ? databases[0] : undefined
    if (!server || !database || server.id !== action.server_resource_id
      || database.id !== action.database_resource_id
      || resourceFingerprint(server, database, group) !== action.resource_fingerprint) {
      return { ok: false, resultCode: "binding_changed" }
    }
    return this.executeRemote({
      mode: "reset", serviceId: action.service_id, serverResourceId: action.server_resource_id,
      databaseResourceId: action.database_resource_id,
      username: action.username, sysUserId: action.sys_user_id, stateToken: action.state_token,
      operationId: action.id, resetPassword: Boolean(action.reset_password), resetTotp: Boolean(action.reset_totp),
      ...(material.passwordHash ? { passwordHash: material.passwordHash } : {}),
      ...(material.passwordSalt ? { passwordSalt: material.passwordSalt } : {}),
      ...(material.totpSecret ? { totpSecret: material.totpSecret } : {}),
    })
  }

  private async executeRemote(input: Parameters<CredentialResetExecutor>[0]): Promise<RemoteCredentialResetResult> {
    if (this.deps.executor) return this.deps.executor(input)
    const workspace = await this.deps.resourceWorkspace.open(input.serviceId, null)
    try {
      const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as ResourceManifest
      const server = manifest.servers.find((candidate) => candidate.id === input.serverResourceId)
      const database = manifest.databases.find((candidate) => candidate.id === input.databaseResourceId)
      if (!server || !database) return { ok: false, resultCode: "resource_binding_unavailable" }
      const payload = Buffer.from(JSON.stringify({
        ...input,
        host: database.host,
        port: database.port,
        database: database.database,
        databaseUsername: database.username,
        databasePassword: database.password,
      }), "utf8").toString("base64")
      return await this.runRemote(workspace.path, manifest.sshConfigPath, server.sshAlias, payload)
    } finally {
      await workspace.cleanup()
    }
  }

  private runRemote(cwd: string, sshConfigPath: string, sshAlias: string, payload: string): Promise<RemoteCredentialResetResult> {
    const program = [
      "import base64,hashlib,json,re,sys",
      "connection=None",
      "try:",
      " import pymysql",
      ` payload=json.loads(base64.b64decode(${JSON.stringify(payload)}).decode('utf-8'))`,
      " connection=pymysql.connect(host=payload['host'],port=int(payload['port']),user=payload['databaseUsername'],password=payload['databasePassword'],database=payload['database'],charset='utf8mb4',connect_timeout=8,read_timeout=20,write_timeout=20,autocommit=False,cursorclass=pymysql.cursors.DictCursor)",
      " def scalar(value):",
      "  if value is None: return ''",
      "  if hasattr(value,'isoformat'): return value.isoformat(sep=' ')",
      "  return str(value)",
      " def token(row):",
      "  values=[scalar(row.get(name)) for name in ('id','username','user_type','status','del_flag','password','salt','totp','first_login_flag','update_time')]",
      "  return hashlib.sha256(json.dumps(values,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()",
      " with connection.cursor() as cursor:",
      "  columns='id,username,user_type,status,del_flag,password,salt,totp,first_login_flag,update_time'",
      "  if payload['mode']=='inspect': cursor.execute('SELECT '+columns+' FROM sys_user WHERE username=%s LIMIT 2',(payload['username'],))",
      "  else: cursor.execute('SELECT '+columns+' FROM sys_user WHERE id=%s AND username=%s LIMIT 2 FOR UPDATE',(payload['sysUserId'],payload['username']))",
      "  rows=cursor.fetchall()",
      "  if len(rows)==0: result={'ok':False,'resultCode':'not_found'}",
      "  elif len(rows)>1: result={'ok':False,'resultCode':'ambiguous'}",
      "  else:",
      "   row=rows[0]; username=str(row.get('username') or ''); user_type=str(row.get('user_type') or '')",
      "   status=int(row['status']) if row.get('status') is not None else None; deleted=int(row['del_flag']) if row['del_flag'] is not None else None",
      "   if username!=payload['username']: result={'ok':False,'resultCode':'target_mismatch'}",
      "   elif username.lower()=='admin' or user_type!='KF_YH': result={'ok':False,'resultCode':'protected_user'}",
      "   elif deleted!=0: result={'ok':False,'resultCode':'deleted'}",
      "   elif payload['mode']=='inspect': result={'ok':True,'resultCode':'eligible','sysUserId':str(row['id']),'stateToken':token(row),'userType':user_type,'status':status,'delFlag':deleted}",
      "   elif token(row)!=payload.get('stateToken'): result={'ok':False,'resultCode':'conflict'}",
      "   else:",
      "    reset_password=bool(payload.get('resetPassword')); reset_totp=bool(payload.get('resetTotp'))",
      "    password_hash=str(payload.get('passwordHash') or ''); password_salt=str(payload.get('passwordSalt') or ''); new_totp=str(payload.get('totpSecret') or '')",
      "    password_valid=(not reset_password) or (re.fullmatch(r'[a-f0-9]+',password_hash) is not None and len(password_hash)%16==0 and re.fullmatch(r'[A-Za-z0-9]{8}',password_salt) is not None)",
      "    totp_valid=(not reset_totp) or re.fullmatch(r'[A-Z2-7]{32}',new_totp) is not None",
      "    if not (reset_password or reset_totp) or not password_valid or not totp_valid: result={'ok':False,'resultCode':'invalid_reset_material'}",
      "    else:",
      "     assignments=[]; parameters=[]",
      "     if reset_password: assignments.extend(['password=%s','salt=%s']); parameters.extend([password_hash,password_salt])",
      "     if reset_totp: assignments.append('totp=%s'); parameters.append(new_totp)",
      "     assignments.append('first_login_flag=%s'); parameters.append(1)",
      "     parameters.extend([row['id'],username,'KF_YH',0])",
      "     cursor.execute('UPDATE sys_user SET '+','.join(assignments)+' WHERE id=%s AND username=%s AND user_type=%s AND del_flag=%s',tuple(parameters))",
      "     affected=int(cursor.rowcount)",
      "     if affected!=1: result={'ok':False,'resultCode':'conflict'}",
      "     else:",
      "      cursor.execute('SELECT password,salt,totp,first_login_flag FROM sys_user WHERE id=%s AND username=%s',(row['id'],username)); checked=cursor.fetchone()",
      "      verified=bool(checked) and int(checked.get('first_login_flag') or 0)==1 and ((not reset_password) or (str(checked.get('password') or '')==password_hash and str(checked.get('salt') or '')==password_salt)) and ((not reset_totp) or str(checked.get('totp') or '')==new_totp)",
      "      result={'ok':verified,'resultCode':'reset' if verified else 'verification_failed','sysUserId':str(row['id']),'passwordReset':reset_password,'totpReset':reset_totp}",
      " if result.get('resultCode')=='reset': connection.commit()",
      " else: connection.rollback()",
      " print(json.dumps(result,ensure_ascii=False,separators=(',',':')))",
      "except Exception as error:",
      " if connection:",
      "  try: connection.rollback()",
      "  except Exception: pass",
      " print(json.dumps({'ok':False,'resultCode':'database_error','errorType':type(error).__name__},separators=(',',':'))); sys.exit(1)",
      "finally:",
      " if connection:",
      "  try: connection.close()",
      "  except Exception: pass",
    ].join("\n")
    return new Promise((resolve) => {
      const child = spawn("ssh", ["-F", sshConfigPath, "--", sshAlias, "timeout", "35s", "python3", "-"], {
        cwd, stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: RemoteCredentialResetResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 16_384) stdout += chunk.toString("utf8") })
      child.once("error", () => finish({ ok: false, resultCode: "ssh_failed" }))
      child.once("close", () => {
        try {
          const parsed = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "") as RemoteCredentialResetResult
          finish(typeof parsed.ok === "boolean" && typeof parsed.resultCode === "string"
            ? parsed : { ok: false, resultCode: "invalid_remote_result" })
        } catch { finish({ ok: false, resultCode: "invalid_remote_result" }) }
      })
      child.stdin.end(program)
      timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, resultCode: "execution_timeout" }) }, 40_000)
      timer.unref()
    })
  }

  private async deliverTemporaryPassword(action: CredentialResetActionRow, temporaryPassword: string): Promise<string> {
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,64}$/u.test(temporaryPassword)) return "unknown"
    const group = boundAccountActionGroup(this.deps.database, action, resourceFingerprint)
    if (!group?.accountId || !group.telegramChatId) return "failed"
    const text = `账号 ${action.username} 的临时密码：${temporaryPassword}\n登录后请立即在右上角修改密码。为减少泄露，这条消息会在 3 分钟后删除。`
    try {
      const messageId = await this.deps.transport.sendMessage(
        group.accountId, group.telegramChatId, text, undefined, null,
        { groupId: group.id, serviceId: action.service_id, replyId: action.confirmation_reply_id, kind: "user_credential_secret" },
      )
      const now = new Date().toISOString()
      this.deps.database.prepare(`INSERT OR IGNORE INTO secret_message_deletions(
        id,action_id,account_id,telegram_chat_id,telegram_message_id,status,due_at,attempt_count,created_at,updated_at
      ) VALUES(?,?,?,?,?,'pending',?,0,?,?)`).run(
        randomUUID(), action.id, group.accountId, group.telegramChatId, messageId,
        new Date(Date.now() + secretDeleteDelayMs).toISOString(), now, now,
      )
      return "sent"
    } catch (error) {
      return error instanceof TelegramDeliveryError && error.state === "uncertain" ? "unknown" : "failed"
    }
  }

  private async sendGroupResult(action: CredentialResetActionRow, event: SupportMessageEvent, resultCode: string): Promise<void> {
    const group = boundAccountActionGroup(this.deps.database, action, resourceFingerprint)
    const service = this.deps.database.readProjectServices("WHERE id=?", [action.service_id])[0]
    if (!group?.enabled || !group.telegramChatId || !service) return
    const answer = resultMessage(action, resultCode)
    const safe = this.deps.redactor.assertSafeOutbound(answer)
    if (!safe.allowed || safe.safeText !== answer) throw new Error("客服账号重置结果未通过出站检查")
    const reply = this.deps.replies.createPending({
      threadId: null, inputRevision: null, groupId: group.id, accountId: group.accountId,
      projectId: action.project_id, serviceId: action.service_id, telegramMessageId: event.telegramMessageId,
      senderUserId: event.senderUserId, senderUsername: event.senderUsername,
      senderDisplayName: event.senderDisplayName, senderRole: event.senderRole,
      service: service.key, serviceSource: "group_binding", question: event.safeText || "确认重置客服账号",
    })
    this.deps.replies.transition(reply.id, "generating")
    const sending = this.deps.replies.claimUnthreadedSending(reply.id, {
      answer, decisionReason: `客服账号重置结果：${resultCode}`, decisionConfidence: 1,
    })
    if (!sending) return
    try {
      const messageId = await this.deps.transport.sendMessage(
        group.accountId, group.telegramChatId, answer, event.telegramMessageId, null,
        { groupId: group.id, serviceId: action.service_id, replyId: reply.id, kind: "user_credential_reset_result" },
      )
      this.deps.replies.transition(reply.id, "replied", { telegramReplyMessageId: messageId })
    } catch (error) {
      this.deps.replies.transition(reply.id, "failed", {
        errorCode: "user_credential_reset_result_delivery_failed",
        decisionReason: "客服账号重置结果发送失败",
        operatorDeliveryStatus: error instanceof TelegramDeliveryError && error.state === "uncertain" ? "uncertain" : "failed",
      })
    }
  }

  private async processDeletions(): Promise<void> {
    if (this.deletionRunning) return
    this.deletionRunning = true
    try {
      const now = new Date().toISOString()
      this.recoverSecretDeletions(now)
      const row = this.deps.database.prepare(`SELECT * FROM secret_message_deletions
        WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1`).get(now) as {
          id: string; account_id: string; telegram_chat_id: string; telegram_message_id: string; attempt_count: number
        } | undefined
      if (!row) return
      const claimed = this.deps.database.prepare(`UPDATE secret_message_deletions SET status='deleting',
        attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='pending'`).run(now, row.id)
      if (Number(claimed.changes) !== 1) return
      try {
        await this.deps.transport.deleteMessage(row.account_id, row.telegram_chat_id, row.telegram_message_id)
        this.deps.database.prepare(`UPDATE secret_message_deletions SET status='deleted',last_error_code=NULL,updated_at=?
          WHERE id=? AND status='deleting'`).run(new Date().toISOString(), row.id)
      } catch (error) {
        const attempts = Number(row.attempt_count) + 1
        const retry = attempts < 5
        this.deps.database.prepare(`UPDATE secret_message_deletions SET status=?,due_at=?,last_error_code=?,updated_at=?
          WHERE id=? AND status='deleting'`).run(
          retry ? "pending" : "failed", new Date(Date.now() + Math.min(attempts, 4) * 30_000).toISOString(),
          error instanceof TelegramDeliveryError ? error.type : "delete_failed", new Date().toISOString(), row.id,
        )
      }
    } finally {
      this.deletionRunning = false
    }
  }
}
