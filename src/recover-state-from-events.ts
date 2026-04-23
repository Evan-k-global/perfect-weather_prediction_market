import 'reflect-metadata';
import './env.js';
import { Bool, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { MarketLeaf } from './market-types.js';
import {
  DEFAULT_STATE_FILE,
  OperatorStateFile,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf
} from './state-store.js';
import { getLocalMarketsRoot, getLocalReceiptsRoot } from './fast-chain-state.js';

type ParsedEvent = {
  type: string;
  data: Record<string, unknown>;
  blockHeight?: string | number | null;
  transactionHash?: string | null;
};

function parseOptionalArgValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function readPublicKey(): PublicKey {
  if (process.env.ZKAPP_PUBLIC_KEY) return PublicKey.fromBase58(process.env.ZKAPP_PUBLIC_KEY);
  if (process.env.ZKAPP_PRIVATE_KEY) return PrivateKey.fromBase58(process.env.ZKAPP_PRIVATE_KEY).toPublicKey();
  throw new Error('Missing env ZKAPP_PUBLIC_KEY or ZKAPP_PRIVATE_KEY');
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
      parsed.push({
        type: flatType,
        data: flatData as Record<string, unknown>,
        blockHeight: (item.blockHeight as string | number | null | undefined) ?? null,
        transactionHash: (item.transactionHash as string | null | undefined) ?? null
      });
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
          parsed.push({
            type: t,
            data: d as Record<string, unknown>,
            blockHeight: (item.blockHeight as string | number | null | undefined) ?? null,
            transactionHash: (item.transactionHash as string | null | undefined) ?? null
          });
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

function applyEvent(state: OperatorStateFile, event: ParsedEvent): void {
  if (event.type === 'marketCreated' || event.type === 'marketUpdated' || event.type === 'marketResolved') {
    const { marketKey, leaf, oracleNonce } = leafFromEventData(event.data);
    state.markets[marketKey] = serializeMarketLeaf(leaf);
    if (oracleNonce) state.usedNonces[oracleNonce] = '1';
    return;
  }
  if (event.type === 'receiptCommitted') {
    const receiptKey = asField(event.data.receiptKey, 'receiptKey').toString();
    const receiptCommitment = asField(event.data.receiptCommitment, 'receiptCommitment').toString();
    state.receipts = state.receipts || {};
    state.receipts[receiptKey] = receiptCommitment;
    return;
  }
  if (event.type === 'receiptClaimed') {
    const receiptKey = asField(event.data.receiptKey, 'receiptKey').toString();
    state.claimedReceipts = state.claimedReceipts || {};
    state.claimedReceipts[receiptKey] = '1';
  }
}

function emptyState(zkappPublicKey: string, existingState: OperatorStateFile): OperatorStateFile {
  return {
    zkappPublicKey,
    markets: {},
    positions: {},
    receipts: {},
    claimedReceipts: {},
    usedNonces: {},
    marketMeta: existingState.marketMeta || {},
    positionMeta: existingState.positionMeta || {},
    receiptMeta: existingState.receiptMeta || {}
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;
  const outFile = parseOptionalArgValue(args, 'out-file') || './data/operator-state.recovered-from-events.json';
  const targetMarketsRoot = parseOptionalArgValue(args, 'markets-root') || process.env.RECOVERY_TARGET_MARKETS_ROOT;
  const targetReceiptsRoot = parseOptionalArgValue(args, 'receipts-root') || process.env.RECOVERY_TARGET_RECEIPTS_ROOT;
  const writeCandidate = parseFlag(args, 'write-candidate');

  if (!targetMarketsRoot) throw new Error('missing --markets-root or RECOVERY_TARGET_MARKETS_ROOT');
  if (!targetReceiptsRoot) throw new Error('missing --receipts-root or RECOVERY_TARGET_RECEIPTS_ROOT');

  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const archiveGraphql = process.env.ZEKO_ARCHIVE_GRAPHQL || graphql;
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  Mina.setActiveInstance(Mina.Network({ networkId: networkId as never, mina: graphql, archive: archiveGraphql }));

  const zkappAddress = readPublicKey();
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);
  const existingState = await loadOperatorState(stateFile);
  const state = emptyState(zkappAddress.toBase58(), existingState);

  console.time('[recover-state-from-events] fetchEvents');
  const rawEvents = await zkapp.fetchEvents();
  console.timeEnd('[recover-state-from-events] fetchEvents');

  const events = extractParsedEvents(rawEvents as unknown[]);
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;

  console.time('[recover-state-from-events] replay');
  let match: Record<string, unknown> | null = null;
  for (let idx = 0; idx < events.length; idx += 1) {
    try {
      applyEvent(state, events[idx]);
    } catch {
      continue;
    }
    const marketsRoot = getLocalMarketsRoot(state);
    const receiptsRoot = getLocalReceiptsRoot(state);
    if (marketsRoot === targetMarketsRoot && receiptsRoot === targetReceiptsRoot) {
      match = {
        eventIndex: idx,
        eventType: events[idx].type,
        blockHeight: events[idx].blockHeight ?? null,
        transactionHash: events[idx].transactionHash ?? null,
        markets: Object.keys(state.markets || {}).length,
        receipts: Object.keys(state.receipts || {}).length,
        claimedReceipts: Object.keys(state.claimedReceipts || {}).length,
        marketsRoot,
        receiptsRoot
      };
      break;
    }
  }
  console.timeEnd('[recover-state-from-events] replay');

  const summary: Record<string, unknown> = {
    source: stateFile,
    rawEvents: Array.isArray(rawEvents) ? rawEvents.length : null,
    parsedEvents: events.length,
    counts,
    target: {
      marketsRoot: targetMarketsRoot,
      receiptsRoot: targetReceiptsRoot
    },
    finalReplay: {
      markets: Object.keys(state.markets || {}).length,
      receipts: Object.keys(state.receipts || {}).length,
      claimedReceipts: Object.keys(state.claimedReceipts || {}).length,
      marketsRoot: getLocalMarketsRoot(state),
      receiptsRoot: getLocalReceiptsRoot(state)
    },
    match
  };

  if (match && writeCandidate) {
    await saveOperatorState(outFile, state);
    summary.wrote = outFile;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error('[recover-state-from-events] failed:', error);
  process.exit(1);
});
