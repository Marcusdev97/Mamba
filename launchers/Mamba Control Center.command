#!/bin/zsh

# Mamba Control Center — open ONE dashboard with a button for every tool, so you
# never have to find files. Keep this window open while you use the panel.

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
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

# 控制台无状态 —— 每次启动都先换掉旧进程,保证按钮/emoji 永远是最新代码
PORT="${CONTROL_PORT:-8810}"
OLD_PID="$(lsof -ti tcp:$PORT 2>/dev/null)"
if [[ -n "$OLD_PID" ]]; then
  echo "换掉旧的 Control Center(pid $OLD_PID)…"
  kill $OLD_PID 2>/dev/null
  sleep 1
fi

echo "Starting Mamba Control Center..."
echo "A dashboard will open in your browser. Click any button to run a tool."
echo "Keep this window open while you use the panel."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/control_center.mjs"

echo ""
read "?Control Center stopped. Press Enter to close..."
