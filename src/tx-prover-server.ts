import './env.js';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PORT = Number.parseInt(process.env.TX_PROVER_PORT || process.env.PORT || '10001', 10);
const HOST = process.env.TX_PROVER_HOST || '0.0.0.0';
const ACTION_TOKEN = (process.env.TX_PROVER_ACTION_TOKEN || process.env.ORACLE_ACTION_TOKEN || '').trim();
const MAX_OLD_SPACE_MB = process.env.TX_PROVER_NODE_MAX_OLD_SPACE_MB || '4096';

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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WorkerResponse =
  | { id: string; ok: true; tx?: unknown }
  | { id: string; ok: false; error: string };

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady = false;
let workerBusy = false;
let respawnTimer: NodeJS.Timeout | null = null;
const pending = new Map<string, PendingRequest>();
let stdoutBuffer = '';

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

function rejectAllPending(message: string): void {
  for (const [id, request] of pending.entries()) {
    request.reject(new Error(message));
    pending.delete(id);
  }
  workerBusy = false;
}

function handleWorkerLine(line: string): void {
  let message: WorkerResponse;
  try {
    message = JSON.parse(line) as WorkerResponse;
  } catch {
    return;
  }
  if (message.id === '__ready__' && message.ok) {
    workerReady = true;
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  workerBusy = false;
  if (message.ok) {
    request.resolve(message.tx);
  } else {
    request.reject(new Error(message.error));
  }
}

function startWorker(): void {
  if (worker) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const workerPath = resolve(here, 'tx-prover-job.js');
  workerReady = false;
  workerBusy = false;
  stdoutBuffer = '';
  worker = spawn(process.execPath, [`--max-old-space-size=${MAX_OLD_SPACE_MB}`, workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let idx = stdoutBuffer.indexOf('\n');
    while (idx >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line) handleWorkerLine(line);
      idx = stdoutBuffer.indexOf('\n');
    }
  });
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk: string) => {
    process.stderr.write(chunk);
  });
  worker.on('exit', (code, signal) => {
    const detail = `tx prover worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    worker = null;
    workerReady = false;
    rejectAllPending(detail);
    if (!respawnTimer) {
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        startWorker();
      }, 1000);
    }
  });
}

async function proveWithWorker(kind: 'market-bet' | 'claim-payout', context: unknown): Promise<unknown> {
  startWorker();
  if (!worker || !workerReady) {
    const error = new Error('tx prover warming up; retry shortly');
    (error as any).statusCode = 503;
    throw error;
  }
  if (workerBusy) {
    const error = new Error('tx prover busy; retry shortly');
    (error as any).statusCode = 503;
    throw error;
  }
  workerBusy = true;
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.stdin.write(`${JSON.stringify({ id, kind, context })}\n`);
  });
}

async function main(): Promise<void> {
  startWorker();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { ok: true, service: 'tx-prover', warmed: workerReady, busy: workerBusy, workerAlive: Boolean(worker) });
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
  });
}

main().catch((error) => {
  console.error('[tx-prover] fatal:', error);
  process.exit(1);
});
