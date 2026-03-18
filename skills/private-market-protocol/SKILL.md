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
3. Prefer a small proving surface on the hot path:
   - browser/client proving for active bets
   - background workers for upkeep
   - no hidden server-side proving fallback in normal UX
4. Preserve on-chain/public outputs:
   - market aggregate totals
   - implied probabilities
   - resolved outcomes
5. Verify compatibility with:
   - `pnpm build`
   - wallet tx flow (`/api/tx/market-bet-context`, browser prove, `/api/tx/finalize`)
   - state sync (`pnpm sync-state:zeko`)

## Guardrails

- Do not hardcode demo thresholds/sources in protocol logic.
- Keep strict zkTLS behavior opt-in via env flags.
- If market metadata is missing, fall back safely (never block tx building due to display metadata).
- Do not put normal user betting back behind server-side proving or operator batching unless you are explicitly trading UX for privacy.
- Do not assume more workers fix a bad state/proving model. Simplify the contract and proving path first.
- If state cannot be reconstructed from chain events, add recovery/bootstrap paths before increasing operational complexity.

## Architecture Lessons

- Build vs deploy:
  - local builds can succeed while hosted startup fails because startup order, env, or chain bootstrap is incomplete
  - always separate “contract exists,” “markets exist,” and “UI can see markets”
- Local vs hosted:
  - hosted services exposed RAM/CPU limits and stale-state bugs that did not show up locally
  - prefer lightweight web services and explicit startup bootstrap over opportunistic writes during page load
- Server vs client:
  - client-side proving is better for active bets only when the contract is intentionally small
  - server-side proving on the market web service led to slow responses and 502s
- UX vs privacy:
  - queued batching improved intent privacy but was too slow for primary UX
  - current direction is public market movement with less attributable user intent, not full hidden market state
