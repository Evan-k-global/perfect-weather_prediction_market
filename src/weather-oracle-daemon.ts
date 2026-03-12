import './env.js';
import { runWeatherAttestation } from './weather-attest.js';
import { runWeatherSync } from './weather-hourly-sync.js';
import { cleanupData } from './cleanup-data.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadOperatorState } from './state-store.js';
import { currentLocalDate, nowLocalHour } from './weather-service.js';

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

async function runOnce(cycle: number): Promise<void> {
  const started = new Date().toISOString();
  console.log(`[weather-daemon] cycle=${cycle} start=${started}`);

  await runWeatherAttestation();
  await runWeatherSync();
  await maybeEnsureForwardDailyMarkets();
  await maybeResolvePassedDailyMarkets();

  const ended = new Date().toISOString();
  console.log(`[weather-daemon] cycle=${cycle} done=${ended}`);
}

function marketDateFromTitle(title: string | undefined): string | null {
  if (!title) return null;
  const match = /^Atherton, CA - (\d{4}-\d{2}-\d{2}) Over\/Under \d+F$/.exec(title);
  return match ? match[1] : null;
}

async function maybeResolvePassedDailyMarkets(): Promise<void> {
  const stateFile = process.env.STATE_FILE || './data/operator-state.json';
  const attestation = process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json';
  const state = await loadOperatorState(stateFile);
  const todayIso = currentLocalDate();
  const nowHour = nowLocalHour();
  const projectRoot = process.cwd();
  for (const [marketKey, stored] of Object.entries(state.markets || {})) {
    if (stored.resolved === '1') continue;
    const meta = state.marketMeta?.[marketKey];
    const marketDate = marketDateFromTitle(meta?.title);
    if (!marketDate) continue;
    const shouldResolve = marketDate < todayIso || (marketDate === todayIso && nowHour >= 19);
    if (!shouldResolve) continue;
    console.log(`[weather-daemon] resolving on-chain daily market for ${marketDate}`);
    const { stdout, stderr } = await execFileAsync(
      'pnpm',
      ['resolve-daily-market:zeko', '--', '--market-date', marketDate, '--attestation', attestation, '--state-file', stateFile],
      { cwd: projectRoot, env: process.env }
    );
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  }
}

async function maybeEnsureForwardDailyMarkets(): Promise<void> {
  const stateFile = process.env.STATE_FILE || './data/operator-state.json';
  const dailyMarketsFile = process.env.DEMO_DAILY_MARKETS_FILE || './data/demo-daily-threshold-markets.json';
  const projectRoot = process.cwd();
  console.log('[weather-daemon] ensuring forward daily markets are created on-chain');
  const { stdout, stderr } = await execFileAsync(
    'pnpm',
    [
      'ensure-daily-markets:zeko',
      '--',
      '--state-file',
      stateFile,
      '--daily-markets-file',
      dailyMarketsFile
    ],
    { cwd: projectRoot, env: process.env }
  );
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}

async function writeHeartbeat(
  filePath: string,
  payload: { status: 'ok' | 'error'; cycle: number; ts: string; message?: string }
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export async function runWeatherOracleDaemon(): Promise<void> {
  const intervalMs = envInt('WEATHER_DAEMON_INTERVAL_MS', 30 * 60 * 1000);
  const retryMs = envInt('WEATHER_DAEMON_RETRY_MS', 2 * 60 * 1000);
  const startDelayMs = envInt('WEATHER_DAEMON_START_DELAY_MS', 0);
  const cleanupIntervalMs = envInt('CLEANUP_DATA_INTERVAL_MS', 6 * 60 * 60 * 1000);
  const cleanupKeepContestDays = envInt('CLEANUP_KEEP_CONTEST_DAYS', 14);
  const cleanupKeepOperatorBackups = envInt('CLEANUP_KEEP_OPERATOR_BACKUPS', 3);
  const cleanupKeepBatchHistory = envInt('CLEANUP_KEEP_BATCH_HISTORY', 200);
  const heartbeatFile =
    process.env.WEATHER_DAEMON_HEARTBEAT_FILE || './data/weather-daemon-heartbeat.json';

  process.env.WEATHER_REQUIRE_TLSN = process.env.WEATHER_REQUIRE_TLSN || '1';
  process.env.WEATHER_TLSN_ATTESTATION_FILE =
    process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json';

  console.log('[weather-daemon] starting');
  console.log(`[weather-daemon] interval_ms=${intervalMs} retry_ms=${retryMs}`);
  console.log(
    `[weather-daemon] cleanup interval_ms=${cleanupIntervalMs} keep_contest_days=${cleanupKeepContestDays} keep_operator_backups=${cleanupKeepOperatorBackups} keep_batch_history=${cleanupKeepBatchHistory}`
  );
  console.log(
    `[weather-daemon] strict=${process.env.WEATHER_REQUIRE_TLSN} attestation_file=${process.env.WEATHER_TLSN_ATTESTATION_FILE}`
  );

  if (startDelayMs > 0) {
    console.log(`[weather-daemon] initial delay ${startDelayMs}ms`);
    await sleep(startDelayMs);
  }

  let cycle = 0;
  let lastCleanupAt = 0;
  while (true) {
    cycle += 1;
    const cycleStart = Date.now();
    try {
      await runOnce(cycle);
      if (cleanupIntervalMs > 0 && Date.now() - lastCleanupAt >= cleanupIntervalMs) {
        const cleanup = await cleanupData({
          keepContestDays: cleanupKeepContestDays,
          keepOperatorBackups: cleanupKeepOperatorBackups,
          keepBatchHistory: cleanupKeepBatchHistory
        });
        lastCleanupAt = Date.now();
        console.log(
          `[weather-daemon] cleanup removed backups=${cleanup.operatorBackups.removed.length} contests=${cleanup.contestFiles.removed.length} batchHistory=${cleanup.batchHistory.before - cleanup.batchHistory.after}`
        );
      }
      await writeHeartbeat(heartbeatFile, {
        status: 'ok',
        cycle,
        ts: new Date().toISOString()
      });
      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(1000, intervalMs - elapsed);
      console.log(`[weather-daemon] sleeping ${waitMs}ms`);
      await sleep(waitMs);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[weather-daemon] cycle=${cycle} failed: ${message}`);
      await writeHeartbeat(heartbeatFile, {
        status: 'error',
        cycle,
        ts: new Date().toISOString(),
        message
      });
      console.log(`[weather-daemon] retrying in ${retryMs}ms`);
      await sleep(retryMs);
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runWeatherOracleDaemon().catch((error: unknown) => {
    console.error('[weather-daemon] fatal:', error);
    process.exit(1);
  });
}
