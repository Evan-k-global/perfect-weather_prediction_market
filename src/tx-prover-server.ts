import './env.js';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PORT = Number.parseInt(process.env.TX_PROVER_PORT || process.env.PORT || '10001', 10);
const HOST = process.env.TX_PROVER_HOST || '0.0.0.0';
const ACTION_TOKEN = (process.env.TX_PROVER_ACTION_TOKEN || '').trim();
const MAX_OLD_SPACE_MB = process.env.TX_PROVER_NODE_MAX_OLD_SPACE_MB || '4096';
const PROVER_JOB_TIMEOUT_MS = Number.parseInt(process.env.TX_PROVER_JOB_TIMEOUT_MS || '180000', 10);
const PROVER_MAX_JOBS_PER_WORKER = Number.parseInt(process.env.TX_PROVER_MAX_JOBS_PER_WORKER || '0', 10);
const PROVER_WORKER_POOL_SIZE = Number.parseInt(process.env.TX_PROVER_WORKER_POOL_SIZE || '1', 10);

type BrowserMarketBetContext = {
  network: { graphql: string; networkId: string };
  zkappPublicKey: string;
  walletPublicKey: string;
  marketKey: string;
  marketDate: string | null;
  addTotalBet: number;
  addYesBet: number;
  receiptKey: string;
  receiptCommitment: string;
  ownerCommitment: string;
  fee: string;
  oldLeaf: unknown;
  newLeaf: unknown;
  marketWitness: unknown;
  receiptWitness: unknown;
};

type ClaimPayoutContext = {
  network: { graphql: string; networkId: string };
  zkappPublicKey: string;
  walletPublicKey: string;
  fee: string;
  payoutTmina: string;
  marketKey: string;
  positionKey: string;
  receiptCommitment: string;
  ownerCommitment: string;
  addTotalBet: number;
  addYesBet: number;
  saltHash: string;
  resolvedLeaf: unknown;
  marketWitness: unknown;
  receiptWitness: unknown;
  claimedReceiptWitness: unknown;
};

type WorkerResponse =
  | { id: string; ok: true; tx?: unknown }
  | { id: string; ok: false; error: string };

type ActiveRequest = {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WorkerSlot = {
  index: number;
  process: ChildProcessWithoutNullStreams | null;
  ready: boolean;
  busy: boolean;
  completedJobs: number;
  stdoutBuffer: string;
  respawnTimer: NodeJS.Timeout | null;
  activeJobTimeout: NodeJS.Timeout | null;
  activeRequest: ActiveRequest | null;
};

const workerSlots: WorkerSlot[] = Array.from({ length: Math.max(1, PROVER_WORKER_POOL_SIZE) }, (_, index) => ({
  index,
  process: null,
  ready: false,
  busy: false,
  completedJobs: 0,
  stdoutBuffer: '',
  respawnTimer: null,
  activeJobTimeout: null,
  activeRequest: null
}));

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

function requireAuth(req: IncomingMessage): void {
  if (!ACTION_TOKEN) throw new Error('tx prover auth disabled: set TX_PROVER_ACTION_TOKEN');
  const headerToken = req.headers['x-prover-token'];
  const supplied = typeof headerToken === 'string' ? headerToken : Array.isArray(headerToken) ? headerToken[0] : null;
  if (!supplied || supplied !== ACTION_TOKEN) throw new Error('tx prover authorization failed');
}

function clearActiveJobTimeout(slot: WorkerSlot): void {
  if (slot.activeJobTimeout) {
    clearTimeout(slot.activeJobTimeout);
    slot.activeJobTimeout = null;
  }
}

function rejectActiveRequest(slot: WorkerSlot, message: string): void {
  clearActiveJobTimeout(slot);
  if (slot.activeRequest) {
    slot.activeRequest.reject(new Error(message));
    slot.activeRequest = null;
  }
  slot.busy = false;
}

function recycleWorker(slot: WorkerSlot, reason: string): void {
  if (!slot.process) return;
  console.warn(`[tx-prover] recycling worker ${slot.index}: ${reason}`);
  slot.ready = false;
  try {
    slot.process.kill('SIGKILL');
  } catch {}
}

function handleWorkerLine(slot: WorkerSlot, line: string): void {
  let message: WorkerResponse;
  try {
    message = JSON.parse(line) as WorkerResponse;
  } catch {
    return;
  }
  if (message.id === '__ready__' && message.ok) {
    slot.ready = true;
    return;
  }
  const active = slot.activeRequest;
  if (!active || active.id !== message.id) return;
  slot.activeRequest = null;
  clearActiveJobTimeout(slot);
  slot.busy = false;
  slot.completedJobs += 1;
  if (message.ok) {
    active.resolve(message.tx);
  } else {
    active.reject(new Error(message.error));
  }
  if (PROVER_MAX_JOBS_PER_WORKER > 0 && slot.completedJobs >= PROVER_MAX_JOBS_PER_WORKER) {
    slot.completedJobs = 0;
    recycleWorker(slot, 'max jobs reached');
  }
}

function startWorker(slot: WorkerSlot): void {
  if (slot.process) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const workerPath = resolve(here, 'tx-prover-job.js');
  slot.ready = false;
  slot.busy = false;
  slot.completedJobs = 0;
  slot.stdoutBuffer = '';
  clearActiveJobTimeout(slot);
  slot.activeRequest = null;
  slot.process = spawn(process.execPath, [`--max-old-space-size=${MAX_OLD_SPACE_MB}`, workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });
  slot.process.stdout.setEncoding('utf8');
  slot.process.stdout.on('data', (chunk: string) => {
    slot.stdoutBuffer += chunk;
    let idx = slot.stdoutBuffer.indexOf('\n');
    while (idx >= 0) {
      const line = slot.stdoutBuffer.slice(0, idx).trim();
      slot.stdoutBuffer = slot.stdoutBuffer.slice(idx + 1);
      if (line) handleWorkerLine(slot, line);
      idx = slot.stdoutBuffer.indexOf('\n');
    }
  });
  slot.process.stderr.setEncoding('utf8');
  slot.process.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[worker ${slot.index}] ${chunk}`);
  });
  slot.process.on('exit', (code, signal) => {
    const detail = `tx prover worker ${slot.index} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    slot.process = null;
    slot.ready = false;
    rejectActiveRequest(slot, detail);
    if (!slot.respawnTimer) {
      slot.respawnTimer = setTimeout(() => {
        slot.respawnTimer = null;
        startWorker(slot);
      }, 1000);
    }
  });
}

