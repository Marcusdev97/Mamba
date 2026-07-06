#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

# Run node from a non-protected cwd. macOS can deny node's getcwd() inside
# ~/Documents (TCC privacy) -> "EPERM ... uv_cwd". server.mjs uses absolute
# paths internally, so the working directory does not matter.
cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

PORT="${CONSOLE_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/"

# Server 已经在跑(比如从「号码连接」或 一键启动 拉起的)-> 直接开网页,不再起第二个
if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "Console 已在运行,直接打开页面。"
  open "$URL"
  exit 0
fi

echo "Starting Mamba Campaign Console..."
echo "A browser tab will open automatically."
echo "Keep this window open while you use the console. Close it to stop."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/server.mjs"

echo ""
read "?Console stopped. Press Enter to close..."
