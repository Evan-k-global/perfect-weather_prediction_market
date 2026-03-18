import './env.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountUpdate, Bool, Field, Mina, Poseidon, PrivateKey, PublicKey, UInt32, UInt64, fetchAccount, fetchTransactionStatus } from 'o1js';
import { DEFAULT_STATE_FILE, loadOperatorState } from './state-store.js';
import {
  NWS_94027_DIGITAL_URL,
  NWS_94027_REQUEST_PATH,
  NWS_94027_SERVER_NAME,
  NWS_94027_STRICT_URL,
  type WeatherSnapshot,
  buildSevenDayHighProbabilities,
  currentLocalDate,
  fetchNws94027Snapshot,
  loadWeatherSnapshot,
  nowLocalHour,
  saveWeatherSnapshot,
  snapshotFromTlsnAttestation
} from './weather-service.js';
import {
  addContestBet,
  loadContestState,
  maybeAutoSettleContest,
  saveContestState,
  settleContest
} from './weather-contest.js';
import { verifyTlsnAttestationFile } from './tlsn-verifier.js';
import {
  loadOracleCommitteeState,
  saveOracleCommitteeState,
  submitCommitteeCommit,
  tryFinalizeCommitteeRound
} from './oracle-committee.js';
import {
  approveEmergencyProposal,
  canExecuteEmergencyProposal,
  createEmergencyProposal,
  loadGovernanceState,
  markProposalExecuted,
  saveGovernanceState
} from './governance-resolution.js';
import {
  acpCreateCreditsIntent,
  acpCreateRelayJobFromCredits,
  acpMarkIntentFunded,
  acpRelayRunJob,
  acpRevealAndSettleRelayJob,
  loadAcpCreditEscrowState,
  saveAcpCreditEscrowState
} from './acp-credit-escrow.js';
import { MarketLeaf, PositionLeaf, PredictionMarketPlatform } from './contract.js';
import { assertLocalMarketsRootMatchesChain } from './chain-state.js';
import {
  buildMarketsMerkleMap,
  buildPositionsMerkleMap,
  deserializeMarketLeaf,
  deserializePositionLeaf,
  saveOperatorState,
  serializeMarketLeaf,
  serializePositionLeaf,
  type StoredMarketLeaf,
  type StoredMarketMeta,
  type StoredPositionLeaf,
  type StoredPositionMeta
} from './state-store.js';
import { withTxRetry } from './tx-retry.js';
import { deriveDateKeyedMarketKey } from './payout-upgrade-types.js';
import { proveAndSendPrivateQueuedBet } from './private-batch-processor.js';

const execFileAsync = promisify(execFile);
const USER_POSITIONS_FILE = './data/user-positions.json';
const DEFAULT_TLSN_ATTESTATION_PATH = './data/tlsn-output/latest/attestation.json';
const LEGACY_TLSN_ATTESTATION_PATH = './data/weather-attestation.json';
const DEMO_DAILY_MARKETS_FILE = './data/demo-daily-threshold-markets.json';
const PRIVATE_BET_QUEUE_FILE = './data/private-bet-queue.json';
const PRIVATE_BATCH_HISTORY_FILE = './data/private-batch-history.json';
const DAILY_SETTLE_STATE_FILE = './data/daily-settle-state.json';
const TLSN_STATUS_FILE = './data/tlsn-output/latest/status.json';
const STARTUP_READY_FILE = './data/startup-ready.json';

type AgentModel = {
  id: string;
  name: string;
  owner: string;
  price: number;
  description: string;
  mode: 'random-demo' | 'external';
};

type EscrowOrder = {
  id: string;
  buyer: string;
  agentId: string;
  amount: number;
  promptHash: string;
  encryptedPrompt: string;
  status: 'FUNDED' | 'RELAYED' | 'SETTLED' | 'REFUNDED';
  paymentMethod: 'wallet';
  relayerFee: number;
  relayerOutputCommitment?: string;
  relayerOutputCiphertext?: string;
  revealedOutput?: string;
  createdAtUnixMs: number;
};

type UserBalance = {
  wallet: number;
  credits: number;
};

type UserPositions = Record<string, Record<string, number>>;
type OracleFreshnessState = 'fresh' | 'stale' | 'expired' | 'missing';
type PrivacyMode = 'zk_strong' | 'compat';
type PendingTxIntent = {
  id: string;
  type: 'market-bet' | 'payout-claim';
  marketKey: string;
  marketDate: string | null;
  walletPublicKey: string;
  positionKey: string;
  addTotalBet: number;
  addYesBet: number;
  userId: string;
  newLeaf: ReturnType<typeof serializeMarketLeaf> | null;
  newPositionLeaf: ReturnType<typeof serializePositionLeaf>;
  userNetPositionAfter: number;
  createdAtUnixMs: number;
};

type DemoDailyMarket = {
  marketDate: string;
  marketKey: string;
  thresholdF: number;
  lockedAtUnixMs: number;
  sourceDayIndexWhenLocked: number;
  sourceForecastHighFWhenLocked: number;
  totalPositionBet: number;
  totalYesPositionBet: number;
};

type DailySettlementInfo = {
  settled: boolean;
  observedHighF: number | null;
  settledAtUnixMs: number | null;
};

type OracleWorkerSyncPayload = {
  snapshot: WeatherSnapshot;
  tlsnStatus?: {
    stage: string;
    ok: boolean;
    ts: string;
    message?: string;
  } | null;
};

type DailyPayoutReadiness = {
  marketDate: string;
  settlement: DailySettlementInfo;
  totalPositionBet: number;
  totalYesPositionBet: number;
  winningSide: 'over' | 'under' | null;
  payoutReady: boolean;
  payoutMode: 'not-supported-on-current-contract' | 'no-bets' | 'pending-settlement';
};

type DailySettleState = {
  lastNightlyRunDate: string | null;
  lastNightlyRunAtUnixMs: number | null;
  lastNightlySettledDates: string[];
  lastAutoRunAtUnixMs: number | null;
  lastAutoRunSource: string | null;
  recentRuns: Array<{
    atUnixMs: number;
    source: string;
    settledDates: string[];
  }>;
};

type PrivateQueuedBet = {
  id: string;
  marketKey: string;
  marketDate: string | null;
  walletPublicKey: string;
  positionKey: string;
  ownerCommitment: string;
  addTotalBet: number;
  addYesBet: number;
  fundingTxHash: string | null;
  walletCommitment: string;
  createdAtUnixMs: number;
  leaseExpiryCount?: number;
  status: 'QUEUED';
};

type PrivateBatchHistoryEntry = {
  id: string;
  atUnixMs: number;
  marketKey: string | null;
  processed: number;
  totalPositionBetAdded: number;
  totalYesBetAdded: number;
  txHash: string | null;
  relayerReimbursedNanomina: string;
  status: 'success' | 'failed';
  error?: string;
};

type ResolvedWalletPosition = {
  positionKey: string;
  marketKey: string;
  marketDate: string | null;
  side: 'over' | 'under';
  stakeTmina: number;
  totalPotTmina: number;
  payoutTmina: number;
  resolvedOutcome: 'over' | 'under';
  won: boolean;
  claimed: boolean;
  claimStatus: 'claimable' | 'submitted' | 'confirmed' | 'not-applicable';
  claimTxHash: string | null;
  claimSubmittedAtUnixMs: number | null;
  claimConfirmedAtUnixMs: number | null;
};

// Agent plug-in surface:
// - register new agents via /api/agents/register
// - accept private prompts via /api/orders/create
// - let a relayer/model runner produce committed output via /api/orders/:id/relay-run
// - reveal and settle that output via /api/orders/:id/reveal-settle
// This keeps the market/oracle protocol reusable while allowing agents to supply private signals.
const agents: AgentModel[] = [
  {
    id: 'default-random-weather',
    name: 'Default Random Predictor',
    owner: 'protocol',
    price: 50,
    description: 'Demo model that outputs pseudo-random weather probabilities.',
    mode: 'random-demo'
  }
];
const orders: Record<string, EscrowOrder> = {};
const balances: Record<string, UserBalance> = {};
const pendingTxIntents: Record<string, PendingTxIntent> = {};
const privateBetQueue: PrivateQueuedBet[] = [];
const privateBatchHistory: PrivateBatchHistoryEntry[] = [];
let contractCompilePromise: Promise<unknown> | null = null;
let privateBatchInFlight = false;
let privateBatchLeaseStartedAtUnixMs: number | null = null;

function getPrivacyMode(): PrivacyMode {
  const mode = (process.env.PRIVACY_MODE || 'zk_strong').trim().toLowerCase();
  if (mode === 'compat') return 'compat';
  return 'zk_strong';
}

