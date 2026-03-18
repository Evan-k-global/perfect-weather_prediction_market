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

## Demo Defaults

- Threshold: `68F`
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
5. Keep all actions wallet-signed for on-chain bet updates.

## Guardrails

- Avoid mixing old number-pick contest UX with yes/no market UX.
- If no pool/bets yet, display neutral `50/50`.
- Keep oracle errors actionable in UI (`refresh oracle`, strict mode notes).
- Do not warn on initial page load that a market is missing if the backend has not actually failed to create/find it yet.
- Prefer the button label `Place Bet`; show temporary status in nearby progress text instead of renaming the primary action.
- Do not let demo daily-market projections drift away from the actual on-chain market identity.

## Build Recommendations

- Local success is not enough. Hosted startup, sync order, and stale seeded daily-market files caused real regressions.
- Do not create extra hosted services to compensate for stale UI reconciliation. Fix the source-of-truth mismatch first.
- Fresh zkApp rollouts need explicit bootstrap:
  - initialize the zkApp
  - create the rolling markets
  - sync local state
  - only then let the UI claim a date is active or missing
- If the market feed and daily-market feed disagree, trust the real on-chain market feed first and repair the projection layer second.
