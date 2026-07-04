#!/bin/zsh

# 一次性修复:昨天(7/2)那次 LIVE run 发出去了 227 个 Flow 3,但自动推进被中途
# 打断,只推了 105 个。这个脚本把"已经收到 Flow 3、却还停在 Flow 3"的其余人
# 补推进到 Flow 4。安全:已经在 Flow 4 的、说不发的,都会自动跳过,不会重复推进。

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"; read "?Press Enter to close..."; exit 1
fi

RUN="$ROOT_DIR/campaign-data/runs/run_2026-07-02T04-48-43-015Z.json"

echo "补推进:昨天发过 Flow 3、但没被推进的人 → Flow 4"
echo "(已在 Flow 4 的、说不发的会自动跳过)"
echo ""

"$NODE" "$ROOT_DIR/campaign-app/advance_flow.mjs" "$RUN" --sent-flow="Flow 3 - Location"

echo ""
read "?Done. Press Enter to close..."
