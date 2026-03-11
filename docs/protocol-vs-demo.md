# Protocol vs Demo Market

This repo contains both reusable protocol infrastructure and one opinionated demo application.

## Reusable Protocol Layer

These parts are meant to be reused across many market types.

### On-chain protocol

- `src/contract.ts`
  - zkApp state roots
  - market creation
  - aggregate market state updates
  - oracle policy binding
  - market resolution primitives
  - experimental payout claim primitives on the upgraded contract path

### Transaction / operator plumbing

- `src/marketplace-server.ts`
  - wallet-signed tx build/finalize flow
  - private bet queue and batch processor
  - relayer-facing endpoints
  - health, readiness, and settlement APIs
- `src/state-store.ts`
  - local Merkle state persistence
- `src/chain-state.ts`
  - local/on-chain root checks
- `src/deploy.ts`, `src/sync-state-zeko.ts`, `src/ensure-daily-markets-zeko.ts`, `src/resolve-daily-market-zeko.ts`
  - deployment and operations scripts

### Oracle trust layer

- `src/weather-attest.ts`
- `src/tlsn-verifier.ts`
- shared oracle freshness / policy enforcement inside `src/marketplace-server.ts`

These are reusable because the same pattern works for other HTTPS-backed oracle sources, not only weather.

### Optional baseline extensions already included in repo

- oracle committee baseline
- governance / emergency resolution baseline
- ACP-style credit escrow + relayer baseline

These are not exposed as active demo UI flows, but they are available as protocol reference code.

## Demo-Specific Application Layer

These parts implement the current Atherton weather market demo.

### Demo market semantics

- location: Atherton, CA (`94027`)
- market type: daily temperature over/under
- rolling window: 6 dates including today
- threshold source: first-seen forecast high for that date, then locked
- current demo default threshold language: `OVER` / `UNDER`

### Demo UI and adapters

- `public/marketplace.html`
  - weather market UI
  - oracle widget
  - visualizer
  - resolved markets panel
- `src/weather-service.ts`
  - weather parsing and probability shaping
- `src/weather-hourly-sync.ts`
- `src/weather-oracle-daemon.ts`
  - demo weather refresh loop and daemon behavior
- `data/demo-daily-threshold-markets.json`
  - demo date-lock file managed by server

## What Is Live In The Demo

- wallet-connected betting
- on-chain aggregate odds/pot
- private live bet intent path
- zkTLS-backed weather oracle path
- rolling daily market creation
- automatic settlement scheduling and audit state
- resolved market tracking

## What Is Experimental / Future

- full per-user trust-minimized payout path as the default live flow
- fully shielded betting or payout privacy
- generalized market factory UX for arbitrary third-party markets

## How To Think About Extending The Repo

If you are building your own market:

1. keep the protocol layer
2. replace the demo market adapter and UI
3. keep privacy/oracle claims precise
4. only reuse the demo weather code if your source and settlement semantics are similar

## Recommended Skills

- protocol changes: `skills/private-market-protocol/SKILL.md`
- zkTLS oracle work: `skills/zktls-weather-oracle/SKILL.md`
- Zeko deploy/ops: `skills/zeko-market-ops/SKILL.md`
- privacy wording / batching: `skills/private-betting-privacy/SKILL.md`
- demo weather UI: `skills/demo-weather-over-under/SKILL.md`


## How Agents Plug In

Agents are an application-layer extension on top of the protocol, not a special-case side demo.

Current plug-in points:

- register models with `/api/agents/register`
- sell private model output through `/api/orders/create`
- run relayed model execution through `/api/orders/:id/relay-run`
- reveal and settle outputs through `/api/orders/:id/reveal-settle`

This means developers can use the repo in three different modes:

1. pure prediction market
2. prediction market plus private model marketplace
3. agent-assisted trading / signal generation on top of the same oracle and market infrastructure

