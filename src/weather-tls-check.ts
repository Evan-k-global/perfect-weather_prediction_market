import './env.js';
import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NWS_94027_REQUEST_PATH,
  NWS_94027_SERVER_NAME
} from './weather-service.js';
import { readTlsnAttestationFile } from './tlsn-verifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOCAL_ATTESTATION = path.resolve(PROJECT_ROOT, 'data', 'weather-attestation.json');

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizePathForWeather(p: string): string {
  return p.replace(/&&+/g, '&').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function detectPocRootCandidates(): string[] {
  const envRoot = process.env.ZKVERIFY_POC_ROOT || '';
  const bundled = path.resolve(PROJECT_ROOT, 'external', 'zk-verify-poc');
  const container = '/opt/zk-verify-poc';
  const fixed = '/Users/evankereiakes/Documents/Codex/tokenized-asset-protocol/external/zk-verify-poc';
  return unique([envRoot, container, bundled, fixed]);
}

async function detectAttestationPath(): Promise<{ selected: string | null; copiedFrom?: string }> {
  const envPath = process.env.WEATHER_TLSN_ATTESTATION_FILE || '';
  const roots = detectPocRootCandidates();
  const candidates = unique([
    envPath,
    DEFAULT_LOCAL_ATTESTATION,
    ...roots.map((r) => path.resolve(r, 'output', 'latest', 'attestation.json'))
  ]);

  for (const c of candidates) {
    if (await exists(c)) {
      if (c !== DEFAULT_LOCAL_ATTESTATION) {
        await mkdir(path.dirname(DEFAULT_LOCAL_ATTESTATION), { recursive: true });
        await copyFile(c, DEFAULT_LOCAL_ATTESTATION);
        return { selected: DEFAULT_LOCAL_ATTESTATION, copiedFrom: c };
      }
      return { selected: c };
    }
  }

  return { selected: null };
}

async function main(): Promise<void> {
  const attestation = await detectAttestationPath();
  const tlsnVerifyCmd = process.env.TLSN_VERIFY_CMD || '';
  const strictMode = process.env.WEATHER_REQUIRE_TLSN === '1';

  console.log('zkTLS weather check');
  console.log('Project root:', PROJECT_ROOT);
  console.log('Strict mode:', strictMode ? 'ON' : 'OFF');
  console.log('Expected server:', NWS_94027_SERVER_NAME);
  console.log('Expected path:', NWS_94027_REQUEST_PATH);

  if (attestation.copiedFrom) {
    console.log('Attestation copied to local data path from:', attestation.copiedFrom);
  }

  if (!attestation.selected) {
    console.log('Status: FAIL');
    console.log('Reason: no attestation file found.');
    console.log('Expected local path:', DEFAULT_LOCAL_ATTESTATION);
    process.exit(1);
  }

  const parsed = await readTlsnAttestationFile(attestation.selected);
  const serverMatch = parsed.server_name === NWS_94027_SERVER_NAME;
  const pathMatch =
    normalizePathForWeather(parsed.request_path) === normalizePathForWeather(NWS_94027_REQUEST_PATH);

  console.log('Attestation file:', attestation.selected);
  console.log('Attestation server_name:', parsed.server_name);
  console.log('Attestation request_path:', parsed.request_path);
  console.log('Attestation timestamp:', parsed.timestamp);
  console.log('Server match:', serverMatch ? 'yes' : 'no');
  console.log('Path match:', pathMatch ? 'yes' : 'no');
  console.log('TLSN_VERIFY_CMD set:', tlsnVerifyCmd ? 'yes' : 'no');
  if (!tlsnVerifyCmd) {
    console.log('Note: using built-in verifier checks (policy + envelope). External verifier is optional but recommended.');
  }

  const blockers: string[] = [];
  if (!serverMatch || !pathMatch) {
    blockers.push('attestation does not match forecast.weather.gov + exact MapClick path');
  }

  if (blockers.length > 0) {
    console.log('Status: FAIL');
    for (const b of blockers) console.log('-', b);
    console.log('Recommended exports:');
    console.log(`export WEATHER_REQUIRE_TLSN=1`);
    console.log(`export WEATHER_TLSN_ATTESTATION_FILE=${attestation.selected}`);
    process.exit(1);
  }

  console.log('Status: PASS');
  console.log('Ready command:');
  console.log('pnpm weather:sync');
}

main().catch((error: unknown) => {
  console.error('[weather-tls-check] failed:', error);
  process.exit(1);
});
