#!/bin/zsh

# 重新生成 SQL 面板(读一次本机 mamba.sqlite 的快照)然后打开。
# 面板是只读快照 + 浏览器里的草稿改动,不会写回数据库。

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

echo "正在从 campaign-data/mamba.sqlite 生成面板..."
echo ""
if ! "$NODE" "$ROOT_DIR/tools/sql-html/build.mjs" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"; then
  echo ""
  echo "生成失败。"
  read "?Press Enter to close..."
  exit 1
fi

echo ""
echo "打开面板..."
open "$ROOT_DIR/mamba-sql.html"
echo ""
echo "提示:面板里的增删改只留在浏览器,要落库请用「导出 SQL」。"
echo ""
read "?Press Enter to close..."
