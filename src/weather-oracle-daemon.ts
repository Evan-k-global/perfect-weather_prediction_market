import './env.js';
import { runWeatherAttestation } from './weather-attest.js';
import { runWeatherSync } from './weather-hourly-sync.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

  const ended = new Date().toISOString();
  console.log(`[weather-daemon] cycle=${cycle} done=${ended}`);
}

async function writeHeartbeat(
  filePath: string,
  payload: { status: 'ok' | 'error'; cycle: number; ts: string; message?: string }
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export async function runWeatherOracleDaemon(): Promise<void> {
  const intervalMs = envInt('WEATHER_DAEMON_INTERVAL_MS', 15 * 60 * 1000);
  const retryMs = envInt('WEATHER_DAEMON_RETRY_MS', 2 * 60 * 1000);
  const startDelayMs = envInt('WEATHER_DAEMON_START_DELAY_MS', 0);
  const heartbeatFile =
    process.env.WEATHER_DAEMON_HEARTBEAT_FILE || './data/weather-daemon-heartbeat.json';

  process.env.WEATHER_REQUIRE_TLSN = process.env.WEATHER_REQUIRE_TLSN || '1';
  process.env.WEATHER_TLSN_ATTESTATION_FILE =
    process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json';

  console.log('[weather-daemon] starting');
  console.log(`[weather-daemon] interval_ms=${intervalMs} retry_ms=${retryMs}`);
  console.log(
    `[weather-daemon] strict=${process.env.WEATHER_REQUIRE_TLSN} attestation_file=${process.env.WEATHER_TLSN_ATTESTATION_FILE}`
  );

  if (startDelayMs > 0) {
    console.log(`[weather-daemon] initial delay ${startDelayMs}ms`);
    await sleep(startDelayMs);
  }

  let cycle = 0;
  while (true) {
    cycle += 1;
    const cycleStart = Date.now();
    try {
      await runOnce(cycle);
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
