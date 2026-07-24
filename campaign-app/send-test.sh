#!/usr/bin/env bash
# Quick blast trigger for the Mamba campaign console (port 8787).
# Usage:
#   ./send-test.sh test "Marcus, 60123456789, en"   # TEST run to one recipient
#   ./send-test.sh live YOUR_PROJECT 50             # LIVE run, cap 50 leads
#   ./send-test.sh status                            # progress snapshot
#   ./send-test.sh stop                              # halt current run
set -euo pipefail
BASE="http://127.0.0.1:8787"
cmd="${1:-status}"

case "$cmd" in
  test)
    recipients="${2:-Marcus, 60123456789, en}"
    echo "== prepare (TEST) =="
    curl -sS -X POST "$BASE/api/prepare" -H "Content-Type: application/json" \
      -d "{\"mode\":\"TEST\",\"testRecipients\":\"$recipients\"}"; echo
    echo "== start =="
    curl -sS -X POST "$BASE/api/start" -H "Content-Type: application/json" -d '{}'; echo
    ;;
  live)
    project="${2:?pass a project name: ./send-test.sh live PROJECT [leadCount]}"
    count="${3:-}"
    body="{\"project\":\"$project\",\"mode\":\"LIVE\""
    [ -n "$count" ] && body="$body,\"leadCount\":$count"
    body="$body}"
    echo "== prepare (LIVE) =="
    curl -sS -X POST "$BASE/api/prepare" -H "Content-Type: application/json" -d "$body"; echo
    echo "== start (optIn) =="
    curl -sS -X POST "$BASE/api/start" -H "Content-Type: application/json" -d '{"optIn":true}'; echo
    ;;
  status) curl -sS "$BASE/api/status"; echo ;;
  stop)   curl -sS -X POST "$BASE/api/stop"; echo ;;
  *) echo "unknown command: $cmd (use test|live|status|stop)"; exit 1 ;;
esac
