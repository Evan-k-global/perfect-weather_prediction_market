# Production Bundle

This bundle runs:

- `marketplace` (API/UI server)
- `weather-daemon` (persistent TLSN attestation + sync loop)

For Render, use the single-service Docker path in `render.yaml`. It runs both processes in one container so they can share `/app/data`.

## 1) Prepare env

```bash
cd /Users/evankereiakes/Documents/Codex/private-prediction-market/deploy
cp env.production.example env.production
```

Set `ZKVERIFY_POC_HOST_PATH` in your shell to the host path that contains `tlsnotary`:

```bash
export ZKVERIFY_POC_HOST_PATH=/Users/evankereiakes/Documents/Codex/tokenized-asset-protocol/external/zk-verify-poc
```

## 2) Start services

```bash
docker compose -f docker-compose.production.yml up -d --build
```

## 3) Verify health

```bash
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs -f weather-daemon
curl -s http://127.0.0.1:8790/api/health
```

## Stale proof policy (recommended)

- `fresh`: normal trading + settlement
- `stale`: close-only trading, block risk-increasing actions
- `expired at determination`: block settlement until fresh proof arrives
- `extended outage`: emergency governance/admin path, fully auditable

## Notes

- The daemon writes heartbeat to `./data/weather-daemon-heartbeat.json`.
- Docker healthcheck validates heartbeat freshness via `pnpm weather:daemon:health`.
- Keep `WEATHER_TLSN_MAX_AGE_MS` tight for production (for example 15m or 60m).
- Render should use a persistent disk mounted at `/app/data`.

## Fresh zkApp Rollout

Use this only when you intentionally cut over to a brand-new zkApp address and want to leave the broken local state behind.

1. Deploy the new zkApp and capture the new `ZKAPP_PUBLIC_KEY`.
2. Update Render env on all services with the new zkApp key material.
3. Redeploy `perfect-weather-prediction-market`.
4. Run the one-shot hosted reset from a Render shell on any service that has `OPERATOR_BASE_URL` and `OPERATOR_ACTION_TOKEN`:

```bash
pnpm run fresh-zkapp:reset-hosted-state -- --reason "fresh zkApp rollout"
```

What that reset does:

- archives the old persisted files under `/app/data/fresh-zkapp-archives/<timestamp>/`
- clears `operator-state.json`
- clears `private-bet-queue.json`
- clears `private-batch-history.json`
- clears `user-positions.json`
- resets `daily-settle-state.json`
- preserves the daily threshold rows but zeroes out their pot totals

5. Redeploy `perfect-weather-operator-worker`.
6. Redeploy `perfect-weather-oracle-worker`.
7. Let oracle upkeep create the new forward markets, then test one fresh bet.

This is the intended emergency path for a clean-slate contract migration without reusing poisoned local state.
