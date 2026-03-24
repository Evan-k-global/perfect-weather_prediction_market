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
pnpm oracle:worker
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
curl -s http://127.0.0.1:8790/api/health
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

## Current timing semantics

- daily weather markets use a `9pm Pacific` cutoff
- before `9pm`, the current market date is the active date
- at or after `9pm`, the active market date advances to the next calendar date
- same-day manual resolution is blocked before `9pm` unless `ALLOW_EARLY_SAME_DAY_RESOLUTION=1` is set intentionally for debugging

## Fresh zkApp epoch notes

Use a fresh zkApp deployment when you change:

- payout math in the contract
- market close-slot semantics
- receipt-claim roots or verification key layout

Treat a new zkApp as a new epoch:

- old markets and receipts do not carry forward automatically
- oracle should recreate the rolling daily markets on the new address
- hosted services should be redeployed together after env key updates

## Docker / Render Notes

- Docker and compose files are in `deploy/` and repo root.
- Strict zkTLS on Render requires the Docker path so the vendored `external/zk-verify-poc/tlsnotary` source and compiled Rust binaries exist in the container.
- This app currently relies on shared local disk state under `./data`.

### Split hosted services

Recommended for production-hardening:

- web service:
  - `marketplace:serve`
  - fast state sync and UI APIs
- oracle worker:
  - `oracle:worker`
  - weather sync
  - daily market creation
  - overdue market resolution
- tx prover:
  - `tx-prover:serve`
  - bet and claim proving only

Tradeoff:

- more moving parts
- cleaner failure isolation
- lower risk of web-instance OOM during proving
- leaner service-specific images

Current repo support:

- `render.yaml` now includes:
  - web service: `perfect-weather-prediction-market`
  - worker service: `perfect-weather-oracle-worker`
  - prover service: `perfect-weather-tx-prover`

Recommended split settings:

- web service:
  - `SYNC_STATE_ON_START=1`
  - `SYNC_STATE_BLOCKING=0`
- oracle worker:
  - use `MARKET_BASE_URL`
  - use the same `ORACLE_ACTION_TOKEN`

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

## Hosted proving reliability notes

- a raw `Field.assertEquals(): <a> != <b>` during hosted proving almost always means stale market or receipt witnesses, not bad user signatures
- the market service now retries stale proving multiple times after state refresh
- the tx-prover now preflights current on-chain roots before entering `tx.prove()` so stale contexts can fail cleanly instead of crashing the instance
- if wallet activity shows a recent bet but on-chain pool totals stay at zero, treat the hosted entry as optimistic metadata until inclusion is confirmed

## More Detail

- operational flow: `docs/operator-runbook.md`
- protocol split: `docs/protocol-vs-demo.md`
- zkTLS integration notes: `docs/zktls-hardening-notes.md`
- payout upgrade notes: `docs/per-date-payout-upgrade.md`
