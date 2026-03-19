import 'reflect-metadata';
import './env.js';
import { AccountUpdate, Field, Mina, PrivateKey, fetchAccount } from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { getFastNodeCompileCache } from './fast-compile-cache.js';
import { withTxRetry } from './tx-retry.js';

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function hasInitializedZkappAppState(account: Awaited<ReturnType<typeof fetchAccount>>): boolean {
  const appState = (account.account as unknown as { zkapp?: { appState?: unknown[] } })?.zkapp?.appState;
  return Array.isArray(appState) && appState.length > 0;
}

async function main(): Promise<void> {
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const txFee = process.env.TX_FEE || '200000000';

  const deployer = PrivateKey.fromBase58(readEnv('DEPLOYER_PRIVATE_KEY'));
  const zkappKey = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY'));
  const zkappAddress = zkappKey.toPublicKey();

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  const deployerAccount = await fetchAccount({ publicKey: deployer.toPublicKey() });
  if (deployerAccount.error) {
    throw new Error(`Missing deployer account: ${deployerAccount.error.statusText || 'unknown'}`);
  }

  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  const zkappExists = !zkappAccount.error;
  const hasVerificationKey = Boolean(
    !zkappAccount.error &&
      zkappAccount.account?.zkapp?.verificationKey &&
      typeof zkappAccount.account.zkapp.verificationKey === 'object'
  );
  const hasAppState = zkappExists && hasInitializedZkappAppState(zkappAccount);

  if (zkappExists && hasVerificationKey && hasAppState) {
    console.log('Fast zkApp already initialized on-chain.');
    console.log('ZKAPP_PUBLIC_KEY=', zkappAddress.toBase58());
    return;
  }

  console.log('Compiling FastPredictionMarketPlatform for bootstrap...');
  await FastPredictionMarketPlatform.compile({
    cache: getFastNodeCompileCache()
  });

  const sourceHash = Field(readEnv('ORACLE_SOURCE_HASH'));
  const requestPathHash = Field(readEnv('ORACLE_REQUEST_PATH_HASH'));

  await withTxRetry(
    async () => {
      const tx = await Mina.transaction({ sender: deployer.toPublicKey(), fee: txFee }, async () => {
        const zkapp = new FastPredictionMarketPlatform(zkappAddress);
        if (!zkappExists) {
          AccountUpdate.fundNewAccount(deployer.toPublicKey());
        }
        if (!hasVerificationKey) {
          zkapp.deploy();
        }
        zkapp.configureOraclePolicy(sourceHash, requestPathHash);
      });
      await tx.prove();
      await tx.sign([deployer, zkappKey]).send();
    },
    { label: 'bootstrap-fast-zkapp:zeko' }
  );

  console.log('Fast zkApp bootstrap complete.');
  console.log('ZKAPP_PUBLIC_KEY=', zkappAddress.toBase58());
}

main().catch((error: unknown) => {
  console.error('[bootstrap-fast-zkapp:zeko] failed:', error);
  process.exit(1);
});
