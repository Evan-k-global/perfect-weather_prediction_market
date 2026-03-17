#!/usr/bin/env sh
set -eu

cd /app

echo "[operator-worker-start] starting hosted operator worker"
MAX_OLD_SPACE_MB="${OPERATOR_NODE_MAX_OLD_SPACE_MB:-1536}"
echo "[operator-worker-start] max_old_space_mb=${MAX_OLD_SPACE_MB}"
exec node --max-old-space-size="${MAX_OLD_SPACE_MB}" --enable-source-maps /app/dist/operator-worker.js
