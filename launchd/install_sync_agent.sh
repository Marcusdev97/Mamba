#!/bin/bash
# install_sync_agent.sh — Sync Agent 排程(每台电脑各装一次).
#
# 装一个后台任务,把本机 SQLite 定时同步进 Global PostgreSQL:
#   com.mamba.syncagent   tools/pg/sync-agent.mjs   — 每天 07:30 / 13:30 / 23:30
#
# 每次会做:同步本机 SQLite → Global Postgres,吸收 incoming/ 里别台上传的档案,
# 最后重新生成 mamba-sql.html。所以早上打开面板看到的就是昨晚 23:30 的最新资料。
#
# 它同时会吸收 campaign-data/incoming/ 里别台电脑上传的 .sqlite,同步完自动归档。
#
# 装:    cd <repo>/launchd && bash install_sync_agent.sh
# 卸载:  bash install_sync_agent.sh --uninstall
# 状态:  bash install_sync_agent.sh --status
# 立刻跑一次(不用等排程): launchctl kickstart -k gui/$(id -u)/com.mamba.syncagent
#
# 前提: 仓库根目录要有 .env.pg(一行连线字串),或环境变数 DATABASE_URL。
# 日志: <repo>/launchd/logs/com.mamba.syncagent.log(错误在 .err.log)
#
# 刻意和 install_launchd.sh 分开:那支管的是 Mac Mini 的常驻维护任务,
# 这支是每台电脑都要装的同步器,分开装/卸不会互相影响。

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$REPO/launchd/logs"
LABEL=com.mamba.syncagent
PLIST="$AGENTS/$LABEL.plist"

case "${1:-}" in
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    exit 0
    ;;
  --status)
    echo "launchctl:"
    launchctl list | grep "$LABEL" || echo "  (没装)"
    echo ""
    echo "最近的日志:"
    tail -n 15 "$LOGS/$LABEL.log" 2>/dev/null || echo "  (还没有日志)"
    exit 0
    ;;
esac

[[ -z "$NODE" ]] && { echo "找不到 node — 先装 Node.js (brew install node)"; exit 1; }
if [[ ! -f "$REPO/.env.pg" && -z "${DATABASE_URL:-}" ]]; then
  echo "⚠ 找不到 $REPO/.env.pg,也没有 DATABASE_URL。"
  echo "  先建一个,内容一行:"
  echo "    postgresql://user@localhost:5432/mamba_global"
  exit 1
fi

# 先手动验一次,不能跑就别装排程 —— 免得每天默默失败没人发现
echo "先试跑一次(dry-run)…"
if ! "$NODE" "$REPO/tools/pg/sync-agent.mjs" --dry-run; then
  echo "✗ 试跑没过,先修好再装排程。"
  exit 1
fi

mkdir -p "$AGENTS" "$LOGS"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/tools/pg/sync-agent.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>23</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$LOGS/$LABEL.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$LABEL.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "loaded $LABEL"

echo ""
echo "装好了。每天 07:30 / 13:30 / 23:30 各跑一次(同步 Postgres + 刷新 SQL 面板)。"
echo "  立刻跑一次:  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "  看状态:      bash launchd/install_sync_agent.sh --status"
echo "  看日志:      tail -f $LOGS/$LABEL.log"
echo "  卸载:        bash launchd/install_sync_agent.sh --uninstall"
