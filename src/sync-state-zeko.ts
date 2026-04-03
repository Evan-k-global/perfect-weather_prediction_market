import 'reflect-metadata';
import './env.js';
import { Bool, Field, Mina, PrivateKey, UInt64 } from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import {
  DEFAULT_STATE_FILE,
  OperatorStateFile,
  deserializeMarketLeaf,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf
} from './state-store.js';
import {
  getLocalMarketsRoot,
  getLocalReceiptsRoot,
  getOnChainMarketsRoot,
  getOnChainReceiptsRoot,
  isUninitializedFastZkappError
} from './fast-chain-state.js';
import { MarketLeaf } from './market-types.js';

type ParsedEvent = {
  type: string;
  data: Record<string, unknown>;
};

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function parseOptionalArgValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function asStringLike(value: unknown, fieldName: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return (value as { toString(): string }).toString();
  }
  throw new Error(`event field ${fieldName} missing`);
}

function asBool(value: unknown, fieldName: string): Bool {
  const normalized = asStringLike(value, fieldName);
  return Bool(normalized === '1' || normalized.toLowerCase() === 'true');
}

function asField(value: unknown, fieldName: string): Field {
  return Field(asStringLike(value, fieldName));
}

function asUInt64(value: unknown, fieldName: string): UInt64 {
  return UInt64.from(asStringLike(value, fieldName));
}

function extractParsedEvents(rawEvents: unknown[]): ParsedEvent[] {
  const parsed: ParsedEvent[] = [];
  for (const item of rawEvents as Array<Record<string, unknown>>) {
    const flatType = typeof item.type === 'string' ? item.type : null;
    const flatData = item.event && typeof item.event === 'object' ? (item.event as Record<string, unknown>).data : null;
    if (flatType && flatData && typeof flatData === 'object' && !Array.isArray(flatData)) {
      parsed.push({ type: flatType, data: flatData as Record<string, unknown> });
      continue;
    }

    const nested = item.events;
    if (Array.isArray(nested)) {
      for (const nestedEvent of nested as Array<Record<string, unknown>>) {
        const t = typeof nestedEvent.type === 'string' ? nestedEvent.type : null;
        const d =
          nestedEvent.event && typeof nestedEvent.event === 'object'
            ? (nestedEvent.event as Record<string, unknown>).data
            : nestedEvent.data;
        if (t && d && typeof d === 'object' && !Array.isArray(d)) {
          parsed.push({ type: t, data: d as Record<string, unknown> });
        }
      }
    }
  }
  return parsed;
}

function leafFromEventData(data: Record<string, unknown>): { marketKey: string; leaf: MarketLeaf; oracleNonce?: string } {
  const marketKey = asField(data.marketKey, 'marketKey').toString();
  const leaf = new MarketLeaf({
    configHash: asField(data.configHash, 'configHash'),
    closeSlot: asUInt64(data.closeSlot, 'closeSlot'),
    expirySlot: asUInt64(data.expirySlot, 'expirySlot'),
    thresholdValueTenthC: asUInt64(data.thresholdValueTenthC, 'thresholdValueTenthC'),
    totalPositionBet: asUInt64(data.totalPositionBet, 'totalPositionBet'),
    totalYesPositionBet: asUInt64(data.totalYesPositionBet, 'totalYesPositionBet'),
    resolved: asBool(data.resolved, 'resolved'),
    outcome: asBool(data.outcome, 'outcome'),
    oracleStatementHash: asField(data.oracleStatementHash, 'oracleStatementHash')
  });
  const oracleNonce = data.oracleNonce ? asField(data.oracleNonce, 'oracleNonce').toString() : undefined;
  return { marketKey, leaf, oracleNonce };
}

function mergeMonotonicState(existingState: OperatorStateFile, nextState: OperatorStateFile): OperatorStateFile {
  nextState.usedNonces = {
    ...(existingState.usedNonces || {}),
    ...(nextState.usedNonces || {})
  };

  return nextState;
}

