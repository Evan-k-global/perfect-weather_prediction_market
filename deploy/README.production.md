# Production Bundle

This bundle runs:

- `marketplace` (API/UI server)
- `oracle-worker` (weather sync + market lifecycle)
- `tx-prover` (bet/claim proving)

For Render, use the split-service Docker paths in `render.yaml`.

## 1) Prepare env

```bash
cd /tmp/private-prediction-market-main/deploy
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
docker compose -f docker-compose.production.yml logs -f oracle-worker
curl -s http://127.0.0.1:8790/api/health
```

## Stale proof policy (recommended)

- `fresh`: normal trading + settlement
- `stale`: close-only trading, block risk-increasing actions
- `expired at determination`: block settlement until fresh proof arrives
- `extended outage`: emergency governance/admin path, fully auditable

## Notes

- Keep `WEATHER_TLSN_MAX_AGE_MS` tight for production (for example 15m or 60m).
- Render should use a persistent disk mounted at `/app/data`.
- After a fresh zkApp rollout, expect a clean market epoch:
  - oracle recreates the rolling daily markets
  - market sync repopulates from the new address
  - old receipts/claims do not automatically carry over
- The current demo uses a `9pm Pacific` cutoff for:
  - daily market close
  - same-day resolution eligibility
  - advancing the active rolling market window
- If tx-prover logs show `Field.assertEquals(): ... != ...`, suspect stale roots/witnesses first. Redeploying a larger prover instance alone will not fix stale proof inputs.
