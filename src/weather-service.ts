import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TlsnAttestationEnvelope, TlsnVerificationReport } from './tlsn-verifier.js';

export const NWS_94027_DIGITAL_URL =
  'https://forecast.weather.gov/MapClick.php?lat=37.4534&lon=-122.1942&lg=english&&FcstType=digital';

// Keep MapClick as UI reference page, but use API endpoint for strict attestation reliability.
// Default to daily forecast (smaller payload than hourly) to keep TLSN proving stable.
export const NWS_94027_STRICT_URL = 'https://api.weather.gov/gridpoints/MTR/86,107/forecast';
export const NWS_94027_SERVER_NAME = 'api.weather.gov';
export const NWS_94027_REQUEST_PATH = '/gridpoints/MTR/86,107/forecast';

const WEATHER_TZ = 'America/Los_Angeles';
const DEFAULT_WEATHER_FILE = './data/weather-94027.json';

export type WeatherSnapshot = {
  sourceUrl: string;
  fetchedAtUnixMs: number;
  localDate: string;
  timezone: string;
  hourlyTempsF: number[];
  dailyHighsF: number[];
  next24hHighF: number | null;
  verified: boolean;
  verificationMode: 'zktls' | 'insecure-direct-fetch';
  evidence?: {
    serverName: string;
    requestPath: string;
    timestamp: number;
    responseBodySha256: string;
    mode: string;
  };
};

function formatLocalDate(unixMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(unixMs));
  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';
  return `${year}-${month}-${day}`;
}

function localHour(unixMs: number, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false
  }).format(new Date(unixMs));
  return Number.parseInt(hour, 10);
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNumbersNearLabel(text: string, labelRegex: RegExp, cap: number): number[] {
  const m = text.match(labelRegex);
  if (!m || m.index === undefined) return [];
  const tail = text.slice(m.index, m.index + 900);
  const values = tail.match(/-?\d+(?:\.\d+)?/g) || [];
  const parsed: number[] = [];
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) parsed.push(n);
    if (parsed.length >= cap) break;
  }
  return parsed;
}

function parseDigitalForecast(html: string): { hourlyTempsF: number[]; dailyHighsF: number[] } {
  const text = stripHtml(html);

  const dailyHighs = extractNumbersNearLabel(text, /Daily\s+Maximum\s+Temperature/i, 7).filter(
    (n) => n >= -50 && n <= 140
  );
  const hourlyTemps = extractNumbersNearLabel(text, /Temperature\s*\(\s*F\s*\)|Hourly\s+Temperature/i, 96).filter(
    (n) => n >= -50 && n <= 140
  );

  return {
    hourlyTempsF: hourlyTemps,
    dailyHighsF: dailyHighs
  };
}

function parseApiHourlyForecastJson(raw: string): { hourlyTempsF: number[]; dailyHighsF: number[] } {
  const candidate = JSON.parse(raw) as {
    properties?: {
      periods?: Array<{
        startTime?: string;
        temperature?: number;
      }>;
    };
  };
  const periods = candidate.properties?.periods || [];
  const hourlyTemps: number[] = [];
  const dailyMaxByDate = new Map<string, number>();

  for (const p of periods) {
    const temp = typeof p.temperature === 'number' ? p.temperature : NaN;
    if (!Number.isFinite(temp)) continue;
    hourlyTemps.push(temp);

    const dt = p.startTime ? new Date(p.startTime) : null;
    if (!dt || Number.isNaN(dt.getTime())) continue;
    const day = dt.toISOString().slice(0, 10);
    const prev = dailyMaxByDate.get(day);
    if (prev === undefined || temp > prev) {
      dailyMaxByDate.set(day, temp);
    }
  }

  const dailyHighs = [...dailyMaxByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 7)
    .map(([, v]) => v);

  return {
    hourlyTempsF: hourlyTemps.slice(0, 96),
    dailyHighsF: dailyHighs
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 3;
  const mu = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.max(2, Math.min(10, Math.sqrt(variance)));
}

function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / (sigma * Math.sqrt(2));
  return 0.5 * (1 + erfApprox(z));
}

export function buildSevenDayHighProbabilities(
  dailyHighsF: number[],
  thresholdF: number
): Array<{ dayIndex: number; expectedHighF: number; pHighAtOrBelowThreshold: number; pHighAboveThreshold: number }> {
  const sigma = stddev(dailyHighsF);
  return dailyHighsF.slice(0, 7).map((mu, idx) => {
    const below = normalCdf(thresholdF, mu, sigma);
    return {
      dayIndex: idx,
      expectedHighF: mu,
      pHighAtOrBelowThreshold: Math.max(0, Math.min(1, below)),
      pHighAboveThreshold: Math.max(0, Math.min(1, 1 - below))
    };
  });
}

function snapshotFromHtml(
  html: string,
  sourceUrl: string,
  verificationMode: 'zktls' | 'insecure-direct-fetch',
  verified: boolean,
  report?: TlsnVerificationReport
): WeatherSnapshot {
  let parsed: { hourlyTempsF: number[]; dailyHighsF: number[] };
  const trimmed = html.trimStart();
  if (trimmed.startsWith('{')) {
    parsed = parseApiHourlyForecastJson(html);
  } else {
    parsed = parseDigitalForecast(html);
  }
  const now = Date.now();
  const first24 = parsed.hourlyTempsF.slice(0, 24);
  const next24hHigh = first24.length ? Math.max(...first24) : null;

  return {
    sourceUrl,
    fetchedAtUnixMs: now,
    localDate: formatLocalDate(now, WEATHER_TZ),
    timezone: WEATHER_TZ,
    hourlyTempsF: parsed.hourlyTempsF,
    dailyHighsF: parsed.dailyHighsF,
    next24hHighF: next24hHigh,
    verified,
    verificationMode,
    evidence: report
      ? {
          serverName: report.serverName,
          requestPath: report.requestPath,
          timestamp: report.timestamp,
          responseBodySha256: report.responseBodySha256,
          mode: report.mode
        }
      : undefined
  };
}

export async function fetchNws94027Snapshot(url: string = NWS_94027_STRICT_URL): Promise<WeatherSnapshot> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'private-prediction-market/0.1 weather-bot'
    }
  });
  if (!response.ok) throw new Error(`weather fetch failed: ${response.status} ${response.statusText}`);
  const html = await response.text();
  return snapshotFromHtml(html, url, 'insecure-direct-fetch', false);
}

export function snapshotFromTlsnAttestation(
  attestation: TlsnAttestationEnvelope,
  report: TlsnVerificationReport,
  sourceUrl: string = NWS_94027_STRICT_URL
): WeatherSnapshot {
  return snapshotFromHtml(attestation.response_body, sourceUrl, 'zktls', report.verified, report);
}

export async function loadWeatherSnapshot(filePath: string = DEFAULT_WEATHER_FILE): Promise<WeatherSnapshot | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as WeatherSnapshot;
  } catch {
    return null;
  }
}

export async function saveWeatherSnapshot(snapshot: WeatherSnapshot, filePath: string = DEFAULT_WEATHER_FILE): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

export function nowLocalHour(): number {
  return localHour(Date.now(), WEATHER_TZ);
}

export function currentLocalDate(): string {
  return formatLocalDate(Date.now(), WEATHER_TZ);
}
