import { Bool, Field, MerkleMap, UInt64 } from 'o1js';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PositionLeaf } from './contract.js';
import { MarketLeaf } from './market-types.js';

export type StoredMarketLeaf = {
  configHash: string;
  closeSlot: string;
  expirySlot: string;
  thresholdValueTenthC: string;
  totalPositionBet: string;
  totalYesPositionBet: string;
  resolved: string;
  outcome: string;
  oracleStatementHash: string;
};

export type OperatorStateFile = {
  zkappPublicKey?: string;
  markets: Record<string, StoredMarketLeaf>;
  positions: Record<string, StoredPositionLeaf>;
  receipts?: Record<string, string>;
  claimedReceipts?: Record<string, string>;
  usedNonces: Record<string, string>;
  marketMeta?: Record<string, StoredMarketMeta>;
  positionMeta?: Record<string, StoredPositionMeta>;
  receiptMeta?: Record<string, StoredReceiptMeta>;
};

export const DEFAULT_STATE_FILE = './data/operator-state.json';

export type StoredMarketMeta = {
  title: string;
  rulesPrimary: string;
  settlementSource: string;
  createdAtUnixMs: number;
  closeSlot: string;
  expirySlot: string;
  determinationSlot: string;
};

export type StoredPositionLeaf = {
  marketKey: string;
  sideOver: string;
  stake: string;
  ownerCommitment: string;
  claimed: string;
};

export type StoredPositionMeta = {
  zkappPublicKey?: string | null;
  marketKey: string;
  marketDate: string | null;
  walletPublicKey: string;
  ownerCommitment?: string | null;
  createdAtUnixMs: number;
  fundingTxHash: string | null;
  claimStatus?: 'submitted' | 'confirmed' | null;
  claimTxHash?: string | null;
  claimSubmittedAtUnixMs?: number | null;
  claimConfirmedAtUnixMs?: number | null;
};

export type StoredReceiptMeta = {
  zkappPublicKey?: string | null;
  marketKey: string;
  marketDate: string | null;
  walletPublicKey: string;
  ownerCommitment: string;
  createdAtUnixMs: number;
  fundingTxHash: string | null;
  fundingStatus?: 'submitted' | 'confirmed' | null;
  fundingSubmittedAtUnixMs?: number | null;
  fundingConfirmedAtUnixMs?: number | null;
  receiptCommitment: string;
  receiptSalt: string;
  side: 'over' | 'under';
  stakeTmina: number;
  claimStatus?: 'claimable' | 'submitted' | 'confirmed' | 'not-applicable' | null;
  claimTxHash?: string | null;
  claimSubmittedAtUnixMs?: number | null;
  claimConfirmedAtUnixMs?: number | null;
};

function parseBoolField(value: string): Bool {
  if (value === '1') return Bool(true);
  return Bool(false);
}

export function serializeMarketLeaf(leaf: MarketLeaf): StoredMarketLeaf {
  return {
    configHash: leaf.configHash.toString(),
    closeSlot: leaf.closeSlot.toString(),
    expirySlot: leaf.expirySlot.toString(),
    thresholdValueTenthC: leaf.thresholdValueTenthC.toString(),
    totalPositionBet: leaf.totalPositionBet.toString(),
    totalYesPositionBet: leaf.totalYesPositionBet.toString(),
    resolved: leaf.resolved.toField().toString(),
    outcome: leaf.outcome.toField().toString(),
    oracleStatementHash: leaf.oracleStatementHash.toString()
  };
}

export function deserializeMarketLeaf(stored: StoredMarketLeaf): MarketLeaf {
  return new MarketLeaf({
    configHash: Field(stored.configHash),
    closeSlot: UInt64.from(stored.closeSlot),
    expirySlot: UInt64.from(stored.expirySlot),
    thresholdValueTenthC: UInt64.from(stored.thresholdValueTenthC),
    totalPositionBet: UInt64.from(stored.totalPositionBet),
    totalYesPositionBet: UInt64.from(stored.totalYesPositionBet),
    resolved: parseBoolField(stored.resolved),
    outcome: parseBoolField(stored.outcome),
    oracleStatementHash: Field(stored.oracleStatementHash)
  });
}

