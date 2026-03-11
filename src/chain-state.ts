import { PublicKey, fetchAccount } from 'o1js';
import { OperatorStateFile, buildMarketsMerkleMap } from './state-store.js';

function stringifyFieldLike(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return (value as { toString(): string }).toString();
  }
  throw new Error('unable to stringify field-like value');
}

export async function getOnChainMarketsRoot(zkappAddress: PublicKey): Promise<string> {
  const account = await fetchAccount({ publicKey: zkappAddress });
  if (account.error) {
    throw new Error(`zkApp account fetch failed: ${account.error.statusText || 'unknown error'}`);
  }
  const appState = (account.account as unknown as { zkapp?: { appState?: unknown[] } })?.zkapp?.appState;
  if (!appState || appState.length === 0) {
    throw new Error('zkApp appState missing; cannot read marketsRoot');
  }
  return stringifyFieldLike(appState[0]);
}

export function getLocalMarketsRoot(state: OperatorStateFile): string {
  return buildMarketsMerkleMap(state).getRoot().toString();
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
