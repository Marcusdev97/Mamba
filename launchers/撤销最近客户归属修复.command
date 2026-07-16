#!/bin/zsh

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
REPORTS=("$ROOT_DIR"/campaign-data/device-ownership/claim-apply-*.json(N.om))
REPORT="${REPORTS[1]}"
if [[ -z "$REPORT" ]]; then
  echo "找不到 claim-apply 报告；没有可自动撤销的迁移批次。"
  read "?按 Enter 关闭..."
  exit 1
fi

DEVICE_ID="$("$NODE" -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.device?.id||""));' "$REPORT")"
SUMMARY="$("$NODE" -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const c={};for(const x of r.applied||[]){const p=x.proposed?.lastSenderPhone||"unknown";c[p]=(c[p]||0)+1}process.stdout.write(Object.entries(c).map(([p,n])=>`${p}: ${n} rows`).join("\n"));' "$REPORT")"

echo "Mamba · 撤销最近客户归属修复"
echo "=============================================="
echo "报告: $REPORT"
echo "Device ID: $DEVICE_ID"
echo "这次 Apply 写入的 sender phone："
echo "$SUMMARY"
echo ""
echo "只会清除这份报告写入且目前仍完全相同的四个 Ownership 字段。"
echo "不会删除客户、回复、Flow、STOP、预约或其他 Notion 资料。"
read "ANSWER?请输入 ROLLBACK 后按 Enter（其他内容取消）: "
if [[ "$ANSWER" != "ROLLBACK" ]]; then
  echo "已取消，没有修改 Notion。"
  read "?按 Enter 关闭..."
  exit 0
fi

"$NODE" campaign-app/device_ownership_repair.mjs --rollback "--report=$REPORT" "--confirm-device=$DEVICE_ID"
RESULT=$?
echo ""
if [[ $RESULT -eq 0 ]]; then
  echo "撤销完成。请继续运行『修复旧客户归属』并绑定正确 sender phone。"
else
  echo "部分 rows 因后续修改或错误而跳过；请查看结果报告，不要手动删除客户。"
fi
read "?按 Enter 关闭..."
exit $RESULT
