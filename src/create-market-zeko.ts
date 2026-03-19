import 'reflect-metadata';
import './env.js';
import { Field, Mina, PrivateKey, UInt64, fetchAccount } from 'o1js';
import { Bool } from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { MarketLeaf } from './market-types.js';
import { assertLocalMarketsRootMatchesChain } from './fast-chain-state.js';
import {
  DEFAULT_STATE_FILE,
  buildMarketsMerkleMap,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf,
  StoredMarketMeta
} from './state-store.js';
import { withTxRetry } from './tx-retry.js';
import { getFastNodeCompileCache } from './fast-compile-cache.js';

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function parseArgValue(args: string[], name: string): string {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  throw new Error(`Missing required argument --${name}`);
}

function parseOptionalArgValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function readSenderPrivateKey(): PrivateKey {
  const raw = process.env.DEPLOYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (!raw) throw new Error('Missing env DEPLOYER_PRIVATE_KEY (or RELAYER_PRIVATE_KEY fallback)');
  return PrivateKey.fromBase58(raw);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const marketKey = Field(parseArgValue(args, 'market-key'));
  const configHash = Field(parseArgValue(args, 'config-hash'));
  const closeSlot = UInt64.from(parseArgValue(args, 'close-slot'));
  const expirySlot = UInt64.from(parseArgValue(args, 'expiry-slot'));
  const thresholdValueTenthC = UInt64.from(parseArgValue(args, 'threshold-tenth-c'));
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;
  const title = parseOptionalArgValue(args, 'title') || `Market ${marketKey.toString()}`;
  const rulesPrimary =
    parseOptionalArgValue(args, 'rules-primary') ||
    'Will observed weather value be greater than threshold at determination time?';
  const settlementSource =
    parseOptionalArgValue(args, 'settlement-source') ||
    'https://api.weather.example/v1/current';
  const determinationSlot = UInt64.from(
    parseOptionalArgValue(args, 'determination-slot') || expirySlot.toString()
  );
  expirySlot.lessThanOrEqual(determinationSlot).assertTrue();

  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const txFee = process.env.TX_FEE || '200000000';
  const sender = readSenderPrivateKey();
  const zkappAddress = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY')).toPublicKey();

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  const senderAccount = await fetchAccount({ publicKey: sender.toPublicKey() });
  if (senderAccount.error) throw new Error(`Missing sender account: ${senderAccount.error.statusText || 'unknown'}`);

  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  if (zkappAccount.error) throw new Error('zkApp account not found. Deploy first.');

  const state = await loadOperatorState(stateFile);
  if (state.markets[marketKey.toString()]) {
    throw new Error(`market ${marketKey.toString()} already exists in ${stateFile}`);
  }
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);

  const marketsMap = buildMarketsMerkleMap(state);
  const newLeaf = new MarketLeaf({
    configHash,
    closeSlot,
    expirySlot,
    thresholdValueTenthC,
    totalPositionBet: UInt64.from(0),
    totalYesPositionBet: UInt64.from(0),
    resolved: Bool(false),
    outcome: Bool(false),
    oracleStatementHash: Field(0)
  });

  await FastPredictionMarketPlatform.compile({
    cache: getFastNodeCompileCache()
  });
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);

  await withTxRetry(
    async () => {
      const tx = await Mina.transaction({ sender: sender.toPublicKey(), fee: txFee }, async () => {
        zkapp.createMarket(marketKey, newLeaf, marketsMap.getWitness(marketKey));
      });
      await tx.prove();
      await tx.sign([sender]).send();
    },
    { label: 'create-market:zeko' }
  );

  state.markets[marketKey.toString()] = serializeMarketLeaf(newLeaf);
  const meta: StoredMarketMeta = {
    title,
    rulesPrimary,
    settlementSource,
    createdAtUnixMs: Date.now(),
    closeSlot: closeSlot.toString(),
    expirySlot: expirySlot.toString(),
    determinationSlot: determinationSlot.toString()
  };
  state.marketMeta = state.marketMeta || {};
  state.marketMeta[marketKey.toString()] = meta;
  await saveOperatorState(stateFile, state);

  console.log('Market created.');
  console.log('Market key:', marketKey.toString());
  console.log('State file:', stateFile);
}

main().catch((error: unknown) => {
  console.error('[create-market-zeko] failed:', error);
  process.exit(1);
});
