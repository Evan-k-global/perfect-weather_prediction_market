import './env.js';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import net from 'node:net';
import { NWS_94027_REQUEST_PATH, NWS_94027_SERVER_NAME } from './weather-service.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_TLSN_STATUS_PATH = path.resolve(projectRoot, 'data', 'tlsn-output', 'latest', 'status.json');

function envOrDefault(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

async function detectPocRoot(): Promise<string> {
  const candidates = [
    process.env.ZKVERIFY_POC_ROOT || '',
    '/opt/zk-verify-poc',
    path.resolve(projectRoot, 'external', 'zk-verify-poc'),
    '/Users/evankereiakes/Documents/Codex/tokenized-asset-protocol/external/zk-verify-poc'
  ].filter((value) => value.length > 0);

  for (const candidate of candidates) {
    const tlsnRoot = path.resolve(candidate, 'tlsnotary');
    if (await exists(tlsnRoot)) {
      return candidate;
    }
  }

  return candidates[0] || path.resolve(projectRoot, 'external', 'zk-verify-poc');
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function newerThan(pathA: string, pathB: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(pathA), stat(pathB)]);
    return a.mtimeMs > b.mtimeMs;
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

async function persistTlsnLogs(outputDir: string, proverLogs: string, notaryLogs: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'last-prover.log'), proverLogs, 'utf8');
  await writeFile(path.join(outputDir, 'last-notary.log'), notaryLogs, 'utf8');
}

async function writeTlsnStatus(
  status: {
    stage: string;
    ok: boolean;
    ts: string;
    message?: string;
    serverHost?: string;
    serverDomain?: string;
    endpoint?: string;
  },
  filePath: string = DEFAULT_TLSN_STATUS_PATH
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(status, null, 2), 'utf8');
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

function derToPem(raw: Buffer): string {
  const b64 = raw.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

async function extractRootLikeCertPem(host: string, port: number, outPath: string): Promise<void> {
  const pemChain = await new Promise<string[]>((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false
      },
      () => {
        try {
          const certs: string[] = [];
          let current = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate | tls.PeerCertificate;
          const seen = new Set<string>();
          while (current && 'raw' in current && current.raw && current.raw.length > 0) {
            const fingerprint = 'fingerprint256' in current ? current.fingerprint256 : '';
            if (fingerprint && seen.has(fingerprint)) break;
            if (fingerprint) seen.add(fingerprint);
            certs.push(derToPem(current.raw));
            const issuer = 'issuerCertificate' in current ? current.issuerCertificate : undefined;
            if (!issuer || issuer === current) break;
            current = issuer as tls.DetailedPeerCertificate;
          }
          socket.end();
          resolve(certs);
        } catch (error) {
          reject(error);
        }
      }
    );
    socket.once('error', reject);
    socket.setTimeout(15000, () => {
      socket.destroy(new Error('timed out fetching TLS certificate chain'));
    });
  });

  if (pemChain.length === 0) {
    throw new Error('failed to fetch TLS certificate chain via node tls');
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${pemChain.join('\n')}\n`, 'utf8');
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

async function waitForLogMatch(
  getLogs: () => string,
  pattern: RegExp,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pattern.test(getLogs())) return true;
    await sleep(50);
  }
  return false;
}

async function pickAvailablePort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to pick available port')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function runPreflightFetch(url: string): Promise<void> {
  const attempts = Number.parseInt(process.env.WEATHER_PREFLIGHT_ATTEMPTS || '3', 10);
  let lastError: unknown = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const pre = await fetch(url, {
        headers: {
          'user-agent': 'private-prediction-market/weather-attest-preflight',
          connection: 'close'
        }
      });
      const body = await pre.text();
      console.log(
        `Preflight HTTP status: ${pre.status} ${pre.statusText}, body bytes: ${Buffer.byteLength(body, 'utf8')}`
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[weather-attest] preflight attempt ${i}/${attempts} failed: ${String(error)}`);
      if (i < attempts) {
        await sleep(1000 * i);
      }
    }
  }
  console.warn(`[weather-attest] continuing without successful preflight: ${String(lastError)}`);
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

async function terminateChild(
  child: import('node:child_process').ChildProcess,
  timeoutMs: number
): Promise<void> {
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.kill('SIGTERM');
  await Promise.race([
    waitForExit(child).catch(() => undefined),
    (async () => {
      await sleep(timeoutMs);
      if (!exited) {
        child.kill('SIGKILL');
      }
    })()
  ]);
}

