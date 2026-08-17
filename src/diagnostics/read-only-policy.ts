const forbidden = /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE|CALL|GRANT|REVOKE|LOCK|UNLOCK|SET|USE|LOAD|HANDLER|INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOAD_FILE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\b/i

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/#[^\r\n]*/g, " ")
    .trim()
}

export function assertReadonlySql(input: string): string {
  const sql = stripComments(input).replace(/;\s*$/, "").trim()
  const prefixAllowed = /^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(sql)
  if (!sql || !prefixAllowed || forbidden.test(sql) || sql.includes(";") || /(?:^|[^@])@[A-Za-z_]/.test(sql)) {
    throw new Error("只允许只读查询")
  }
  return sql
}

export function boundedReadonlySql(input: string, maxRows = 200): string {
  const sql = assertReadonlySql(input)
  if (!/^SELECT\b/i.test(sql)) return sql
  const limit = sql.match(/\bLIMIT\s+(\d+)\s*$/i)
  if (!limit) return `${sql} LIMIT ${maxRows}`
  if (Number(limit[1]) > maxRows) return sql.replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${maxRows}`)
  return sql
}

export function assertDatabaseScope(input: string, database: string): string {
  const sql = assertReadonlySql(input)
  const withoutStrings = sql.replace(/'(?:''|\\.|[^'])*'/g, "''").replace(/"(?:""|\\.|[^"])*"/g, '""')
  if (/\bUNION\b|\(\s*SELECT\b|\b(?:FROM|JOIN)\s*\(/i.test(withoutStrings)) {
    throw new Error("只允许查询当前服务数据库")
  }
  for (const fromClause of withoutStrings.matchAll(/\bFROM\b([\s\S]*?)(?=\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b|$)/gi)) {
    if (fromClause[1]?.includes(",")) throw new Error("只允许查询当前服务数据库")
  }
  if (/\b(?:mysql|information_schema|performance_schema|sys)\b/i.test(withoutStrings)) {
    throw new Error("只允许查询当前服务数据库")
  }
  if (/^SHOW\b/i.test(sql) && !/^SHOW\s+(?:TABLES|COLUMNS\s+FROM\s+`?[A-Za-z0-9_$-]+`?|INDEX(?:ES)?\s+FROM\s+`?[A-Za-z0-9_$-]+`?)\s*$/i.test(sql)) {
    throw new Error("只允许查询当前服务数据库")
  }
  const describe = sql.match(/^(?:DESCRIBE|DESC)\s+((?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*))?)\s*$/i)
  if (/^(?:DESCRIBE|DESC)\b/i.test(sql) && !describe) throw new Error("只允许查询当前服务数据库")
  if (describe) {
    const parts = describe[1]!.split(".").map((part) => part.trim().replace(/^`|`$/g, "").toLocaleLowerCase("en-US"))
    if (parts.length === 2 && parts[0] !== database.toLocaleLowerCase("en-US")) throw new Error("只允许查询当前服务数据库")
  }
  const unquote = (value: string) => value.replace(/^`|`$/g, "").toLocaleLowerCase("en-US")
  const databaseName = database.toLocaleLowerCase("en-US")
  const allowedQualifiers = new Set([databaseName])
  const tableReference = /\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*))?)(?:\s+(?:AS\s+)?(`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*))?/gi
  const reserved = new Set(["where", "join", "left", "right", "inner", "outer", "cross", "on", "order", "group", "limit", "having", "union"])
  for (const match of withoutStrings.matchAll(tableReference)) {
    const parts = match[1]!.split(".").map((part) => unquote(part.trim()))
    if (parts.length === 2 && parts[0] !== databaseName) throw new Error("只允许查询当前服务数据库")
    allowedQualifiers.add(parts.at(-1)!)
    const alias = match[2] ? unquote(match[2]) : ""
    if (alias && !reserved.has(alias)) allowedQualifiers.add(alias)
  }
  const qualifier = /(?:`([^`]+)`|\b([A-Za-z_$][A-Za-z0-9_$-]*))\s*\.\s*(?:`[^`]+`|[A-Za-z_$][A-Za-z0-9_$-]*)/g
  for (const match of withoutStrings.matchAll(qualifier)) {
    const scope = (match[1] ?? match[2] ?? "").toLocaleLowerCase("en-US")
    if (!allowedQualifiers.has(scope)) throw new Error("只允许查询当前服务数据库")
  }
  return sql
}

export type ServerCheck = "service_status" | "recent_logs" | "disk_usage" | "nginx_routes" | "system_resources"

