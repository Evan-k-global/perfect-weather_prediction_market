import './env.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountUpdate, Bool, Field, MerkleMap, MerkleMapWitness, Mina, Poseidon, PrivateKey, PublicKey, UInt32, UInt64, fetchAccount, fetchTransactionStatus } from 'o1js';
import { DEFAULT_STATE_FILE, loadOperatorState, type OperatorStateFile } from './state-store.js';
import {
  MARKET_CUTOFF_HOUR_LOCAL,
  currentActiveMarketDate,
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
import { PositionLeaf } from './contract.js';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { MarketLeaf } from './market-types.js';
import {
  assertLocalMarketsRootMatchesChain,
  assertLocalReceiptsRootMatchesChain,
  getLocalMarketsRoot,
  getLocalReceiptsRoot,
  getOnChainMarketsRoot,
  getOnChainReceiptsRoot
} from './fast-chain-state.js';
import {
  backupOperatorState,
  buildClaimedReceiptsMerkleMap,
  buildMarketsMerkleMap,
  buildReceiptsMerkleMap,
  deserializeMarketLeaf,
  deserializePositionLeaf,
  saveOperatorState,
  serializeMarketLeaf,
  serializePositionLeaf,
  type StoredMarketLeaf,
  type StoredMarketMeta,
  type StoredPositionLeaf,
  type StoredPositionMeta,
  type StoredReceiptMeta
} from './state-store.js';
import { isRetryableTxError, withTxRetry } from './tx-retry.js';
import { deriveDateKeyedMarketKey } from './payout-upgrade-types.js';
import { getSuggestedSequencerFee } from './sequencer-fee.js';
import { getFastNodeCompileCache } from './fast-compile-cache.js';

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
const FRESH_ZKAPP_ARCHIVE_DIR = './data/fresh-zkapp-archives';
const HOSTED_TX_BANLIST_FILE = './data/hosted-tx-banlist.json';
const CLAIM_STATUS_CACHE_TTL_MS = 30_000;
const RECEIPT_BACKFILL_TTL_MS = 5 * 60_000;

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
  newPositionLeaf?: ReturnType<typeof serializePositionLeaf>;
  receiptCommitment?: string | null;
  receiptSalt?: string | null;
  userNetPositionAfter: number;
  createdAtUnixMs: number;
};

type ReceiptBackfillCacheEntry = {
  attemptedAtUnixMs: number;
  recoveredCount: number;
};

type SerializedMerkleWitness = {
  isLefts: boolean[];
  siblings: string[];
};

type BrowserMarketBetContext = {
  network: {
    graphql: string;
    networkId: string;
  };
  zkappPublicKey: string;
  walletPublicKey: string;
  marketKey: string;
  marketDate: string | null;
  addTotalBet: number;
  addYesBet: number;
  receiptKey: string;
  receiptCommitment: string;
  ownerCommitment: string;
  fee: string;
  oldLeaf: StoredMarketLeaf;
  newLeaf: StoredMarketLeaf;
  marketWitness: SerializedMerkleWitness;
  receiptWitness: SerializedMerkleWitness;
};

