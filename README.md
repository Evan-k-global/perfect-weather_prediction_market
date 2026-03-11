# Private Prediction Market Demo

A Zeko testnet prediction market demo with:

- real on-chain daily markets
- wallet-signed betting
- private live bet intent via batching
- zkTLS-backed weather oracle verification
- rolling 6-day Atherton weather over/under markets

## Quick Deployer Summary

### Reusable protocol pieces

- zkApp contract and market state roots
- wallet tx build/finalize flow
- private bet batching path
- zkTLS oracle verification path
- Zeko deployment + sync scripts

### Demo-specific pieces

- Atherton, CA weather market
- daily locked threshold logic
- oracle widget + weather visualizer
- rolling 6-day UI

### What is private

- live bet intent is batched and not exposed as a simple direct public market-side update
- aggregate market state remains public
- wallet activity remains public on-chain

### Fast start

```bash
pnpm install
pnpm build
pnpm marketplace:serve
```

Open `http://127.0.0.1:8790/marketplace`

### Docs

- protocol vs demo: `docs/protocol-vs-demo.md`
- operator runbook: `docs/operator-runbook.md`
- zkTLS notes: `docs/zktls-hardening-notes.md`
- docs index: `docs/index.md`


### Agents plug in here

The repo already exposes an agent/model integration surface:

- model registry: `/api/agents`
- private order creation: `/api/orders/create`
- relayer/model execution: `/api/orders/:id/relay-run`
- reveal + settlement: `/api/orders/:id/reveal-settle`

That means agents can act as private signal providers, model vendors, or relayed execution services on top of the same market/oracle protocol.


# Prediction Market zkApp (v1 scaffold)

`o1js` scaffold for a private-position prediction market with:

- permissionless market creation (arbitrary markets via `configHash`)
- public aggregate per-market totals (`totalPositionBet`, `totalYesPositionBet`)
- weather-style oracle resolution payloads with replay protection
- event stream for off-chain ranking (`top by total bet`, `ending soon`)

## Notes

- Individual user position amounts are represented by `positionsRoot` updates and transition digests.
- TLSNotary verification is expected to happen in an oracle/prover service; this contract verifies a compact statement shape and policy bindings.
- Ranking should be computed off-chain from market events and mirrored in UI/indexer.
- Environment policy (hard rule for this app): runtime config is loaded from project `.env` and `.env.local` (not shell-only exports). `.env.local` overrides `.env`.
- Secret policy: never commit real keys; commit `.env.example` only.

## Protocol vs Demo

- docs index: `docs/index.md`
- Protocol architecture split: `docs/protocol-vs-demo.md`
- zkTLS hardening notes: `docs/zktls-hardening-notes.md`
- per-date payout upgrade: `docs/per-date-payout-upgrade.md`
- operator runbook: `docs/operator-runbook.md`
- Reusable protocol skill: `skills/private-market-protocol/SKILL.md`
- Demo weather market skill: `skills/demo-weather-over-under/SKILL.md`

## Live Default vs Experimental

Live default:

- private queued betting intent (`PRIVACY_MODE=zk_strong`)
- public aggregate market odds/state
- automatic oracle refresh and automatic settlement status updates
- no per-user on-chain payout claim rail yet

Experimental / future:

- per-user on-chain payout claim path
- claimable position leaves
- public winner claim transactions
- resolved-markets UI claim flow (requires upgraded payout-enabled zkApp deployment)

The experimental payout code exists in the repo as protocol groundwork, but it is not the default live demo path.

## Demo Default Threshold

- Demo Over/Under threshold is `68F` (`threshold-tenth-c=200`).
- If a market has no pool yet, UI defaults market odds to `50/50`.
- Market pool and YES/NO odds in UI are on-chain aggregate state values from `/api/markets`.
- Demo daily lock behavior:
  - one demo market line per calendar date is locked on first sight from oracle forecast
  - locked threshold is not overwritten by later forecast updates
  - each day, newly observed future dates (for example the new D+6) get a new locked line

## Run Paths

### Run With pnpm (Source)

```bash
pnpm install
pnpm build
pnpm marketplace:serve
```

