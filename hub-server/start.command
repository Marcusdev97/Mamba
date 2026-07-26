#!/bin/bash
# 双击这个档案就能开中央 Server。
# 关掉视窗或按 Control-C 就停。
cd "$(dirname "$0")/.." || exit 1
exec node hub-server/server.mjs "$@"
