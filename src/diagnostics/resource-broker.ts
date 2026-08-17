import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createConnection } from "mysql2/promise"

import { NodeCommandRunner } from "../git-sync/command-runner.js"
import type { RuntimeDatabase } from "../runtime/database.js"
import { ConfiguredSecretRedactor, isSensitiveDlpFieldName, redactText } from "../security/dlp.js"
import { sshTargetArguments } from "../security/ssh-target.js"
import { assertDatabaseScope, boundedReadonlySql, serverCheckCommand, type ServerCheck } from "./read-only-policy.js"
import { prepareVerifiedDatabaseQuery } from "./verified-database-query.js"

export type ServerCheckResult = { exitCode: number; stdout: string; stderr: string }
export type DatabaseQueryResult = { columns: string[]; rows: unknown[]; truncated: boolean }
export type VerifiedDatabaseQueryRequest = {
  databaseAlias: string
  serverAlias: string | null
  sql: string
  rowLimit: number
}

const sensitiveColumn = /(?:pass|pwd|secret|token|key|sign|session|credential|auth|private|md5|card|bank.*account|account.*(?:number|no)|phone|mobile|email|name|url|ip|merchant|mch|shbh)/i
const opaqueContainerColumn = /^(?:value|content|config|data|payload|params|request|response|remark|extra)$/i
const allowedBusinessColumn = /^(?:id|[a-z0-9_]*(?:_id|status|state|type|code|currency|amount|fee|rate|count|total|enabled|created_at|updated_at|deleted_at|finished_at|started_at|timestamp|datetime|date|time)|xtddh|shddh|ddh|shbh|ddzt|ddje|sjje|tdbh|tdmc|tdlx|jyzt|clzt|cjsj|gxsj|wcsj|zfsj|hdsj|region|timezone|branch|platform|service)$/i
const verifiedMetadataColumn = /^(?:Field|Type|Null|Key|Extra|Table|Non_unique|Key_name|Seq_in_index|Column_name|Collation|Cardinality|Sub_part|Packed|Index_type|Comment|Index_comment|Visible|Expression|id|select_type|partitions|type|possible_keys|key_len|ref|rows|filtered)$/i
const logPayloadColumn = /^(?:content|request|request_body|request_params|response|response_body|params|payload|message|remark|request_content|response_content|req_data|res_data|callback_content|callback_data)$/i

export function isSensitiveDatabaseColumn(column: string): boolean {
  return isSensitiveDlpFieldName(column) || sensitiveColumn.test(column)
}

export function isAllowedVerifiedMetadataColumn(column: string): boolean {
  return verifiedMetadataColumn.test(column)
}

export function sanitizeDatabaseLogPayload(
  value: unknown,
  redact: (input: string) => string = (input) => redactText(input).text,
): unknown {
  const sanitize = (current: unknown, depth: number): unknown => {
    if (depth > 6) return "[已截断]"
    if (typeof current === "string") {
      const bounded = current.slice(0, 20_000)
      if (/^\s*[\[{]/u.test(bounded)) {
        try { return JSON.stringify(sanitize(JSON.parse(bounded), depth + 1)).slice(0, 2000) }
        catch { /* 非完整 JSON 继续按普通文本强制脱敏。 */ }
      }
      return redact(bounded).slice(0, 2000)
    }
    if (Array.isArray(current)) return current.slice(0, 50).map((item) => sanitize(item, depth + 1))
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).slice(0, 100).map(([key, item]) => (
        [key, isSensitiveDatabaseColumn(key) ? "[已脱敏]" : sanitize(item, depth + 1)]
      )))
    }
    return typeof current === "number" || typeof current === "boolean" || current === null ? current : String(current)
  }
  return sanitize(value, 0)
}

