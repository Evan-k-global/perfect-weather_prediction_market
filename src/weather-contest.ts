import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WeatherSnapshot } from './weather-service.js';

export type WeatherContestBet = {
  id: string;
  userId: string;
  predictedHighF: number;
  stake: number;
  createdAtUnixMs: number;
};

export type WeatherContestSettlement = {
  observedHighF: number;
  settledAtUnixMs: number;
  winners: Array<{ userId: string; betId: string; guess: number; payout: number }>;
};

export type WeatherContestState = {
  marketDate: string;
  closeHourLocal: number;
  bets: WeatherContestBet[];
  settled?: WeatherContestSettlement;
};

const DEFAULT_CONTEST_FILE = './data/weather-contest-94027.json';

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadContestState(
  marketDate: string,
  closeHourLocal: number,
  filePath: string = DEFAULT_CONTEST_FILE
): Promise<WeatherContestState> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as WeatherContestState;
    if (parsed.marketDate === marketDate) return parsed;
  } catch {
    // ignore
  }
  return { marketDate, closeHourLocal, bets: [] };
}

export async function saveContestState(
  state: WeatherContestState,
  filePath: string = DEFAULT_CONTEST_FILE
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export function addContestBet(
  state: WeatherContestState,
  input: { userId: string; predictedHighF: number; stake: number; nowUnixMs: number; nowLocalHour: number }
): WeatherContestState {
  if (state.settled) throw new Error('contest already settled');
  if (input.nowLocalHour >= state.closeHourLocal) throw new Error('betting window closed for today');
  if (!Number.isFinite(input.predictedHighF)) throw new Error('predictedHighF must be finite');
  if (!Number.isFinite(input.stake) || input.stake <= 0) throw new Error('stake must be > 0');

  const bet: WeatherContestBet = {
    id: randomId(),
    userId: input.userId,
    predictedHighF: Math.round(input.predictedHighF * 10) / 10,
    stake: Math.floor(input.stake),
    createdAtUnixMs: input.nowUnixMs
  };

  return {
    ...state,
    bets: [...state.bets, bet]
  };
}

export function settleContest(
  state: WeatherContestState,
  observedHighF: number,
  settledAtUnixMs: number
): WeatherContestState {
  if (state.settled) return state;
  if (state.bets.length === 0) {
    return {
      ...state,
      settled: { observedHighF, settledAtUnixMs, winners: [] }
    };
  }

  const valid = state.bets.filter((b) => b.predictedHighF <= observedHighF);
  if (valid.length === 0) {
    return {
      ...state,
      settled: { observedHighF, settledAtUnixMs, winners: [] }
    };
  }

  let bestGap = Number.POSITIVE_INFINITY;
  for (const b of valid) {
    const gap = observedHighF - b.predictedHighF;
    if (gap < bestGap) bestGap = gap;
  }

  const winners = valid.filter((b) => observedHighF - b.predictedHighF === bestGap);
  const totalPool = state.bets.reduce((sum, b) => sum + b.stake, 0);
  const totalWinnerStake = winners.reduce((sum, w) => sum + w.stake, 0);

  const payouts = winners.map((w) => {
    const share = totalWinnerStake > 0 ? w.stake / totalWinnerStake : 0;
    return {
      userId: w.userId,
      betId: w.id,
      guess: w.predictedHighF,
      payout: Math.round(totalPool * share)
    };
  });

  return {
    ...state,
    settled: {
      observedHighF,
      settledAtUnixMs,
      winners: payouts
    }
  };
}

export function maybeAutoSettleContest(
  state: WeatherContestState,
  snapshot: WeatherSnapshot,
  nowLocalHour: number,
  nowUnixMs: number
): WeatherContestState {
  if (state.settled) return state;
  // End-of-day auto-settlement for demo using latest next-24h projected high.
  if (nowLocalHour < 21) return state;
  if (snapshot.next24hHighF === null) return state;
  return settleContest(state, snapshot.next24hHighF, nowUnixMs);
}
