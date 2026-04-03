import './env.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runWeatherAttestation } from './weather-attest.js';
import { DEFAULT_STATE_FILE, saveOperatorState, type OperatorStateFile, type StoredMarketMeta } from './state-store.js';
import { isRetryableTxError } from './tx-retry.js';
import {
  currentActiveMarketDate,
  NWS_94027_REQUEST_PATH,
  NWS_94027_SERVER_NAME,
  NWS_94027_STRICT_URL,
  currentLocalDate,
  nowLocalHour,
  snapshotFromTlsnAttestation
} from './weather-service.js';
import { verifyTlsnAttestationFile } from './tlsn-verifier.js';

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function envEnabled(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  return fallback;
}

async function readTlsnStatus(filePath: string): Promise<{ stage: string; ok: boolean; ts: string; message?: string } | null> {
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

async function req(baseUrl: string, oracleToken: string, endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-oracle-token': oracleToken
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const snippet = text.slice(0, 160).replace(/\s+/g, ' ').trim();
      throw new Error(`request ${endpoint} returned non-JSON response (status ${res.status}): ${snippet}`);
    }
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `request ${endpoint} failed with status ${res.status}`);
  }
  return data;
}

async function waitForMarketReady(baseUrl: string, maxAttempts: number, delayMs: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/ready`, {
        method: 'GET',
        headers: { 'cache-control': 'no-store' }
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { ready?: boolean } | null;
        if (data?.ready === true) {
          console.log(`[oracle-worker] market ready after ${attempt} check(s)`);
          return;
        }
      }
    } catch {}
    if (attempt < maxAttempts) {
      console.log(`[oracle-worker] waiting for market readiness attempt=${attempt}/${maxAttempts}`);
      await sleep(delayMs);
    }
  }
  throw new Error(`market did not become ready after ${maxAttempts} readiness checks`);
}

function marketDateFromTitle(title: string | undefined): string | null {
  if (!title) return null;
  const match = /^Atherton, CA - (\d{4}-\d{2}-\d{2}) Over\/Under \d+F$/.exec(title);
  return match ? match[1] : null;
}

function collectMarketDates(
  state: OperatorStateFile,
  dailyMarkets: Record<string, unknown>
): Map<string, string> {
  const byMarketKey = new Map<string, string>();

  for (const [marketKey, meta] of Object.entries(state.marketMeta || {})) {
    const marketDate = marketDateFromTitle((meta as StoredMarketMeta | undefined)?.title);
    if (marketDate) byMarketKey.set(marketKey, marketDate);
  }

  for (const [marketDate, value] of Object.entries(dailyMarkets || {})) {
    const marketKey = (value as { marketKey?: unknown } | null)?.marketKey;
    if (typeof marketKey === 'string' && marketKey.length > 0 && !byMarketKey.has(marketKey)) {
      byMarketKey.set(marketKey, marketDate);
    }
  }

  for (const meta of Object.values(state.positionMeta || {})) {
    if (!meta || typeof meta.marketKey !== 'string' || typeof meta.marketDate !== 'string' || !meta.marketDate) continue;
    if (!byMarketKey.has(meta.marketKey)) {
      byMarketKey.set(meta.marketKey, meta.marketDate);
    }
  }

  for (const meta of Object.values(state.receiptMeta || {})) {
    if (!meta || typeof meta.marketKey !== 'string' || typeof meta.marketDate !== 'string' || !meta.marketDate) continue;
    if (!byMarketKey.has(meta.marketKey)) {
      byMarketKey.set(meta.marketKey, meta.marketDate);
    }
  }

  return byMarketKey;
}

async function saveDailyMarketsFile(
  filePath: string,
  dailyMarkets: Record<string, unknown>
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(dailyMarkets, null, 2), 'utf8');
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function changedKeys<T>(before: Record<string, T> | undefined, after: Record<string, T> | undefined): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(after || {})) {
    if (JSON.stringify((before || {})[key]) !== JSON.stringify(value)) {
      result[key] = value;
    }
  }
  return result;
}

let lastEnsureDate: string | null = null;
let lastResolveWindowKey: string | null = null;

function shouldRunEnsurePass(todayIso: string): boolean {
  return lastEnsureDate !== todayIso;
}

function shouldRunResolvePass(
  todayIso: string,
  nowHour: number,
  state: OperatorStateFile,
  dailyMarkets: Record<string, unknown>
): {
  shouldRun: boolean;
  windowKey: string | null;
  pastDueUnresolvedDates: string[];
  eligibleTodayDates: string[];
} {
  const pastDueUnresolvedDates: string[] = [];
  const eligibleTodayDates: string[] = [];
  const marketDates = collectMarketDates(state, dailyMarkets);
  for (const [marketKey, marketDate] of marketDates.entries()) {
    const stored = state.markets[marketKey];
    if (!marketDate || !stored || stored.resolved === '1') continue;
    if (marketDate < todayIso) {
      pastDueUnresolvedDates.push(marketDate);
      continue;
    }
    if (marketDate === todayIso && nowHour >= 21) {
      eligibleTodayDates.push(marketDate);
    }
  }
  if (pastDueUnresolvedDates.length > 0) {
    const windowKey = `${todayIso}-past-due`;
    return {
      shouldRun: lastResolveWindowKey !== windowKey,
      windowKey,
      pastDueUnresolvedDates,
      eligibleTodayDates
    };
  }
  if (eligibleTodayDates.length > 0) {
    const windowKey = `${todayIso}-after-21`;
    return {
      shouldRun: lastResolveWindowKey !== windowKey,
      windowKey,
      pastDueUnresolvedDates,
      eligibleTodayDates
    };
  }
  return { shouldRun: false, windowKey: null, pastDueUnresolvedDates, eligibleTodayDates };
}

async function maybeRunChainActions(baseUrl: string, oracleToken: string): Promise<void> {
  if (!envEnabled('ORACLE_WORKER_ENABLE_CHAIN_ACTIONS', true)) return;
  const todayIso = currentLocalDate();
  const activeMarketDate = currentActiveMarketDate();
  const nowHour = nowLocalHour();
  const runEnsurePass = shouldRunEnsurePass(activeMarketDate);
  const exportPayload = await req(baseUrl, oracleToken, '/api/oracle/export-state', {});
  const state = exportPayload?.state as OperatorStateFile | null;
  const dailyMarkets = (exportPayload?.dailyMarkets || {}) as Record<string, unknown>;
  if (!state) return;
  const resolveDecision = shouldRunResolvePass(todayIso, nowHour, state, dailyMarkets);
  const runResolvePass = resolveDecision.shouldRun;
  console.log(
    `[oracle-worker] resolve candidates today=${todayIso} hour=${nowHour} past_due=${resolveDecision.pastDueUnresolvedDates.join(',') || 'none'} today_eligible=${resolveDecision.eligibleTodayDates.join(',') || 'none'}`
  );
  if (!runEnsurePass && !runResolvePass) {
    console.log('[oracle-worker] skipping chain actions; no daily lifecycle work due');
    return;
  }

  const stateFile = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const dailyMarketsFile = process.env.DEMO_DAILY_MARKETS_FILE || './data/demo-daily-threshold-markets.json';
  await saveOperatorState(stateFile, state);
  await saveDailyMarketsFile(dailyMarketsFile, dailyMarkets);

  const projectRoot = process.cwd();
  const leaseOwner = `oracle:${randomUUID()}`;
  await req(baseUrl, oracleToken, '/api/oracle/acquire-chain-lease', {
    owner: leaseOwner,
    kind: 'oracle-chain-actions',
    holdMs: 10 * 60 * 1000,
    waitMs: 2 * 60 * 1000
  });
  try {
    const syncArgs = ['sync-state:zeko', '--', '--state-file', stateFile];
    try {
      const synced = await execFileAsync('pnpm', syncArgs, { cwd: projectRoot, env: process.env });
      if (synced.stdout.trim()) console.log(synced.stdout.trim());
      if (synced.stderr.trim()) console.error(synced.stderr.trim());
    } catch (error) {
      if (!isRetryableTxError(error)) {
        throw error;
      }
      console.warn(
        `[oracle-worker] transient sync-state failure; skipping chain actions this cycle: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    if (runEnsurePass) {
      const ensureArgs = [
        'ensure-daily-markets:zeko',
        '--',
        '--state-file',
        stateFile,
        '--daily-markets-file',
        dailyMarketsFile
      ];
      const ensured = await execFileAsync('pnpm', ensureArgs, { cwd: projectRoot, env: process.env });
      if (ensured.stdout.trim()) console.log(ensured.stdout.trim());
      if (ensured.stderr.trim()) console.error(ensured.stderr.trim());
      lastEnsureDate = activeMarketDate;
    }

    const updatedStateAfterEnsure = await loadJsonFile<OperatorStateFile>(stateFile);
    const updatedDailyMarketsAfterEnsure = await loadJsonFile<Record<string, unknown>>(dailyMarketsFile);
    const marketDates = collectMarketDates(updatedStateAfterEnsure, updatedDailyMarketsAfterEnsure);
    if (runResolvePass) {
      const targetDates = new Set([
        ...resolveDecision.pastDueUnresolvedDates,
        ...resolveDecision.eligibleTodayDates
      ]);
      for (const [marketKey, marketDate] of marketDates.entries()) {
        const stored = updatedStateAfterEnsure.markets[marketKey];
        if (!marketDate || !stored || stored.resolved === '1') continue;
        const shouldResolve = targetDates.has(marketDate);
        if (!shouldResolve) continue;
        const resolveArgs = [
          'resolve-daily-market:zeko',
          '--',
          '--market-date',
          marketDate,
          '--state-file',
          stateFile
        ];
        console.log(`[oracle-worker] resolving marketDate=${marketDate}`);
        const resolved = await execFileAsync('pnpm', resolveArgs, { cwd: projectRoot, env: process.env });
        if (resolved.stdout.trim()) console.log(resolved.stdout.trim());
        if (resolved.stderr.trim()) console.error(resolved.stderr.trim());
      }
      lastResolveWindowKey = resolveDecision.windowKey;
    }

    const finalState = await loadJsonFile<OperatorStateFile>(stateFile);
    const finalDailyMarkets = await loadJsonFile<Record<string, unknown>>(dailyMarketsFile);
    const markets = changedKeys(state.markets || {}, finalState.markets || {});
    const marketMeta = changedKeys(state.marketMeta || {}, finalState.marketMeta || {});
    const usedNonces = changedKeys(state.usedNonces || {}, finalState.usedNonces || {});
    const changedDailyMarkets = changedKeys(dailyMarkets, finalDailyMarkets);
    if (
      Object.keys(markets).length === 0 &&
      Object.keys(marketMeta).length === 0 &&
      Object.keys(usedNonces).length === 0 &&
      Object.keys(changedDailyMarkets).length === 0
    ) {
      return;
    }
    const imported = await req(baseUrl, oracleToken, '/api/oracle/import-state', {
      markets,
      marketMeta,
      usedNonces,
      dailyMarkets: changedDailyMarkets
    });
    console.log(
      `[oracle-worker] imported chain actions markets=${imported.marketsImported} marketMeta=${imported.marketMetaImported} dailyMarkets=${imported.dailyMarketsImported} usedNonces=${imported.usedNoncesImported}`
    );
  } finally {
    try {
      await req(baseUrl, oracleToken, '/api/oracle/release-chain-lease', { owner: leaseOwner });
    } catch (error) {
      console.warn('[oracle-worker] failed to release chain lease:', error instanceof Error ? error.message : String(error));
    }
  }
}

