#!/bin/bash
# Mamba lead recovery — re-stamp device ownership so hidden leads reappear.
# Safe: preview writes nothing; apply only sets 4 ownership fields, never sends WhatsApp.
set -e

APPDIR="/Users/marcus/Desktop/Mamba/campaign-app"
OWNDIR="/Users/marcus/Desktop/Mamba/campaign-data/device-ownership"
DEVICE="mamba-e69c1eb2-8b02-43a1-91fe-5eade52c6d58"
SENDER="60168568756"

# Find node (handles nvm / homebrew / volta / fnm). Bash-safe: unmatched globs are skipped.
NODE="$(command -v node 2>/dev/null || true)"
if [ ! -x "$NODE" ]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/state/fnm_multishells/*/bin/node; do
    [ -x "$_c" ] && { NODE="$_c"; break; }
  done
fi
if [ ! -x "$NODE" ]; then
  echo "找不到 Node.js。请先打开一次 Mamba Control Center，再运行本脚本。"
  exit 1
fi
echo "Using node: $NODE"

cd "$APPDIR"

echo "=================================================="
echo " STEP 1/2 - PREVIEW (no writes, safe)"
echo "=================================================="
"$NODE" device_ownership_repair.mjs --dry-run --claim-current-connections --expected-sender="$SENDER"

REPORT=$(ls -t "$OWNDIR"/claim-preview-*.json | head -1)
echo
echo "Newest preview report: $REPORT"
echo
echo "Check above: '确定属于本机' (confirmed local) should be ~1177 and 冲突 (conflicts) = 0."
read -p "Type  YES  then Enter to write ownership to Notion (anything else cancels): " OK
if [ "$OK" != "YES" ]; then
  echo "Cancelled. Nothing was written."
  exit 1
fi

echo
echo "=================================================="
echo " STEP 2/2 - APPLY (writes 4 ownership fields only)"
echo "=================================================="
"$NODE" device_ownership_repair.mjs --apply --report="$REPORT" --confirm-device="$DEVICE"

echo
echo "Done. Go to the Inbox and click Refresh - your leads should reappear."
