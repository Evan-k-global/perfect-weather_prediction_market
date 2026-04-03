# Perfect Weather Prediction Market

A Zeko testnet prediction market demo that combines:

- real on-chain daily markets
- wallet-signed betting
- lean remote tx proving for wallet-signed bets and claims
- zkTLS-backed weather oracle verification
- agent/model plug-in points for private signals and relayed execution

## What We Built

### Protocol layer

Reusable infrastructure for other markets:

- zkApp market contract and state roots
- wallet tx build/finalize flow
- hosted oracle lifecycle and tx-prover split
- zkTLS / TLSNotary oracle verification path
- Zeko deploy, sync, and per-date market ops scripts

### Demo application layer

A concrete weather market built on that protocol:

- Atherton, CA daily high temperature over/under markets
- rolling 6-day market window including today
- one locked threshold per date
- weather oracle widget and visualizer
- resolved markets panel

## Why It Is Interesting

This demo is trying to solve three real problems at once:

- **oracle integrity**: weather data can be verified through zkTLS instead of blindly trusting a backend fetch
- **bet privacy**: hosted services stay out of wallet signing while keeping user transaction metadata separate from oracle lifecycle work
- **developer extensibility**: the protocol layer can be reused for other markets, and agents can plug in as private model or signal providers

## What Is Private

This repo supports **wallet-signed user transactions with a hosted oracle/prover split**, not full shielded finance.

- wallet activity is still public on-chain
- aggregate market state is public on-chain
- user signing still happens in-wallet, while hosted services are split so market rendering, oracle lifecycle, and tx proving do not fight each other

That is the deliberate tradeoff for this demo.

## Agents Plug In Here

The repo already exposes an agent/model integration surface:

- model registry: `/api/agents`
- private order creation: `/api/orders/create`
- relayer/model execution: `/api/orders/:id/relay-run`
- reveal + settlement: `/api/orders/:id/reveal-settle`

That means developers can use the same protocol for:

- pure prediction markets
- prediction markets plus private model marketplaces
- agent-assisted trading and signal generation

## Fork And Run

```bash
pnpm install
pnpm build
pnpm marketplace:serve
```

Open:

- `http://127.0.0.1:8790/marketplace`

If you want the weather oracle loop running too:

```bash
pnpm oracle:worker
```

## Deployment Modes

Recommended hosted split:

- `perfect-weather-prediction-market`
  - UI
  - fast state rendering
  - tx context/finalize
- `perfect-weather-oracle-worker`
  - weather sync
  - daily market creation
  - overdue market resolution
- `perfect-weather-tx-prover`
  - bet/claim proving only

Not part of the normal hosted path:

- operator worker
- queue-based private batching
- browser proving as the primary UX path

## Build Recommendation

After iterating through local builds, hosted Render deploys, heavy worker splits, server-side provers, and browser proving, the current recommendation is:

- keep the **market web service** focused on UI, lightweight API state, and finalize/indexing
- keep the **oracle worker** responsible for weather sync, rolling market creation, and overdue resolution
- keep the **tx-prover** narrowly focused on bet/claim proving
- keep the **operator / private queue** out of the normal user betting path
- prebuild and reuse compile caches so lower-tier hosted instances survive cold boot more reliably

### What we learned the hard way

- Browser proving for this contract surface was far too slow in practice; local Node proving and a lean remote prover were dramatically better.
- Moving heavy proving onto the hosted web service causes slow responses, 502s, and rollout instability.
- Adding more workers and services does not fix a broken core proving/state model. It can hide the problem while increasing operational complexity.
- The old queued private-bet path improved privacy in one dimension, but it was too slow and operationally awkward for primary UX.
- State trees that cannot be reconstructed from chain events become recovery hazards. Fresh zkApp rollouts and clean recovery tooling matter.
- Hosted state sync and oracle imports must preserve wallet metadata like `receiptMeta`, or the UI loses claimability even when on-chain state is correct.
- Oracle resolution should not depend only on active-window UI metadata; rolled-off markets still need durable date mapping so overdue resolution can continue.
- Build-time and runtime compile caches materially reduce cold-start CPU and RAM pressure on hosted services.

### Current architectural direction

- **Public market state, more private user intent**
  - pool and odds can be public
  - user directional intent should not be trivially attributable at click time
- **Fast path**
  - active market exists on-chain
  - tx-prover builds the bet/claim transaction
  - wallet signs and sends
- **Background path**
  - oracle worker creates the next daily markets and resolves finished ones
- **State path**
  - hosted market persists wallet activity / claim metadata for fast rendering

### What to avoid

- Do not put normal bet proving behind the operator queue unless you deliberately want slower micro-batch privacy.
- Do not let startup sync or oracle imports overwrite fresh wallet metadata.
- Do not treat extra hosted workers as a substitute for simplifying the proving surface.
- Do not mix legacy claim/position machinery back into the hot bet path unless you accept much slower proofs.
- Do not assume local success means hosted success; Render memory/CPU, cold compile time, and startup races exposed issues that did not show up locally.

## Developer Docs

- protocol vs demo: `docs/protocol-vs-demo.md`
- developer setup and implementation details: `docs/developer-setup.md`
- operator runbook: `docs/operator-runbook.md`
- build recommendations and architecture retrospective: `docs/build-recommendations.md`
- local prover mode for power users: `docs/local-prover-mode.md`
- zkTLS hardening notes: `docs/zktls-hardening-notes.md`
- production deploy and fresh-zkApp rollout: `deploy/README.production.md`
- blog post / overview: `docs/blog-zeko-private-market.md`
- docs index: `docs/index.md`

## Skills

- `skills/private-market-protocol/SKILL.md`
- `skills/zktls-weather-oracle/SKILL.md`
- `skills/zeko-market-ops/SKILL.md`
- `skills/zeko-event-sync-and-archive/SKILL.md`
- `skills/private-betting-privacy/SKILL.md`
- `skills/demo-weather-over-under/SKILL.md`
- `skills/agent-market-integration/SKILL.md`

Recent hosted learnings worth preserving:
- retry tx-prover work once after refreshing state if proving hits a root assertion mismatch
- keep `/api/tx/finalize` resilient because wallet send success and hosted status persistence can fail independently
- treat market resolution and receipt claims as monotonic during sync; incomplete event snapshots should not erase already-resolved or already-claimed state
