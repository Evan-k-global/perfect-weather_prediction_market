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

1. Load active market threshold from `/api/markets`.
2. Request weather probabilities using that threshold.
3. Render:
   - clear yes/no labels with threshold value
   - odds bars (market-level and day-level)
4. Keep all actions wallet-signed for on-chain bet updates.

## Guardrails

- Avoid mixing old number-pick contest UX with yes/no market UX.
- If no pool/bets yet, display neutral `50/50`.
- Keep oracle errors actionable in UI (`refresh oracle`, strict mode notes).
