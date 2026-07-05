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

mkdir -p "$ROOT_DIR/recycle-import/inbox" "$ROOT_DIR/recycle-import/processed" "$ROOT_DIR/recycle-import/rejected"

echo "Starting Mamba Recycle Leads Importer..."
echo "Put Excel files here:"
echo "$ROOT_DIR/recycle-import/inbox"
echo ""
echo "A browser tab will open automatically."
echo "Keep this window open while you import. Close it to stop."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/recycle_import_server.mjs"

echo ""
read "?Importer stopped. Press Enter to close..."
