import { PublicKey, fetchAccount } from 'o1js';
import { OperatorStateFile, buildMarketsMerkleMap, buildPositionsMerkleMap } from './state-store.js';

function stringifyFieldLike(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return (value as { toString(): string }).toString();
  }
  throw new Error('unable to stringify field-like value');
}

function getAppStateField(appState: unknown[] | undefined, index: number, label: string): string {
  if (!appState || appState.length <= index) {
    throw new Error(`zkApp appState missing; cannot read ${label}`);
  }
  return stringifyFieldLike(appState[index]);
}

async function getOnChainAppState(zkappAddress: PublicKey): Promise<unknown[]> {
  const account = await fetchAccount({ publicKey: zkappAddress });
  if (account.error) {
    throw new Error(`zkApp account fetch failed: ${account.error.statusText || 'unknown error'}`);
  }
  const appState = (account.account as unknown as { zkapp?: { appState?: unknown[] } })?.zkapp?.appState;
  if (!appState || appState.length === 0) {
    throw new Error('zkApp appState missing');
  }
  return appState;
}

export async function getOnChainMarketsRoot(zkappAddress: PublicKey): Promise<string> {
  const appState = await getOnChainAppState(zkappAddress);
  return getAppStateField(appState, 0, 'marketsRoot');
}

export async function getOnChainPositionsRoot(zkappAddress: PublicKey): Promise<string> {
  const appState = await getOnChainAppState(zkappAddress);
  return getAppStateField(appState, 1, 'positionsRoot');
}

export function getLocalMarketsRoot(state: OperatorStateFile): string {
  return buildMarketsMerkleMap(state).getRoot().toString();
}

export function getLocalPositionsRoot(state: OperatorStateFile): string {
  return buildPositionsMerkleMap(state).getRoot().toString();
}

export async function assertLocalMarketsRootMatchesChain(
  zkappAddress: PublicKey,
  state: OperatorStateFile
): Promise<void> {
  const localRoot = getLocalMarketsRoot(state);
  const chainRoot = await getOnChainMarketsRoot(zkappAddress);
  if (localRoot !== chainRoot) {
    throw new Error(
      `marketsRoot mismatch local=${localRoot} chain=${chainRoot}. Run: pnpm sync-state:zeko -- --state-file ./data/operator-state.json`
    );
  }
}

export async function assertLocalPositionsRootMatchesChain(
  zkappAddress: PublicKey,
  state: OperatorStateFile
): Promise<void> {
  const localRoot = getLocalPositionsRoot(state);
  const chainRoot = await getOnChainPositionsRoot(zkappAddress);
  if (localRoot !== chainRoot) {
    throw new Error(
      `positionsRoot mismatch local=${localRoot} chain=${chainRoot}. Sync authoritative operator state before claiming or batching.`
    );
  }
}
