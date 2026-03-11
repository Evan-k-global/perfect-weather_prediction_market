import 'reflect-metadata';
import './env.js';
import { Bool, Mina, PrivateKey, Field, fetchAccount } from 'o1js';
import { PositionLeaf, PredictionMarketPlatform } from './contract.js';
import {
  DEFAULT_STATE_FILE,
  buildMarketsMerkleMap,
  buildPositionsMerkleMap,
  deserializeMarketLeaf,
  deserializePositionLeaf,
  loadOperatorState,
  saveOperatorState,
  serializePositionLeaf
} from './state-store.js';
import { assertLocalMarketsRootMatchesChain } from './chain-state.js';
import { withTxRetry } from './tx-retry.js';

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
  const positionKey = Field(parseArgValue(args, 'position-key'));
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;

  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const txFee = process.env.TX_FEE || '200000000';
  const claimant = PrivateKey.fromBase58(process.env.CLAIMANT_PRIVATE_KEY || readEnv('DEPLOYER_PRIVATE_KEY'));
  const zkappAddress = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY')).toPublicKey();

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  const claimantAccount = await fetchAccount({ publicKey: claimant.toPublicKey() });
  if (claimantAccount.error) throw new Error(`Missing claimant account: ${claimantAccount.error.statusText || 'unknown'}`);

  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  if (zkappAccount.error) throw new Error('zkApp account not found. Deploy first.');

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  const existingMarket = state.markets[marketKey.toString()];
  if (!existingMarket) throw new Error(`market ${marketKey.toString()} missing in ${stateFile}`);
  const resolvedLeaf = deserializeMarketLeaf(existingMarket);
  if (!resolvedLeaf.resolved.toBoolean()) throw new Error('market not resolved yet');

  const existingPosition = state.positions[positionKey.toString()];
  if (!existingPosition) throw new Error(`position ${positionKey.toString()} missing in ${stateFile}`);
  const positionLeaf = deserializePositionLeaf(existingPosition);
  if (positionLeaf.claimed.toBoolean()) throw new Error('position already claimed');

  await PredictionMarketPlatform.compile();
  const zkapp = new PredictionMarketPlatform(zkappAddress);
  const marketsMap = buildMarketsMerkleMap(state);
  const positionsMap = buildPositionsMerkleMap(state);

  await withTxRetry(
    async () => {
      const tx = await Mina.transaction({ sender: claimant.toPublicKey(), fee: txFee }, async () => {
        zkapp.claimPayout(
          marketKey,
          resolvedLeaf,
          marketsMap.getWitness(marketKey),
          positionKey,
          positionLeaf,
          positionsMap.getWitness(positionKey),
          claimant.toPublicKey()
        );
      });
      await tx.prove();
      await tx.sign([claimant]).send();
    },
    { label: 'claim-payout:zeko' }
  );

  const claimedLeaf = new PositionLeaf({
    marketKey: positionLeaf.marketKey,
    sideOver: positionLeaf.sideOver,
    stake: positionLeaf.stake,
    ownerCommitment: positionLeaf.ownerCommitment,
    claimed: Bool(true)
  });
  state.positions[positionKey.toString()] = serializePositionLeaf(claimedLeaf);
  await saveOperatorState(stateFile, state);

  const winningPool = resolvedLeaf.outcome.toBoolean()
    ? BigInt(resolvedLeaf.totalYesPositionBet.toString())
    : BigInt(resolvedLeaf.totalPositionBet.toString()) - BigInt(resolvedLeaf.totalYesPositionBet.toString());
  const payoutNanomina =
    (BigInt(resolvedLeaf.totalPositionBet.toString()) * BigInt(positionLeaf.stake.toString())) / winningPool;
  console.log('Payout claimed.');
  console.log('Market key:', marketKey.toString());
  console.log('Position key:', positionKey.toString());
  console.log('Claimant:', claimant.toPublicKey().toBase58());
  console.log('Payout (nanomina):', payoutNanomina.toString());
  console.log('State file:', stateFile);
}

main().catch((error: unknown) => {
  console.error('[claim-payout:zeko] failed:', error);
  process.exit(1);
});
