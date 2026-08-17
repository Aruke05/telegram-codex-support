#!/bin/zsh
set -euo pipefail

project_root="$(git rev-parse --show-toplevel)"
cd "$project_root"

internal_remote="${INTERNAL_REMOTE:-origin}"
public_remote="${PUBLIC_REMOTE:-github}"
public_branch="${PUBLIC_BRANCH:-telegram-ai-support}"
source_branch="$(git branch --show-current)"
source_commit="$(git rev-parse HEAD)"
source_subject="$(git log -1 --format=%s)"

if [[ -z "$source_branch" ]]; then
  print -u2 "当前处于 detached HEAD，无法发布"
  exit 1
fi

if git ls-tree -r --name-only HEAD | rg -qi '(^|/)\.env$|(^|/)data/|\.(pem|key|p12|jks|session|sqlite|db)$'; then
  print -u2 "当前提交包含不允许进入公开镜像的敏感文件"
  exit 1
fi

git push "$internal_remote" "$source_branch"

public_url="$(git remote get-url "$public_remote")"
mirror_root="$(mktemp -d "${TMPDIR:-/tmp}/telegram-support-public.XXXXXX")"
trap 'rm -rf "$mirror_root"' EXIT
mirror_dir="$mirror_root/repository"

git clone --quiet --single-branch --branch "$public_branch" "$public_url" "$mirror_dir"
git -C "$mirror_dir" rm -r -q --ignore-unmatch .
git archive HEAD | tar -x -C "$mirror_dir"
git -C "$mirror_dir" add -A

if git -C "$mirror_dir" diff --cached --quiet; then
  print "GitHub 公开镜像已经是最新版本"
  exit 0
fi

git -C "$mirror_dir" commit -q -m "$source_subject" -m "内部来源提交：$source_commit"
git -C "$mirror_dir" push origin "$public_branch"
