#!/bin/zsh
set -euo pipefail

label="com.mercury.telegram-codex-support"
target="gui/${UID}/${label}"

if ! launchctl print "${target}" >/dev/null 2>&1; then
  print "AI 客服常驻服务未安装。"
  exit 1
fi

launchctl print "${target}" | awk '/^[[:space:]]*(state|pid|last exit code) =/ { sub(/^[[:space:]]+/, ""); print }'
if curl --silent --fail --max-time 2 http://127.0.0.1:3210/health >/dev/null; then
  print "健康检查：正常"
else
  print -u2 "健康检查：失败"
  exit 1
fi
