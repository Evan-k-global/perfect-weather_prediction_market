# Build Recommendations

This document captures the practical lessons from building the weather market locally, pushing it to hosted infrastructure, adding workers and extra proving services, and then simplifying back toward a cleaner architecture.

## Short recommendation

For this repo, the best default architecture is:

- **market web service**
  - UI
  - lightweight API
  - state read/finalize/indexing
- **oracle worker**
  - create next daily markets
  - resolve finished markets
  - keep forecast/oracle freshness current
- **browser/client**
  - prove active on-chain bets locally
  - sign and send with the wallet
- **operator / queue**
  - optional fallback only
  - not the primary betting UX

## What broke and why

### 1. Server-side proving on the market service was too fragile

We repeatedly saw:

- long request times
- 502s
- Render startup instability
- the web service wedging during heavy proving

The root problem was not just “not enough memory.” The market service was doing too much:

- serving the UI
- syncing state
- handling weather/oracle API reads
- sometimes proving large transactions

That is too much responsibility for one hosted process.

### 2. Adding workers did not fix a heavy proving surface

We tried:

- operator worker for queued settlement
- separate tx-prover service
- larger machine sizes

These helped isolate failures, but they did not change the core problem when the proving surface itself was too large or the local state model was brittle.

The biggest lesson:

- more services are not a substitute for simpler protocol design

### 3. The private queue improved privacy but hurt UX and operability

The old queued path did have a privacy advantage:

- it obscured direct wallet-to-side attribution better than direct public bets

But it also introduced:

- delayed settlement
- queue backlogs
- stale head poisoning
- operator memory pressure
- unclear pricing/slippage behavior during bursts

That path is useful as an experiment in private intent, but it is not the best default user experience for this demo.

### 4. Old state trees became a recovery trap

One of the most expensive failures came from a state model that depended on an authoritative local positions tree which could not be fully reconstructed from chain events.

That created:

- `positionsRoot mismatch`
- broken claims
- inability to recover by just “syncing from chain”

The lesson is clear:

- if a local tree is critical, it must be reconstructible or resettable

### 5. Browser proving works better only if the contract is deliberately small

Moving to browser/client proving was directionally right:

- uses the user’s machine
- avoids hosted bottlenecks
- improves privacy and scaling

But we also learned:

- a large all-in-one contract is still too slow even in the browser
- moving a heavy contract from server to browser does not make it magically fast

So the real requirement is:

- small hot-path contract
- minimal bet proving surface
- separate claim/fallback logic outside the critical path

## Recommended architecture

### Active betting

Use browser-side proving for active on-chain markets.

Flow:

1. market service returns a lightweight bet context and witnesses
2. browser worker compiles/proves locally
3. wallet signs and sends
4. market service finalizes local metadata

Why:

- user machine does the heavy work
- market service stays responsive
- no operator dependency for normal bets

### Market creation and resolution

Use the oracle worker.

Responsibilities:

- create forward daily markets before users need them
- resolve markets after the determination window
- keep this off the market web service

Why:

- market creation should be background upkeep
- users should not depend on operator fallback just to bet tomorrow’s market

### Privacy model

Prefer:

- public pool and odds movement
- more private user intent attribution

This repo’s practical privacy target is:

- don’t trivially expose one wallet -> one side -> one timing edge at the moment of the bet
- it is acceptable that aggregate market movement is public

That is much more realistic for a market product than trying to hide all post-trade information.

### Queue / operator

Treat the queue as:

- fallback
- research surface
- optional privacy experiment

Do not make it the default UX unless:

- you intentionally want delayed micro-batch privacy
- and you are willing to accept more operational complexity

## What to keep small

The hot proving path should include only what a bet actually needs.

Good candidates for the hot contract/program:

- create market
- place receipt bet
- resolve market

Bad candidates for the hot path:

- legacy claimable positions
- old payout logic
- emergency recovery methods
- multiple unrelated proving branches in the same contract surface

## Hosting guidance

### Local development

Local runs can mask hosted problems.

Why:

- your machine is often much stronger
- disk and cache behavior differ
- browser and Node prove differently than constrained hosted services

Always verify hosted assumptions separately:

- startup behavior
- readiness behavior
- memory/CPU limits
- state sync timing

### Hosted market service

Keep it lean.

It should not:

- prove normal bets
- run heavy queue settlement
- become the place where every recovery path and legacy mode meets

### Hosted workers

Use workers only for clearly background responsibilities:

- oracle upkeep
- optional operator fallback

Workers are useful when they isolate background duties. They are not automatically useful just because a system is struggling.

## Recovery recommendations

From this project’s failures:

- keep clean fresh-zkApp rollout tooling
- archive and reset hosted state intentionally during contract migrations
- prefer new zkApp addresses for contract-breaking changes
- avoid state models that require unreconstructible local trees

## Recommended decision order for future work

When a path is slow or unstable, check in this order:

1. Is the proving surface too large?
2. Is the hot path doing unnecessary server work?
3. Is a worker being used for something that should be background only?
4. Is the privacy model asking for batching where the UX really wants direct execution?
5. Is a state tree recoverable from chain if things go wrong?

This order matters. In this repo, most pain came from solving #2 and #3 before fully solving #1 and #5.
