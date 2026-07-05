#!/bin/zsh

# Realtime WhatsApp reply tracker. Listens for incoming customer replies via the
# Evolution API webhook and records them instantly (text + voice/image/sticker).
# Keep this window open while you want live tracking. Close it to stop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

# Run node from a non-protected cwd (macOS can deny getcwd() inside protected
# folders). The script uses absolute paths internally, so cwd does not matter.
cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Starting Mamba Live Reply Tracker..."
echo "It connects the WhatsApp webhook and opens a dashboard in your browser."
echo "Keep this window open to keep tracking replies live. Close it to stop."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/blaster_tracker.mjs" --open

echo ""
read "?Tracker stopped. Press Enter to close..."