async function runCycle(baseUrl: string, oracleToken: string): Promise<void> {
  try {
    await runWeatherAttestation();
    const attestationPath = process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json';
    const statusPath = process.env.TLSN_STATUS_FILE || './data/tlsn-output/latest/status.json';
    const maxAgeMs = Number.parseInt(process.env.WEATHER_TLSN_MAX_AGE_MS || '3600000', 10);
    const strict = process.env.WEATHER_REQUIRE_TLSN === '1';
    const { attestation, report } = await verifyTlsnAttestationFile(attestationPath, {
      allowedServerName: NWS_94027_SERVER_NAME,
      allowedRequestPath: NWS_94027_REQUEST_PATH,
      maxAgeMs,
      maxFutureSkewMs: 0,
      strict,
      nowMs: Date.now()
    });
    const snapshot = snapshotFromTlsnAttestation(attestation, report, NWS_94027_STRICT_URL);
    const tlsnStatus = (await readTlsnStatus(statusPath)) || {
      stage: 'done',
      ok: true,
      ts: new Date(snapshot.fetchedAtUnixMs).toISOString(),
      message: 'oracle worker verified snapshot'
    };
    const result = await req(baseUrl, oracleToken, '/api/oracle/weather-sync', {
      snapshot,
      tlsnStatus
    });
    console.log(
      `[oracle-worker] synced snapshot verified=${result.snapshotVerified ? 'yes' : 'no'} mode=${result.verificationMode}`
    );
  } catch (error) {
    console.error('[oracle-worker] weather sync failed, continuing with chain actions:', error);
  }
  await maybeRunChainActions(baseUrl, oracleToken);
}

