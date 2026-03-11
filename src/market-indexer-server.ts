import './env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_FILE, loadOperatorState } from './state-store.js';

type MarketView = {
  marketKey: string;
  title: string;
  rulesPrimary: string;
  settlementSource: string;
  closeSlot: number;
  expirySlot: number;
  determinationSlot: number;
  totalPositionBet: number;
  totalYesPositionBet: number;
  impliedProbability: number;
  resolved: boolean;
  outcome: number;
  createdAtUnixMs: number;
  timeToExpirySlots: number;
};

function parseIntOrDefault(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function writeJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

function toMarketViews(state: Awaited<ReturnType<typeof loadOperatorState>>, currentSlot: number): MarketView[] {
  return Object.entries(state.markets).map(([marketKey, leaf]) => {
    const total = Number(leaf.totalPositionBet);
    const yes = Number(leaf.totalYesPositionBet);
    const impliedProbability = total > 0 ? yes / total : 0;
    const meta = state.marketMeta?.[marketKey];
    const closeSlot = Number(leaf.closeSlot);
    const expirySlot = Number(leaf.expirySlot);
    const determinationSlot = Number(meta?.determinationSlot || leaf.expirySlot);

    return {
      marketKey,
      title: meta?.title || `Market ${marketKey}`,
      rulesPrimary:
        meta?.rulesPrimary ||
        'Will observed weather value be greater than threshold at determination time?',
      settlementSource: meta?.settlementSource || 'unknown',
      closeSlot,
      expirySlot,
      determinationSlot,
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

function rankTopByBet(markets: MarketView[]): MarketView[] {
  return [...markets].sort((a, b) => b.totalPositionBet - a.totalPositionBet);
}

function rankEndingSoon(markets: MarketView[]): MarketView[] {
  return [...markets]
    .filter((m) => !m.resolved)
    .sort((a, b) => a.timeToExpirySlots - b.timeToExpirySlots);
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.INDEXER_PORT || '8788', 10);
  const defaultStatePath = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dashboardPath = path.resolve(__dirname, '..', 'public', 'markets-dashboard.html');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/' || url.pathname === '/dashboard') {
        const html = await readFile(dashboardPath, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }
      const currentSlot = parseIntOrDefault(url.searchParams.get('current_slot'), 0);
      const statePath = url.searchParams.get('state_file') || defaultStatePath;
      const state = await loadOperatorState(statePath);
      const markets = toMarketViews(state, currentSlot);

      if (url.pathname === '/api/markets') {
        writeJson(res, 200, { count: markets.length, markets });
        return;
      }
      if (url.pathname === '/api/rankings/top-bet') {
        writeJson(res, 200, { rankings: rankTopByBet(markets) });
        return;
      }
      if (url.pathname === '/api/rankings/ending-soon') {
        writeJson(res, 200, { rankings: rankEndingSoon(markets) });
        return;
      }

      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : 'unknown error' });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Market indexer listening on http://127.0.0.1:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error('[market-indexer-server] failed:', error);
  process.exit(1);
});
