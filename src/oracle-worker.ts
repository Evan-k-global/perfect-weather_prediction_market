import './env.js';
import { readFile } from 'node:fs/promises';
import { runWeatherAttestation } from './weather-attest.js';
import {
  NWS_94027_REQUEST_PATH,
  NWS_94027_SERVER_NAME,
  NWS_94027_STRICT_URL,
  snapshotFromTlsnAttestation
} from './weather-service.js';
import { verifyTlsnAttestationFile } from './tlsn-verifier.js';

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

async function req(baseUrl: string, operatorToken: string, endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-operator-token': operatorToken
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

async function runCycle(baseUrl: string, operatorToken: string): Promise<void> {
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
  const result = await req(baseUrl, operatorToken, '/api/operator/weather-sync', {
    snapshot,
    tlsnStatus
  });
  console.log(
    `[oracle-worker] synced snapshot verified=${result.snapshotVerified ? 'yes' : 'no'} mode=${result.verificationMode}`
  );
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('OPERATOR_BASE_URL').replace(/\/+$/, '');
  const operatorToken = requireEnv('OPERATOR_ACTION_TOKEN');
  const intervalMs = envInt('ORACLE_WORKER_INTERVAL_MS', 30 * 60 * 1000);
  const retryMs = envInt('ORACLE_WORKER_RETRY_MS', 5 * 60 * 1000);
  const startDelayMs = envInt('ORACLE_WORKER_START_DELAY_MS', 10000);
  process.env.WEATHER_REQUIRE_TLSN = process.env.WEATHER_REQUIRE_TLSN || '1';
  process.env.WEATHER_TLSN_ATTESTATION_FILE =
    process.env.WEATHER_TLSN_ATTESTATION_FILE || './data/tlsn-output/latest/attestation.json';

  console.log(`[oracle-worker] base_url=${baseUrl}`);
  console.log(`[oracle-worker] interval_ms=${intervalMs} retry_ms=${retryMs} start_delay_ms=${startDelayMs}`);
  if (startDelayMs > 0) {
    console.log(`[oracle-worker] initial delay ${startDelayMs}ms`);
    await sleep(startDelayMs);
  }

  let cycle = 0;
  while (true) {
    cycle += 1;
    const started = Date.now();
    console.log(`[oracle-worker] cycle=${cycle} start=${new Date().toISOString()}`);
    try {
      await runCycle(baseUrl, operatorToken);
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