Open `http://127.0.0.1:8790/marketplace`

### Environment Setup (One-Time)

```bash
cp .env.example .env.local
```

Then fill real key values in `.env.local`:
- `DEPLOYER_PRIVATE_KEY`
- `ZKAPP_PRIVATE_KEY`
- optional `RELAYER_PRIVATE_KEY` (falls back to deployer key if omitted)

### Run With Docker (Compose)

```bash
cp ./deploy/env.production.example ./deploy/env.production
export ZKVERIFY_POC_HOST_PATH=/absolute/path/to/zk-verify-poc
docker compose up -d --build
```

Open `http://127.0.0.1:8790/marketplace`

### Optional GHCR Prebuilt Image

- Workflow file: `.github/workflows/docker-ghcr.yml`
- Publishes: `ghcr.io/<owner>/<repo>/private-prediction-market:<tag>`
- To run pulled image with the same compose file:

```bash
export PREDICTION_MARKET_IMAGE=ghcr.io/<owner>/<repo>/private-prediction-market:<tag>
docker compose up -d
```

## Scripts

- `pnpm build`
- `pnpm demo:local`
- `pnpm demo:oracle`
- `pnpm deploy:zeko`
- `pnpm sync-state:zeko -- --state-file ./data/operator-state.json`
- `pnpm create-market:zeko -- --market-key 1001 --config-hash 9001 --close-slot 100 --expiry-slot 120 --threshold-tenth-c 200 --title "Atherton > 68F?" --rules-primary "Resolves YES if observed daily high > 68F at determination time." --settlement-source "https://api.weather.gov/gridpoints/MTR/86,107/forecast" --determination-slot 120`
- `pnpm ensure-daily-markets:zeko -- --state-file ./data/operator-state.json`
- `pnpm trade-update:zeko -- --market-key 1001 --add-total-bet 1500 --add-yes-bet 900`
- `pnpm oracle:build-statement -- --attestation ./examples/weather-attestation.sample.json --market-key 123456 --allowed-server api.weather.example --allowed-path '/v1/current?lat=40.7829&lon=-73.9654&units=metric' --max-age-ms 999999999999 --threshold-tenth-c 200 --observed-at-slot 110 --nonce 444`
- `pnpm resolve-daily-market:zeko -- --market-date 2026-03-10 --state-file ./data/operator-state.json`
- `pnpm indexer:serve` then open `http://127.0.0.1:8788/dashboard`
- `pnpm agent:serve` then open `http://127.0.0.1:8789/widget`
- `pnpm marketplace:serve` then open `http://127.0.0.1:8790/marketplace`
- `pnpm weather:attest` (generate weather TLSNotary attestation file directly from local zk-verify-poc)
- `pnpm weather:sync` (hourly refresh + auto-settle check for 94027 weather contest)
- `pnpm weather:daemon` (persistent attest+sync loop for production-style operation)
- `pnpm weather:daemon:health` (checks daemon heartbeat freshness)
- `pnpm weather:tls:check` (strict zkTLS readiness check + attestation auto-detect/copy)
- `pnpm demo:ui` then open `http://localhost:8787`

## Deployment Status

- Current status: contract + resolver wiring implemented and verified on local chain demos.
- Live scripts are now available for deploy/create/resolve; they require funded keys + network access.
- Deploy/create/resolve commands require env vars:
  - `DEPLOYER_PRIVATE_KEY`
  - `ZKAPP_PRIVATE_KEY`
  - `ORACLE_SOURCE_HASH`
  - `ORACLE_REQUEST_PATH_HASH`
  - optional `ZEKO_GRAPHQL`, `ZEKO_NETWORK_ID`, `TX_FEE`

## Live Runbook (Zeko)

1. Export env vars:
   - `export DEPLOYER_PRIVATE_KEY=...`
   - `export ZKAPP_PRIVATE_KEY=...`
   - `export ORACLE_SOURCE_HASH=...`
   - `export ORACLE_REQUEST_PATH_HASH=...`

2. Deploy/configure zkApp:
```bash
pnpm deploy:zeko
```

