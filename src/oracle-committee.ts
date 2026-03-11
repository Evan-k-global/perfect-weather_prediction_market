import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type OracleCommitteePolicy = {
  enabled: boolean;
  mode: 'single-zktls-oracle' | 'zktls-committee';
  quorum: number;
  members: string[];
};

export type OracleCommitteeCommit = {
  memberId: string;
  snapshotHash: string;
  attestationHash: string;
  committedAtUnixMs: number;
};

export type OracleCommitteeRound = {
  roundId: string;
  marketDate: string;
  commits: OracleCommitteeCommit[];
  finalized?: {
    snapshotHash: string;
    attestationHash: string;
    votes: number;
    finalizedAtUnixMs: number;
  };
};

export type OracleCommitteeState = {
  policy: OracleCommitteePolicy;
  rounds: Record<string, OracleCommitteeRound>;
};

export const DEFAULT_COMMITTEE_STATE_FILE = './data/oracle-committee-state.json';

const defaultPolicy: OracleCommitteePolicy = {
  enabled: false,
  mode: 'single-zktls-oracle',
  quorum: 2,
  members: []
};

export async function loadOracleCommitteeState(
  stateFile: string = DEFAULT_COMMITTEE_STATE_FILE
): Promise<OracleCommitteeState> {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as OracleCommitteeState;
    return {
      policy: parsed.policy || defaultPolicy,
      rounds: parsed.rounds || {}
    };
  } catch {
    return {
      policy: defaultPolicy,
      rounds: {}
    };
  }
}

export async function saveOracleCommitteeState(
  state: OracleCommitteeState,
  stateFile: string = DEFAULT_COMMITTEE_STATE_FILE
): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function submitCommitteeCommit(
  state: OracleCommitteeState,
  input: {
    roundId: string;
    marketDate: string;
    memberId: string;
    snapshotHash: string;
    attestationHash: string;
    nowUnixMs: number;
  }
): OracleCommitteeState {
  const round = state.rounds[input.roundId] || {
    roundId: input.roundId,
    marketDate: input.marketDate,
    commits: []
  };
  if (round.finalized) {
    throw new Error(`round ${input.roundId} already finalized`);
  }

  const filtered = round.commits.filter((c) => c.memberId !== input.memberId);
  filtered.push({
    memberId: input.memberId,
    snapshotHash: input.snapshotHash,
    attestationHash: input.attestationHash,
    committedAtUnixMs: input.nowUnixMs
  });

  return {
    ...state,
    rounds: {
      ...state.rounds,
      [input.roundId]: {
        ...round,
        commits: filtered
      }
    }
  };
}

export function tryFinalizeCommitteeRound(
  state: OracleCommitteeState,
  roundId: string,
  nowUnixMs: number
): { state: OracleCommitteeState; finalized: boolean } {
  const round = state.rounds[roundId];
  if (!round || round.finalized) return { state, finalized: false };
  const quorum = Math.max(1, state.policy.quorum);

  const tally = new Map<string, { votes: number; snapshotHash: string; attestationHash: string }>();
  for (const commit of round.commits) {
    const key = `${commit.snapshotHash}::${commit.attestationHash}`;
    const prev = tally.get(key);
    if (prev) prev.votes += 1;
    else {
      tally.set(key, {
        votes: 1,
        snapshotHash: commit.snapshotHash,
        attestationHash: commit.attestationHash
      });
    }
  }

  let winner: { votes: number; snapshotHash: string; attestationHash: string } | null = null;
  for (const item of tally.values()) {
    if (item.votes >= quorum && (!winner || item.votes > winner.votes)) {
      winner = item;
    }
  }
  if (!winner) return { state, finalized: false };

  return {
    state: {
      ...state,
      rounds: {
        ...state.rounds,
        [roundId]: {
          ...round,
          finalized: {
            snapshotHash: winner.snapshotHash,
            attestationHash: winner.attestationHash,
            votes: winner.votes,
            finalizedAtUnixMs: nowUnixMs
          }
        }
      }
    },
    finalized: true
  };
}
