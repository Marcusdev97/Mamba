#!/bin/zsh

# Canonical Mamba entry point. One server (8787), one Control Center UI.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。请先安装 Node.js，再重新打开 Mamba。"
  read "?Press Enter to close..."
  exit 1
fi

PORT="${CONSOLE_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/control-center"

if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "Mamba 已经在运行，正在打开统一 Control Center。"
  open "$URL"
  exit 0
fi

echo "Starting Mamba..."
echo "Control Center: $URL"
echo "Sales Brain 默认关闭；Reply Tracker 只记录回复，不会自动回复客户。"
echo "保持这个窗口开启。关闭窗口会停止本次 Mamba 服务。"
echo ""

MAMBA_OPEN_PATH="/control-center" "$NODE" "$ROOT_DIR/campaign-app/server.mjs"

echo ""
read "?Mamba stopped. Press Enter to close..."
