import 'reflect-metadata';
import './env.js';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Bool, Field, Mina, Poseidon, PrivateKey, UInt64, fetchAccount } from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { MarketLeaf } from './market-types.js';
import { DEFAULT_STATE_FILE, buildMarketsMerkleMap, loadOperatorState, saveOperatorState, serializeMarketLeaf, StoredMarketMeta } from './state-store.js';
import { assertLocalMarketsRootMatchesChain, isUninitializedFastZkappError } from './fast-chain-state.js';
import { withTxRetry } from './tx-retry.js';
import { deriveDateKeyedMarketKey } from './payout-upgrade-types.js';
import { getFastNodeCompileCache } from './fast-compile-cache.js';

type DemoDailyMarketFile = Record<string, {
  marketDate: string;
  marketKey?: string;
  thresholdF: number;
  lockedAtUnixMs: number;
  sourceDayIndexWhenLocked: number;
  sourceForecastHighFWhenLocked: number;
  totalPositionBet: number;
  totalYesPositionBet: number;
}>;

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

function fieldFromHexDigest(hex: string, chars = 30): Field {
  return Field(BigInt(`0x${hex.slice(0, chars)}`));
}

function fieldFromIsoDate(dateIso: string): Field {
  return fieldFromHexDigest(createHash('sha256').update(`date:${dateIso}`).digest('hex'));
}

function demoBaseConfigHash(): Field {
  return Field(process.env.DEMO_MARKET_BASE_CONFIG_HASH || '9301');
}

function deriveMarketKey(dateIso: string): Field {
  return deriveDateKeyedMarketKey(demoBaseConfigHash(), fieldFromIsoDate(dateIso));
}

function thresholdFToTenthC(thresholdF: number): bigint {
  return BigInt(Math.round(((thresholdF - 32) * 5 * 10) / 9));
}

function localDateAtHour(dateIso: string, hourLocal: number): Date {
  const date = new Date(`${dateIso}T00:00:00`);
  date.setHours(hourLocal, 0, 0, 0);
  return date;
}

function minuteSlotForDateHour(dateIso: string, hourLocal: number): bigint {
  return BigInt(Math.floor(localDateAtHour(dateIso, hourLocal).getTime() / 60000));
}

async function loadDemoDailyMarkets(filePath: string): Promise<DemoDailyMarketFile> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as DemoDailyMarketFile;
}

async function saveDemoDailyMarkets(filePath: string, data: DemoDailyMarketFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readSenderPrivateKey(): PrivateKey {
  const raw = process.env.DEPLOYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (!raw) throw new Error('Missing env DEPLOYER_PRIVATE_KEY (or RELAYER_PRIVATE_KEY fallback)');
  return PrivateKey.fromBase58(raw);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;
  const dailyMarketsFile = parseOptionalArgValue(args, 'daily-markets-file') || './data/demo-daily-threshold-markets.json';
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
  try {
    await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  } catch (error) {
    if (!isUninitializedFastZkappError(error)) {
      throw error;
    }
    console.warn('[ensure-daily-markets:zeko] fast zkApp is not initialized on-chain yet; skipping market creation');
    console.log('Daily market ensure skipped.');
    console.log('Created:', 0);
    console.log('Reason:', 'zkapp not initialized');
    console.log('State file:', stateFile);
    console.log('Daily markets file:', dailyMarketsFile);
    return;
  }
  const daily = await loadDemoDailyMarkets(dailyMarketsFile);
  await FastPredictionMarketPlatform.compile({
    cache: getFastNodeCompileCache()
  });
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);

  let created = 0;
  for (const [marketDate, item] of Object.entries(daily).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const marketKey = deriveMarketKey(marketDate);
    item.marketKey = marketKey.toString();
    if (state.markets[marketKey.toString()]) continue;

    const closeSlot = UInt64.from(minuteSlotForDateHour(marketDate, 21).toString());
    const expirySlot = UInt64.from(minuteSlotForDateHour(marketDate, 24).toString());
    const thresholdValueTenthC = UInt64.from(thresholdFToTenthC(item.thresholdF).toString());
    const newLeaf = new MarketLeaf({
      configHash: demoBaseConfigHash(),
      closeSlot,
      expirySlot,
      thresholdValueTenthC,
      totalPositionBet: UInt64.from(0),
      totalYesPositionBet: UInt64.from(0),
      resolved: Bool(false),
      outcome: Bool(false),
      oracleStatementHash: Field(0)
    });
    const marketsMap = buildMarketsMerkleMap(state);
    await withTxRetry(
      async () => {
        const tx = await Mina.transaction({ sender: sender.toPublicKey(), fee: txFee }, async () => {
          zkapp.createMarket(marketKey, newLeaf, marketsMap.getWitness(marketKey));
        });
        await tx.prove();
        await tx.sign([sender]).send();
      },
      { label: `ensure-daily-market:${marketDate}` }
    );

    state.markets[marketKey.toString()] = serializeMarketLeaf(newLeaf);
    state.marketMeta = state.marketMeta || {};
    const meta: StoredMarketMeta = {
      title: `Atherton, CA - ${marketDate} Over/Under ${item.thresholdF}F`,
      rulesPrimary: `Resolves OVER if observed daily high on ${marketDate} is greater than locked threshold ${item.thresholdF}F.`,
      settlementSource: 'https://api.weather.gov/gridpoints/MTR/86,107/forecast',
      createdAtUnixMs: Date.now(),
      closeSlot: closeSlot.toString(),
      expirySlot: expirySlot.toString(),
      determinationSlot: expirySlot.toString()
    };
    state.marketMeta[marketKey.toString()] = meta;
    created += 1;
  }

  await saveOperatorState(stateFile, state);
  await saveDemoDailyMarkets(dailyMarketsFile, daily);
  console.log('Daily market ensure complete.');
  console.log('Created:', created);
  console.log('State file:', stateFile);
  console.log('Daily markets file:', dailyMarketsFile);
}

main().catch((error: unknown) => {
  console.error('[ensure-daily-markets:zeko] failed:', error);
  process.exit(1);
});
