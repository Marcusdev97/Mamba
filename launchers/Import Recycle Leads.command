#!/bin/zsh

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
