#!/bin/zsh

# Update Notion Blast Leads — upload the blasted leads from a chosen day's run
# into the Notion "Blast Leads" database (one row per customer, skips anyone
# already there). Press Enter to use today; or type 27 / 06-27 / 2026-06-27.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Updating Notion Blast Leads..."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/notion_upload.mjs"

echo ""
read "?Done. Press Enter to close..."
