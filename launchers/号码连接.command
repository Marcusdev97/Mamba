#!/bin/zsh

# 号码连接 — 一个按钮搞定"号码能发"的所有前置:
#   1) Docker / Evolution 引擎没跑 -> 自动启动(原「启动 Evolution」的逻辑)
#   2) Campaign Console 没跑 -> 自动启动
#   3) 打开「号码连接」页扫码上线
# 幂等:什么都在跑的话,就只是打开网页。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$ROOT_DIR/evolution-pilot"
NET="mamba-evolution"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

PORT="${CONSOLE_PORT:-8787}"
EVO_PORT="8080"
URL="http://127.0.0.1:${PORT}/numbers"

export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"; read "?Press Enter to close..."; exit 1
fi

echo "MAMBA | 号码连接"
echo "================"

# ---------- 1) Evolution 引擎 ----------
evo_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${EVO_PORT}/"; }

if evo_up; then
  echo "✓ Evolution 引擎已在线(:${EVO_PORT})"
else
  echo "Evolution 引擎没在跑,自动启动…"

  if ! command -v docker >/dev/null 2>&1; then
    echo "找不到 docker 命令。请先安装并打开 Docker。"
    read "?Press Enter to close..."; exit 1
  fi

  # Docker 引擎就绪(Colima 优先,退回 Docker Desktop)
  if ! docker info >/dev/null 2>&1; then
    if command -v colima >/dev/null 2>&1; then
      echo "启动 Colima(Docker 引擎)… 第一次可能要一两分钟。"
      colima start
    else
      echo "正在尝试打开 Docker Desktop…"
      open -a Docker 2>/dev/null
    fi
    echo "等待 Docker 引擎就绪(最多 120 秒)…"
    for i in {1..120}; do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker 引擎还没就绪。手动跑一下 'colima start',好了再点本按钮。"
    read "?Press Enter to close..."; exit 1
  fi

  cd "$COMPOSE_DIR" || { echo "找不到 $COMPOSE_DIR"; read "?Press Enter to close..."; exit 1; }

  # 有 Compose 用 Compose,否则 docker run 幂等启动
  COMPOSE=()
  if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); fi

  if (( ${#COMPOSE} )); then
    echo "使用 Compose:${COMPOSE[*]}"
    $COMPOSE up -d
  else
    echo "没检测到 Compose,改用 docker run 启动…"
    PGPASS="$(grep -E 'POSTGRES_PASSWORD:' docker-compose.yml | head -1 | awk '{print $2}')"
    [[ -z "$PGPASS" ]] && PGPASS="evolution"
    docker network inspect "$NET" >/dev/null 2>&1 || { echo "建网络 $NET…"; docker network create "$NET" >/dev/null; }
    ensure() {
      local name="$1"; shift
      [[ "$1" == "--" ]] && shift
      if docker ps --format '{{.Names}}' | grep -qx "$name"; then
        echo "  $name 已在运行"
      elif docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
        echo "  启动已存在的 $name…"; docker start "$name" >/dev/null
      else
        echo "  创建并启动 $name…"; docker run -d --name "$name" --network "$NET" --restart unless-stopped "$@" >/dev/null
      fi
    }
    ensure postgres -- \
      -e POSTGRES_DB=evolution -e POSTGRES_USER=evolution -e POSTGRES_PASSWORD="$PGPASS" \
      -v evolution_postgres:/var/lib/postgresql/data postgres:15-alpine
    ensure redis -- \
      -v evolution_redis:/data redis:7-alpine redis-server --appendonly yes
    echo "  等 postgres 就绪…"
    for i in {1..30}; do
      docker exec postgres pg_isready -U evolution -d evolution >/dev/null 2>&1 && break
      sleep 1
    done
    ensure evolution-api -- \
      --env-file .env -p 127.0.0.1:8080:8080 \
      -v evolution_instances:/evolution/instances evoapicloud/evolution-api:v2.3.7
  fi

  echo "等待 Evolution 上线(最多 60 秒)…"
  for i in {1..60}; do evo_up && break; sleep 1; done
  evo_up && echo "✓ Evolution 引擎已上线" || echo "⚠️ Evolution 还没响应,页面会显示 API 离线;等一会儿点「刷新」即可。"
fi

# ---------- 2) Campaign Console ----------
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "Campaign Console 没在运行,正在启动..."
  cd "$HOME" 2>/dev/null || cd /
  MAMBA_AUTO_OPEN=0 nohup "$NODE" "$ROOT_DIR/campaign-app/server.mjs" >/dev/null 2>&1 &
  for i in {1..15}; do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/" && break; sleep 1; done
fi

# ---------- 3) 打开页面 ----------
echo "打开号码连接:$URL"
open "$URL"
echo ""
read "?Press Enter to close..."
