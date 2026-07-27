#!/bin/zsh

# 开一个只读 server,让同一个 Wi-Fi 下的另一台电脑用浏览器看这台主机的数据库。
# 开起来之后终端机会印出网址(含存取码),贴到那台电脑的浏览器就行,不用装东西。
#
# 只读:那台电脑弄不坏这台的资料,也发不出任何 WhatsApp 讯息。
# 关掉这个视窗或按 Control-C 就停。

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
  read "?Press Enter to close..."
  exit 1
fi

cd "$ROOT_DIR" || exit 1
exec "$NODE" tools/sql-html/serve.mjs "$@"
