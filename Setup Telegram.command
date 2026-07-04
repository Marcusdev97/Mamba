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

echo "MAMBA | SETUP TELEGRAM"
echo "======================"
echo "Make sure you have opened your bot in Telegram and sent it any message"
echo "(e.g. hi) first. This will find your chat id and save it."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/setup_telegram.mjs"

echo ""
read "?Press Enter to close..."
