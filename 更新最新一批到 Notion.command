#!/bin/zsh

# 手动补推进"最新一批"到 Notion —— 万一发完后自动推进没跑完(比如中途重启了
# Console),点这个把已发出去的人补推进到下一轮。可以重复点:已经推进过的、说
# 不发的、没发到的,都会自动跳过,不会重复推进。只动 Notion,不用开 Docker。

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"; read "?Press Enter to close..."; exit 1
fi

echo "补推进最新一批到 Notion(把已发出去的人推进到下一轮)..."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/advance_flow.mjs" --latest

echo ""
read "?Done. Press Enter to close..."
