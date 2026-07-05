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

echo "Starting Mamba Campaign Console..."
echo "A browser tab will open automatically."
echo "Keep this window open while you use the console. Close it to stop."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/server.mjs"

echo ""
read "?Console stopped. Press Enter to close..."
