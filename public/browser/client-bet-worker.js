import {
  AccountUpdate,
  Bool,
  Field,
  MerkleMapWitness,
  Mina,
  PublicKey,
  UInt32,
  UInt64,
  fetchAccount
} from '/vendor/o1js/index.js';
import { FastPredictionMarketPlatform } from '/dist/fast-contract.js';
import { MarketLeaf } from '/dist/market-types.js';

let compilePromise = null;
let activeNetworkKey = '';

function setActiveNetwork(network) {
  const nextKey = `${network.networkId}:${network.graphql}`;
  if (activeNetworkKey === nextKey) return;
  const instance = Mina.Network({
    networkId: network.networkId,
    mina: network.graphql,
    archive: network.graphql
  });
  Mina.setActiveInstance(instance);
  activeNetworkKey = nextKey;
}

function deserializeMarketLeaf(stored) {
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

function deserializeMerkleWitness(serialized) {
  return new MerkleMapWitness(
    serialized.isLefts.map((value) => Bool(Boolean(value))),
    serialized.siblings.map((value) => Field(value))
  );
}

async function warmup(network) {
  setActiveNetwork(network);
  if (!compilePromise) {
    compilePromise = FastPredictionMarketPlatform.compile();
  }
  return await compilePromise;
}

async function buildReceiptBetTx(context) {
  setActiveNetwork(context.network);
  await warmup(context.network);

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

  const feePayerUpdate = tx.feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }

  await tx.prove();
  return tx.toJSON();
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'warmup') {
      await warmup(payload.network);
      self.postMessage({ id, ok: true, result: { warmed: true } });
      return;
    }
    if (type === 'buildReceiptBetTx') {
      const tx = await buildReceiptBetTx(payload.context);
      self.postMessage({ id, ok: true, result: tx });
      return;
    }
    throw new Error(`unknown worker message type: ${type}`);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