async function buildStateFromEvents(params: {
  zkappAddress: ReturnType<typeof PrivateKey.fromBase58> extends PrivateKey ? ReturnType<PrivateKey['toPublicKey']> : never;
  networkId: string;
  graphql: string;
  archiveGraphql: string;
  existingState: OperatorStateFile;
}): Promise<OperatorStateFile> {
  const { zkappAddress, networkId, graphql, archiveGraphql, existingState } = params;
  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: archiveGraphql
  });
  Mina.setActiveInstance(network);

  const zkapp = new FastPredictionMarketPlatform(zkappAddress);
  const rawEvents = await zkapp.fetchEvents();
  const parsed = extractParsedEvents(rawEvents as unknown[]);
  const nextState: OperatorStateFile = {
    zkappPublicKey: zkappAddress.toBase58(),
    markets: {},
    positions: {},
    receipts: {},
    claimedReceipts: {},
    usedNonces: {},
    marketMeta: existingState.marketMeta || {},
    positionMeta: existingState.positionMeta || {},
    receiptMeta: existingState.receiptMeta || {}
  };

  for (const evt of parsed) {
    try {
      if (evt.type === 'marketCreated' || evt.type === 'marketUpdated' || evt.type === 'marketResolved') {
        const { marketKey, leaf, oracleNonce } = leafFromEventData(evt.data);
        nextState.markets[marketKey] = serializeMarketLeaf(leaf);
        if (oracleNonce) {
          nextState.usedNonces[oracleNonce] = '1';
        }
      } else if (evt.type === 'receiptCommitted') {
        const receiptKey = asField(evt.data.receiptKey, 'receiptKey').toString();
        const receiptCommitment = asField(evt.data.receiptCommitment, 'receiptCommitment').toString();
        nextState.receipts = nextState.receipts || {};
        nextState.receipts[receiptKey] = receiptCommitment;
      } else if (evt.type === 'receiptClaimed') {
        const receiptKey = asField(evt.data.receiptKey, 'receiptKey').toString();
        nextState.claimedReceipts = nextState.claimedReceipts || {};
        nextState.claimedReceipts[receiptKey] = '1';
      }
    } catch {
      // ignore incompatible historical events from older contract versions
    }
  }

  return mergeMonotonicState(existingState, nextState);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const archiveGraphql = process.env.ZEKO_ARCHIVE_GRAPHQL || graphql;
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const zkappAddress = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY')).toPublicKey();
  const existingState = await loadOperatorState(stateFile);

  const latestState = await loadOperatorState(stateFile);
  const nextState = await buildStateFromEvents({
    zkappAddress,
    networkId,
    graphql,
    archiveGraphql: graphql,
    existingState: latestState
  });
  nextState.marketMeta = {
    ...(existingState.marketMeta || {}),
    ...(latestState.marketMeta || {})
  };
  nextState.positionMeta = {
    ...(existingState.positionMeta || {}),
    ...(latestState.positionMeta || {})
  };
  nextState.receiptMeta = {
    ...(existingState.receiptMeta || {}),
    ...(latestState.receiptMeta || {})
  };

  const localRoot = getLocalMarketsRoot(nextState);
  const localReceiptsRoot = getLocalReceiptsRoot(nextState);
  await saveOperatorState(stateFile, nextState);

  let chainRoot: string | null = null;
  let chainReceiptsRoot: string | null = null;
  try {
    chainRoot = await getOnChainMarketsRoot(zkappAddress);
    chainReceiptsRoot = await getOnChainReceiptsRoot(zkappAddress);
  } catch (error) {
    if (isUninitializedFastZkappError(error)) {
      console.warn(
        '[sync-state-zeko] zkApp account does not exist on-chain yet; saved event-derived fresh-contract state'
      );
    } else {
      console.warn(
        `[sync-state-zeko] chain root fetch unavailable after event sync: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log('State sync complete.');
  console.log('Events source:', graphql);
  console.log('Markets synced:', Object.keys(nextState.markets).length);
  console.log('Receipts synced:', Object.keys(nextState.receipts || {}).length);
  console.log('Used nonces synced:', Object.keys(nextState.usedNonces).length);
  console.log('Local marketsRoot:', localRoot);
  console.log('Chain marketsRoot:', chainRoot ?? 'unavailable');
  console.log('Local receiptsRoot:', localReceiptsRoot);
  console.log('Chain receiptsRoot:', chainReceiptsRoot ?? 'unavailable');
  console.log('Markets root match:', chainRoot ? (localRoot === chainRoot ? 'yes' : 'no') : 'unknown');
  console.log('Receipts root match:', chainReceiptsRoot ? (localReceiptsRoot === chainReceiptsRoot ? 'yes' : 'no') : 'unknown');
}

main().catch((error: unknown) => {
  console.error('[sync-state-zeko] failed:', error);
  process.exit(1);
});