function getPrivateBatchIntervalMs(): number {
  const explicit = process.env.PRIVATE_BATCH_INTERVAL_MS;
  if (explicit !== undefined) {
    const parsed = Number.parseInt(explicit, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  // Do not run memory-heavy proving in the long-lived hosted web process by default.
  if (process.env.RENDER === 'true' || process.env.IS_RENDER === 'true') {
    return 0;
  }
  return 30000;
}

function getRelayerPrivateKey(): PrivateKey | null {
  const deployer = process.env.DEPLOYER_PRIVATE_KEY;
  const relayer = process.env.RELAYER_PRIVATE_KEY;
  // Deterministic default for this app: prefer deployer key unless explicitly absent.
  // This avoids signer drift between direct scripts and private batch processor.
  const base58 = deployer || relayer;
  if (!base58) return null;
  return PrivateKey.fromBase58(base58);
}

function getOptionalZkappPrivateKey(): PrivateKey | null {
  const base58 = process.env.ZKAPP_PRIVATE_KEY;
  if (!base58) return null;
  return PrivateKey.fromBase58(base58);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fieldFromHexDigest(hex: string, chars = 30): Field {
  return Field(BigInt(`0x${hex.slice(0, chars)}`));
}

function fieldFromIsoDate(dateIso: string): Field {
  return fieldFromHexDigest(sha256Hex(`date:${dateIso}`));
}

function getDemoBaseConfigHashField(): Field {
  return Field(process.env.DEMO_MARKET_BASE_CONFIG_HASH || '9301');
}

function deriveDemoDateMarketKey(dateIso: string): string {
  return deriveDateKeyedMarketKey(getDemoBaseConfigHashField(), fieldFromIsoDate(dateIso)).toString();
}

function marketDateFromViewTitle(title: string | undefined): string | null {
  if (!title) return null;
  const match = /^Atherton, CA - (\d{4}-\d{2}-\d{2}) Over\/Under \d+F$/.exec(title);
  return match ? match[1] : null;
}

function ownerCommitmentFromWalletPublicKey(walletPublicKey: string): Field {
  return Poseidon.hash(PublicKey.fromBase58(walletPublicKey).toFields());
}

function encodePrivatePayload(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodePrivatePayload(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function randomPredictionOutput(promptHash: string): string {
  const entropy = Number.parseInt(promptHash.slice(0, 8), 16);
  const predictedDailyHighF = 55 + (entropy % 31); // [55, 85]
  const p = Math.max(0, Math.min(1, (predictedDailyHighF - 55) / 30));
  return JSON.stringify({
    predicted_daily_high_f: predictedDailyHighF,
    probability_yes: p,
    probability_no: 1 - p,
    confidence: Math.min(0.95, 0.35 + p / 2),
    note: 'demo-random-int-55-85'
  });
}

function writeJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

function requireNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

async function refreshWeatherWithOptionalTlsn(inputAttestationPath?: string) {
  const strict = process.env.WEATHER_REQUIRE_TLSN === '1';
  const envAttestationPath = inputAttestationPath || process.env.WEATHER_TLSN_ATTESTATION_FILE;
  const attestationPath =
    envAttestationPath ||
    (existsSync(DEFAULT_TLSN_ATTESTATION_PATH) ? DEFAULT_TLSN_ATTESTATION_PATH : LEGACY_TLSN_ATTESTATION_PATH);
  const maxAgeMs = Number.parseInt(process.env.WEATHER_TLSN_MAX_AGE_MS || '3600000', 10);
  const shouldUseTlsn =
    strict ||
    Boolean(envAttestationPath) ||
    existsSync(DEFAULT_TLSN_ATTESTATION_PATH) ||
    existsSync(LEGACY_TLSN_ATTESTATION_PATH);

  if (shouldUseTlsn) {
    try {
      if (!attestationPath) {
        throw new Error('zkTLS weather mode requires attestation file (default: ./data/weather-attestation.json)');
      }
      const { attestation, report } = await verifyTlsnAttestationFile(attestationPath, {
        allowedServerName: NWS_94027_SERVER_NAME,
        allowedRequestPath: NWS_94027_REQUEST_PATH,
        maxAgeMs,
        maxFutureSkewMs: 0,
        strict,
        nowMs: Date.now()
      });
      const snapshot = snapshotFromTlsnAttestation(attestation, report, NWS_94027_STRICT_URL);
      await saveWeatherSnapshot(snapshot);
      return {
        snapshot,
        verification: report
      };
    } catch (error) {
      if (strict) {
        throw error;
      }
      const fallbackSnapshot = await fetchNws94027Snapshot(NWS_94027_STRICT_URL);
      await saveWeatherSnapshot(fallbackSnapshot);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        snapshot: fallbackSnapshot,
        verification: {
          verified: false,
          mode: 'insecure-direct-fetch',
          note: `TLS verify failed, used direct fetch fallback: ${reason}`
        }
      };
    }
  }

  const snapshot = await fetchNws94027Snapshot(NWS_94027_STRICT_URL);
  await saveWeatherSnapshot(snapshot);
  return {
    snapshot,
    verification: {
      verified: false,
      mode: 'insecure-direct-fetch',
      note: 'Set WEATHER_REQUIRE_TLSN=1 + WEATHER_TLSN_ATTESTATION_FILE for verified mode.'
    }
  };
}

function parseIntOrDefault(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getNetworkConfig() {
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const requestedNetworkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const isZekoTestnet = /testnet\.zeko\.io/i.test(graphql);
  const networkId = isZekoTestnet && requestedNetworkId === 'zeko' ? 'testnet' : requestedNetworkId;
  const txFee = process.env.TX_FEE || '1200000000';
  return { graphql, networkId, txFee };
}

async function ensureContractCompiled(): Promise<void> {
  if (!contractCompilePromise) {
    contractCompilePromise = PredictionMarketPlatform.compile();
  }
  await contractCompilePromise;
}

function setActiveZekoNetwork() {
  const { graphql, networkId } = getNetworkConfig();
  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);
}

function getZkappPublicKey(): PublicKey {
  const explicit = process.env.ZKAPP_PUBLIC_KEY;
  if (explicit && explicit.length > 0) return PublicKey.fromBase58(explicit);
  const zkappPriv = process.env.ZKAPP_PRIVATE_KEY;
  if (!zkappPriv) {
    throw new Error('Missing env ZKAPP_PUBLIC_KEY (or ZKAPP_PRIVATE_KEY as fallback)');
  }
  return PrivateKey.fromBase58(zkappPriv).toPublicKey();
}

function getOraclePolicy() {
  const strict = process.env.WEATHER_REQUIRE_TLSN === '1';
  const maxAgeMs = Number.parseInt(process.env.WEATHER_TLSN_MAX_AGE_MS || '7200000', 10);
  const staleAfterMs = Number.parseInt(process.env.WEATHER_ORACLE_STALE_MS || String(maxAgeMs), 10);
  const expiredAfterMs = Number.parseInt(
    process.env.WEATHER_ORACLE_EXPIRED_MS || String(Math.max(staleAfterMs * 2, staleAfterMs + 1)),
    10
  );
  return {
    strict,
    staleAfterMs,
    expiredAfterMs
  };
}

function isoDateOffset(baseDateIso: string, dayOffset: number): string {
  const dt = new Date(`${baseDateIso}T00:00:00.000-08:00`);
  const next = new Date(dt.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isoToUtcDate(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00.000Z`);
}

function daysDiff(fromIso: string, toIso: string): number {
  const from = isoToUtcDate(fromIso).getTime();
  const to = isoToUtcDate(toIso).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function contestStateFileForDate(marketDate: string): string {
  return `./data/weather-contest-94027-${marketDate}.json`;
}

function pacificHourMinute(unixMs: number): { hour: number; minute: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(unixMs));
  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return { hour, minute, date: `${year}-${month}-${day}` };
}

async function loadDailySettlementInfo(marketDate: string): Promise<DailySettlementInfo> {
  const contest = await loadContestState(marketDate, 15, contestStateFileForDate(marketDate));
  return {
    settled: Boolean(contest.settled),
    observedHighF: contest.settled?.observedHighF ?? null,
    settledAtUnixMs: contest.settled?.settledAtUnixMs ?? null
  };
}

async function withDailySettlementInfo<
  T extends {
    marketDate: string;
  }
>(markets: T[]): Promise<Array<T & { settlement: DailySettlementInfo }>> {
  return Promise.all(
    markets.map(async (market) => ({
      ...market,
      settlement: await loadDailySettlementInfo(market.marketDate)
    }))
  );
}

async function buildDailyPayoutReadiness(
  markets: Array<DemoDailyMarket & { settlement?: DailySettlementInfo }>
): Promise<DailyPayoutReadiness[]> {
  return Promise.all(
    markets.map(async (market) => {
      const settlement = market.settlement || (await loadDailySettlementInfo(market.marketDate));
      const total = Number.isFinite(market.totalPositionBet) ? market.totalPositionBet : 0;
      const yes = Number.isFinite(market.totalYesPositionBet) ? market.totalYesPositionBet : 0;
      const threshold = Math.round(market.thresholdF);
      const observed = settlement.observedHighF;
      const winningSide =
        settlement.settled && typeof observed === 'number'
          ? observed > threshold
            ? 'over'
            : 'under'
          : null;
      const payoutMode: DailyPayoutReadiness['payoutMode'] = !settlement.settled
        ? 'pending-settlement'
        : total <= 0
          ? 'no-bets'
          : 'not-supported-on-current-contract';
      return {
        marketDate: market.marketDate,
        settlement,
        totalPositionBet: total,
        totalYesPositionBet: yes,
        winningSide,
        payoutReady: settlement.settled && total > 0,
        payoutMode
      };
    })
  );
}

async function loadDailySettleState(filePath: string = DAILY_SETTLE_STATE_FILE): Promise<DailySettleState> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DailySettleState>;
    return {
      lastNightlyRunDate: typeof parsed.lastNightlyRunDate === 'string' ? parsed.lastNightlyRunDate : null,
      lastNightlyRunAtUnixMs:
        typeof parsed.lastNightlyRunAtUnixMs === 'number' && Number.isFinite(parsed.lastNightlyRunAtUnixMs)
          ? parsed.lastNightlyRunAtUnixMs
          : null,
      lastNightlySettledDates: Array.isArray(parsed.lastNightlySettledDates)
        ? parsed.lastNightlySettledDates.filter((v): v is string => typeof v === 'string')
        : [],
      lastAutoRunAtUnixMs:
        typeof parsed.lastAutoRunAtUnixMs === 'number' && Number.isFinite(parsed.lastAutoRunAtUnixMs)
          ? parsed.lastAutoRunAtUnixMs
          : null,
      lastAutoRunSource: typeof parsed.lastAutoRunSource === 'string' ? parsed.lastAutoRunSource : null,
      recentRuns: Array.isArray(parsed.recentRuns)
        ? parsed.recentRuns
            .filter(
              (v): v is { atUnixMs: number; source: string; settledDates: string[] } =>
                Boolean(v) &&
                typeof v === 'object' &&
                Number.isFinite((v as { atUnixMs?: number }).atUnixMs) &&
                typeof (v as { source?: string }).source === 'string' &&
                Array.isArray((v as { settledDates?: unknown[] }).settledDates)
            )
            .map((v) => ({
              atUnixMs: v.atUnixMs,
              source: v.source,
              settledDates: v.settledDates.filter((d): d is string => typeof d === 'string')
            }))
            .slice(0, 20)
        : []
    };
  } catch {
    return {
      lastNightlyRunDate: null,
      lastNightlyRunAtUnixMs: null,
      lastNightlySettledDates: [],
      lastAutoRunAtUnixMs: null,
      lastAutoRunSource: null,
      recentRuns: []
    };
  }
}

async function saveDailySettleState(
  state: DailySettleState,
  filePath: string = DAILY_SETTLE_STATE_FILE
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

async function recordDailySettleRun(
  current: DailySettleState,
  source: string,
  settledDates: string[]
): Promise<DailySettleState> {
  const next: DailySettleState = {
    ...current,
    lastAutoRunAtUnixMs: Date.now(),
    lastAutoRunSource: source,
    recentRuns: [
      {
        atUnixMs: Date.now(),
        source,
        settledDates
      },
      ...current.recentRuns
    ].slice(0, 20)
  };
  await saveDailySettleState(next);
  return next;
}

async function autoSettleDailyContestsFromSnapshot(
  snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>
): Promise<string[]> {
  if (!snapshot || snapshot.next24hHighF === null) return [];
  const settledDates: string[] = [];
  const daily = await loadDemoDailyMarkets();
  const todayIso = currentLocalDate();
  const nowHour = nowLocalHour();
  const nowUnixMs = Date.now();
  for (const marketDate of Object.keys(daily).sort()) {
    // Resolve passed dates, and resolve today's market after close-hour.
    const shouldSettle = marketDate < todayIso || (marketDate === todayIso && nowHour >= 19);
    if (!shouldSettle) continue;
    const fp = contestStateFileForDate(marketDate);
    let contest = await loadContestState(marketDate, 15, fp);
    if (contest.settled) continue;
    contest = settleContest(contest, snapshot.next24hHighF, nowUnixMs);
    await saveContestState(contest, fp);
    settledDates.push(marketDate);
  }
  return settledDates;
}

function mergeDemoDailyMarketsWithOnChainState(
  markets: Record<string, DemoDailyMarket>,
  state: Awaited<ReturnType<typeof loadOperatorState>>
): { merged: Record<string, DemoDailyMarket>; changed: boolean } {
  const derived = deriveDailyMarketsFromOnChainState(state);
  if (derived.length === 0) {
    return { merged: markets, changed: false };
  }
  const merged: Record<string, DemoDailyMarket> = { ...markets };
  let changed = false;
  for (const onChain of derived) {
    const existing = merged[onChain.marketDate];
    const next: DemoDailyMarket = {
      marketDate: onChain.marketDate,
      marketKey: onChain.marketKey,
      thresholdF: onChain.thresholdF,
      lockedAtUnixMs: existing?.lockedAtUnixMs ?? onChain.lockedAtUnixMs,
      sourceDayIndexWhenLocked: existing?.sourceDayIndexWhenLocked ?? onChain.sourceDayIndexWhenLocked,
      sourceForecastHighFWhenLocked: existing?.sourceForecastHighFWhenLocked ?? onChain.sourceForecastHighFWhenLocked,
      totalPositionBet: onChain.totalPositionBet,
      totalYesPositionBet: onChain.totalYesPositionBet
    };
    if (
      !existing ||
      existing.marketKey !== next.marketKey ||
      Math.round(existing.thresholdF) !== Math.round(next.thresholdF) ||
      Number(existing.totalPositionBet || 0) !== next.totalPositionBet ||
      Number(existing.totalYesPositionBet || 0) !== next.totalYesPositionBet
    ) {
      merged[onChain.marketDate] = next;
      changed = true;
    }
  }
  return { merged, changed };
}

async function loadDemoDailyMarkets(filePath: string = DEMO_DAILY_MARKETS_FILE): Promise<Record<string, DemoDailyMarket>> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = (JSON.parse(raw) as Record<string, DemoDailyMarket>) || {};
    try {
      const state = await loadOperatorState(process.env.STATE_FILE || DEFAULT_STATE_FILE);
      const { merged, changed } = mergeDemoDailyMarketsWithOnChainState(parsed, state);
      if (changed) {
        await saveDemoDailyMarkets(merged, filePath);
      }
      return merged;
    } catch {
      return parsed;
    }
  } catch {
    try {
      const state = await loadOperatorState(process.env.STATE_FILE || DEFAULT_STATE_FILE);
      const { merged } = mergeDemoDailyMarketsWithOnChainState({}, state);
      return merged;
    } catch {
      return {};
    }
  }
}

async function saveDemoDailyMarkets(
  markets: Record<string, DemoDailyMarket>,
  filePath: string = DEMO_DAILY_MARKETS_FILE
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(markets, null, 2), 'utf8');
}

async function loadPrivateBetQueue(filePath: string = PRIVATE_BET_QUEUE_FILE): Promise<PrivateQueuedBet[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PrivateQueuedBet[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((q) => q && typeof q.id === 'string' && q.status === 'QUEUED')
      .map((q) => ({
        ...q,
        leaseExpiryCount:
          typeof q.leaseExpiryCount === 'number' && Number.isFinite(q.leaseExpiryCount) && q.leaseExpiryCount >= 0
            ? Math.floor(q.leaseExpiryCount)
            : 0
      }));
  } catch {
    return [];
  }
}

async function savePrivateBetQueue(queue: PrivateQueuedBet[], filePath: string = PRIVATE_BET_QUEUE_FILE): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(queue, null, 2), 'utf8');
}

async function loadPrivateBatchHistory(filePath: string = PRIVATE_BATCH_HISTORY_FILE): Promise<PrivateBatchHistoryEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PrivateBatchHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadTlsnStatus(
  filePath: string = TLSN_STATUS_FILE
): Promise<{ stage: string; ok: boolean; ts: string; message?: string } | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { stage?: string; ok?: boolean; ts?: string; message?: string };
    if (typeof parsed.stage !== 'string' || typeof parsed.ok !== 'boolean' || typeof parsed.ts !== 'string') {
      return null;
    }
    return {
      stage: parsed.stage,
      ok: parsed.ok,
      ts: parsed.ts,
      message: typeof parsed.message === 'string' ? parsed.message : undefined
    };
  } catch {
    return null;
  }
}

async function saveTlsnStatus(
  status: { stage: string; ok: boolean; ts: string; message?: string } | null,
  filePath: string = TLSN_STATUS_FILE
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!status) {
    try {
      await writeFile(filePath, '', 'utf8');
    } catch {
      // ignore
    }
    return;
  }
  await writeFile(filePath, JSON.stringify(status, null, 2), 'utf8');
}

function normalizeTlsnStatus(
  snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>,
  tlsnStatus: Awaited<ReturnType<typeof loadTlsnStatus>>
) {
  if (
    snapshot &&
    snapshot.verified &&
    snapshot.verificationMode === 'zktls' &&
    tlsnStatus &&
    Number.isFinite(Date.parse(tlsnStatus.ts)) &&
    snapshot.fetchedAtUnixMs >= Date.parse(tlsnStatus.ts)
  ) {
    return {
      stage: 'done',
      ok: true,
      ts: new Date(snapshot.fetchedAtUnixMs).toISOString(),
      message: 'latest zkTLS snapshot verified'
    };
  }
  return tlsnStatus;
}

function parseOracleWorkerSyncPayload(body: Record<string, unknown>): OracleWorkerSyncPayload {
  const snapshot = body.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('snapshot must be provided');
  }
  const candidate = snapshot as Record<string, unknown>;
  if (typeof candidate.sourceUrl !== 'string') throw new Error('snapshot.sourceUrl must be a string');
  if (typeof candidate.fetchedAtUnixMs !== 'number' || !Number.isFinite(candidate.fetchedAtUnixMs)) {
    throw new Error('snapshot.fetchedAtUnixMs must be a finite number');
  }
  if (typeof candidate.localDate !== 'string') throw new Error('snapshot.localDate must be a string');
  if (typeof candidate.timezone !== 'string') throw new Error('snapshot.timezone must be a string');
  if (!Array.isArray(candidate.hourlyTempsF) || !Array.isArray(candidate.dailyHighsF)) {
    throw new Error('snapshot.hourlyTempsF and snapshot.dailyHighsF must be arrays');
  }
  if (typeof candidate.verified !== 'boolean') throw new Error('snapshot.verified must be a boolean');
  if (candidate.verificationMode !== 'zktls' && candidate.verificationMode !== 'insecure-direct-fetch') {
    throw new Error('snapshot.verificationMode must be zktls or insecure-direct-fetch');
  }
  const parsedSnapshot = candidate as WeatherSnapshot;
  const tlsnStatusRaw = body.tlsnStatus;
  const tlsnStatus =
    tlsnStatusRaw && typeof tlsnStatusRaw === 'object'
      ? {
          stage: requireString((tlsnStatusRaw as Record<string, unknown>).stage, 'tlsnStatus.stage'),
          ok: Boolean((tlsnStatusRaw as Record<string, unknown>).ok),
          ts: requireString((tlsnStatusRaw as Record<string, unknown>).ts, 'tlsnStatus.ts'),
          message:
            typeof (tlsnStatusRaw as Record<string, unknown>).message === 'string'
              ? String((tlsnStatusRaw as Record<string, unknown>).message)
              : undefined
        }
      : null;
  return { snapshot: parsedSnapshot, tlsnStatus };
}

async function loadDisplayWeatherSnapshot(): Promise<Awaited<ReturnType<typeof loadWeatherSnapshot>>> {
  const snapshot = await loadWeatherSnapshot();
  if (snapshot) return snapshot;
  try {
    return await fetchNws94027Snapshot(NWS_94027_STRICT_URL);
  } catch {
    return null;
  }
}

async function readStartupReadyState(): Promise<{ ready: boolean; reason: string }> {
  try {
    const raw = await readFile(STARTUP_READY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { ready?: unknown; reason?: unknown };
    return {
      ready: parsed.ready === true,
      reason: typeof parsed.reason === 'string' && parsed.reason.length > 0 ? parsed.reason : 'starting'
    };
  } catch {
    return {
      ready: process.env.SYNC_STATE_ON_START !== '1',
      reason: process.env.SYNC_STATE_ON_START === '1' ? 'waiting for startup-ready marker' : 'startup sync not requested'
    };
  }
}

async function savePrivateBatchHistory(
  entries: PrivateBatchHistoryEntry[],
  filePath: string = PRIVATE_BATCH_HISTORY_FILE
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

async function appendPrivateBatchHistory(entry: PrivateBatchHistoryEntry): Promise<void> {
  privateBatchHistory.unshift(entry);
  if (privateBatchHistory.length > 200) privateBatchHistory.length = 200;
  await savePrivateBatchHistory(privateBatchHistory);
}

async function recordPrivateBatchFailure(error: unknown, marketKey: string | null = privateBetQueue[0]?.marketKey || null) {
  await appendPrivateBatchHistory({
    id: randomUUID(),
    atUnixMs: Date.now(),
    marketKey,
    processed: 0,
    totalPositionBetAdded: 0,
    totalYesBetAdded: 0,
    txHash: null,
    relayerReimbursedNanomina: '0',
    status: 'failed',
    error: error instanceof Error ? error.message : String(error)
  });
}

function getPrivateBatchLeaseTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.PRIVATE_BATCH_LEASE_TIMEOUT_MS || '180000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180000;
}

function getPrivateBatchMaxLeaseExpiries(): number {
  const parsed = Number.parseInt(process.env.PRIVATE_BATCH_MAX_LEASE_EXPIRIES || '3', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

async function releaseExpiredPrivateBatchLease(nowUnixMs: number = Date.now()): Promise<boolean> {
  if (!privateBatchInFlight || privateBatchLeaseStartedAtUnixMs === null) return false;
  if (nowUnixMs - privateBatchLeaseStartedAtUnixMs < getPrivateBatchLeaseTimeoutMs()) return false;
  const first = privateBetQueue[0] || null;
  const nextLeaseExpiryCount = Math.max(0, Number(first?.leaseExpiryCount || 0)) + 1;
  console.warn(
    `[private-batch] releasing stale lease age_ms=${nowUnixMs - privateBatchLeaseStartedAtUnixMs} queueDepth=${privateBetQueue.length} lease_expiry_count=${nextLeaseExpiryCount}`
  );
  if (first) {
    first.leaseExpiryCount = nextLeaseExpiryCount;
    if (nextLeaseExpiryCount >= getPrivateBatchMaxLeaseExpiries()) {
      await recordPrivateBatchFailure(
        `stale lease exceeded ${nextLeaseExpiryCount} expiries; quarantined after repeated worker restarts`,
        first.marketKey
      );
      privateBetQueue.shift();
      await savePrivateBetQueue(privateBetQueue);
      console.error(
        `[private-batch] dropped stuck queue head id=${first.id} marketDate=${first.marketDate || 'unknown'} after repeated stale leases`
      );
    } else {
      await savePrivateBetQueue(privateBetQueue);
    }
  }
  privateBatchInFlight = false;
  privateBatchLeaseStartedAtUnixMs = null;
  return true;
}

function findSelectedOnChainMarket(
  state: Awaited<ReturnType<typeof loadOperatorState>>,
  marketKey: string,
  marketDate: string | null
) {
  const views = toMarketViews(state, 0);
  return (
    views.find((m) => String(m.marketKey) === String(marketKey)) ||
    (marketDate
      ? views.find((m) => marketDateFromViewTitle(m.title) === marketDate && !m.resolved) ||
        views.find((m) => marketDateFromViewTitle(m.title) === marketDate)
      : null) ||
    null
  );
}

async function applySuccessfulPrivateBetBatch(params: {
  stateFile: string;
  queuedBet: PrivateQueuedBet;
  txHash: string | null;
  relayerReimbursedNanomina: string;
}) {
  const { stateFile, queuedBet, txHash, relayerReimbursedNanomina } = params;
  const state = await loadOperatorState(stateFile);
  const existing = state.markets[queuedBet.marketKey];
  if (!existing) throw new Error(`market ${queuedBet.marketKey} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('cannot apply private batch on resolved market');

  const newLeaf = new MarketLeaf({
    configHash: oldLeaf.configHash,
    closeSlot: oldLeaf.closeSlot,
    expirySlot: oldLeaf.expirySlot,
    thresholdValueTenthC: oldLeaf.thresholdValueTenthC,
    totalPositionBet: oldLeaf.totalPositionBet.add(UInt64.from(queuedBet.addTotalBet)),
    totalYesPositionBet: oldLeaf.totalYesPositionBet.add(UInt64.from(queuedBet.addYesBet)),
    resolved: Bool(false),
    outcome: Bool(false),
    oracleStatementHash: Field(0)
  });
  newLeaf.totalYesPositionBet.lessThanOrEqual(newLeaf.totalPositionBet).assertTrue();

  const positionKey = queuedBet.positionKey;
  if (state.positions[positionKey]) {
    throw new Error(`position ${positionKey} already exists in state file`);
  }
  const positionLeaf = new PositionLeaf({
    marketKey: Field(queuedBet.marketKey),
    sideOver: Bool(queuedBet.addYesBet === queuedBet.addTotalBet),
    stake: UInt64.from(queuedBet.addTotalBet),
    ownerCommitment: Field(queuedBet.ownerCommitment),
    claimed: Bool(false)
  });

  state.markets[queuedBet.marketKey] = serializeMarketLeaf(newLeaf);
  state.positions[positionKey] = serializePositionLeaf(positionLeaf);
  state.positionMeta = state.positionMeta || {};
  state.positionMeta[positionKey] = {
    marketKey: queuedBet.marketKey,
    marketDate: queuedBet.marketDate,
    walletPublicKey: queuedBet.walletPublicKey,
    ownerCommitment: queuedBet.ownerCommitment,
    createdAtUnixMs: queuedBet.createdAtUnixMs,
    fundingTxHash: queuedBet.fundingTxHash
  };
  await saveOperatorState(stateFile, state);

  const positions = await loadUserPositions(USER_POSITIONS_FILE);
  positions[queuedBet.walletPublicKey] = positions[queuedBet.walletPublicKey] || {};
  const prior = positions[queuedBet.walletPublicKey][queuedBet.marketKey] || 0;
  positions[queuedBet.walletPublicKey][queuedBet.marketKey] =
    prior + positionDelta(queuedBet.addTotalBet, queuedBet.addYesBet);
  await saveUserPositions(USER_POSITIONS_FILE, positions);

  const dailyMarketMap = await loadDemoDailyMarkets();
  if (queuedBet.marketDate) {
    const day = dailyMarketMap[queuedBet.marketDate];
    if (day) {
      day.totalPositionBet = (Number.isFinite(day.totalPositionBet) ? day.totalPositionBet : 0) + queuedBet.addTotalBet;
      day.totalYesPositionBet =
        (Number.isFinite(day.totalYesPositionBet) ? day.totalYesPositionBet : 0) + queuedBet.addYesBet;
      dailyMarketMap[queuedBet.marketDate] = day;
    }
  }
  await saveDemoDailyMarkets(dailyMarketMap);

  const idx = privateBetQueue.findIndex((q) => q.id === queuedBet.id);
  if (idx >= 0) privateBetQueue.splice(idx, 1);
  await savePrivateBetQueue(privateBetQueue);

  const successResult = {
    processed: 1,
    txHash,
    marketKey: queuedBet.marketKey,
    marketDate: queuedBet.marketDate,
    totalPositionBetAdded: queuedBet.addTotalBet,
    totalYesBetAdded: queuedBet.addYesBet,
    relayerReimbursedNanomina
  };
  await appendPrivateBatchHistory({
    id: randomUUID(),
    atUnixMs: Date.now(),
    marketKey: queuedBet.marketKey,
    processed: 1,
    totalPositionBetAdded: queuedBet.addTotalBet,
    totalYesBetAdded: queuedBet.addYesBet,
    txHash,
    relayerReimbursedNanomina,
    status: 'success'
  });
  return successResult;
}

async function ensureDemoDailyMarketsFromSnapshot(
  snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>,
  filePath: string = DEMO_DAILY_MARKETS_FILE
): Promise<DemoDailyMarket[]> {
  const existing = await loadDemoDailyMarkets(filePath);
  const todayIso = currentLocalDate();
  const maxWindowDate = isoDateOffset(todayIso, 5);
  const trimmed: Record<string, DemoDailyMarket> = {};
  for (const [marketDate, market] of Object.entries(existing)) {
    if (marketDate >= todayIso && marketDate <= maxWindowDate) {
      trimmed[marketDate] = {
        ...market,
        marketKey: typeof market.marketKey === 'string' && market.marketKey.length > 0 ? market.marketKey : deriveDemoDateMarketKey(marketDate)
      };
    }
  }
  if (snapshot) {
    snapshot.dailyHighsF.slice(0, 6).forEach((high, dayIndex) => {
      const marketDate = isoDateOffset(snapshot.localDate, dayIndex);
      if (!trimmed[marketDate]) {
        trimmed[marketDate] = {
          marketDate,
          marketKey: deriveDemoDateMarketKey(marketDate),
          thresholdF: Math.round(high),
          lockedAtUnixMs: Date.now(),
          sourceDayIndexWhenLocked: dayIndex,
          sourceForecastHighFWhenLocked: high,
          totalPositionBet: 0,
          totalYesPositionBet: 0
        };
      }
    });
  }
  await saveDemoDailyMarkets(trimmed, filePath);
  return Object.values(trimmed)
    .map((m) => ({
      ...m,
      marketKey: typeof m.marketKey === 'string' && m.marketKey.length > 0 ? m.marketKey : deriveDemoDateMarketKey(m.marketDate),
      totalPositionBet: Number.isFinite(m.totalPositionBet) ? m.totalPositionBet : 0,
      totalYesPositionBet: Number.isFinite(m.totalYesPositionBet) ? m.totalYesPositionBet : 0
    }))
    .sort((a, b) => (a.marketDate < b.marketDate ? -1 : a.marketDate > b.marketDate ? 1 : 0));
}

function withCurrentForecast(
  markets: DemoDailyMarket[],
  snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>
): Array<
  DemoDailyMarket & {
    currentForecastHighF: number | null;
    pOverThreshold: number;
    pAtOrBelowThreshold: number;
    currentDayIndex: number | null;
  }
> {
  if (!snapshot) {
    return markets.map((m) => ({
      ...m,
      currentForecastHighF: null,
      pOverThreshold: 0.5,
      pAtOrBelowThreshold: 0.5,
      currentDayIndex: null
    }));
  }

  return markets.map((m) => {
    const idx = daysDiff(snapshot.localDate, m.marketDate);
    if (idx < 0 || idx >= snapshot.dailyHighsF.length) {
      return {
        ...m,
        currentForecastHighF: null,
        pOverThreshold: 0.5,
        pAtOrBelowThreshold: 0.5,
        currentDayIndex: null
      };
    }
    const probs = buildSevenDayHighProbabilities(snapshot.dailyHighsF, m.thresholdF);
    const point = probs[idx];
    const high = snapshot.dailyHighsF[idx] ?? null;
    const dayTotal = Number.isFinite(m.totalPositionBet) ? m.totalPositionBet : 0;
    const dayYes = Number.isFinite(m.totalYesPositionBet) ? m.totalYesPositionBet : 0;
    const marketYes = dayTotal > 0 ? Math.max(0, Math.min(1, dayYes / dayTotal)) : null;
    return {
      ...m,
      currentForecastHighF: high,
      pOverThreshold: marketYes ?? (point ? point.pHighAboveThreshold : 0.5),
      pAtOrBelowThreshold: marketYes === null ? (point ? point.pHighAtOrBelowThreshold : 0.5) : 1 - marketYes,
      currentDayIndex: idx
    };
  });
}

function getOracleFreshness(snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>, nowMs: number): {
  state: OracleFreshnessState;
  ageMs: number | null;
  reason: string;
} {
  const policy = getOraclePolicy();
  if (!snapshot) {
    return { state: 'missing', ageMs: null, reason: 'no weather snapshot available' };
  }
  if (policy.strict && (!snapshot.verified || snapshot.verificationMode !== 'zktls')) {
    return { state: 'expired', ageMs: null, reason: 'strict mode requires zkTLS-verified snapshot before settlement' };
  }
  const ageMs = nowMs - snapshot.fetchedAtUnixMs;
  if (ageMs <= policy.staleAfterMs) {
    return { state: 'fresh', ageMs, reason: 'within freshness window' };
  }
  if (ageMs <= policy.expiredAfterMs) {
    return { state: 'stale', ageMs, reason: 'snapshot is aging; refresh oracle for safe settlement' };
  }
  return { state: 'expired', ageMs, reason: 'snapshot too old; settlement blocked until oracle refresh' };
}

function toMarketViews(state: Awaited<ReturnType<typeof loadOperatorState>>, currentSlot: number) {
  let demoDailyByMarketKey: Record<string, DemoDailyMarket> = {};
  try {
    const raw = readFileSync(DEMO_DAILY_MARKETS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, DemoDailyMarket>;
    demoDailyByMarketKey = Object.fromEntries(
      Object.values(parsed || {})
        .filter((market) => market && typeof market.marketKey === 'string')
        .map((market) => [String(market.marketKey), market])
    );
  } catch {
    demoDailyByMarketKey = {};
  }
  return Object.entries(state.markets).map(([marketKey, leaf]) => {
    const total = Number(leaf.totalPositionBet);
    const yes = Number(leaf.totalYesPositionBet);
    const impliedProbability = total > 0 ? yes / total : 0.5;
    const thresholdValueTenthC = Number(leaf.thresholdValueTenthC);
    const thresholdF = Math.round(((thresholdValueTenthC / 10) * 9) / 5 + 32);
    const meta = state.marketMeta?.[marketKey];
    const fallbackDemoDaily = demoDailyByMarketKey[String(marketKey)];
    const closeSlot = Number(leaf.closeSlot);
    const expirySlot = Number(leaf.expirySlot);
    const determinationSlot = Number(meta?.determinationSlot || leaf.expirySlot);
    const defaultTitle = fallbackDemoDaily
      ? `Atherton, CA - ${fallbackDemoDaily.marketDate} Over/Under ${fallbackDemoDaily.thresholdF}F`
      : marketKey === '1002'
        ? 'Atherton, CA - Temp Market'
        : `Market ${marketKey}`;
    const defaultSource =
      fallbackDemoDaily || marketKey === '1002'
        ? 'https://api.weather.gov/gridpoints/MTR/86,107/forecast'
        : 'unknown';
    return {
      marketKey,
      title: meta?.title || defaultTitle,
      rulesPrimary:
        meta?.rulesPrimary ||
        (fallbackDemoDaily
          ? `Resolves OVER if observed daily high on ${fallbackDemoDaily.marketDate} is greater than locked threshold ${fallbackDemoDaily.thresholdF}F.`
          : 'Will observed weather value be greater than threshold at determination time?'),
      settlementSource: meta?.settlementSource || defaultSource,
      closeSlot,
      expirySlot,
      determinationSlot,
      thresholdValueTenthC,
      thresholdF,
      totalPositionBet: total,
      totalYesPositionBet: yes,
      impliedProbability,
      resolved: leaf.resolved === '1',
      outcome: Number(leaf.outcome),
      createdAtUnixMs: meta?.createdAtUnixMs || 0,
      timeToExpirySlots: expirySlot - currentSlot
    };
  });
}

function resolvePrimaryMarketThresholdF(state: Awaited<ReturnType<typeof loadOperatorState>>): number {
  const views = toMarketViews(state, 0);
  const preferred = views.find((m) => !m.resolved) || views.find((m) => m.marketKey === '1002') || views[0];
  if (!preferred) return 68;
  return Number.isFinite(preferred.thresholdF) ? preferred.thresholdF : 68;
}

function attachOnChainDailyMarketState(
  dailyMarkets: Array<DemoDailyMarket & { settlement?: DailySettlementInfo; currentForecastHighF?: number | null; pOverThreshold?: number; pAtOrBelowThreshold?: number; currentDayIndex?: number | null }>,
  state: Awaited<ReturnType<typeof loadOperatorState>>,
  pendingPrivateByDate: Record<string, { totalPositionBet: number; totalYesPositionBet: number }> = {}
) {
  const viewList = toMarketViews(state, 0);
  const viewsByKey = new Map(viewList.map((m) => [String(m.marketKey), m]));
  const viewsByDate = new Map(
    viewList
      .map((m) => [marketDateFromViewTitle(m.title), m] as const)
      .filter((entry): entry is [string, (typeof viewList)[number]] => Boolean(entry[0]))
  );
  return dailyMarkets.map((market) => {
    const onChain = viewsByKey.get(String(market.marketKey)) || viewsByDate.get(market.marketDate) || null;
    const pending = pendingPrivateByDate[market.marketDate] || { totalPositionBet: 0, totalYesPositionBet: 0 };
    const basePoolTmina = onChain ? Number(onChain.totalPositionBet) : market.totalPositionBet;
    const baseOverTmina = onChain ? Number(onChain.totalYesPositionBet) : market.totalYesPositionBet;
    const projectedPoolTmina = basePoolTmina + pending.totalPositionBet;
    const projectedOverTmina = baseOverTmina + pending.totalYesPositionBet;
    return {
      ...market,
      marketKey: onChain ? String(onChain.marketKey) : market.marketKey,
      thresholdF: onChain ? Number(onChain.thresholdF) : market.thresholdF,
      totalPositionBet: basePoolTmina,
      totalYesPositionBet: baseOverTmina,
      onChainCreated: Boolean(onChain),
      onChainResolved: onChain ? Boolean(onChain.resolved) : false,
      onChainPoolTmina: onChain ? Number(onChain.totalPositionBet) : 0,
      onChainOverTmina: onChain ? Number(onChain.totalYesPositionBet) : 0,
      pendingPrivatePoolTmina: pending.totalPositionBet,
      pendingPrivateOverTmina: pending.totalYesPositionBet,
      projectedPoolTmina,
      projectedOverTmina
    };
  });
}

function summarizePendingPrivateBetsByDate() {
  const byDate: Record<string, { totalPositionBet: number; totalYesPositionBet: number }> = {};
  for (const bet of privateBetQueue) {
    if (!bet.marketDate) continue;
    const current = byDate[bet.marketDate] || { totalPositionBet: 0, totalYesPositionBet: 0 };
    current.totalPositionBet += Number.isFinite(bet.addTotalBet) ? bet.addTotalBet : 0;
    current.totalYesPositionBet += Number.isFinite(bet.addYesBet) ? bet.addYesBet : 0;
    byDate[bet.marketDate] = current;
  }
  return byDate;
}

function deriveDailyMarketsFromOnChainState(
  state: Awaited<ReturnType<typeof loadOperatorState>>
): DemoDailyMarket[] {
  const views = toMarketViews(state, 0);
  return views
    .map((market) => {
      const match = /^Atherton, CA - (\d{4}-\d{2}-\d{2}) Over\/Under (\d+)F$/.exec(market.title || '');
      if (!match) return null;
      return {
        marketDate: match[1],
        marketKey: String(market.marketKey),
        thresholdF: Number(match[2]),
        lockedAtUnixMs: Number.isFinite(market.createdAtUnixMs) ? Number(market.createdAtUnixMs) : 0,
        sourceDayIndexWhenLocked: 0,
        sourceForecastHighFWhenLocked: Number(match[2]),
        totalPositionBet: Number.isFinite(Number(market.totalPositionBet)) ? Number(market.totalPositionBet) : 0,
        totalYesPositionBet: Number.isFinite(Number(market.totalYesPositionBet)) ? Number(market.totalYesPositionBet) : 0
      } satisfies DemoDailyMarket;
    })
    .filter((market): market is DemoDailyMarket => Boolean(market))
    .sort((a, b) => (a.marketDate < b.marketDate ? -1 : a.marketDate > b.marketDate ? 1 : 0));
}

async function runProjectCommand(projectRoot: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('pnpm', args, {
    cwd: projectRoot,
    env: process.env
  });
  return `${stdout}\n${stderr}`.trim();
}

async function refreshState(projectRoot: string): Promise<void> {
  await runProjectCommand(projectRoot, ['sync-state:zeko', '--', '--state-file', './data/operator-state.json']);
}

function getOperatorActionToken(): string | null {
  const raw = process.env.OPERATOR_ACTION_TOKEN;
  if (!raw) return null;
  const token = raw.trim();
  return token.length > 0 ? token : null;
}

function requireOperatorAuthorization(req: IncomingMessage, body: Record<string, unknown> | null): void {
  const expected = getOperatorActionToken();
  if (!expected) {
    throw new Error('operator actions disabled: set OPERATOR_ACTION_TOKEN');
  }
  const headerToken = req.headers['x-operator-token'];
  const supplied =
    (typeof headerToken === 'string' ? headerToken : Array.isArray(headerToken) ? headerToken[0] : null) ||
    (body && typeof body.operatorToken === 'string' ? body.operatorToken : null);
  if (!supplied || supplied !== expected) {
    throw new Error('operator authorization failed');
  }
}

async function loadUserPositions(filePath: string): Promise<UserPositions> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as UserPositions;
    return parsed || {};
  } catch {
    return {};
  }
}

async function saveUserPositions(filePath: string, positions: UserPositions): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(positions, null, 2), 'utf8');
}

function positionDelta(addTotalBet: number, addYesBet: number): number {
  const noBet = addTotalBet - addYesBet;
  return addYesBet - noBet;
}

function winningPoolNanomina(totalPositionBet: bigint, totalYesPositionBet: bigint, outcomeOver: boolean): bigint {
  return outcomeOver ? totalYesPositionBet : totalPositionBet - totalYesPositionBet;
}

function payoutNanominaForStake(totalPositionBet: bigint, totalYesPositionBet: bigint, outcomeOver: boolean, stake: bigint): bigint {
  const pool = winningPoolNanomina(totalPositionBet, totalYesPositionBet, outcomeOver);
  if (pool <= 0n) return 0n;
  return (totalPositionBet * stake) / pool;
}

async function listResolvedWalletPositions(
  walletPublicKey: string,
  stateFile: string
): Promise<ResolvedWalletPosition[]> {
  const state = await reconcileSubmittedPayoutClaims(stateFile);
  const ownerCommitment = ownerCommitmentFromWalletPublicKey(walletPublicKey).toString();
  const result: ResolvedWalletPosition[] = [];
  for (const [positionKey, storedPosition] of Object.entries(state.positions || {})) {
    const meta = state.positionMeta?.[positionKey];
    const positionLeaf = deserializePositionLeaf(storedPosition);
    const metaMatchesWallet = Boolean(meta && meta.walletPublicKey === walletPublicKey);
    const leafMatchesWallet = positionLeaf.ownerCommitment.toString() === ownerCommitment;
    if (!metaMatchesWallet && !leafMatchesWallet) continue;
    const marketKey = meta?.marketKey || positionLeaf.marketKey.toString();
    const storedMarket = state.markets[marketKey];
    if (!storedMarket) continue;
    const marketLeaf = deserializeMarketLeaf(storedMarket);
    if (!marketLeaf.resolved.toBoolean()) continue;
    const resolvedOutcome = marketLeaf.outcome.toBoolean() ? 'over' : 'under';
    const side = positionLeaf.sideOver.toBoolean() ? 'over' : 'under';
    const totalPot = BigInt(marketLeaf.totalPositionBet.toString());
    const totalYes = BigInt(marketLeaf.totalYesPositionBet.toString());
    const stake = BigInt(positionLeaf.stake.toString());
    const won = side === resolvedOutcome;
    const payout = won ? payoutNanominaForStake(totalPot, totalYes, marketLeaf.outcome.toBoolean(), stake) : 0n;
    result.push({
      positionKey,
      marketKey,
      marketDate: meta?.marketDate || null,
      side,
      stakeTmina: Number(stake),
      totalPotTmina: Number(totalPot),
      payoutTmina: Number(payout),
      resolvedOutcome,
      won,
      claimed: positionLeaf.claimed.toBoolean(),
      claimStatus: won
        ? positionLeaf.claimed.toBoolean()
          ? 'confirmed'
          : meta?.claimStatus === 'submitted'
            ? 'submitted'
            : 'claimable'
        : 'not-applicable',
      claimTxHash: meta?.claimTxHash || null,
      claimSubmittedAtUnixMs: meta?.claimSubmittedAtUnixMs || null,
      claimConfirmedAtUnixMs: meta?.claimConfirmedAtUnixMs || null
    });
  }
  return result.sort((a, b) => {
    const ad = a.marketDate || '';
    const bd = b.marketDate || '';
    return ad < bd ? 1 : ad > bd ? -1 : 0;
  });
}

function markPositionClaimConfirmed(state: Awaited<ReturnType<typeof loadOperatorState>>, positionKey: string, confirmedAtUnixMs: number) {
  const existingPosition = state.positions[positionKey];
  if (!existingPosition) return false;
  const existingLeaf = deserializePositionLeaf(existingPosition);
  if (!existingLeaf.claimed.toBoolean()) {
    const claimedLeaf = new PositionLeaf({
      marketKey: existingLeaf.marketKey,
      sideOver: existingLeaf.sideOver,
      stake: existingLeaf.stake,
      ownerCommitment: existingLeaf.ownerCommitment,
      claimed: Bool(true)
    });
    state.positions[positionKey] = serializePositionLeaf(claimedLeaf);
  }
  state.positionMeta = state.positionMeta || {};
  const meta = state.positionMeta[positionKey];
  if (meta) {
    meta.claimStatus = 'confirmed';
    meta.claimConfirmedAtUnixMs = confirmedAtUnixMs;
  }
  return true;
}

async function reconcileSubmittedPayoutClaims(stateFile: string) {
  setActiveZekoNetwork();
  const state = await loadOperatorState(stateFile);
  const pendingClaims = Object.entries(state.positionMeta || {}).filter(([, meta]) => {
    return Boolean(meta?.claimStatus === 'submitted' && meta?.claimTxHash);
  });
  if (!pendingClaims.length) return state;
  const { graphql } = getNetworkConfig();
  let dirty = false;
  for (const [positionKey, meta] of pendingClaims) {
    if (!meta?.claimTxHash) continue;
    try {
      const status = await fetchTransactionStatus(meta.claimTxHash, graphql);
      if (status === 'INCLUDED') {
        dirty = markPositionClaimConfirmed(state, positionKey, Date.now()) || dirty;
      }
    } catch {
      // Leave claim pending if status cannot be fetched yet.
    }
  }
  if (dirty) {
    await saveOperatorState(stateFile, state);
  }
  return state;
}

async function buildWalletFeePayerMarketBetTx(params: {
  stateFile: string;
  marketKey: string;
  addTotalBet: number;
  addYesBet: number;
  marketDate: string | null;
  feePayerPublicKey: string;
  userId: string;
}): Promise<{
  tx: unknown;
  fee: string;
  intent: PendingTxIntent;
  marketSummary: { totalPositionBet: string; totalYesPositionBet: string };
}> {
  const { stateFile, marketKey, addTotalBet, addYesBet, marketDate, feePayerPublicKey, userId } = params;
  if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');

  setActiveZekoNetwork();
  await ensureContractCompiled();
  const feePayer = PublicKey.fromBase58(feePayerPublicKey);
  const { txFee } = getNetworkConfig();
  const zkappAddress = getZkappPublicKey();
  const account = await fetchAccount({ publicKey: feePayer });
  if (account.error) throw new Error(`fee payer account not found: ${account.error.statusText || 'unknown'}`);

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  const existing = state.markets[marketKey];
  if (!existing) throw new Error(`market ${marketKey} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('cannot trade a resolved market');
  if (!(addYesBet === 0 || addYesBet === addTotalBet)) {
    throw new Error('claimable payout path requires binary over/under stake; addYesBet must be 0 or equal addTotalBet');
  }

  const newLeaf = new MarketLeaf({
    configHash: oldLeaf.configHash,
    closeSlot: oldLeaf.closeSlot,
    expirySlot: oldLeaf.expirySlot,
    thresholdValueTenthC: oldLeaf.thresholdValueTenthC,
    totalPositionBet: oldLeaf.totalPositionBet.add(UInt64.from(addTotalBet)),
    totalYesPositionBet: oldLeaf.totalYesPositionBet.add(UInt64.from(addYesBet)),
    resolved: Bool(false),
    outcome: Bool(false),
    oracleStatementHash: Field(0)
  });
  newLeaf.totalYesPositionBet.lessThanOrEqual(newLeaf.totalPositionBet).assertTrue();

  const marketFieldKey = Field(marketKey);
  const marketsMap = buildMarketsMerkleMap(state);
  const positionsMap = buildPositionsMerkleMap(state);
  const intentId = randomUUID();
  const positionKey = fieldFromHexDigest(
    sha256Hex(`${feePayerPublicKey}:${marketKey}:${marketDate || ''}:${intentId}:${Date.now()}`)
  );
  if (state.positions[positionKey.toString()]) {
    throw new Error('position key collision; retry transaction build');
  }
  const positionLeaf = new PositionLeaf({
    marketKey: marketFieldKey,
    sideOver: Bool(addYesBet === addTotalBet),
    stake: UInt64.from(addTotalBet),
    ownerCommitment: ownerCommitmentFromWalletPublicKey(feePayerPublicKey),
    claimed: Bool(false)
  });

  const zkapp = new PredictionMarketPlatform(zkappAddress);
  const betAmountNanomina = BigInt(addTotalBet) * 1_000_000_000n;
  const tx = await Mina.transaction({ sender: feePayer, fee: txFee }, async () => {
    // Escrow bet principal on-chain: transfer user bet amount into the zkApp account.
    const bettorPayment = AccountUpdate.createSigned(feePayer);
    bettorPayment.send({
      to: zkappAddress,
      amount: UInt64.from(betAmountNanomina)
    });
    zkapp.placeClaimableBet(
      marketFieldKey,
      oldLeaf,
      newLeaf,
      marketsMap.getWitness(marketFieldKey),
      positionKey,
      positionLeaf,
      positionsMap.getWitness(positionKey)
    );
  });
  const feePayerUpdate = (tx as unknown as { feePayer?: { body?: { preconditions?: { account?: { nonce?: unknown } }; useFullCommitment?: unknown } } }).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }
  await tx.prove();

  const positions = await loadUserPositions(USER_POSITIONS_FILE);
  positions[userId] = positions[userId] || {};
  const prior = positions[userId][marketKey] || 0;
  const next = prior + positionDelta(addTotalBet, addYesBet);

  const intent: PendingTxIntent = {
    id: intentId,
    type: 'market-bet',
    marketKey,
    marketDate,
    walletPublicKey: feePayerPublicKey,
    positionKey: positionKey.toString(),
    addTotalBet,
    addYesBet,
    userId,
    newLeaf: serializeMarketLeaf(newLeaf),
    newPositionLeaf: serializePositionLeaf(positionLeaf),
    userNetPositionAfter: next,
    createdAtUnixMs: Date.now()
  };
  pendingTxIntents[intent.id] = intent;

  return {
    tx: tx.toJSON(),
    fee: txFee,
    intent,
    marketSummary: {
      totalPositionBet: newLeaf.totalPositionBet.toString(),
      totalYesPositionBet: newLeaf.totalYesPositionBet.toString()
    }
  };
}

async function buildWalletFeePayerClaimPayoutTx(params: {
  stateFile: string;
  marketKey: string;
  positionKey: string;
  feePayerPublicKey: string;
  userId: string;
}): Promise<{
  tx: unknown;
  fee: string;
  intent: PendingTxIntent;
  payoutSummary: { payoutTmina: string; marketKey: string; positionKey: string };
}> {
  const { stateFile, marketKey, positionKey, feePayerPublicKey, userId } = params;
  setActiveZekoNetwork();
  await ensureContractCompiled();
  const feePayer = PublicKey.fromBase58(feePayerPublicKey);
  const { txFee } = getNetworkConfig();
  const zkappAddress = getZkappPublicKey();
  const account = await fetchAccount({ publicKey: feePayer });
  if (account.error) throw new Error(`fee payer account not found: ${account.error.statusText || 'unknown'}`);

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  const existingMarket = state.markets[marketKey];
  if (!existingMarket) throw new Error(`market ${marketKey} missing in ${stateFile}`);
  const resolvedLeaf = deserializeMarketLeaf(existingMarket);
  if (!resolvedLeaf.resolved.toBoolean()) throw new Error('market not resolved');
  const existingPosition = state.positions[positionKey];
  if (!existingPosition) throw new Error(`position ${positionKey} missing in ${stateFile}`);
  const positionLeaf = deserializePositionLeaf(existingPosition);
  if (positionLeaf.claimed.toBoolean()) throw new Error('position already claimed');
  positionLeaf.marketKey.assertEquals(Field(marketKey));
  const ownerCommitment = ownerCommitmentFromWalletPublicKey(feePayerPublicKey);
  positionLeaf.ownerCommitment.assertEquals(ownerCommitment);
  const resolvedOutcomeOver = resolvedLeaf.outcome.toBoolean();
  if (positionLeaf.sideOver.toBoolean() !== resolvedOutcomeOver) {
    throw new Error('position is not on the winning side');
  }

  const marketFieldKey = Field(marketKey);
  const positionFieldKey = Field(positionKey);
  const marketsMap = buildMarketsMerkleMap(state);
  const positionsMap = buildPositionsMerkleMap(state);
  const zkapp = new PredictionMarketPlatform(zkappAddress);
  const tx = await Mina.transaction({ sender: feePayer, fee: txFee }, async () => {
    zkapp.claimPayout(
      marketFieldKey,
      resolvedLeaf,
      marketsMap.getWitness(marketFieldKey),
      positionFieldKey,
      positionLeaf,
      positionsMap.getWitness(positionFieldKey),
      feePayer
    );
  });
  const feePayerUpdate = (tx as unknown as { feePayer?: { body?: { preconditions?: { account?: { nonce?: unknown } }; useFullCommitment?: unknown } } }).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }
  await tx.prove();

  const totalPot = BigInt(resolvedLeaf.totalPositionBet.toString());
  const totalYes = BigInt(resolvedLeaf.totalYesPositionBet.toString());
  const stake = BigInt(positionLeaf.stake.toString());
  const payout = payoutNanominaForStake(totalPot, totalYes, resolvedOutcomeOver, stake);
  const claimedLeaf = new PositionLeaf({
    marketKey: positionLeaf.marketKey,
    sideOver: positionLeaf.sideOver,
    stake: positionLeaf.stake,
    ownerCommitment: positionLeaf.ownerCommitment,
    claimed: Bool(true)
  });

  const intent: PendingTxIntent = {
    id: randomUUID(),
    type: 'payout-claim',
    marketKey,
    marketDate: state.positionMeta?.[positionKey]?.marketDate || null,
    walletPublicKey: feePayerPublicKey,
    positionKey,
    addTotalBet: 0,
    addYesBet: 0,
    userId,
    newLeaf: null,
    newPositionLeaf: serializePositionLeaf(claimedLeaf),
    userNetPositionAfter: 0,
    createdAtUnixMs: Date.now()
  };
  pendingTxIntents[intent.id] = intent;

  return {
    tx: tx.toJSON(),
    fee: txFee,
    intent,
    payoutSummary: {
      payoutTmina: payout.toString(),
      marketKey,
      positionKey
    }
  };
}

async function processPrivateBetBatch(params: {
  stateFile: string;
  maxItems: number;
}): Promise<{
  processed: number;
  txHash: string | null;
  marketKey: string | null;
  marketDate: string | null;
  totalPositionBetAdded: number;
  totalYesBetAdded: number;
  relayerReimbursedNanomina: string;
}> {
  if (privateBatchInFlight) {
    throw new Error('private batch processor already running');
  }
  if (privateBetQueue.length === 0) {
    return {
      processed: 0,
      txHash: null,
      marketKey: null,
      marketDate: null,
      totalPositionBetAdded: 0,
      totalYesBetAdded: 0,
      relayerReimbursedNanomina: '0'
    };
  }
  privateBatchInFlight = true;
  try {
    const first = privateBetQueue[0];
    if (!first) {
      return {
        processed: 0,
        txHash: null,
        marketKey: null,
        marketDate: null,
        totalPositionBetAdded: 0,
        totalYesBetAdded: 0,
        relayerReimbursedNanomina: '0'
      };
    }
    const proofResult = await proveAndSendPrivateQueuedBet({
      queuedBet: first,
      stateFile: params.stateFile
    });
    return await applySuccessfulPrivateBetBatch({
      stateFile: params.stateFile,
      queuedBet: first,
      txHash: proofResult.txHash,
      relayerReimbursedNanomina: proofResult.relayerReimbursedNanomina
    });
  } catch (error) {
    await recordPrivateBatchFailure(error);
    throw error;
  } finally {
    privateBatchInFlight = false;
  }
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, '..');
  const pagePath = path.resolve(projectRoot, 'public', 'marketplace.html');
  const publicRoot = path.resolve(projectRoot, 'public');
  const port = Number.parseInt(
    process.env.MARKETPLACE_PORT || process.env.PORT || '8790',
    10
  );
  const host = process.env.MARKETPLACE_HOST || '0.0.0.0';
  const defaultStatePath = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const committeeEnabled = process.env.ENABLE_ORACLE_COMMITTEE_PATH === '1';
  const governanceEnabled = process.env.ENABLE_GOVERNANCE_PATH === '1';
  const acpCreditEscrowEnabled = process.env.ENABLE_ACP_CREDIT_ESCROW_PATH === '1';

  // Durable startup state for private batching.
  const restoredQueue = await loadPrivateBetQueue();
  privateBetQueue.splice(0, privateBetQueue.length, ...restoredQueue);
  const restoredHistory = await loadPrivateBatchHistory();
  privateBatchHistory.splice(0, privateBatchHistory.length, ...restoredHistory);
  let dailySettleState = await loadDailySettleState();
  let lastDailySettleRunDate: string | null = dailySettleState.lastNightlyRunDate;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/marketplace')) {
        const html = await readFile(pagePath, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.end(html);
        return;
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/public/'))) {
        const rawPath = url.pathname.startsWith('/public/')
          ? url.pathname.slice('/public/'.length)
          : url.pathname.slice(1);
        const normalized = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const target = path.resolve(publicRoot, normalized);
        if (!target.startsWith(publicRoot)) {
          writeJson(res, 400, { error: 'invalid asset path' });
          return;
        }
        const ctype = contentTypeForFile(target);
        let fileStat;
        try {
          fileStat = await stat(target);
        } catch {
          writeJson(res, 404, { error: 'asset not found' });
          return;
        }
        const fileSize = fileStat.size;
        const range = req.headers.range;

        res.setHeader('Content-Type', ctype);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Accept-Ranges', 'bytes');

        if (range && ctype === 'video/mp4') {
          const match = /bytes=(\d*)-(\d*)/.exec(range);
          if (match) {
            const start = match[1] ? Number.parseInt(match[1], 10) : 0;
            const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
            const safeStart = Math.max(0, Math.min(start, fileSize - 1));
            const safeEnd = Math.max(safeStart, Math.min(end, fileSize - 1));
            const chunkSize = safeEnd - safeStart + 1;
            if (safeStart >= fileSize || safeEnd >= fileSize) {
              res.statusCode = 416;
              res.setHeader('Content-Range', `bytes */${fileSize}`);
              res.end();
              return;
            }

            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${safeStart}-${safeEnd}/${fileSize}`);
            res.setHeader('Content-Length', String(chunkSize));
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            createReadStream(target, { start: safeStart, end: safeEnd }).pipe(res);
            return;
          }
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', String(fileSize));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(target).pipe(res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        let zkappPublicKey: string | null = null;
        let zkappConfigError: string | null = null;
        try {
          zkappPublicKey = getZkappPublicKey().toBase58();
        } catch (error) {
          zkappPublicKey = null;
          zkappConfigError = error instanceof Error ? error.message : String(error);
        }
        writeJson(res, 200, {
          ok: true,
          service: 'marketplace',
          privacyMode: getPrivacyMode(),
          zkappPublicKey,
          zkappConfigError,
          dailySettle: dailySettleState,
          features: {
            oracleCommitteePathEnabled: committeeEnabled,
            governancePathEnabled: governanceEnabled,
            acpCreditEscrowPathEnabled: acpCreditEscrowEnabled,
            manualWeatherRefreshEnabled: !(process.env.RENDER === 'true' || process.env.IS_RENDER === 'true')
          },
          ts: new Date().toISOString()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/ready') {
        const readiness = await readStartupReadyState();
        const status = readiness.ready ? 200 : 503;
        writeJson(res, status, {
          ok: readiness.ready,
          ready: readiness.ready,
          reason: readiness.reason,
          ts: new Date().toISOString()
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/private-bets/submit') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('private queue path is only required in PRIVACY_MODE=zk_strong');
        }
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const addTotalBet = requireNumber(body.addTotalBet, 'addTotalBet');
        const addYesBet = requireNonNegativeNumber(body.addYesBet, 'addYesBet');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        const fundingTxHash = typeof body.fundingTxHash === 'string' && body.fundingTxHash.length > 0 ? body.fundingTxHash : null;
        const marketDate = requireString(body.marketDate, 'marketDate');
        const selectedThresholdF =
          typeof body.thresholdF === 'number' && Number.isFinite(body.thresholdF) ? Math.round(body.thresholdF) : null;
        if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');
        if (!(Math.floor(addYesBet) === 0 || Math.floor(addYesBet) === Math.floor(addTotalBet))) {
          throw new Error('private payout path requires binary over/under stake; use full OVER or full UNDER amount');
        }
        if (marketDate) {
          const todayIso = currentLocalDate();
          if (marketDate < todayIso) {
            throw new Error(`market date ${marketDate} is closed (past date). Today is ${todayIso}`);
          }
          const maxDate = isoDateOffset(todayIso, 5);
          if (marketDate > maxDate) {
            throw new Error(`market date ${marketDate} is outside rolling window (${todayIso} to ${maxDate})`);
          }
        }
        const state = await loadOperatorState(defaultStatePath);
        const selectedMarket = findSelectedOnChainMarket(state, marketKey, marketDate);
        const dailyMarkets = marketDate ? await loadDemoDailyMarkets() : {};
        const selectedDailyMarket = marketDate ? dailyMarkets[marketDate] || null : null;
        let effectiveMarketKey: string;
        if (selectedMarket) {
          effectiveMarketKey = String(selectedMarket.marketKey);
          const existingMarket = state.markets[effectiveMarketKey];
          if (!existingMarket) {
            throw new Error(`market ${marketDate} is temporarily unavailable on-chain`);
          }
          const existingLeaf = deserializeMarketLeaf(existingMarket);
          if (existingLeaf.resolved.toBoolean()) {
            throw new Error(`market ${marketDate} is already resolved`);
          }
          if (selectedThresholdF !== null) {
            const thresholdValueTenthC = Number(existingLeaf.thresholdValueTenthC.toString());
            const onChainThresholdF = Math.round(((thresholdValueTenthC / 10) * 9) / 5 + 32);
            if (onChainThresholdF !== selectedThresholdF) {
              throw new Error(
                `selected threshold ${selectedThresholdF}F does not match active on-chain threshold ${onChainThresholdF}F for ${marketDate}`
              );
            }
          }
        } else {
          if (!marketDate || !selectedDailyMarket) {
            throw new Error(
              `locked market ${marketDate} is unavailable. Wait for the next oracle upkeep cycle or refresh forecast state.`
            );
          }
          const dailyThresholdF = Math.round(Number(selectedDailyMarket.thresholdF));
          if (selectedThresholdF !== null && dailyThresholdF !== selectedThresholdF) {
            throw new Error(
              `selected threshold ${selectedThresholdF}F does not match locked threshold ${dailyThresholdF}F for ${marketDate}`
            );
          }
          effectiveMarketKey =
            typeof selectedDailyMarket.marketKey === 'string' && selectedDailyMarket.marketKey.length > 0
              ? selectedDailyMarket.marketKey
              : deriveDemoDateMarketKey(marketDate);
        }
        const id = randomUUID();
        const positionKey = fieldFromHexDigest(
          sha256Hex(`${walletPublicKey}:${effectiveMarketKey}:${marketDate || ''}:${id}:${Date.now()}`)
        ).toString();
        const ownerCommitment = ownerCommitmentFromWalletPublicKey(walletPublicKey).toString();
        const walletCommitment = sha256Hex(
          `${walletPublicKey}:${effectiveMarketKey}:${marketDate || ''}:${Math.floor(addTotalBet)}:${Math.floor(addYesBet)}:${id}:${Date.now()}`
        );
        privateBetQueue.push({
          id,
          marketKey: effectiveMarketKey,
          marketDate,
          walletPublicKey,
          positionKey,
          ownerCommitment,
          addTotalBet: Math.floor(addTotalBet),
          addYesBet: Math.floor(addYesBet),
          fundingTxHash,
          walletCommitment,
          createdAtUnixMs: Date.now(),
          leaseExpiryCount: 0,
          status: 'QUEUED'
        });
        await savePrivateBetQueue(privateBetQueue);
        writeJson(res, 200, {
          ok: true,
          privacyMode: 'zk_strong',
          queueDepth: privateBetQueue.length,
          intent: {
            id,
            marketKey: effectiveMarketKey,
            marketDate,
            positionKey,
            fundingTxHash,
            walletCommitment,
            status: 'QUEUED'
          },
          note: 'Private commitment queued. Batch proof/settlement executor must post aggregated on-chain transition.'
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/private-bets/status') {
        const now = Date.now();
        await releaseExpiredPrivateBatchLease(now);
        const oldest = privateBetQueue[0];
        writeJson(res, 200, {
          ok: true,
          privacyMode: getPrivacyMode(),
          queueDepth: privateBetQueue.length,
          inFlight: privateBatchInFlight,
          leaseAgeMs: privateBatchInFlight && privateBatchLeaseStartedAtUnixMs ? now - privateBatchLeaseStartedAtUnixMs : null,
          oldestAgeMs: oldest ? now - oldest.createdAtUnixMs : null,
          recentBatch: privateBatchHistory[0] || null
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/private-bets/history') {
        const limitParam = Number.parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Math.max(1, Math.min(100, Number.isFinite(limitParam) ? limitParam : 20));
        writeJson(res, 200, {
          ok: true,
          count: privateBatchHistory.length,
          history: privateBatchHistory.slice(0, limit)
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/payouts/resolved-markets') {
        const walletPublicKey = requireString(url.searchParams.get('walletPublicKey'), 'walletPublicKey');
        const positions = await listResolvedWalletPositions(walletPublicKey, defaultStatePath);
        writeJson(res, 200, {
          ok: true,
          walletPublicKey,
          count: positions.length,
          positions,
          note: 'Winning resolved positions can be claimed publicly. Losing resolved positions are shown for history.'
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/wallet/activity') {
        const walletPublicKey = requireString(url.searchParams.get('walletPublicKey'), 'walletPublicKey');
        const state = await loadOperatorState(defaultStatePath);
        const queued = privateBetQueue
          .filter((entry) => entry.walletPublicKey === walletPublicKey)
          .map((entry) => ({
            type: 'queued-private-bet' as const,
            id: entry.id,
            marketKey: entry.marketKey,
            marketDate: entry.marketDate,
            side: entry.addYesBet === entry.addTotalBet ? 'over' : 'under',
            stakeTmina: entry.addTotalBet,
            createdAtUnixMs: entry.createdAtUnixMs,
            fundingTxHash: entry.fundingTxHash,
            status: entry.status
          }));
        const positions = Object.entries(state.positionMeta || {})
          .filter(([, meta]) => meta?.walletPublicKey === walletPublicKey)
          .map(([positionKey, meta]) => {
            const storedPosition = state.positions[positionKey];
            const storedMarket = state.markets[meta.marketKey];
            const positionLeaf = storedPosition ? deserializePositionLeaf(storedPosition) : null;
            const marketLeaf = storedMarket ? deserializeMarketLeaf(storedMarket) : null;
            const side = positionLeaf?.sideOver.toBoolean() ? 'over' : 'under';
            const resolved = marketLeaf?.resolved.toBoolean() || false;
            const resolvedOutcome = resolved ? (marketLeaf?.outcome.toBoolean() ? 'over' : 'under') : null;
            return {
              type: 'position' as const,
              positionKey,
              marketKey: meta.marketKey,
              marketDate: meta.marketDate,
              side,
              stakeTmina: positionLeaf ? Number(positionLeaf.stake.toString()) : null,
              createdAtUnixMs: meta.createdAtUnixMs,
              fundingTxHash: meta.fundingTxHash,
              resolved,
              resolvedOutcome,
              won: resolved && resolvedOutcome !== null ? side === resolvedOutcome : null,
              claimed: positionLeaf?.claimed.toBoolean() || false,
              claimStatus: meta.claimStatus || null,
              claimTxHash: meta.claimTxHash || null
            };
          })
          .sort((a, b) => {
            const ad = a.marketDate || '';
            const bd = b.marketDate || '';
            if (ad !== bd) return ad < bd ? 1 : -1;
            return (b.createdAtUnixMs || 0) - (a.createdAtUnixMs || 0);
          });
        writeJson(res, 200, {
          ok: true,
          walletPublicKey,
          queuedCount: queued.length,
          positionCount: positions.length,
          queued,
          positions
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/private-bets/process-batch') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('batch processor is only required in PRIVACY_MODE=zk_strong');
        }
        if (process.env.RENDER === 'true' || process.env.IS_RENDER === 'true') {
          throw new Error('direct private batch processing is disabled on the hosted web service; use the operator worker');
        }
        const body = await readJsonBody(req);
        const maxItemsRaw = typeof body.maxItems === 'number' && Number.isFinite(body.maxItems) ? body.maxItems : 32;
        const result = await processPrivateBetBatch({
          stateFile: defaultStatePath,
          maxItems: maxItemsRaw
        });
        writeJson(res, 200, {
          ok: true,
          privacyMode: 'zk_strong',
          ...result,
          queueDepth: privateBetQueue.length
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/process-private-batch') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('batch processor is only required in PRIVACY_MODE=zk_strong');
        }
        if (process.env.RENDER === 'true' || process.env.IS_RENDER === 'true') {
          throw new Error('direct private batch processing is disabled on the hosted web service; use /api/operator/lease-private-batch from the operator worker');
        }
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const result = await processPrivateBetBatch({
          stateFile: defaultStatePath,
          maxItems: Number.parseInt(process.env.PRIVATE_BATCH_MAX_ITEMS || '64', 10)
        });
        await refreshState(projectRoot);
        writeJson(res, 200, {
          ok: true,
          privacyMode: 'zk_strong',
          result,
          queueDepth: privateBetQueue.length
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/lease-private-batch') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('batch processor is only required in PRIVACY_MODE=zk_strong');
        }
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        await releaseExpiredPrivateBatchLease();
        const first = privateBetQueue[0] || null;
        if (!first) {
          writeJson(res, 200, {
            ok: true,
            leased: false,
            queueDepth: 0,
            inFlight: privateBatchInFlight
          });
          return;
        }
        if (privateBatchInFlight) {
          writeJson(res, 200, {
            ok: true,
            leased: false,
            queueDepth: privateBetQueue.length,
            inFlight: true
          });
          return;
        }
        const state = await loadOperatorState(defaultStatePath);
        const dailyMarkets = await loadDemoDailyMarkets();
        privateBatchInFlight = true;
        privateBatchLeaseStartedAtUnixMs = Date.now();
        writeJson(res, 200, {
          ok: true,
          leased: true,
          batch: first,
          queueDepth: privateBetQueue.length,
          state,
          dailyMarkets
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/export-state') {
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const state = await loadOperatorState(defaultStatePath);
        const dailyMarkets = await loadDemoDailyMarkets();
        writeJson(res, 200, {
          ok: true,
          state,
          dailyMarkets
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/import-state') {
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const importedMarkets = ((body.markets as Record<string, StoredMarketLeaf>) || {});
        const importedPositions = ((body.positions as Record<string, StoredPositionLeaf>) || {});
        const importedMarketMeta = ((body.marketMeta as Record<string, StoredMarketMeta>) || {});
        const importedPositionMeta = ((body.positionMeta as Record<string, StoredPositionMeta>) || {});
        const importedUsedNonces = ((body.usedNonces as Record<string, string>) || {});
        const currentState = await loadOperatorState(defaultStatePath);
        const nextState = {
          ...currentState,
          markets: {
            ...currentState.markets,
            ...importedMarkets
          },
          positions: {
            ...(currentState.positions || {}),
            ...importedPositions
          },
          marketMeta: {
            ...(currentState.marketMeta || {}),
            ...importedMarketMeta
          },
          positionMeta: {
            ...(currentState.positionMeta || {}),
            ...importedPositionMeta
          },
          usedNonces: {
            ...currentState.usedNonces,
            ...importedUsedNonces
          }
        };
        await saveOperatorState(defaultStatePath, nextState);
        const dailyMarketsPatch = body.dailyMarkets;
        if (dailyMarketsPatch && typeof dailyMarketsPatch === 'object') {
          const currentDailyMarkets = await loadDemoDailyMarkets();
          await saveDemoDailyMarkets({
            ...currentDailyMarkets,
            ...(dailyMarketsPatch as Record<string, DemoDailyMarket>)
          });
        }
        writeJson(res, 200, {
          ok: true,
          marketsImported: Object.keys(importedMarkets).length,
          positionsImported: Object.keys(importedPositions).length,
          marketMetaImported: Object.keys(importedMarketMeta).length,
          positionMetaImported: Object.keys(importedPositionMeta).length,
          dailyMarketsImported: Object.keys((body.dailyMarkets as Record<string, unknown>) || {}).length,
          usedNoncesImported: Object.keys(importedUsedNonces).length
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/complete-private-batch') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('batch processor is only required in PRIVACY_MODE=zk_strong');
        }
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const batchId = requireString(body.id, 'id');
        const txHash =
          typeof body.txHash === 'string' && body.txHash.trim().length > 0 ? body.txHash.trim() : null;
        const relayerReimbursedNanomina =
          typeof body.relayerReimbursedNanomina === 'string' && body.relayerReimbursedNanomina.trim().length > 0
            ? body.relayerReimbursedNanomina.trim()
            : '0';
        const first = privateBetQueue[0];
        if (!first || first.id !== batchId) {
          throw new Error('leased private batch no longer matches queue head');
        }
        const result = await applySuccessfulPrivateBetBatch({
          stateFile: defaultStatePath,
          queuedBet: first,
          txHash,
          relayerReimbursedNanomina
        });
        privateBatchInFlight = false;
        privateBatchLeaseStartedAtUnixMs = null;
        writeJson(res, 200, {
          ok: true,
          result,
          queueDepth: privateBetQueue.length
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/fail-private-batch') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('batch processor is only required in PRIVACY_MODE=zk_strong');
        }
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const batchId = requireString(body.id, 'id');
        const first = privateBetQueue[0];
        if (!first || first.id !== batchId) {
          throw new Error('leased private batch no longer matches queue head');
        }
        await recordPrivateBatchFailure(body.error, first.marketKey);
        privateBetQueue.shift();
        await savePrivateBetQueue(privateBetQueue);
        privateBatchInFlight = false;
        privateBatchLeaseStartedAtUnixMs = null;
        writeJson(res, 200, {
          ok: true,
          queueDepth: privateBetQueue.length
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/clear-private-queue') {
        if (getPrivacyMode() !== 'zk_strong') {
          throw new Error('batch processor is only required in PRIVACY_MODE=zk_strong');
        }
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const reason =
          typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason.trim()
            : 'manual queue reset';
        const cleared = [...privateBetQueue];
        for (const queuedBet of cleared) {
          await appendPrivateBatchHistory({
            id: randomUUID(),
            atUnixMs: Date.now(),
            marketKey: queuedBet.marketKey,
            processed: 0,
            totalPositionBetAdded: queuedBet.addTotalBet,
            totalYesBetAdded: queuedBet.addYesBet,
            txHash: null,
            relayerReimbursedNanomina: '0',
            status: 'failed',
            error: `${reason} (cleared queued bet ${queuedBet.id})`
          });
        }
        privateBetQueue.splice(0, privateBetQueue.length);
        await savePrivateBetQueue(privateBetQueue);
        privateBatchInFlight = false;
        privateBatchLeaseStartedAtUnixMs = null;
        writeJson(res, 200, {
          ok: true,
          cleared: cleared.length,
          reason
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/emergency-reset-positions-state') {
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const state = await loadOperatorState(defaultStatePath);
        const clearedPositions = Object.keys(state.positions || {}).length;
        const clearedPositionMeta = Object.keys(state.positionMeta || {}).length;
        const clearedQueuedBets = privateBetQueue.length;
        const reason = 'emergency positions reset';
        if (clearedQueuedBets > 0) {
          const cleared = [...privateBetQueue];
          for (const queuedBet of cleared) {
            await appendPrivateBatchHistory({
              id: randomUUID(),
              atUnixMs: Date.now(),
              marketKey: queuedBet.marketKey,
              processed: 0,
              totalPositionBetAdded: queuedBet.addTotalBet,
              totalYesBetAdded: queuedBet.addYesBet,
              txHash: null,
              relayerReimbursedNanomina: '0',
              status: 'failed',
              error: `${reason} (cleared queued bet ${queuedBet.id})`
            });
          }
        }
        privateBetQueue.splice(0, privateBetQueue.length);
        await savePrivateBetQueue(privateBetQueue);
        privateBatchInFlight = false;
        privateBatchLeaseStartedAtUnixMs = null;
        await saveOperatorState(defaultStatePath, {
          ...state,
          positions: {},
          positionMeta: {}
        });
        await saveUserPositions(USER_POSITIONS_FILE, {});
        writeJson(res, 200, {
          ok: true,
          clearedPositions,
          clearedPositionMeta,
          clearedQueuedBets
        });
        return;
      }

      // Hidden baseline: committee-based oracle consensus path (disabled by default).
      if (req.method === 'POST' && url.pathname === '/api/internal/oracle-committee/commit') {
        if (!committeeEnabled) throw new Error('oracle committee path disabled');
        const body = await readJsonBody(req);
        const roundId = requireString(body.roundId, 'roundId');
        const marketDate = requireString(body.marketDate, 'marketDate');
        const memberId = requireString(body.memberId, 'memberId');
        const snapshotHash = requireString(body.snapshotHash, 'snapshotHash');
        const attestationHash = requireString(body.attestationHash, 'attestationHash');

        let state = await loadOracleCommitteeState();
        state = submitCommitteeCommit(state, {
          roundId,
          marketDate,
          memberId,
          snapshotHash,
          attestationHash,
          nowUnixMs: Date.now()
        });
        const finalized = tryFinalizeCommitteeRound(state, roundId, Date.now());
        await saveOracleCommitteeState(finalized.state);
        writeJson(res, 200, {
          ok: true,
          finalized: finalized.finalized,
          round: finalized.state.rounds[roundId] || null
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/internal/oracle-committee/state') {
        if (!committeeEnabled) throw new Error('oracle committee path disabled');
        const state = await loadOracleCommitteeState();
        writeJson(res, 200, { state });
        return;
      }

      // Hidden baseline: governance emergency resolution path (disabled by default).
      if (req.method === 'POST' && url.pathname === '/api/internal/governance/proposals') {
        if (!governanceEnabled) throw new Error('governance path disabled');
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const actionType = requireString(body.actionType, 'actionType') as 'force-settlement' | 'pause-market' | 'resume-market';
        const reason = requireString(body.reason, 'reason');
        const proposer = requireString(body.proposer, 'proposer');

        let state = await loadGovernanceState();
        const created = createEmergencyProposal(state, {
          marketKey,
          actionType,
          reason,
          proposer,
          nowUnixMs: Date.now()
        });
        state = created.state;
        await saveGovernanceState(state);
        writeJson(res, 200, { proposal: created.proposal });
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/internal\/governance\/proposals\/[^/]+\/approve$/)) {
        if (!governanceEnabled) throw new Error('governance path disabled');
        const proposalId = url.pathname.split('/')[5];
        const body = await readJsonBody(req);
        const approver = requireString(body.approver, 'approver');
        let state = await loadGovernanceState();
        state = approveEmergencyProposal(state, proposalId, approver);
        await saveGovernanceState(state);
        writeJson(res, 200, { proposal: state.proposals[proposalId] || null });
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/internal\/governance\/proposals\/[^/]+\/execute$/)) {
        if (!governanceEnabled) throw new Error('governance path disabled');
        const proposalId = url.pathname.split('/')[5];
        let state = await loadGovernanceState();
        const check = canExecuteEmergencyProposal(state, proposalId, Date.now());
        if (!check.ok) throw new Error(`proposal not executable: ${check.reason}`);
        state = markProposalExecuted(state, proposalId, Date.now());
        await saveGovernanceState(state);
        writeJson(res, 200, {
          executed: true,
          proposal: state.proposals[proposalId] || null
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/internal/governance/state') {
        if (!governanceEnabled) throw new Error('governance path disabled');
        const state = await loadGovernanceState();
        writeJson(res, 200, { state });
        return;
      }

      // Hidden baseline: ACP-style credits escrow + relayer path (disabled by default).
      if (req.method === 'POST' && url.pathname === '/api/internal/acp/credits/intent') {
        if (!acpCreditEscrowEnabled) throw new Error('acp credit escrow path disabled');
        const body = await readJsonBody(req);
        const owner = requireString(body.owner, 'owner');
        const amount = requireNumber(body.amount, 'amount');
        const nonce = requireString(body.nonce, 'nonce');
        let state = await loadAcpCreditEscrowState();
        const created = acpCreateCreditsIntent(state, {
          owner,
          amount,
          nonce,
          nowUnixMs: Date.now()
        });
        state = created.state;
        await saveAcpCreditEscrowState(state);
        writeJson(res, 200, { intent: created.intent });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/internal/acp/credits/fund') {
        if (!acpCreditEscrowEnabled) throw new Error('acp credit escrow path disabled');
        const body = await readJsonBody(req);
        const intentId = requireString(body.intentId, 'intentId');
        let state = await loadAcpCreditEscrowState();
        const funded = acpMarkIntentFunded(state, { intentId });
        state = funded.state;
        await saveAcpCreditEscrowState(state);
        writeJson(res, 200, { intent: funded.intent, balance: state.balances[funded.intent.owner] || 0 });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/internal/acp/credits/spend-relay') {
        if (!acpCreditEscrowEnabled) throw new Error('acp credit escrow path disabled');
        const body = await readJsonBody(req);
        const owner = requireString(body.owner, 'owner');
        const spendAmount = requireNumber(body.spendAmount, 'spendAmount');
        const agentId = requireString(body.agentId, 'agentId');
        const prompt = requireString(body.prompt, 'prompt');
        const intentId = typeof body.intentId === 'string' ? body.intentId : undefined;
        let state = await loadAcpCreditEscrowState();
        const created = acpCreateRelayJobFromCredits(state, {
          owner,
          spendAmount,
          agentId,
          prompt,
          nowUnixMs: Date.now(),
          intentId
        });
        state = created.state;
        await saveAcpCreditEscrowState(state);
        writeJson(res, 200, { job: created.job, balance: state.balances[owner] || 0 });
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/internal\/acp\/relay\/jobs\/[^/]+\/run$/)) {
        if (!acpCreditEscrowEnabled) throw new Error('acp credit escrow path disabled');
        const jobId = url.pathname.split('/')[6];
        const body = await readJsonBody(req);
        const outputPlaintext = requireString(body.outputPlaintext, 'outputPlaintext');
        let state = await loadAcpCreditEscrowState();
        const ran = acpRelayRunJob(state, { jobId, outputPlaintext });
        state = ran.state;
        await saveAcpCreditEscrowState(state);
        writeJson(res, 200, { job: ran.job });
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/internal\/acp\/relay\/jobs\/[^/]+\/settle$/)) {
        if (!acpCreditEscrowEnabled) throw new Error('acp credit escrow path disabled');
        const jobId = url.pathname.split('/')[6];
        const body = await readJsonBody(req);
        const outputPlaintext = requireString(body.outputPlaintext, 'outputPlaintext');
        let state = await loadAcpCreditEscrowState();
        const settled = acpRevealAndSettleRelayJob(state, { jobId, outputPlaintext });
        state = settled.state;
        await saveAcpCreditEscrowState(state);
        writeJson(res, 200, { job: settled.job });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/internal/acp/state') {
        if (!acpCreditEscrowEnabled) throw new Error('acp credit escrow path disabled');
        const state = await loadAcpCreditEscrowState();
        writeJson(res, 200, { state });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/markets') {
        const currentSlot = parseIntOrDefault(url.searchParams.get('current_slot'), 0);
        const statePath = url.searchParams.get('state_file') || defaultStatePath;
        const state = await loadOperatorState(statePath);
        const markets = toMarketViews(state, currentSlot);
        const snapshot = await loadDisplayWeatherSnapshot();
        const oracle = getOracleFreshness(snapshot, Date.now());
        writeJson(res, 200, { count: markets.length, markets, oracle, oraclePolicy: getOraclePolicy() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/market-bet') {
        if (getPrivacyMode() !== 'compat') {
          throw new Error(
            'PRIVACY_MODE=zk_strong blocks direct per-user market tx path. Use /api/private-bets/submit and batch settlement.'
          );
        }
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const addTotalBet = requireNumber(body.addTotalBet, 'addTotalBet');
        const addYesBet = requireNonNegativeNumber(body.addYesBet, 'addYesBet');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        const marketDate = requireString(body.marketDate, 'marketDate');
        const selectedThresholdF =
          typeof body.thresholdF === 'number' && Number.isFinite(body.thresholdF) ? Math.round(body.thresholdF) : null;
        const userId = walletPublicKey;
        if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');
        {
          const todayIso = currentLocalDate();
          if (marketDate < todayIso) {
            throw new Error(`market date ${marketDate} is closed (past date). Today is ${todayIso}`);
          }
          const maxDate = isoDateOffset(todayIso, 5);
          if (marketDate > maxDate) {
            throw new Error(`market date ${marketDate} is outside rolling window (${todayIso} to ${maxDate})`);
          }
        }
        await refreshState(projectRoot);
        const currentState = await loadOperatorState(defaultStatePath);
        const selectedMarket = findSelectedOnChainMarket(currentState, marketKey, marketDate);
        if (!selectedMarket) {
          throw new Error(
            `market ${marketDate} is not active on-chain yet. Betting opens after the automatic daily market creation cycle reaches this date.`
          );
        }
        const effectiveMarketKey = String(selectedMarket.marketKey);
        if (selectedThresholdF !== null && Number.isFinite(Number(selectedMarket.thresholdF))) {
          const onChainThresholdF = Math.round(Number(selectedMarket.thresholdF));
          if (onChainThresholdF !== selectedThresholdF) {
            throw new Error(
              `selected threshold ${selectedThresholdF}F does not match active on-chain threshold ${onChainThresholdF}F for ${marketDate}`
            );
          }
        }
        const built = await buildWalletFeePayerMarketBetTx({
          stateFile: defaultStatePath,
          marketKey: effectiveMarketKey,
          addTotalBet: Math.floor(addTotalBet),
          addYesBet: Math.floor(addYesBet),
          marketDate,
          feePayerPublicKey: walletPublicKey,
          userId
        });
        writeJson(res, 200, {
          ok: true,
          mode: 'wallet-fee-payer',
          intentId: built.intent.id,
          fee: built.fee,
          tx: built.tx,
          marketSummary: built.marketSummary
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/market-close') {
        if (getPrivacyMode() !== 'compat') {
          throw new Error(
            'PRIVACY_MODE=zk_strong blocks direct per-user close tx path. Use private batch settlement path.'
          );
        }
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        const positions = await loadUserPositions(USER_POSITIONS_FILE);
        const net = positions[walletPublicKey]?.[marketKey] || 0;
        if (net === 0) throw new Error('no open net position to close');
        const closeAmount = Math.abs(net);
        const addTotalBet = closeAmount;
        const addYesBet = net < 0 ? closeAmount : 0;
        await refreshState(projectRoot);
        const built = await buildWalletFeePayerMarketBetTx({
          stateFile: defaultStatePath,
          marketKey,
          addTotalBet,
          addYesBet,
          marketDate: null,
          feePayerPublicKey: walletPublicKey,
          userId: walletPublicKey
        });
        writeJson(res, 200, {
          ok: true,
          mode: 'wallet-fee-payer',
          action: 'close-bet',
          intentId: built.intent.id,
          fee: built.fee,
          tx: built.tx,
          closeOrder: { addTotalBet, addYesBet, priorNetPosition: net },
          marketSummary: built.marketSummary
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/claim-payout') {
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const positionKey = requireString(body.positionKey, 'positionKey');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        await refreshState(projectRoot);
        const built = await buildWalletFeePayerClaimPayoutTx({
          stateFile: defaultStatePath,
          marketKey,
          positionKey,
          feePayerPublicKey: walletPublicKey,
          userId: walletPublicKey
        });
        writeJson(res, 200, {
          ok: true,
          mode: 'wallet-fee-payer',
          action: 'claim-payout',
          intentId: built.intent.id,
          fee: built.fee,
          tx: built.tx,
          payoutSummary: built.payoutSummary
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/finalize') {
        const body = await readJsonBody(req);
        const intentId = requireString(body.intentId, 'intentId');
        const txHash = requireString(body.txHash, 'txHash');
        const intent = pendingTxIntents[intentId];
        if (!intent) throw new Error('intent not found or expired');
        if (Date.now() - intent.createdAtUnixMs > 15 * 60 * 1000) {
          delete pendingTxIntents[intentId];
          throw new Error('intent expired; rebuild transaction');
        }
        const state = await loadOperatorState(defaultStatePath);
        if (intent.type === 'market-bet' && intent.newLeaf) {
          state.markets[intent.marketKey] = intent.newLeaf;
          state.positions[intent.positionKey] = intent.newPositionLeaf;
          state.positionMeta = state.positionMeta || {};
          state.positionMeta[intent.positionKey] = {
            marketKey: intent.marketKey,
            marketDate: intent.marketDate,
            walletPublicKey: intent.walletPublicKey,
            ownerCommitment: ownerCommitmentFromWalletPublicKey(intent.walletPublicKey).toString(),
            createdAtUnixMs: intent.createdAtUnixMs,
            fundingTxHash: txHash
          };
        } else if (intent.type === 'payout-claim') {
          state.positionMeta = state.positionMeta || {};
          const existingMeta = state.positionMeta[intent.positionKey];
          if (!existingMeta) throw new Error('position metadata missing for payout claim');
          existingMeta.claimStatus = 'submitted';
          existingMeta.claimTxHash = txHash;
          existingMeta.claimSubmittedAtUnixMs = Date.now();
          existingMeta.claimConfirmedAtUnixMs = null;
          try {
            setActiveZekoNetwork();
            const { graphql } = getNetworkConfig();
            const claimTxStatus = await fetchTransactionStatus(txHash, graphql);
            if (claimTxStatus === 'INCLUDED') {
              markPositionClaimConfirmed(state, intent.positionKey, Date.now());
            }
          } catch {
            // Leave claim in submitted state until a later refresh confirms inclusion.
          }
        }
        await saveOperatorState(defaultStatePath, state);

        if (intent.type === 'market-bet') {
          const positions = await loadUserPositions(USER_POSITIONS_FILE);
          positions[intent.userId] = positions[intent.userId] || {};
          positions[intent.userId][intent.marketKey] = intent.userNetPositionAfter;
          await saveUserPositions(USER_POSITIONS_FILE, positions);
        }

        if (intent.type === 'market-bet' && intent.marketDate) {
          const dailyMarketMap = await loadDemoDailyMarkets();
          const day = dailyMarketMap[intent.marketDate];
          if (day) {
            const nextTotal = (Number.isFinite(day.totalPositionBet) ? day.totalPositionBet : 0) + intent.addTotalBet;
            const nextYes = (Number.isFinite(day.totalYesPositionBet) ? day.totalYesPositionBet : 0) + intent.addYesBet;
            day.totalPositionBet = nextTotal;
            day.totalYesPositionBet = nextYes;
            dailyMarketMap[intent.marketDate] = day;
            await saveDemoDailyMarkets(dailyMarketMap);
          }
        }
        delete pendingTxIntents[intentId];

        writeJson(res, 200, {
          ok: true,
          txHash,
          type: intent.type,
          marketKey: intent.marketKey,
          userId: intent.userId,
          userNetPosition: intent.userNetPositionAfter,
          claimStatus:
            intent.type === 'payout-claim'
              ? state.positionMeta?.[intent.positionKey]?.claimStatus || 'submitted'
              : undefined
        });
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/markets\/[^/]+\/bet$/)) {
        const marketKey = url.pathname.split('/')[3];
        const body = await readJsonBody(req);
        const addTotalBet = requireNumber(body.addTotalBet, 'addTotalBet');
        const addYesBet = requireNumber(body.addYesBet, 'addYesBet');
        const userId = typeof body.userId === 'string' ? body.userId : null;
        if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');
        const snapshot = await loadWeatherSnapshot();
        const oracle = getOracleFreshness(snapshot, Date.now());
        if (oracle.state !== 'fresh') {
          throw new Error(`market in close-only mode: oracle state is ${oracle.state} (${oracle.reason})`);
        }

        const output = await runProjectCommand(projectRoot, [
          'trade-update:zeko',
          '--',
          '--market-key',
          marketKey,
          '--add-total-bet',
          String(Math.floor(addTotalBet)),
          '--add-yes-bet',
          String(Math.floor(addYesBet)),
          '--state-file',
          './data/operator-state.json'
        ]);

        let userNetPosition = null;
        if (userId) {
          const positions = await loadUserPositions(USER_POSITIONS_FILE);
          positions[userId] = positions[userId] || {};
          const prior = positions[userId][marketKey] || 0;
          const next = prior + positionDelta(Math.floor(addTotalBet), Math.floor(addYesBet));
          positions[userId][marketKey] = next;
          await saveUserPositions(USER_POSITIONS_FILE, positions);
          userNetPosition = next;
        }

        await refreshState(projectRoot);
        const state = await loadOperatorState(defaultStatePath);
        writeJson(res, 200, { ok: true, output, market: state.markets[marketKey] || null, userNetPosition });
        return;
      }

      if (req.method === 'POST' && url.pathname.match(/^\/api\/markets\/[^/]+\/close$/)) {
        const marketKey = url.pathname.split('/')[3];
        const body = await readJsonBody(req);
        const userId = requireString(body.userId, 'userId');
        const positions = await loadUserPositions(USER_POSITIONS_FILE);
        const net = positions[userId]?.[marketKey] || 0;
        if (net === 0) throw new Error('no open net position to close');

        const closeAmount = Math.abs(net);
        const addTotalBet = closeAmount;
        const addYesBet = net < 0 ? closeAmount : 0;

        const output = await runProjectCommand(projectRoot, [
          'trade-update:zeko',
          '--',
          '--market-key',
          marketKey,
          '--add-total-bet',
          String(Math.floor(addTotalBet)),
          '--add-yes-bet',
          String(Math.floor(addYesBet)),
          '--state-file',
          './data/operator-state.json'
        ]);

        positions[userId] = positions[userId] || {};
        positions[userId][marketKey] = 0;
        await saveUserPositions(USER_POSITIONS_FILE, positions);

        await refreshState(projectRoot);
        const state = await loadOperatorState(defaultStatePath);
        writeJson(res, 200, {
          ok: true,
          action: 'close-bet',
          marketKey,
          closedNetBefore: net,
          closeOrder: { addTotalBet, addYesBet },
          output,
          market: state.markets[marketKey] || null,
          userNetPosition: 0
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.match(/^\/api\/users\/[^/]+\/positions$/)) {
        const userId = url.pathname.split('/')[3];
        const positions = await loadUserPositions(USER_POSITIONS_FILE);
        writeJson(res, 200, { userId, positions: positions[userId] || {} });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/agents') {
        writeJson(res, 200, { agents });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/agents/register') {
        const body = await readJsonBody(req);
        const model: AgentModel = {
          id: randomUUID(),
          name: requireString(body.name, 'name'),
          owner: requireString(body.owner, 'owner'),
          price: requireNumber(body.price, 'price'),
          description: requireString(body.description, 'description'),
          mode: 'external'
        };
        agents.push(model);
        writeJson(res, 200, { agent: model });
        return;
      }

      if (req.method === 'GET' && url.pathname.match(/^\/api\/users\/[^/]+\/balance$/)) {
        const userId = url.pathname.split('/')[3];
        if (!balances[userId]) balances[userId] = { wallet: 0, credits: 0 };
        writeJson(res, 200, { userId, balance: balances[userId] });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/orders/create') {
        const body = await readJsonBody(req);
        const buyer = requireString(body.buyer, 'buyer');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        const agentId = requireString(body.agentId, 'agentId');
        const paymentMethod: 'wallet' = 'wallet';
        const prompt = requireString(body.prompt, 'prompt');
        const agent = agents.find((a) => a.id === agentId);
        if (!agent) throw new Error('agent not found');
        // Wallet-only demo mode: caller must pass connected wallet key.
        if (walletPublicKey !== buyer) {
          throw new Error('buyer must match connected wallet public key');
        }

        const relayerFee = Math.max(1, Math.floor(agent.price * 0.05));
        const order: EscrowOrder = {
          id: randomUUID(),
          buyer,
          agentId,
          amount: agent.price,
          promptHash: sha256Hex(prompt),
          encryptedPrompt: encodePrivatePayload(prompt),
          status: 'FUNDED',
          paymentMethod,
          relayerFee,
          createdAtUnixMs: Date.now()
        };
        orders[order.id] = order;
        writeJson(res, 200, { order });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/relay-run')) {
        const orderId = url.pathname.split('/')[3];
        const order = orders[orderId];
        if (!order) throw new Error('order not found');
        if (order.status !== 'FUNDED') throw new Error('order must be FUNDED');
        const agent = agents.find((a) => a.id === order.agentId);
        if (!agent) throw new Error('agent missing');
        const prompt = decodePrivatePayload(order.encryptedPrompt);
        const output =
          agent.mode === 'random-demo'
            ? randomPredictionOutput(order.promptHash)
            : `{"note":"external model pending","prompt":"${prompt}"}`;
        order.relayerOutputCommitment = sha256Hex(output);
        order.relayerOutputCiphertext = encodePrivatePayload(output);
        order.status = 'RELAYED';
        writeJson(res, 200, { order });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/reveal-settle')) {
        const orderId = url.pathname.split('/')[3];
        const body = await readJsonBody(req);
        const output = requireString(body.output, 'output');
        const order = orders[orderId];
        if (!order) throw new Error('order not found');
        if (order.status !== 'RELAYED') throw new Error('order must be RELAYED');
        if (sha256Hex(output) !== order.relayerOutputCommitment) throw new Error('output commitment mismatch');
        order.revealedOutput = output;
        order.status = 'SETTLED';
        writeJson(res, 200, {
          order,
          payouts: {
            agentAmount: order.amount - order.relayerFee,
            relayerFee: order.relayerFee
          }
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/orders/')) {
        const orderId = url.pathname.split('/')[3];
        const order = orders[orderId];
        if (!order) throw new Error('order not found');
        writeJson(res, 200, { order });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/weather/94027/refresh') {
        if (process.env.RENDER === 'true' || process.env.IS_RENDER === 'true') {
          throw new Error('manual weather refresh is disabled on the hosted market service; the oracle worker syncs forecast data automatically');
        }
        let refreshed: Awaited<ReturnType<typeof refreshWeatherWithOptionalTlsn>>;
        try {
          refreshed = await refreshWeatherWithOptionalTlsn(undefined);
        } catch (error) {
          const strict = process.env.WEATHER_REQUIRE_TLSN === '1';
          const message = error instanceof Error ? error.message : String(error);
          const canRetryWithFreshAttestation =
            strict &&
            /(attestation too old|invalid attestation envelope|ENOENT|no such file|strict mode requires zkTLS)/i.test(
              message
            );
          if (!canRetryWithFreshAttestation) throw error;
          await runProjectCommand(projectRoot, ['weather:attest']);
          refreshed = await refreshWeatherWithOptionalTlsn(undefined);
        }
        const { snapshot, verification } = refreshed;
        const state = await loadOperatorState(defaultStatePath);
        const dailyMarkets = attachOnChainDailyMarketState(
          await withDailySettlementInfo(withCurrentForecast(await ensureDemoDailyMarketsFromSnapshot(snapshot), snapshot)),
          state
        );
        const selectedDate = currentLocalDate();
        let contest = await loadContestState(selectedDate, 15, contestStateFileForDate(selectedDate));
        contest = maybeAutoSettleContest(contest, snapshot, nowLocalHour(), Date.now());
        await saveContestState(contest, contestStateFileForDate(selectedDate));
        const autoSettledDates = await autoSettleDailyContestsFromSnapshot(snapshot);
        dailySettleState = await recordDailySettleRun(dailySettleState, 'api-weather-refresh', autoSettledDates);
        const oracle = getOracleFreshness(snapshot, Date.now());
        writeJson(res, 200, {
          snapshot,
          verification,
          oracle,
          oraclePolicy: getOraclePolicy(),
          dailyMarkets,
          contest,
          autoSettledDates,
          note: 'Data source: NWS digital forecast page; zkTLS enforced when WEATHER_REQUIRE_TLSN=1.'
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/weather-sync') {
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const { snapshot, tlsnStatus } = parseOracleWorkerSyncPayload(body);
        await saveWeatherSnapshot(snapshot as NonNullable<typeof snapshot>);
        await saveTlsnStatus(tlsnStatus ?? null);
        await ensureDemoDailyMarketsFromSnapshot(snapshot);
        const selectedDate = snapshot.localDate || currentLocalDate();
        let contest = await loadContestState(selectedDate, 15, contestStateFileForDate(selectedDate));
        contest = maybeAutoSettleContest(contest, snapshot, nowLocalHour(), Date.now());
        await saveContestState(contest, contestStateFileForDate(selectedDate));
        const autoSettledDates = await autoSettleDailyContestsFromSnapshot(snapshot);
        dailySettleState = await recordDailySettleRun(dailySettleState, 'operator-weather-sync', autoSettledDates);
        writeJson(res, 200, {
          ok: true,
          snapshotVerified: snapshot.verified,
          verificationMode: snapshot.verificationMode,
          autoSettledDates
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/resolve-daily-market') {
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const marketDate = requireString(body.marketDate, 'marketDate');
        const output = await runProjectCommand(projectRoot, [
          'resolve-daily-market:zeko',
          '--',
          '--market-date',
          marketDate,
          '--attestation',
          process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json',
          '--state-file',
          './data/operator-state.json'
        ]);
        await refreshState(projectRoot);
        writeJson(res, 200, {
          ok: true,
          marketDate,
          output
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/ensure-daily-markets') {
        const body = await readJsonBody(req);
        requireOperatorAuthorization(req, body as Record<string, unknown>);
        const output = await runProjectCommand(projectRoot, [
          'ensure-daily-markets:zeko',
          '--',
          '--state-file',
          './data/operator-state.json',
          '--daily-markets-file',
          process.env.DEMO_DAILY_MARKETS_FILE || './data/demo-daily-threshold-markets.json'
        ]);
        await refreshState(projectRoot);
        writeJson(res, 200, {
          ok: true,
          output
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/public/resolve-daily-market') {
        const body = await readJsonBody(req);
        const marketDate = requireString(body.marketDate, 'marketDate');
        const state = await loadOperatorState(defaultStatePath);
        const views = toMarketViews(state, 0);
        const market = views.find((m) => {
          const title = typeof m.title === 'string' ? m.title : '';
          return title.startsWith(`Atherton, CA - ${marketDate} Over/Under `);
        });
        if (!market) {
          throw new Error(`market for ${marketDate} not found`);
        }
        if (market.resolved) {
          writeJson(res, 200, {
            ok: true,
            ignored: true,
            marketDate,
            reason: 'market already resolved'
          });
          return;
        }
        const todayIso = currentLocalDate();
        const eligible = marketDate < todayIso || (marketDate === todayIso && nowLocalHour() >= 19);
        if (!eligible) {
          writeJson(res, 200, {
            ok: true,
            ignored: true,
            marketDate,
            reason: `market not yet eligible for resolution; today is ${todayIso}`
          });
          return;
        }
        const output = await runProjectCommand(projectRoot, [
          'resolve-daily-market:zeko',
          '--',
          '--market-date',
          marketDate,
          '--attestation',
          process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json',
          '--state-file',
          './data/operator-state.json'
        ]);
        await refreshState(projectRoot);
        writeJson(res, 200, {
          ok: true,
          marketDate,
          output
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/weather/94027') {
        const statePath = url.searchParams.get('state_file') || defaultStatePath;
        const state = await loadOperatorState(statePath);
        const defaultThresholdF = resolvePrimaryMarketThresholdF(state);
        const thresholdF = Number.parseFloat(url.searchParams.get('threshold_f') || String(defaultThresholdF));
        const selectedDate = url.searchParams.get('market_date') || currentLocalDate();
        const snapshot = await loadDisplayWeatherSnapshot();
        const tlsnStatus = normalizeTlsnStatus(snapshot, await loadTlsnStatus());
        const oracle = getOracleFreshness(snapshot, Date.now());
        const baseDailyMarkets =
          snapshot || Object.keys(await loadDemoDailyMarkets()).length > 0
            ? await ensureDemoDailyMarketsFromSnapshot(snapshot)
            : deriveDailyMarketsFromOnChainState(state);
        const pendingPrivateByDate = summarizePendingPrivateBetsByDate();
        const dailyMarkets = attachOnChainDailyMarketState(
          await withDailySettlementInfo(withCurrentForecast(baseDailyMarkets, snapshot)),
          state,
          pendingPrivateByDate
        );
        let contest = await loadContestState(selectedDate, 15, contestStateFileForDate(selectedDate));
        let autoSettledDates: string[] = [];
        if (snapshot) {
          contest = maybeAutoSettleContest(contest, snapshot, nowLocalHour(), Date.now());
          await saveContestState(contest, contestStateFileForDate(selectedDate));
          autoSettledDates = await autoSettleDailyContestsFromSnapshot(snapshot);
          dailySettleState = await recordDailySettleRun(dailySettleState, 'api-weather-read', autoSettledDates);
        }
        const baseProbs = snapshot
          ? buildSevenDayHighProbabilities(snapshot.dailyHighsF, Number.isFinite(thresholdF) ? thresholdF : 86)
          : [];
        const baseDate = snapshot?.localDate || selectedDate;
        const probs = baseProbs.map((p) => ({
          ...p,
          marketDate: isoDateOffset(baseDate, p.dayIndex)
        }));
        writeJson(res, 200, {
          sourceUrl: NWS_94027_DIGITAL_URL,
          strictSettlementSourceUrl: NWS_94027_STRICT_URL,
          snapshot,
          tlsnStatus,
          oracle,
          oraclePolicy: getOraclePolicy(),
          thresholdF,
          sevenDayProbabilities: probs,
          dailyMarkets,
          contest,
          autoSettledDates
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/demo/daily-markets') {
        const snapshot = await loadWeatherSnapshot();
        const state = await loadOperatorState(defaultStatePath);
        const baseDailyMarkets =
          snapshot || Object.keys(await loadDemoDailyMarkets()).length > 0
            ? await ensureDemoDailyMarketsFromSnapshot(snapshot)
            : deriveDailyMarketsFromOnChainState(state);
        const pendingPrivateByDate = summarizePendingPrivateBetsByDate();
        const dailyMarkets = attachOnChainDailyMarketState(
          await withDailySettlementInfo(withCurrentForecast(baseDailyMarkets, snapshot)),
          state,
          pendingPrivateByDate
        );
        writeJson(res, 200, {
          count: dailyMarkets.length,
          dailyMarkets
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/settlement/readiness') {
        const snapshot = await loadWeatherSnapshot();
        const dailyMarkets = await withDailySettlementInfo(
          withCurrentForecast(await ensureDemoDailyMarketsFromSnapshot(snapshot), snapshot)
        );
        const readiness = await buildDailyPayoutReadiness(dailyMarkets);
        writeJson(res, 200, {
          ok: true,
          count: readiness.length,
          readiness,
          note:
            'Per-date payout claim support is experimental and requires the upgraded payout-enabled zkApp deployment. The default live demo path still prioritizes private betting over public claimability.'
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/weather/contest/bet') {
        const body = await readJsonBody(req);
        const userId = requireString(body.userId, 'userId');
        const predictedHighF = requireNumber(body.predictedHighF, 'predictedHighF');
        const stake = requireNumber(body.stake, 'stake');
        const marketDate = requireString(body.marketDate, 'marketDate');
        // Number-pick contest accepts bets for future settlement windows.
        // Oracle freshness is enforced at settlement time, not bet entry time.
        let contest = await loadContestState(marketDate, 15, contestStateFileForDate(marketDate));
        contest = addContestBet(contest, {
          userId,
          predictedHighF,
          stake,
          nowUnixMs: Date.now(),
          nowLocalHour: nowLocalHour()
        });
        await saveContestState(contest, contestStateFileForDate(marketDate));
        writeJson(res, 200, { contest });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/weather/contest/settle') {
        const body = await readJsonBody(req);
        const marketDate = requireString(body.marketDate, 'marketDate');
        const explicitObserved =
          typeof body.observedHighF === 'number' && Number.isFinite(body.observedHighF)
            ? body.observedHighF
            : null;
        const snapshot = await loadWeatherSnapshot();
        if (explicitObserved === null && (!snapshot || snapshot.next24hHighF === null)) {
          throw new Error('missing observed high: pass observedHighF or refresh weather snapshot first');
        }
        if (process.env.WEATHER_REQUIRE_TLSN === '1') {
          if (!snapshot || !snapshot.verified || snapshot.verificationMode !== 'zktls') {
            throw new Error('settlement blocked: WEATHER_REQUIRE_TLSN=1 and latest snapshot is not zkTLS-verified');
          }
        }
        const oracle = getOracleFreshness(snapshot, Date.now());
        if (oracle.state === 'expired' || oracle.state === 'missing') {
          throw new Error(`settlement blocked: oracle state is ${oracle.state} (${oracle.reason})`);
        }

        let contest = await loadContestState(marketDate, 15, contestStateFileForDate(marketDate));
        contest = settleContest(
          contest,
          explicitObserved ?? (snapshot as NonNullable<typeof snapshot>).next24hHighF!,
          Date.now()
        );
        await saveContestState(contest, contestStateFileForDate(marketDate));
        writeJson(res, 200, { contest });
        return;
      }

      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, host, () => {
    const net = getNetworkConfig();
    console.log(`Unified marketplace listening on http://${host}:${port}/marketplace`);
    console.log(`[network] graphql=${net.graphql} networkId=${net.networkId} txFee=${net.txFee}`);
    console.log(`[private-batch] restored queueDepth=${privateBetQueue.length} history=${privateBatchHistory.length}`);
    try {
      const relayer = getRelayerPrivateKey();
      const deployerRaw = process.env.DEPLOYER_PRIVATE_KEY;
      const relayerRaw = process.env.RELAYER_PRIVATE_KEY;
      const source = deployerRaw ? 'DEPLOYER_PRIVATE_KEY' : relayerRaw ? 'RELAYER_PRIVATE_KEY' : 'missing';
      console.log(
        `[private-batch] signer_source=${source} signer_pub=${relayer ? relayer.toPublicKey().toBase58() : 'missing'}`
      );
    } catch (error) {
      console.warn('[private-batch] signer inspection failed:', error instanceof Error ? error.message : String(error));
    }
    if (getPrivacyMode() === 'zk_strong') {
      const intervalMs = getPrivateBatchIntervalMs();
      if (intervalMs > 0) {
        console.log(`[private-batch] enabled interval processor every ${intervalMs}ms`);
        setInterval(async () => {
          if (privateBetQueue.length === 0 || privateBatchInFlight) return;
          try {
            const result = await processPrivateBetBatch({
              stateFile: defaultStatePath,
              maxItems: Number.parseInt(process.env.PRIVATE_BATCH_MAX_ITEMS || '64', 10)
            });
            if (result.processed > 0) {
              console.log(
                `[private-batch] processed=${result.processed} market=${result.marketKey} date=${result.marketDate || 'n/a'} total+=${result.totalPositionBetAdded} yes+=${result.totalYesBetAdded} txHash=${result.txHash || 'n/a'}`
              );
            }
          } catch (error) {
            console.warn('[private-batch] cycle failed:', error instanceof Error ? error.message : String(error));
          }
        }, intervalMs);
      } else {
        console.log('[private-batch] interval disabled (PRIVATE_BATCH_INTERVAL_MS <= 0)');
      }
    }

    const autoSettleIntervalMs = Number.parseInt(process.env.DAILY_AUTO_SETTLE_INTERVAL_MS || '60000', 10);
    if (autoSettleIntervalMs > 0) {
      console.log(`[daily-settle] enabled interval checker every ${autoSettleIntervalMs}ms`);
      setInterval(async () => {
        try {
          const snapshot = await loadWeatherSnapshot();
          const settledDates = await autoSettleDailyContestsFromSnapshot(snapshot);
          dailySettleState = await recordDailySettleRun(dailySettleState, 'interval-auto-settle', settledDates);
          if (settledDates.length > 0) {
            console.log(`[daily-settle] settled contest dates: ${settledDates.join(', ')}`);
          }
        } catch (error) {
          console.warn('[daily-settle] cycle failed:', error instanceof Error ? error.message : String(error));
        }
      }, autoSettleIntervalMs);
    } else {
      console.log('[daily-settle] interval disabled (DAILY_AUTO_SETTLE_INTERVAL_MS <= 0)');
    }

    const nightlySettleIntervalMs = Number.parseInt(process.env.DAILY_SETTLE_SCHEDULE_CHECK_MS || '60000', 10);
    if (nightlySettleIntervalMs > 0) {
      console.log('[daily-settle] scheduled nightly settle check enabled for 23:55 America/Los_Angeles');
      console.log(
        `[daily-settle] restored lastNightlyRunDate=${dailySettleState.lastNightlyRunDate || 'none'} lastNightlyRunAt=${dailySettleState.lastNightlyRunAtUnixMs || 'none'}`
      );
      setInterval(async () => {
        try {
          const now = pacificHourMinute(Date.now());
          if (now.hour !== 23 || now.minute < 55) return;
          if (lastDailySettleRunDate === now.date) return;
          const snapshot = await loadWeatherSnapshot();
          const settledDates = await autoSettleDailyContestsFromSnapshot(snapshot);
          lastDailySettleRunDate = now.date;
          dailySettleState = {
            ...(await recordDailySettleRun(dailySettleState, 'nightly-scheduled-settle', settledDates)),
            lastNightlyRunDate: now.date,
            lastNightlyRunAtUnixMs: Date.now(),
            lastNightlySettledDates: settledDates
          };
          await saveDailySettleState(dailySettleState);
          console.log(
            `[daily-settle] nightly run ${now.date} settled=${settledDates.length > 0 ? settledDates.join(', ') : 'none'}`
          );
        } catch (error) {
          console.warn('[daily-settle] nightly run failed:', error instanceof Error ? error.message : String(error));
        }
      }, nightlySettleIntervalMs);
    } else {
      console.log('[daily-settle] nightly scheduled settle disabled (DAILY_SETTLE_SCHEDULE_CHECK_MS <= 0)');
    }
  });
}

main().catch((error: unknown) => {
  console.error('[marketplace-server] failed:', error);
  process.exit(1);
});
