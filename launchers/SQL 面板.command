#!/bin/zsh

# SQL 面板 —— 本机 SQLite 与 Notion CRM 的维护入口。

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
  echo "│  MAMBA · 本机数据库                         │"
  echo "╰──────────────────────────────────────────────╯"
  echo ""
  echo "  1   查看本机数据库     （SQLite · 只读快照）"
  echo "  2   备份本机数据库     （SQLite · quick_check）"
  echo "  3   打开 Notion CRM"
  echo ""
  echo "  q   离开"
  echo ""
  echo -n "选一个 > "
  read choice

  case "$choice" in
    1)
      echo ""
      echo "正在读取本机 SQLite…"
      quiet "$NODE" tools/sql-html/build.mjs || { echo "生成失败。"; read "?按 Enter 继续..."; continue; }
      open "$ROOT_DIR/mamba-sql.html"
      echo ""
      echo "已打开本机只读快照。页面内的草稿改动不会回写 SQLite。"
      read "?按 Enter 回到菜单..."
      ;;
    2)
      echo ""
      quiet "$NODE" tools/backup-local-database.mjs || { echo "备份失败。"; read "?按 Enter 继续..."; continue; }
      echo ""
      read "?按 Enter 回到菜单..."
      ;;
    3)
      notion_id="$("$NODE" --input-type=module -e 'import fs from "node:fs"; const config=JSON.parse(fs.readFileSync("campaign-data/notion_config.json","utf8")); process.stdout.write(String(config?.databases?.blastLeads || "").replaceAll("-", ""));' 2>/dev/null)"
      if [[ -z "$notion_id" ]]; then
        echo ""
        echo "找不到 Notion Blast Leads database ID。请检查 campaign-data/notion_config.json。"
        read "?按 Enter 回到菜单..."
        continue
      fi
      open "https://www.notion.so/$notion_id"
      echo ""
      echo "已打开 Notion CRM。"
      read "?按 Enter 回到菜单..."
      ;;
    q|Q)
      exit 0
      ;;
    *)
      echo "  只能输入 1 / 2 / 3 / q"
      sleep 1
      ;;
  esac
done
