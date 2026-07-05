#!/bin/zsh

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

echo "Sync the GLOBAL STOP suppression list from Notion (all projects, all lead databases)."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/suppression.mjs"

echo ""
read "?Press Enter to close..."
