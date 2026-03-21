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
   - dedicated tx-prover for bet/claim proving
   - background workers for upkeep only
   - no hidden operator queue or market-web proving in normal UX
4. Preserve on-chain/public outputs:
   - market aggregate totals
   - implied probabilities
   - resolved outcomes
5. Verify compatibility with:
   - `pnpm build`
   - wallet tx flow (`/api/tx/market-bet`, tx-prover, `/api/tx/finalize`)
   - state sync (`pnpm sync-state:zeko`)

## Guardrails

- Do not hardcode demo thresholds/sources in protocol logic.
- Keep strict zkTLS behavior opt-in via env flags.
- If market metadata is missing, fall back safely (never block tx building due to display metadata).
- Do not put normal user betting back behind the operator queue or the market web service unless you are explicitly trading UX for privacy.
- Do not assume more workers fix a bad state/proving model. Simplify the contract and proving path first.
- If state cannot be reconstructed from chain events, add recovery/bootstrap paths before increasing operational complexity.
- Preserve wallet metadata (`receiptMeta`, `positionMeta`) across sync/import cycles. On-chain roots alone are not enough for fast wallet-facing claim UX.
- Keep market-date identity durable beyond the active betting window. Oracle resolution for rolled-off dates should not depend only on current daily-market rows.

## Architecture Lessons

- Build vs deploy:
  - local builds can succeed while hosted startup fails because startup order, env, or chain bootstrap is incomplete
  - always separate “contract exists,” “markets exist,” and “UI can see markets”
- Local vs hosted:
  - hosted services exposed RAM/CPU limits and stale-state bugs that did not show up locally
  - prefer lightweight web services and explicit startup bootstrap over opportunistic writes during page load
- Server vs client:
  - browser proving for this contract surface was too slow in practice
  - server-side proving on the market web service led to slow responses and 502s
  - a small dedicated tx-prover is the current hosted compromise for UX
- UX vs privacy:
  - queued batching improved intent privacy but was too slow for primary UX
  - current direction is public market movement with fast wallet-signed transactions, not full hidden market state
- Compute:
  - compile caches should be built into hosted images and reused at runtime
  - lower-tier hosted instances benefit more from reused compile artifacts than from adding more mixed-responsibility services
- Claim flow reliability:
  - a wallet tx hash is not enough; the hosted market still needs `/api/tx/finalize` to persist `submitted` / `confirmed`
  - payout-claim finalize should tolerate lost in-memory intents and recover from `{ marketKey, positionKey, walletPublicKey, txHash }`
  - transient finalize failures are more common than proof failures once the wallet send succeeds, so retry and recovery should stay lean and explicit
- Prover state drift:
  - `Field.assertEquals(): <a> != <b>` in the tx-prover usually means the witness was built against an older root and the live zkApp state changed before proving
  - retry by refreshing state, rebuilding context, and proving again once before surfacing the error
  - treat this as a state-coordination problem first, not as proof corruption
- Sync monotonicity:
  - event-based sync can be temporarily incomplete on hosted/archive infrastructure
  - do not let sync regress monotonic state like `resolved` markets, claimed receipts, or used oracle nonces
  - if a market resolved once locally, never overwrite it back to unresolved from a thinner event snapshot
