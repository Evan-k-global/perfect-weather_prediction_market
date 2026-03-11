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
- Current Render recommendation is a single web service that runs both:
  - `marketplace:serve`
  - `weather:daemon`
- This app currently relies on shared local disk state under `./data`.

## More Detail

- operational flow: `docs/operator-runbook.md`
- protocol split: `docs/protocol-vs-demo.md`
- zkTLS integration notes: `docs/zktls-hardening-notes.md`
- payout upgrade notes: `docs/per-date-payout-upgrade.md`