3. Sync local operator state to on-chain events (recommended after any timeout/unknown tx status):
```bash
pnpm sync-state:zeko -- --state-file ./data/operator-state.json
```

4. Create a market (stores off-chain Merkle state in `./data/operator-state.json`):
```bash
pnpm create-market:zeko -- \
  --market-key 1001 \
  --config-hash 9001 \
  --close-slot 100 \
  --expiry-slot 120 \
  --threshold-tenth-c 200
```

5. Apply trade updates (public aggregate totals):
```bash
pnpm trade-update:zeko -- \
  --market-key 1001 \
  --add-total-bet 1500 \
  --add-yes-bet 900
```

6. Resolve from attestation:
```bash
pnpm resolve-weather:zeko -- \
  --market-key 1001 \
  --attestation ./examples/weather-attestation.sample.json \
  --allowed-server api.weather.example \
  --allowed-path '/v1/current?lat=40.7829&lon=-73.9654&units=metric' \
  --max-age-ms 999999999999
```

Note: `--observed-at-slot` is optional. If omitted, resolver defaults to the market `expirySlot`.
If provided, it must be within `[closeSlot, expirySlot]` or the script exits before sending a tx.

## Recurrence Reduction

- All tx scripts now use automatic retry/backoff for transient failures (`Gateway Timeout`, nonce contention, fetch failures).
- Before any mutating tx, scripts preflight local vs on-chain `marketsRoot` and fail with a sync command if mismatched.
- Use this as your standard recovery command after uncertain tx status:
```bash
pnpm sync-state:zeko -- --state-file ./data/operator-state.json
```

## Agent Marketplace Demo

- Purpose: sell private model outputs alongside market trading.
- Includes:
  - model registry (`/api/agents`, `/api/agents/register`)
  - escrow order creation (`/api/orders/create`)
  - relayer execution (`/api/orders/:id/relay-run`)
  - commitment-based reveal and settlement (`/api/orders/:id/reveal-settle`)
- Demo default model: `default-random-weather` (pseudo-random prediction output).

Run:
```bash
pnpm agent:serve
```
Open:
`http://127.0.0.1:8789/widget`

## Unified Marketplace (Recommended)

Single page that combines:
- betting markets (with on-chain bet action using `trade-update:zeko`)
- model selection + buy/run via wallet or credits
- `Use Model Bet` and `Close Bet` controls (close offsets net position)
- escrow + relayer + settle workflow
- weather bot panel for 94027 (NWS digital source + 7-day probabilities)

Run:
```bash
pnpm marketplace:serve
```
Open:
`http://127.0.0.1:8790/marketplace`

### Wallet-Signed On-Chain Bets (Zeko Testnet)

- UI now includes `Connect Wallet` (Auro/Pallad via `window.mina`).
- Bet actions use wallet fee-payer flow:
  1. server builds + proves zkApp tx (`/api/tx/market-bet` or `/api/tx/market-close`)
  2. wallet signs/sends tx (`window.mina.sendTransaction`)
  3. UI finalizes local operator state (`/api/tx/finalize`)
- Required env for server tx building:
  - `ZKAPP_PUBLIC_KEY` (preferred) or `ZKAPP_PRIVATE_KEY` (fallback for deriving public key)
  - optional `ZEKO_GRAPHQL`, `ZEKO_NETWORK_ID`, `TX_FEE`

### Privacy Mode (Default: `zk_strong`)

- `PRIVACY_MODE=zk_strong` (default):
  - disables direct per-user `/api/tx/market-bet` and `/api/tx/market-close`
  - uses private commitment queue endpoint: `/api/private-bets/submit`
  - UI first sends wallet payment to zkApp pool, then queues private commitment
  - queue items are consumed by a relayer batch executor to post aggregated on-chain transitions
  - requires `RELAYER_PRIVATE_KEY` (falls back to `DEPLOYER_PRIVATE_KEY` if unset)
  - optional tuning:
    - `PRIVATE_BATCH_INTERVAL_MS` (default `30000`)
    - `PRIVATE_BATCH_MAX_ITEMS` (default `64`)
    - `RELAYER_REIMBURSE_NANOMINA` (default `TX_FEE`)
    - `RELAYER_REIMBURSE_DISABLED=1` to disable reimbursement