type ClaimPayoutContext = {
  network: {
    graphql: string;
    networkId: string;
  };
  zkappPublicKey: string;
  walletPublicKey: string;
  fee: string;
  payoutTmina: string;
  marketKey: string;
  positionKey: string;
  receiptCommitment: string;
  ownerCommitment: string;
  addTotalBet: number;
  addYesBet: number;
  saltHash: string;
  resolvedLeaf: StoredMarketLeaf;
  marketWitness: SerializedMerkleWitness;
  receiptWitness: SerializedMerkleWitness;
  claimedReceiptWitness: SerializedMerkleWitness;
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

function emptyDailySettleState(): DailySettleState {
  return {
    lastNightlyRunDate: null,
    lastNightlyRunAtUnixMs: null,
    lastNightlySettledDates: [],
    lastAutoRunAtUnixMs: null,
    lastAutoRunSource: null,
    recentRuns: []
  };
}

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
const receiptBackfillCache = new Map<string, ReceiptBackfillCacheEntry>();
const claimTxStatusCache = new Map<string, { status: string; fetchedAtUnixMs: number }>();
const txSessionTokens = new Map<string, { caller: string; expiresAtUnixMs: number }>();
const lastTxSessionIssuedAtByCaller = new Map<string, number>();
const hostedTxBetCountsByFingerprint = new Map<string, { date: string; count: number }>();
const hostedTxLastBetAtByFingerprint = new Map<string, number>();
const persistentHostedBlockedCallers = new Set<string>();
const persistentHostedBlockedWallets = new Set<string>();
const privateBetQueue: PrivateQueuedBet[] = [];
const privateBatchHistory: PrivateBatchHistoryEntry[] = [];
let privateBatchInFlight = false;
let privateBatchLeaseStartedAtUnixMs: number | null = null;
let fastContractCompilePromise: Promise<void> | null = null;
let lastStateRefreshAtUnixMs = 0;
let backgroundStateRefreshPromise: Promise<void> | null = null;
let activeChainMutationLease: { owner: string; expiresAtUnixMs: number; kind: string } | null = null;

const CHAIN_MUTATION_LEASE_POLL_MS = 250;

function getHostedClaimSubmitTimeoutMs(): number {
  const explicit = process.env.CLAIM_SUBMITTED_TIMEOUT_MS;
  if (explicit !== undefined) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 10 * 60 * 1000;
}

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

function getHostedSafeIntervalMs(envName: string, localFallback: number): number {
  const explicit = process.env[envName];
  if (explicit !== undefined) {
    const parsed = Number.parseInt(explicit, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (process.env.RENDER === 'true' || process.env.IS_RENDER === 'true') {
    return 0;
  }
  return localFallback;
}

function shouldAssertChainRootsInBetContext(): boolean {
  const explicit = process.env.BET_CONTEXT_ASSERT_CHAIN_ROOTS;
  if (explicit !== undefined) {
    const normalized = explicit.trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(normalized);
  }
  return true;
}

function useLeanHostedBetContext(): boolean {
  if (process.env.RENDER === 'true' || process.env.IS_RENDER === 'true') {
    return true;
  }
  const explicit = process.env.LEAN_HOSTED_BET_CONTEXT;
  if (explicit === undefined) return false;
  const normalized = explicit.trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function useLocalServerBetProving(): boolean {
  const explicit = process.env.LOCAL_SERVER_BET_PROVING;
  if (explicit !== undefined) {
    const normalized = explicit.trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(normalized);
  }
  return !(process.env.RENDER === 'true' || process.env.IS_RENDER === 'true');
}

function getRemoteTxProverBaseUrl(): string | null {
  const raw = (process.env.TX_PROVER_BASE_URL || '').trim();
  if (!raw) return null;
  return (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, '');
}

function useRemoteTxProver(): boolean {
  if (useLocalServerBetProving()) return false;
  return Boolean(getRemoteTxProverBaseUrl());
}

function getRemoteTxProverToken(): string | null {
  const raw = (process.env.TX_PROVER_ACTION_TOKEN || '').trim();
  return raw.length > 0 ? raw : null;
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

function receiptCommitmentFromBet(params: {
  marketKey: string;
  addTotalBet: number;
  addYesBet: number;
  ownerCommitment: Field;
  salt: string;
}): Field {
  return Poseidon.hash([
    Field(params.marketKey),
    Field(params.addTotalBet),
    Field(params.addYesBet),
    params.ownerCommitment,
    fieldFromHexDigest(sha256Hex(`receipt-salt:${params.salt}`))
  ]);
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

function getChainMutationLeaseStatus() {
  if (activeChainMutationLease && activeChainMutationLease.expiresAtUnixMs <= Date.now()) {
    activeChainMutationLease = null;
  }
  return activeChainMutationLease;
}

async function acquireChainMutationLease(params: {
  owner: string;
  kind: string;
  holdMs: number;
  waitMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.waitMs;
  while (Date.now() <= deadline) {
    const current = getChainMutationLeaseStatus();
    if (!current || current.owner === params.owner) {
      activeChainMutationLease = {
        owner: params.owner,
        kind: params.kind,
        expiresAtUnixMs: Date.now() + params.holdMs
      };
      return;
    }
    await sleep(CHAIN_MUTATION_LEASE_POLL_MS);
  }
  const current = getChainMutationLeaseStatus();
  throw new Error(
    `chain mutation busy${current ? ` (${current.kind})` : ''}; retry shortly`
  );
}

function releaseChainMutationLease(owner: string): void {
  const current = getChainMutationLeaseStatus();
  if (current && current.owner === owner) {
    activeChainMutationLease = null;
  }
}

async function withChainMutationLease<T>(params: {
  owner: string;
  kind: string;
  holdMs: number;
  waitMs: number;
  work: () => Promise<T>;
}): Promise<T> {
  await acquireChainMutationLease(params);
  try {
    return await params.work();
  } finally {
    releaseChainMutationLease(params.owner);
  }
}

function callerLabel(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function requestUserAgent(req: IncomingMessage): string {
  const value = req.headers['user-agent'];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] || '' : '';
}

function requestHeaderLabel(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] || '' : '';
}

function logHostedTxRequest(req: IncomingMessage, path: string, event: string, detail = ''): void {
  const caller = callerLabel(req);
  const origin = requestHeaderLabel(req, 'origin') || '-';
  const referer = requestHeaderLabel(req, 'referer') || '-';
  const secFetchSite = requestHeaderLabel(req, 'sec-fetch-site') || '-';
  const secFetchMode = requestHeaderLabel(req, 'sec-fetch-mode') || '-';
  const userAgent = requestUserAgent(req) || '-';
  const suffix = detail ? ` detail=${detail}` : '';
  console.log(
    `[market] tx ${event} path=${path} caller=${caller} origin=${origin} referer=${referer} secFetchSite=${secFetchSite} secFetchMode=${secFetchMode} ua=${JSON.stringify(userAgent)}${suffix}`
  );
}

function appendLogDetail(detail: string, extra: string): string {
  if (!extra) return detail;
  return detail ? `${detail} ${extra}` : extra;
}

function envCsvSet(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function loadHostedTxBanlistFromDisk(): void {
  try {
    if (!existsSync(HOSTED_TX_BANLIST_FILE)) return;
    const raw = readFileSync(HOSTED_TX_BANLIST_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { callers?: unknown; wallets?: unknown };
    const callers = Array.isArray(parsed.callers) ? parsed.callers : [];
    const wallets = Array.isArray(parsed.wallets) ? parsed.wallets : [];
    for (const caller of callers) {
      if (typeof caller === 'string' && caller.trim()) persistentHostedBlockedCallers.add(caller.trim());
    }
    for (const wallet of wallets) {
      if (typeof wallet === 'string' && wallet.trim()) persistentHostedBlockedWallets.add(wallet.trim());
    }
  } catch (error) {
    console.warn('[market] failed to load hosted tx banlist:', error instanceof Error ? error.message : String(error));
  }
}

async function saveHostedTxBanlistToDisk(): Promise<void> {
  try {
    await mkdir(path.dirname(HOSTED_TX_BANLIST_FILE), { recursive: true });
    await writeFile(
      HOSTED_TX_BANLIST_FILE,
      JSON.stringify(
        {
          callers: Array.from(persistentHostedBlockedCallers).sort(),
          wallets: Array.from(persistentHostedBlockedWallets).sort()
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (error) {
    console.warn('[market] failed to save hosted tx banlist:', error instanceof Error ? error.message : String(error));
  }
}

function hostedTxCallerFingerprint(req: IncomingMessage): string {
  return `${callerLabel(req)}|${requestUserAgent(req)}`;
}

function requireHostedTxNotBlocked(
  req: IncomingMessage,
  path: string,
  detail: { walletPublicKey?: string | null } = {}
): void {
  const caller = callerLabel(req);
  const blockedCallers = envCsvSet('HOSTED_TX_BLOCKED_CALLERS');
  if (blockedCallers.has(caller) || persistentHostedBlockedCallers.has(caller)) {
    logHostedTxRequest(req, path, 'reject', appendLogDetail('', `blocked-caller=${caller}`));
    throw new Error('tx request rejected: blocked caller');
  }
  const wallet = detail.walletPublicKey || null;
  if (wallet) {
    const blockedWallets = envCsvSet('HOSTED_TX_BLOCKED_WALLETS');
    if (blockedWallets.has(wallet) || persistentHostedBlockedWallets.has(wallet)) {
      logHostedTxRequest(req, path, 'reject', appendLogDetail('', `blocked-wallet=${wallet}`));
      throw new Error('tx request rejected: blocked wallet');
    }
  }
}

async function recordHostedMarketBetAndMaybeBlock(
  req: IncomingMessage,
  path: string,
  walletPublicKey: string
): Promise<void> {
  const fingerprint = hostedTxCallerFingerprint(req);
  const cooldownMs = Number.parseInt(process.env.HOSTED_TX_MIN_SECONDS_BET_COOLDOWN || '60', 10) * 1000;
  const lastBetAt = hostedTxLastBetAtByFingerprint.get(fingerprint) || 0;
  if (cooldownMs > 0 && Date.now() - lastBetAt < cooldownMs) {
    logHostedTxRequest(req, path, 'reject', `bet-cooldown-ms=${cooldownMs}`);
    throw new Error('tx request rejected: hosted bet cooldown active');
  }
  hostedTxLastBetAtByFingerprint.set(fingerprint, Date.now());

  const maxPerDay = Number.parseInt(process.env.HOSTED_TX_MAX_BETS_PER_BROWSER_PER_DAY || '24', 10);
  if (!(maxPerDay > 0)) return;
  const todayIso = currentLocalDate();
  const existing = hostedTxBetCountsByFingerprint.get(fingerprint);
  const nextCount = existing && existing.date === todayIso ? existing.count + 1 : 1;
  hostedTxBetCountsByFingerprint.set(fingerprint, { date: todayIso, count: nextCount });
  if (nextCount > maxPerDay) {
    const caller = callerLabel(req);
    persistentHostedBlockedCallers.add(caller);
    persistentHostedBlockedWallets.add(walletPublicKey);
    await saveHostedTxBanlistToDisk();
    logHostedTxRequest(
      req,
      path,
      'reject',
      `auto-banned count=${nextCount} max=${maxPerDay} caller=${caller} wallet=${walletPublicKey}`
    );
    throw new Error('tx request rejected: hosted browser permanently banned after daily abuse limit');
  }
}

function pruneExpiredTxSessions(now = Date.now()): void {
  for (const [token, entry] of txSessionTokens.entries()) {
    if (entry.expiresAtUnixMs <= now) txSessionTokens.delete(token);
  }
}

function issueTxSessionToken(req: IncomingMessage): { token: string; expiresAtUnixMs: number } {
  pruneExpiredTxSessions();
  const caller = callerLabel(req);
  const minIntervalMs = Number.parseInt(process.env.HOSTED_TX_SESSION_MIN_INTERVAL_MS || '60000', 10);
  const lastIssuedAt = lastTxSessionIssuedAtByCaller.get(caller) || 0;
  if (minIntervalMs > 0 && Date.now() - lastIssuedAt < minIntervalMs) {
    logHostedTxRequest(req, '/api/tx/session', 'reject', `rate-limited minIntervalMs=${minIntervalMs}`);
    throw new Error('tx request rejected: tx session rate limited');
  }
  const token = randomUUID();
  const expiresAtUnixMs = Date.now() + 15 * 60 * 1000;
  txSessionTokens.set(token, {
    caller,
    expiresAtUnixMs
  });
  lastTxSessionIssuedAtByCaller.set(caller, Date.now());
  return { token, expiresAtUnixMs };
}

function requireHostedTxSession(req: IncomingMessage, isHosted: boolean, path: string): void {
  if (!isHosted) return;
  pruneExpiredTxSessions();
  const supplied = typeof req.headers['x-market-tx-session'] === 'string'
    ? req.headers['x-market-tx-session'].trim()
    : Array.isArray(req.headers['x-market-tx-session'])
    ? (req.headers['x-market-tx-session'][0] || '').trim()
    : '';
  if (!supplied) {
    logHostedTxRequest(req, path, 'reject', 'missing-tx-session');
    throw new Error('tx request rejected: missing tx session');
  }
  const entry = txSessionTokens.get(supplied);
  if (!entry) {
    logHostedTxRequest(req, path, 'reject', 'invalid-or-expired-tx-session');
    throw new Error('tx request rejected: invalid or expired tx session');
  }
  const caller = callerLabel(req);
  if (entry.caller !== caller) {
    logHostedTxRequest(req, path, 'reject', `tx-session-caller-mismatch expected=${entry.caller}`);
    throw new Error(`tx request rejected: tx session caller mismatch ${caller}`);
  }
}

function requireHostedTxOrigin(req: IncomingMessage, url: URL, isHosted: boolean, path: string): void {
  if (!isHosted) return;
  const host = req.headers.host;
  if (!host) {
    logHostedTxRequest(req, path, 'reject', 'missing-host');
    throw new Error('tx request rejected: missing host');
  }
  const expectedHost = url.host || host;
  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const rawReferer = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : '';

  const matchesHost = (value: string): boolean => {
    if (!value) return false;
    try {
      return new URL(value).host === expectedHost;
    } catch {
      return false;
    }
  };

  if (matchesHost(rawOrigin) || matchesHost(rawReferer)) return;
  logHostedTxRequest(req, path, 'reject', `cross-origin expectedHost=${expectedHost}`);
  throw new Error(`tx request rejected: cross-origin caller ${callerLabel(req)}`);
}

function requireHostedBrowserFetch(req: IncomingMessage, isHosted: boolean, path: string): void {
  if (!isHosted) return;
  const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'].trim().toLowerCase() : '';
  const secFetchMode = typeof req.headers['sec-fetch-mode'] === 'string' ? req.headers['sec-fetch-mode'].trim().toLowerCase() : '';
  if (secFetchSite !== 'same-origin') {
    logHostedTxRequest(req, path, 'reject', `invalid-fetch-site=${secFetchSite || 'missing'}`);
    throw new Error(`tx request rejected: invalid fetch site ${secFetchSite || 'missing'}`);
  }
  if (secFetchMode !== 'cors' && secFetchMode !== 'same-origin') {
    logHostedTxRequest(req, path, 'reject', `invalid-fetch-mode=${secFetchMode || 'missing'}`);
    throw new Error(`tx request rejected: invalid fetch mode ${secFetchMode || 'missing'}`);
  }
}

function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNetworkConfig() {
  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const archiveGraphql = process.env.ZEKO_ARCHIVE_GRAPHQL || graphql;
  const requestedNetworkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const isZekoTestnet = /testnet\.zeko\.io/i.test(graphql);
  const networkId = isZekoTestnet && requestedNetworkId === 'zeko' ? 'testnet' : requestedNetworkId;
  return { graphql, archiveGraphql, networkId };
}

function setActiveZekoNetwork() {
  const { graphql, archiveGraphql, networkId } = getNetworkConfig();
  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: archiveGraphql
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
    const shouldSettle = marketDate < todayIso || (marketDate === todayIso && nowHour >= 21);
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
      const seeded = seedFallbackRollingDailyMarkets(merged);
      if (changed || seeded.changed) {
        await saveDemoDailyMarkets(seeded.markets, filePath);
      }
      return seeded.markets;
    } catch {
      const seeded = seedFallbackRollingDailyMarkets(parsed);
      if (seeded.changed) {
        await saveDemoDailyMarkets(seeded.markets, filePath);
      }
      return seeded.markets;
    }
  } catch {
    try {
      const state = await loadOperatorState(process.env.STATE_FILE || DEFAULT_STATE_FILE);
      const { merged } = mergeDemoDailyMarketsWithOnChainState({}, state);
      const seeded = seedFallbackRollingDailyMarkets(merged);
      if (seeded.changed) {
        await saveDemoDailyMarkets(seeded.markets, filePath);
      }
      return seeded.markets;
    } catch {
      return seedFallbackRollingDailyMarkets({}).markets;
    }
  }
}

function seedFallbackRollingDailyMarkets(
  markets: Record<string, DemoDailyMarket>
): { markets: Record<string, DemoDailyMarket>; changed: boolean } {
  const todayIso = currentActiveMarketDate();
  const maxWindowDate = isoDateOffset(todayIso, 5);
  const currentEntries = Object.entries(markets).filter(([marketDate]) => marketDate >= todayIso && marketDate <= maxWindowDate);
  if (currentEntries.length > 0) {
    return { markets, changed: false };
  }
  const existingThresholds = Object.values(markets)
    .map((market) => Math.round(Number(market.thresholdF)))
    .filter((value) => Number.isFinite(value) && value > 0);
  const fallbackThreshold = existingThresholds.length > 0 ? existingThresholds[existingThresholds.length - 1] : 68;
  const seeded: Record<string, DemoDailyMarket> = { ...markets };
  for (let dayIndex = 0; dayIndex < 6; dayIndex += 1) {
    const marketDate = isoDateOffset(todayIso, dayIndex);
    if (!seeded[marketDate]) {
      seeded[marketDate] = {
        marketDate,
        marketKey: deriveDemoDateMarketKey(marketDate),
        thresholdF: fallbackThreshold,
        lockedAtUnixMs: Date.now(),
        sourceDayIndexWhenLocked: dayIndex,
        sourceForecastHighFWhenLocked: fallbackThreshold,
        totalPositionBet: 0,
        totalYesPositionBet: 0
      };
    }
  }
  return { markets: seeded, changed: true };
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
    zkappPublicKey: state.zkappPublicKey || getZkappPublicKey().toBase58(),
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
  const todayIso = currentActiveMarketDate();
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

async function readProjectedDemoDailyMarketsFromSnapshot(
  snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>,
  filePath: string = DEMO_DAILY_MARKETS_FILE
): Promise<DemoDailyMarket[]> {
  const existing = await loadDemoDailyMarkets(filePath);
  const todayIso = currentActiveMarketDate();
  const maxWindowDate = isoDateOffset(todayIso, 5);
  const trimmed: Record<string, DemoDailyMarket> = {};
  for (const [marketDate, market] of Object.entries(existing)) {
    if (marketDate >= todayIso && marketDate <= maxWindowDate) {
      trimmed[marketDate] = {
        ...market,
        marketKey:
          typeof market.marketKey === 'string' && market.marketKey.length > 0
            ? market.marketKey
            : deriveDemoDateMarketKey(marketDate)
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
  return Object.values(trimmed)
    .map((m) => ({
      ...m,
      marketKey: typeof m.marketKey === 'string' && m.marketKey.length > 0 ? m.marketKey : deriveDemoDateMarketKey(m.marketDate),
      totalPositionBet: Number.isFinite(m.totalPositionBet) ? m.totalPositionBet : 0,
      totalYesPositionBet: Number.isFinite(m.totalYesPositionBet) ? m.totalYesPositionBet : 0
    }))
    .sort((a, b) => (a.marketDate < b.marketDate ? -1 : a.marketDate > b.marketDate ? 1 : 0));
}

async function readDisplayDailyMarkets(
  state: Awaited<ReturnType<typeof loadOperatorState>>,
  snapshot: Awaited<ReturnType<typeof loadWeatherSnapshot>>
): Promise<DemoDailyMarket[]> {
  if (snapshot) {
    return await readProjectedDemoDailyMarketsFromSnapshot(snapshot);
  }
  const projected = await readProjectedDemoDailyMarketsFromSnapshot(null);
  if (projected.length > 0) {
    return projected;
  }
  return deriveDailyMarketsFromOnChainState(state);
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
  state: Awaited<ReturnType<typeof loadOperatorState>>
) {
  const viewList = toMarketViews(state, 0);
  const viewsByKey = new Map(viewList.map((m) => [String(m.marketKey), m]));
  const viewsByDate = new Map(
    viewList
      .map((m) => [marketDateFromViewTitle(m.title), m] as const)
      .filter((entry): entry is [string, (typeof viewList)[number]] => Boolean(entry[0]))
  );
  return dailyMarkets.map((market) => {
    const canonicalMarketKey = deriveDemoDateMarketKey(market.marketDate);
    const onChain =
      viewsByKey.get(canonicalMarketKey) ||
      viewsByKey.get(String(market.marketKey)) ||
      viewsByDate.get(market.marketDate) ||
      null;
    const basePoolTmina = onChain ? Number(onChain.totalPositionBet) : market.totalPositionBet;
    const baseOverTmina = onChain ? Number(onChain.totalYesPositionBet) : market.totalYesPositionBet;
    return {
      ...market,
      marketKey: onChain ? String(onChain.marketKey) : canonicalMarketKey,
      thresholdF: onChain ? Number(onChain.thresholdF) : market.thresholdF,
      totalPositionBet: basePoolTmina,
      totalYesPositionBet: baseOverTmina,
      onChainCreated: Boolean(onChain),
      onChainResolved: onChain ? Boolean(onChain.resolved) : false,
      onChainPoolTmina: onChain ? Number(onChain.totalPositionBet) : 0,
      onChainOverTmina: onChain ? Number(onChain.totalYesPositionBet) : 0,
      pendingPrivatePoolTmina: 0,
      pendingPrivateOverTmina: 0,
      projectedPoolTmina: basePoolTmina,
      projectedOverTmina: baseOverTmina
    };
  });
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
  if (process.env.DISABLE_OPERATOR_STATE_SYNC === '1') {
    console.warn('[state-sync] skipped because DISABLE_OPERATOR_STATE_SYNC=1');
    return;
  }
  await runProjectCommand(projectRoot, ['sync-state:zeko', '--', '--state-file', './data/operator-state.json']);
  lastStateRefreshAtUnixMs = Date.now();
}

function parseBooleanLike(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

async function refreshStateInBackground(projectRoot: string, reason: string): Promise<void> {
  if (backgroundStateRefreshPromise) return backgroundStateRefreshPromise;
  backgroundStateRefreshPromise = (async () => {
    try {
      await refreshState(projectRoot);
      console.log(`[state-sync] success reason=${reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryableTxError(error)) {
        console.warn(`[state-sync] skipped retryable failure reason=${reason}: ${message}`);
      } else {
        console.warn(`[state-sync] failed reason=${reason}: ${message}`);
      }
    } finally {
      backgroundStateRefreshPromise = null;
    }
  })();
  return backgroundStateRefreshPromise;
}

async function ensureRecentlySyncedState(projectRoot: string, maxAgeMs = 5 * 60 * 1000): Promise<void> {
  if (lastStateRefreshAtUnixMs > 0 && Date.now() - lastStateRefreshAtUnixMs <= maxAgeMs) return;
  await refreshState(projectRoot);
}

async function ensureFreshHostedProvingState(projectRoot: string): Promise<void> {
  const hostedFreshnessMs = Number.parseInt(process.env.HOSTED_PROVER_STATE_MAX_AGE_MS || '15000', 10);
  await ensureRecentlySyncedState(projectRoot, hostedFreshnessMs);
}

async function ensureDailyMarkets(projectRoot: string): Promise<void> {
  await refreshState(projectRoot);
  try {
    await runProjectCommand(projectRoot, [
      'ensure-daily-markets:zeko',
      '--',
      '--state-file',
      './data/operator-state.json',
      '--daily-markets-file',
      './data/demo-daily-threshold-markets.json'
    ]);
  } catch (error) {
    if (!isFreshStateMismatchError(error)) {
      throw error;
    }
    await refreshState(projectRoot);
    await runProjectCommand(projectRoot, [
      'ensure-daily-markets:zeko',
      '--',
      '--state-file',
      './data/operator-state.json',
      '--daily-markets-file',
      './data/demo-daily-threshold-markets.json'
    ]);
  }
}

async function bootstrapFastZkapp(projectRoot: string): Promise<void> {
  await runProjectCommand(projectRoot, ['bootstrap-fast-zkapp:zeko']);
}

function isFreshStateMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('marketsRoot mismatch') || message.includes('receiptsRoot mismatch');
}

function isRemoteProverStateDriftError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Field\.assertEquals\(\):\s+\d+\s+!=\s+\d+/.test(message) ||
    message.includes('marketsRoot mismatch') ||
    message.includes('receiptsRoot mismatch') ||
    message.includes('claimedReceiptsRoot')
  );
}

async function withFreshMarketStateRetry<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isFreshStateMismatchError(error)) throw error;
    await refreshState(projectRoot);
    return await work();
  }
}

async function withBetProofStateRetry<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isRemoteProverStateDriftError(error)) throw error;
    await refreshState(projectRoot);
    return await work();
  }
}

async function withRemoteProverStateRetry<T>(
  projectRoot: string,
  buildAndProve: () => Promise<T>
): Promise<T> {
  try {
    return await buildAndProve();
  } catch (error) {
    if (!isRemoteProverStateDriftError(error)) throw error;
    await refreshState(projectRoot);
    return await buildAndProve();
  }
}

async function ensureHostedBetBuildState(projectRoot: string, isHosted: boolean): Promise<void> {
  if (isHosted) {
    await refreshState(projectRoot);
    return;
  }
  await ensureRecentlySyncedState(projectRoot);
}

function serializeMerkleWitness(witness: { isLefts: Bool[]; siblings: Field[] }): SerializedMerkleWitness {
  return {
    isLefts: witness.isLefts.map((value) => value.toBoolean()),
    siblings: witness.siblings.map((value) => value.toString())
  };
}

type SyncParsedEvent = {
  type: string;
  data: Record<string, unknown>;
};

function extractSyncParsedEvents(rawEvents: unknown[]): SyncParsedEvent[] {
  const parsed: SyncParsedEvent[] = [];
  for (const item of rawEvents as Array<Record<string, unknown>>) {
    const flatType = typeof item.type === 'string' ? item.type : null;
    const flatData = item.event && typeof item.event === 'object' ? (item.event as Record<string, unknown>).data : null;
    if (flatType && flatData && typeof flatData === 'object' && !Array.isArray(flatData)) {
      parsed.push({ type: flatType, data: flatData as Record<string, unknown> });
      continue;
    }
    const nested = item.events;
    if (Array.isArray(nested)) {
      for (const nestedEvent of nested as Array<Record<string, unknown>>) {
        const t = typeof nestedEvent.type === 'string' ? nestedEvent.type : null;
        const d =
          nestedEvent.event && typeof nestedEvent.event === 'object'
            ? (nestedEvent.event as Record<string, unknown>).data
            : nestedEvent.data;
        if (t && d && typeof d === 'object' && !Array.isArray(d)) {
          parsed.push({ type: t, data: d as Record<string, unknown> });
        }
      }
    }
  }
  return parsed;
}

function asSyncField(value: unknown, fieldName: string): Field {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return Field(value);
  }
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return Field((value as { toString(): string }).toString());
  }
  throw new Error(`event field ${fieldName} missing`);
}

function asSyncUInt64(value: unknown, fieldName: string): UInt64 {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return UInt64.from(value);
  }
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return UInt64.from((value as { toString(): string }).toString());
  }
  throw new Error(`event field ${fieldName} missing`);
}

function asSyncBool(value: unknown, fieldName: string): Bool {
  const normalized =
    typeof value === 'boolean'
      ? value
        ? '1'
        : '0'
      : typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : typeof value === 'object' && value !== null && 'toString' in value
      ? (value as { toString(): string }).toString()
      : null;
  if (normalized === null) throw new Error(`event field ${fieldName} missing`);
  return Bool(normalized === '1' || normalized.toLowerCase() === 'true');
}

function buildAuthoritativeStateFromEvents(
  existingState: OperatorStateFile,
  rawEvents: unknown[],
  zkappPublicKey: string
): OperatorStateFile {
  const nextState: OperatorStateFile = {
    zkappPublicKey,
    markets: {},
    positions: existingState.positions || {},
    receipts: {},
    claimedReceipts: {},
    usedNonces: {},
    marketMeta: existingState.marketMeta || {},
    positionMeta: existingState.positionMeta || {},
    receiptMeta: existingState.receiptMeta || {}
  };
  for (const evt of extractSyncParsedEvents(rawEvents)) {
    try {
      if (evt.type === 'marketCreated' || evt.type === 'marketUpdated' || evt.type === 'marketResolved') {
        const data = evt.data;
        const marketKey = asSyncField(data.marketKey, 'marketKey').toString();
        const leaf = new MarketLeaf({
          configHash: asSyncField(data.configHash, 'configHash'),
          closeSlot: asSyncUInt64(data.closeSlot, 'closeSlot'),
          expirySlot: asSyncUInt64(data.expirySlot, 'expirySlot'),
          thresholdValueTenthC: asSyncUInt64(data.thresholdValueTenthC, 'thresholdValueTenthC'),
          totalPositionBet: asSyncUInt64(data.totalPositionBet, 'totalPositionBet'),
          totalYesPositionBet: asSyncUInt64(data.totalYesPositionBet, 'totalYesPositionBet'),
          resolved: asSyncBool(data.resolved, 'resolved'),
          outcome: asSyncBool(data.outcome, 'outcome'),
          oracleStatementHash: asSyncField(data.oracleStatementHash, 'oracleStatementHash')
        });
        nextState.markets[marketKey] = serializeMarketLeaf(leaf);
        if (data.oracleNonce) {
          nextState.usedNonces[asSyncField(data.oracleNonce, 'oracleNonce').toString()] = '1';
        }
      } else if (evt.type === 'receiptCommitted') {
        nextState.receipts ||= {};
        nextState.receipts[asSyncField(evt.data.receiptKey, 'receiptKey').toString()] = asSyncField(
          evt.data.receiptCommitment,
          'receiptCommitment'
        ).toString();
      } else if (evt.type === 'receiptClaimed') {
        nextState.claimedReceipts ||= {};
        nextState.claimedReceipts[asSyncField(evt.data.receiptKey, 'receiptKey').toString()] = '1';
      }
    } catch {
      // Ignore incompatible historical events from older contract versions.
    }
  }
  nextState.usedNonces = {
    ...(existingState.usedNonces || {}),
    ...(nextState.usedNonces || {})
  };
  return nextState;
}

async function loadLiveOperatorStateForHostedTxBuild(stateFile: string): Promise<OperatorStateFile> {
  const existingState = await loadOperatorState(stateFile);
  const { graphql, networkId } = getNetworkConfig();
  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);
  const zkapp = new FastPredictionMarketPlatform(getZkappPublicKey());
  const rawEvents = await zkapp.fetchEvents();
  return buildAuthoritativeStateFromEvents(existingState, rawEvents as unknown[], getZkappPublicKey().toBase58());
}

function deserializeMerkleWitness(serialized: SerializedMerkleWitness): MerkleMapWitness {
  return new MerkleMapWitness(
    serialized.isLefts.map((value) => Bool(Boolean(value))),
    serialized.siblings.map((value) => Field(value))
  );
}

async function ensureFastContractCompiled(): Promise<void> {
  if (!fastContractCompilePromise) {
    fastContractCompilePromise = FastPredictionMarketPlatform.compile({
      cache: getFastNodeCompileCache()
    }).then(() => undefined);
  }
  await fastContractCompilePromise;
}

async function buildBrowserFeePayerMarketBetContext(params: {
  stateFile: string;
  marketKey: string;
  addTotalBet: number;
  addYesBet: number;
  marketDate: string | null;
  feePayerPublicKey: string;
  userId: string;
  preferLiveHostedState?: boolean;
}): Promise<{
  intent: PendingTxIntent;
  fee: string;
  marketSummary: { totalPositionBet: string; totalYesPositionBet: string };
  buildContext: BrowserMarketBetContext;
}> {
  const { stateFile, marketKey, addTotalBet, addYesBet, marketDate, feePayerPublicKey, userId, preferLiveHostedState = false } = params;
  if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');

  setActiveZekoNetwork();
  const { graphql, networkId } = getNetworkConfig();
  const { feeRaw: txFee } = await getSuggestedSequencerFee(graphql);
  const zkappAddress = getZkappPublicKey();
  const state = preferLiveHostedState ? await loadLiveOperatorStateForHostedTxBuild(stateFile) : await loadOperatorState(stateFile);
  if (shouldAssertChainRootsInBetContext()) {
    await assertLocalMarketsRootMatchesChain(zkappAddress, state);
    await assertLocalReceiptsRootMatchesChain(zkappAddress, state);
  }
  const existing = state.markets[marketKey];
  if (!existing) throw new Error(`market ${marketKey} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('cannot trade a resolved market');
  if (!(addYesBet === 0 || addYesBet === addTotalBet)) {
    throw new Error('binary over/under stake requires addYesBet to be 0 or equal addTotalBet');
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
  const receiptsMap = buildReceiptsMerkleMap(state);
  const intentId = randomUUID();
  const receiptSalt = randomUUID();
  const positionKey = fieldFromHexDigest(
    sha256Hex(`${feePayerPublicKey}:${marketKey}:${marketDate || ''}:${intentId}:${Date.now()}`)
  );
  if ((state.receipts || {})[positionKey.toString()]) {
    throw new Error('receipt key collision; retry transaction build');
  }
  const ownerCommitment = ownerCommitmentFromWalletPublicKey(feePayerPublicKey);
  const receiptCommitment = receiptCommitmentFromBet({
    marketKey,
    addTotalBet,
    addYesBet,
    ownerCommitment,
    salt: receiptSalt
  });
  const positionLeaf = new PositionLeaf({
    marketKey: marketFieldKey,
    sideOver: Bool(addYesBet === addTotalBet),
    stake: UInt64.from(addTotalBet),
    ownerCommitment,
    claimed: Bool(false)
  });

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
    receiptCommitment: receiptCommitment.toString(),
    receiptSalt,
    userNetPositionAfter: next,
    createdAtUnixMs: Date.now()
  };
  pendingTxIntents[intent.id] = intent;

  return {
    intent,
    fee: txFee,
    marketSummary: {
      totalPositionBet: newLeaf.totalPositionBet.toString(),
      totalYesPositionBet: newLeaf.totalYesPositionBet.toString()
    },
    buildContext: {
      network: { graphql, networkId },
      zkappPublicKey: zkappAddress.toBase58(),
      walletPublicKey: feePayerPublicKey,
      marketKey,
      marketDate,
      addTotalBet,
      addYesBet,
      receiptKey: positionKey.toString(),
      receiptCommitment: receiptCommitment.toString(),
      ownerCommitment: ownerCommitment.toString(),
      fee: txFee,
      oldLeaf: serializeMarketLeaf(oldLeaf),
      newLeaf: serializeMarketLeaf(newLeaf),
      marketWitness: serializeMerkleWitness(marketsMap.getWitness(marketFieldKey)),
      receiptWitness: serializeMerkleWitness(receiptsMap.getWitness(positionKey))
    }
  };
}

async function buildLocalServerReceiptBetTx(context: BrowserMarketBetContext): Promise<unknown> {
  setActiveZekoNetwork();
  await ensureFastContractCompiled();

  const feePayer = PublicKey.fromBase58(context.walletPublicKey);
  const account = await fetchAccount({ publicKey: feePayer });
  if (account.error) {
    throw new Error(`fee payer account not found: ${account.error.statusText || 'unknown'}`);
  }

  const zkappAddress = PublicKey.fromBase58(context.zkappPublicKey);
  const marketKey = Field(context.marketKey);
  const receiptKey = Field(context.receiptKey);
  const receiptCommitment = Field(context.receiptCommitment);
  const ownerCommitment = Field(context.ownerCommitment);
  const oldLeaf = deserializeMarketLeaf(context.oldLeaf);
  const newLeaf = deserializeMarketLeaf(context.newLeaf);
  const marketWitness = deserializeMerkleWitness(context.marketWitness);
  const receiptWitness = deserializeMerkleWitness(context.receiptWitness);
  const betAmountNanomina = BigInt(context.addTotalBet) * 1_000_000_000n;
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);

  const tx = await Mina.transaction({ sender: feePayer, fee: context.fee }, async () => {
    const bettorPayment = AccountUpdate.createSigned(feePayer);
    bettorPayment.send({
      to: zkappAddress,
      amount: UInt64.from(betAmountNanomina)
    });
    await zkapp.placeReceiptBet(
      marketKey,
      oldLeaf,
      newLeaf,
      marketWitness,
      receiptKey,
      receiptCommitment,
      receiptWitness,
      ownerCommitment
    );
  });

  const feePayerUpdate = (tx as any).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }

  await tx.prove();
  return tx.toJSON();
}

async function buildLocalServerClaimReceiptTx(context: ClaimPayoutContext): Promise<unknown> {
  setActiveZekoNetwork();
  await ensureFastContractCompiled();

  const feePayer = PublicKey.fromBase58(context.walletPublicKey);
  const account = await fetchAccount({ publicKey: feePayer });
  if (account.error) {
    throw new Error(`fee payer account not found: ${account.error.statusText || 'unknown'}`);
  }

  const zkappAddress = PublicKey.fromBase58(context.zkappPublicKey);
  const zkapp = new FastPredictionMarketPlatform(zkappAddress);
  const tx = await Mina.transaction({ sender: feePayer, fee: context.fee }, async () => {
    await zkapp.claimReceiptPayout(
      Field(context.marketKey),
      deserializeMarketLeaf(context.resolvedLeaf),
      deserializeMerkleWitness(context.marketWitness),
      Field(context.positionKey),
      Field(context.receiptCommitment),
      deserializeMerkleWitness(context.receiptWitness),
      deserializeMerkleWitness(context.claimedReceiptWitness),
      feePayer,
      UInt64.from(context.addTotalBet),
      UInt64.from(context.addYesBet),
      Field(context.ownerCommitment),
      Field(context.saltHash)
    );
  });

  const feePayerUpdate = (tx as any).feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }

  await tx.prove();
  return tx.toJSON();
}

function getOracleActionToken(): string | null {
  const raw = process.env.ORACLE_ACTION_TOKEN || process.env.OPERATOR_ACTION_TOKEN;
  if (!raw) return null;
  const token = raw.trim();
  return token.length > 0 ? token : null;
}

function requireOracleAuthorization(req: IncomingMessage, body: Record<string, unknown> | null): void {
  const expected = getOracleActionToken();
  if (!expected) {
    throw new Error('oracle actions disabled: set ORACLE_ACTION_TOKEN');
  }
  const headerToken = req.headers['x-oracle-token'];
  const supplied =
    (typeof headerToken === 'string' ? headerToken : Array.isArray(headerToken) ? headerToken[0] : null) ||
    (body && typeof body.oracleToken === 'string' ? body.oracleToken : null);
  if (!supplied || supplied !== expected) {
    throw new Error('oracle authorization failed');
  }
}

function normalizeOracleStateImportBody(body: Record<string, unknown>): {
  markets: OperatorStateFile['markets'];
  marketMeta: NonNullable<OperatorStateFile['marketMeta']>;
  usedNonces: OperatorStateFile['usedNonces'];
  dailyMarkets: Record<string, DemoDailyMarket>;
  replaceExisting: boolean;
} {
  const unwrapped =
    typeof body.body === 'string' && body.body.trim().length > 0
      ? ((() => {
          try {
            return JSON.parse(body.body) as Record<string, unknown>;
          } catch {
            return body;
          }
        })())
      : body;
  return {
    markets: (unwrapped.markets as OperatorStateFile['markets']) || {},
    marketMeta: (unwrapped.marketMeta as NonNullable<OperatorStateFile['marketMeta']>) || {},
    usedNonces: (unwrapped.usedNonces as OperatorStateFile['usedNonces']) || {},
    dailyMarkets: (unwrapped.dailyMarkets as Record<string, DemoDailyMarket>) || {},
    replaceExisting: unwrapped.replaceExisting === true
  };
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

async function archiveJsonFileForFreshZkappReset(
  filePath: string,
  archiveDir: string
): Promise<{ file: string; archived: boolean }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, path.basename(filePath));
    await writeFile(archivePath, raw, 'utf8');
    return { file: filePath, archived: true };
  } catch {
    return { file: filePath, archived: false };
  }
}

async function maybeResetFreshZkappLocalState(
  stateFilePath: string,
  dailyMarketsFilePath: string
): Promise<void> {
  const currentZkappPublicKey = getZkappPublicKey().toBase58();
  const state = await loadOperatorState(stateFilePath);
  const storedZkappPublicKey = state.zkappPublicKey || null;
  const hasLegacyState =
    Object.keys(state.markets || {}).length > 0 ||
    Object.keys(state.receipts || {}).length > 0 ||
    Object.keys(state.claimedReceipts || {}).length > 0 ||
    Object.keys(state.marketMeta || {}).length > 0 ||
    Object.keys(state.positionMeta || {}).length > 0 ||
    Object.keys(state.receiptMeta || {}).length > 0;

  let shouldReset = false;
  if (storedZkappPublicKey && storedZkappPublicKey !== currentZkappPublicKey) {
    shouldReset = true;
  } else if (!storedZkappPublicKey && hasLegacyState) {
    try {
      const emptyRoot = new MerkleMap().getRoot().toString();
      const chainMarketsRoot = await getOnChainMarketsRoot(getZkappPublicKey());
      const chainReceiptsRoot = await getOnChainReceiptsRoot(getZkappPublicKey());
      shouldReset = chainMarketsRoot === emptyRoot && chainReceiptsRoot === emptyRoot;
    } catch {
      shouldReset = false;
    }
  }

  if (!shouldReset) return;

  const archiveDir = path.join(
    FRESH_ZKAPP_ARCHIVE_DIR,
    `${Date.now()}-${storedZkappPublicKey || 'legacy-unkeyed'}`
  );
  await archiveJsonFileForFreshZkappReset(stateFilePath, archiveDir);
  await archiveJsonFileForFreshZkappReset(dailyMarketsFilePath, archiveDir);

  const emptyState: OperatorStateFile = {
    zkappPublicKey: currentZkappPublicKey,
    markets: {},
    positions: {},
    receipts: {},
    claimedReceipts: {},
    usedNonces: {},
    marketMeta: {},
    positionMeta: {},
    receiptMeta: {}
  };
  await saveOperatorState(stateFilePath, emptyState);

  const existingDailyMarkets = await loadDemoDailyMarkets(dailyMarketsFilePath);
  await saveDemoDailyMarkets(sanitizeDailyMarketsForFreshZkappReset(existingDailyMarkets), dailyMarketsFilePath);
  console.log(
    `[fresh-zkapp-reset] archived legacy state and sanitized daily markets for new zkApp ${currentZkappPublicKey}`
  );
}

function sanitizeDailyMarketsForFreshZkappReset(
  markets: Record<string, DemoDailyMarket>
): Record<string, DemoDailyMarket> {
  const sanitized: Record<string, DemoDailyMarket> = {};
  for (const [marketDate, market] of Object.entries(markets || {})) {
    if (!market || typeof market !== 'object') continue;
    sanitized[marketDate] = {
      marketDate,
      marketKey: typeof market.marketKey === 'string' ? market.marketKey : deriveDemoDateMarketKey(marketDate),
      thresholdF: Number.isFinite(market.thresholdF) ? market.thresholdF : 0,
      lockedAtUnixMs: Number.isFinite(market.lockedAtUnixMs) ? market.lockedAtUnixMs : Date.now(),
      sourceDayIndexWhenLocked:
        Number.isFinite(market.sourceDayIndexWhenLocked) ? market.sourceDayIndexWhenLocked : 0,
      sourceForecastHighFWhenLocked:
        Number.isFinite(market.sourceForecastHighFWhenLocked) ? market.sourceForecastHighFWhenLocked : 0,
      totalPositionBet: 0,
      totalYesPositionBet: 0
    };
  }
  return sanitized;
}

function metaMatchesCurrentZkapp(
  meta: { zkappPublicKey?: string | null } | null | undefined,
  currentZkappPublicKey: string | null | undefined
): boolean {
  if (!meta) return false;
  if (!currentZkappPublicKey) return true;
  return meta.zkappPublicKey === currentZkappPublicKey;
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

function getReceiptFundingStatus(meta: { fundingStatus?: 'submitted' | 'confirmed' | null }): 'submitted' | 'confirmed' {
  return meta.fundingStatus === 'submitted' ? 'submitted' : 'confirmed';
}

function reconcileReceiptFundingStatuses(state: Awaited<ReturnType<typeof loadOperatorState>>): boolean {
  state.receiptMeta = state.receiptMeta || {};
  const receipts = state.receipts || {};
  let dirty = false;
  for (const [receiptKey, meta] of Object.entries(state.receiptMeta)) {
    if (!meta) continue;
    const onChainReceiptExists = Boolean(receipts[receiptKey]);
    if (onChainReceiptExists) {
      if (meta.fundingStatus !== 'confirmed') {
        meta.fundingStatus = 'confirmed';
        dirty = true;
      }
      if (!Number.isFinite(meta.fundingConfirmedAtUnixMs as number)) {
        meta.fundingConfirmedAtUnixMs = Date.now();
        dirty = true;
      }
      continue;
    }
    if (meta.fundingStatus === 'confirmed') {
      meta.fundingStatus = 'submitted';
      meta.fundingConfirmedAtUnixMs = null;
      dirty = true;
    }
  }
  return dirty;
}

function tminaToNanomina(valueTmina: bigint): bigint {
  return valueTmina * 1_000_000_000n;
}

async function listResolvedWalletPositions(
  walletPublicKey: string,
  stateFile: string
): Promise<ResolvedWalletPosition[]> {
  const { state, derivedResolvedOutcomes } = await reconcileSubmittedPayoutClaims(stateFile);
  const currentZkappPublicKey = state.zkappPublicKey || null;
  const ownerCommitment = ownerCommitmentFromWalletPublicKey(walletPublicKey).toString();
  const result: ResolvedWalletPosition[] = [];
  for (const [positionKey, storedPosition] of Object.entries(state.positions || {})) {
    const meta = state.positionMeta?.[positionKey];
    if (meta && !metaMatchesCurrentZkapp(meta, currentZkappPublicKey)) continue;
    const positionLeaf = deserializePositionLeaf(storedPosition);
    const metaMatchesWallet = Boolean(meta && meta.walletPublicKey === walletPublicKey);
    const leafMatchesWallet = positionLeaf.ownerCommitment.toString() === ownerCommitment;
    if (!metaMatchesWallet && !leafMatchesWallet) continue;
    const marketKey = meta?.marketKey || positionLeaf.marketKey.toString();
    const storedMarket = state.markets[marketKey];
    if (!storedMarket) continue;
    const marketLeaf = deserializeMarketLeaf(storedMarket);
    const { resolved, resolvedOutcome } = getEffectiveResolvedMarketState(marketLeaf, marketKey, derivedResolvedOutcomes);
    if (!resolved || !resolvedOutcome) continue;
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
  for (const [receiptKey, meta] of Object.entries(state.receiptMeta || {})) {
    if (!meta || meta.walletPublicKey !== walletPublicKey) continue;
    if (!metaMatchesCurrentZkapp(meta, currentZkappPublicKey)) continue;
    const storedMarket = state.markets[meta.marketKey];
    if (!storedMarket) continue;
    const marketLeaf = deserializeMarketLeaf(storedMarket);
    const { resolved, resolvedOutcome } = getEffectiveResolvedMarketState(marketLeaf, meta.marketKey, derivedResolvedOutcomes);
    if (!resolved || !resolvedOutcome) continue;
    const totalPot = BigInt(marketLeaf.totalPositionBet.toString());
    const totalYes = BigInt(marketLeaf.totalYesPositionBet.toString());
    const stake = BigInt(meta.stakeTmina);
    const won = meta.side === resolvedOutcome;
    const payout = won ? payoutNanominaForStake(totalPot, totalYes, marketLeaf.outcome.toBoolean(), stake) : 0n;
    result.push({
      positionKey: receiptKey,
      marketKey: meta.marketKey,
      marketDate: meta.marketDate || null,
      side: meta.side,
      stakeTmina: Number(stake),
      totalPotTmina: Number(totalPot),
      payoutTmina: Number(payout),
      resolvedOutcome,
      won,
      claimed: meta.claimStatus === 'confirmed',
      claimStatus: won ? (meta.claimStatus || 'claimable') : 'not-applicable',
      claimTxHash: meta.claimTxHash || null,
      claimSubmittedAtUnixMs: meta.claimSubmittedAtUnixMs || null,
      claimConfirmedAtUnixMs: meta.claimConfirmedAtUnixMs || null
    });
  }
  return result.sort((a, b) => {
    const ad = a.marketDate || '';
    const bd = b.marketDate || '';
    return ad < bd ? 1 : ad > bd ? -1 : 0;
  });
}

async function maybeBackfillReceiptMetaForWallet(
  walletPublicKey: string,
  stateFile: string
): Promise<{ attempted: boolean; recoveredCount: number }> {
  const cached = receiptBackfillCache.get(walletPublicKey);
  const now = Date.now();
  if (cached && now - cached.attemptedAtUnixMs < RECEIPT_BACKFILL_TTL_MS) {
    return { attempted: false, recoveredCount: cached.recoveredCount };
  }

  setActiveZekoNetwork();
  const zkapp = new FastPredictionMarketPlatform(getZkappPublicKey());
  const ownerCommitment = ownerCommitmentFromWalletPublicKey(walletPublicKey).toString();
  const state = await loadOperatorState(stateFile);
  const events = await zkapp.fetchEvents();
  const marketLeaves = new Map<string, StoredMarketLeaf>();
  const txDeltas = new Map<string, { marketKey: string; addTotalBet: number; addYesBet: number }>();
  let recoveredCount = 0;

  for (const evt of events) {
    const txHash = evt?.event?.transactionInfo?.transactionHash;
    if (!txHash) continue;
    if (evt.type === 'marketCreated' || evt.type === 'marketUpdated' || evt.type === 'marketResolved') {
      const data = evt.event.data as unknown as {
        marketKey: Field;
        configHash: Field;
        closeSlot: UInt64;
        expirySlot: UInt64;
        thresholdValueTenthC: UInt64;
        totalPositionBet: UInt64;
        totalYesPositionBet: UInt64;
        resolved: Bool;
        outcome: Bool;
        oracleStatementHash: Field;
      };
      const marketKey = data.marketKey.toString();
      const nextLeaf = serializeMarketLeaf(
        new MarketLeaf({
          configHash: data.configHash,
          closeSlot: data.closeSlot,
          expirySlot: data.expirySlot,
          thresholdValueTenthC: data.thresholdValueTenthC,
          totalPositionBet: data.totalPositionBet,
          totalYesPositionBet: data.totalYesPositionBet,
          resolved: data.resolved,
          outcome: data.outcome,
          oracleStatementHash: data.oracleStatementHash
        })
      );
      const previousLeaf = marketLeaves.get(marketKey);
      if (evt.type === 'marketUpdated' && previousLeaf) {
        const addTotalBet =
          Number(BigInt(nextLeaf.totalPositionBet) - BigInt(previousLeaf.totalPositionBet));
        const addYesBet =
          Number(BigInt(nextLeaf.totalYesPositionBet) - BigInt(previousLeaf.totalYesPositionBet));
        if (Number.isFinite(addTotalBet) && addTotalBet > 0 && Number.isFinite(addYesBet) && addYesBet >= 0) {
          txDeltas.set(txHash, { marketKey, addTotalBet, addYesBet });
        }
      }
      marketLeaves.set(marketKey, nextLeaf);
      continue;
    }
    if (evt.type !== 'receiptCommitted') continue;
    const data = evt.event.data as unknown as {
      receiptKey: Field;
      marketKey: Field;
      ownerCommitment: Field;
      receiptCommitment: Field;
    };
    if (data.ownerCommitment.toString() !== ownerCommitment) continue;
    const receiptKey = data.receiptKey.toString();
    if (state.receiptMeta?.[receiptKey]) continue;
    const delta = txDeltas.get(txHash);
    const marketKey = data.marketKey.toString();
    const addTotalBet = delta?.marketKey === marketKey ? delta.addTotalBet : null;
    const addYesBet = delta?.marketKey === marketKey ? delta.addYesBet : null;
    if (addTotalBet === null || addYesBet === null) continue;
    const side = addYesBet === addTotalBet ? 'over' : addYesBet === 0 ? 'under' : null;
    if (!side) continue;
    const marketDate = marketDateFromViewTitle(state.marketMeta?.[marketKey]?.title);
    state.receiptMeta = state.receiptMeta || {};
    state.receiptMeta[receiptKey] = {
      zkappPublicKey: state.zkappPublicKey || getZkappPublicKey().toBase58(),
      marketKey,
      marketDate,
      walletPublicKey,
      ownerCommitment,
      createdAtUnixMs: Number(evt.blockHeight?.toString?.() || 0),
      fundingTxHash: txHash,
      fundingStatus: 'confirmed',
      fundingSubmittedAtUnixMs: Number(evt.blockHeight?.toString?.() || 0),
      fundingConfirmedAtUnixMs: Number(evt.blockHeight?.toString?.() || 0),
      receiptCommitment: data.receiptCommitment.toString(),
      receiptSalt: '',
      side,
      stakeTmina: addTotalBet
    };
    recoveredCount += 1;
  }

  if (recoveredCount > 0) {
    await saveOperatorState(stateFile, state);
  }
  receiptBackfillCache.set(walletPublicKey, {
    attemptedAtUnixMs: now,
    recoveredCount
  });
  return { attempted: true, recoveredCount };
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

function finalizeReceiptClaimStatuses(state: Awaited<ReturnType<typeof loadOperatorState>>): boolean {
  let dirty = false;
  state.receiptMeta = state.receiptMeta || {};
  state.claimedReceipts = state.claimedReceipts || {};
  for (const [receiptKey, meta] of Object.entries(state.receiptMeta)) {
    if (!meta) continue;
    if (state.claimedReceipts[receiptKey] === '1') {
      if (meta.claimStatus !== 'confirmed') {
        meta.claimStatus = 'confirmed';
        dirty = true;
      }
      continue;
    }
    const storedMarket = state.markets[meta.marketKey];
    if (!storedMarket) continue;
    const marketLeaf = deserializeMarketLeaf(storedMarket);
    if (!marketLeaf.resolved.toBoolean()) continue;
    const won = meta.side === (marketLeaf.outcome.toBoolean() ? 'over' : 'under');
    if (meta.claimStatus === 'confirmed' || meta.claimStatus === 'submitted') continue;
    const nextStatus: StoredReceiptMeta['claimStatus'] = won ? 'claimable' : 'not-applicable';
    if (meta.claimStatus !== nextStatus) {
      meta.claimStatus = nextStatus;
      dirty = true;
    }
  }
  return dirty;
}

function markReceiptClaimConfirmed(state: Awaited<ReturnType<typeof loadOperatorState>>, receiptKey: string, confirmedAtUnixMs: number) {
  state.receiptMeta = state.receiptMeta || {};
  state.claimedReceipts = state.claimedReceipts || {};
  const meta = state.receiptMeta[receiptKey];
  if (!meta) return false;
  meta.claimStatus = 'confirmed';
  meta.claimConfirmedAtUnixMs = confirmedAtUnixMs;
  state.claimedReceipts[receiptKey] = '1';
  return true;
}

function resetSubmittedClaimForRetry(
  target: {
    claimStatus?: 'claimable' | 'submitted' | 'confirmed' | 'not-applicable' | null;
    claimTxHash?: string | null;
    claimSubmittedAtUnixMs?: number | null;
    claimConfirmedAtUnixMs?: number | null;
  } | null | undefined
): boolean {
  if (!target) return false;
  let dirty = false;
  if (target.claimStatus !== 'claimable') {
    target.claimStatus = 'claimable';
    dirty = true;
  }
  if (target.claimTxHash !== null) {
    target.claimTxHash = null;
    dirty = true;
  }
  if (target.claimSubmittedAtUnixMs !== null) {
    target.claimSubmittedAtUnixMs = null;
    dirty = true;
  }
  if (target.claimConfirmedAtUnixMs !== null) {
    target.claimConfirmedAtUnixMs = null;
    dirty = true;
  }
  return dirty;
}

type DerivedResolvedOutcomeMap = Map<string, 'over' | 'under'>;

function getEffectiveResolvedMarketState(
  marketLeaf: MarketLeaf | null,
  marketKey: string,
  derivedResolvedOutcomes: DerivedResolvedOutcomeMap
): { resolved: boolean; resolvedOutcome: 'over' | 'under' | null } {
  if (marketLeaf?.resolved.toBoolean()) {
    return {
      resolved: true,
      resolvedOutcome: marketLeaf.outcome.toBoolean() ? 'over' : 'under'
    };
  }
  const derived = derivedResolvedOutcomes.get(marketKey) || null;
  return {
    resolved: Boolean(derived),
    resolvedOutcome: derived
  };
}

async function recoverAndRecordReceiptClaimFinalize(params: {
  state: Awaited<ReturnType<typeof loadOperatorState>>;
  positionKey: string;
  marketKey: string;
  walletPublicKey: string;
  txHash: string;
  recordedAtUnixMs: number;
}): Promise<'submitted' | 'confirmed'> {
  const { state, positionKey, marketKey, walletPublicKey, txHash, recordedAtUnixMs } = params;
  state.positionMeta = state.positionMeta || {};
  state.receiptMeta = state.receiptMeta || {};

  const receiptMeta = state.receiptMeta[positionKey];
  const positionMeta = state.positionMeta[positionKey];
  const currentZkappPublicKey = state.zkappPublicKey || null;
  const targetMeta = positionMeta || receiptMeta;
  if (!targetMeta) throw new Error('claim metadata missing for payout claim');
  if (targetMeta.marketKey !== marketKey) throw new Error('claim market mismatch during finalize');
  if (targetMeta.walletPublicKey !== walletPublicKey) throw new Error('claim wallet mismatch during finalize');
  if (!metaMatchesCurrentZkapp(targetMeta, currentZkappPublicKey)) {
    throw new Error('claim metadata belongs to a different zkapp epoch');
  }

  targetMeta.claimStatus = 'submitted';
  targetMeta.claimTxHash = txHash;
  targetMeta.claimSubmittedAtUnixMs = recordedAtUnixMs;
  targetMeta.claimConfirmedAtUnixMs = null;

  try {
    setActiveZekoNetwork();
    const { graphql } = getNetworkConfig();
    const claimTxStatus = await fetchTransactionStatus(txHash, graphql);
    if (claimTxStatus === 'INCLUDED') {
      if (positionMeta) {
        markPositionClaimConfirmed(state, positionKey, Date.now());
      } else {
        markReceiptClaimConfirmed(state, positionKey, Date.now());
      }
      return 'confirmed';
    }
  } catch {
    // Leave claim in submitted state until a later refresh confirms inclusion.
  }

  return 'submitted';
}

async function reconcileSubmittedPayoutClaims(stateFile: string) {
  setActiveZekoNetwork();
  const state = await loadOperatorState(stateFile);
  let dirty = finalizeReceiptClaimStatuses(state);
  dirty = reconcileReceiptFundingStatuses(state) || dirty;
  const derivedResolvedOutcomes: DerivedResolvedOutcomeMap = new Map();
  const submittedTimeoutMs = getHostedClaimSubmitTimeoutMs();
  const pendingClaims = Object.entries(state.positionMeta || {}).filter(([, meta]) => {
    return Boolean(meta?.claimStatus === 'submitted' && meta?.claimTxHash);
  });
  const pendingReceiptClaims = Object.entries(state.receiptMeta || {}).filter(([, meta]) => {
    return Boolean(meta?.claimTxHash);
  });
  if (!pendingClaims.length && !pendingReceiptClaims.length) {
    if (dirty) {
      await saveOperatorState(stateFile, state);
    }
    return { state, derivedResolvedOutcomes };
  }
  const { graphql } = getNetworkConfig();
  const now = Date.now();
  for (const [positionKey, meta] of pendingClaims) {
    if (!meta?.claimTxHash) continue;
    try {
      const cached = claimTxStatusCache.get(meta.claimTxHash);
      const status =
        cached && now - cached.fetchedAtUnixMs < CLAIM_STATUS_CACHE_TTL_MS
          ? cached.status
          : await fetchTransactionStatus(meta.claimTxHash, graphql);
      if (!cached || now - cached.fetchedAtUnixMs >= CLAIM_STATUS_CACHE_TTL_MS) {
        claimTxStatusCache.set(meta.claimTxHash, { status, fetchedAtUnixMs: now });
      }
      if (status === 'INCLUDED') {
        dirty = markPositionClaimConfirmed(state, positionKey, Date.now()) || dirty;
      } else if (
        status !== 'INCLUDED' &&
        Number.isFinite(meta.claimSubmittedAtUnixMs) &&
        now - Number(meta.claimSubmittedAtUnixMs) >= submittedTimeoutMs
      ) {
        dirty = resetSubmittedClaimForRetry(meta) || dirty;
      }
    } catch {
      if (
        Number.isFinite(meta?.claimSubmittedAtUnixMs) &&
        now - Number(meta.claimSubmittedAtUnixMs) >= submittedTimeoutMs
      ) {
        dirty = resetSubmittedClaimForRetry(meta) || dirty;
      }
    }
  }
  for (const [receiptKey, meta] of pendingReceiptClaims) {
    if (!meta?.claimTxHash) continue;
    try {
      const cached = claimTxStatusCache.get(meta.claimTxHash);
      const status =
        cached && now - cached.fetchedAtUnixMs < CLAIM_STATUS_CACHE_TTL_MS
          ? cached.status
          : await fetchTransactionStatus(meta.claimTxHash, graphql);
      if (!cached || now - cached.fetchedAtUnixMs >= CLAIM_STATUS_CACHE_TTL_MS) {
        claimTxStatusCache.set(meta.claimTxHash, { status, fetchedAtUnixMs: now });
      }
      if (status === 'INCLUDED') {
        derivedResolvedOutcomes.set(meta.marketKey, meta.side);
        dirty = markReceiptClaimConfirmed(state, receiptKey, Date.now()) || dirty;
      } else if (
        meta.claimStatus === 'submitted' &&
        status !== 'INCLUDED' &&
        Number.isFinite(meta.claimSubmittedAtUnixMs) &&
        now - Number(meta.claimSubmittedAtUnixMs) >= submittedTimeoutMs
      ) {
        dirty = resetSubmittedClaimForRetry(meta) || dirty;
      }
    } catch {
      if (
        meta.claimStatus === 'submitted' &&
        Number.isFinite(meta?.claimSubmittedAtUnixMs) &&
        now - Number(meta.claimSubmittedAtUnixMs) >= submittedTimeoutMs
      ) {
        dirty = resetSubmittedClaimForRetry(meta) || dirty;
      }
    }
  }
  if (dirty) {
    await saveOperatorState(stateFile, state);
  }
  return { state, derivedResolvedOutcomes };
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
  const built = await buildClaimPayoutContext({
    stateFile,
    marketKey,
    positionKey,
    feePayerPublicKey
  });
  const tx = await buildLocalServerClaimReceiptTx(built.buildContext);
  const intent: PendingTxIntent = {
    id: randomUUID(),
    type: 'payout-claim',
    marketKey,
    marketDate: null,
    walletPublicKey: feePayerPublicKey,
    positionKey,
    addTotalBet: 0,
    addYesBet: 0,
    userId,
    newLeaf: null,
    userNetPositionAfter: 0,
    createdAtUnixMs: Date.now()
  };
  pendingTxIntents[intent.id] = intent;

  return {
    tx,
    fee: built.fee,
    intent,
    payoutSummary: built.payoutSummary
  };
}

async function buildClaimPayoutContext(params: {
  stateFile: string;
  marketKey: string;
  positionKey: string;
  feePayerPublicKey: string;
}): Promise<{
  fee: string;
  payoutSummary: { payoutTmina: string; marketKey: string; positionKey: string };
  buildContext: ClaimPayoutContext;
}> {
  const { stateFile, marketKey, positionKey, feePayerPublicKey } = params;
  setActiveZekoNetwork();
  const { graphql, networkId } = getNetworkConfig();
  const { feeRaw: txFee } = await getSuggestedSequencerFee(graphql);
  const zkappAddress = getZkappPublicKey();

  const { state, derivedResolvedOutcomes } = await reconcileSubmittedPayoutClaims(stateFile);
  if (shouldAssertChainRootsInBetContext()) {
    await assertLocalMarketsRootMatchesChain(zkappAddress, state);
    await assertLocalReceiptsRootMatchesChain(zkappAddress, state);
  }
  const meta = state.receiptMeta?.[positionKey];
  if (!meta) throw new Error('receipt metadata missing for payout claim');
  if (meta.walletPublicKey !== feePayerPublicKey) {
    throw new Error('wallet does not own this receipt position');
  }
  if (meta.marketKey !== marketKey) {
    throw new Error('receipt metadata market mismatch');
  }
  const storedMarket = state.markets[marketKey];
  if (!storedMarket) throw new Error('market missing for payout claim');
  const marketLeaf = deserializeMarketLeaf(storedMarket);
  const { resolved, resolvedOutcome } = getEffectiveResolvedMarketState(marketLeaf, marketKey, derivedResolvedOutcomes);
  if (!resolved || !resolvedOutcome) throw new Error('market is not resolved yet');
  const won = meta.side === resolvedOutcome;
  if (!won) throw new Error('receipt is not on the winning side');
  if (meta.claimStatus === 'submitted') throw new Error('claim already submitted');
  if (meta.claimStatus === 'confirmed') throw new Error('claim already confirmed');
  if (!meta.receiptSalt) throw new Error('receipt salt missing for payout claim');
  const payoutTmina = payoutNanominaForStake(
    BigInt(marketLeaf.totalPositionBet.toString()),
    BigInt(marketLeaf.totalYesPositionBet.toString()),
    marketLeaf.outcome.toBoolean(),
    BigInt(meta.stakeTmina)
  );
  if (payoutTmina <= 0n) throw new Error('no payout available for this receipt');
  const addTotalBet = Number(meta.stakeTmina);
  const addYesBet = meta.side === 'over' ? addTotalBet : 0;
  const receiptCommitment = receiptCommitmentFromBet({
    marketKey,
    addTotalBet,
    addYesBet,
    ownerCommitment: Field(meta.ownerCommitment),
    salt: meta.receiptSalt
  });
  if (receiptCommitment.toString() !== meta.receiptCommitment) {
    throw new Error('receipt commitment mismatch for payout claim');
  }
  const marketFieldKey = Field(marketKey);
  const receiptFieldKey = Field(positionKey);
  const marketsMap = buildMarketsMerkleMap(state);
  const receiptsMap = buildReceiptsMerkleMap(state);
  const claimedReceiptsMap = buildClaimedReceiptsMerkleMap(state);
  if ((state.claimedReceipts || {})[positionKey] === '1') {
    throw new Error('claim already confirmed');
  }

  return {
    fee: txFee,
    payoutSummary: {
      payoutTmina: payoutTmina.toString(),
      marketKey,
      positionKey
    },
    buildContext: {
      network: { graphql, networkId },
      zkappPublicKey: zkappAddress.toBase58(),
      walletPublicKey: feePayerPublicKey,
      fee: txFee,
      payoutTmina: payoutTmina.toString(),
      marketKey,
      positionKey
      ,
      receiptCommitment: meta.receiptCommitment,
      ownerCommitment: meta.ownerCommitment,
      addTotalBet,
      addYesBet,
      saltHash: fieldFromHexDigest(sha256Hex(`receipt-salt:${meta.receiptSalt}`)).toString(),
      resolvedLeaf: serializeMarketLeaf(marketLeaf),
      marketWitness: serializeMerkleWitness(marketsMap.getWitness(marketFieldKey)),
      receiptWitness: serializeMerkleWitness(receiptsMap.getWitness(receiptFieldKey)),
      claimedReceiptWitness: serializeMerkleWitness(claimedReceiptsMap.getWitness(receiptFieldKey))
    }
  };
}

async function requestRemoteTxProver<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = getRemoteTxProverBaseUrl();
  const token = getRemoteTxProverToken();
  if (!baseUrl) throw new Error('remote tx prover not configured: set TX_PROVER_BASE_URL');
  if (!token) throw new Error('remote tx prover not configured: set TX_PROVER_ACTION_TOKEN');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-prover-token': token
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        const snippet = text.slice(0, 160).replace(/\s+/g, ' ').trim();
        throw new Error(`remote tx prover returned non-JSON response (${res.status}): ${snippet}`);
      }
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `remote tx prover request ${endpoint} failed with status ${res.status}`);
    }
    return data as T;
  } catch (error) {
    throw new Error(`remote tx prover unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
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
  void params;
  throw new Error('private queued betting has been retired from this build');
}

async function main(): Promise<void> {
  loadHostedTxBanlistFromDisk();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, '..');
  const pagePath = path.resolve(projectRoot, 'public', 'marketplace.html');
  const publicRoot = path.resolve(projectRoot, 'public');
  const distRoot = path.resolve(projectRoot, 'dist');
  const o1jsWebRoot = path.resolve(projectRoot, 'node_modules', 'o1js', 'dist', 'web');
  const reflectRoot = path.resolve(projectRoot, 'node_modules', 'reflect-metadata');
  const isHosted = process.env.RENDER === 'true' || process.env.IS_RENDER === 'true';
  const port = Number.parseInt(process.env.MARKETPLACE_PORT || process.env.PORT || '8790', 10);
  const host = process.env.MARKETPLACE_HOST || (isHosted ? '0.0.0.0' : '127.0.0.1');
  const defaultStatePath = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const dailyMarketsPath = process.env.DEMO_DAILY_MARKETS_FILE || DEMO_DAILY_MARKETS_FILE;
  await maybeResetFreshZkappLocalState(defaultStatePath, dailyMarketsPath);
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

      if (req.method === 'GET' || req.method === 'HEAD') {
        let staticRoot: string | null = null;
        let rawPath: string | null = null;
        if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/public/')) {
          staticRoot = publicRoot;
          rawPath = url.pathname.startsWith('/public/')
            ? url.pathname.slice('/public/'.length)
            : url.pathname.slice(1);
        } else if (url.pathname.startsWith('/dist/')) {
          staticRoot = distRoot;
          rawPath = url.pathname.slice('/dist/'.length);
        } else if (url.pathname.startsWith('/vendor/o1js/')) {
          staticRoot = o1jsWebRoot;
          rawPath = url.pathname.slice('/vendor/o1js/'.length);
        } else if (url.pathname.startsWith('/vendor/reflect-metadata/')) {
          staticRoot = reflectRoot;
          rawPath = url.pathname.slice('/vendor/reflect-metadata/'.length);
        }
        if (staticRoot && rawPath !== null) {
          const normalized = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
          const target = path.resolve(staticRoot, normalized);
          if (!target.startsWith(staticRoot)) {
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
          network: getNetworkConfig(),
          dailySettle: dailySettleState,
          features: {
            manualWeatherRefreshEnabled: !(process.env.RENDER === 'true' || process.env.IS_RENDER === 'true'),
            localServerBetProvingEnabled: useLocalServerBetProving(),
            remoteTxProverEnabled: useRemoteTxProver()
          },
          ts: new Date().toISOString()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/root-status') {
        let zkappPublicKey: string | null = null;
        let zkappConfigError: string | null = null;
        let localMarketsRoot: string | null = null;
        let chainMarketsRoot: string | null = null;
        let localReceiptsRoot: string | null = null;
        let chainReceiptsRoot: string | null = null;
        let stateMtimeIso: string | null = null;
        let rootError: string | null = null;

        try {
          const zkapp = getZkappPublicKey();
          zkappPublicKey = zkapp.toBase58();
          const state = await loadOperatorState(defaultStatePath);
          localMarketsRoot = getLocalMarketsRoot(state);
          localReceiptsRoot = getLocalReceiptsRoot(state);
          try {
            const stateStat = await stat(defaultStatePath);
            stateMtimeIso = stateStat.mtime.toISOString();
          } catch {
            stateMtimeIso = null;
          }
          try {
            chainMarketsRoot = await getOnChainMarketsRoot(zkapp);
            chainReceiptsRoot = await getOnChainReceiptsRoot(zkapp);
          } catch (error) {
            rootError = error instanceof Error ? error.message : String(error);
          }
        } catch (error) {
          zkappConfigError = error instanceof Error ? error.message : String(error);
        }

        writeJson(res, 200, {
          ok: true,
          service: 'marketplace-root-status',
          zkappPublicKey,
          zkappConfigError,
          stateFile: defaultStatePath,
          stateMtimeIso,
          localMarketsRoot,
          chainMarketsRoot,
          marketsRootMatch:
            localMarketsRoot && chainMarketsRoot ? localMarketsRoot === chainMarketsRoot : null,
          localReceiptsRoot,
          chainReceiptsRoot,
          receiptsRootMatch:
            localReceiptsRoot && chainReceiptsRoot ? localReceiptsRoot === chainReceiptsRoot : null,
          rootError,
          ts: new Date().toISOString()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/operator/export-state') {
        requireOracleAuthorization(req, null);
        const state = await loadOperatorState(defaultStatePath);
        writeJson(res, 200, {
          ok: true,
          stateFile: defaultStatePath,
          state
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/operator/import-state') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        const state = (body as { state?: OperatorStateFile }).state;
        if (!state || typeof state !== 'object') {
          throw new Error('state payload required');
        }
        const replaceExisting = parseBooleanLike((body as Record<string, unknown>).replaceExisting, false);
        const existing = replaceExisting
          ? {
              markets: {},
              positions: {},
              receipts: {},
              claimedReceipts: {},
              usedNonces: {},
              marketMeta: {},
              positionMeta: {},
              receiptMeta: {}
            }
          : await loadOperatorState(defaultStatePath);
        const nextState: OperatorStateFile = {
          zkappPublicKey:
            typeof state.zkappPublicKey === 'string'
              ? state.zkappPublicKey
              : typeof existing.zkappPublicKey === 'string'
                ? existing.zkappPublicKey
                : undefined,
          markets: replaceExisting ? state.markets || {} : { ...(existing.markets || {}), ...(state.markets || {}) },
          positions:
            replaceExisting ? state.positions || {} : { ...(existing.positions || {}), ...(state.positions || {}) },
          receipts:
            replaceExisting ? state.receipts || {} : { ...(existing.receipts || {}), ...(state.receipts || {}) },
          claimedReceipts:
            replaceExisting
              ? state.claimedReceipts || {}
              : { ...(existing.claimedReceipts || {}), ...(state.claimedReceipts || {}) },
          usedNonces:
            replaceExisting ? state.usedNonces || {} : { ...(existing.usedNonces || {}), ...(state.usedNonces || {}) },
          marketMeta:
            replaceExisting ? state.marketMeta || {} : { ...(existing.marketMeta || {}), ...(state.marketMeta || {}) },
          positionMeta:
            replaceExisting
              ? state.positionMeta || {}
              : { ...(existing.positionMeta || {}), ...(state.positionMeta || {}) },
          receiptMeta:
            replaceExisting ? state.receiptMeta || {} : { ...(existing.receiptMeta || {}), ...(state.receiptMeta || {}) }
        };
        const backupPath = await backupOperatorState(
          defaultStatePath,
          replaceExisting ? 'pre-import-replace' : 'pre-import-merge'
        );
        await saveOperatorState(defaultStatePath, nextState);
        writeJson(res, 200, {
          ok: true,
          stateFile: defaultStatePath,
          replaceExisting,
          backupPath,
          markets: Object.keys(nextState.markets || {}).length,
          positions: Object.keys(nextState.positions || {}).length,
          receipts: Object.keys(nextState.receipts || {}).length,
          claimedReceipts: Object.keys(nextState.claimedReceipts || {}).length,
          usedNonces: Object.keys(nextState.usedNonces || {}).length
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

      if (req.method === 'POST' && url.pathname === '/api/tx/market-bet-context') {
        requireHostedBrowserFetch(req, isHosted, url.pathname);
        requireHostedTxOrigin(req, url, isHosted, url.pathname);
        requireHostedTxSession(req, isHosted, url.pathname);
        logHostedTxRequest(req, url.pathname, 'accept');
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
          const todayIso = currentActiveMarketDate();
          if (marketDate < todayIso) {
            throw new Error(`market date ${marketDate} is closed (past date). Today is ${todayIso}`);
          }
          const maxDate = isoDateOffset(todayIso, 5);
          if (marketDate > maxDate) {
            throw new Error(`market date ${marketDate} is outside rolling window (${todayIso} to ${maxDate})`);
          }
        }

        const buildBetContext = async () => {
          const currentState = await loadOperatorState(defaultStatePath);
          const selectedMarket = findSelectedOnChainMarket(currentState, marketKey, marketDate);
          if (!selectedMarket) {
            throw new Error(`market ${marketDate} is not active on-chain yet. Wait for oracle sync, then try again.`);
          }
          if (selectedThresholdF !== null && Number.isFinite(Number(selectedMarket.thresholdF))) {
            const onChainThresholdF = Math.round(Number(selectedMarket.thresholdF));
            if (onChainThresholdF !== selectedThresholdF) {
              throw new Error(
                `selected threshold ${selectedThresholdF}F does not match active on-chain threshold ${onChainThresholdF}F for ${marketDate}`
              );
            }
          }
          return await buildBrowserFeePayerMarketBetContext({
            stateFile: defaultStatePath,
            marketKey: String(selectedMarket.marketKey),
            addTotalBet: Math.floor(addTotalBet),
            addYesBet: Math.floor(addYesBet),
            marketDate,
            feePayerPublicKey: walletPublicKey,
            userId,
            preferLiveHostedState: false
          });
        };
        const built = useLeanHostedBetContext()
          ? await buildBetContext()
          : await withFreshMarketStateRetry(projectRoot, buildBetContext);
        writeJson(res, 200, {
          ok: true,
          mode: 'wallet-fee-payer-browser',
          intentId: built.intent.id,
          fee: built.fee,
          buildContext: built.buildContext,
          marketSummary: built.marketSummary
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/session') {
        requireHostedBrowserFetch(req, isHosted, url.pathname);
        requireHostedTxOrigin(req, url, isHosted, url.pathname);
        requireHostedTxNotBlocked(req, url.pathname);
        const session = issueTxSessionToken(req);
        logHostedTxRequest(req, url.pathname, 'issue-session', `expiresAtUnixMs=${session.expiresAtUnixMs}`);
        writeJson(res, 200, {
          ok: true,
          token: session.token,
          expiresAtUnixMs: session.expiresAtUnixMs
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/market-bet') {
        requireHostedBrowserFetch(req, isHosted, url.pathname);
        requireHostedTxOrigin(req, url, isHosted, url.pathname);
        requireHostedTxSession(req, isHosted, url.pathname);
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const addTotalBet = requireNumber(body.addTotalBet, 'addTotalBet');
        const addYesBet = requireNonNegativeNumber(body.addYesBet, 'addYesBet');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        requireHostedTxNotBlocked(req, url.pathname, { walletPublicKey });
        await recordHostedMarketBetAndMaybeBlock(req, url.pathname, walletPublicKey);
        logHostedTxRequest(
          req,
          url.pathname,
          'accept',
          `wallet=${walletPublicKey} marketKey=${marketKey} addTotalBet=${Math.floor(addTotalBet)} addYesBet=${Math.floor(addYesBet)}`
        );
        const marketDate = requireString(body.marketDate, 'marketDate');
        const selectedThresholdF =
          typeof body.thresholdF === 'number' && Number.isFinite(body.thresholdF) ? Math.round(body.thresholdF) : null;
        const userId = walletPublicKey;
        if (addYesBet > addTotalBet) throw new Error('addYesBet must be <= addTotalBet');
        if (!isHosted) {
          await ensureRecentlySyncedState(projectRoot);
        }

        const ensureLocalBettableMarket = async () => {
          let currentState = await loadOperatorState(defaultStatePath);
          let selectedMarket = findSelectedOnChainMarket(currentState, marketKey, marketDate);
          let createdOnDemand = false;
          if (!selectedMarket) {
            if (isHosted) {
              throw new Error(`market ${marketDate} is not active on-chain yet. Wait for oracle sync, then try again.`);
            }
            await ensureDailyMarkets(projectRoot);
            currentState = await loadOperatorState(defaultStatePath);
            selectedMarket = findSelectedOnChainMarket(currentState, marketKey, marketDate);
            createdOnDemand = true;
          }
          if (!selectedMarket) {
            throw new Error(`market ${marketDate} is not active on-chain yet. Local market creation was attempted, but the market is still unavailable.`);
          }
          return { currentState, selectedMarket, createdOnDemand };
        };
        const { selectedMarket, createdOnDemand } = await ensureLocalBettableMarket();
        if (!createdOnDemand && selectedThresholdF !== null && Number.isFinite(Number(selectedMarket.thresholdF))) {
          const onChainThresholdF = Math.round(Number(selectedMarket.thresholdF));
          if (onChainThresholdF !== selectedThresholdF) {
            throw new Error(
              `selected threshold ${selectedThresholdF}F does not match active on-chain threshold ${onChainThresholdF}F for ${marketDate}`
            );
          }
        }

        const txResult = useRemoteTxProver()
          ? await (async () => {
              const built = isHosted
                ? await buildBrowserFeePayerMarketBetContext({
                    stateFile: defaultStatePath,
                    marketKey: String(selectedMarket.marketKey),
                    addTotalBet: Math.floor(addTotalBet),
                    addYesBet: Math.floor(addYesBet),
                    marketDate,
                    feePayerPublicKey: walletPublicKey,
                    userId,
                    preferLiveHostedState: false
                  })
                : await withRemoteProverStateRetry(projectRoot, async () =>
                    await withFreshMarketStateRetry(projectRoot, async () =>
                      buildBrowserFeePayerMarketBetContext({
                        stateFile: defaultStatePath,
                        marketKey: String(selectedMarket.marketKey),
                        addTotalBet: Math.floor(addTotalBet),
                        addYesBet: Math.floor(addYesBet),
                        marketDate,
                        feePayerPublicKey: walletPublicKey,
                        userId
                      })
                    )
                  );
              const proved = await requestRemoteTxProver<{ ok: true; tx: unknown }>('/prove/market-bet', {
                context: built.buildContext
              });
              return { built, tx: proved.tx };
            })()
          : useLocalServerBetProving()
          ? await (async () => {
              const built = isHosted
                ? await buildBrowserFeePayerMarketBetContext({
                    stateFile: defaultStatePath,
                    marketKey: String(selectedMarket.marketKey),
                    addTotalBet: Math.floor(addTotalBet),
                    addYesBet: Math.floor(addYesBet),
                    marketDate,
                    feePayerPublicKey: walletPublicKey,
                    userId,
                    preferLiveHostedState: false
                  })
                : await withFreshMarketStateRetry(projectRoot, async () =>
                    buildBrowserFeePayerMarketBetContext({
                      stateFile: defaultStatePath,
                      marketKey: String(selectedMarket.marketKey),
                      addTotalBet: Math.floor(addTotalBet),
                      addYesBet: Math.floor(addYesBet),
                      marketDate,
                      feePayerPublicKey: walletPublicKey,
                      userId
                    })
                  );
              return {
                built,
                tx: await buildLocalServerReceiptBetTx(built.buildContext)
              };
            })()
          : (() => {
              throw new Error('no transaction proving path configured');
            })();
        const built = txResult.built;
        const tx = txResult.tx;
        writeJson(res, 200, {
          ok: true,
          mode: useRemoteTxProver() ? 'wallet-fee-payer-remote-prover' : 'wallet-fee-payer-local',
          intentId: built.intent.id,
          fee: built.fee,
          tx,
          marketSummary: built.marketSummary
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/market-close') {
        throw new Error('server-side market close is disabled on the fast client-bet path');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/claim-payout') {
        requireHostedBrowserFetch(req, isHosted, url.pathname);
        requireHostedTxOrigin(req, url, isHosted, url.pathname);
        requireHostedTxSession(req, isHosted, url.pathname);
        const body = await readJsonBody(req);
        const marketKey = requireString(body.marketKey, 'marketKey');
        const positionKey = requireString(body.positionKey, 'positionKey');
        const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
        requireHostedTxNotBlocked(req, url.pathname, { walletPublicKey });
        logHostedTxRequest(
          req,
          url.pathname,
          'accept',
          `wallet=${walletPublicKey} marketKey=${marketKey} positionKey=${positionKey}`
        );
        if (!isHosted) {
          await ensureRecentlySyncedState(projectRoot);
        }
        let fee: string;
        let payoutSummary: { payoutTmina: string; marketKey: string; positionKey: string };
        let tx: unknown;
        let intentId: string;
        let mode: string;

        if (useRemoteTxProver()) {
          const builtAndTx = await (async () => {
            const built = isHosted
              ? await buildClaimPayoutContext({
                  stateFile: defaultStatePath,
                  marketKey,
                  positionKey,
                  feePayerPublicKey: walletPublicKey
                })
              : await withRemoteProverStateRetry(projectRoot, async () =>
                  await withFreshMarketStateRetry(projectRoot, async () =>
                    buildClaimPayoutContext({
                      stateFile: defaultStatePath,
                      marketKey,
                      positionKey,
                      feePayerPublicKey: walletPublicKey
                    })
                  )
                );
            const proved = await requestRemoteTxProver<{ ok: true; tx: unknown }>('/prove/claim-payout', {
              context: built.buildContext
            });
            return { built, tx: proved.tx };
          })();
          tx = builtAndTx.tx;
          const built = builtAndTx.built;
          fee = built.fee;
          payoutSummary = built.payoutSummary;
          const intent: PendingTxIntent = {
            id: randomUUID(),
            type: 'payout-claim',
            marketKey,
            marketDate: null,
            walletPublicKey,
            positionKey,
            addTotalBet: 0,
            addYesBet: 0,
            userId: walletPublicKey,
            newLeaf: null,
            userNetPositionAfter: 0,
            createdAtUnixMs: Date.now()
          };
          pendingTxIntents[intent.id] = intent;
          intentId = intent.id;
          mode = 'wallet-fee-payer-remote-prover';
        } else {
          const built = isHosted
            ? await buildWalletFeePayerClaimPayoutTx({
                stateFile: defaultStatePath,
                marketKey,
                positionKey,
                feePayerPublicKey: walletPublicKey,
                userId: walletPublicKey
              })
            : await withFreshMarketStateRetry(projectRoot, async () =>
                buildWalletFeePayerClaimPayoutTx({
                  stateFile: defaultStatePath,
                  marketKey,
                  positionKey,
                  feePayerPublicKey: walletPublicKey,
                  userId: walletPublicKey
                })
              );
          tx = built.tx;
          fee = built.fee;
          payoutSummary = built.payoutSummary;
          intentId = built.intent.id;
          mode = 'wallet-fee-payer';
        }

        writeJson(res, 200, {
          ok: true,
          mode,
          action: 'claim-payout',
          intentId,
          fee,
          tx,
          payoutSummary
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tx/finalize') {
        requireHostedBrowserFetch(req, isHosted, url.pathname);
        requireHostedTxOrigin(req, url, isHosted, url.pathname);
        requireHostedTxSession(req, isHosted, url.pathname);
        logHostedTxRequest(req, url.pathname, 'accept');
        const body = await readJsonBody(req);
        const intentId = requireString(body.intentId, 'intentId');
        const txHash = requireString(body.txHash, 'txHash');
        const intent = pendingTxIntents[intentId];
        const state = await loadOperatorState(defaultStatePath);
        if (!intent) {
          const fallbackType = typeof body.type === 'string' ? body.type : '';
          if (fallbackType !== 'payout-claim') throw new Error('intent not found or expired');
          const marketKey = requireString(body.marketKey, 'marketKey');
          const positionKey = requireString(body.positionKey, 'positionKey');
          const walletPublicKey = requireString(body.walletPublicKey, 'walletPublicKey');
          const claimStatus = await recoverAndRecordReceiptClaimFinalize({
            state,
            positionKey,
            marketKey,
            walletPublicKey,
            txHash,
            recordedAtUnixMs: Date.now()
          });
          await saveOperatorState(defaultStatePath, state);
          writeJson(res, 200, {
            ok: true,
            recovered: true,
            txHash,
            type: 'payout-claim',
            marketKey,
            userId: walletPublicKey,
            claimStatus
          });
          return;
        }
        if (Date.now() - intent.createdAtUnixMs > 15 * 60 * 1000) {
          delete pendingTxIntents[intentId];
          throw new Error('intent expired; rebuild transaction');
        }
        if (intent.type === 'market-bet' && intent.newLeaf) {
          if (!intent.receiptCommitment) {
            throw new Error('receipt commitment missing for market bet finalize');
          }
          state.receiptMeta = state.receiptMeta || {};
          state.receiptMeta[intent.positionKey] = {
            zkappPublicKey: state.zkappPublicKey || getZkappPublicKey().toBase58(),
            marketKey: intent.marketKey,
            marketDate: intent.marketDate,
            walletPublicKey: intent.walletPublicKey,
            ownerCommitment: ownerCommitmentFromWalletPublicKey(intent.walletPublicKey).toString(),
            createdAtUnixMs: intent.createdAtUnixMs,
            fundingTxHash: txHash,
            fundingStatus: 'submitted',
            fundingSubmittedAtUnixMs: Date.now(),
            fundingConfirmedAtUnixMs: null,
            receiptCommitment: intent.receiptCommitment,
            receiptSalt: intent.receiptSalt || '',
            side: intent.addYesBet === intent.addTotalBet ? 'over' : 'under',
            stakeTmina: intent.addTotalBet
          };
        } else if (intent.type === 'payout-claim') {
          await recoverAndRecordReceiptClaimFinalize({
            state,
            positionKey: intent.positionKey,
            marketKey: intent.marketKey,
            walletPublicKey: intent.walletPublicKey,
            txHash,
            recordedAtUnixMs: Date.now()
          });
        }
        await saveOperatorState(defaultStatePath, state);

        if (intent.type === 'market-bet' || intent.type === 'payout-claim') {
          try {
            await refreshState(projectRoot);
            const refreshed = await loadOperatorState(defaultStatePath);
            if (intent.type === 'market-bet') {
              refreshed.receiptMeta = refreshed.receiptMeta || {};
              const refreshedMeta = refreshed.receiptMeta[intent.positionKey];
              if (refreshedMeta && refreshed.receipts?.[intent.positionKey]) {
                refreshedMeta.fundingStatus = 'confirmed';
                refreshedMeta.fundingConfirmedAtUnixMs = refreshedMeta.fundingConfirmedAtUnixMs || Date.now();
              }
            }
            await saveOperatorState(defaultStatePath, refreshed);
          } catch (error) {
            lastStateRefreshAtUnixMs = 0;
            console.warn(
              intent.type === 'market-bet' ? '[finalize] post-bet sync failed:' : '[finalize] post-claim sync failed:',
              error instanceof Error ? error.message : String(error)
            );
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
              ? state.positionMeta?.[intent.positionKey]?.claimStatus || state.receiptMeta?.[intent.positionKey]?.claimStatus || 'submitted'
              : undefined
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/payouts/resolved-markets') {
        const walletPublicKey = requireString(url.searchParams.get('walletPublicKey'), 'walletPublicKey');
        let positions = await listResolvedWalletPositions(walletPublicKey, defaultStatePath);
        const repaired = await maybeBackfillReceiptMetaForWallet(walletPublicKey, defaultStatePath);
        const recoveredCount = repaired.recoveredCount;
        if (repaired.recoveredCount > 0) {
          positions = await listResolvedWalletPositions(walletPublicKey, defaultStatePath);
        }
        writeJson(res, 200, {
          ok: true,
          walletPublicKey,
          count: positions.length,
          positions,
          recoveredCount,
          note: 'Winning resolved receipt bets can be claimed here after daily finalization. Losing resolved bets remain visible for history.'
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/wallet/activity') {
        const walletPublicKey = requireString(url.searchParams.get('walletPublicKey'), 'walletPublicKey');
        const { state, derivedResolvedOutcomes } = await reconcileSubmittedPayoutClaims(defaultStatePath);
        const currentZkappPublicKey = state.zkappPublicKey || null;
        const positions = Object.entries(state.positionMeta || {})
          .filter(([, meta]) => meta?.walletPublicKey === walletPublicKey && metaMatchesCurrentZkapp(meta, currentZkappPublicKey))
          .map(([positionKey, meta]) => {
            const storedPosition = state.positions[positionKey];
            const storedMarket = state.markets[meta.marketKey];
            const positionLeaf = storedPosition ? deserializePositionLeaf(storedPosition) : null;
            const marketLeaf = storedMarket ? deserializeMarketLeaf(storedMarket) : null;
            const side = positionLeaf?.sideOver.toBoolean() ? 'over' : 'under';
            const { resolved, resolvedOutcome } = getEffectiveResolvedMarketState(
              marketLeaf,
              meta.marketKey,
              derivedResolvedOutcomes
            );
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
          .sort((a, b) => (b.createdAtUnixMs || 0) - (a.createdAtUnixMs || 0));
        const receiptPositions = Object.entries(state.receiptMeta || {})
          .filter(([, meta]) => meta?.walletPublicKey === walletPublicKey && metaMatchesCurrentZkapp(meta, currentZkappPublicKey))
          .map(([receiptKey, meta]) => {
            const storedMarket = state.markets[meta.marketKey];
            const marketLeaf = storedMarket ? deserializeMarketLeaf(storedMarket) : null;
            const { resolved, resolvedOutcome } = getEffectiveResolvedMarketState(
              marketLeaf,
              meta.marketKey,
              derivedResolvedOutcomes
            );
            const won = resolved && resolvedOutcome ? meta.side === resolvedOutcome : null;
            const claimStatus =
              resolved
                ? won
                  ? meta.claimStatus || 'claimable'
                  : 'not-applicable'
                : 'receipt-pending-claims-phase';
            return {
              type: 'position' as const,
              positionKey: receiptKey,
              marketKey: meta.marketKey,
              marketDate: meta.marketDate,
              side: meta.side,
              stakeTmina: meta.stakeTmina,
              createdAtUnixMs: meta.createdAtUnixMs,
              fundingTxHash: meta.fundingTxHash,
              fundingStatus: getReceiptFundingStatus(meta),
              resolved,
              resolvedOutcome,
              won,
              claimed: meta.claimStatus === 'confirmed',
              claimStatus,
              claimTxHash: meta.claimTxHash || null
            };
          })
          .sort((a, b) => (b.createdAtUnixMs || 0) - (a.createdAtUnixMs || 0));
        const combinedPositions = [...receiptPositions, ...positions].sort(
          (a, b) => (b.createdAtUnixMs || 0) - (a.createdAtUnixMs || 0)
        );
        writeJson(res, 200, {
          ok: true,
          walletPublicKey,
          queuedCount: 0,
          positionCount: combinedPositions.length,
          queued: [],
          positions: combinedPositions
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

      if (req.method === 'POST' && url.pathname === '/api/oracle/weather-sync') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        const { snapshot, tlsnStatus } = parseOracleWorkerSyncPayload(body);
        await saveWeatherSnapshot(snapshot as NonNullable<typeof snapshot>);
        await saveTlsnStatus(tlsnStatus ?? null);
        await ensureDemoDailyMarketsFromSnapshot(snapshot);
        const selectedDate = snapshot.localDate || currentLocalDate();
        let contest = await loadContestState(selectedDate, 15, contestStateFileForDate(selectedDate));
        contest = maybeAutoSettleContest(contest, snapshot, nowLocalHour(), Date.now());
        await saveContestState(contest, contestStateFileForDate(selectedDate));
        const autoSettledDates = await autoSettleDailyContestsFromSnapshot(snapshot);
        dailySettleState = await recordDailySettleRun(dailySettleState, 'oracle-sync', autoSettledDates);
        writeJson(res, 200, {
          ok: true,
          snapshotVerified: snapshot.verified,
          verificationMode: snapshot.verificationMode,
          autoSettledDates
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/oracle/export-state') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        if (lastStateRefreshAtUnixMs === 0 || Date.now() - lastStateRefreshAtUnixMs > 30_000) {
          await refreshStateInBackground(projectRoot, 'oracle-export');
        }
        const state = await loadOperatorState(defaultStatePath);
        const dailyMarkets = await loadDemoDailyMarkets(process.env.DEMO_DAILY_MARKETS_FILE || DEMO_DAILY_MARKETS_FILE);
        writeJson(res, 200, {
          ok: true,
          state,
          dailyMarkets
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/oracle/acquire-chain-lease') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        const owner = requireString(body.owner, 'owner');
        const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'oracle-chain-actions';
        const holdMs = Math.min(
          Math.max(Number.parseInt(String(body.holdMs || '0'), 10) || 180_000, 5_000),
          10 * 60_000
        );
        const waitMs = Math.min(
          Math.max(Number.parseInt(String(body.waitMs || '0'), 10) || 120_000, 1_000),
          10 * 60_000
        );
        await acquireChainMutationLease({ owner, kind, holdMs, waitMs });
        writeJson(res, 200, { ok: true, owner, kind, holdMs });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/oracle/release-chain-lease') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        const owner = requireString(body.owner, 'owner');
        releaseChainMutationLease(owner);
        writeJson(res, 200, { ok: true, owner });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/oracle/import-state') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        const imported = normalizeOracleStateImportBody(body as Record<string, unknown>);
        const dailyMarketsPath = process.env.DEMO_DAILY_MARKETS_FILE || DEMO_DAILY_MARKETS_FILE;
        let existingDailyMarkets: Record<string, DemoDailyMarket> | null = null;
        if (Object.keys(imported.dailyMarkets || {}).length > 0) {
          existingDailyMarkets = await loadDemoDailyMarkets(dailyMarketsPath);
        }

        const state = await loadOperatorState(defaultStatePath);
        state.markets = imported.replaceExisting
          ? { ...(imported.markets || {}) }
          : {
              ...(state.markets || {}),
              ...(imported.markets || {})
            };
        state.marketMeta = imported.replaceExisting
          ? { ...(imported.marketMeta || {}) }
          : {
              ...(state.marketMeta || {}),
              ...(imported.marketMeta || {})
            };
        state.usedNonces = imported.replaceExisting
          ? { ...(imported.usedNonces || {}) }
          : {
              ...(state.usedNonces || {}),
              ...(imported.usedNonces || {})
            };
        await saveOperatorState(defaultStatePath, state);

        if (existingDailyMarkets) {
          await saveDemoDailyMarkets(
            imported.replaceExisting
              ? { ...imported.dailyMarkets }
              : {
                  ...existingDailyMarkets,
                  ...imported.dailyMarkets
                },
            dailyMarketsPath
          );
        }

        writeJson(res, 200, {
          ok: true,
          replaceExisting: imported.replaceExisting,
          marketsImported: Object.keys(imported.markets || {}).length,
          marketMetaImported: Object.keys(imported.marketMeta || {}).length,
          dailyMarketsImported: Object.keys(imported.dailyMarkets || {}).length,
          usedNoncesImported: Object.keys(imported.usedNonces || {}).length
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/oracle/resolve-daily-market') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        const marketDate = requireString(body.marketDate, 'marketDate');
        await refreshState(projectRoot);
        const output = await runProjectCommand(projectRoot, [
          'resolve-daily-market:zeko',
          '--',
          '--market-date',
          marketDate,
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

      if (req.method === 'POST' && url.pathname === '/api/oracle/ensure-daily-markets') {
        const body = await readJsonBody(req);
        requireOracleAuthorization(req, body as Record<string, unknown>);
        await refreshState(projectRoot);
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
        const eligible = marketDate < todayIso || (marketDate === todayIso && nowLocalHour() >= MARKET_CUTOFF_HOUR_LOCAL);
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
        const baseDailyMarkets = await readDisplayDailyMarkets(state, snapshot);
        const dailyMarkets = attachOnChainDailyMarketState(
          await withDailySettlementInfo(withCurrentForecast(baseDailyMarkets, snapshot)),
          state
        );
        const contest = await loadContestState(selectedDate, 15, contestStateFileForDate(selectedDate));
        const autoSettledDates: string[] = [];
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
        const baseDailyMarkets = await readDisplayDailyMarkets(state, snapshot);
        const dailyMarkets = attachOnChainDailyMarketState(
          await withDailySettlementInfo(withCurrentForecast(baseDailyMarkets, snapshot)),
          state
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
    console.log(`[network] graphql=${net.graphql} networkId=${net.networkId}`);
    privateBetQueue.splice(0, privateBetQueue.length);
    console.log('[fast-path] private queue disabled in this build');

    const autoSettleIntervalMs = getHostedSafeIntervalMs('DAILY_AUTO_SETTLE_INTERVAL_MS', 60000);
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

    const nightlySettleIntervalMs = getHostedSafeIntervalMs('DAILY_SETTLE_SCHEDULE_CHECK_MS', 60000);
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

    const hostedStateSyncIntervalRaw = process.env.HOSTED_STATE_SYNC_INTERVAL_MS;
    const hostedStateSyncIntervalMs =
      hostedStateSyncIntervalRaw !== undefined
        ? Math.max(0, Number.parseInt(hostedStateSyncIntervalRaw, 10) || 0)
        : 15000;
    if (process.env.DISABLE_OPERATOR_STATE_SYNC === '1') {
      console.log('[state-sync] background sync disabled (DISABLE_OPERATOR_STATE_SYNC=1)');
    } else if (hostedStateSyncIntervalMs > 0) {
      console.log(`[state-sync] background sync enabled every ${hostedStateSyncIntervalMs}ms`);
      void refreshStateInBackground(projectRoot, 'startup');
      setInterval(() => {
        void refreshStateInBackground(projectRoot, 'interval');
      }, hostedStateSyncIntervalMs);
    } else {
      console.log('[state-sync] background sync disabled (HOSTED_STATE_SYNC_INTERVAL_MS <= 0)');
    }
  });
}

main().catch((error: unknown) => {
  console.error('[marketplace-server] failed:', error);
  process.exit(1);
});