function selectWorker(): { slot: WorkerSlot | null; status: 'ready' | 'warming' | 'busy' } {
  const readyIdle = workerSlots.find((slot) => slot.process && slot.ready && !slot.busy) || null;
  if (readyIdle) return { slot: readyIdle, status: 'ready' };
  const unstarted = workerSlots.find((slot) => !slot.process) || null;
  if (unstarted) {
    startWorker(unstarted);
    return { slot: null, status: 'warming' };
  }
  const warming = workerSlots.some((slot) => !slot.ready);
  return { slot: null, status: warming ? 'warming' : 'busy' };
}

async function proveWithWorker(kind: 'market-bet' | 'claim-payout', context: unknown): Promise<unknown> {
  const selection = selectWorker();
  if (!selection.slot) {
    const error = new Error(selection.status === 'warming' ? 'tx prover warming up; retry shortly' : 'tx prover busy; retry shortly');
    (error as any).statusCode = 503;
    throw error;
  }
  const slot = selection.slot;
  slot.busy = true;
  const id = randomUUID();
  slot.activeJobTimeout = setTimeout(() => {
    if (!slot.activeRequest || slot.activeRequest.id !== id) return;
    recycleWorker(slot, `job timeout after ${PROVER_JOB_TIMEOUT_MS}ms`);
  }, PROVER_JOB_TIMEOUT_MS);
  return await new Promise((resolve, reject) => {
    slot.activeRequest = { id, resolve, reject };
    slot.process!.stdin.write(`${JSON.stringify({ id, kind, context })}\n`);
  });
}

function ensureWorkersStarted(): void {
  for (const slot of workerSlots) startWorker(slot);
}

async function main(): Promise<void> {
  ensureWorkersStarted();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        const aliveWorkers = workerSlots.filter((slot) => Boolean(slot.process)).length;
        const warmedWorkers = workerSlots.filter((slot) => slot.ready).length;
        const busyWorkers = workerSlots.filter((slot) => slot.busy).length;
        const completedJobs = workerSlots.reduce((sum, slot) => sum + slot.completedJobs, 0);
        writeJson(res, 200, {
          ok: true,
          service: 'tx-prover',
          workerPoolSize: workerSlots.length,
          workerAlive: aliveWorkers,
          warmedWorkers,
          busyWorkers,
          completedJobs,
          warmed: warmedWorkers > 0,
          busy: busyWorkers === workerSlots.length && workerSlots.length > 0
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prove/market-bet') {
        requireAuth(req);
        const body = await readJsonBody(req);
        const context = body.context as BrowserMarketBetContext | undefined;
        if (!context) throw new Error('context is required');
        const tx = await proveWithWorker('market-bet', context);
        writeJson(res, 200, { ok: true, tx });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prove/claim-payout') {
        requireAuth(req);
        const body = await readJsonBody(req);
        const context = body.context as ClaimPayoutContext | undefined;
        if (!context) throw new Error('context is required');
        const tx = await proveWithWorker('claim-payout', context);
        writeJson(res, 200, { ok: true, tx });
        return;
      }
      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, Number((error as any)?.statusCode || 500), {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[tx-prover] listening on http://${HOST}:${PORT}`);
    console.log(`[tx-prover] worker_pool_size=${workerSlots.length} job_timeout_ms=${PROVER_JOB_TIMEOUT_MS} max_jobs_per_worker=${PROVER_MAX_JOBS_PER_WORKER}`);
  });
}

main().catch((error) => {
  console.error('[tx-prover] fatal:', error);
  process.exit(1);
});