async function main(): Promise<void> {
  const rawBaseUrl = (process.env.MARKET_BASE_URL || process.env.OPERATOR_BASE_URL || '').trim();
  const baseUrl = (/^https?:\/\//i.test(rawBaseUrl) ? rawBaseUrl : rawBaseUrl ? `http://${rawBaseUrl}` : '').replace(
    /\/+$/,
    ''
  );
  if (!baseUrl) throw new Error('Missing env MARKET_BASE_URL');
  const oracleToken = process.env.ORACLE_ACTION_TOKEN || process.env.OPERATOR_ACTION_TOKEN;
  if (!oracleToken) throw new Error('Missing env ORACLE_ACTION_TOKEN');
  const intervalMs = envInt('ORACLE_WORKER_INTERVAL_MS', 30 * 60 * 1000);
  const retryMs = envInt('ORACLE_WORKER_RETRY_MS', 60 * 1000);
  const startDelayMs = envInt('ORACLE_WORKER_START_DELAY_MS', 5000);
  process.env.WEATHER_REQUIRE_TLSN = process.env.WEATHER_REQUIRE_TLSN || '1';
  process.env.WEATHER_TLSN_ATTESTATION_FILE =
    process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json';

  console.log(`[oracle-worker] market_base_url=${baseUrl}`);
  console.log(`[oracle-worker] interval_ms=${intervalMs} retry_ms=${retryMs} start_delay_ms=${startDelayMs}`);
  console.log(`[oracle-worker] chain_actions=${envEnabled('ORACLE_WORKER_ENABLE_CHAIN_ACTIONS', true) ? 'enabled' : 'disabled'}`);
  if (startDelayMs > 0) {
    console.log(`[oracle-worker] initial delay ${startDelayMs}ms`);
    await sleep(startDelayMs);
  }
  await waitForMarketReady(baseUrl, envInt('ORACLE_WORKER_READY_CHECK_ATTEMPTS', 20), envInt('ORACLE_WORKER_READY_CHECK_DELAY_MS', 3000));

  let cycle = 0;
  while (true) {
    cycle += 1;
    const started = Date.now();
    console.log(`[oracle-worker] cycle=${cycle} start=${new Date().toISOString()}`);
    try {
      await runCycle(baseUrl, oracleToken);
      console.log(`[oracle-worker] cycle=${cycle} done=${new Date().toISOString()}`);
      const elapsed = Date.now() - started;
      await sleep(Math.max(1000, intervalMs - elapsed));
    } catch (error) {
      console.error(`[oracle-worker] cycle=${cycle} failed:`, error);
      await sleep(retryMs);
    }
  }
}

main().catch((error) => {
  console.error('[oracle-worker] fatal:', error);
  process.exit(1);
});