export function serverCheckCommand(check: ServerCheck, workdir: string): string {
  const quotedWorkdir = `'${workdir.replaceAll("'", "'\\''")}'`
  if (check === "service_status") return "printf 'running_services\\n'; systemctl list-units --type=service --state=running --no-pager --no-legend | head -n 200; printf 'java_processes\\n'; ps -eo pid=,comm=,etimes= --sort=pid | awk '$2==\"java\"{print}' | head -n 100"
  if (check === "recent_logs") return "journalctl --no-pager --since '-30 min' -n 1000 -o cat | awk 'BEGIN{e=0;w=0;n=0} {n++} /ERROR|Exception/{e++} /WARN/{w++} END{printf \"errors=%d warnings=%d lines=%d\\n\",e,w,n}'"
  if (check === "nginx_routes") return [
    "if ! command -v nginx >/dev/null 2>&1; then echo nginx=missing; exit 0; fi",
    "config=$(nginx -T 2>/dev/null) || { echo nginx_config=unreadable; exit 0; }",
    "echo nginx_config=readable",
    "printf '%s\\n' \"$config\" | awk '/^[[:space:]]*server_name[[:space:]]/{print} /^[[:space:]]*location[[:space:]]/{print} /^[[:space:]]*proxy_pass[[:space:]]/{print \"proxy_pass configured\"}' | head -n 400",
  ].join("; ")
  if (check === "system_resources") {
    const command = [
      "set -eu",
      "set -- $(awk '/^cpu / {total=0; for(i=2;i<=9;i++) total+=$i; idle=$5+$6; printf \"%.0f %.0f\\n\",total,idle; exit}' /proc/stat)",
      "cpu_total_1=$1",
      "cpu_idle_1=$2",
      "set -- $(awk 'NR>2 {interface=$1; sub(/:$/,\"\",interface); if(interface!=\"lo\"){rx+=$2; tx+=$10}} END {printf \"%.0f %.0f\\n\",rx,tx}' /proc/net/dev)",
      "network_rx_1=$1",
      "network_tx_1=$2",
      "network_time_1=$(awk 'NR==1 {print $1; exit}' /proc/uptime)",
      "sleep 1",
      "set -- $(awk '/^cpu / {total=0; for(i=2;i<=9;i++) total+=$i; idle=$5+$6; printf \"%.0f %.0f\\n\",total,idle; exit}' /proc/stat)",
      "cpu_total_2=$1",
      "cpu_idle_2=$2",
      "set -- $(awk 'NR>2 {interface=$1; sub(/:$/,\"\",interface); if(interface!=\"lo\"){rx+=$2; tx+=$10}} END {printf \"%.0f %.0f\\n\",rx,tx}' /proc/net/dev)",
      "network_rx_2=$1",
      "network_tx_2=$2",
      "network_time_2=$(awk 'NR==1 {print $1; exit}' /proc/uptime)",
      "cpu_delta_total=$((cpu_total_2-cpu_total_1))",
      "cpu_delta_idle=$((cpu_idle_2-cpu_idle_1))",
      "network_sample_seconds=$(awk -v first=\"$network_time_1\" -v second=\"$network_time_2\" 'BEGIN {elapsed=second-first; if(elapsed<=0 || elapsed>10) exit 1; printf \"%.6f\",elapsed}')",
      "network_rx_rate=$(awk -v first=\"$network_rx_1\" -v second=\"$network_rx_2\" -v elapsed=\"$network_sample_seconds\" 'BEGIN {if(second<first || elapsed<=0) exit 1; printf \"%.2f\",(second-first)/elapsed}')",
      "network_tx_rate=$(awk -v first=\"$network_tx_1\" -v second=\"$network_tx_2\" -v elapsed=\"$network_sample_seconds\" 'BEGIN {if(second<first || elapsed<=0) exit 1; printf \"%.2f\",(second-first)/elapsed}')",
      "awk -v total=\"$cpu_delta_total\" -v idle=\"$cpu_delta_idle\" 'BEGIN {if(total<=0) exit 1; printf \"cpu_usage_percent=%.2f\\n\",100*(total-idle)/total}'",
      "awk '{printf \"loadavg_1m=%s\\nloadavg_5m=%s\\nloadavg_15m=%s\\n\",$1,$2,$3}' /proc/loadavg",
      "awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {if(total<=0) exit 1; printf \"memory_total_kb=%.0f\\nmemory_available_kb=%.0f\\n\",total,available}' /proc/meminfo",
      `df -Pk -- ${quotedWorkdir} | awk 'NR==2 {gsub("%","",$5); printf "disk_total_kb=%s\\ndisk_available_kb=%s\\ndisk_used_percent=%s\\n",$2,$4,$5; found=1} END {if(!found) exit 1}'`,
      "printf 'network_rx_bytes_per_second=%s\\nnetwork_tx_bytes_per_second=%s\\nnetwork_sample_seconds=%s\\n' \"$network_rx_rate\" \"$network_tx_rate\" \"$network_sample_seconds\"",
    ].join("; ")
    return `timeout 15s sh -c '${command.replaceAll("'", "'\\''")}'`
  }
  return `df -h ${quotedWorkdir}`
}
