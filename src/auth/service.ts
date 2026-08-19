import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"

import { z } from "zod"

import type { RuntimeDatabase } from "../runtime/database.js"
import type { LocalSecretVault } from "../runtime/secret-vault.js"
import { menuKeys, type AuthPrincipal, type MenuKey } from "./types.js"

type SqlRow = Record<string, unknown>
function derivePassword(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}
const tokenLifetimeSeconds = 12 * 60 * 60
const tokenSchema = z.object({
  userId: z.string().uuid(),
  authVersion: z.number().int().positive(),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict()

type LoginBucket = { failures: number[]; lockedUntil: number }

export type AccessRoleView = { id: string; name: string; menus: MenuKey[]; menusEditable: boolean }
export type AccessUserView = {
  id: string
  username: string
  enabled: boolean
  roleIds: string[]
  createdAt: string
  updatedAt: string
}
export type AccessControlView = { currentUserId: string; users: AccessUserView[]; roles: AccessRoleView[] }
export type CreateAccessUserInput = { username: string; password: string; roleId: string; enabled: boolean }
export type UpdateAccessUserInput = {
  username?: string | undefined
  password?: string | undefined
  roleId?: string | undefined
  enabled?: boolean | undefined
}
export type UpdateAccessRoleInput = { name: string; menus: MenuKey[] }

export class LoginThrottledError extends Error {}

export class AdminAuthService {
  private readonly buckets = new Map<string, LoginBucket>()
  private activePasswordChecks = 0

  constructor(
    private readonly database: RuntimeDatabase,
    private readonly vault: LocalSecretVault,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async login(usernameInput: unknown, passwordInput: unknown, remoteAddress: string): Promise<{ principal: AuthPrincipal; token: string }> {
    const username = z.string().trim().min(1).max(80).parse(usernameInput).toLocaleLowerCase("en-US")
    const password = z.string().min(1).max(1024).parse(passwordInput)
    const keys = [`ip:${remoteAddress}`, `user:${username}`]
    this.assertAttemptAllowed(keys)
    if (this.activePasswordChecks >= 4) throw new LoginThrottledError("登录请求过多")
    this.activePasswordChecks += 1
    try {
      const row = this.database.prepare(`SELECT id,username,password_hash,password_salt,password_cost,enabled,auth_version
        FROM admin_users WHERE username=? COLLATE NOCASE`).get(username) as SqlRow | undefined
      const salt = String(row?.password_salt ?? "BbQicl6cISpfLdCWlFJddA")
      const cost = Number(row?.password_cost ?? 16384)
      const derived = await derivePassword(password, Buffer.from(salt, "base64url"), cost)
      const expected = Buffer.from(String(row?.password_hash ?? "71FbesRBIOWOKT330xvtE46PKwwmkX6Zi83n6bfZ35BepucrMY9gmyoYiFkBh0o8C1jj9y1XQe4S8CfKmzpQ5g"), "base64url")
      const valid = expected.length === derived.length && timingSafeEqual(expected, derived) && Number(row?.enabled ?? 0) === 1
      if (!row || !valid) {
        this.recordFailure(keys)
        throw new Error("账号或密码错误")
      }
      keys.forEach((key) => this.buckets.delete(key))
      const csrfToken = randomBytes(32).toString("base64url")
      const principal = this.loadPrincipal(String(row.id), csrfToken)
      const token = this.issueToken(principal)
      return { principal, token }
    } finally {
      this.activePasswordChecks -= 1
    }
  }

  authenticate(token: string | undefined): AuthPrincipal | null {
    if (!token) return null
    const parts = token.split(".")
    if (parts.length !== 2) return null
    const [payload, signature] = parts
    if (!payload || !signature) return null
    const expected = this.vault.mac("admin-session-v1", payload)
    let received: Buffer
    try { received = Buffer.from(signature, "base64url") } catch { return null }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
    try {
      const parsed = tokenSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
      const currentSeconds = Math.floor(this.now() / 1000)
      if (parsed.expiresAt <= currentSeconds || parsed.issuedAt > currentSeconds + 60) return null
      const principal = this.loadPrincipal(parsed.userId, parsed.csrfToken)
      return principal.authVersion === parsed.authVersion ? principal : null
    } catch {
      return null
    }
  }

  invalidateSessions(userId: string, authVersion: number): void {
    this.database.prepare(`UPDATE admin_users SET auth_version=auth_version+1,updated_at=?
      WHERE id=? AND auth_version=?`).run(new Date(this.now()).toISOString(), userId, authVersion)
  }

  accessControl(currentUserId: string): AccessControlView {
    const roles = (this.database.prepare("SELECT id,name,is_super_admin FROM admin_roles ORDER BY is_super_admin DESC,created_at,id").all() as SqlRow[])
      .map((role) => ({
        id: String(role.id),
        name: String(role.name),
        menus: menuKeys.filter((menu) => Boolean(this.database.prepare(
          "SELECT 1 FROM admin_role_menus WHERE role_id=? AND menu_key=?",
        ).get(String(role.id), menu))),
        menusEditable: Number(role.is_super_admin) !== 1,
      }))
    const users = (this.database.prepare(`SELECT id,username,enabled,created_at,updated_at
      FROM admin_users ORDER BY created_at,id`).all() as SqlRow[]).map((user) => ({
      id: String(user.id),
      username: String(user.username),
      enabled: Number(user.enabled) === 1,
      roleIds: (this.database.prepare("SELECT role_id FROM admin_user_roles WHERE user_id=? ORDER BY created_at,role_id")
        .all(String(user.id)) as SqlRow[]).map((assignment) => String(assignment.role_id)),
      createdAt: String(user.created_at),
      updatedAt: String(user.updated_at),
    }))
    return { currentUserId, users, roles }
  }

  async createAccessUser(input: CreateAccessUserInput): Promise<AccessUserView> {
    this.requireRole(input.roleId)
    const id = randomUUID()
    const username = input.username.trim().toLocaleLowerCase("en-US")
    const salt = randomBytes(16)
    const cost = 16384
    const passwordHash = await derivePassword(input.password, salt, cost)
    const now = new Date(this.now()).toISOString()
    try {
      this.database.transaction(() => {
        this.database.prepare(`INSERT INTO admin_users(
          id,username,password_hash,password_salt,password_cost,enabled,auth_version,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,1,?,?)`).run(
          id, username, passwordHash.toString("base64url"), salt.toString("base64url"), cost, input.enabled ? 1 : 0, now, now,
        )
        this.database.prepare("INSERT INTO admin_user_roles(user_id,role_id,created_at) VALUES(?,?,?)").run(id, input.roleId, now)
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes("admin_users.username")) throw new Error("账号已存在")
      throw error
    }
    return this.requireAccessUser(id)
  }

  async updateAccessUser(id: string, input: UpdateAccessUserInput, currentUserId: string): Promise<AccessUserView> {
    const current = this.requireAccessUser(id)
    if (input.roleId) this.requireRole(input.roleId)
    const nextRoleIds = input.roleId ? [input.roleId] : current.roleIds
    const nextEnabled = input.enabled ?? current.enabled
    if (this.isSuperRoleAssignment(current.roleIds) && (!nextEnabled || !this.isSuperRoleAssignment(nextRoleIds))) {
      this.assertAnotherEnabledSuper(id)
    }
    if (id === currentUserId && !nextEnabled) throw new Error("不能停用当前登录账号")
    const username = input.username?.trim().toLocaleLowerCase("en-US")
    const now = new Date(this.now()).toISOString()
    let passwordHash: Buffer | null = null
    let passwordSalt: Buffer | null = null
    const cost = 16384
    if (input.password) {
      passwordSalt = randomBytes(16)
      passwordHash = await derivePassword(input.password, passwordSalt, cost)
    }
    try {
      this.database.transaction(() => {
        this.database.prepare(`UPDATE admin_users SET
          username=COALESCE(?,username),enabled=?,auth_version=auth_version+1,
          password_hash=COALESCE(?,password_hash),password_salt=COALESCE(?,password_salt),
          password_cost=CASE WHEN ? IS NULL THEN password_cost ELSE ? END,updated_at=? WHERE id=?`).run(
          username ?? null,
          nextEnabled ? 1 : 0,
          passwordHash?.toString("base64url") ?? null,
          passwordSalt?.toString("base64url") ?? null,
          passwordHash?.toString("base64url") ?? null,
          cost,
          now,
          id,
        )
        if (input.roleId) {
          this.database.prepare("DELETE FROM admin_user_roles WHERE user_id=?").run(id)
          this.database.prepare("INSERT INTO admin_user_roles(user_id,role_id,created_at) VALUES(?,?,?)").run(id, input.roleId, now)
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes("admin_users.username")) throw new Error("账号已存在")
      throw error
    }
    return this.requireAccessUser(id)
  }

  updateAccessRole(id: string, input: UpdateAccessRoleInput): AccessRoleView {
    const current = this.requireAccessRole(id)
    const nextMenus = current.menusEditable ? menuKeys.filter((menu) => input.menus.includes(menu)) : [...menuKeys]
    if (nextMenus.length === 0) throw new Error("角色至少保留一个菜单")
    const menusChanged = current.menus.join(",") !== nextMenus.join(",")
    const now = new Date(this.now()).toISOString()
    this.database.transaction(() => {
      this.database.prepare("UPDATE admin_roles SET name=?,updated_at=? WHERE id=?").run(input.name.trim(), now, id)
      if (menusChanged) {
        this.database.prepare("DELETE FROM admin_role_menus WHERE role_id=?").run(id)
        const insert = this.database.prepare("INSERT INTO admin_role_menus(role_id,menu_key,created_at) VALUES(?,?,?)")
        nextMenus.forEach((menu) => insert.run(id, menu, now))
        this.database.prepare(`UPDATE admin_users SET auth_version=auth_version+1,updated_at=? WHERE id IN (
          SELECT user_id FROM admin_user_roles WHERE role_id=?
        )`).run(now, id)
      }
    })
    return this.requireAccessRole(id)
  }

  private requireAccessUser(id: string): AccessUserView {
    const row = this.database.prepare(`SELECT id,username,enabled,created_at,updated_at
      FROM admin_users WHERE id=?`).get(id) as SqlRow | undefined
    if (!row) throw new Error("账号不存在")
    return {
      id: String(row.id),
      username: String(row.username),
      enabled: Number(row.enabled) === 1,
      roleIds: (this.database.prepare("SELECT role_id FROM admin_user_roles WHERE user_id=? ORDER BY created_at,role_id")
        .all(id) as SqlRow[]).map((assignment) => String(assignment.role_id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private requireRole(id: string): void {
    if (!this.database.prepare("SELECT 1 FROM admin_roles WHERE id=?").get(id)) throw new Error("权限方案不存在")
  }

  private requireAccessRole(id: string): AccessRoleView {
    const row = this.database.prepare("SELECT id,name,is_super_admin FROM admin_roles WHERE id=?").get(id) as SqlRow | undefined
    if (!row) throw new Error("权限方案不存在")
    return {
      id: String(row.id),
      name: String(row.name),
      menus: menuKeys.filter((menu) => Boolean(this.database.prepare(
        "SELECT 1 FROM admin_role_menus WHERE role_id=? AND menu_key=?",
      ).get(id, menu))),
      menusEditable: Number(row.is_super_admin) !== 1,
    }
  }

  private isSuperRoleAssignment(roleIds: string[]): boolean {
    return roleIds.some((roleId) => Boolean(this.database.prepare(
      "SELECT 1 FROM admin_roles WHERE id=? AND is_super_admin=1",
    ).get(roleId)))
  }

  private assertAnotherEnabledSuper(excludedUserId: string): void {
    const other = this.database.prepare(`SELECT 1 FROM admin_users user
      WHERE user.enabled=1 AND user.id<>? AND EXISTS (
        SELECT 1 FROM admin_user_roles assignment JOIN admin_roles role ON role.id=assignment.role_id
        WHERE assignment.user_id=user.id AND role.is_super_admin=1
      ) LIMIT 1`).get(excludedUserId)
    if (!other) throw new Error("至少保留一个可用的全部功能账号")
  }

  private loadPrincipal(userId: string, csrfToken: string): AuthPrincipal {
    const user = this.database.prepare(`SELECT id,username,enabled,auth_version FROM admin_users WHERE id=?`).get(userId) as SqlRow | undefined
    if (!user || Number(user.enabled) !== 1) throw new Error("未登录")
    const rows = this.database.prepare(`SELECT role.is_super_admin,menu.menu_key
      FROM admin_user_roles assignment
      JOIN admin_roles role ON role.id=assignment.role_id
      LEFT JOIN admin_role_menus menu ON menu.role_id=role.id
      WHERE assignment.user_id=?`).all(userId) as SqlRow[]
    const menus = menuKeys.filter((menu) => rows.some((row) => row.menu_key === menu))
    if (menus.length === 0) throw new Error("未分配可用菜单")
    return {
      userId: String(user.id),
      username: String(user.username),
      authVersion: Number(user.auth_version),
      menus,
      isSuperAdmin: rows.some((row) => Number(row.is_super_admin) === 1),
      csrfToken,
    }
  }

  private issueToken(principal: AuthPrincipal): string {
    const issuedAt = Math.floor(this.now() / 1000)
    const payload = Buffer.from(JSON.stringify({
      userId: principal.userId,
      authVersion: principal.authVersion,
      csrfToken: principal.csrfToken,
      issuedAt,
      expiresAt: issuedAt + tokenLifetimeSeconds,
    }), "utf8").toString("base64url")
    return `${payload}.${this.vault.mac("admin-session-v1", payload).toString("base64url")}`
  }

  private assertAttemptAllowed(keys: string[]): void {
    const now = this.now()
    this.cleanupBuckets(now)
    if (keys.some((key) => (this.buckets.get(key)?.lockedUntil ?? 0) > now)) {
      throw new LoginThrottledError("登录请求过多")
    }
  }

  private recordFailure(keys: string[]): void {
    const now = this.now()
    const cutoff = now - 10 * 60 * 1000
    keys.forEach((key) => {
      const bucket = this.buckets.get(key) ?? { failures: [], lockedUntil: 0 }
      bucket.failures = bucket.failures.filter((timestamp) => timestamp >= cutoff)
      bucket.failures.push(now)
      const threshold = key.startsWith("user:") ? 5 : 20
      if (bucket.failures.length >= threshold) bucket.lockedUntil = now + 15 * 60 * 1000
      this.buckets.set(key, bucket)
    })
  }

  private cleanupBuckets(now: number): void {
    const cutoff = now - 30 * 60 * 1000
    for (const [key, bucket] of this.buckets) {
      bucket.failures = bucket.failures.filter((timestamp) => timestamp >= cutoff)
      if (bucket.failures.length === 0 && bucket.lockedUntil <= now) this.buckets.delete(key)
    }
    if (this.buckets.size <= 20_000) return
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key)
      if (this.buckets.size <= 10_000) break
    }
  }
}

export function menuForApi(method: string, pathname: string): MenuKey | "chat-or-replies" | null {
  if (pathname.startsWith("/api/access-control")) return "access"
  if (pathname.startsWith("/api/admin-chat/")) return "chat"
  if (pathname === "/api/replies/events") return "chat-or-replies"
  if (pathname.startsWith("/api/telegram/") || pathname === "/api/groups") return "connections"
  if (pathname.startsWith("/api/project") || pathname.startsWith("/api/diagnostics/")) return "projects"
  if (pathname.startsWith("/api/replies") || pathname.startsWith("/api/support-threads")) return "replies"
  if (pathname.startsWith("/api/memories") || pathname.startsWith("/api/memory-events")
    || pathname.startsWith("/api/learning-observations") || pathname.startsWith("/api/learning-reports")
    || pathname.startsWith("/api/operator-style-versions")
    || pathname.startsWith("/api/directives")) return "memories"
  if (pathname.startsWith("/api/interface-docs") || pathname.startsWith("/api/magicbook")) return "docs"
  if (pathname.startsWith("/api/model")) return "models"
  if (pathname.startsWith("/api/runtime")) return "runtime"
  if (pathname.startsWith("/api/transfer")) return "transfer"
  if (pathname.startsWith("/api/security")) return "settings"
  return method === "GET" ? "overview" : null
}
