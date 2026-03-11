---
name: private-market-protocol
description: Use when implementing or modifying the reusable prediction-market protocol layer (zkApp contract roots, wallet-signed tx flow, oracle verification policy, and non-UI market plumbing) independent of any specific demo market.
---

# Private Market Protocol

## Use This Skill For

- Protocol-level changes in `src/contract.ts`
- Wallet-signed tx construction/finalization paths in `src/marketplace-server.ts`
- Oracle trust/verification policy changes (`src/tlsn-verifier.ts`, `src/weather-attest.ts`)
- Global safeguards (nonce handling, root sync, close-only/expired behavior)

## Workflow

1. Confirm whether change is global protocol or demo-only.
2. Keep protocol APIs stable for multiple market adapters.
3. Preserve on-chain/public outputs:
   - market aggregate totals
   - implied probabilities
   - resolved outcomes
4. Verify compatibility with:
   - `pnpm build`
   - wallet tx flow (`/api/tx/market-bet`, `/api/tx/finalize`)
   - state sync (`pnpm sync-state:zeko`)

## Guardrails

- Do not hardcode demo thresholds/sources in protocol logic.
- Keep strict zkTLS behavior opt-in via env flags.
- If market metadata is missing, fall back safely (never block tx building due to display metadata).
