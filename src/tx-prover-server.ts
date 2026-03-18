import './env.js';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AccountUpdate,
  Bool,
  Field,
  Mina,
  Poseidon,
  PrivateKey,
  PublicKey,
  UInt32,
  UInt64,
  fetchAccount
} from 'o1js';
import { PredictionMarketPlatform, MarketLeaf, PositionLeaf } from './contract.js';
import {
  DEFAULT_STATE_FILE,
  buildMarketsMerkleMap,
  buildReceiptsMerkleMap,
  deserializeMarketLeaf,
  loadOperatorState,
  serializeMarketLeaf,
  serializePositionLeaf,
  type OperatorStateFile
} from './state-store.js';
import { assertLocalMarketsRootMatchesChain, assertLocalReceiptsRootMatchesChain } from './chain-state.js';

const PORT = Number.parseInt(process.env.TX_PROVER_PORT || '10001', 10);
const STATE_FILE = process.env.STATE_FILE || DEFAULT_STATE_FILE;
const ACTION_TOKEN = (process.env.TX_PROVER_ACTION_TOKEN || process.env.OPERATOR_ACTION_TOKEN || '').trim();

let contractCompilePromise: Promise<unknown> | null = null;

type PendingTxIntent = {
  id: string;
  type: 'market-bet';
  marketKey: string;
  marketDate: string | null;
  walletPublicKey: string;
  positionKey: string;
  addTotalBet: number;
  addYesBet: number;
  userId: string;
  newLeaf: ReturnType<typeof serializeMarketLeaf> | null;
  newPositionLeaf: ReturnType<typeof serializePositionLeaf>;
  receiptCommitment?: string | null;
  receiptSalt?: string | null;
  userNetPositionAfter: number;
  createdAtUnixMs: number;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fieldFromHexDigest(hex: string, chars = 30): Field {
  return Field(BigInt(`0x${hex.slice(0, chars)}`));
}

function ownerCommitmentFromWalletPublicKey(walletPublicKey: string): Field {
  return Poseidon.hash(PublicKey.fromBase58(walletPublicKey).toFields());
}

function receiptCommitmentFromBet(params: {
  marketKey: string;
  addTotalBet: number;
  addYesBet: number;
  ownerCommitment: Field;
  salt: string;
}): Field {
  return Poseidon.hash([
    Field(params.marketKey),
    Field(params.addTotalBet),
    Field(params.addYesBet),
    params.ownerCommitment,
    fieldFromHexDigest(sha256Hex(`receipt-salt:${params.salt}`))
  ]);
}

function getNetworkConfig() {
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const requestedNetworkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const isZekoTestnet = /testnet\.zeko\.io/i.test(graphql);
  const networkId = isZekoTestnet && requestedNetworkId === 'zeko' ? 'testnet' : requestedNetworkId;
  const txFee = process.env.TX_FEE || '1200000000';
  return { graphql, networkId, txFee };
}

async function ensureContractCompiled(): Promise<void> {
  if (!contractCompilePromise) {
    contractCompilePromise = PredictionMarketPlatform.compile();
  }
  await contractCompilePromise;
}

function setActiveZekoNetwork() {
  const { graphql, networkId } = getNetworkConfig();
  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);
}

function getZkappPublicKey(): PublicKey {
  const explicit = process.env.ZKAPP_PUBLIC_KEY;
  if (explicit && explicit.length > 0) return PublicKey.fromBase58(explicit);
  const zkappPriv = process.env.ZKAPP_PRIVATE_KEY;
  if (!zkappPriv) {
    throw new Error('Missing env ZKAPP_PUBLIC_KEY (or ZKAPP_PRIVATE_KEY as fallback)');
  }
  return PrivateKey.fromBase58(zkappPriv).toPublicKey();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

function requireNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

function writeJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

function requireAuth(req: IncomingMessage): void {
  if (!ACTION_TOKEN) {
    throw new Error('tx prover auth disabled: set TX_PROVER_ACTION_TOKEN');
  }
  const headerToken = req.headers['x-prover-token'];
  const supplied = typeof headerToken === 'string' ? headerToken : Array.isArray(headerToken) ? headerToken[0] : null;
  if (!supplied || supplied !== ACTION_TOKEN) {
    throw new Error('tx prover authorization failed');
  }
}

function currentLocalDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';
  return `${year}-${month}-${day}`;
}

