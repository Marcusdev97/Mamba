#!/bin/zsh

# SQL 面板 —— 一个入口,底下四件事。
# 双击开,输入数字选，按 Enter。

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
  read "?按 Enter 关闭..."
  exit 1
fi

cd "$ROOT_DIR" || exit 1
quiet() { "$@" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"; }

while true; do
  clear 2>/dev/null || true
  echo "╭──────────────────────────────────────────────╮"
  echo "│  MAMBA · SQL 面板                            │"
  echo "╰──────────────────────────────────────────────╯"
  echo ""
  echo "  1   看数据库          （我自己看，开在这台）"
  echo "  2   给另一台电脑看     （同 Wi-Fi，只读）"
  echo "  3   收另一台的数据     （对方用浏览器上传）"
  echo "  4   立刻同步一次       （送进 Global Postgres + 刷新面板）"
  echo ""
  echo "  q   离开"
  echo ""
  echo -n "选一个 > "
  read choice

  case "$choice" in
    1)
      echo ""
      echo "正在读最新数据…"
      quiet "$NODE" tools/sql-html/build.mjs || { echo "生成失败。"; read "?按 Enter 继续..."; continue; }
      open "$ROOT_DIR/mamba-sql.html"
      echo ""
      echo "已在浏览器打开。面板里的增删改只留在浏览器，要落库请用「导出 SQL」。"
      read "?按 Enter 回到菜单..."
      ;;
    2)
      echo ""
      echo "开只读 server…把印出来的网址发给对方。按 Control-C 停止。"
      echo ""
      quiet "$NODE" tools/sql-html/serve.mjs
      read "?按 Enter 回到菜单..."
      ;;
    3)
      echo ""
      echo "开上传口…把印出来的 /upload 网址发给对方。"
      echo "对方上传前要先关掉他那台的 Mamba。收完按 Control-C 停止。"
      echo ""
      quiet "$NODE" tools/sql-html/serve.mjs --allow-upload
      echo ""
      echo "收到的档案会在下次同步时自动进 Postgres（每天 07:30 / 13:30 / 23:30）。"
      echo "不想等就回菜单选 4。"
      read "?按 Enter 回到菜单..."
      ;;
    4)
      echo ""
      quiet "$NODE" tools/pg/sync-agent.mjs
      echo ""
      read "?按 Enter 回到菜单..."
      ;;
    q|Q)
      exit 0
      ;;
    *)
      echo "  只能输入 1 / 2 / 3 / 4 / q"
      sleep 1
      ;;
  esac
done
