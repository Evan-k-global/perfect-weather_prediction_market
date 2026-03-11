# Per-Date Payout Upgrade

This document describes the contract upgrade required to move the demo from:

- on-chain aggregate market state
- on-chain oracle resolution
- off-chain per-date settlement tracking

to:

- per-date claimable markets
- per-user verifiable payout rights
- on-chain payout execution

## Why The Current Contract Stops Short

The current zkApp supports:

- `createMarket()`
- `placePrivateBet()`
- `resolveWeatherMarket()`

This is enough to maintain:

- one market root
- aggregate totals
- oracle-based final outcome

It is not enough to pay winners, because the contract does not currently expose:

- a per-user payout entitlement format
- a per-user claim verification method
- a replay-protected payout method

So today the system can say:

- market `2026-03-12` settled
- observed high was `68F`
- winning side was `under`
- total pool was `X`

But it cannot yet prove and pay:

- wallet `A` is entitled to `Y`
- wallet `A` has not already claimed

That is why the next three pieces are necessary.

## 1. Per-User Claim Commitments Or Claim Proofs

### Problem

Aggregate market totals are not enough to derive a safe user payout on-chain.

Even if the app knows off-chain that a user bet `5 tMINA` on `over` for `2026-03-12`, the contract does not have a trustless way to verify that claim later.

### Required Upgrade

Each user position must become claimable in one of two ways:

#### A. Public claim ledger

The chain stores enough information to later verify:

- user public key
- market/date key
- side
- amount
- claim status

This is simpler, but weakens privacy.

#### B. Private claim commitment path

The chain stores:

- a commitment to the user bet/position
- a nullifier when claimed

The claimant later proves in zero knowledge:

- they know the opening to a winning commitment
- it belongs to the resolved market/date
- it has not been claimed before
- the payout amount is computed correctly

This fits the privacy direction better.

### Why It Is Necessary

Without claim commitments or proofs, payout becomes:

- operator-managed
- file-based
- trust-based

That is not enough for a protocol-grade market.

## 2. zkApp Payout Method

### Problem

Resolution is not payout.

After a market is resolved, users still need a contract method that transfers funds according to provable entitlement.

### Required Upgrade

Add a payout method such as:

- `claimPayout(...)`

This method must verify:

- market is resolved
- winning side is known
- claim belongs to that exact market/date
- claim amount is valid
- claim was not previously redeemed

If privacy is preserved, this method also needs:

- claim nullifier checks
- commitment membership proof
- payout note creation or public payout transfer rules

### Why It Is Necessary

Without a contract payout method, the system is incomplete:

- it can settle a result
- it cannot settle money to winners in a trust-minimized way

This is the main functional gap between the current demo and a full market protocol.

## 3. Per-Date Market Key Strategy

### Problem

Each calendar date is logically its own market:

- own threshold
- own final observed value
- own winning side
- own payout pool

If the chain does not isolate claims by date-specific market key, payout logic becomes ambiguous and dangerous.

### Required Upgrade

Move to a one-market-per-date model at the contract level.

Recommended key derivation:

- `marketKey = Poseidon(baseConfigHash, localDateField)`

Where:

- `baseConfigHash` identifies the market family, for example Atherton daily O/U
- `localDateField` identifies the specific market date

This ensures:

- `2026-03-10` and `2026-03-11` are distinct claim domains
- payouts cannot leak across dates
- settlement, claim, and audit paths all refer to one exact date-keyed market

### Why It Is Necessary

If a claim is not tied to an exact per-date market key, then:

- payout math can bleed between dates
- claims can target the wrong resolved outcome
- auditability becomes weak

Per-date isolation is the basis of safe payout accounting.

## Recommended Upgrade Shape

### Contract V2 states

- `marketsRoot`
- `positionsRoot`
- `claimsNullifierRoot`
- `usedOracleNonceRoot`
- oracle policy fields

### Contract V2 methods

- `createMarket()`
- `placePrivateBet()`
- `resolveWeatherMarket()`
- `claimPayout()`

### Claim flow

1. User funds bet and a position commitment is created.
2. Market/date resolves on-chain.
3. User submits claim proof.
4. Contract checks:
   - market resolved
   - commitment belongs to this market/date
   - side matches resolved outcome
   - nullifier unused
5. Contract marks nullifier spent and pays or mints payout note.

## Privacy Options

### Minimal V2

- public user claim amounts
- simpler implementation
- weaker privacy

### zk-strong V2

- private commitment-based claims
- nullifiers for replay protection
- optional shielded payout notes
- stronger privacy, higher proving complexity

## Practical Recommendation

If the goal is to continue this protocol rather than stop at the demo:

1. Introduce one market key per date.
2. Add claim commitments/nullifiers.
3. Add `claimPayout()` to the zkApp.
4. Keep the current batched private intent architecture as the bet entry path.

This is the cleanest path from the current codebase to real per-user payout.

## Why This Is The Correct Place To Pause If Not Upgrading

If you do not implement the three items above, the repo remains:

- a strong demo of private intent + zkTLS oracle + aggregate market resolution

but not yet:

- a full trust-minimized payout protocol

That is a legitimate stopping point for a demo, but not for final protocol claims.
