# Operator Runbook

This runbook describes the live default operating model for the demo.

## What Runs Automatically

When the server and oracle daemon are running, the demo does these automatically:

- refresh weather oracle snapshots
- verify strict zkTLS snapshots when strict mode is enabled
- update rolling daily market context
- mark daily dates as `open` or `resolved`
- run periodic settlement checks
- run a nightly settlement backstop around `11:55 PM America/Los_Angeles`

What is not yet automatic because it is not part of the live demo path:

- legacy aggregate-market payout on older deployments

Payout-enabled path on upgraded deployment:

- create deterministic per-date markets
- resolve those per-date markets on-chain
- winners claim publicly from the Resolved Markets panel

## Required Processes

Terminal 1:

```bash
cd /tmp/private-prediction-market-main
pnpm marketplace:serve
```

Terminal 2:

```bash
cd /tmp/private-prediction-market-main
pnpm oracle:worker
```

## UI

Open:

- `http://127.0.0.1:8790/marketplace`

Useful endpoints:

- `/api/health`
- `/api/markets`
- `/api/weather/94027`
- `/api/settlement/readiness`
- `/api/private-bets/status`
- `/api/private-bets/history`

## Environment

Use `.env.local`, not shell-only exports.

Expected local values:

- `DEPLOYER_PRIVATE_KEY`
- `ZKAPP_PRIVATE_KEY`
- optional `RELAYER_PRIVATE_KEY`
- `ZEKO_GRAPHQL`
- `ZEKO_NETWORK_ID`
- `TX_FEE`
- `WEATHER_REQUIRE_TLSN`
- `WEATHER_TLSN_ATTESTATION_FILE`

## Recovery Commands

Rebuild:

```bash
pnpm build
```

Payout-enabled per-date market bootstrap:

```bash
pnpm ensure-daily-markets:zeko -- --state-file ./data/operator-state.json
```

Resolve one daily on-chain market after oracle data is final:

```bash
pnpm resolve-daily-market:zeko -- --market-date 2026-03-10 --state-file ./data/operator-state.json
```

Resync operator state:

```bash
pnpm sync-state:zeko -- --state-file ./data/operator-state.json
```

Force oracle refresh:

```bash
pnpm weather:sync
```

Check daemon heartbeat:

```bash
curl -s http://127.0.0.1:8790/api/health
```

## Operational Truth

Live default:

- private/batched betting intent
- public aggregate market state
- automatic settlement status
- payout-enabled resolved-markets claim flow requires upgraded per-date zkApp deployment

Not live default:

- per-user on-chain payout claim rail
- full shielded betting/payout privacy

## Failure Modes

If oracle is stale:

- bets may still be allowed
- settlement is paused until oracle refresh succeeds

If private batch processing fails:

- queue depth grows
- market odds do not update until a batch succeeds
- inspect `/api/private-bets/history`

If server is down near midnight:

- nightly settlement backstop will not run until restart
- persisted scheduler state reduces duplicate/missed runs after restart
