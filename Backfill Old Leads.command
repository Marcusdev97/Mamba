#!/bin/zsh

# Backfill Old Leads — ONE-TIME migration. Brings leads that were blasted before
# the flow upgrade (Status = "Blasted", no Sequence Status) into the automatic
# sequence so they can continue to Flow 2.
#
# It first sweeps WhatsApp history and stops/flags anyone who already replied,
# then enrolls the rest as "Flow 1 done -> Flow 2 next" with Follow Up Due =
# their original blast date + 2 days. Needs Evolution (Docker) online for the
# reply sweep; it aborts before enrolling if Evolution can't be reached.
#
# Tip: to preview without writing, run with --dry-run in Terminal.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/liuyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

cd "$HOME" 2>/dev/null || cd /

if [[ ! -x "$NODE" ]]; then
  echo "The bundled Node.js runtime was not found."
  read "?Press Enter to close..."
  exit 1
fi

echo "Backfilling old leads into the flow system (sweep replies, then enroll)..."
echo "Make sure Evolution (Docker) is running."
echo ""

"$NODE" "$ROOT_DIR/campaign-app/backfill_flow_state.mjs"

echo ""
read "?Done. Press Enter to close..."
