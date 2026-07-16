#!/bin/zsh

# Mamba Watchdog — 双击一次安装，登录 Mac 后常驻。
# 独立检查 Mamba / WhatsApp / Tracker / Brain；主程序掉线时尝试重启，
# 并把掉线、恢复和每小时心跳发去 Telegram 系统台。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。先安装 Node，再重新双击。"
  read "?Press Enter to close..."
  exit 1
fi

LABEL="com.mamba.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$ROOT_DIR/launchd/logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"

echo "MAMBA | Watchdog 安装器"
echo "======================="
echo ""

if [[ -f "$PLIST" ]]; then
  echo "已经装过。直接 Enter = 重装/更新；输入 remove = 移除。"
  read "ans?> "
  if [[ "$ans" == "remove" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$PLIST"
    echo "已移除 Mamba Watchdog。"
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
    <string>$ROOT_DIR/campaign-app/mamba_watchdog.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
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
  echo "安装完成。Watchdog 已经常驻，每 30 秒检查一次。"
  echo "Telegram 会收到启动心跳、掉线、恢复和每小时心跳。"
else
  echo "launchctl 挂载失败。重启 Mac 后再双击一次。"
fi

echo ""
echo "状态文件: $ROOT_DIR/campaign-data/watchdog/status.json"
echo "日志目录: $LOGS"
echo ""
read "?Press Enter to close..."
