import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_ACP_ESCROW_FILE = './data/acp-credit-escrow.json';

export type AcpCreditIntent = {
  id: string;
  owner: string;
  amount: number;
  nonce: string;
  createdAtUnixMs: number;
  status: 'created' | 'funded' | 'spent' | 'cancelled';
};

export type AcpRelayJob = {
  id: string;
  intentId: string;
  agentId: string;
  promptHash: string;
  outputCommitment?: string;
  outputCiphertext?: string;
  status: 'queued' | 'ran' | 'revealed' | 'settled';
  createdAtUnixMs: number;
};

export type AcpCreditEscrowState = {
  balances: Record<string, number>;
  intents: Record<string, AcpCreditIntent>;
  relayJobs: Record<string, AcpRelayJob>;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function loadAcpCreditEscrowState(
  filePath: string = DEFAULT_ACP_ESCROW_FILE
): Promise<AcpCreditEscrowState> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as AcpCreditEscrowState;
    return {
      balances: parsed.balances || {},
      intents: parsed.intents || {},
      relayJobs: parsed.relayJobs || {}
    };
  } catch {
    return { balances: {}, intents: {}, relayJobs: {} };
  }
}

export async function saveAcpCreditEscrowState(
  state: AcpCreditEscrowState,
  filePath: string = DEFAULT_ACP_ESCROW_FILE
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export function acpCreateCreditsIntent(
  state: AcpCreditEscrowState,
  input: { owner: string; amount: number; nonce: string; nowUnixMs: number }
): { state: AcpCreditEscrowState; intent: AcpCreditIntent } {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('amount must be > 0');
  }
  const intent: AcpCreditIntent = {
    id: randomUUID(),
    owner: input.owner,
    amount: Math.floor(input.amount),
    nonce: input.nonce,
    createdAtUnixMs: input.nowUnixMs,
    status: 'created'
  };
  return {
    state: {
      ...state,
      intents: { ...state.intents, [intent.id]: intent }
    },
    intent
  };
}

export function acpMarkIntentFunded(
  state: AcpCreditEscrowState,
  input: { intentId: string }
): { state: AcpCreditEscrowState; intent: AcpCreditIntent } {
  const intent = state.intents[input.intentId];
  if (!intent) throw new Error('intent not found');
  if (intent.status !== 'created') throw new Error('intent is not fundable');
  const nextIntent: AcpCreditIntent = { ...intent, status: 'funded' };
  const priorBalance = state.balances[intent.owner] || 0;
  return {
    state: {
      ...state,
      balances: { ...state.balances, [intent.owner]: priorBalance + intent.amount },
      intents: { ...state.intents, [intent.id]: nextIntent }
    },
    intent: nextIntent
  };
}

export function acpCreateRelayJobFromCredits(
  state: AcpCreditEscrowState,
  input: { owner: string; spendAmount: number; agentId: string; prompt: string; nowUnixMs: number; intentId?: string }
): { state: AcpCreditEscrowState; job: AcpRelayJob } {
  if (!Number.isFinite(input.spendAmount) || input.spendAmount <= 0) {
    throw new Error('spendAmount must be > 0');
  }
  const spend = Math.floor(input.spendAmount);
  const bal = state.balances[input.owner] || 0;
  if (bal < spend) throw new Error('insufficient credits');

  const intentId = input.intentId || randomUUID();
  const promptHash = sha256Hex(input.prompt);
  const job: AcpRelayJob = {
    id: randomUUID(),
    intentId,
    agentId: input.agentId,
    promptHash,
    status: 'queued',
    createdAtUnixMs: input.nowUnixMs
  };

  return {
    state: {
      ...state,
      balances: { ...state.balances, [input.owner]: bal - spend },
      relayJobs: { ...state.relayJobs, [job.id]: job }
    },
    job
  };
}

export function acpRelayRunJob(
  state: AcpCreditEscrowState,
  input: { jobId: string; outputPlaintext: string }
): { state: AcpCreditEscrowState; job: AcpRelayJob } {
  const job = state.relayJobs[input.jobId];
  if (!job) throw new Error('job not found');
  if (job.status !== 'queued') throw new Error('job is not runnable');
  const outputCommitment = sha256Hex(input.outputPlaintext);
  const outputCiphertext = Buffer.from(input.outputPlaintext, 'utf8').toString('base64');
  const nextJob: AcpRelayJob = {
    ...job,
    outputCommitment,
    outputCiphertext,
    status: 'ran'
  };
  return {
    state: { ...state, relayJobs: { ...state.relayJobs, [job.id]: nextJob } },
    job: nextJob
  };
}

export function acpRevealAndSettleRelayJob(
  state: AcpCreditEscrowState,
  input: { jobId: string; outputPlaintext: string }
): { state: AcpCreditEscrowState; job: AcpRelayJob } {
  const job = state.relayJobs[input.jobId];
  if (!job) throw new Error('job not found');
  if (job.status !== 'ran') throw new Error('job must be ran');
  const digest = sha256Hex(input.outputPlaintext);
  if (job.outputCommitment !== digest) throw new Error('output commitment mismatch');
  const nextJob: AcpRelayJob = { ...job, status: 'settled' };
  return {
    state: { ...state, relayJobs: { ...state.relayJobs, [job.id]: nextJob } },
    job: nextJob
  };
}
