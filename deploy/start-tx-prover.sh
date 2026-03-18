#!/usr/bin/env sh
set -eu

cd /app

echo "[tx-prover-start] starting hosted tx prover"
MAX_OLD_SPACE_MB="${TX_PROVER_NODE_MAX_OLD_SPACE_MB:-4096}"
echo "[tx-prover-start] max_old_space_mb=${MAX_OLD_SPACE_MB}"
exec node --max-old-space-size="${MAX_OLD_SPACE_MB}" --enable-source-maps /app/dist/tx-prover-server.js