function isoDateOffset(baseDateIso: string, dayOffset: number): string {
  const dt = new Date(`${baseDateIso}T00:00:00.000-08:00`);
  const next = new Date(dt.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function buildWalletFeePayerMarketBetTx(params: {
  stateFile: string;
  marketKey: string;
  addTotalBet: number;
  addYesBet: number;
  marketDate: string | null;
  feePayerPublicKey: string;
  userId: string;
  selectedThresholdF?: number | null;
}): Promise<{
  tx: unknown;
  fee: string;
  intent: PendingTxIntent;
  marketSummary: { totalPositionBet: string; totalYesPositionBet: string };
}> {
  const { stateFile, marketKey, addTotalBet, addYesBet, marketDate, feePayerPublicKey, userId } = params;
  if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');

  setActiveZekoNetwork();
  await ensureContractCompiled();
  const feePayer = PublicKey.fromBase58(feePayerPublicKey);
  const { txFee } = getNetworkConfig();
  const zkappAddress = getZkappPublicKey();
  const account = await fetchAccount({ publicKey: feePayer });
  if (account.error) throw new Error(`fee payer account not found: ${account.error.statusText || 'unknown'}`);

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  await assertLocalReceiptsRootMatchesChain(zkappAddress, state);
  const existing = state.markets[marketKey];
  if (!existing) throw new Error(`market ${marketKey} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('cannot trade a resolved market');
  if (!(addYesBet === 0 || addYesBet === addTotalBet)) {
    throw new Error('binary over/under stake requires addYesBet to be 0 or equal addTotalBet');
  }

  const newLeaf = new MarketLeaf({
    configHash: oldLeaf.configHash,
    closeSlot: oldLeaf.closeSlot,
    expirySlot: oldLeaf.expirySlot,
    thresholdValueTenthC: oldLeaf.thresholdValueTenthC,
    totalPositionBet: oldLeaf.totalPositionBet.add(UInt64.from(addTotalBet)),
    totalYesPositionBet: oldLeaf.totalYesPositionBet.add(UInt64.from(addYesBet)),
    resolved: Bool(false),
    outcome: Bool(false),
    oracleStatementHash: Field(0)
  });
  newLeaf.totalYesPositionBet.lessThanOrEqual(newLeaf.totalPositionBet).assertTrue();

  const marketFieldKey = Field(marketKey);
  const marketsMap = buildMarketsMerkleMap(state);
  const receiptsMap = buildReceiptsMerkleMap(state);
  const intentId = randomUUID();
  const receiptSalt = randomUUID();
  const positionKey = fieldFromHexDigest(
    sha256Hex(`${feePayerPublicKey}:${marketKey}:${marketDate || ''}:${intentId}:${Date.now()}`)
  );
  if ((state.receipts || {})[positionKey.toString()]) {
    throw new Error('receipt key collision; retry transaction build');
  }
  const ownerCommitment = ownerCommitmentFromWalletPublicKey(feePayerPublicKey);
  const receiptCommitment = receiptCommitmentFromBet({
    marketKey,
    addTotalBet,
    addYesBet,
    ownerCommitment,
    salt: receiptSalt
  });
  const positionLeaf = new PositionLeaf({
    marketKey: marketFieldKey,
    sideOver: Bool(addYesBet === addTotalBet),
    stake: UInt64.from(addTotalBet),
    ownerCommitment,
    claimed: Bool(false)
  });

  const zkapp = new PredictionMarketPlatform(zkappAddress);
  const betAmountNanomina = BigInt(addTotalBet) * 1_000_000_000n;
  const tx = await Mina.transaction({ sender: feePayer, fee: txFee }, async () => {
    const bettorPayment = AccountUpdate.createSigned(feePayer);
    bettorPayment.send({
      to: zkappAddress,
      amount: UInt64.from(betAmountNanomina)
    });
    zkapp.placeReceiptBet(
      marketFieldKey,
      oldLeaf,
      newLeaf,
      marketsMap.getWitness(marketFieldKey),
      positionKey,
      receiptCommitment,
      receiptsMap.getWitness(positionKey),
      ownerCommitment
    );
  });
  const feePayerUpdate = (tx as unknown as { feePayer?: { body?: { preconditions?: { account?: { nonce?: unknown } }; useFullCommitment?: unknown } } }).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }
  await tx.prove();

  const intent: PendingTxIntent = {
    id: intentId,
    type: 'market-bet',
    marketKey,
    marketDate,
    walletPublicKey: feePayerPublicKey,
    positionKey: positionKey.toString(),
    addTotalBet,
    addYesBet,
    userId,
    newLeaf: serializeMarketLeaf(newLeaf),
    newPositionLeaf: serializePositionLeaf(positionLeaf),
    receiptCommitment: receiptCommitment.toString(),
    receiptSalt,
    userNetPositionAfter: 0,
    createdAtUnixMs: Date.now()
  };

  return {
    tx: tx.toJSON(),
    fee: txFee,
    intent,
    marketSummary: {
      totalPositionBet: newLeaf.totalPositionBet.toString(),
      totalYesPositionBet: newLeaf.totalYesPositionBet.toString()
    }
  };
}

async function main(): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { ok: true, service: 'tx-prover' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/prover/market-bet') {
        requireAuth(req);
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const addTotalBet = requireNumber(body.addTotalBet, 'addTotalBet');
        const addYesBet = requireNonNegativeNumber(body.addYesBet, 'addYesBet');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        const marketDate = requireString(body.marketDate, 'marketDate');
        const todayIso = currentLocalDate();
        if (marketDate < todayIso) {
          throw new Error(`market date ${marketDate} is closed (past date). Today is ${todayIso}`);
        }
        const maxDate = isoDateOffset(todayIso, 5);
        if (marketDate > maxDate) {
          throw new Error(`market date ${marketDate} is outside rolling window (${todayIso} to ${maxDate})`);
        }
        const built = await buildWalletFeePayerMarketBetTx({
          stateFile: STATE_FILE,
          marketKey,
          addTotalBet: Math.floor(addTotalBet),
          addYesBet: Math.floor(addYesBet),
          marketDate,
          feePayerPublicKey: walletPublicKey,
          userId: walletPublicKey
        });
        writeJson(res, 200, {
          ok: true,
          mode: 'wallet-fee-payer',
          intentId: built.intent.id,
          fee: built.fee,
          tx: built.tx,
          intent: built.intent,
          marketSummary: built.marketSummary
        });
        return;
      }
      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[tx-prover] listening on http://0.0.0.0:${PORT}`);
    const net = getNetworkConfig();
    console.log(`[tx-prover] graphql=${net.graphql} networkId=${net.networkId} txFee=${net.txFee}`);
  });
}

main().catch((error: unknown) => {
  console.error('[tx-prover] failed:', error);
  process.exit(1);
});
