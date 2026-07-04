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

echo "SET NOTION TOKEN"
echo "================"
echo "Paste your Notion integration secret/token below."
echo "It starts with something like ntn_ or secret_."
echo ""

read -s "?Notion token: " TOKEN
echo ""

if [[ -z "$TOKEN" ]]; then
  echo "No token entered."
  read "?Press Enter to close..."
  exit 1
fi

NOTION_TOKEN_INPUT="$TOKEN" "$NODE" "$ROOT_DIR/campaign-app/set_notion_token.mjs"
echo ""
read "?Press Enter to close..."
