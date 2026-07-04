#!/bin/zsh

# Upload Blaster — after each night's blast, upload the blasted leads into the
# Notion "Blast Leads" database (one row per customer, skips anyone already
# there). Reads the latest run; press Enter to pick the newest.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Uploading blasted leads to Notion..."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/notion_upload.mjs"

echo ""
read "?Done. Press Enter to close..."
