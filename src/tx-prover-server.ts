import './env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  AccountUpdate,
  Bool,
  Field,
  MerkleMapWitness,
  Mina,
  PrivateKey,
  PublicKey,
  UInt32,
  UInt64,
  fetchAccount
} from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { getFastNodeCompileCache } from './fast-compile-cache.js';
import {
  getOnChainClaimedReceiptsRoot,
  getOnChainMarketsRoot,
  getOnChainReceiptsRoot
} from './fast-chain-state.js';
import { MarketLeaf } from './market-types.js';
import type { StoredMarketLeaf } from './state-store.js';

const PORT = Number.parseInt(process.env.TX_PROVER_PORT || process.env.PORT || '10001', 10);
const HOST = process.env.TX_PROVER_HOST || '0.0.0.0';
const ACTION_TOKEN = (process.env.TX_PROVER_ACTION_TOKEN || process.env.ORACLE_ACTION_TOKEN || '').trim();

type SerializedMerkleWitness = {
  isLefts: boolean[];
  siblings: string[];
};

type BrowserMarketBetContext = {
  network: {
    graphql: string;
    networkId: string;
  };
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
  oldLeaf: StoredMarketLeaf;
  newLeaf: StoredMarketLeaf;
  marketWitness: SerializedMerkleWitness;
  receiptWitness: SerializedMerkleWitness;
};

type ClaimPayoutContext = {
  network: {
    graphql: string;
    networkId: string;
  };
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
  resolvedLeaf: StoredMarketLeaf;
  marketWitness: SerializedMerkleWitness;
  receiptWitness: SerializedMerkleWitness;
  claimedReceiptWitness: SerializedMerkleWitness;
};

let compilePromise: Promise<unknown> | null = null;
let activeNetworkKey = '';
let proveQueue: Promise<void> = Promise.resolve();