- `PRIVACY_MODE=compat`:
  - re-enables prior direct wallet tx flow for local/dev compatibility

Private batch APIs:
- `GET /api/private-bets/status`
- `POST /api/private-bets/process-batch`
- `GET /api/private-bets/history`

Durability:
- private queue persisted to `./data/private-bet-queue.json`
- batch history persisted to `./data/private-batch-history.json`

Privacy model:
- Public: market aggregates (`totalPositionBet`, `totalYesPositionBet`), implied odds, resolution.
- `zk_strong` default: per-user bets are queued as private commitments for batched settlement path.
- Relayer reimbursement: batch processor can reimburse relayer from zkApp pool balance in the same tx.
- `compat` mode: direct per-user tx flow is visible at chain tx layer.

Settlement / payout model:
- settlement status is updated automatically by the server/daemon
- current live demo supports automatic per-date result resolution status
- payout-enabled path requires upgraded payout-enabled zkApp deployment plus per-date on-chain markets
- resolved-market claim UI and `pnpm claim-payout:zeko` are available once that upgraded deployment is active

## 94027 Weather Source

- URL wired in UI/server:
  - `https://forecast.weather.gov/MapClick.php?lat=37.4534&lon=-122.1942&lg=english&&FcstType=digital`
- Strict settlement/attestation source:
  - `https://api.weather.gov/gridpoints/MTR/86,107/forecast`
- This is a free public NOAA/NWS endpoint (no API key required for this use pattern).
- We ingest and parse the digital forecast page hourly and compute 7-day high probabilities using a normal distribution.
- Daily high contest settlement rule (demo):
  - closest guess without going over wins
  - payout is proportional to winner stake share of the winning cohort
  - auto-settle check runs on weather refresh and in `pnpm weather:sync`

## zkTLS (TLSNotary) Wiring

- Added `src/tlsn-verifier.ts` for attestation verification flow.
- Added `pnpm weather:tls:check` to remove placeholder/env confusion.
- Added `pnpm weather:attest` for one-command attestation generation:
  - auto-detects `ZKVERIFY_POC_ROOT` (defaults to:
    `/Users/evankereiakes/Documents/Codex/tokenized-asset-protocol/external/zk-verify-poc`)
  - builds `tlsnotary` binaries if needed
  - starts local notary, runs prover against `forecast.weather.gov:443` + 94027 MapClick path
  - writes `./data/weather-attestation.json`
  - Auto-detects attestation candidates:
    - `WEATHER_TLSN_ATTESTATION_FILE`
    - `./data/weather-attestation.json`
    - `${ZKVERIFY_POC_ROOT}/output/latest/attestation.json`
    - `/Users/evankereiakes/Documents/Codex/tokenized-asset-protocol/external/zk-verify-poc/output/latest/attestation.json`
  - If found externally, it copies to `./data/weather-attestation.json`.
  - Validates server/path binding for the 94027 NWS URL policy.
- Weather refresh now supports strict zkTLS mode:
  - `WEATHER_REQUIRE_TLSN=1`
  - optional `WEATHER_TLSN_ATTESTATION_FILE` (defaults to `./data/weather-attestation.json`)
  - optional `WEATHER_TLSN_MAX_AGE_MS=3600000`
  - optional `WEATHER_ORACLE_STALE_MS` (default: `WEATHER_TLSN_MAX_AGE_MS`)
  - optional `WEATHER_ORACLE_EXPIRED_MS` (default: `2 * WEATHER_ORACLE_STALE_MS`)
  - `TLSN_VERIFY_CMD=/absolute/path/to/your/tlsnotary-verifier-binary-or-script`
  - optional `TLSN_VERIFY_ARGS="..."`
- If `TLSN_VERIFY_CMD` is not set, strict mode uses built-in checks (policy + envelope parsing).
  External verifier remains recommended for stronger cryptographic assurance.
