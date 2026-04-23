import 'reflect-metadata';
import './env.js';
import { Field, MerkleMap } from 'o1js';
import {
  DEFAULT_STATE_FILE,
  OperatorStateFile,
  StoredMarketLeaf,
  deserializeMarketLeaf,
  loadOperatorState,
  saveOperatorState
} from './state-store.js';
import { getLocalMarketsRoot, getLocalReceiptsRoot } from './fast-chain-state.js';

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

function compareBigIntString(a: string | number | bigint, b: string | number | bigint): number {
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function emptyMerkleRoot(): string {
  return new MerkleMap().getRoot().toString();
}

type Candidate = {
  orderName: string;
  mode: 'prefix' | 'suffix';
  n: number;
  keys: string[];
};

function scanEntries<T>(
  entries: Array<[string, T]>,
  targetRoot: string,
  setEntry: (map: MerkleMap, key: string, value: T) => void
): Array<Omit<Candidate, 'orderName'>> {
  const candidates: Array<Omit<Candidate, 'orderName'>> = [];

  for (const mode of ['prefix', 'suffix'] as const) {
    const ordered = mode === 'prefix' ? entries : [...entries].reverse();
    const map = new MerkleMap();
    const keys: string[] = [];

    if (emptyMerkleRoot() === targetRoot) {
      candidates.push({ mode, n: 0, keys: [] });
    }

    for (const [key, value] of ordered) {
      setEntry(map, key, value);

      if (mode === 'prefix') {
        keys.push(key);
      } else {
        keys.unshift(key);
      }

      if (map.getRoot().toString() === targetRoot) {
        candidates.push({ mode, n: keys.length, keys: [...keys] });
      }
    }
  }

  return candidates;
}

function marketOrders(state: OperatorStateFile): Record<string, Array<[string, StoredMarketLeaf]>> {
  const entries = Object.entries(state.markets || {});
  return {
    json: entries,
    closeSlot: [...entries].sort((a, b) => compareBigIntString(a[1].closeSlot || 0, b[1].closeSlot || 0)),
    metaCreated: [...entries].sort(
      (a, b) => (state.marketMeta?.[a[0]]?.createdAtUnixMs || 0) - (state.marketMeta?.[b[0]]?.createdAtUnixMs || 0)
    ),
    key: [...entries].sort((a, b) => compareBigIntString(a[0], b[0]))
  };
}

function receiptOrders(state: OperatorStateFile): Record<string, Array<[string, string]>> {
  const entries = Object.entries(state.receipts || {});
  return {
    json: entries,
    metaCreated: [...entries].sort(
      (a, b) => (state.receiptMeta?.[a[0]]?.createdAtUnixMs || 0) - (state.receiptMeta?.[b[0]]?.createdAtUnixMs || 0)
    ),
    key: [...entries].sort((a, b) => compareBigIntString(a[0], b[0]))
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;
  const targetMarketsRoot = parseOptionalArgValue(args, 'markets-root') || process.env.RECOVERY_TARGET_MARKETS_ROOT;
  const targetReceiptsRoot = parseOptionalArgValue(args, 'receipts-root') || process.env.RECOVERY_TARGET_RECEIPTS_ROOT;
  const outFile = parseOptionalArgValue(args, 'out-file') || './data/operator-state.recovered-candidate.json';
  const writeCandidate = parseFlag(args, 'write-candidate');

  if (!targetMarketsRoot) throw new Error('missing --markets-root or RECOVERY_TARGET_MARKETS_ROOT');
  if (!targetReceiptsRoot) throw new Error('missing --receipts-root or RECOVERY_TARGET_RECEIPTS_ROOT');

  const state = await loadOperatorState(stateFile);
  const marketCandidates: Candidate[] = [];
  const receiptCandidates: Candidate[] = [];

  console.time('[recover-state-candidates] scan');

  for (const [orderName, entries] of Object.entries(marketOrders(state))) {
    for (const candidate of scanEntries(entries, targetMarketsRoot, (map, key, value) => {
      map.set(Field(key), deserializeMarketLeaf(value).hash());
    })) {
      marketCandidates.push({ orderName, ...candidate });
    }
  }

  for (const [orderName, entries] of Object.entries(receiptOrders(state))) {
    for (const candidate of scanEntries(entries, targetReceiptsRoot, (map, key, value) => {
      map.set(Field(key), Field(value));
    })) {
      receiptCandidates.push({ orderName, ...candidate });
    }
  }

  console.timeEnd('[recover-state-candidates] scan');

  const summary: Record<string, unknown> = {
    source: stateFile,
    full: {
      markets: Object.keys(state.markets || {}).length,
      receipts: Object.keys(state.receipts || {}).length,
      claimedReceipts: Object.keys(state.claimedReceipts || {}).length,
      marketsRoot: getLocalMarketsRoot(state),
      receiptsRoot: getLocalReceiptsRoot(state)
    },
    target: {
      marketsRoot: targetMarketsRoot,
      receiptsRoot: targetReceiptsRoot
    },
    marketCandidates: marketCandidates.map(({ keys: _keys, ...candidate }) => candidate),
    receiptCandidates: receiptCandidates.map(({ keys: _keys, ...candidate }) => candidate)
  };

  if (writeCandidate && marketCandidates.length > 0 && receiptCandidates.length > 0) {
    const marketCandidate = marketCandidates[0];
    const receiptCandidate = receiptCandidates[0];
    const recovered: OperatorStateFile = {
      ...state,
      markets: Object.fromEntries(marketCandidate.keys.map((key) => [key, state.markets[key]])),
      receipts: Object.fromEntries(receiptCandidate.keys.map((key) => [key, (state.receipts || {})[key]]))
    };
    await saveOperatorState(outFile, recovered);
    summary.wrote = {
      file: outFile,
      markets: Object.keys(recovered.markets || {}).length,
      receipts: Object.keys(recovered.receipts || {}).length,
      marketsRoot: getLocalMarketsRoot(recovered),
      receiptsRoot: getLocalReceiptsRoot(recovered)
    };
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error('[recover-state-candidates] failed:', error);
  process.exit(1);
});
