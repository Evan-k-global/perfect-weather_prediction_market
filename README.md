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

## Developer Docs

- protocol vs demo: `docs/protocol-vs-demo.md`
- developer setup and implementation details: `docs/developer-setup.md`
- operator runbook: `docs/operator-runbook.md`
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