function runWithInput(command: string, args: string[], input: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Codex 执行已取消"))
      return
    }
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let aborted = false
    let forceKill: ReturnType<typeof setTimeout> | null = null
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* 子进程已经退出。 */ }
    }
    const timer = setTimeout(() => {
      terminate("SIGTERM")
      forceKill = setTimeout(() => terminate("SIGKILL"), 1500)
      forceKill.unref()
    }, timeoutMs)
    timer.unref()
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKill) clearTimeout(forceKill)
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => {
      aborted = true
      terminate("SIGKILL")
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 256_000) stdout += chunk.slice(0, 256_000 - stdout.length)
    })
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk.slice(0, 16_000 - stderr.length)
    })
    child.once("error", () => {
      finish(() => reject(new Error(aborted ? "Codex 执行已取消" : "数据库只读复核命令不可用")))
    })
    child.once("close", (code) => {
      finish(() => aborted
        ? reject(new Error("Codex 执行已取消"))
        : resolve({ exitCode: code ?? 1, stdout, stderr }))
    })
    child.stdin.on("error", () => {
      /* SSH 提前退出时可能触发 EPIPE，最终状态统一由 error/close 处理。 */
    })
    child.stdin.end(input, "utf8")
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Codex 执行已取消")
}

function verifiedQueryProgram(payload: string): string {
  return [
    "import base64,json,sys",
    "try:",
    " import pymysql",
    ` payload=json.loads(base64.b64decode(${JSON.stringify(payload)}).decode('utf-8'))`,
    " connection=pymysql.connect(host=payload['host'],port=int(payload['port']),user=payload['username'],password=payload['password'],database=payload['database'],charset='utf8mb4',connect_timeout=8,read_timeout=20,write_timeout=10,autocommit=False,cursorclass=pymysql.cursors.DictCursor)",
    " try:",
    "  with connection.cursor() as cursor:",
    "   cursor.execute('SET SESSION MAX_EXECUTION_TIME=15000')",
    "   cursor.execute('SET SESSION TRANSACTION READ ONLY')",
    "   cursor.execute(payload['sql'])",
    "   rows=cursor.fetchmany(int(payload['rowLimit'])+1) if cursor.description else []",
    "   truncated=len(rows)>int(payload['rowLimit'])",
    "   rows=rows[:int(payload['rowLimit'])]",
    "   columns=[item[0] for item in cursor.description] if cursor.description else []",
    "   fields=getattr(getattr(cursor,'_result',None),'fields',[]) if cursor.description else []",
    "   originalColumns=[getattr(field,'org_name',None) or None for field in fields] if len(fields)==len(columns) else [None for _ in columns]",
    "   originalTables=[getattr(field,'org_table',None) or None for field in fields] if len(fields)==len(columns) else [None for _ in columns]",
    "   print(json.dumps({'ok':True,'columns':columns,'originalColumns':originalColumns,'originalTables':originalTables,'rows':rows,'truncated':truncated},ensure_ascii=False,default=str))",
    " finally:",
    "  connection.rollback()",
    "  connection.close()",
    "except Exception as error:",
    " print(json.dumps({'ok':False,'errorType':type(error).__name__},ensure_ascii=False))",
    " sys.exit(1)",
  ].join("\n")
}

export class ReadonlyResourceBroker {
  private readonly runner = new NodeCommandRunner()
  private readonly redactor: ConfiguredSecretRedactor

  constructor(private readonly database: RuntimeDatabase) {
    this.redactor = new ConfiguredSecretRedactor(database)
  }