- In strict mode, contest settlement is blocked unless the latest weather snapshot is `verified=true` and `verificationMode=zktls`.
- Oracle freshness states are exposed in API (`fresh`, `stale`, `expired`, `missing`):
  - `GET /api/weather/94027`
  - `GET /api/markets`
- Close-only guardrails:
  - New bets are blocked when oracle state is not `fresh`.
  - Settlement is blocked when oracle state is `expired` or `missing`.
- `resolve-weather:zeko` is also wired to verifier flow:
  - default strict behavior (`TLSN_STRICT=1` by default)
  - set `TLSN_STRICT=0` only for local demo fixtures.

### Minimal strict workflow

```bash
pnpm weather:attest
export WEATHER_REQUIRE_TLSN=1
pnpm weather:tls:check
pnpm weather:sync
```

### Persistent strict workflow (recommended)

```bash
export TLSN_PROVER_TIMEOUT_MS=600000
export WEATHER_DAEMON_INTERVAL_MS=300000
pnpm weather:daemon
```

## Production Hosting Bundle

- Files:
  - `deploy/Dockerfile`
  - `deploy/docker-compose.production.yml`
  - `deploy/env.production.example`
  - `deploy/README.production.md`
- Starts two services:
  - `marketplace` (API/UI on port `8790`)
  - `weather-daemon` (persistent zkTLS attest + sync)
- Health checks:
  - `GET /api/health` for marketplace
  - daemon heartbeat freshness via `pnpm weather:daemon:health`

## Docker Quick Start (Root Compose)

- Root compose file: `docker-compose.yml`
- Services: `marketplace` (UI/API) and `weather-daemon` (strict zkTLS attest + sync loop)

1. Copy env template:
```bash
cp ./deploy/env.production.example ./deploy/env.production
```
2. Set your local zk-verify-poc path (required for strict zkTLS):
```bash
export ZKVERIFY_POC_HOST_PATH=/absolute/path/to/zk-verify-poc
```
3. Build and start:
```bash
docker compose up -d --build
```
4. Open:
```bash
http://127.0.0.1:8790/marketplace
```
5. Follow logs:
```bash
docker compose logs -f marketplace weather-daemon
```
6. Stop:
```bash
docker compose down
```

Notes:
- You need Docker Desktop (or Docker Engine + Compose plugin) on your machine.
- You do not need Docker Hub for this local flow; images are built locally.
- Docker Hub (or GHCR) is only needed if you want to publish prebuilt images for others.

## Hidden Baseline Extensions (Disabled By Default)

Baseline scaffolding is included for handoff teams and not exposed in the UI:

- Oracle committee consensus path (zkTLS committee commits/finalization)
- Governance emergency resolution path (timelocked proposal/approve/execute)
- ACP-style credits escrow + relayer path (reference scaffold for developers)

Both are disabled unless explicitly enabled:

- `ENABLE_ORACLE_COMMITTEE_PATH=1`
- `ENABLE_GOVERNANCE_PATH=1`
- `ENABLE_ACP_CREDIT_ESCROW_PATH=1`

Internal endpoints remain off unless those flags are set:

- `/api/internal/oracle-committee/*`
- `/api/internal/governance/*`
- `/api/internal/acp/*`

ACP reference notes:
- Source file: `src/acp-credit-escrow.ts`
- Includes intent -> fund -> spend -> relay run -> reveal+settle lifecycle.
- This is included for developer reference (borrowed ACP pattern), but current demo mode remains wallet-signed on-chain model/bet flows.

## Kalshi-Inspired Data/UX Guardrails

- Keep market title + explicit primary rules visible with a direct settlement source reference.
- Keep close time and determination/settlement time distinct.
- Always show implied probability and aggregate size (`totalPositionBet`) together.
- Rankings expose both liquidity (`top-bet`) and urgency (`ending-soon`).

Reference pages:
- [Kalshi learn center](https://help.kalshi.com/en/)
- [Kalshi market data primer](https://help.kalshi.com/en/articles/10508187-how-to-interpret-market-data)
- [Kalshi weather markets](https://help.kalshi.com/en/articles/12014374-weather-markets)