export async function runWeatherAttestation(): Promise<void> {
  const pocRoot = await detectPocRoot();
  const tlsnRoot = path.resolve(pocRoot, 'tlsnotary');
  const proverSource = path.resolve(tlsnRoot, 'src', 'bin', 'prover.rs');
  const notaryBin = path.resolve(tlsnRoot, 'target', 'debug', 'notary');
  const proverBin = path.resolve(tlsnRoot, 'target', 'debug', 'prover');
  const maxRecvData = Number.parseInt(process.env.TLSN_MAX_RECV_DATA || '262144', 10);
  const proverTimeoutMs = Number.parseInt(process.env.TLSN_PROVER_TIMEOUT_MS || '120000', 10);
  const notaryReadyWaitMs = Number.parseInt(
    process.env.TLSN_NOTARY_READY_WAIT_MS || (process.env.RENDER ? '1500' : '300'),
    10
  );

  const notaryHost = envOrDefault('TLSN_NOTARY_HOST', '127.0.0.1');
  const configuredNotaryPort = process.env.TLSN_NOTARY_PORT;
  const notaryPort = configuredNotaryPort
    ? Number.parseInt(configuredNotaryPort, 10)
    : await pickAvailablePort(notaryHost);

  const configuredServerHost = envOrDefault('TLSN_SERVER_HOST', NWS_94027_SERVER_NAME);
  const serverDomain = envOrDefault('TLSN_SERVER_DOMAIN', NWS_94027_SERVER_NAME);
  const serverPort = Number.parseInt(envOrDefault('TLSN_SERVER_PORT', '443'), 10);
  const endpoint = envOrDefault('TLSN_ENDPOINT', NWS_94027_REQUEST_PATH);
  let serverHost = configuredServerHost;
  try {
    const shouldPreferIpv4 =
      process.env.TLSN_USE_HOSTNAME_CONNECT !== '1' &&
      configuredServerHost === NWS_94027_SERVER_NAME;
    if ((process.env.TLSN_FORCE_SERVER_IP === '1' || shouldPreferIpv4) && configuredServerHost === NWS_94027_SERVER_NAME) {
      const resolved = await dns.lookup(configuredServerHost, { family: 4 });
      serverHost = resolved.address;
      console.log(`Resolved ${configuredServerHost} to IPv4 ${serverHost} for prover TCP connect.`);
    }
  } catch {
    serverHost = configuredServerHost;
  }

  const outputDir = path.resolve(projectRoot, process.env.TLSN_OUTPUT_DIR || 'data/tlsn-output/latest');
  const outputAttestation = path.resolve(outputDir, process.env.TLSN_OUTPUT_ATTESTATION_FILE || 'attestation.json');
  const archiveDir = path.resolve(projectRoot, process.env.TLSN_ARCHIVE_DIR || 'data/tlsn-output/archive');
  const localAttestation = path.resolve(
    projectRoot,
    process.env.WEATHER_TLSN_LOCAL_ATTESTATION_FILE || 'data/weather-attestation.json'
  );
  const certPath = path.resolve(projectRoot, 'data', 'tlsn-certs', `${serverDomain}.pem`);

  const signingKeyHex = process.env.TLSNOTARY_SIGNING_KEY_HEX || randomBytes(32).toString('hex');
  const statusPath = process.env.TLSN_STATUS_FILE || DEFAULT_TLSN_STATUS_PATH;

  const preflightUrl = `https://${serverDomain}${endpoint}`;
  console.log('Preflight target URL:', preflightUrl);
  await writeTlsnStatus(
    {
      stage: 'preflight',
      ok: false,
      ts: new Date().toISOString(),
      serverHost,
      serverDomain,
      endpoint
    },
    statusPath
  );
  await runPreflightFetch(preflightUrl);

  if (!(await exists(tlsnRoot))) {
    throw new Error(`tlsnotary repo not found: ${tlsnRoot}. Set ZKVERIFY_POC_ROOT to your zk-verify-poc path.`);
  }

  console.log('[weather-attest] tlsn config:');
  console.log(`  pocRoot=${pocRoot}`);
  console.log(`  tlsnRoot=${tlsnRoot}`);
  console.log(`  notaryBin=${notaryBin}`);
  console.log(`  proverBin=${proverBin}`);
  console.log(`  certPath=${certPath}`);
  console.log(`  outputDir=${outputDir}`);
  console.log(`  serverHost=${serverHost}`);
  console.log(`  serverDomain=${serverDomain}`);
  console.log(`  endpoint=${endpoint}`);

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

  const forceRebuild = process.env.TLSN_FORCE_REBUILD === '1';
  const sourceChanged =
    (await newerThan(proverSource, proverBin)) ||
    (await newerThan(path.resolve(tlsnRoot, 'src', 'bin', 'notary.rs'), notaryBin)) ||
    (await newerThan(path.resolve(tlsnRoot, 'Cargo.toml'), proverBin));
  if (forceRebuild || sourceChanged || !(await exists(notaryBin)) || !(await exists(proverBin))) {
    console.log('Building tlsnotary binaries...');
    await runChecked('cargo', ['build', '--manifest-path', path.resolve(tlsnRoot, 'Cargo.toml')], tlsnRoot);
  } else {
    console.log('Using existing tlsnotary binaries.');
  }

  console.log('Preparing trust anchor certificate...');
  await writeTlsnStatus({ stage: 'prepare-cert', ok: false, ts: new Date().toISOString(), serverHost, serverDomain, endpoint }, statusPath);
  await extractRootLikeCertPem(serverDomain, serverPort, certPath);
  await mkdir(outputDir, { recursive: true });

  console.log('Starting tlsnotary notary...');
  await writeTlsnStatus({ stage: 'notary-starting', ok: false, ts: new Date().toISOString(), serverHost, serverDomain, endpoint }, statusPath);
  const notary = spawn(notaryBin, [], {
    cwd: tlsnRoot,
    env: {
      ...process.env,
      RUST_BACKTRACE: process.env.RUST_BACKTRACE || '1',
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
    const sawListenLog = await waitForLogMatch(() => notaryLogs, /listening on /i, notaryReadyWaitMs);
    if (!sawListenLog) {
      await sleep(notaryReadyWaitMs);
    }
    if (notarySpawnError) {
      await writeTlsnStatus({ stage: 'notary-error', ok: false, ts: new Date().toISOString(), message: notarySpawnError, serverHost, serverDomain, endpoint }, statusPath);
      throw new Error(`notary failed to start: ${notarySpawnError}`);
    }
    if (notaryExited) {
      await writeTlsnStatus({ stage: 'notary-exited', ok: false, ts: new Date().toISOString(), message: notaryLogs || '(no notary logs)', serverHost, serverDomain, endpoint }, statusPath);
      throw new Error(`notary exited early. Logs:\n${notaryLogs || '(no notary logs)'}`);
    }

    console.log('Running tlsnotary prover against weather source...');
    await writeTlsnStatus({ stage: 'prover-starting', ok: false, ts: new Date().toISOString(), serverHost, serverDomain, endpoint }, statusPath);
    const prover = spawn(proverBin, [], {
      cwd: tlsnRoot,
      env: {
        ...process.env,
        RUST_BACKTRACE: process.env.RUST_BACKTRACE || '1',
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
    let proverSpawnError: string | null = null;
    let proverExited = false;
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
    prover.on('error', (err) => {
      proverSpawnError = String(err);
    });
    prover.on('exit', () => {
      proverExited = true;
    });

    const proverCode = await waitForExitWithTimeout(prover, proverTimeoutMs, () => {
      prover.kill('SIGTERM');
      setTimeout(() => {
        if (!proverExited) {
          prover.kill('SIGKILL');
        }
      }, 5_000);
    });
    await persistTlsnLogs(outputDir, proverLogs, notaryLogs);
    if (proverSpawnError) {
      await writeTlsnStatus({ stage: 'prover-error', ok: false, ts: new Date().toISOString(), message: proverSpawnError, serverHost, serverDomain, endpoint }, statusPath);
      throw new Error(`prover failed to start: ${proverSpawnError}. Logs written to ${outputDir}`);
    }
    if (!proverExited && proverCode === 124) {
      await writeTlsnStatus({ stage: 'prover-timeout', ok: false, ts: new Date().toISOString(), message: `timed out after ${proverTimeoutMs}ms`, serverHost, serverDomain, endpoint }, statusPath);
      throw new Error(`prover timed out after ${proverTimeoutMs}ms. Logs written to ${outputDir}`);
    }
    if (proverCode !== 0) {
      await writeTlsnStatus({ stage: 'prover-exited', ok: false, ts: new Date().toISOString(), message: `exit code ${proverCode}`, serverHost, serverDomain, endpoint }, statusPath);
      throw new Error(
        `prover exited with code ${proverCode}. Logs written to ${outputDir}.\nProver logs:\n${
          proverLogs || '(no prover logs)'
        }\nNotary logs:\n${notaryLogs || '(no notary logs)'}`
      );
    }
  } finally {
    await terminateChild(notary, 5_000).catch(() => undefined);
  }

  if (!(await exists(outputAttestation))) {
    await writeTlsnStatus({ stage: 'attestation-missing', ok: false, ts: new Date().toISOString(), message: `missing ${outputAttestation}`, serverHost, serverDomain, endpoint }, statusPath);
    throw new Error(`attestation output missing at ${outputAttestation}`);
  }

  await copyFile(outputAttestation, localAttestation);
  await archiveAttestation(outputAttestation, archiveDir);
  await archiveAttestationByMarketDate(outputAttestation, archiveDir);
  await writeTlsnStatus({ stage: 'done', ok: true, ts: new Date().toISOString(), serverHost, serverDomain, endpoint }, statusPath);

  console.log('Weather attestation generated.');
  console.log('Attestation file:', localAttestation);
  console.log('Set strict mode and sync:');
  console.log('export WEATHER_REQUIRE_TLSN=1');
  console.log(`export WEATHER_TLSN_ATTESTATION_FILE=${localAttestation}`);
  console.log('pnpm weather:sync');
}

function sanitizeTsForPath(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[:.]/g, '-');
}

async function archiveAttestation(sourcePath: string, archiveDir: string): Promise<void> {
  const raw = await readFile(sourcePath, 'utf8');
  const parsed = JSON.parse(raw) as { timestamp?: number; request_path?: string };
  const ts = typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp)
    ? parsed.timestamp
    : Math.floor(Date.now() / 1000);
  await mkdir(archiveDir, { recursive: true });
  const archived = path.join(archiveDir, `${sanitizeTsForPath(ts)}-attestation.json`);
  await copyFile(sourcePath, archived);
}

async function archiveAttestationByMarketDate(sourcePath: string, archiveDir: string): Promise<void> {
  const raw = await readFile(sourcePath, 'utf8');
  const parsed = JSON.parse(raw) as { response_body?: string };
  if (typeof parsed.response_body !== 'string') return;
  const responseJson = JSON.parse(parsed.response_body) as {
    properties?: { periods?: Array<{ startTime?: string }> };
    features?: Array<{ properties?: { timestamp?: string } }>;
  };
  const periods = responseJson.properties?.periods || [];
  const marketDates = new Set<string>(
    periods
      .map((period) => (typeof period.startTime === 'string' ? period.startTime.slice(0, 10) : null))
      .filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)))
  );
  const observationDates = (responseJson.features || [])
    .map((feature) =>
      typeof feature?.properties?.timestamp === 'string'
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }).format(new Date(feature.properties.timestamp))
        : null
    )
    .filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)));
  for (const marketDate of observationDates) {
    marketDates.add(marketDate);
  }
  if (marketDates.size === 0) return;
  await mkdir(archiveDir, { recursive: true });
  for (const marketDate of marketDates) {
    await copyFile(sourcePath, path.join(archiveDir, `${marketDate}-attestation.json`));
  }
}

