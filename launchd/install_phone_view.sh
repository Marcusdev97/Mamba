#!/bin/bash
set -euo pipefail

SOURCE="/Users/liuyichen/Documents/Mamba/launchd/com.mamba.phone-view.plist"
TARGET="$HOME/Library/LaunchAgents/com.mamba.phone-view.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SOURCE" "$TARGET"
launchctl bootout "$DOMAIN/com.mamba.phone-view" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$DOMAIN/com.mamba.phone-view"
launchctl kickstart -k "$DOMAIN/com.mamba.phone-view"
echo "Mamba Phone View 已安装并启动。"
