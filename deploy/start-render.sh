#!/usr/bin/env sh
set -eu

cd /app

mkdir -p ./data/tlsn-output/latest ./data/tlsn-certs

STATE_FILE="${STATE_FILE:-./data/operator-state.json}"
DEMO_DAILY_MARKETS_FILE="./data/demo-daily-threshold-markets.json"

if [ ! -f "${DEMO_DAILY_MARKETS_FILE}" ] && [ -f "/app/deploy/demo-daily-threshold-markets.seed.json" ]; then
  cp /app/deploy/demo-daily-threshold-markets.seed.json "${DEMO_DAILY_MARKETS_FILE}"
fi

SYNC_ON_START="${SYNC_STATE_ON_START:-1}"
SYNC_BLOCKING="${SYNC_STATE_BLOCKING:-0}"
SYNC_PID=""

run_state_sync() {
  echo "[render-start] syncing on-chain operator state into ${STATE_FILE}"
  node --enable-source-maps /app/dist/sync-state-zeko.js -- --state-file "${STATE_FILE}"
}

mark_ready() {
  printf '{"ready":true,"reason":"%s","at":"%s"}\n' "$1" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > /app/data/startup-ready.json
}

mark_not_ready() {
  printf '{"ready":false,"reason":"%s","at":"%s"}\n' "$1" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > /app/data/startup-ready.json
}

mark_not_ready "starting"

if [ "$SYNC_ON_START" = "1" ] && [ "$SYNC_BLOCKING" = "1" ]; then
  echo "[render-start] startup sync mode=blocking"
  run_state_sync
  mark_ready "blocking startup sync finished"
fi

node --enable-source-maps /app/dist/marketplace-server.js &
MARKETPLACE_PID=$!

if [ "$SYNC_ON_START" = "1" ] && [ "$SYNC_BLOCKING" != "1" ]; then
  echo "[render-start] startup sync mode=background"
  (
    if run_state_sync; then
      echo "[render-start] background state sync finished"
      mark_ready "background startup sync finished"
    else
      echo "[render-start] background state sync failed"
      mark_not_ready "background startup sync failed"
    fi
  ) &
  SYNC_PID=$!
elif [ "$SYNC_ON_START" != "1" ]; then
  mark_ready "startup sync disabled"
fi

cleanup() {
  if [ -n "$SYNC_PID" ]; then
    kill "$SYNC_PID" 2>/dev/null || true
  fi
  kill "$MARKETPLACE_PID" 2>/dev/null || true
}

trap cleanup INT TERM

wait "$MARKETPLACE_PID"
