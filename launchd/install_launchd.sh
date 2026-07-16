#!/bin/bash
# install_launchd.sh — 缺口 5: Mac Mini 常驻 (launchd 开机自启).
#
# 在 Mac Mini 上跑一次:
#   cd <repo>/launchd && bash install_launchd.sh
# 卸载:
#   bash install_launchd.sh --uninstall
#
# 装 3 个后台维护任务。Reply Tracker / Sales Brain 由 Mamba Server 按
# Settings 的安全开关统一管理，避免多个 launchd/command 抢同一个 webhook。
#   com.mamba.braincache   brain_cache_sync --watch — 每 30 分钟 Notion -> 本地知识缓存
#   com.mamba.suppression  suppression.mjs          — 每 30 分钟同步全局 STOP 名单
#   com.mamba.scorecard    daily_scorecard.mjs      — 每晚 22:00 成绩单 -> Mamba 系统台
#
# 前提: Evolution API 的 Docker 已设 restart=always (docker update --restart=always <container>)
# 日志: <repo>/launchd/logs/*.log

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$REPO/launchd/logs"
LABELS=(com.mamba.braincache com.mamba.suppression com.mamba.scorecard)
LEGACY_LABELS=(com.mamba.brain com.mamba.tracker)

if [[ "${1:-}" == "--uninstall" ]]; then
  for label in "${LABELS[@]}" "${LEGACY_LABELS[@]}"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$AGENTS/$label.plist"
    echo "removed $label"
  done
  exit 0
fi

# Remove reply services created by older versions. The unified Mamba Server now
# owns these processes and their webhook lifecycle.
for label in "${LEGACY_LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$AGENTS/$label.plist"
done

[[ -z "$NODE" ]] && { echo "找不到 node — 先装 Node.js (brew install node)"; exit 1; }
mkdir -p "$AGENTS" "$LOGS"

# $1=label  $2=program args (xml)  $3=schedule block (xml)
write_plist() {
  cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array>
$2
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
$3
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
}

KEEPALIVE='  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>'
EVERY30='  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>'

write_plist com.mamba.braincache "    <string>$NODE</string>
    <string>$REPO/campaign-app/brain_cache_sync.mjs</string>
    <string>--watch</string>" "$KEEPALIVE"

write_plist com.mamba.suppression "    <string>$NODE</string>
    <string>$REPO/campaign-app/suppression.mjs</string>" "$EVERY30"

NIGHTLY22='  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>22</integer>
    <key>Minute</key><integer>0</integer>
  </dict>'

write_plist com.mamba.scorecard "    <string>$NODE</string>
    <string>$REPO/campaign-app/daily_scorecard.mjs</string>" "$NIGHTLY22"

for label in "${LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "loaded $label"
done

echo ""
echo "全部装好。检查: launchctl list | grep com.mamba"
echo "看日志:      tail -f $LOGS/com.mamba.brain.log"
echo "笔电远程:    装 Tailscale 后浏览器开 http://<mac-mini>:8798 (面板) / :8799 (brain 状态)"
