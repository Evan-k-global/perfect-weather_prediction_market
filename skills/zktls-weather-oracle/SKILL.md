---
name: zktls-weather-oracle
description: Use when integrating, debugging, or operating zkTLS/TLSNotary-backed HTTPS oracle fetches for this repo, especially NOAA/NWS weather sources, attestation freshness policy, strict-mode gating, and prover/notary stability.
---

# zkTLS Weather Oracle

## Use This Skill For

- `src/weather-attest.ts`
- `src/tlsn-verifier.ts`
- `src/weather-hourly-sync.ts`
- weather-oracle sections of `src/marketplace-server.ts`
- strict-mode env/config and attestation path handling

## Workflow

1. Confirm the target HTTPS source and exact request path.
2. Keep attestation policy bound to:
   - server name
   - request path
   - freshness window
3. Prefer deterministic payloads and connection behavior.
4. Verify the app behavior in both modes:
   - strict zkTLS enabled
   - insecure fallback disabled/enabled explicitly
5. Validate with:
   - `pnpm weather:attest`
   - `pnpm weather:sync`
   - `pnpm weather:daemon`

## Repo-Specific Guidance

- Primary strict source is `https://api.weather.gov/gridpoints/MTR/86,107/forecast`.
- Preferred attestation path is `./data/tlsn-output/latest/attestation.json`.
- Legacy copy path is `./data/weather-attestation.json`.
- Runtime config should come from `.env` / `.env.local`, not shell-only exports.

## Guardrails

- Do not silently accept stale attestations in strict mode.
- If strict mode is enabled, settlement must pause when the snapshot is too old or unverified.
- Keep source/path policy checks explicit; do not loosen them just to make local testing easier.
- When TLSNotary is unstable, prefer fixing deterministic request/response behavior before expanding timeouts.
