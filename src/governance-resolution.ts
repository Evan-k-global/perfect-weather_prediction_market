import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type GovernancePolicy = {
  enabled: boolean;
  timelockMs: number;
  approvers: string[];
  minApprovals: number;
};

export type EmergencyActionType = 'force-settlement' | 'pause-market' | 'resume-market';

export type EmergencyProposal = {
  id: string;
  marketKey: string;
  actionType: EmergencyActionType;
  reason: string;
  createdAtUnixMs: number;
  executeAfterUnixMs: number;
  approvals: string[];
  executed: boolean;
  executedAtUnixMs?: number;
};

export type GovernanceState = {
  policy: GovernancePolicy;
  proposals: Record<string, EmergencyProposal>;
};

export const DEFAULT_GOVERNANCE_STATE_FILE = './data/governance-resolution-state.json';

const defaultPolicy: GovernancePolicy = {
  enabled: false,
  timelockMs: 6 * 60 * 60 * 1000,
  approvers: [],
  minApprovals: 2
};

function proposalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function loadGovernanceState(
  stateFile: string = DEFAULT_GOVERNANCE_STATE_FILE
): Promise<GovernanceState> {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as GovernanceState;
    return {
      policy: parsed.policy || defaultPolicy,
      proposals: parsed.proposals || {}
    };
  } catch {
    return {
      policy: defaultPolicy,
      proposals: {}
    };
  }
}

export async function saveGovernanceState(
  state: GovernanceState,
  stateFile: string = DEFAULT_GOVERNANCE_STATE_FILE
): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function createEmergencyProposal(
  state: GovernanceState,
  input: {
    marketKey: string;
    actionType: EmergencyActionType;
    reason: string;
    proposer: string;
    nowUnixMs: number;
  }
): { state: GovernanceState; proposal: EmergencyProposal } {
  const id = proposalId();
  const proposal: EmergencyProposal = {
    id,
    marketKey: input.marketKey,
    actionType: input.actionType,
    reason: input.reason,
    createdAtUnixMs: input.nowUnixMs,
    executeAfterUnixMs: input.nowUnixMs + state.policy.timelockMs,
    approvals: [input.proposer],
    executed: false
  };
  return {
    state: {
      ...state,
      proposals: {
        ...state.proposals,
        [id]: proposal
      }
    },
    proposal
  };
}

export function approveEmergencyProposal(
  state: GovernanceState,
  proposalIdValue: string,
  approver: string
): GovernanceState {
  const proposal = state.proposals[proposalIdValue];
  if (!proposal) throw new Error(`proposal not found: ${proposalIdValue}`);
  if (proposal.executed) throw new Error('proposal already executed');
  const approvals = proposal.approvals.includes(approver) ? proposal.approvals : [...proposal.approvals, approver];
  return {
    ...state,
    proposals: {
      ...state.proposals,
      [proposalIdValue]: {
        ...proposal,
        approvals
      }
    }
  };
}

export function canExecuteEmergencyProposal(
  state: GovernanceState,
  proposalIdValue: string,
  nowUnixMs: number
): { ok: boolean; reason: string } {
  const proposal = state.proposals[proposalIdValue];
  if (!proposal) return { ok: false, reason: 'proposal not found' };
  if (proposal.executed) return { ok: false, reason: 'proposal already executed' };
  if (proposal.approvals.length < state.policy.minApprovals) {
    return { ok: false, reason: 'not enough approvals' };
  }
  if (nowUnixMs < proposal.executeAfterUnixMs) {
    return { ok: false, reason: 'timelock not elapsed' };
  }
  return { ok: true, reason: 'ready' };
}

export function markProposalExecuted(
  state: GovernanceState,
  proposalIdValue: string,
  nowUnixMs: number
): GovernanceState {
  const proposal = state.proposals[proposalIdValue];
  if (!proposal) throw new Error(`proposal not found: ${proposalIdValue}`);
  return {
    ...state,
    proposals: {
      ...state.proposals,
      [proposalIdValue]: {
        ...proposal,
        executed: true,
        executedAtUnixMs: nowUnixMs
      }
    }
  };
}
