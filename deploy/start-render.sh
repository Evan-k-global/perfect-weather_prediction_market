#!/usr/bin/env sh
set -eu

mkdir -p /app/data/tlsn-output/latest /app/data/tlsn-certs

node --enable-source-maps /app/dist/marketplace-server.js &
MARKETPLACE_PID=$!

node --enable-source-maps /app/dist/weather-oracle-daemon.js &
DAEMON_PID=$!

cleanup() {
  kill "$MARKETPLACE_PID" "$DAEMON_PID" 2>/dev/null || true
}

trap cleanup INT TERM

wait "$MARKETPLACE_PID" "$DAEMON_PID"
