import { assertDatabaseScope, assertReadonlySql, boundedReadonlySql } from "./read-only-policy.js"

const identifierPattern = "(?:`[A-Za-z_$][A-Za-z0-9_$-]*`|[A-Za-z_$][A-Za-z0-9_$-]*)"
const qualifiedTablePattern = `(?:${identifierPattern}\\s*\\.\\s*)?${identifierPattern}`

export type VerifiedDatabaseStatement = {
  kind: "select" | "metadata" | "explain"
  table: string | null
}

function unquoteIdentifier(value: string): string {
  return value.trim().replace(/^`|`$/gu, "").toLocaleLowerCase("en-US")
}

function tableNameFromReference(value: string): string {
  return unquoteIdentifier(value.split(".").at(-1) ?? "")
}

function verifiedTableName(table: string): string {
  const normalized = tableNameFromReference(table)
  if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(normalized)) throw new Error("数据库只读复核表名无效")
  return normalized
}

function inspectSelect(sql: string): VerifiedDatabaseStatement {
  if (!/^SELECT\s+(?:\*|(?:(?:`?[A-Za-z_$][A-Za-z0-9_$-]*`?\s*\.\s*)?`?[A-Za-z_$][A-Za-z0-9_$-]*`?)(?:\s*,\s*(?:(?:`?[A-Za-z_$][A-Za-z0-9_$-]*`?\s*\.\s*)?`?[A-Za-z_$][A-Za-z0-9_$-]*`?))*)\s+FROM\b/iu.test(sql)) {
    throw new Error("数据库只读复核只允许读取原始字段")
  }
  if (/\bJOIN\b/iu.test(sql)) throw new Error("数据库只读复核只允许查询单张业务表")
  const fromClause = sql.match(/\bFROM\b([\s\S]*?)(?=\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b|$)/iu)?.[1]?.trim() ?? ""
  const table = fromClause.match(new RegExp(`^(${qualifiedTablePattern})(?:\\s+(?:AS\\s+)?(?:\`?[A-Za-z_$][A-Za-z0-9_$-]*\`?))?$`, "iu"))
  if (!table?.[1]) throw new Error("数据库只读复核只允许查询单张业务表")
  return { kind: "select", table: verifiedTableName(table[1]) }
}

export function inspectVerifiedDatabaseStatement(input: string): VerifiedDatabaseStatement {
  const sql = assertReadonlySql(input)
  if (/^SELECT\b/iu.test(sql)) return inspectSelect(sql)
  if (/^SHOW\s+TABLES\s*$/iu.test(sql)) return { kind: "metadata", table: null }
  const show = sql.match(new RegExp(`^SHOW\\s+(?:COLUMNS|INDEX(?:ES)?)\\s+FROM\\s+(${qualifiedTablePattern})\\s*$`, "iu"))
  if (show?.[1]) return { kind: "metadata", table: verifiedTableName(show[1]) }
  const describe = sql.match(new RegExp(`^(?:DESCRIBE|DESC)\\s+(${qualifiedTablePattern})\\s*$`, "iu"))
  if (describe?.[1]) return { kind: "metadata", table: verifiedTableName(describe[1]) }
  const explain = sql.match(/^EXPLAIN\s+(SELECT\b[\s\S]+)$/iu)
  if (explain?.[1]) {
    const select = inspectSelect(explain[1])
    return { kind: "explain", table: select.table }
  }
  throw new Error("数据库只读复核只允许当前服务数据库内单表的字段 索引或查询计划")
}

export function prepareVerifiedDatabaseQuery(
  input: string,
  database: string,
  rowLimit: number,
): VerifiedDatabaseStatement & { sql: string } {
  const scoped = assertDatabaseScope(input, database)
  const inspected = inspectVerifiedDatabaseStatement(scoped)
  return {
    ...inspected,
    sql: inspected.kind === "select" ? boundedReadonlySql(scoped, rowLimit) : scoped,
  }
}
