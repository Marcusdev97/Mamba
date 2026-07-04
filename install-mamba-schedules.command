#!/bin/zsh
# Mamba 定时任务安装器 (launchd)
#  - 每晚 22:00 (Mac 本地时间)：upload 当晚 blast leads → Notion，再跑 nightly summary → Telegram
#  - 每早 08:45：morning follow-up（结算回复 + 推今天要跟进的人 → Telegram）
# 不改你 Mamba 文件夹里的任何东西。配置文件放在 ~/Library/LaunchAgents。

set -e

LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
mkdir -p "$LA" "$LOGS"

echo "写入定时配置..."

cat > "$LA/com.mamba.nightly.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mamba.nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/marcus/Desktop/Mamba/campaign-app &amp;&amp; node notion_upload.mjs ; node nightly_summary.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/marcus/Library/Logs/mamba-nightly.log</string>
  <key>StandardErrorPath</key><string>/Users/marcus/Library/Logs/mamba-nightly.log</string>
</dict>
</plist>
PLIST

cat > "$LA/com.mamba.morning.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mamba.morning</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/marcus/Desktop/Mamba/campaign-app &amp;&amp; node morning_followup.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>45</integer></dict>
  <key>StandardOutPath</key><string>/Users/marcus/Library/Logs/mamba-morning.log</string>
  <key>StandardErrorPath</key><string>/Users/marcus/Library/Logs/mamba-morning.log</string>
</dict>
</plist>
PLIST

MYUID=$(id -u)
for L in com.mamba.nightly com.mamba.morning; do
  launchctl bootout "gui/$MYUID" "$LA/$L.plist" 2>/dev/null || true
  launchctl bootstrap "gui/$MYUID" "$LA/$L.plist"
  launchctl enable "gui/$MYUID/$L"
done

echo ""
echo "✅ 装好了！"
echo "   • 每晚 22:00  → upload + nightly summary"
echo "   • 每早 08:45  → morning follow-up"
echo ""
echo "想立刻测一次今晚那条（会真的上传 + 发 Telegram）："
echo "   launchctl start com.mamba.nightly"
echo ""
echo "看运行日志："
echo "   tail -f ~/Library/Logs/mamba-nightly.log"
echo "   tail -f ~/Library/Logs/mamba-morning.log"
echo ""
echo "以后想取消："
echo "   launchctl bootout gui/$MYUID/com.mamba.nightly"
echo "   launchctl bootout gui/$MYUID/com.mamba.morning"
echo ""
read "?完成。按 Enter 关闭..."
