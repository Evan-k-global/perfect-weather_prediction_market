# Developer Setup

This file contains the lower-level implementation and operations details that do not need to live in the top-level README.

## Local Environment

Copy the example env file:

```bash
cp .env.example .env.local
```

Populate `.env.local` with real values for:

- `DEPLOYER_PRIVATE_KEY`
- `ZKAPP_PRIVATE_KEY`
- optional `RELAYER_PRIVATE_KEY`
- `ZEKO_GRAPHQL`
- `ZEKO_NETWORK_ID`
- `TX_FEE`
- `ORACLE_SOURCE_HASH`
- `ORACLE_REQUEST_PATH_HASH`

Relayer note:

- the marketplace server currently prefers `DEPLOYER_PRIVATE_KEY` as the batch signer if it exists
- this was done to avoid signer drift after earlier invalid-signature issues
- `RELAYER_PRIVATE_KEY` remains configurable, but the live default path is deployer-first unless you change that code path intentionally

## Basic Local Run

Terminal 1:

```bash
pnpm build
pnpm marketplace:serve
```

Terminal 2:

```bash
pnpm weather:daemon
```

## Useful zkTLS / Weather Commands

Generate a weather attestation:

```bash
pnpm weather:attest
```

Check strict zkTLS readiness:

```bash
pnpm weather:tls:check
```

Run one strict weather sync:

```bash
pnpm weather:sync
```

Health check the daemon:

```bash
pnpm weather:daemon:health
```

Clean stale local/runtime disk artifacts:

```bash
pnpm cleanup:data
```

Optional retention overrides:

```bash
pnpm cleanup:data -- --keep-contest-days 14 --keep-operator-backups 3 --keep-batch-history 200
```

Automatic daemon cleanup:

- the weather daemon now runs cleanup periodically
- default interval: every 6 hours
- env overrides:
  - `CLEANUP_DATA_INTERVAL_MS`
  - `CLEANUP_KEEP_CONTEST_DAYS`
  - `CLEANUP_KEEP_OPERATOR_BACKUPS`
  - `CLEANUP_KEEP_BATCH_HISTORY`

## Zeko Market Operations

Deploy the zkApp:

```bash
pnpm deploy:zeko
```

Sync local operator state:

```bash
pnpm sync-state:zeko -- --state-file ./data/operator-state.json
```

Ensure deterministic per-date markets exist:

```bash
pnpm ensure-daily-markets:zeko -- --state-file ./data/operator-state.json
```

Resolve one daily market:

```bash
pnpm resolve-daily-market:zeko -- --market-date 2026-03-11 --state-file ./data/operator-state.json
```

## Docker / Render Notes

- Docker and compose files are in `deploy/` and repo root.
- Strict zkTLS on Render requires the Docker path so the vendored `external/zk-verify-poc/tlsnotary` source and compiled Rust binaries exist in the container.
- This app currently relies on shared local disk state under `./data`.

### Unified hosted service

Recommended for demo use:

- one Render web service runs both:
  - `marketplace:serve`
  - `weather:daemon`
- the same service also handles:
  - private batch processing
  - forward daily market creation
  - on-chain resolution

Tradeoff:

- simplest operations
- highest memory usage

For this mode, use the repo-root `render.yaml`, attach a persistent disk at `/app/data`, and provision enough RAM for o1js proving.

### Split hosted services

Recommended for production-hardening:

- web service:
  - `marketplace:serve`
  - optional oracle read APIs
- worker/operator service:
  - hosted operator worker
  - private batch proving
  - ensure/resolve scripts

Tradeoff:

- more moving parts
- cleaner failure isolation
- lower risk of web-instance OOM during proving

Current repo support:

- `render.yaml` now includes:
  - web service: `perfect-weather-prediction-market`
  - worker service: `perfect-weather-operator-worker`
- worker entrypoint:
  - `pnpm operator:worker`

Required worker env:

```bash
OPERATOR_BASE_URL=https://perfect-weather-prediction-market-w6k6.onrender.com
OPERATOR_ACTION_TOKEN=<same token configured on web service>
OPERATOR_WORKER_INTERVAL_MS=30000
OPERATOR_WORKER_RETRY_MS=120000
```

Recommended split settings:

- web service:
  - `PRIVATE_BATCH_INTERVAL_MS=0`
  - `WEATHER_DAEMON_CHAIN_ACTIONS=0`
- worker service:
  - use `OPERATOR_BASE_URL`
  - use the same `OPERATOR_ACTION_TOKEN`

Recommended Render env vars:

```bash
ZEKO_GRAPHQL=https://testnet.zeko.io
ZEKO_NETWORK_ID=testnet
TX_FEE=1200000000

DEPLOYER_PRIVATE_KEY=<your deployer private key>
ZKAPP_PRIVATE_KEY=<your zkapp private key>
RELAYER_PRIVATE_KEY=<same value as DEPLOYER_PRIVATE_KEY>

ORACLE_SOURCE_HASH=15126917236570818645268669871560224562495005605333775632281016101998410458993
ORACLE_REQUEST_PATH_HASH=14957528108931705932653449500339042047303125375030890702920435972538498433663

PRIVACY_MODE=zk_strong
RELAYER_REIMBURSE_DISABLED=1
PRIVATE_BATCH_INTERVAL_MS=30000
PRIVATE_BATCH_MAX_ITEMS=64

WEATHER_REQUIRE_TLSN=1
WEATHER_TLSN_ATTESTATION_FILE=./data/tlsn-output/latest/attestation.json
WEATHER_TLSN_MAX_AGE_MS=3600000
WEATHER_ORACLE_STALE_MS=7200000
WEATHER_ORACLE_EXPIRED_MS=14400000

WEATHER_DAEMON_INTERVAL_MS=1800000
WEATHER_DAEMON_RETRY_MS=120000

CLEANUP_DATA_INTERVAL_MS=21600000
CLEANUP_KEEP_CONTEST_DAYS=14
CLEANUP_KEEP_OPERATOR_BACKUPS=3
CLEANUP_KEEP_BATCH_HISTORY=200

ZKVERIFY_POC_ROOT=/opt/zk-verify-poc
```

If you intentionally split services later, move the heavy operator jobs out of the web service instead of just lowering these intervals.

## More Detail

- operational flow: `docs/operator-runbook.md`
- protocol split: `docs/protocol-vs-demo.md`
- zkTLS integration notes: `docs/zktls-hardening-notes.md`
- payout upgrade notes: `docs/per-date-payout-upgrade.md`
