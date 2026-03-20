import './env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Field } from 'o1js';
import { deriveDateKeyedMarketKey } from './payout-upgrade-types.js';
import { findArchivedAttestationForMarketDate } from './weather-attest.js';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const marketDate = parseArgValue(args, 'market-date');
  const explicitAttestation = parseOptionalArgValue(args, 'attestation');
  const stateFile = parseOptionalArgValue(args, 'state-file') || './data/operator-state.json';
  const observedAtSlot = parseOptionalArgValue(args, 'observed-at-slot');
  const projectRoot = process.cwd();
  const archivedAttestation = explicitAttestation ? null : await findArchivedAttestationForMarketDate(marketDate);
  const attestation =
    explicitAttestation ||
    archivedAttestation ||
    './data/tlsn-output/latest/attestation.json';
  await readFile(attestation, 'utf8');
  const marketKey = deriveMarketKey(marketDate);
  const liveMaxAgeMs = process.env.WEATHER_TLSN_MAX_AGE_MS || '3600000';
  const historicalMaxAgeMs = process.env.WEATHER_TLSN_HISTORICAL_MAX_AGE_MS || String(365 * 24 * 60 * 60 * 1000);
  const maxAgeMs = archivedAttestation ? historicalMaxAgeMs : liveMaxAgeMs;
  const commandArgs = [
    'resolve-weather:zeko',
    '--',
    '--market-key', marketKey,
    '--attestation', attestation,
    '--allowed-server', 'api.weather.gov',
    '--allowed-path', '/gridpoints/MTR/86,107/forecast',
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
