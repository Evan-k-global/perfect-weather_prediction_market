#!/usr/bin/env sh
set -eu

cd /app

mkdir -p ./data/tlsn-output/latest ./data/tlsn-certs

STATE_FILE="${STATE_FILE:-./data/operator-state.json}"
DEMO_DAILY_MARKETS_FILE="./data/demo-daily-threshold-markets.json"

if [ ! -f "${DEMO_DAILY_MARKETS_FILE}" ] && [ -f "/app/deploy/demo-daily-threshold-markets.seed.json" ]; then
  cp /app/deploy/demo-daily-threshold-markets.seed.json "${DEMO_DAILY_MARKETS_FILE}"
fi

echo "[render-start] syncing on-chain operator state into ${STATE_FILE}"
node --enable-source-maps /app/dist/sync-state-zeko.js -- --state-file "${STATE_FILE}"

node --enable-source-maps /app/dist/marketplace-server.js &
MARKETPLACE_PID=$!

node --enable-source-maps /app/dist/weather-oracle-daemon.js &
DAEMON_PID=$!

cleanup() {
  kill "$MARKETPLACE_PID" "$DAEMON_PID" 2>/dev/null || true
}

trap cleanup INT TERM

wait "$MARKETPLACE_PID" "$DAEMON_PID"
