import './env.js';

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
  if (!value) {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

const baseUrl = requireEnv('OPERATOR_BASE_URL').replace(/\/+$/, '');
const operatorToken = requireEnv('OPERATOR_ACTION_TOKEN');

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
  const data = text ? JSON.parse(text) : null;
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
  const result = await req('/api/operator/process-private-batch', {
    method: 'POST',
    body: JSON.stringify({})
  });
  console.log(`[operator-worker] processed queue remaining=${result.queueDepth}`);
}

async function maybeEnsureDailyMarkets(): Promise<void> {
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
  await maybeEnsureDailyMarkets();
  await maybeProcessPrivateQueue();
  await maybeResolveDueMarkets();
  console.log(`[operator-worker] cycle=${cycle} done=${new Date().toISOString()}`);
}

async function main(): Promise<void> {
  const intervalMs = envInt('OPERATOR_WORKER_INTERVAL_MS', 30000);
  const retryMs = envInt('OPERATOR_WORKER_RETRY_MS', 120000);
  console.log(`[operator-worker] base_url=${baseUrl}`);
  console.log(`[operator-worker] interval_ms=${intervalMs} retry_ms=${retryMs}`);
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
