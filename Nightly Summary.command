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

echo "MAMBA | NIGHTLY SUMMARY"
echo "======================="
echo "Counting today's calls, blasts and new ad leads, then sending to Telegram."
echo "Tip: upload today's call records to Notion BEFORE running this."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/nightly_summary.mjs"

echo ""
read "?Press Enter to close..."
