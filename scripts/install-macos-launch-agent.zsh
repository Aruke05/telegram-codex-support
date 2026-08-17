#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "此命令只用于 macOS。"
  exit 1
fi

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
label="com.mercury.telegram-codex-support"
domain="gui/${UID}"
launch_agents_dir="${HOME}/Library/LaunchAgents"
plist_path="${launch_agents_dir}/${label}.plist"
runtime_dir="${project_dir}/data/runtime"
log_dir="${runtime_dir}/logs"
stdout_path="${log_dir}/service.log"
stderr_path="${log_dir}/service-error.log"
node_path="$(command -v node || true)"
codex_path="$(command -v codex || true)"
pnpm_path="$(command -v pnpm || true)"

if [[ -z "${node_path}" || -z "${pnpm_path}" || -z "${codex_path}" ]]; then
  print -u2 "需要先安装并登录 Node.js、pnpm 和 Codex CLI。"
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

project_xml="$(xml_escape "${project_dir}")"
node_xml="$(xml_escape "${node_path}")"
home_xml="$(xml_escape "${HOME}")"
path_xml="$(xml_escape "${node_path:h}:${codex_path:h}:${PATH}")"
stdout_xml="$(xml_escape "${stdout_path}")"
stderr_xml="$(xml_escape "${stderr_path}")"
data_xml="$(xml_escape "${project_dir}/data")"

cd "${project_dir}"
"${pnpm_path}" install --frozen-lockfile
"${pnpm_path}" build

mkdir -p "${launch_agents_dir}" "${log_dir}"
chmod 700 "${runtime_dir}" "${log_dir}"

{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0">' '<dict>'
  printf '%s\n' '  <key>Label</key>' "  <string>${label}</string>"
  printf '%s\n' '  <key>ProgramArguments</key>' '  <array>' '    <string>/usr/bin/caffeinate</string>' '    <string>-i</string>' "    <string>${node_xml}</string>" "    <string>${project_xml}/dist/server.js</string>" '  </array>'
  printf '%s\n' '  <key>WorkingDirectory</key>' "  <string>${project_xml}</string>"
  printf '%s\n' '  <key>EnvironmentVariables</key>' '  <dict>'
  printf '%s\n' '    <key>HOME</key>' "    <string>${home_xml}</string>"
  printf '%s\n' '    <key>PATH</key>' "    <string>${path_xml}</string>"
  printf '%s\n' '    <key>HOST</key>' '    <string>127.0.0.1</string>'
  printf '%s\n' '    <key>PORT</key>' '    <string>3210</string>'
  printf '%s\n' '    <key>DATA_DIR</key>' "    <string>${data_xml}</string>"
  printf '%s\n' '    <key>LOG_LEVEL</key>' '    <string>warn</string>'
  if [[ -n "${CODEX_HOME:-}" ]]; then
    printf '%s\n' '    <key>CODEX_HOME</key>' "    <string>$(xml_escape "${CODEX_HOME}")</string>"
  fi
  printf '%s\n' '  </dict>'
  printf '%s\n' '  <key>RunAtLoad</key>' '  <true/>'
  printf '%s\n' '  <key>KeepAlive</key>' '  <true/>'
  printf '%s\n' '  <key>ProcessType</key>' '  <string>Background</string>'
  printf '%s\n' '  <key>ThrottleInterval</key>' '  <integer>10</integer>'
  printf '%s\n' '  <key>Umask</key>' '  <integer>63</integer>'
  printf '%s\n' '  <key>StandardOutPath</key>' "  <string>${stdout_xml}</string>"
  printf '%s\n' '  <key>StandardErrorPath</key>' "  <string>${stderr_xml}</string>"
  printf '%s\n' '</dict>' '</plist>'
} > "${plist_path}"

chmod 600 "${plist_path}"
plutil -lint "${plist_path}" >/dev/null
launchctl bootout "${domain}" "${plist_path}" >/dev/null 2>&1 || true
launchctl bootstrap "${domain}" "${plist_path}"
launchctl enable "${domain}/${label}"
launchctl kickstart -k "${domain}/${label}"

for _ in {1..20}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:3210/health >/dev/null; then
    print "AI 客服常驻服务已启动：http://127.0.0.1:3210/"
    exit 0
  fi
  sleep 1
done

print -u2 "常驻服务已注册，但健康检查未通过。运行 pnpm service:status 查看状态。"
exit 1