  async runServerCheck(resourceId: string, check: ServerCheck): Promise<ServerCheckResult> {
    const server = this.database.readServerResources("WHERE id=? AND enabled=1", [resourceId])[0]
    if (!server) throw new Error("服务器资源不存在")
    const targetArguments = sshTargetArguments(server.username, server.host)
    const directory = await mkdtemp(path.join(tmpdir(), "telegram-support-key-"))
    const keyPath = path.join(directory, "identity")
    const knownHostsPath = path.join(directory, "known_hosts")
    try {
      await writeFile(keyPath, server.privateKey, { mode: 0o600 })
      await writeFile(knownHostsPath, "", { mode: 0o600 })
      const result = await this.runner.run("ssh", [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=12",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-o", "LogLevel=ERROR",
        "-i", keyPath,
        "-p", String(server.port),
        ...targetArguments,
        serverCheckCommand(check, server.workdir),
      ], { cwd: directory, timeoutMs: 20_000 })
      this.redactor.refresh()
      return {
        exitCode: result.exitCode,
        stdout: this.redactor.redact(result.stdout.slice(0, 16_000)).text,
        stderr: this.redactor.redact(result.stderr.slice(0, 4_000)).text,
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async verifyDatabaseQuery(serviceId: string, request: VerifiedDatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    throwIfAborted(signal)
    const database = this.database.readDatabaseResources(
      "WHERE service_id=? AND alias=? AND enabled=1 LIMIT 1",
      [serviceId, request.databaseAlias],
    )[0]
    if (!database) throw new Error("数据库只读复核资源不存在")
    const servers = this.database.readServerResources("WHERE service_id=? AND enabled=1 ORDER BY created_at,id", [serviceId])
    const generatedServerIndex = request.serverAlias?.match(/^support-([1-9]\d*)$/u)
    const server = request.serverAlias === null
      ? servers[0]
      : generatedServerIndex
        ? servers[Number(generatedServerIndex[1]) - 1]
        : servers.find((candidate) => candidate.alias === request.serverAlias)
    if (!server) throw new Error("数据库只读复核服务器不存在")
    const targetArguments = sshTargetArguments(server.username, server.host)
    if (!Number.isFinite(request.rowLimit) || !Number.isInteger(request.rowLimit) || request.rowLimit < 1 || request.rowLimit > 100) {
      throw new Error("数据库只读复核行数限制无效")
    }
    const rowLimit = request.rowLimit
    const verifiedQuery = prepareVerifiedDatabaseQuery(request.sql, database.database, rowLimit)
    const sql = verifiedQuery.sql
    const verifiedSelectTable = verifiedQuery.kind === "select" ? verifiedQuery.table : null
    const directory = await mkdtemp(path.join(tmpdir(), "telegram-support-db-verify-"))
    const keyPath = path.join(directory, "identity")
    const knownHostsPath = path.join(directory, "known_hosts")
    try {
      await chmod(directory, 0o700)
      await writeFile(keyPath, server.privateKey, { mode: 0o600 })
      await writeFile(knownHostsPath, "", { mode: 0o600 })
      const payload = Buffer.from(JSON.stringify({
        host: database.host,
        port: database.port,
        database: database.database,
        username: database.username,
        password: database.password,
        sql,
        rowLimit,
      }), "utf8").toString("base64")
      const result = await runWithInput("ssh", [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=12",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-o", "LogLevel=ERROR",
        "-i", keyPath,
        "-p", String(server.port),
        ...targetArguments,
        "timeout", "35s", "python3", "-",
      ], verifiedQueryProgram(payload), directory, 45_000, signal)
      throwIfAborted(signal)
      let parsed: unknown = null
      try { parsed = JSON.parse(result.stdout.trim()) } catch { /* 非 JSON 输出按失败处理。 */ }
      if (result.exitCode !== 0 || !parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
        throw new Error("数据库只读复核执行失败")
      }
      const rawColumns = (parsed as { columns?: unknown }).columns
      const rawOriginalColumns = (parsed as { originalColumns?: unknown }).originalColumns
      const rawOriginalTables = (parsed as { originalTables?: unknown }).originalTables
      const rawRows = (parsed as { rows?: unknown }).rows
      if (!Array.isArray(rawColumns) || !rawColumns.every((column) => typeof column === "string")
        || !Array.isArray(rawOriginalColumns) || rawOriginalColumns.length !== rawColumns.length
        || !rawOriginalColumns.every((column) => column === null || typeof column === "string")
        || !Array.isArray(rawOriginalTables) || rawOriginalTables.length !== rawColumns.length
        || !rawOriginalTables.every((table) => table === null || typeof table === "string") || !Array.isArray(rawRows)) {
        throw new Error("数据库只读复核结果格式错误")
      }
      const columns = rawColumns.slice(0, 200)
      const originalColumns = rawOriginalColumns.slice(0, 200) as Array<string | null>
      const originalTables = rawOriginalTables.slice(0, 200) as Array<string | null>
      if (/^SELECT\b/iu.test(sql) && originalTables.some((table) => !table || table.toLocaleLowerCase("en-US") !== verifiedSelectTable)) {
        throw new Error("数据库只读复核结果来源表不可信")
      }
      const allowedLogPayloadFields = new Set<string>()
      const blockedFields = new Set(columns.filter((column, index) => {
        const original = originalColumns[index]
        if (/^SELECT\b/iu.test(sql) && !original) return true
        const trustedName = original || column
        const allowedLogPayload = Boolean(verifiedSelectTable && logPayloadColumn.test(trustedName))
        if (allowedLogPayload) allowedLogPayloadFields.add(column)
        const selectQuery = verifiedQuery.kind === "select"
        const allowed = selectQuery ? allowedBusinessColumn.test(trustedName) || allowedLogPayload : isAllowedVerifiedMetadataColumn(column)
        return !allowed || (selectQuery && (isSensitiveDatabaseColumn(trustedName) || isSensitiveDatabaseColumn(column)
          || (!allowedLogPayload && (opaqueContainerColumn.test(trustedName) || opaqueContainerColumn.test(column)))))
      }))
      this.redactor.refresh()
      const rows = rawRows.slice(0, rowLimit).map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return null
        return Object.fromEntries(Object.entries(row as Record<string, unknown>).slice(0, 200).map(([key, value]) => {
          if (blockedFields.has(key)) return [key, "[已脱敏]"]
          if (allowedLogPayloadFields.has(key)) {
            return [key, sanitizeDatabaseLogPayload(value, (input) => this.redactor.redact(input).text)]
          }
          if (typeof value === "string") return [key, this.redactor.redact(value.slice(0, 2000)).text]
          if (typeof value === "number" || typeof value === "boolean" || value === null) return [key, value]
          return [key, this.redactor.redact(JSON.stringify(value).slice(0, 2000)).text]
        }))
      }).filter((row): row is Record<string, unknown> => row !== null)
      throwIfAborted(signal)
      return {
        columns: columns.map((column) => blockedFields.has(column) ? "[敏感字段]" : column),
        rows,
        truncated: (parsed as { truncated?: unknown }).truncated === true,
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async runDatabaseQuery(resourceId: string, inputSql: string): Promise<DatabaseQueryResult> {
    const resource = this.database.readDatabaseResources("WHERE id=? AND enabled=1", [resourceId])[0]
    if (!resource) throw new Error("数据库资源不存在")
    const sql = boundedReadonlySql(assertDatabaseScope(inputSql, resource.database), 200)
    const connection = await createConnection({
      host: resource.host,
      port: resource.port,
      database: resource.database,
      user: resource.username,
      password: resource.password,
      timezone: resource.timezone || "Z",
      connectTimeout: 12_000,
      multipleStatements: false,
      charset: "utf8mb4",
    })
    try {
      await connection.query("SET SESSION MAX_EXECUTION_TIME=15000")
      await connection.query("SET SESSION TRANSACTION READ ONLY")
      await connection.beginTransaction()
      const [rawRows, fields] = await connection.query(sql)
      await connection.rollback()
      const rows = Array.isArray(rawRows) ? rawRows : []
      if (/^SELECT\b/i.test(sql) && fields.some((field) => !field.orgName)) {
        throw new Error("只允许读取原始字段")
      }
      const blockedFields = new Set(fields.filter((field) => {
        const original = field.orgName || field.name
        const selectQuery = /^SELECT\b/i.test(sql)
        const allowed = selectQuery ? allowedBusinessColumn.test(original) : isAllowedVerifiedMetadataColumn(field.name)
        return !allowed || (selectQuery && (isSensitiveDatabaseColumn(original) || opaqueContainerColumn.test(original)))
      }).map((field) => field.name))
      const safeRows = rows.slice(0, 200).map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row
        return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => (
          [key, blockedFields.has(key) ? "[已脱敏]" : value]
        )))
      })
      const serialized = JSON.stringify(safeRows, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)
      this.redactor.refresh()
      const safe = this.redactor.redact(serialized).text
      return {
        columns: fields.map((field) => blockedFields.has(field.name) ? "[敏感字段]" : field.name),
        rows: JSON.parse(safe) as unknown[],
        truncated: rows.length > 200,
      }
    } finally {
      try { await connection.rollback() } catch { /* 未开启事务时忽略。 */ }
      await connection.end()
    }
  }
}
