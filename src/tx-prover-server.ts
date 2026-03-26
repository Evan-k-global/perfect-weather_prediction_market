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
const VERBOSE = process.env.TX_PROVER_VERBOSE === '1';
const JOB_TIMEOUT_MS = Number.parseInt(process.env.TX_PROVER_JOB_TIMEOUT_MS || '90000', 10);
const REQUIRE_PRIVATE_CALLERS =
  process.env.TX_PROVER_REQUIRE_PRIVATE_CALLERS === '0'
    ? false
    : process.env.RENDER === 'true' || process.env.IS_RENDER === 'true';

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
let activeJobTimer: NodeJS.Timeout | null = null;
let activeJobStartedAtUnixMs = 0;
let acceptedJobCount = 0;

function callerLabel(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function requestUserAgent(req: IncomingMessage): string {
  const value = req.headers['user-agent'];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] || '' : '';
}

function requestHeaderLabel(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] || '' : '';
}

function logProverRequest(req: IncomingMessage, kind: 'market-bet' | 'claim-payout', event: string): void {
  const caller = callerLabel(req);
  const origin = requestHeaderLabel(req, 'origin') || '-';
  const referer = requestHeaderLabel(req, 'referer') || '-';
  const secFetchSite = requestHeaderLabel(req, 'sec-fetch-site') || '-';
  const secFetchMode = requestHeaderLabel(req, 'sec-fetch-mode') || '-';
  const userAgent = requestUserAgent(req) || '-';
  console.log(
    `[tx-prover] ${event} kind=${kind} caller=${caller} busy=${workerBusy} origin=${origin} referer=${referer} secFetchSite=${secFetchSite} secFetchMode=${secFetchMode} ua=${JSON.stringify(userAgent)}`
  );
}

function isPrivateCaller(caller: string): boolean {
  if (!caller) return false;
  if (
    caller === '127.0.0.1' ||
    caller === '::1' ||
    caller.startsWith('::ffff:127.') ||
    caller.startsWith('10.') ||
    caller.startsWith('::ffff:10.') ||
    caller.startsWith('192.168.') ||
    caller.startsWith('::ffff:192.168.')
  ) {
    return true;
  }
  const v4 = caller.startsWith('::ffff:') ? caller.slice('::ffff:'.length) : caller;
  const match = /^172\.(\d{1,3})\./.exec(v4);
  if (match) {
    const octet = Number.parseInt(match[1], 10);
    return octet >= 16 && octet <= 31;
  }
  return false;
}

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
  if (REQUIRE_PRIVATE_CALLERS) {
    const caller = callerLabel(req);
    if (!isPrivateCaller(caller)) {
      const error = new Error(`tx prover caller rejected: ${caller}`);
      (error as any).statusCode = 403;
      throw error;
    }
  }
}

function rejectPending(message: string): void {
  if (!pendingRequest) return;
  if (activeJobTimer) {
    clearTimeout(activeJobTimer);
    activeJobTimer = null;
  }
  pendingRequest.reject(new Error(message));
  pendingRequest = null;
  pendingRequestId = null;
  workerBusy = false;
  activeJobStartedAtUnixMs = 0;
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
  if (activeJobTimer) {
    clearTimeout(activeJobTimer);
    activeJobTimer = null;
  }
  workerBusy = false;
  activeJobStartedAtUnixMs = 0;
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

function recycleWorker(reason: string): void {
  if (!worker) return;
  if (VERBOSE) {
    console.warn(`[tx-prover] recycling worker: ${reason}`);
  }
  const current = worker;
  worker = null;
  workerReady = false;
  try {
    current.kill('SIGKILL');
  } catch {}
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
  activeJobStartedAtUnixMs = Date.now();
  acceptedJobCount += 1;
  pendingRequestId = id;
  activeJobTimer = setTimeout(() => {
    recycleWorker(`job timed out after ${JOB_TIMEOUT_MS}ms requestId=${id}`);
  }, JOB_TIMEOUT_MS);
  const leanContext =
    kind === 'market-bet' && context && typeof context === 'object'
      ? (() => {
          const { marketDate: _marketDate, ...rest } = context as BrowserMarketBetContext;
          return rest;
        })()
      : kind === 'claim-payout' && context && typeof context === 'object'
      ? (() => {
          const { payoutTmina: _payoutTmina, ...rest } = context as ClaimPayoutContext;
          return rest;
        })()
      : context;
  return await new Promise((resolve, reject) => {
    pendingRequest = { resolve, reject };
    if (VERBOSE) {
      console.log(`[tx-prover] dispatch kind=${kind} requestId=${id}`);
    }
    worker!.stdin.write(`${JSON.stringify({ id, kind, context: leanContext })}\n`);
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
          workerAlive: Boolean(worker),
          acceptedJobCount,
          activeJobAgeMs: activeJobStartedAtUnixMs > 0 ? Date.now() - activeJobStartedAtUnixMs : 0
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prove/market-bet') {
        requireAuth(req);
        logProverRequest(req, 'market-bet', 'request');
        const body = await readJsonBody(req);
        const context = body.context as BrowserMarketBetContext | undefined;
        if (!context) throw new Error('context is required');
        const tx = await proveWithWorker('market-bet', context);
        writeJson(res, 200, { ok: true, tx });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prove/claim-payout') {
        requireAuth(req);
        logProverRequest(req, 'claim-payout', 'request');
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
