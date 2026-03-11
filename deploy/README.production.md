# Production Bundle

This bundle runs:

- `marketplace` (API/UI server)
- `weather-daemon` (persistent TLSN attestation + sync loop)

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
