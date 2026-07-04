#!/bin/zsh

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Sync active templates from Notion into local projects."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/notion_sync_templates.mjs"

echo ""
read "?Press Enter to close..."