async function withProverSlot<T>(work: () => Promise<T>): Promise<T> {
  const previous = proveQueue;
  let release!: () => void;
  proveQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function setActiveNetwork(network: { graphql: string; networkId: string }): void {
  const nextKey = `${network.networkId}:${network.graphql}`;
  if (activeNetworkKey === nextKey) return;
  const instance = Mina.Network({
    networkId: network.networkId as never,
    mina: network.graphql,
    archive: network.graphql
  });
  Mina.setActiveInstance(instance);
  activeNetworkKey = nextKey;
}

async function ensureFastContractCompiled(): Promise<void> {
  if (!compilePromise) {
    compilePromise = FastPredictionMarketPlatform.compile({
      cache: getFastNodeCompileCache()
    }).then(() => undefined);
  }
  await compilePromise;
}

function getNetworkConfig() {
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const requestedNetworkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const isZekoTestnet = /testnet\.zeko\.io/i.test(graphql);
  const networkId = isZekoTestnet && requestedNetworkId === 'zeko' ? 'testnet' : requestedNetworkId;
  return { graphql, networkId };
}

function warmProver(): void {
  const network = getNetworkConfig();
  setActiveNetwork(network);
  void ensureFastContractCompiled()
    .then(() => {
      console.log('[tx-prover] compile warmup finished');
    })
    .catch((error) => {
      console.error('[tx-prover] compile warmup failed:', error);
      compilePromise = null;
    });
}

function deserializeMarketLeaf(stored: StoredMarketLeaf): MarketLeaf {
  return new MarketLeaf({
    configHash: Field(stored.configHash),
    closeSlot: UInt64.from(stored.closeSlot),
    expirySlot: UInt64.from(stored.expirySlot),
    thresholdValueTenthC: UInt64.from(stored.thresholdValueTenthC),
    totalPositionBet: UInt64.from(stored.totalPositionBet),
    totalYesPositionBet: UInt64.from(stored.totalYesPositionBet),
    resolved: Bool(stored.resolved === '1'),
    outcome: Bool(stored.outcome === '1'),
    oracleStatementHash: Field(stored.oracleStatementHash)
  });
}

function deserializeMerkleWitness(serialized: SerializedMerkleWitness): MerkleMapWitness {
  return new MerkleMapWitness(
    serialized.isLefts.map((value) => Bool(Boolean(value))),
    serialized.siblings.map((value) => Field(value))
  );
}

async function assertBetContextRootsFresh(
  zkappAddress: PublicKey,
  marketKey: Field,
  oldLeaf: MarketLeaf,
  marketWitness: MerkleMapWitness,
  receiptKey: Field,
  receiptWitness: MerkleMapWitness
): Promise<void> {
  const [localMarketsRoot, witnessMarketKey] = marketWitness.computeRootAndKey(oldLeaf.hash());
  witnessMarketKey.assertEquals(marketKey);
  const [localReceiptsRoot, witnessReceiptKey] = receiptWitness.computeRootAndKey(Field(0));
  witnessReceiptKey.assertEquals(receiptKey);
  const [chainMarketsRoot, chainReceiptsRoot] = await Promise.all([
    getOnChainMarketsRoot(zkappAddress),
    getOnChainReceiptsRoot(zkappAddress)
  ]);
  if (localMarketsRoot.toString() !== chainMarketsRoot) {
    throw new Error(`marketsRoot mismatch local=${localMarketsRoot.toString()} chain=${chainMarketsRoot}`);
  }
  if (localReceiptsRoot.toString() !== chainReceiptsRoot) {
    throw new Error(`receiptsRoot mismatch local=${localReceiptsRoot.toString()} chain=${chainReceiptsRoot}`);
  }
}

async function assertClaimContextRootsFresh(
  zkappAddress: PublicKey,
  marketKey: Field,
  resolvedLeaf: MarketLeaf,
  marketWitness: MerkleMapWitness,
  receiptKey: Field,
  receiptCommitment: Field,
  receiptWitness: MerkleMapWitness,
  claimedReceiptWitness: MerkleMapWitness
): Promise<void> {
  const [localMarketsRoot, witnessMarketKey] = marketWitness.computeRootAndKey(resolvedLeaf.hash());
  witnessMarketKey.assertEquals(marketKey);
  const [localReceiptsRoot, witnessReceiptKey] = receiptWitness.computeRootAndKey(receiptCommitment);
  witnessReceiptKey.assertEquals(receiptKey);
  const [localClaimedRoot, claimedWitnessKey] = claimedReceiptWitness.computeRootAndKey(Field(0));
  claimedWitnessKey.assertEquals(receiptKey);
  const [chainMarketsRoot, chainReceiptsRoot, chainClaimedRoot] = await Promise.all([
    getOnChainMarketsRoot(zkappAddress),
    getOnChainReceiptsRoot(zkappAddress),
    getOnChainClaimedReceiptsRoot(zkappAddress)
  ]);
  if (localMarketsRoot.toString() !== chainMarketsRoot) {
    throw new Error(`marketsRoot mismatch local=${localMarketsRoot.toString()} chain=${chainMarketsRoot}`);
  }
  if (localReceiptsRoot.toString() !== chainReceiptsRoot) {
    throw new Error(`receiptsRoot mismatch local=${localReceiptsRoot.toString()} chain=${chainReceiptsRoot}`);
  }
  if (localClaimedRoot.toString() !== chainClaimedRoot) {
    throw new Error(`claimedReceiptsRoot mismatch local=${localClaimedRoot.toString()} chain=${chainClaimedRoot}`);
  }
}

async function buildMarketBetTx(context: BrowserMarketBetContext): Promise<unknown> {
  setActiveNetwork(context.network);
  await ensureFastContractCompiled();

  const feePayer = PublicKey.fromBase58(context.walletPublicKey);
  const account = await fetchAccount({ publicKey: feePayer });
  if (account.error) {
    throw new Error(`fee payer account not found: ${account.error.statusText || 'unknown'}`);
  }

  const zkappAddress = PublicKey.fromBase58(context.zkappPublicKey);
  const marketKey = Field(context.marketKey);
  const receiptKey = Field(context.receiptKey);
  const receiptCommitment = Field(context.receiptCommitment);
  const ownerCommitment = Field(context.ownerCommitment);
  const oldLeaf = deserializeMarketLeaf(context.oldLeaf);
  const newLeaf = deserializeMarketLeaf(context.newLeaf);
  const marketWitness = deserializeMerkleWitness(context.marketWitness);
  const receiptWitness = deserializeMerkleWitness(context.receiptWitness);
  const betAmountNanomina = BigInt(context.addTotalBet) * 1_000_000_000n;
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);

  await assertBetContextRootsFresh(zkappAddress, marketKey, oldLeaf, marketWitness, receiptKey, receiptWitness);

  const tx = await Mina.transaction({ sender: feePayer, fee: context.fee }, async () => {
    const bettorPayment = AccountUpdate.createSigned(feePayer);
    bettorPayment.send({
      to: zkappAddress,
      amount: UInt64.from(betAmountNanomina)
    });
    zkapp.placeReceiptBet(
      marketKey,
      oldLeaf,
      newLeaf,
      marketWitness,
      receiptKey,
      receiptCommitment,
      receiptWitness,
      ownerCommitment
    );
  });

  const feePayerUpdate = (tx as any).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }

  await tx.prove();
  return tx.toJSON();
}

