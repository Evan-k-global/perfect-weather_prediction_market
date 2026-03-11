import 'reflect-metadata';
import './env.js';
import { Bool, Field, Mina, Poseidon, PrivateKey, UInt64, fetchAccount } from 'o1js';
import { MarketLeaf, PredictionMarketPlatform } from './contract.js';
import { assertLocalMarketsRootMatchesChain } from './chain-state.js';
import { withTxRetry } from './tx-retry.js';
import {
  DEFAULT_STATE_FILE,
  buildMarketsMerkleMap,
  deserializeMarketLeaf,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf
} from './state-store.js';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const marketKey = Field(parseArgValue(args, 'market-key'));
  const addTotalBet = UInt64.from(parseArgValue(args, 'add-total-bet'));
  const addYesBet = UInt64.from(parseArgValue(args, 'add-yes-bet'));
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;

  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const txFee = process.env.TX_FEE || '200000000';
  const trader = PrivateKey.fromBase58(readEnv('DEPLOYER_PRIVATE_KEY'));
  const zkappAddress = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY')).toPublicKey();

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  const traderAccount = await fetchAccount({ publicKey: trader.toPublicKey() });
  if (traderAccount.error) throw new Error(`Missing trader account: ${traderAccount.error.statusText || 'unknown'}`);

  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  if (zkappAccount.error) throw new Error('zkApp account not found. Deploy first.');

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  const existing = state.markets[marketKey.toString()];
  if (!existing) throw new Error(`market ${marketKey.toString()} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('cannot trade a resolved market');
  addYesBet.lessThanOrEqual(addTotalBet).assertTrue();

  const newLeaf = new MarketLeaf({
    configHash: oldLeaf.configHash,
    closeSlot: oldLeaf.closeSlot,
    expirySlot: oldLeaf.expirySlot,
    thresholdValueTenthC: oldLeaf.thresholdValueTenthC,
    totalPositionBet: oldLeaf.totalPositionBet.add(addTotalBet),
    totalYesPositionBet: oldLeaf.totalYesPositionBet.add(addYesBet),
    resolved: Bool(false),
    outcome: Bool(false),
    oracleStatementHash: Field(0)
  });
  newLeaf.totalYesPositionBet.lessThanOrEqual(newLeaf.totalPositionBet).assertTrue();

  const marketsMap = buildMarketsMerkleMap(state);
  const transitionDigest = Poseidon.hash([
    marketKey,
    oldLeaf.totalPositionBet.value,
    oldLeaf.totalYesPositionBet.value,
    newLeaf.totalPositionBet.value,
    newLeaf.totalYesPositionBet.value
  ]);
  const nextPositionsRoot = Poseidon.hash([transitionDigest, Field(Date.now())]);

  await PredictionMarketPlatform.compile();
  const zkapp = new PredictionMarketPlatform(zkappAddress);
  await withTxRetry(
    async () => {
      const tx = await Mina.transaction({ sender: trader.toPublicKey(), fee: txFee }, async () => {
        zkapp.placePrivateBet(
          marketKey,
          oldLeaf,
          newLeaf,
          marketsMap.getWitness(marketKey),
          nextPositionsRoot,
          transitionDigest
        );
      });
      await tx.prove();
      await tx.sign([trader]).send();
    },
    { label: 'trade-update:zeko' }
  );

  state.markets[marketKey.toString()] = serializeMarketLeaf(newLeaf);
  await saveOperatorState(stateFile, state);

  console.log('Market trade update applied.');
  console.log('Market key:', marketKey.toString());
  console.log('Total position bet:', newLeaf.totalPositionBet.toString());
  console.log('Total yes position bet:', newLeaf.totalYesPositionBet.toString());
}

main().catch((error: unknown) => {
  console.error('[trade-update-zeko] failed:', error);
  process.exit(1);
});
