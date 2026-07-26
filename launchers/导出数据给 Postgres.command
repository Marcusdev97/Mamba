#!/bin/zsh

# 把本机 SQLite 导成 Postgres 可以直接跑的两个文件:
#   docs/mamba-schema.postgres.sql   建表(只需第一次,或 schema 改过)
#   mamba-data.pg.sql                全量数据(可重复跑)
#
# 这个脚本不会连你的数据库,也不碰密码 —— 只生成文件,最后把上传命令印出来。
# 第二台电脑往同一个库推数据时,用下面印出的 --if-newer 那条。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。"
  read "?Press Enter to close..."
  exit 1
fi

run() { "$NODE" "$@" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"; }

echo "1/2 生成建表脚本..."
run "$ROOT_DIR/tools/pg/build-postgres.mjs" || { read "?Press Enter to close..."; exit 1; }
echo ""
echo "2/2 导出全量数据(--if-newer:只覆盖比库里更新的行)..."
run "$ROOT_DIR/tools/pg/dump-data.mjs" --if-newer || { read "?Press Enter to close..."; exit 1; }

echo ""
echo "────────────────────────────────────────────────────────"
echo "接下来在终端机跑(把 \$DATABASE_URL 换成你的连接串):"
echo ""
echo "  cd \"$ROOT_DIR\""
echo "  psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f docs/mamba-schema.postgres.sql"
echo "  psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f mamba-data.pg.sql"
echo ""
echo "建表那条只有第一次(或改过 schema)才需要跑。"
echo "────────────────────────────────────────────────────────"
echo ""
read "?Press Enter to close..."