export async function findArchivedAttestationForMarketDate(
  marketDateIso: string,
  archiveDir: string = path.resolve(projectRoot, 'data', 'tlsn-output', 'archive')
): Promise<string | null> {
  if (!(await exists(archiveDir))) return null;
  const exactPath = path.join(archiveDir, `${marketDateIso}-attestation.json`);
  if (await exists(exactPath)) return exactPath;
  const entries = (await readdir(archiveDir))
    .filter((name) => name.endsWith('-attestation.json'))
    .sort()
    .reverse();
  for (const name of entries) {
    const fullPath = path.join(archiveDir, name);
    try {
      const raw = await readFile(fullPath, 'utf8');
      const parsed = JSON.parse(raw) as { response_body?: string };
      if (typeof parsed.response_body !== 'string') continue;
      const responseJson = JSON.parse(parsed.response_body) as {
        properties?: { periods?: Array<{ startTime?: string }> };
        features?: Array<{ properties?: { timestamp?: string } }>;
      };
      const periods = responseJson.properties?.periods || [];
      if (periods.some((period) => typeof period.startTime === 'string' && period.startTime.slice(0, 10) === marketDateIso)) {
        return fullPath;
      }
      const features = responseJson.features || [];
      if (
        features.some((feature) => {
          const timestamp = feature?.properties?.timestamp;
          if (typeof timestamp !== 'string') return false;
          const localDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }).format(new Date(timestamp));
          return localDate === marketDateIso;
        })
      ) {
        return fullPath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runWeatherAttestation().catch((error: unknown) => {
    console.error('[weather-attest] failed:', error);
    process.exit(1);
  });
}
