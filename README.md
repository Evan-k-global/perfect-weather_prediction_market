# Perfect Weather Prediction Market

A Zeko testnet prediction market demo that combines:

- real on-chain daily markets
- wallet-signed betting
- private live bet intent via batching
- zkTLS-backed weather oracle verification
- agent/model plug-in points for private signals and relayed execution

## What We Built

### Protocol layer

Reusable infrastructure for other markets:

- zkApp market contract and state roots
- wallet tx build/finalize flow
- private bet batching path
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
- **bet privacy**: live bet intent is batched instead of being exposed as a simple direct public market-side update
- **developer extensibility**: the protocol layer can be reused for other markets, and agents can plug in as private model or signal providers

## What Is Private

This repo supports **private live betting intent**, not full shielded finance.

- wallet activity is still public on-chain
- aggregate market state is public on-chain
- live per-user bet intent is batched and not exposed as a simple direct one-wallet-one-side market update

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
pnpm weather:daemon
```

## Deployment Modes

### Unified demo service

Recommended for demos and small hosted deployments:

- one service runs:
  - `marketplace:serve`
  - `weather:daemon`
  - private batch proving
  - on-chain daily market ensure/resolve
- simpler operations
- higher RAM requirement

This is the current recommended Render mode if you want the full product behavior in one place. Use enough memory headroom for o1js proving and daemon activity.

### Split production services

Recommended once you want stricter operational boundaries:

- web service:
  - UI/API
  - oracle status and market display
- worker/operator service:
  - private batch proving
  - on-chain market creation
  - on-chain resolution

The repo now includes this split mode directly for Render:

- web service:
  - `perfect-weather-prediction-market`
- worker service:
  - `perfect-weather-operator-worker`

Why split:

- isolates user traffic from proving spikes
- reduces web-service memory pressure
- gives better control over settlement/operator jobs

## Build Recommendation

After iterating through local builds, hosted Render deploys, heavy worker splits, server-side provers, and browser proving, the current recommendation is:

- keep the **market web service** focused on UI, lightweight API state, and finalize/indexing
- keep the **oracle worker** responsible for forward market creation and resolution
- keep the **operator / private queue** out of the normal user betting path
- use **client-side proving** for active on-chain bets
- treat any queued/deferred path as exceptional fallback only, not primary UX

### What we learned the hard way

- A large all-in-one zkApp contract is too heavy for fast browser proving and too fragile for web-service proving.
- Moving heavy proving onto the hosted web service causes slow responses, 502s, and rollout instability.
- Adding more workers and services does not fix a broken core proving/state model. It can hide the problem while increasing operational complexity.
- The old queued private-bet path improved live intent privacy, but it was operationally slow and economically awkward without slippage controls.
- State trees that cannot be reconstructed from chain events become recovery hazards. Fresh zkApp rollouts and clean recovery tooling matter.
- Browser proving is a better fit for active bets than server proving, but only if the proving surface is intentionally small.

### Current architectural direction

- **Public market state, more private user intent**
  - pool and odds can be public
  - user directional intent should not be trivially attributable at click time
- **Fast path**
  - active market exists on-chain
  - browser builds and proves the bet locally
  - wallet signs and sends
- **Background path**
  - oracle worker creates the next daily markets and resolves finished ones
- **Deferred path**
  - claims and richer receipt-root settlement can happen after the hot betting path

### What to avoid

- Do not put normal bet proving behind the operator queue unless you deliberately want slower micro-batch privacy.
- Do not treat extra hosted workers as a substitute for simplifying the proving surface.
- Do not mix legacy claim/position machinery back into the hot bet path unless you accept much slower proofs.
- Do not assume local success means hosted success; Render memory/CPU and startup behavior exposed several issues that did not show up locally.

## Developer Docs

- protocol vs demo: `docs/protocol-vs-demo.md`
- developer setup and implementation details: `docs/developer-setup.md`
- operator runbook: `docs/operator-runbook.md`
- build recommendations and architecture retrospective: `docs/build-recommendations.md`
- zkTLS hardening notes: `docs/zktls-hardening-notes.md`
- production deploy and fresh-zkApp rollout: `deploy/README.production.md`
- blog post / overview: `docs/blog-zeko-private-market.md`
- docs index: `docs/index.md`

## Skills

- `skills/private-market-protocol/SKILL.md`
- `skills/zktls-weather-oracle/SKILL.md`
- `skills/zeko-market-ops/SKILL.md`
- `skills/private-betting-privacy/SKILL.md`
- `skills/demo-weather-over-under/SKILL.md`
