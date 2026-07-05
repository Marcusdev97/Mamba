#!/bin/zsh

# Mamba Control Center — open ONE dashboard with a button for every tool, so you
# never have to find files. Keep this window open while you use the panel.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Starting Mamba Control Center..."
echo "A dashboard will open in your browser. Click any button to run a tool."
echo "Keep this window open while you use the panel."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/control_center.mjs"

echo ""
read "?Control Center stopped. Press Enter to close..."
