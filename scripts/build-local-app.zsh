#!/bin/zsh
set -euo pipefail

if [[ $# -ne 1 ]]; then
  print -u2 "用法：$0 <本地版目录>"
  exit 2
fi

source_root="${0:A:h:h}"
target_root="${1:A}"
app_root="$target_root/AI客服.app"
contents="$app_root/Contents"

if [[ -e "$app_root" ]]; then
  /usr/bin/trash "$app_root"
fi
mkdir -p "$contents/MacOS" "$contents/Resources"
swiftc -parse-as-library -O "$source_root/local-app/LocalApp.swift" -o "$contents/MacOS/AI客服" -framework Cocoa -framework WebKit
cp "$source_root/local-app/Info.plist" "$contents/Info.plist"
node_path="$(command -v node)"
cp "$node_path" "$contents/Resources/node"
chmod 755 "$contents/MacOS/AI客服" "$contents/Resources/node"
codesign --force --deep --sign - "$app_root"
