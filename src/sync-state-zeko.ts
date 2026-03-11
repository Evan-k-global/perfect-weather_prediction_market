import 'reflect-metadata';
import './env.js';
import { Bool, Field, Mina, PrivateKey, UInt64 } from 'o1js';
import { MarketLeaf, PredictionMarketPlatform } from './contract.js';
import {
  DEFAULT_STATE_FILE,
  OperatorStateFile,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf
} from './state-store.js';
import { getLocalMarketsRoot, getOnChainMarketsRoot } from './chain-state.js';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const zkappAddress = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY')).toPublicKey();

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  await PredictionMarketPlatform.compile();
  const zkapp = new PredictionMarketPlatform(zkappAddress);
  const existingState = await loadOperatorState(stateFile);

  const rawEvents = await zkapp.fetchEvents();
  const parsed = extractParsedEvents(rawEvents as unknown[]);
  const nextState: OperatorStateFile = {
    markets: {},
    positions: existingState.positions || {},
    usedNonces: {},
    marketMeta: existingState.marketMeta || {},
    positionMeta: existingState.positionMeta || {}
  };

  for (const evt of parsed) {
    if (evt.type !== 'marketCreated' && evt.type !== 'marketUpdated' && evt.type !== 'marketResolved') {
      continue;
    }
    try {
      const { marketKey, leaf, oracleNonce } = leafFromEventData(evt.data);
      nextState.markets[marketKey] = serializeMarketLeaf(leaf);
      if (oracleNonce) {
        nextState.usedNonces[oracleNonce] = '1';
      }
    } catch {
      // ignore incompatible historical events from older contract versions
    }
  }

  await saveOperatorState(stateFile, nextState);
  const localRoot = getLocalMarketsRoot(nextState);
  const chainRoot = await getOnChainMarketsRoot(zkappAddress);

  console.log('State sync complete.');
  console.log('Markets synced:', Object.keys(nextState.markets).length);
  console.log('Used nonces synced:', Object.keys(nextState.usedNonces).length);
  console.log('Local marketsRoot:', localRoot);
  console.log('Chain marketsRoot:', chainRoot);
  console.log('Roots match:', localRoot === chainRoot ? 'yes' : 'no');
}

main().catch((error: unknown) => {
  console.error('[sync-state-zeko] failed:', error);
  process.exit(1);
});
