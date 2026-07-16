#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi
if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"
  read "?按 Enter 关闭..."
  exit 1
fi

cd "$ROOT_DIR" || exit 1
echo "Mamba · 设置本机唯一 WhatsApp 号码"
echo "=============================================="
read "PHONE?请输入完整号码，例如 60168568756: "
PHONE="${PHONE//[^0-9]/}"
"$NODE" campaign-app/device_sender_config.mjs "--phone=$PHONE"
RESULT=$?
echo ""
if [[ $RESULT -eq 0 ]]; then
  echo "设置成功。请关闭并重新打开 Mamba。"
else
  echo "设置失败；Notion 和 WhatsApp 都没有被修改。"
fi
read "?按 Enter 关闭..."
exit $RESULT
