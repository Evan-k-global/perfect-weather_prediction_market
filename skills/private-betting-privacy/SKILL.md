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

Use this skill to extract reusable privacy language that another builder or agent could apply to a different market, not just to describe this repo’s UI.

## Privacy Model In This Repo

Live default:
- wallet activity is public on-chain
- aggregate market state is public on-chain
- wallet signing stays local
- market, oracle, and tx-prover are split so no single hosted service owns the entire user flow
- a sophisticated observer can still correlate wallet tx timing and market state changes

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
- Keep claim wording honest:
   - claim proving and wallet signing can succeed while hosted finalize still fails
   - until finalize persists status, the UI should not imply that payout metadata is settled
   - local wallet signing remains a key privacy boundary even when proving/finalize are hosted
   - hosted wallet activity can be optimistic before chain inclusion; do not imply that a wallet hash means the bet already changed public market state

## Next Privacy Step

The smallest meaningful privacy upgrade beyond the current design is a receipt-commitment model. Instead of exposing a plainly inferable per-user bet record, the market stores a commitment to the user bet and proves in zk that the committed bet is valid and that public aggregate market totals were updated correctly. Observers can still see that a wallet transaction happened and that market state changed, but they no longer get a simple public record that directly spells out the user’s bet details.

## Agent Implementation Outline

If extending this market for stronger privacy with the smallest rewrite:

1. Keep public aggregate market totals and public market resolution.
2. Replace any user-explicit position representation with:
   - `receiptCommitment`
   - `receiptsRoot`
   - `claimedReceiptsRoot`
3. Bet proving should only show publicly:
   - the market root update
   - the receipts root update
   - a valid committed receipt insertion
4. Claim proving should verify:
   - receipt inclusion
   - claimant ownership
   - winning-side eligibility
   - not-already-claimed status
5. Keep UX metadata (`receiptMeta`, claim status, market date mapping) off-chain and wallet-scoped.

## Generalized Guidance

When documenting privacy for another market or agent workflow:

- separate “private from casual users” from “private from sophisticated observers”
- separate “private from the public” from “private from the application operator”
- describe local signing, remote proving, and hosted metadata as distinct trust boundaries
- treat receipt commitments as a legibility reduction, not as full concealment
