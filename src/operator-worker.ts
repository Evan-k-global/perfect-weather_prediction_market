import './env.js';

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_STATE_FILE, loadOperatorState, saveOperatorState, type OperatorStateFile } from './state-store.js';
import { proveAndSendPrivateQueuedBet, type PrivateQueuedBet } from './private-batch-processor.js';

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

function envEnabled(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  return fallback;
}

function envOptionalInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

const baseUrl = requireEnv('OPERATOR_BASE_URL').replace(/\/+$/, '');
const operatorToken = requireEnv('OPERATOR_ACTION_TOKEN');
const localStatePath = process.env.STATE_FILE || DEFAULT_STATE_FILE;
const localDailyMarketsPath = process.env.DEMO_DAILY_MARKETS_FILE || './data/demo-daily-threshold-markets.json';

async function saveDailyMarketsFile(filePath: string, dailyMarkets: Record<string, unknown>): Promise<void> {
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

async function ensureQueuedMarketExists(
  batch: PrivateQueuedBet,
  state: OperatorStateFile,
  dailyMarkets: Record<string, unknown>
): Promise<void> {
  if (!batch.marketDate || state.markets?.[batch.marketKey]) return;
  await saveOperatorState(localStatePath, state);
  await saveDailyMarketsFile(localDailyMarketsPath, dailyMarkets);
  const { stdout, stderr } = await execFileAsync(
    'pnpm',
    [
      'ensure-daily-markets:zeko',
      '--',
      '--state-file',
      localStatePath,
      '--daily-markets-file',
      localDailyMarketsPath
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 8
    }
  );
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  const finalState = await loadOperatorState(localStatePath);
  const finalDailyMarkets = await loadJsonFile<Record<string, unknown>>(localDailyMarketsPath);
  if (!finalState.markets?.[batch.marketKey]) {
    throw new Error(`automatic market creation did not create ${batch.marketDate} (${batch.marketKey})`);
  }
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
  const imported = await req('/api/operator/import-state', {
    method: 'POST',
    body: JSON.stringify({
      markets,
      marketMeta,
      usedNonces,
      dailyMarkets: changedDailyMarkets
    })
  });
  console.log(
    `[operator-worker] created missing market ${batch.marketDate} imported markets=${imported.marketsImported} marketMeta=${imported.marketMetaImported} dailyMarkets=${imported.dailyMarketsImported} usedNonces=${imported.usedNoncesImported}`
  );
}

async function syncAuthoritativeStateFromChain(state: OperatorStateFile): Promise<OperatorStateFile> {
  const { stdout, stderr } = await execFileAsync(
    'pnpm',
    ['sync-state:zeko', '--', '--state-file', localStatePath],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 8
    }
  );
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  const syncedState = await loadOperatorState(localStatePath);
  const markets = changedKeys(state.markets || {}, syncedState.markets || {});
  const positions = changedKeys(state.positions || {}, syncedState.positions || {});
  const marketMeta = changedKeys(state.marketMeta || {}, syncedState.marketMeta || {});
  const positionMeta = changedKeys(state.positionMeta || {}, syncedState.positionMeta || {});
  const usedNonces = changedKeys(state.usedNonces || {}, syncedState.usedNonces || {});
  if (
    Object.keys(markets).length === 0 &&
    Object.keys(positions).length === 0 &&
    Object.keys(marketMeta).length === 0 &&
    Object.keys(positionMeta).length === 0 &&
    Object.keys(usedNonces).length === 0
  ) {
    return syncedState;
  }
  const imported = await req('/api/operator/import-state', {
    method: 'POST',
    body: JSON.stringify({
      markets,
      positions,
      marketMeta,
      positionMeta,
      usedNonces
    })
  });
  console.log(
    `[operator-worker] imported synced state markets=${imported.marketsImported} positions=${imported.positionsImported} marketMeta=${imported.marketMetaImported} positionMeta=${imported.positionMetaImported} usedNonces=${imported.usedNoncesImported}`
  );
  return syncedState;
}

