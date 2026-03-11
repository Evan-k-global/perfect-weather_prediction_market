import './env.js';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import { NWS_94027_REQUEST_PATH, NWS_94027_SERVER_NAME } from './weather-service.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const defaultPocRoot =
  '/Users/evankereiakes/Documents/Codex/tokenized-asset-protocol/external/zk-verify-poc';

function envOrDefault(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runChecked(cmd: string, args: string[], cwd?: string): Promise<void> {
  await execFileAsync(cmd, args, {
    cwd,
    env: process.env
  });
}

async function patchTlsnProverLimits(proverPath: string, maxRecvData: number): Promise<boolean> {
  const raw = await readFile(proverPath, 'utf8');
  const recvRe = /const\s+MAX_RECV_DATA:\s*usize\s*=\s*1\s*<<\s*(\d+)\s*;/;
  const match = raw.match(recvRe);
  if (!match) return false;
  const currentShift = Number.parseInt(match[1], 10);
  const desiredShift = Math.ceil(Math.log2(maxRecvData));
  if (!Number.isFinite(currentShift) || desiredShift <= currentShift) return false;

  const patched = raw.replace(recvRe, `const MAX_RECV_DATA: usize = 1 << ${desiredShift};`);
  await writeFile(proverPath, patched, 'utf8');
  return true;
}

async function patchTlsnProverHttpVersion(proverPath: string): Promise<boolean> {
  const raw = await readFile(proverPath, 'utf8');
  if (!raw.includes('HTTP/1.1')) return false;
  const patched = raw.replace('HTTP/1.1', 'HTTP/1.0');
  if (patched === raw) return false;
  await writeFile(proverPath, patched, 'utf8');
  return true;
}

async function extractRootLikeCertPem(host: string, port: number, outPath: string): Promise<void> {
  const shell =
    `openssl s_client -showcerts -servername ${host} -connect ${host}:${port} < /dev/null 2>/dev/null`;
  let stdout = '';
  try {
    const result = await execFileAsync('/bin/zsh', ['-lc', shell], {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024
    });
    stdout = result.stdout;
  } catch (error) {
    // openssl s_client can return non-zero even when it printed a valid cert chain.
    const candidate = error as { stdout?: string };
    stdout = candidate.stdout || '';
  }

  const matches = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (matches.length === 0) {
    throw new Error('failed to fetch TLS certificate chain via openssl');
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  // Preserve full chain to maximize compatibility with rustls root store loading.
  await writeFile(outPath, `${matches.join('\n')}\n`, 'utf8');
}

function waitForExit(child: import('node:child_process').ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 0));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForExitWithTimeout(
  child: import('node:child_process').ChildProcess,
  timeoutMs: number,
  onTimeout: () => void
): Promise<number> {
  return await Promise.race([
    waitForExit(child),
    (async () => {
      await sleep(timeoutMs);
      onTimeout();
      return 124;
    })()
  ]);
}

export async function runWeatherAttestation(): Promise<void> {
  const pocRoot = envOrDefault('ZKVERIFY_POC_ROOT', defaultPocRoot);
  const tlsnRoot = path.resolve(pocRoot, 'tlsnotary');
  const proverSource = path.resolve(tlsnRoot, 'src', 'bin', 'prover.rs');
  const notaryBin = path.resolve(tlsnRoot, 'target', 'debug', 'notary');
  const proverBin = path.resolve(tlsnRoot, 'target', 'debug', 'prover');
  const maxRecvData = Number.parseInt(process.env.TLSN_MAX_RECV_DATA || '262144', 10);
  const proverTimeoutMs = Number.parseInt(process.env.TLSN_PROVER_TIMEOUT_MS || '300000', 10);

  const notaryHost = envOrDefault('TLSN_NOTARY_HOST', '127.0.0.1');
  const notaryPort = Number.parseInt(envOrDefault('TLSN_NOTARY_PORT', '7047'), 10);

  const configuredServerHost = envOrDefault('TLSN_SERVER_HOST', NWS_94027_SERVER_NAME);
  const serverDomain = envOrDefault('TLSN_SERVER_DOMAIN', NWS_94027_SERVER_NAME);
  const serverPort = Number.parseInt(envOrDefault('TLSN_SERVER_PORT', '443'), 10);
  const endpoint = envOrDefault('TLSN_ENDPOINT', NWS_94027_REQUEST_PATH);
  let serverHost = configuredServerHost;
  try {
    if (configuredServerHost === NWS_94027_SERVER_NAME) {
      const resolved = await dns.lookup(configuredServerHost, { family: 4 });
      serverHost = resolved.address;
      console.log(`Resolved ${configuredServerHost} to IPv4 ${serverHost} for prover TCP connect.`);
    }
  } catch {
    serverHost = configuredServerHost;
  }

  const outputDir = path.resolve(projectRoot, 'data', 'tlsn-output', 'latest');
  const outputAttestation = path.resolve(outputDir, 'attestation.json');
  const localAttestation = path.resolve(projectRoot, 'data', 'weather-attestation.json');
  const certPath = path.resolve(projectRoot, 'data', 'tlsn-certs', `${serverDomain}.pem`);

  const signingKeyHex = process.env.TLSNOTARY_SIGNING_KEY_HEX || randomBytes(32).toString('hex');

  const preflightUrl = `https://${serverDomain}${endpoint}`;
  console.log('Preflight target URL:', preflightUrl);
  try {
    const pre = await fetch(preflightUrl, {
      headers: {
        'user-agent': 'private-prediction-market/weather-attest-preflight',
        connection: 'close'
      }
    });
    const body = await pre.text();
    console.log(
      `Preflight HTTP status: ${pre.status} ${pre.statusText}, body bytes: ${Buffer.byteLength(body, 'utf8')}`
    );
  } catch (error) {
    throw new Error(`preflight fetch failed for ${preflightUrl}: ${String(error)}`);
  }

  if (!(await exists(tlsnRoot))) {
    throw new Error(`tlsnotary repo not found: ${tlsnRoot}. Set ZKVERIFY_POC_ROOT to your zk-verify-poc path.`);
  }

  if (await exists(proverSource)) {
    const patched = await patchTlsnProverLimits(proverSource, maxRecvData);
    if (patched) {
      console.log(`Patched tlsnotary prover MAX_RECV_DATA for large weather responses (target >= ${maxRecvData}).`);
    }
    const patchedHttp = await patchTlsnProverHttpVersion(proverSource);
    if (patchedHttp) {
      console.log('Patched tlsnotary prover request to HTTP/1.0 for deterministic connection close.');
    }
  }

  if (!(await exists(notaryBin)) || !(await exists(proverBin))) {
    console.log('Building tlsnotary binaries...');
    await runChecked('cargo', ['build', '--manifest-path', path.resolve(tlsnRoot, 'Cargo.toml')], tlsnRoot);
  } else {
    // Rebuild to ensure potential source patch is applied.
    await runChecked('cargo', ['build', '--manifest-path', path.resolve(tlsnRoot, 'Cargo.toml')], tlsnRoot);
  }

  console.log('Preparing trust anchor certificate...');
  await extractRootLikeCertPem(serverDomain, serverPort, certPath);
  await mkdir(outputDir, { recursive: true });

  console.log('Starting tlsnotary notary...');
  const notary = spawn(notaryBin, [], {
    cwd: tlsnRoot,
    env: {
      ...process.env,
      RUST_LOG: process.env.TLSN_NOTARY_RUST_LOG || process.env.RUST_LOG || 'info',
      TLSN_NOTARY_HOST: notaryHost,
      TLSN_NOTARY_PORT: String(notaryPort),
      TLSN_ROOT_CERT_PATH: certPath,
      TLSNOTARY_SIGNING_KEY_HEX: signingKeyHex
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let notaryLogs = '';
  let notaryExited = false;
  let notarySpawnError: string | null = null;
  notary.stdout?.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    notaryLogs += s;
    process.stdout.write(s);
  });
  notary.stderr?.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    notaryLogs += s;
    process.stderr.write(s);
  });
  notary.on('error', (err) => {
    notarySpawnError = String(err);
  });
  notary.on('exit', () => {
    notaryExited = true;
  });

  try {
    await sleep(1200);
    if (notarySpawnError) {
      throw new Error(`notary failed to start: ${notarySpawnError}`);
    }
    if (notaryExited) {
      throw new Error(`notary exited early. Logs:\n${notaryLogs || '(no notary logs)'}`);
    }

    console.log('Running tlsnotary prover against weather source...');
    const prover = spawn(proverBin, [], {
      cwd: tlsnRoot,
      env: {
        ...process.env,
        RUST_LOG:
          process.env.TLSN_PROVER_RUST_LOG || process.env.RUST_LOG || 'info,mpc_tls::leader=error',
        TLSN_NOTARY_HOST: notaryHost,
        TLSN_NOTARY_PORT: String(notaryPort),
        TLSN_SERVER_HOST: serverHost,
        TLSN_SERVER_DOMAIN: serverDomain,
        TLSN_SERVER_PORT: String(serverPort),
        TLSN_ENDPOINT: endpoint,
        TLSN_ROOT_CERT_PATH: certPath,
        OUTPUT_DIR: outputDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let proverLogs = '';
    prover.stdout?.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      proverLogs += s;
      process.stdout.write(s);
    });
    prover.stderr?.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      proverLogs += s;
      process.stderr.write(s);
    });

    const proverCode = await waitForExitWithTimeout(prover, proverTimeoutMs, () => {
      prover.kill('SIGTERM');
    });
    if (proverCode !== 0) {
      throw new Error(
        `prover exited with code ${proverCode}. Logs:\n${proverLogs || '(no prover logs)'}`
      );
    }
  } finally {
    notary.kill('SIGTERM');
    await waitForExit(notary).catch(() => undefined);
  }

  if (!(await exists(outputAttestation))) {
    throw new Error(`attestation output missing at ${outputAttestation}`);
  }

  await copyFile(outputAttestation, localAttestation);

  console.log('Weather attestation generated.');
  console.log('Attestation file:', localAttestation);
  console.log('Set strict mode and sync:');
  console.log('export WEATHER_REQUIRE_TLSN=1');
  console.log(`export WEATHER_TLSN_ATTESTATION_FILE=${localAttestation}`);
  console.log('pnpm weather:sync');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runWeatherAttestation().catch((error: unknown) => {
    console.error('[weather-attest] failed:', error);
    process.exit(1);
  });
}
