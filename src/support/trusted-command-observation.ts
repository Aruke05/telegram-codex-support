import { realpathSync } from "node:fs"
import path from "node:path"

import type { CodexCommandObservation } from "../codex/executor.js"
import type { InvestigationStep } from "../codex/schemas.js"
import { inspectVerifiedDatabaseStatement } from "../diagnostics/verified-database-query.js"

export type TrustedCommandContext = {
  workspacePath: string
  codeRoots: string[]
}

export type TrustedDatabaseQueryRequest = {
  databaseAlias: string
  serverAlias: string | null
  sql: string
  rowLimit: number
}

export type TrustedCommandValidation =
  | { kind: "database"; request: TrustedDatabaseQueryRequest }
  | { kind: "evidence"; source: Extract<InvestigationStep["source"], "code" | "server" | "log" | "redis">; command: string }

const safeAliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u
const readonlySqlPrefix = /^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/iu
const forbiddenSql = /(?:;|--|\/\*|#|\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|ALTER|CREATE|DROP|TRUNCATE|RENAME|GRANT|REVOKE|CALL|DO|HANDLER|LOAD|LOCK|UNLOCK|KILL|SET|USE|UNION|INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\b|\(\s*SELECT\b|\b(?:FROM|JOIN)\s*\(|:=|@@?)/iu

function tokenizeShell(command: string): string[] | null {
  const tokens: string[] = []
  let token = ""
  let started = false
  let quote: "single" | "double" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote === "single") {
      if (character === "'") quote = null
      else token += character
      started = true
      continue
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null
        continue
      }
      if (character === "$" || character === "`") return null
      if (character === "\\") {
        const next = command[index + 1]
        if (!next || next === "\n" || next === "\r") return null
        token += next
        index += 1
      } else token += character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token)
        token = ""
        started = false
      }
      continue
    }
    if (character === "'") {
      quote = "single"
      started = true
      continue
    }
    if (character === '"') {
      quote = "double"
      started = true
      continue
    }
    if (/[;|&><`$(){}\n\r]/u.test(character) || character === "#") return null
    if (character === "\\") {
      const next = command[index + 1]
      if (!next || next === "\n" || next === "\r") return null
      token += next
      index += 1
    } else token += character
    started = true
  }
  if (quote) return null
  if (started) tokens.push(token)
  return tokens.length > 0 ? tokens : null
}

function unwrapShell(command: string): string[] | null {
  const outer = tokenizeShell(command)
  if (!outer) return null
  if (["bash", "zsh", "sh", "/bin/bash", "/bin/zsh", "/bin/sh"].includes(outer[0] ?? "")) {
    if (outer.length !== 3 || outer[1] !== "-lc") return null
    return tokenizeShell(outer[2]!)
  }
  return outer
}

function inside(candidate: string, roots: string[], cwd: string): boolean {
  try {
    const resolved = realpathSync.native(path.resolve(cwd, candidate))
    return roots.some((root) => {
      try {
        const relative = path.relative(realpathSync.native(path.resolve(root)), resolved)
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      } catch { return false }
    })
  } catch { return false }
}

function stripTimeout(tokens: string[]): string[] | null {
  if (tokens[0] !== "timeout") return tokens
  if (!/^(?:[1-5]?\d|60)s$/u.test(tokens[1] ?? "")) return null
  return tokens.slice(2)
}

function parseDatabaseRequest(tokens: string[], context: TrustedCommandContext): TrustedDatabaseQueryRequest | null {
  const command = stripTimeout(tokens)
  if (!command || command[0] !== "node") return null
  const helper = command[1]
  if (!helper || path.resolve(context.workspacePath, helper) !== path.join(path.resolve(context.workspacePath), "query-database.mjs")) return null
  const values = new Map<string, string>()
  for (let index = 2; index < command.length; index += 2) {
    const option = command[index]
    const value = command[index + 1]
    if (!option || !value || !["--database", "--server", "--sql", "--rows"].includes(option) || values.has(option)) return null
    values.set(option, value)
  }
  const databaseAlias = values.get("--database") ?? ""
  const serverAlias = values.get("--server") ?? null
  const sql = (values.get("--sql") ?? "").trim().replace(/;\s*$/u, "")
  const rowLimit = Number(values.get("--rows") ?? 30)
  if (!safeAliasPattern.test(databaseAlias) || (serverAlias !== null && !safeAliasPattern.test(serverAlias))) return null
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 100) return null
  if (!sql || sql.length > 20_000 || !readonlySqlPrefix.test(sql) || forbiddenSql.test(sql)) return null
  try { inspectVerifiedDatabaseStatement(sql) } catch { return null }
  return { databaseAlias, serverAlias, sql, rowLimit }
}

function validateRipgrep(tokens: string[], context: TrustedCommandContext): boolean {
  if (tokens[0] !== "rg") return false
  let index = 1
  let filesMode = false
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index]!
    if (option === "--") { index += 1; break }
    if (option === "--files") filesMode = true
    else if (!/^(?:-[nHSiFwl]+|--(?:line-number|fixed-strings|files-with-matches|no-heading)|--color=never)$/u.test(option)) return false
    index += 1
  }
  if (!filesMode) {
    if (!tokens[index]) return false
    index += 1
  }
  const paths = tokens.slice(index)
  return paths.length > 0 && paths.every((candidate) => inside(candidate, context.codeRoots, context.workspacePath))
}

function validateGit(tokens: string[], context: TrustedCommandContext): boolean {
  if (tokens[0] !== "git" || tokens[1] !== "-C" || !tokens[2] || !inside(tokens[2], context.codeRoots, context.workspacePath)) return false
  const subcommand = tokens[3]
  const args = tokens.slice(4)
  if (!subcommand || args.some((token) => /^(?:-c|--config-env|--exec-path|--git-dir|--work-tree|--output(?:=|$)|--ext-diff)/u.test(token))) return false
  if (subcommand === "grep") {
    return args.length > 0 && args.every((token) => !token.startsWith("-")
      || /^(?:-[nHiIlwFE]+|--(?:line-number|ignore-case|files-with-matches|fixed-strings|extended-regexp|cached)|--)$/u.test(token))
  }
  if (subcommand === "show") {
    return args.length > 0 && args.includes("--no-ext-diff") && args.includes("--no-textconv")
      && args.every((token) => !token.startsWith("-")
        || /^(?:--no-ext-diff|--no-textconv|--stat|--oneline|--name-only|--name-status|--format=[A-Za-z0-9%._: -]{1,160}|--)$/u.test(token))
  }
  if (subcommand === "log") {
    return args.every((token, index) => !token.startsWith("-")
      || /^(?:--oneline|--no-decorate|--name-only|--name-status|--since=[A-Za-z0-9: +._-]{1,80}|--until=[A-Za-z0-9: +._-]{1,80}|--max-count=\d{1,3}|-n|--)$/u.test(token)
      || (index > 0 && args[index - 1] === "-n" && /^\d{1,3}$/u.test(token)))
      && !args.some((token, index) => args[index - 1] === "-n" && Number(token) > 500)
  }
  if (subcommand === "rev-parse") {
    return args.length > 0 && args.every((token) => !token.startsWith("-") || ["--verify", "--show-toplevel", "--show-prefix"].includes(token))
  }
  if (subcommand === "diff") {
    return args.includes("--no-ext-diff") && args.includes("--no-textconv")
      && args.every((token) => !token.startsWith("-") || ["--no-ext-diff", "--no-textconv", "--stat", "--name-only", "--name-status", "--"].includes(token))
  }
  return false
}

function validateFileRead(tokens: string[], context: TrustedCommandContext): boolean {
  const executable = tokens[0]
  if (executable === "cat") {
    const argumentsList = tokens.slice(1)
    if (argumentsList.some((token) => token.startsWith("-") && !/^(?:-[nbs]+)$/u.test(token))) return false
    const paths = argumentsList.filter((token) => !token.startsWith("-"))
    return paths.length > 0 && paths.every((candidate) => inside(candidate, context.codeRoots, context.workspacePath))
  }
  if (executable === "head" || executable === "tail") {
    let index = 1
    if (tokens[index] === "-n") {
      const count = Number(tokens[index + 1])
      if (!Number.isInteger(count) || count < 1 || count > 500) return false
      index += 2
    }
    const paths = tokens.slice(index)
    return paths.length > 0 && paths.every((candidate) => !candidate.startsWith("-")
      && inside(candidate, context.codeRoots, context.workspacePath))
  }
  if (executable === "sed") {
    return tokens.length === 4 && tokens[1] === "-n" && /^\d+(?:,\d+)?p$/u.test(tokens[2]!)
      && inside(tokens[3]!, context.codeRoots, context.workspacePath)
  }
  if (executable === "wc") {
    const argumentsList = tokens.slice(1)
    if (argumentsList.some((token) => token.startsWith("-") && !/^(?:-[lcw]+)$/u.test(token))) return false
    const paths = argumentsList.filter((token) => !token.startsWith("-"))
    return paths.length > 0 && paths.every((candidate) => inside(candidate, context.codeRoots, context.workspacePath))
  }
  return false
}

function remoteCommand(tokens: string[], context: TrustedCommandContext): string | null {
  if (tokens[0] !== "ssh" || tokens[1] !== "-F") return null
  if (path.resolve(context.workspacePath, tokens[2]!) !== path.join(path.resolve(context.workspacePath), "ssh_config")) return null
  const separatorOffset = tokens[3] === "--" ? 1 : 0
  if (tokens.length !== 5 + separatorOffset || !/^support-[1-9]\d*$/u.test(tokens[3 + separatorOffset]!)) return null
  const command = tokens[4 + separatorOffset]!
  return command && command.length <= 16_000 ? command : null
}

const redisValuePattern = /^[A-Za-z0-9:_*?.-]{1,256}$/u

function validateRedis(tokens: string[]): boolean {
  if (tokens[0] !== "redis-cli") return false
  let index = 1
  const options = new Set<string>()
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index]!
    if (options.has(option)) return false
    options.add(option)
    if (option === "--raw") index += 1
    else if (option === "-n" && /^\d{1,5}$/u.test(tokens[index + 1] ?? "") && Number(tokens[index + 1]) <= 65535) index += 2
    else if (option === "-p" && /^[1-9]\d{0,4}$/u.test(tokens[index + 1] ?? "") && Number(tokens[index + 1]) <= 65535) index += 2
    else if (option === "-h" && ["127.0.0.1", "localhost"].includes(tokens[index + 1] ?? "")) index += 2
    else return false
  }
  const operation = tokens[index]?.toUpperCase()
  if (!operation || !["GET", "MGET", "HGET", "HMGET", "HGETALL", "EXISTS", "TTL", "PTTL", "TYPE", "SCAN"].includes(operation)) return false
  const argumentsList = tokens.slice(index + 1)
  if (operation === "GET" || operation === "HGETALL" || operation === "EXISTS" || operation === "TTL" || operation === "PTTL" || operation === "TYPE") {
    return argumentsList.length === 1 && redisValuePattern.test(argumentsList[0]!)
  }
  if (operation === "MGET") return argumentsList.length >= 1 && argumentsList.length <= 20 && argumentsList.every((value) => redisValuePattern.test(value))
  if (operation === "HGET") return argumentsList.length === 2 && argumentsList.every((value) => redisValuePattern.test(value))
  if (operation === "HMGET") return argumentsList.length >= 2 && argumentsList.length <= 21 && argumentsList.every((value) => redisValuePattern.test(value))
  if (!/^\d{1,20}$/u.test(argumentsList[0] ?? "")) return false
  let scanIndex = 1
  const scanOptions = new Set<string>()
  while (scanIndex < argumentsList.length) {
    const option = argumentsList[scanIndex]?.toUpperCase()
    const value = argumentsList[scanIndex + 1]
    if (!option || !value || scanOptions.has(option)) return false
    scanOptions.add(option)
    if (option === "MATCH" && redisValuePattern.test(value)) scanIndex += 2
    else if (option === "COUNT" && /^[1-9]\d{0,3}$/u.test(value) && Number(value) <= 1000) scanIndex += 2
    else if (option === "TYPE" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value)) scanIndex += 2
    else return false
  }
  return true
}

const safeRemoteServicePattern = /^[A-Za-z0-9@_.-]{1,160}$/u

function validateRemoteServer(tokens: string[]): boolean {
  if (tokens.length === 1 && tokens[0] === "uptime") return true
  if (tokens.length === 2 && tokens[0] === "free" && tokens[1] === "-m") return true
  if (tokens.length === 2 && tokens[0] === "df" && tokens[1] === "-h") return true
  if (tokens.length === 2 && tokens[0] === "cat" && tokens[1] === "/proc/loadavg") return true
  if (tokens.length === 3 && tokens[0] === "ip" && tokens[1] === "-s" && tokens[2] === "link") return true
  return tokens.length === 3 && tokens[0] === "systemctl" && tokens[1] === "is-active"
    && safeRemoteServicePattern.test(tokens[2]!)
}

function validateRemoteJournal(tokens: string[]): boolean {
  if (tokens[0] !== "journalctl") return false
  const values = new Map<string, string>()
  let noPager = false
  for (let index = 1; index < tokens.length;) {
    const option = tokens[index]
    if (option === "--no-pager" && !noPager) {
      noPager = true
      index += 1
      continue
    }
    const value = tokens[index + 1]
    if (!option || !value || values.has(option) || !["-u", "--since", "-n", "-o"].includes(option)) return false
    values.set(option, value)
    index += 2
  }
  return noPager
    && safeRemoteServicePattern.test(values.get("-u") ?? "")
    && /^[A-Za-z0-9: +._-]{1,80}$/u.test(values.get("--since") ?? "")
    && /^(?:[1-9]\d{0,2}|1000)$/u.test(values.get("-n") ?? "")
    && Number(values.get("-n")) <= 1000
    && values.get("-o") === "cat"
}

function validateRemoteReadonly(command: string): "server" | "log" | "redis" | null {
  if (!command.trim() || /[\u0000\r]/u.test(command)) return null
  const simpleTokens = tokenizeShell(command)
  const simpleCommand = simpleTokens ? stripTimeout(simpleTokens) : null
  if (!simpleCommand) return null
  if (validateRedis(simpleCommand)) return "redis"
  if (validateRemoteJournal(simpleCommand)) return "log"
  if (validateRemoteServer(simpleCommand)) return "server"
  return null
}

export function validateTrustedCommandObservation(
  observation: CodexCommandObservation,
  context: TrustedCommandContext,
): TrustedCommandValidation | null {
  const tokens = unwrapShell(observation.command)
  if (tokens) {
    const database = parseDatabaseRequest(tokens, context)
    if (database) return { kind: "database", request: database }
    const command = stripTimeout(tokens)
    if (!command) return null
    if (validateRipgrep(command, context) || validateGit(command, context) || validateFileRead(command, context)) {
      return { kind: "evidence", source: "code", command: observation.command }
    }
    const directRemote = remoteCommand(command, context)
    if (directRemote) {
      const source = validateRemoteReadonly(directRemote)
      return source ? { kind: "evidence", source, command: observation.command } : null
    }
  }
  return null
}
