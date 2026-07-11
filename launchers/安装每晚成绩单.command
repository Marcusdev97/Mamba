#!/bin/zsh

# 每晚成绩单 — 双击一次, 永久生效。
# 装一个 launchd 定时任务: 每晚 22:00 自动跑 daily_scorecard.mjs,
# 把今天的 blast/回复/温度/call 数发去 Telegram「Mamba 系统台」。
# Mac 开着就会发; 22:00 时在睡觉/关机, 开机后 launchd 不补发, 可手动跑一次。
# 再次双击 = 重装/更新 (无害)。要移除: 双击后按提示输入 remove。

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

LABEL="com.mamba.scorecard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$ROOT_DIR/launchd/logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"

echo "MAMBA | 每晚成绩单安装器"
echo "========================"
echo ""

if [[ -f "$PLIST" ]]; then
  echo "已经装过了。直接 Enter = 重装/更新;输入 remove = 移除定时。"
  read "ans?> "
  if [[ "$ans" == "remove" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$PLIST"
    echo "已移除。以后不会再自动发成绩单。"
    read "?Press Enter to close..."
    exit 0
  fi
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT_DIR/campaign-app/daily_scorecard.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>22</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOGS/$LABEL.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$LABEL.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "✅ 装好了。每晚 22:00 自动发成绩单去「Mamba 系统台」。"
else
  echo "⚠️ launchctl 挂载失败 — 试试重启电脑后再双击一次。"
fi

echo ""
echo "现在先给你看一次今天的(只预览,不发送):"
echo "--------------------------------------"
"$NODE" "$ROOT_DIR/campaign-app/daily_scorecard.mjs" --dry

echo ""
read "?Press Enter to close..."