async function req(path: string, init: RequestInit = {}): Promise<any> {
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
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const snippet = text.slice(0, 160).replace(/\s+/g, ' ').trim();
      throw new Error(
        `request ${path} returned non-JSON response (status ${res.status}): ${snippet}`
      );
    }
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `request ${path} failed with status ${res.status}`);
  }
  return data;
}

function marketDateFromTitle(title: string | undefined): string | null {
  if (!title) return null;
  const match = /^Atherton, CA - (\d{4}-\d{2}-\d{2}) Over\/Under \d+F$/.exec(title);
  return match ? match[1] : null;
}

function currentPacificDateIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';
  return `${year}-${month}-${day}`;
}

function currentPacificHour(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour')?.value || '0');
}

async function maybeProcessPrivateQueue(): Promise<void> {
  const status = await req('/api/private-bets/status', { method: 'GET' });
  if (!status || status.privacyMode !== 'zk_strong') return;
  if (status.inFlight) return;
  const depth = Number(status.queueDepth || 0);
  if (depth <= 0) return;
  console.log(`[operator-worker] processing private queue depth=${depth}`);
  const lease = await req('/api/operator/lease-private-batch', {
    method: 'POST',
    body: JSON.stringify({})
  });
  if (!lease?.leased || !lease?.batch || !lease?.state) return;

  const batch = lease.batch as PrivateQueuedBet;
  let workingState = lease.state as OperatorStateFile;
  const dailyMarkets = (lease.dailyMarkets || {}) as Record<string, unknown>;
  try {
    console.log(
      `[operator-worker] leased batch id=${batch.id} marketDate=${batch.marketDate || 'unknown'} marketKey=${batch.marketKey}`
    );
    await saveOperatorState(localStatePath, workingState);
    await saveDailyMarketsFile(localDailyMarketsPath, dailyMarkets);
    console.log(`[operator-worker] checking market readiness for batch ${batch.id}`);
    await ensureQueuedMarketExists(batch, workingState, dailyMarkets);
    console.log(`[operator-worker] proving queued batch ${batch.id}`);
    let result;
    try {
      result = await proveAndSendPrivateQueuedBet({
        queuedBet: batch,
        stateFile: localStatePath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/positionsRoot mismatch|marketsRoot mismatch/i.test(message)) {
        console.warn(`[operator-worker] stale state detected for batch ${batch.id}; syncing authoritative state and retrying once`);
        workingState = await syncAuthoritativeStateFromChain(workingState);
        await ensureQueuedMarketExists(batch, workingState, dailyMarkets);
        console.log(`[operator-worker] retrying queued batch ${batch.id} after state sync`);
        result = await proveAndSendPrivateQueuedBet({
          queuedBet: batch,
          stateFile: localStatePath
        });
      } else {
        throw error;
      }
    }
    console.log(`[operator-worker] submitting completion for batch ${batch.id} tx=${result.txHash || 'pending'}`);
    const completed = await req('/api/operator/complete-private-batch', {
      method: 'POST',
      body: JSON.stringify({
        id: batch.id,
        txHash: result.txHash,
        relayerReimbursedNanomina: result.relayerReimbursedNanomina
      })
    });
    console.log(`[operator-worker] processed queue remaining=${completed.queueDepth}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await req('/api/operator/fail-private-batch', {
        method: 'POST',
        body: JSON.stringify({
          id: batch.id,
          error: message
        })
      });
    } catch (releaseError) {
      console.error('[operator-worker] failed to release leased private batch:', releaseError);
    }
    throw error;
  }
}

async function maybeEnsureDailyMarkets(): Promise<void> {
  if (!envEnabled('OPERATOR_WORKER_ENABLE_ENSURE', true)) return;
  console.log('[operator-worker] ensuring forward daily markets');
  const result = await req('/api/operator/ensure-daily-markets', {
    method: 'POST',
    body: JSON.stringify({})
  });
  if (result?.output) {
    console.log(result.output);
  }
}

async function maybeResolveDueMarkets(): Promise<void> {
  if (!envEnabled('OPERATOR_WORKER_ENABLE_RESOLVE', true)) return;
  const data = await req('/api/markets', { method: 'GET' });
  const markets = Array.isArray(data?.markets) ? data.markets : [];
  const todayIso = currentPacificDateIso();
  const hour = currentPacificHour();
  for (const market of markets) {
    if (market?.resolved) continue;
    const marketDate = marketDateFromTitle(typeof market?.title === 'string' ? market.title : undefined);
    if (!marketDate) continue;
    const eligible = marketDate < todayIso || (marketDate === todayIso && hour >= 19);
    if (!eligible) continue;
    console.log(`[operator-worker] resolving due market ${marketDate}`);
    const result = await req('/api/public/resolve-daily-market', {
      method: 'POST',
      body: JSON.stringify({ marketDate })
    });
    if (result?.ignored) {
      console.log(`[operator-worker] skipped ${marketDate}: ${result.reason}`);
    } else {
      console.log(`[operator-worker] resolved ${marketDate}`);
    }
  }
}

async function runCycle(cycle: number): Promise<void> {
  console.log(`[operator-worker] cycle=${cycle} start=${new Date().toISOString()}`);
  try {
    await maybeProcessPrivateQueue();
  } catch (error) {
    console.error(`[operator-worker] cycle=${cycle} private queue step failed:`, error);
  }

  try {
    await maybeResolveDueMarkets();
  } catch (error) {
    console.error(`[operator-worker] cycle=${cycle} resolve step failed:`, error);
  }

  const ensureEveryOverride = envOptionalInt('OPERATOR_WORKER_ENSURE_EVERY');
  const ensureEvery = ensureEveryOverride === null ? 10 : ensureEveryOverride;
  if (ensureEvery > 0 && cycle % ensureEvery === 0) {
    try {
      await maybeEnsureDailyMarkets();
    } catch (error) {
      console.error(`[operator-worker] cycle=${cycle} ensure step failed:`, error);
    }
  }
  console.log(`[operator-worker] cycle=${cycle} done=${new Date().toISOString()}`);
}

async function main(): Promise<void> {
  const intervalMs = envInt('OPERATOR_WORKER_INTERVAL_MS', 5000);
  const retryMs = envInt('OPERATOR_WORKER_RETRY_MS', 15000);
  const startDelayMs = envInt('OPERATOR_WORKER_START_DELAY_MS', 5000);
  const resolveEnabled = envEnabled('OPERATOR_WORKER_ENABLE_RESOLVE', true);
  const ensureEnabled = envEnabled('OPERATOR_WORKER_ENABLE_ENSURE', true);
  const ensureEveryOverride = envOptionalInt('OPERATOR_WORKER_ENSURE_EVERY');
  console.log(`[operator-worker] base_url=${baseUrl}`);
  console.log(
    `[operator-worker] interval_ms=${intervalMs} retry_ms=${retryMs} start_delay_ms=${startDelayMs}`
  );
  console.log(
    `[operator-worker] resolve_enabled=${resolveEnabled} ensure_enabled=${ensureEnabled} ensure_every=${
      ensureEveryOverride === null ? 'default(10)' : ensureEveryOverride
    }`
  );
  if (startDelayMs > 0) {
    console.log(`[operator-worker] initial delay ${startDelayMs}ms`);
    await sleep(startDelayMs);
  }
  let cycle = 0;
  while (true) {
    cycle += 1;
    const started = Date.now();
    try {
      await runCycle(cycle);
      const elapsed = Date.now() - started;
      const waitMs = Math.max(1000, intervalMs - elapsed);
      await sleep(waitMs);
    } catch (error) {
      console.error(`[operator-worker] cycle=${cycle} failed:`, error);
      await sleep(retryMs);
    }
  }
}

main().catch((error) => {
  console.error('[operator-worker] fatal:', error);
  process.exit(1);
});
