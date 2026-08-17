#!/bin/zsh
set -euo pipefail

label="com.mercury.telegram-codex-support"
plist_path="${HOME}/Library/LaunchAgents/${label}.plist"

launchctl bootout "gui/${UID}" "${plist_path}" >/dev/null 2>&1 || true
if [[ -f "${plist_path}" ]]; then
  rm "${plist_path}"
fi
print "AI 客服常驻服务已停止并移除；项目和 SQLite 数据未删除。"