export function serializePositionLeaf(leaf: PositionLeaf): StoredPositionLeaf {
  return {
    marketKey: leaf.marketKey.toString(),
    sideOver: leaf.sideOver.toField().toString(),
    stake: leaf.stake.toString(),
    ownerCommitment: leaf.ownerCommitment.toString(),
    claimed: leaf.claimed.toField().toString()
  };
}

export function deserializePositionLeaf(stored: StoredPositionLeaf): PositionLeaf {
  return new PositionLeaf({
    marketKey: Field(stored.marketKey),
    sideOver: parseBoolField(stored.sideOver),
    stake: UInt64.from(stored.stake),
    ownerCommitment: Field(stored.ownerCommitment),
    claimed: parseBoolField(stored.claimed)
  });
}

export async function loadOperatorState(statePath: string): Promise<OperatorStateFile> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as OperatorStateFile;
    return {
      markets: parsed.markets || {},
      zkappPublicKey: typeof parsed.zkappPublicKey === 'string' ? parsed.zkappPublicKey : undefined,
      positions: parsed.positions || {},
      receipts: parsed.receipts || {},
      claimedReceipts: parsed.claimedReceipts || {},
      usedNonces: parsed.usedNonces || {},
      marketMeta: parsed.marketMeta || {},
      positionMeta: parsed.positionMeta || {},
      receiptMeta: parsed.receiptMeta || {}
    };
  } catch {
    return { markets: {}, positions: {}, receipts: {}, claimedReceipts: {}, usedNonces: {}, marketMeta: {}, positionMeta: {}, receiptMeta: {} };
  }
}

export async function saveOperatorState(statePath: string, state: OperatorStateFile): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
  await rename(tempPath, statePath);
}

export async function backupOperatorState(statePath: string, suffix?: string): Promise<string | null> {
  try {
    await readFile(statePath, 'utf8');
  } catch {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = suffix ? `.${suffix.replace(/[^a-zA-Z0-9_-]+/g, '-')}` : '';
  const backupPath = path.join(path.dirname(statePath), `operator-state.backup.${stamp}${label}.json`);
  await mkdir(path.dirname(statePath), { recursive: true });
  await copyFile(statePath, backupPath);
  return backupPath;
}

export function buildMarketsMerkleMap(state: OperatorStateFile): MerkleMap {
  const map = new MerkleMap();
  for (const [key, stored] of Object.entries(state.markets)) {
    const leaf = deserializeMarketLeaf(stored);
    map.set(Field(key), leaf.hash());
  }
  return map;
}

export function buildPositionsMerkleMap(state: OperatorStateFile): MerkleMap {
  const map = new MerkleMap();
  for (const [key, stored] of Object.entries(state.positions || {})) {
    const leaf = deserializePositionLeaf(stored);
    map.set(Field(key), leaf.hash());
  }
  return map;
}

export function buildNonceMerkleMap(state: OperatorStateFile): MerkleMap {
  const map = new MerkleMap();
  for (const [nonce, value] of Object.entries(state.usedNonces)) {
    map.set(Field(nonce), Field(value));
  }
  return map;
}

export function buildReceiptsMerkleMap(state: OperatorStateFile): MerkleMap {
  const map = new MerkleMap();
  for (const [key, commitment] of Object.entries(state.receipts || {})) {
    map.set(Field(key), Field(commitment));
  }
  return map;
}

export function buildClaimedReceiptsMerkleMap(state: OperatorStateFile): MerkleMap {
  const map = new MerkleMap();
  for (const [key, claimed] of Object.entries(state.claimedReceipts || {})) {
    map.set(Field(key), Field(claimed));
  }
  return map;
}
