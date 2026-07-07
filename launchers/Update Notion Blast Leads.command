#!/bin/zsh

# Update Notion Blast Leads — upload the blasted leads from a chosen day's run
# into the Notion "Blast Leads" database (one row per customer, skips anyone
# already there). Press Enter to use today; or type 27 / 06-27 / 2026-06-27.

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

echo "Updating Notion Blast Leads..."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/notion_upload.mjs"

echo ""
read "?Done. Press Enter to close..."
