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
BOOTSTRAP_DAILY_MARKETS_ON_START="${BOOTSTRAP_DAILY_MARKETS_ON_START:-1}"
BOOTSTRAP_FAST_ZKAPP_ON_START="${BOOTSTRAP_FAST_ZKAPP_ON_START:-1}"
SYNC_PID=""
BOOTSTRAP_PID=""
FAST_ZKAPP_BOOTSTRAP_PID=""

run_state_sync() {
  echo "[render-start] syncing on-chain operator state into ${STATE_FILE}"
  node --enable-source-maps /app/dist/sync-state-zeko.js -- --state-file "${STATE_FILE}"
}

run_bootstrap_daily_markets() {
  echo "[render-start] ensuring rolling daily markets into ${DEMO_DAILY_MARKETS_FILE}"
  node --enable-source-maps /app/dist/ensure-daily-markets-zeko.js -- \
    --state-file "${STATE_FILE}" \
    --daily-markets-file "${DEMO_DAILY_MARKETS_FILE}"
}

run_bootstrap_fast_zkapp() {
  echo "[render-start] ensuring fast zkApp is initialized on-chain"
  node --enable-source-maps /app/dist/bootstrap-fast-zkapp-zeko.js
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

if [ "$BOOTSTRAP_FAST_ZKAPP_ON_START" = "1" ]; then
  (
    sleep 2
    if run_bootstrap_fast_zkapp; then
      echo "[render-start] fast zkApp bootstrap finished"
    else
      echo "[render-start] fast zkApp bootstrap failed"
    fi
  ) &
  FAST_ZKAPP_BOOTSTRAP_PID=$!
fi

if [ "$BOOTSTRAP_DAILY_MARKETS_ON_START" = "1" ]; then
  (
    if [ -n "$FAST_ZKAPP_BOOTSTRAP_PID" ]; then
      wait "$FAST_ZKAPP_BOOTSTRAP_PID" || true
    else
      sleep 2
    fi
    if run_bootstrap_daily_markets; then
      echo "[render-start] startup daily market ensure finished"
    else
      echo "[render-start] startup daily market ensure failed"
    fi
  ) &
  BOOTSTRAP_PID=$!
fi

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
  if [ -n "$FAST_ZKAPP_BOOTSTRAP_PID" ]; then
    kill "$FAST_ZKAPP_BOOTSTRAP_PID" 2>/dev/null || true
  fi
  if [ -n "$BOOTSTRAP_PID" ]; then
    kill "$BOOTSTRAP_PID" 2>/dev/null || true
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
