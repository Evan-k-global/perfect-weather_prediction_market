#!/usr/bin/env sh
set -eu

cd /app

mkdir -p ./data/tlsn-output/latest ./data/tlsn-certs

echo "[oracle-worker-start] starting hosted oracle worker"
exec node --enable-source-maps /app/dist/oracle-worker.js
