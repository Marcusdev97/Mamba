#!/bin/zsh

# 发送台 — Flow 1 群发 + Flow 2-10 跟进, 一个页面两个 tab。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

PORT="${CONSOLE_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/send"

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"
  read "?Press Enter to close..."
  exit 1
fi

if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "Campaign Console 没在运行,正在启动..."
  MAMBA_AUTO_OPEN=0 nohup "$NODE" "$ROOT_DIR/campaign-app/server.mjs" >/dev/null 2>&1 &
  sleep 3
fi

echo "打开发送台:$URL"
open "$URL"
echo ""
read "?Press Enter to close..."
