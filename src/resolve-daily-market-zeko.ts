import './env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Field } from 'o1js';
import { deriveDateKeyedMarketKey } from './payout-upgrade-types.js';
import { findArchivedAttestationForMarketDate } from './weather-attest.js';
import { currentLocalDate } from './weather-service.js';

const execFileAsync = promisify(execFile);

function parseArgValue(args: string[], name: string): string {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  throw new Error(`Missing required argument --${name}`);
}

function parseOptionalArgValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function fieldFromHexDigest(hex: string, chars = 30): Field {
  return Field(BigInt(`0x${hex.slice(0, chars)}`));
}

function fieldFromIsoDate(dateIso: string): Field {
  return fieldFromHexDigest(createHash('sha256').update(`date:${dateIso}`).digest('hex'));
}

function deriveMarketKey(dateIso: string): string {
  const baseConfigHash = Field(process.env.DEMO_MARKET_BASE_CONFIG_HASH || '9301');
  return deriveDateKeyedMarketKey(baseConfigHash, fieldFromIsoDate(dateIso)).toString();
}

const WEATHER_MARKET_TIME_ZONE = 'America/Los_Angeles';
const DEFAULT_OBSERVATION_STATION_ID = process.env.NWS_OBSERVATION_STATION_ID || 'KPAO';

function nextIsoDate(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function formatShortOffset(dateIso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WEATHER_MARKET_TIME_ZONE,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(`${dateIso}T12:00:00Z`));
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT-08:00';
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (!match) return '-08:00';
  const sign = match[1];
  const hours = match[2].padStart(2, '0');
  const minutes = (match[3] || '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function buildObservationPathForMarketDate(marketDate: string, stationId: string): string {
  const offset = formatShortOffset(marketDate);
  const nextDate = nextIsoDate(marketDate);
  return `/stations/${stationId}/observations?start=${marketDate}T00:00:00${offset}&end=${nextDate}T00:00:00${offset}&limit=300`;
}

async function buildHistoricalObservationAttestation(projectRoot: string, marketDate: string): Promise<{
  attestationPath: string;
  allowedPath: string;
}> {
  const stationId = process.env.NWS_OBSERVATION_STATION_ID || DEFAULT_OBSERVATION_STATION_ID;
  const allowedPath = buildObservationPathForMarketDate(marketDate, stationId);
  const outputDir = path.join('data', 'tlsn-output', 'history', marketDate);
  const attestationPath = path.join(projectRoot, outputDir, 'attestation.json');
  await execFileAsync(
    'pnpm',
    ['weather:attest'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        TLSN_SERVER_HOST: 'api.weather.gov',
        TLSN_SERVER_DOMAIN: 'api.weather.gov',
        TLSN_ENDPOINT: allowedPath,
        TLSN_OUTPUT_DIR: outputDir,
        WEATHER_TLSN_LOCAL_ATTESTATION_FILE: path.join(outputDir, 'latest-attestation.json'),
        TLSN_STATUS_FILE: path.join(outputDir, 'status.json')
      }
    }
  );
  return { attestationPath, allowedPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const marketDate = parseArgValue(args, 'market-date');
  const explicitAttestation = parseOptionalArgValue(args, 'attestation');
  const stateFile = parseOptionalArgValue(args, 'state-file') || './data/operator-state.json';
  const observedAtSlot = parseOptionalArgValue(args, 'observed-at-slot');
  const projectRoot = process.cwd();
  const archivedAttestation = explicitAttestation ? null : await findArchivedAttestationForMarketDate(marketDate);
  const useHistoricalWindow = Boolean(archivedAttestation) || marketDate < currentLocalDate();
  let attestation =
    explicitAttestation ||
    archivedAttestation ||
    './data/tlsn-output/latest/attestation.json';
  let allowedPath = '/gridpoints/MTR/86,107/forecast';
  if (!explicitAttestation && !archivedAttestation && useHistoricalWindow) {
    const generated = await buildHistoricalObservationAttestation(projectRoot, marketDate);
    attestation = generated.attestationPath;
    allowedPath = generated.allowedPath;
  }
  await readFile(attestation, 'utf8');
  const marketKey = deriveMarketKey(marketDate);
  const liveMaxAgeMs = process.env.WEATHER_TLSN_MAX_AGE_MS || '3600000';
  const historicalMaxAgeMs = process.env.WEATHER_TLSN_HISTORICAL_MAX_AGE_MS || String(365 * 24 * 60 * 60 * 1000);
  const maxAgeMs = useHistoricalWindow ? historicalMaxAgeMs : liveMaxAgeMs;
  const commandArgs = [
    'resolve-weather:zeko',
    '--',
    '--market-key', marketKey,
    '--attestation', attestation,
    '--allowed-server', 'api.weather.gov',
    '--allowed-path', allowedPath,
    '--max-age-ms', maxAgeMs,
    '--state-file', stateFile
  ];
  if (observedAtSlot) {
    commandArgs.push('--observed-at-slot', observedAtSlot);
  }
  const { stdout, stderr } = await execFileAsync('pnpm', commandArgs, {
    cwd: projectRoot,
    env: process.env
  });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  console.log('Resolved daily market date:', marketDate);
  console.log('Market key:', marketKey);
  console.log('Attestation:', attestation);
}

main().catch((error: unknown) => {
  console.error('[resolve-daily-market:zeko] failed:', error);
  process.exit(1);
});
