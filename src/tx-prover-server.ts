import './env.js';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.TX_PROVER_PORT || process.env.PORT || '10001', 10);
const HOST = process.env.TX_PROVER_HOST || '0.0.0.0';
const ACTION_TOKEN = (process.env.TX_PROVER_ACTION_TOKEN || '').trim();
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
  | { id: string; ok: false; error: string }
  | { id: '__ready__'; ok: true };

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady = false;
let workerBusy = false;
let pendingRequestId: string | null = null;
let pendingRequest: PendingRequest | null = null;
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

function rejectPending(message: string): void {
  if (!pendingRequest) return;
  pendingRequest.reject(new Error(message));
  pendingRequest = null;
  pendingRequestId = null;
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
  if (message.id === '__ready__') return;
  if (!pendingRequest || message.id !== pendingRequestId) return;
  const request = pendingRequest;
  pendingRequest = null;
  pendingRequestId = null;
  workerBusy = false;
  if (message.ok && 'tx' in message) {
    request.resolve(message.tx);
    return;
  }
  if (!message.ok) {
    request.reject(new Error(message.error));
    return;
  }
  request.reject(new Error('tx prover worker returned unexpected ready message'));
}

function startWorker(): void {
  if (worker) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const workerPath = resolve(here, 'tx-prover-job.js');
  workerReady = false;
  workerBusy = false;
  pendingRequest = null;
  pendingRequestId = null;
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
    worker = null;
    workerReady = false;
    rejectPending(`tx prover worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    setTimeout(() => startWorker(), 1000);
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
  const id = randomUUID();
  workerBusy = true;
  pendingRequestId = id;
  return await new Promise((resolve, reject) => {
    pendingRequest = { resolve, reject };
    worker!.stdin.write(`${JSON.stringify({ id, kind, context })}\n`);
  });
}

async function main(): Promise<void> {
  startWorker();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, {
          ok: true,
          service: 'tx-prover',
          warmed: workerReady,
          busy: workerBusy,
          workerAlive: Boolean(worker)
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
  });
}

main().catch((error) => {
  console.error('[tx-prover] fatal:', error);
  process.exit(1);
});
