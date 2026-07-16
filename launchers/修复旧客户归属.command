#!/bin/zsh

# One-time, user-confirmed migration for legacy customers that predate
# Device ID + sender phone ownership fields.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [[ ! -x "$NODE" ]]; then
  for _c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/state/fnm_multishells/*/bin/node(N); do
    [[ -x "$_c" ]] && { NODE="$_c"; break; }
  done
fi

if [[ ! -x "$NODE" ]]; then
  echo "找不到 Node.js。请先安装 Node.js，再重新打开。"
  read "?按 Enter 关闭..."
  exit 1
fi

cd "$ROOT_DIR" || exit 1
echo "Mamba · 修复旧客户归属"
echo "=============================================="
echo "第一步只做 Preview：读取当前 OPEN WhatsApp 的 outbound history，"
echo "不会修改 Notion、不会发送 WhatsApp、不会启动 AI 回复。"
echo ""

"$NODE" campaign-app/device_ownership_repair.mjs --dry-run --claim-current-connections
if [[ $? -ne 0 ]]; then
  echo ""
  echo "Preview 失败。请按上面的错误说明处理后再试。"
  read "?按 Enter 关闭..."
  exit 1
fi

REPORTS=("$ROOT_DIR"/campaign-data/device-ownership/claim-preview-*.json(N.om))
REPORT="${REPORTS[1]}"
if [[ -z "$REPORT" ]]; then
  echo "找不到刚生成的 Claim Preview 报告。"
  read "?按 Enter 关闭..."
  exit 1
fi

DEVICE_ID="$("$NODE" -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.device?.id||""));' "$REPORT")"
CONFIRMED="$("$NODE" -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.summary?.confirmedLocal||0));' "$REPORT")"

echo ""
if [[ "$CONFIRMED" -eq 0 ]]; then
  echo "没有任何客户达到安全补写条件，所以没有修改 Notion。"
  echo "请查看报告中的 conflicts / unresolved 原因：$REPORT"
  read "?按 Enter 关闭..."
  exit 0
fi

echo "准备补写 $CONFIRMED 位确定匹配的客户。"
echo "Device ID: $DEVICE_ID"
echo "报告: $REPORT"
echo ""
echo "确认这些 OPEN WhatsApp connection 的历史客户属于这台 Mac，"
read "ANSWER?请输入 APPLY 后按 Enter（输入其他内容会取消）: "
if [[ "$ANSWER" != "APPLY" ]]; then
  echo "已取消；Notion 没有修改。"
  read "?按 Enter 关闭..."
  exit 0
fi

"$NODE" campaign-app/device_ownership_repair.mjs --apply "--report=$REPORT" "--confirm-device=$DEVICE_ID"
RESULT=$?
echo ""
if [[ $RESULT -eq 0 ]]; then
  echo "修复完成。Customer Desk 将只显示这台 Device 确认拥有的客户。"
  open "http://127.0.0.1:8787/conversations"
else
  echo "修复只完成一部分或失败；请查看上面的 errorCode 和结果报告。"
fi
read "?按 Enter 关闭..."
exit $RESULT
