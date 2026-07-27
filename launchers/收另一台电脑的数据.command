#!/bin/zsh

# 开一个 server,让另一台电脑用浏览器把它的 mamba.sqlite 传过来。
#
# 那台电脑要做的事:开网址 → 选档案 → 按上传。不用装任何东西。
# 收到的档案存进 campaign-data/incoming/,**不会覆盖这台自己的资料库**。
#
# 传完之后这台终端机会印出「怎么看它 / 怎么合并到 Postgres」的命令。
# 关掉这个视窗或按 Control-C 就停 —— 收完就关掉,别一直开着。

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

echo "════════════════════════════════════════════════════════"
echo " 收另一台电脑的数据"
echo ""
echo " 把下面印出的网址后面加上 /upload 发给那台电脑,例如:"
echo "   http://192.168.x.x:8900/upload?key=xxxx"
echo ""
echo " 那台电脑上传前记得先关掉 Mamba。"
echo "════════════════════════════════════════════════════════"
echo ""

cd "$ROOT_DIR" || exit 1
exec "$NODE" tools/sql-html/serve.mjs --allow-upload "$@"
