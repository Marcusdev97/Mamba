#!/bin/zsh

# Mamba Sales Brain — AI 回复引擎 (Layer 1 + Layer 2)。
#
# 这个 launcher 会按正确顺序起两个服务:
#   1. blaster_tracker --no-webhook  (记录/统计, 不抢 webhook)
#   2. brain_service                 (唯一回复出口, 拥有 Evolution webhook,
#                                     并把每个 payload 转发给 tracker)
#
# 客户回复 -> brain 分类 -> 简单的自动回罐头 / 复杂的 AI 起草 -> Telegram 按钮
# [✅照发 | ✏️改后发 | 🙋接管] -> 你按了才发。关掉这个窗口 = 两个服务都停。
#
# Reply Intake 是内部记录层,会由这个 launcher 一起启动,不需要单独操作。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

# Run node from a non-protected cwd (macOS can deny getcwd() inside protected
# folders). The scripts use absolute paths internally, so cwd does not matter.
cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Starting Mamba Sales Brain..."
echo "  1/2 Reply Intake (background record service)"
"$NODE" "$ROOT_DIR/campaign-app/blaster_tracker.mjs" --no-webhook &
TRACKER_PID=$!

cleanup() {
  kill "$TRACKER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

sleep 2
echo "  2/2 Brain Service (owns webhook, replies need your Telegram approval)"
echo ""
echo "Keep this window open. Close it to stop BOTH services."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/brain_service.mjs"

echo ""
read "?Brain stopped. Press Enter to close..."
