#!/bin/zsh

# Mamba Watchdog — 双击一次安装，登录 Mac 后常驻。
# 独立检查 Mamba / Docker / Evolution / WhatsApp / Tracker / Brain；只监控和报警，
# 不自动重启 Mamba，避免 Scheduler 或中断的 Campaign 在无人确认时恢复发送。
# Telegram 时间由 Settings 管理；默认同一次异常只报一次，恢复时再报一次。

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

# Docker Desktop 自己退出时，container restart policy 无法把它叫回来。
# 登录项只负责下次登录自动启动 Docker；Watchdog 仍不会自动恢复 Campaign。
if [[ -d "/Applications/Docker.app" ]]; then
  osascript <<'APPLESCRIPT' >/dev/null 2>&1
tell application "System Events"
  if not (exists login item "Docker") then
    make login item at end with properties {name:"Docker", path:"/Applications/Docker.app", hidden:true}
  end if
end tell
APPLESCRIPT
  echo "✓ Docker Desktop 已加入 Mac 登录启动项。"
else
  echo "⚠ 找不到 /Applications/Docker.app；跳过 Docker 登录启动设置。"
fi

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
    <key>MAMBA_WATCHDOG_AUTO_RESTART</key><string>0</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "安装完成。Watchdog 已经常驻；检查与 Telegram 通知时间可在 Mamba Settings 调整。"
  echo "安全模式：只报警，不会自动重启 Mamba 或恢复 Campaign。"
  echo "默认不会发送正常心跳，也不会重复发送同一次异常。"
else
  echo "launchctl 挂载失败。重启 Mac 后再双击一次。"
fi

echo ""
echo "状态文件: $ROOT_DIR/campaign-data/watchdog/status.json"
echo "日志目录: $LOGS"
echo ""
read "?Press Enter to close..."
