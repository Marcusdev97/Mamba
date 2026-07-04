#!/bin/zsh

# Start Evolution — 一键把 WhatsApp 引擎(Evolution，跑在 Docker 里)启动起来。
# 优先用 Compose;如果这台机器没装 Compose(只有 docker CLI),自动改用
# docker run 建网络 + 三个容器。幂等:容器已存在就直接 start。
# 启动后号码会在 http://127.0.0.1:8080 上线。

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$ROOT_DIR/evolution-pilot"
NET="mamba-evolution"

export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

echo "MAMBA | 启动 Evolution"
echo "====================="

if ! command -v docker >/dev/null 2>&1; then
  echo "找不到 docker 命令。请先安装并打开 Docker。"
  read "?Press Enter to close..."; exit 1
fi

# 1) 等 Docker 引擎就绪。本机用 Colima,优先启动它;否则退回 Docker Desktop。
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
  echo "Docker 引擎还没就绪。手动跑一下 'colima start' 等它好了再点本按钮。"
  read "?Press Enter to close..."; exit 1
fi

cd "$COMPOSE_DIR" || { echo "找不到 $COMPOSE_DIR"; read "?Press Enter to close..."; exit 1; }

# 2a) 有 Compose 就用 Compose
COMPOSE=()
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); fi

if (( ${#COMPOSE} )); then
  echo "使用 Compose:${COMPOSE[*]}"
  $COMPOSE up -d
  echo ""; $COMPOSE ps
  echo ""; echo "Evolution 应在 http://127.0.0.1:8080 上线。回 Console 点「刷新」。"
  read "?Press Enter to close..."; exit 0
fi

# 2b) 没有 Compose —— 用 docker run 手动起(幂等)
echo "没检测到 Compose,改用 docker run 启动…"

PGPASS="$(grep -E 'POSTGRES_PASSWORD:' docker-compose.yml | head -1 | awk '{print $2}')"
[[ -z "$PGPASS" ]] && PGPASS="evolution"

docker network inspect "$NET" >/dev/null 2>&1 || { echo "建网络 $NET…"; docker network create "$NET" >/dev/null; }

# helper:幂等启动一个容器。用法:ensure NAME -- <docker run 参数...>
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

echo ""
docker ps --filter "network=$NET" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ""
echo "Evolution 应在 http://127.0.0.1:8080 上线。回 Console 点「刷新」;号码没连上就「+ 添加号码(扫码)」。"
read "?Press Enter to close..."
