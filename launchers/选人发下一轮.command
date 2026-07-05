#!/bin/zsh

# 选人发下一轮 — opens the web picker where you tick who to blast next and send
# directly. It is served by the Campaign Console, so this launcher makes sure
# the Console is running, then opens the picker page.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

PORT="${CONSOLE_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/next-flow"

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

# Start the Campaign Console in the background if it isn't already listening.
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "Campaign Console 没在运行,正在启动..."
  MAMBA_AUTO_OPEN=0 nohup "$NODE" "$ROOT_DIR/campaign-app/server.mjs" >/dev/null 2>&1 &
  sleep 3
fi

echo "打开选人页面:$URL"
open "$URL"

echo ""
echo "提示:发送进度在主控制台 http://127.0.0.1:${PORT}/ 查看。"
read "?Press Enter to close..."
