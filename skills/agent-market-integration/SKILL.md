---
name: agent-market-integration
description: Use when integrating agents or private models into the prediction market, including model registration, private order flow, relayed execution, reveal/settle paths, and mapping agent outputs into market actions.
---

# Agent Market Integration

## Use This Skill For

- agent/model registration in `src/marketplace-server.ts`
- private order creation and relayed execution
- reveal/settle flows for agent-produced outputs
- adding agent-driven strategies or signal layers on top of the market
- documenting how agents consume or extend the market protocol

## Existing Integration Surface

Current endpoints already support an agent-oriented workflow:

- `GET /api/agents`
- `POST /api/agents/register`
- `POST /api/orders/create`
- `POST /api/orders/:id/relay-run`
- `POST /api/orders/:id/reveal-settle`

These are implemented in:
- `/tmp/private-prediction-market-main/src/marketplace-server.ts`

## Workflow

1. Decide whether the agent is:
   - a signal/model provider
   - a relayed execution actor
   - a strategy layer on top of public market state
   - a vendor of private outputs consumed by users or other agents
2. Keep the agent layer separate from:
   - oracle lifecycle
   - market state sync
   - tx-prover proving responsibilities
3. Prefer agent outputs that can be:
   - privately generated
   - selectively revealed
   - linked to market actions without forcing the market server to own the model logic
4. Keep wallet signing and market tx finalization in the existing market flow unless there is a strong reason to move them.

## Guardrails

- Do not collapse agent execution into the oracle worker.
- Do not make the tx-prover responsible for model inference or agent logic.
- Do not describe agent output as private if it is revealed in plaintext through the hosted app.
- Prefer narrow agent interfaces: signal generation, order creation, relay-run, reveal-settle.
- If agents influence betting, keep the public/private boundary explicit: public market totals can stay public even if the model signal is private.

## Extension Patterns

### 1. Private signal provider
- agent produces a forecast or recommendation off-chain
- user or relayer consumes that signal
- resulting market tx uses the normal wallet/prover flow

### 2. Model marketplace
- agent is registered as a model
- buyer creates a private order
- relayer runs the model
- output is revealed and settled through the existing order endpoints

### 3. Agent-assisted trader
- agent reads market state and oracle data
- agent proposes a trade or automates a trade trigger
- wallet still signs, market still finalizes

### 4. Future privacy upgrade
- pair agent signals with receipt commitments or a more private state model
- let agents generate private signal value without exposing it as a plainly legible market-side user action

## Code-Level Guidance

When extending the repo for agents, start here:

- `/tmp/private-prediction-market-main/src/marketplace-server.ts`
  - agent registry
  - private order creation
  - relay-run
  - reveal-settle
- `/tmp/private-prediction-market-main/skills/private-market-protocol/SKILL.md`
  - protocol boundaries
- `/tmp/private-prediction-market-main/skills/private-betting-privacy/SKILL.md`
  - privacy language and limits
- `/tmp/private-prediction-market-main/skills/demo-weather-over-under/SKILL.md`
  - demo-specific UI behavior if agent signals are surfaced in the weather market

## Recommended Architecture

- market service: render state, build/finalize transactions, host agent endpoints
- oracle worker: weather sync and market lifecycle only
- tx-prover: prove bet/claim transactions only
- agent/model layer: private signals, strategy outputs, or order fulfillment
- wallet: final signing boundary

This keeps the market reusable while allowing agents to extend the system without taking over core protocol responsibilities.