async function buildClaimPayoutTx(context: ClaimPayoutContext): Promise<unknown> {
  setActiveNetwork(context.network);
  await ensureFastContractCompiled();
  const feePayer = PublicKey.fromBase58(context.walletPublicKey);
  const feePayerAccount = await fetchAccount({ publicKey: feePayer });
  if (feePayerAccount.error) {
    throw new Error(`fee payer account not found: ${feePayerAccount.error.statusText || 'unknown'}`);
  }
  const zkappAddress = PublicKey.fromBase58(context.zkappPublicKey);
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);
  const marketKey = Field(context.marketKey);
  const receiptKey = Field(context.positionKey);
  const receiptCommitment = Field(context.receiptCommitment);
  const resolvedLeaf = deserializeMarketLeaf(context.resolvedLeaf);
  const marketWitness = deserializeMerkleWitness(context.marketWitness);
  const receiptWitness = deserializeMerkleWitness(context.receiptWitness);
  const claimedReceiptWitness = deserializeMerkleWitness(context.claimedReceiptWitness);

  await assertClaimContextRootsFresh(
    zkappAddress,
    marketKey,
    resolvedLeaf,
    marketWitness,
    receiptKey,
    receiptCommitment,
    receiptWitness,
    claimedReceiptWitness
  );

  const tx = await Mina.transaction({ sender: feePayer, fee: context.fee }, async () => {
    zkapp.claimReceiptPayout(
      marketKey,
      resolvedLeaf,
      marketWitness,
      receiptKey,
      receiptCommitment,
      receiptWitness,
      claimedReceiptWitness,
      feePayer,
      UInt64.from(context.addTotalBet),
      UInt64.from(context.addYesBet),
      Field(context.ownerCommitment),
      Field(context.saltHash)
    );
  });
  const feePayerUpdate = (tx as any).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }
  await tx.prove();
  return tx.toJSON();
}

async function main(): Promise<void> {
  warmProver();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { ok: true, service: 'tx-prover', warmed: compilePromise !== null });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/prove/market-bet') {
        requireAuth(req);
        const body = await readJsonBody(req);
        const context = body.context as BrowserMarketBetContext | undefined;
        if (!context) throw new Error('context is required');
        const tx = await withProverSlot(() => buildMarketBetTx(context));
        writeJson(res, 200, { ok: true, tx });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/prove/claim-payout') {
        requireAuth(req);
        const body = await readJsonBody(req);
        const context = body.context as ClaimPayoutContext | undefined;
        if (!context) throw new Error('context is required');
        const tx = await withProverSlot(() => buildClaimPayoutTx(context));
        writeJson(res, 200, { ok: true, tx });
        return;
      }

      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, 500, {
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
