import './env.js';
import { readFile } from 'node:fs/promises';

type Heartbeat = {
  status: 'ok' | 'error';
  cycle: number;
  ts: string;
  message?: string;
};

async function main(): Promise<void> {
  const filePath = process.env.WEATHER_DAEMON_HEARTBEAT_FILE || './data/weather-daemon-heartbeat.json';
  const maxAgeMs = Number.parseInt(process.env.WEATHER_DAEMON_HEALTH_MAX_AGE_MS || '1200000', 10);

  const raw = await readFile(filePath, 'utf8');
  const hb = JSON.parse(raw) as Heartbeat;
  const tsMs = Date.parse(hb.ts);
  const ageMs = Date.now() - tsMs;

  if (!Number.isFinite(tsMs)) throw new Error('invalid heartbeat timestamp');
  if (hb.status !== 'ok') throw new Error(`heartbeat status=${hb.status} message=${hb.message || 'none'}`);
  if (ageMs > maxAgeMs) throw new Error(`heartbeat stale ageMs=${ageMs} maxAgeMs=${maxAgeMs}`);

  console.log(`ok cycle=${hb.cycle} ageMs=${ageMs}`);
}

main().catch((error: unknown) => {
  console.error('[weather-daemon-health] failed:', error);
  process.exit(1);
});
