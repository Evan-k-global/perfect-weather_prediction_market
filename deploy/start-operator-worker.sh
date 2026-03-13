#!/usr/bin/env sh
set -eu

cd /app

echo "[operator-worker-start] starting hosted operator worker"
node --enable-source-maps /app/dist/operator-worker.js
