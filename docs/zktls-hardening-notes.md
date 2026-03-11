# zkTLS Hardening Notes

This file summarizes the work done to make the weather oracle zkTLS/TLSNotary flow stable enough for the demo and easier for other developers to operate.

## Goal

Use a strict, verifiable weather source for the Atherton demo market while keeping the developer workflow simple enough to run locally and later host on a server.

Primary source:

- `https://api.weather.gov/gridpoints/MTR/86,107/forecast`

UI reference source:

- `https://forecast.weather.gov/MapClick.php?lat=37.4534&lon=-122.1942&lg=english&&FcstType=digital`

## What Was Hardened

### 1. Strict verification path

The app now supports strict zkTLS verification for weather sync and settlement:

- strict mode gate: `WEATHER_REQUIRE_TLSN=1`
- attestation file path:
  - preferred: `./data/tlsn-output/latest/attestation.json`
  - legacy fallback: `./data/weather-attestation.json`
- policy checks:
  - allowed server name
  - allowed request path
  - max age
  - no future skew

Relevant files:

- [tlsn-verifier.ts](/Users/evankereiakes/Documents/Codex/private-prediction-market/src/tlsn-verifier.ts)
- [marketplace-server.ts](/Users/evankereiakes/Documents/Codex/private-prediction-market/src/marketplace-server.ts)
- [weather-hourly-sync.ts](/Users/evankereiakes/Documents/Codex/private-prediction-market/src/weather-hourly-sync.ts)

### 2. One-command attestation generation

Added `pnpm weather:attest` so the developer does not have to manually compose notary/prover commands.

The attestation command now:

- locates the `tlsnotary` repo under the configured `zk-verify-poc`
- builds binaries if needed
- prepares trust anchor certificates
- starts the local notary
- runs the prover against the weather source
- writes the latest attestation to:
  - `./data/tlsn-output/latest/attestation.json`
- copies a legacy local convenience file to:
  - `./data/weather-attestation.json`

Relevant file:

- [weather-attest.ts](/Users/evankereiakes/Documents/Codex/private-prediction-market/src/weather-attest.ts)

### 3. TLSNotary stability fixes for the NOAA/NWS source

The original prover flow was unreliable against the target endpoint because the response size and connection behavior were not stable enough for the demo setup.

Fixes added:

- force smaller strict source payload by using daily forecast endpoint instead of hourly forecast
- preflight HTTP fetch before prover run
- patch prover `MAX_RECV_DATA` when needed for larger responses
- patch request behavior to `HTTP/1.0` to get deterministic connection close
- resolve target host to IPv4 before prover TCP connect
- add clearer timeout behavior and logs for prover/notary progress
- keep strict mode tied to verified snapshots only

These changes were application-level hardening for this integration, not a claim that TLSNotary is generally broken.

### 4. Better local ergonomics

To reduce user confusion and shell-specific failures:

- project runtime config now loads from `.env` and `.env.local`
- `.env.local` is the expected place for local secrets and paths
- the app no longer depends on ephemeral shell-only exports as the main configuration model

Relevant file:

- [env.ts](/Users/evankereiakes/Documents/Codex/private-prediction-market/src/env.ts)

### 5. Safer sync behavior

Weather sync now:

- uses strict verification when configured
- rejects expired attestations in strict mode
- can fall back to insecure direct fetch only when strict mode is disabled
- blocks settlement when strict policy is enabled but the latest snapshot is not zkTLS verified

This avoids silent resolution from unverified data in strict mode.

## Operational Model

### Local flow

1. Generate attestation:

```bash
pnpm weather:attest
```

2. Strict sync:

```bash
pnpm weather:sync
```

3. Persistent hosted-style loop:

```bash
pnpm weather:daemon
```

### Recommended server-side mode

For any hosted environment, use:

- `pnpm weather:daemon`

This provides:

- recurring attestation generation
- recurring weather sync
- heartbeat file for health checks

Health check:

```bash
pnpm weather:daemon:health
```

## Current Limits

These are the remaining known limitations:

- strict mode still depends on the latest attestation file being fresh enough
- settlement automation is server-driven, not chain-native cron
- the current demo settles against the demo daily contest/date files; full per-date on-chain market resolution is still a separate hardening track
- wallet activity remains visible on-chain even when market intent is batched privately

## Recommended Next Steps

1. Move fully to per-date on-chain resolution and payout.
2. Add hosted monitoring for:
   - stale attestation
   - daemon down
   - nightly settlement missed
3. Upstream the application-discovered TLSNotary integration notes to the upstream `zk-verify-poc` maintainers.

## Quick Reference

- Strict source:
  - `https://api.weather.gov/gridpoints/MTR/86,107/forecast`
- Latest attestation:
  - `./data/tlsn-output/latest/attestation.json`
- Legacy copied attestation:
  - `./data/weather-attestation.json`
- Daemon heartbeat:
  - `./data/weather-daemon-heartbeat.json`
