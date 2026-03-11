# Building a Private Prediction Market on Zeko with zkTLS, Wallet-Signed Bets, and Agent Plug-Ins

Most prediction market demos do one thing well. They either show a nice market UI, a toy oracle, or a zk-branded contract that does not actually address the hard parts of the product. This project was built to do something more complete: show what a modern private prediction market can look like when you take oracle integrity, wallet UX, private bet intent, and developer extensibility seriously.

The result is a working Zeko testnet demo with real on-chain daily markets, wallet-signed betting, a zkTLS-backed weather oracle, a rolling settlement loop, and a clear path for agents to plug in private signals and model outputs. It is not full shielded finance, and we are explicit about that. But it is a serious, technically coherent step toward a category of applications that feel much more aligned with what zero knowledge should actually enable.

## Why this is interesting

A normal on-chain prediction market has three obvious weaknesses.

First, the oracle path is usually weak. A backend fetches some API, parses JSON, and pushes a result on-chain. Even when the smart contract is correct, the trust model is often just “trust our server.”

Second, the betting path is usually too public. If everyone can trivially see exactly what each wallet is betting while the market is still live, users leak their alpha. In many real markets, that is unacceptable. The most valuable information is not the payout after the fact. It is the signal embedded in the bet before the market resolves.

Third, most demos are not really extensible. They have one hardcoded market, one data path, and no obvious way for agents, private models, or relayers to become first-class participants.

This project tries to address all three.

## What we built

At the protocol layer, the repo contains a reusable prediction market foundation:

- a zkApp contract for market roots, aggregate market state updates, and oracle policy binding
- wallet-signed transaction build/finalize flow
- private bet batching path
- deployment, sync, and per-date market operations scripts
- zkTLS/TLSNotary verification plumbing for HTTPS-backed oracle sources

On top of that protocol layer, the demo application implements a concrete market:

- Atherton, California daily weather over/under markets
- one locked threshold per date
- a rolling 6-day window including today
- automatic oracle refresh and settlement scheduling
- a clean UI for placing bets, viewing odds, and inspecting resolved markets

The contract and operator layer are designed to be reusable. The Atherton weather adapter is just one opinionated app sitting on top.

## Why Zeko and zk matter here

Zeko matters because this is not just a database app with a blockchain front-end attached. The contract state and market transitions are meant to be enforced in a proof-aware environment, not hidden behind server trust.

The zkApp layer gives us something important: the application can move market state forward in a way that is constrained by circuit logic and verifiable state transitions. Market creation, aggregate odds movement, and oracle resolution are not just “requests to a backend.” They are part of a proof-oriented state machine.

That changes the design space.

You can still use a server as an operator, coordinator, or relayer, but the server is not the final source of truth. It is an execution layer around a verifiable core.

For prediction markets, that is a big deal. These apps live or die on trust assumptions. If users think the operator can change outcomes, rewrite markets, or arbitrarily settle conditions, the product is not interesting. Zeko plus zkApp constraints tighten those assumptions meaningfully.

## The zkTLS piece is one of the most important parts

The oracle path is where many otherwise-good crypto apps collapse. If the on-chain logic is perfect but the source data path is weak, the market is weak.

That is why we spent real time hardening the zkTLS path.

This project uses zkTLS / TLSNotary to attest to data fetched from the weather source rather than blindly trusting a server fetch. In strict mode, the app checks:

- the allowed server name
- the exact request path
- attestation age / freshness
- whether the latest snapshot is acceptable for settlement

This is not cosmetic zero-knowledge branding. It materially changes the oracle trust model.

We also had to do real integration work to make it usable in practice. NOAA/NWS responses were not a clean, one-shot happy path for the demo. We had to stabilize the prover/notary flow, make request behavior more deterministic, trim payload assumptions, bind the policy carefully, and add better readiness and timeout behavior.

That work is documented in [zktls-hardening-notes.md](/Users/evankereiakes/Documents/Codex/private-prediction-market/docs/zktls-hardening-notes.md), and it is one of the strongest technical pieces in the repo. It turns “our server says the weather was X” into something much more defensible.

## What is private, and what is not

We are careful not to overclaim.

This demo supports private live bet intent, not full shielded finance.

That means:

- wallet activity is still public on-chain
- aggregate market state is public on-chain
- but live per-user bet intent is batched and not exposed as a simple direct one-wallet-one-side public market update

That balance matters.

For users, the most important privacy property in a prediction market is often pre-resolution privacy. If other traders can see your exact directional bet while the market is live, your signal leaks immediately. That can be more damaging than the eventual public visibility of payouts or aggregate state.

So this demo prioritizes the privacy that matters most for the product: protecting the live informational edge of the bettor.

## The agent angle is not an afterthought

One of the more interesting things about this repo is that agents can plug into it directly.

There is already an agent/model integration surface in the server:

- `/api/agents` for model registry
- `/api/agents/register` for adding new agent entries
- `/api/orders/create` for private prompt/order creation
- `/api/orders/:id/relay-run` for relayer/model execution
- `/api/orders/:id/reveal-settle` for reveal and settlement of model output

This matters because the product is not just “users bet on public information.” It can also become “users buy or consume private model outputs, then use those outputs to inform or automate market behavior.”

That creates a compelling design space:

- private model signals
- relayer-mediated execution
- agent-driven market making or strategy support
- private analytics that feed into public aggregate market action

In other words, the market protocol is not only compatible with agents. It is a natural substrate for them.

That is one of the reasons this repo is more interesting than a simple one-market demo. It has a reusable protocol layer, and agents can slot into that layer as private-signal producers, relayed executors, or model vendors.

## Operationally, this is a serious demo

The system is not just a static page and a contract. It includes:

- deployment and sync scripts for Zeko testnet
- per-date market creation
- oracle daemon flow
- periodic and nightly settlement checks
- persisted scheduler state on disk
- health and readiness endpoints
- explicit documentation for operators and developers

This matters because prediction markets are not just contract design. They are operations. Oracle freshness, nightly settlement, root consistency, signer correctness, relayer behavior, and recovery tooling all determine whether the app is credible.

The repo now includes that operational layer, not just the headline features.

## Why this is a strong foundation

The most exciting part of this project is not that it solves every possible privacy or payout problem today. It is that the architecture is honest, extensible, and already useful.

Developers can take the reusable parts:

- zkApp market logic
- private batching path
- zkTLS oracle verification
- deployment and sync tooling
- agent integration surface

and swap out the demo layer:

- new market semantics
- new oracle source
- different settlement logic
- different UI
- different agent/model strategy layer

That is exactly what a strong protocol-plus-demo repo should do. It should provide a credible foundation and a working reference application without pretending the reference application is the entire protocol universe.

## Where this goes next

The next frontier is obvious: richer payout rails and stronger privacy.

Today, the system optimizes for private live betting intent and a strong oracle path. The future work is around how far to push shielded claims, payout handling, and more generalized market factories.

But even before those upgrades, this repo already demonstrates something valuable: zero knowledge is not just for proving that a toy computation happened. It can make an application more trustworthy, more private where it matters, and more composable for agents and market operators.

That is why this build is cool. It is not only a weather market. It is a credible blueprint for what private, agent-aware, oracle-hardened on-chain markets can look like when the zero-knowledge layer is treated as infrastructure instead of marketing.
