# Local Prover Mode

This mode is for power users who want the current hosted app flow, but want heavy proving to run on their own machine instead of in the browser or on the shared hosted tx-prover.

## Why This Exists

Browser proving and shared hosted proving each hit real limits:

- browser memory ceilings are much lower than total machine RAM
- long `o1js` proofs can make a browser tab unstable or unresponsive
- a shared hosted prover can become the bottleneck even for one active tester

Local prover mode keeps the user-visible flow the same while moving the expensive part into a local Node process.

## Target UX

The intended flow is:

1. browser loads the hosted market UI
2. browser asks the hosted market service for bet or claim context
3. browser sends that context to a local prover on `127.0.0.1`
4. local prover returns proved tx JSON
5. browser hands the tx to the wallet for signing and submission
6. hosted market still handles finalize, indexing, and wallet activity

That means:

- wallet signing still stays in-wallet
- market rendering still comes from the hosted web service
- oracle lifecycle still stays on the hosted oracle worker
- only the heavy proving step moves local

## What It Solves

- avoids browser-memory bottlenecks during compile/prove
- avoids shared hosted prover contention
- lets a power user use their own machine RAM and CPU directly
- keeps the normal wallet UX and hosted market UX intact

## What It Does Not Solve

- stale or wrong market state
- contract bugs
- finalization/indexing bugs
- chain inclusion delays

This is a proving-placement improvement, not a full protocol change.

## Minimal Architecture

Use the existing split, but replace only the proving hop:

- hosted `perfect-weather-prediction-market`
  - UI
  - market context build
  - finalize
  - wallet activity
- hosted `perfect-weather-oracle-worker`
  - market creation
  - weather sync
  - resolution
- local `tx-prover`
  - `POST /prove/market-bet`
  - `POST /prove/claim-payout`

## Practical Deployment Shapes

### Option 1: Full local stack

This is the easiest developer path:

```bash
pnpm build
pnpm marketplace:serve
pnpm oracle:worker
pnpm tx-prover:serve
```

This avoids both browser limits and hosted-prover contention, but it is not the hosted-user flow.

### Option 2: Hosted market + local prover

This is the more interesting power-user mode.

The browser stays on the hosted market site, but remote proving is redirected to a local prover.

The cleanest version would be:

1. add a local-only UI toggle like `Use local prover`
2. point prove requests to `http://127.0.0.1:10001`
3. keep all non-proving requests on the hosted market

That gives the user:

- hosted market data
- hosted oracle updates
- local proof generation
- wallet signing as usual

## Security Model

If local prover mode is added, keep it simple:

- local prover should only listen on `127.0.0.1`
- local prover should still require its action token
- do not expose the local prover on a public interface
- do not reuse broader oracle/admin tokens for prover access

## Recommended Implementation Approach

If we productize this, keep the changes narrow:

1. add a local prover endpoint override in the frontend
2. keep the same request payloads already used by the hosted prover
3. do not fork the transaction format
4. do not add a second finalize path
5. do not introduce queueing or worker pools just for local mode

The important idea is:

- same tx context
- same proved tx shape
- different proving location

## Good Fit

Local prover mode is a good fit for:

- internal testing
- demos with a technical operator
- power users who want better reliability than shared hosted proving
- debugging browser-memory or hosted-prover bottlenecks

## Bad Fit

It is not a good default for:

- zero-install consumer UX
- casual demo viewers
- mobile-first users

## Recommendation

Treat local prover mode as a supported advanced path, not the primary public UX.

That gives this project:

- a clean fallback when hosted proving is flaky
- a way around browser memory constraints
- a practical high-reliability path for serious testers

without forcing every user to run local infrastructure.
