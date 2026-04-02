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

const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
const archiveGraphql = process.env.ZEKO_ARCHIVE_GRAPHQL || graphql;
const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
const txFee = process.env.TX_FEE || '200000000';

const deployer = PrivateKey.fromBase58(readEnv('DEPLOYER_PRIVATE_KEY'));
const zkappKey = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY'));
const zkappAddress = zkappKey.toPublicKey();

const network = Mina.Network({
  networkId: networkId as never,
  mina: graphql,
  archive: archiveGraphql
});
Mina.setActiveInstance(network);

const deployerAccount = await fetchAccount({ publicKey: deployer.toPublicKey() });
if (deployerAccount.error) throw new Error(`Missing deployer account: ${deployerAccount.error.statusText || 'unknown'}`);

const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
const zkappExists = !zkappAccount.error;
const zkappAlreadyDeployed = Boolean(
  !zkappAccount.error &&
    zkappAccount.account?.zkapp?.verificationKey &&
    typeof zkappAccount.account.zkapp.verificationKey === 'object'
);

console.log('Compiling FastPredictionMarketPlatform...');
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
      if (!zkappAlreadyDeployed) {
        zkapp.deploy();
      }
      zkapp.configureOraclePolicy(sourceHash, requestPathHash);
    });
    await tx.prove();
    await tx.sign([deployer, zkappKey]).send();
  },
  { label: 'deploy:zeko' }
);

console.log('Deploy complete.');
console.log('ZKAPP_PUBLIC_KEY=', zkappAddress.toBase58());
