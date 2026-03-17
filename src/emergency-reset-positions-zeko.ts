import 'reflect-metadata';
import './env.js';
import { AccountUpdate, MerkleMap, Mina, PrivateKey, fetchAccount } from 'o1js';
import { withTxRetry } from './tx-retry.js';

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function req(baseUrl: string, operatorToken: string, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers || {});
  headers.set('x-operator-token', operatorToken);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers
  });
  const text = await res.text();
  let parsed: any = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`request ${path} failed with non-JSON response (${res.status}): ${text.slice(0, 240)}`);
    }
  }
  if (!res.ok) {
    throw new Error(parsed?.error || `request ${path} failed with status ${res.status}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const txFee = process.env.TX_FEE || '200000000';
  const deployer = PrivateKey.fromBase58(readEnv('DEPLOYER_PRIVATE_KEY'));
  const zkappKey = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY'));
  const zkappAddress = zkappKey.toPublicKey();
  const operatorBaseUrl = readEnv('OPERATOR_BASE_URL').replace(/\/+$/, '');
  const operatorToken = readEnv('OPERATOR_ACTION_TOKEN');
  const emptyPositionsRoot = new MerkleMap().getRoot();

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  const deployerAccount = await fetchAccount({ publicKey: deployer.toPublicKey() });
  if (deployerAccount.error) throw new Error(`Missing deployer account: ${deployerAccount.error.statusText || 'unknown'}`);

  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  if (zkappAccount.error) throw new Error('zkApp account not found. Deploy first.');

  console.log('[emergency-reset] resetting on-chain positions root via signed app-state update...');
  await withTxRetry(
    async () => {
      const tx = await Mina.transaction({ sender: deployer.toPublicKey(), fee: txFee }, async () => {
        const update = AccountUpdate.createSigned(zkappAddress);
        AccountUpdate.setValue(update.body.update.appState[1], emptyPositionsRoot);
      });
      await tx.prove();
      await tx.sign([deployer, zkappKey]).send();
    },
    { label: 'emergency-reset-positions:onchain' }
  );

  console.log('[emergency-reset] clearing hosted local positions + queue state...');
  const result = await req(operatorBaseUrl, operatorToken, '/api/operator/emergency-reset-positions-state', {
    method: 'POST',
    body: JSON.stringify({})
  });
  console.log(
    `[emergency-reset] local reset complete positions=${result.clearedPositions} positionMeta=${result.clearedPositionMeta} queued=${result.clearedQueuedBets}`
  );
}

main().catch((error: unknown) => {
  console.error('[emergency-reset-positions:zeko] failed:', error);
  process.exit(1);
});
