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
