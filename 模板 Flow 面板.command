#!/bin/zsh

# 模板 & Flow 面板 — 打开网页看整个自动序列、直接拉 Notion 的模板、一眼看出哪个
# flow 缺模板。由 Campaign Console 提供,所以这个启动器会确保 Console 在跑再打开。

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

PORT="${CONSOLE_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/templates"

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"; read "?Press Enter to close..."; exit 1
fi

if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "Campaign Console 没在运行,正在启动..."
  nohup "$NODE" "$ROOT_DIR/campaign-app/server.mjs" >/dev/null 2>&1 &
  sleep 3
fi

echo "打开模板 & Flow 面板:$URL"
open "$URL"
echo ""
read "?Press Enter to close..."
