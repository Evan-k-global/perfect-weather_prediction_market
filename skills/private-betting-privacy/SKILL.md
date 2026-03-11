---
name: private-betting-privacy
description: Use when changing privacy claims, batching behavior, relayer flow, or user-facing explanations of what is private vs public in this repo's prediction market implementation.
---

# Private Betting Privacy

## Use This Skill For

- privacy-mode logic in `src/marketplace-server.ts`
- private batch queue/history endpoints
- resolved-markets / claim UX wording
- README/docs language about privacy guarantees

## Privacy Model In This Repo

Live default:
- wallet activity is public on-chain
- aggregate market state is public on-chain
- live per-user market intent is batched and not exposed as a simple direct market-side update

Not provided by default:
- fully shielded balances
- fully shielded bet amounts
- fully shielded payout claims

## Workflow

1. State clearly whether a change affects:
   - bet intent privacy
   - wallet activity privacy
   - payout privacy
2. Keep README/UI wording aligned with the actual implementation.
3. Preserve the current demo priority:
   - pre-resolution betting privacy matters more than payout privacy
4. If adding payout features, decide whether they are:
   - live default
   - experimental / future

## Guardrails

- Do not describe the app as fully private or shielded unless wallet funding, bet placement, and payout claiming are all cryptographically hidden.
- Prefer precise phrases:
   - `private bet intent`
   - `batched market updates`
   - `public aggregate market state`
- If a feature introduces post-market reveal, document that explicitly.
