---
name: zeko-market-ops
description: Use when deploying, syncing, repairing, or operating the Zeko testnet market stack in this repo, including zkApp deployment, per-date market creation, state sync, nightly settlement, and wallet-signed transaction troubleshooting.
---

# Zeko Market Ops

## Use This Skill For

- `src/deploy.ts`
- `src/sync-state-zeko.ts`
- `src/create-market-zeko.ts`
- `src/ensure-daily-markets-zeko.ts`
- `src/resolve-daily-market-zeko.ts`
- operator runbook and `.env.local` issues

## Workflow

1. Confirm the deployment target:
   - fresh zkApp address or legacy address
   - testnet GraphQL endpoint
   - funded deployer and zkApp accounts
2. Check env first:
   - `.env.local` is authoritative
   - `ZEKO_NETWORK_ID` must match signing domain
   - required oracle hashes must exist
3. Deploy or configure the zkApp.
4. Sync local state from on-chain events.
5. Ensure deterministic per-date markets exist.
6. Only then run server/daemon and place bets.

## Repo-Specific Guidance

- Default network should be `testnet`, not `zeko`.
- Fresh payout-enabled deployments need a new `ZKAPP_PRIVATE_KEY`; do not reuse a legacy address if old state/history is unwanted.
- `sync-state:zeko` is the standard recovery command after uncertain tx status.
- If local and on-chain `marketsRoot` differ, stop and sync before sending more market txs.
- Older ad hoc trade/claim scripts were retired and archived locally during the fast-contract cleanup; prefer the live market/oracle flows in `src/marketplace-server.ts` and browser proving instead.

## Common Failure Causes

- `Invalid_signature`: wrong network id or wrong signer key in `.env.local`.
- `Invalid proof`: upgraded code pointed at an old verification key / legacy zkApp address.
- `marketsRoot mismatch`: local operator state is stale.
- `Field.assertEquals(): ... != ...` during hosted bet/claim proving: the tx-prover was given a stale market/receipt/claimed witness after another tx updated the root; refresh state and rebuild once.
- `Update_not_permitted_app_state`: trying to deploy over an existing account incorrectly.
- `resolved` market disappears after it was already settled/claimed: event sync likely rebuilt from an incomplete snapshot; preserve monotonic state and rerun sync instead of trusting the regression.

## Guardrails

- Prefer a clean new zkApp address for contract-breaking upgrades.
- Never assume shell exports override `.env.local` in this repo.
- After deploy changes, run `pnpm build` before retrying scripts.
