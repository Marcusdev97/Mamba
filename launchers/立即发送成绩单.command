#!/bin/zsh

# 立即发送今日成绩单 — 双击马上把今天的 blast/回复/温度/call 数发去 Telegram。
# 用途:
#   1. 测试:确认成绩单能真的发到 Telegram(不是只预览)。
#   2. 补发:22:00 那会儿 Mac 在睡觉/关机,launchd 没自动发 -> 手动补一发。
# 想只看不发,用 "安装每晚成绩单.command" 里的预览,或加 --dry。

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

echo "MAMBA | 立即发送今日成绩单"
echo "=========================="
echo ""

"$NODE" "$ROOT_DIR/campaign-app/daily_scorecard.mjs"

echo ""
read "?Press Enter to close..."
