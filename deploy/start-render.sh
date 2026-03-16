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

if [ "$SYNC_ON_START" = "1" ] && [ "$SYNC_BLOCKING" = "1" ]; then
  echo "[render-start] startup sync mode=blocking"
  run_state_sync
fi

node --enable-source-maps /app/dist/marketplace-server.js &
MARKETPLACE_PID=$!

if [ "$SYNC_ON_START" = "1" ] && [ "$SYNC_BLOCKING" != "1" ]; then
  echo "[render-start] startup sync mode=background"
  (
    run_state_sync
    echo "[render-start] background state sync finished"
  ) &
  SYNC_PID=$!
fi

DAEMON_PID=""
if [ "${WEATHER_DAEMON_ENABLED:-1}" != "0" ]; then
  node --enable-source-maps /app/dist/weather-oracle-daemon.js &
  DAEMON_PID=$!
else
  echo "[render-start] weather daemon disabled in web service (WEATHER_DAEMON_ENABLED=0)"
fi

cleanup() {
  if [ -n "$SYNC_PID" ]; then
    kill "$SYNC_PID" 2>/dev/null || true
  fi
  if [ -n "$DAEMON_PID" ]; then
    kill "$MARKETPLACE_PID" "$DAEMON_PID" 2>/dev/null || true
  else
    kill "$MARKETPLACE_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM

if [ -n "$DAEMON_PID" ]; then
  wait "$MARKETPLACE_PID" "$DAEMON_PID"
else
  wait "$MARKETPLACE_PID"
fi
