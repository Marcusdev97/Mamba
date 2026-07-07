#!/bin/zsh

# Realtime WhatsApp reply tracker. Listens for incoming customer replies via the
# Evolution API webhook and records them instantly (text + voice/image/sticker).
# Keep this window open while you want live tracking. Close it to stop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

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
