import './env.js';
import readline from 'node:readline';
import {
  AccountUpdate,
  Bool,
  Field,
  MerkleMapWitness,
  Mina,
  PublicKey,
  UInt32,
  UInt64
} from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { getFastNodeCompileCache } from './fast-compile-cache.js';
import { MarketLeaf } from './market-types.js';
import type { StoredMarketLeaf } from './state-store.js';

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

type JobRequest =
  | { id: string; kind: 'market-bet'; context: BrowserMarketBetContext }
  | { id: string; kind: 'claim-payout'; context: ClaimPayoutContext };

type JobResponse =
  | { id: string; ok: true; tx: unknown }
  | { id: string; ok: false; error: string }
  | { id: '__ready__'; ok: true };

let compilePromise: Promise<unknown> | null = null;
let activeNetworkKey = '';
const VERBOSE = process.env.TX_PROVER_VERBOSE === '1';

function send(response: JobResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function debug(message: string): void {
  if (VERBOSE) {
    log(message);
  }
}

function setActiveNetwork(network: { graphql: string; networkId: string }): void {
  const nextKey = `${network.networkId}:${network.graphql}`;
  if (activeNetworkKey === nextKey) return;
  const archiveGraphql = process.env.ZEKO_ARCHIVE_GRAPHQL || network.graphql;
  const instance = Mina.Network({
    networkId: network.networkId as never,
    mina: network.graphql,
    archive: archiveGraphql
  });
  Mina.setActiveInstance(instance);
  activeNetworkKey = nextKey;
}

async function ensureFastContractCompiled(network: { graphql: string; networkId: string }): Promise<void> {
  setActiveNetwork(network);
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

async function buildMarketBetTx(context: BrowserMarketBetContext): Promise<unknown> {
  await ensureFastContractCompiled(context.network);
  const feePayer = PublicKey.fromBase58(context.walletPublicKey);
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

  const tx = await Mina.transaction({ sender: feePayer, fee: context.fee }, async () => {
    const bettorPayment = AccountUpdate.createSigned(feePayer);
    bettorPayment.send({ to: zkappAddress, amount: UInt64.from(betAmountNanomina) });
    await zkapp.placeReceiptBet(
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
  await ensureFastContractCompiled(context.network);
  const feePayer = PublicKey.fromBase58(context.walletPublicKey);
  const zkappAddress = PublicKey.fromBase58(context.zkappPublicKey);
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);
  const tx = await Mina.transaction({ sender: feePayer, fee: context.fee }, async () => {
    await zkapp.claimReceiptPayout(
      Field(context.marketKey),
      deserializeMarketLeaf(context.resolvedLeaf),
      deserializeMerkleWitness(context.marketWitness),
      Field(context.positionKey),
      Field(context.receiptCommitment),
      deserializeMerkleWitness(context.receiptWitness),
      deserializeMerkleWitness(context.claimedReceiptWitness),
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
  try {
    await ensureFastContractCompiled(getNetworkConfig());
    log('[tx-prover-job] compile warmup finished');
    send({ id: '__ready__', ok: true });
  } catch (error) {
    log(`[tx-prover-job] compile warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JobRequest | null = null;
    const startedAt = Date.now();
    try {
      request = JSON.parse(trimmed) as JobRequest;
      debug(
        `[tx-prover-job] start kind=${request.kind} requestId=${request.id} wallet=${request.context.walletPublicKey} marketKey=${request.context.marketKey}`
      );
      if (request.kind === 'market-bet') {
        const tx = await buildMarketBetTx(request.context);
        debug(`[tx-prover-job] done kind=market-bet requestId=${request.id} durationMs=${Date.now() - startedAt}`);
        send({ id: request.id, ok: true, tx });
      } else if (request.kind === 'claim-payout') {
        const tx = await buildClaimPayoutTx(request.context);
        debug(`[tx-prover-job] done kind=claim-payout requestId=${request.id} durationMs=${Date.now() - startedAt}`);
        send({ id: request.id, ok: true, tx });
      }
    } catch (error) {
      log(
        `[tx-prover-job] fail kind=${request?.kind || 'unknown'} requestId=${request?.id || 'unknown'} durationMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`
      );
      send({ id: request?.id || 'unknown', ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

main().catch((error) => {
  log(`[tx-prover-job] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
