import './env.js';

import { AccountUpdate, Bool, Field, Mina, PrivateKey, PublicKey, UInt32, UInt64, fetchAccount } from 'o1js';
import { DEFAULT_STATE_FILE, buildMarketsMerkleMap, buildPositionsMerkleMap, deserializeMarketLeaf, loadOperatorState } from './state-store.js';
import { MarketLeaf, PositionLeaf, PredictionMarketPlatform } from './contract.js';
import { assertLocalMarketsRootMatchesChain, assertLocalPositionsRootMatchesChain } from './chain-state.js';
import { withTxRetry } from './tx-retry.js';

export type PrivateQueuedBet = {
  id: string;
  marketKey: string;
  marketDate: string | null;
  walletPublicKey: string;
  positionKey: string;
  ownerCommitment: string;
  addTotalBet: number;
  addYesBet: number;
  fundingTxHash: string | null;
  walletCommitment: string;
  createdAtUnixMs: number;
  status: 'QUEUED';
};

export type PrivateBatchProofResult = {
  processed: number;
  txHash: string | null;
  marketKey: string | null;
  marketDate: string | null;
  totalPositionBetAdded: number;
  totalYesBetAdded: number;
  relayerReimbursedNanomina: string;
};

let contractCompilePromise: Promise<unknown> | null = null;

function getRelayerPrivateKey(): PrivateKey | null {
  const deployer = process.env.DEPLOYER_PRIVATE_KEY;
  const relayer = process.env.RELAYER_PRIVATE_KEY;
  const base58 = deployer || relayer;
  if (!base58) return null;
  return PrivateKey.fromBase58(base58);
}

function getOptionalZkappPrivateKey(): PrivateKey | null {
  const base58 = process.env.ZKAPP_PRIVATE_KEY;
  if (!base58) return null;
  return PrivateKey.fromBase58(base58);
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

export async function proveAndSendPrivateQueuedBet(params: {
  queuedBet: PrivateQueuedBet;
  stateFile?: string;
}): Promise<PrivateBatchProofResult> {
  const queuedBet = params.queuedBet;
  const stateFile = params.stateFile || process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const relayer = getRelayerPrivateKey();
  if (!relayer) {
    throw new Error('Missing env RELAYER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY fallback) for zk_strong batch processing');
  }

  const marketKey = queuedBet.marketKey;
  const marketDate = queuedBet.marketDate ?? null;
  const addTotalBet = queuedBet.addTotalBet;
  const addYesBet = queuedBet.addYesBet;
  if (!(addYesBet === 0 || addYesBet === addTotalBet)) {
    throw new Error('claimable payout path requires binary over/under stake; queued item must be full OVER or full UNDER');
  }

  setActiveZekoNetwork();
  await ensureContractCompiled();
  const { txFee } = getNetworkConfig();
  const zkappAddress = getZkappPublicKey();
  const zkappSigner = getOptionalZkappPrivateKey();
  const reimburseEnabled = process.env.RELAYER_REIMBURSE_DISABLED !== '1';
  const signerMatchesZkapp =
    zkappSigner !== null && zkappSigner.toPublicKey().toBase58() === zkappAddress.toBase58();
  const configuredReimburse = BigInt(process.env.RELAYER_REIMBURSE_NANOMINA || txFee);
  const maxByBatchStake = BigInt(addTotalBet) * 1_000_000_000n;
  const relayerReimbursedNanominaBase = reimburseEnabled && signerMatchesZkapp
    ? (configuredReimburse < maxByBatchStake ? configuredReimburse : maxByBatchStake)
    : 0n;
  const relayerAccount = await fetchAccount({ publicKey: relayer.toPublicKey() });
  if (relayerAccount.error) {
    throw new Error(`relayer account not found: ${relayerAccount.error.statusText || 'unknown'}`);
  }

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  await assertLocalPositionsRootMatchesChain(zkappAddress, state);
  const existing = state.markets[marketKey];
  if (!existing) throw new Error(`market ${marketKey} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('cannot process private batch on resolved market');

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
  const positionsMap = buildPositionsMerkleMap(state);
  const positionKey = Field(queuedBet.positionKey);
  if (state.positions[positionKey.toString()]) {
    throw new Error(`position ${positionKey.toString()} already exists in state file`);
  }
  const positionLeaf = new PositionLeaf({
    marketKey: marketFieldKey,
    sideOver: Bool(addYesBet === addTotalBet),
    stake: UInt64.from(addTotalBet),
    ownerCommitment: Field(queuedBet.ownerCommitment),
    claimed: Bool(false)
  });
  const zkapp = new PredictionMarketPlatform(zkappAddress);

  let txHash: string | null = null;
  const submitBatchTx = async (reimburseNanomina: bigint) => {
    await withTxRetry(
      async () => {
        const useReimburse = reimburseNanomina > 0n && signerMatchesZkapp && zkappSigner !== null;
        const signers = useReimburse ? [relayer, zkappSigner] : [relayer];
        const tx = await Mina.transaction({ sender: relayer.toPublicKey(), fee: txFee }, async () => {
          await zkapp.placeClaimableBet(
            marketFieldKey,
            oldLeaf,
            newLeaf,
            marketsMap.getWitness(marketFieldKey),
            positionKey,
            positionLeaf,
            positionsMap.getWitness(positionKey)
          );
          if (useReimburse) {
            const reimburse = AccountUpdate.createSigned(zkappSigner.toPublicKey());
            reimburse.send({
              to: relayer.toPublicKey(),
              amount: UInt64.from(reimburseNanomina)
            });
          }
        });
        const feePayerUpdate = (
          tx as unknown as {
            feePayer?: { body?: { preconditions?: { account?: { nonce?: unknown } }; useFullCommitment?: unknown } };
          }
        ).feePayer;
        if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
          feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
        }
        if (feePayerUpdate?.body) {
          feePayerUpdate.body.useFullCommitment = Bool(true);
        }
        await tx.prove();
        const sent = await tx.sign(signers).send();
        txHash = typeof sent?.hash === 'string' ? sent.hash : null;
      },
      { label: 'private-batch:zeko' }
    );
  };

  let relayerReimbursedNanomina = relayerReimbursedNanominaBase;
  try {
    await submitBatchTx(relayerReimbursedNanomina);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const shouldRetryWithoutReimburse =
      relayerReimbursedNanomina > 0n &&
      /Constraint unsatisfied|insufficient|balance/i.test(msg);
    if (!shouldRetryWithoutReimburse) throw error;
    console.warn('[private-batch] reimbursement failed, retrying without reimbursement');
    relayerReimbursedNanomina = 0n;
    await submitBatchTx(relayerReimbursedNanomina);
  }

  return {
    processed: 1,
    txHash,
    marketKey,
    marketDate,
    totalPositionBetAdded: addTotalBet,
    totalYesBetAdded: addYesBet,
    relayerReimbursedNanomina: relayerReimbursedNanomina.toString()
  };
}
