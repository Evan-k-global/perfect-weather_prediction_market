---
name: demo-weather-over-under
description: Use when working on the Atherton weather demo market UI and adapter logic (Over/Under threshold UX, weather probability rendering, oracle sync UX, and demo defaults such as 68F threshold).
---

# Demo Weather Over/Under

## Use This Skill For

- Demo UI behavior in `public/marketplace.html`
- Weather threshold display and odds rendering
- Demo weather API integration (`src/weather-service.ts`, `src/weather-hourly-sync.ts`)
- Oracle refresh UX and auto-settlement behavior for the demo

This is the most demo-specific skill in the repo. Even here, document the weather market as an example of broader product patterns:

- date-windowed prediction markets
- background-created rolling markets
- resolved/claimable wallet history
- UI behavior when on-chain state and local projections briefly diverge

## Demo Defaults

- Threshold: `68F`
- Daily cutoff: `9pm Pacific`
- Market semantics:
  - YES = observed high > threshold
  - NO = observed high <= threshold
- Show both:
  - on-chain aggregate market odds
  - forecast-implied day-level odds

## Workflow

1. Treat `/api/markets` as the source of truth for what actually exists on-chain.
2. Reconcile date-based demo rows against the deterministic date-derived market key, not stale seeded titles or local-only keys.
3. Request weather probabilities using the active on-chain threshold.
4. Render:
   - clear yes/no labels with threshold value
   - odds bars (market-level and day-level)
5. Keep all actions wallet-signed for on-chain bet updates and claims.

## Guardrails

- Avoid mixing old number-pick contest UX with yes/no market UX.
- If no pool/bets yet, display neutral `50/50`.
- Keep oracle errors actionable in UI (`refresh oracle`, strict mode notes).
- Do not warn on initial page load that a market is missing if the backend has not actually failed to create/find it yet.
- Prefer the button label `Place Bet`; temporary statuses can replace the button label during the in-flight action but should reset cleanly after success/failure.
- Do not let demo daily-market projections drift away from the actual on-chain market identity.
- Do not leave resolved/claim UI dependent on stale daily rows; once a market rolls off the active window it still needs to appear in resolved history via hosted wallet metadata.

## Build Recommendations

- Local success is not enough. Hosted startup, sync order, and stale seeded daily-market files caused real regressions.
- Do not create extra hosted services to compensate for stale UI reconciliation. Fix the source-of-truth mismatch first.
- Fresh zkApp rollouts need explicit bootstrap:
  - initialize the zkApp
  - create the rolling markets
  - sync local state
  - only then let the UI claim a date is active or missing
- The active demo market window is not midnight-based anymore:
  - before `9pm PT`, today is active
  - at or after `9pm PT`, tomorrow becomes the first active market date
- If the market feed and daily-market feed disagree, trust the real on-chain market feed first and repair the projection layer second.
- For hosted operation:
  - market renders quickly from shared state
  - oracle runs background lifecycle work
  - tx-prover handles bet/claim proving
  - browser wallet signs
- If the tx-prover throws a raw `Field.assertEquals(): ... != ...` after a few bets/claims, suspect stale witnesses from a root update rather than a broken wallet flow; refresh state, rebuild context, and retry multiple times before surfacing the error.
- Past-date resolution must retry on the next oracle cycle if a market missed its first nightly window; do not make users wait another full day.
- If `Resolved Markets` empties after a real resolve/claim, suspect sync regression before blaming the UI. The demo should preserve monotonic resolved/claimed state rather than allowing an incomplete event snapshot to erase it.
- If a bet appears in `Your Activity` but the on-chain pool returns to zero after refresh, treat the entry as optimistic hosted metadata until inclusion is confirmed.
- In the resolved-markets card:
  - keep progress on the claim button itself (`Generating tx proof`, `Sign Wallet Tx`, `Finalizing claim...`)
  - avoid long raw market identifiers unless they are needed for debugging
  - do not stretch the claim button full-width when a compact action affordance reads better
