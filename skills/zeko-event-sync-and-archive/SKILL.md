---
name: zeko-event-sync-and-archive
description: Use when changing or debugging how this repo reads zkApp events, syncs operator state, handles archive vs main GraphQL endpoints, or explains why wallet-signed bets can stay submitted while authoritative market totals do not move.
---

# Zeko Event Sync And Archive

## Use This Skill For

- `src/sync-state-zeko.ts`
- `src/marketplace-server.ts` bet/claim build and finalize flow
- `src/chain-state.ts` / root-check logic
- operator or oracle workflows that refresh `data/operator-state.json`
- docs or incident notes about archive/main endpoint behavior

## Core Model

- `fetchAccount()` gives live zkApp roots.
- `fetchEvents()` gives the event stream used to rebuild:
  - `markets`
  - `receipts`
  - `claimedReceipts`
- Proof generation depends on both:
  - live roots
  - event-derived Merkle witnesses

If those diverge, proofs fail with stale-root errors like:
- `Field.assertEquals(... != ...)`
- `marketsRoot mismatch local=... chain=...`

## Repo Truth Rules

- Global market odds and payouts must follow authoritative synced market state, not wallet tx hashes.
- Receipt-backed bets are only authoritative after `receiptCommitted` is visible in synced state.
- Wallet activity can show `submitted`, but aggregate markets must stay unchanged until synced receipts/market events confirm the bet.

## Archive Guidance

- Do not assume archive and main endpoints behave identically.
- For live proving paths, prefer the event source that stays closest to the live root.
- Archive is better suited for history/backfill than for request-time witness generation if it lags.
- Never put expensive event rebuilds or full sync loops directly in the hot HTTP tx build path.

## Operational Guidance

- Keep `sync-state:zeko` off the live bet request path.
- Keep operator state fresh in the background instead.
- If root reads (`fetchAccount`) are flaky, do not freeze event-derived state forever.
- A sync run should still persist event-derived state when possible, then log root-check availability separately.

## Debug Workflow

1. Check `/api/markets`.
   - This is the authoritative aggregate state users actually trade against.
2. Check `/api/wallet/activity`.
   - Distinguish `submitted` vs `confirmed`.
3. If wallet activity advances but `/api/markets` does not:
   - the tx hash exists, but authoritative event sync has not confirmed the receipt/market update.
4. If tx-prover logs `Field.assertEquals(... != ...)`:
   - compare local synced roots to live roots before touching wallet/Auro logic.
5. If oracle sync fails on `fetchAccount()`:
   - treat that as a root-read outage, not proof logic failure.

## Guardrails

- Do not “fix” stale-root issues by making aggregate markets follow wallet activity.
- Do not rely on tx-hash confirmation alone for market totals or payout math.
- Do not add multi-pass sync or `fetchEvents()` loops inside `/api/tx/market-bet` or `/api/tx/claim-payout`.
- Keep debugging layered:
  - live roots
  - event-derived state
  - proof build
  - wallet send
  - finalize / status UI
