#!/bin/zsh

# 一键启动 — 从零把整个 Mamba 跑起来,一路带你到「连接号码」的界面:
#   1) 确保 Docker 引擎在跑(Colima 或 Docker Desktop)
#   2) 拉起 Evolution WhatsApp 引擎(:8080)并等它真的健康
#   3) 启动 Campaign Console(:8787)
#   4) 打开控制台网页 —— 在上面「+ 添加号码(扫码)」连接你的号码就能 operate
# 幂等:已经在跑的东西不会重复启动。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$ROOT_DIR/evolution-pilot"
CONSOLE_PORT="${CONSOLE_PORT:-8787}"
EVO_PORT="8080"

NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

echo "🐍 MAMBA | 一键启动"
echo "==================="

# ---------- 1) Docker 引擎 ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 找不到 docker 命令。请先安装并打开 Docker(或 Colima)。"
  read "?Press Enter to close..."; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "▶ 启动 Colima(Docker 引擎)… 第一次可能要一两分钟。"
    colima start
  else
    echo "▶ 正在打开 Docker Desktop…"
    open -a Docker 2>/dev/null
  fi
  echo "  等待 Docker 引擎就绪(最多 120 秒)…"
  for i in {1..120}; do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker 引擎还没就绪。手动跑 'colima start',好了再点本按钮。"
  read "?Press Enter to close..."; exit 1
fi
echo "✔ Docker 引擎就绪"

# ---------- 2) Evolution 引擎(:8080) ----------
COMPOSE=()
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); fi

if (( ${#COMPOSE} )); then
  echo "▶ 拉起 Evolution 容器…"
  ( cd "$COMPOSE_DIR" && $COMPOSE up -d )
else
  echo "❌ 没检测到 docker compose。先用「启动 Evolution」按钮起一次,或安装 Compose。"
  read "?Press Enter to close..."; exit 1
fi

echo "  等 Evolution 在 http://127.0.0.1:${EVO_PORT} 上线(最多 90 秒)…"
EVO_OK=0
for i in {1..90}; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${EVO_PORT}/")"
  if [[ "$code" == "200" || "$code" == "401" ]]; then EVO_OK=1; break; fi
  sleep 1
done
if (( EVO_OK )); then
  echo "✔ Evolution 已上线"
else
  echo "⚠ Evolution 还没起来。最近日志:"
  ( cd "$COMPOSE_DIR" && $COMPOSE logs --tail 15 evolution-api 2>/dev/null )
  echo "  修好上面的报错后再点本按钮。"
  read "?Press Enter to close..."; exit 1
fi

# ---------- 3) Campaign Console(:8787) ----------
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${CONSOLE_PORT}/"; then
  echo "✔ Campaign Console 已经在跑"
else
  echo "▶ 启动 Campaign Console…"
  if [[ ! -x "$NODE" ]]; then
    echo "❌ 找不到 Node.js。"; read "?Press Enter to close..."; exit 1
  fi
  # 从非受保护目录启动(避开 ~/Documents 的 TCC 限制导致的 uv_cwd 报错)
  ( cd "$HOME" 2>/dev/null || cd /; \
    MAMBA_AUTO_OPEN=0 CONSOLE_PORT="$CONSOLE_PORT" nohup "$NODE" "$ROOT_DIR/campaign-app/server.mjs" >/dev/null 2>&1 & )
  for i in {1..30}; do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${CONSOLE_PORT}/" && break
    sleep 1
  done
  echo "✔ Console 已启动"
fi

# ---------- 4) 打开连接号码的界面 ----------
URL="http://127.0.0.1:${CONSOLE_PORT}/numbers"
echo ""
echo "🎉 全部就绪!正在打开控制台:$URL"
echo "   在网页上点「+ 添加号码(扫码)」,用手机 WhatsApp 扫码就能连接号码开始 operate。"
open "$URL"
echo ""
read "?一切都在后台跑着。可以关掉这个窗口。Press Enter to close..."
