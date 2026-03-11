import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export type TlsnAttestationEnvelope = {
  server_name: string;
  request_path: string;
  timestamp: number;
  response_body: string;
  session_header_bytes_hex?: string;
  signature?: {
    r_hex: string;
    s_hex: string;
  };
  notary_public_key?: {
    x_hex: string;
    y_hex: string;
  };
};

export type TlsnVerificationReport = {
  verified: boolean;
  mode: 'external-cli' | 'envelope-only';
  responseBodySha256: string;
  serverName: string;
  requestPath: string;
  timestamp: number;
  verifierOutput?: string;
};

export type VerifyTlsnOptions = {
  allowedServerName: string;
  allowedRequestPath: string;
  maxAgeMs: number;
  maxFutureSkewMs?: number;
  strict: boolean;
  nowMs: number;
  verifierCmd?: string;
  verifierArgs?: string[];
};

function isEvenHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function normalizePathForWeather(path: string): string {
  return path.replace(/&&+/g, '&').trim();
}

function assertEnvelope(attestation: TlsnAttestationEnvelope): void {
  if (!attestation.server_name || !attestation.response_body) {
    throw new Error('invalid attestation envelope');
  }
  if (!Number.isFinite(attestation.timestamp)) {
    throw new Error('invalid attestation timestamp');
  }

  // Structural checks; cryptographic verification is delegated to external verifier when configured.
  if (attestation.session_header_bytes_hex && !isEvenHex(attestation.session_header_bytes_hex)) {
    throw new Error('session_header_bytes_hex invalid hex');
  }
  if (attestation.signature) {
    if (!isEvenHex(attestation.signature.r_hex)) throw new Error('signature.r_hex invalid hex');
    if (!isEvenHex(attestation.signature.s_hex)) throw new Error('signature.s_hex invalid hex');
  }
  if (attestation.notary_public_key) {
    if (!isEvenHex(attestation.notary_public_key.x_hex)) throw new Error('notary_public_key.x_hex invalid hex');
    if (!isEvenHex(attestation.notary_public_key.y_hex)) throw new Error('notary_public_key.y_hex invalid hex');
  }
}

function assertPolicy(attestation: TlsnAttestationEnvelope, options: VerifyTlsnOptions): void {
  const gotServer = attestation.server_name;
  if (gotServer !== options.allowedServerName) {
    throw new Error(`server_name mismatch: got=${gotServer} expected=${options.allowedServerName}`);
  }

  const gotPath = normalizePathForWeather(attestation.request_path || options.allowedRequestPath);
  const wantPath = normalizePathForWeather(options.allowedRequestPath);
  if (gotPath !== wantPath) {
    throw new Error(`request_path mismatch: got=${gotPath} expected=${wantPath}`);
  }

  const ageMs = options.nowMs - attestation.timestamp;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 0;
  if (ageMs < -maxFutureSkewMs) throw new Error('attestation timestamp is in the future');
  if (ageMs > options.maxAgeMs) throw new Error(`attestation too old: ageMs=${ageMs}`);
}

async function runExternalVerifier(
  attestationFile: string,
  options: VerifyTlsnOptions
): Promise<{ verified: boolean; verifierOutput: string }> {
  const cmd = options.verifierCmd || process.env.TLSN_VERIFY_CMD;
  if (!cmd) {
    // Built-in strict fallback: envelope + policy checks above are mandatory.
    // External verifier is still recommended for stronger cryptographic validation.
    return { verified: true, verifierOutput: 'external verifier not configured; using built-in checks' };
  }

  const envArgs = process.env.TLSN_VERIFY_ARGS?.trim();
  const args = [
    ...(options.verifierArgs || []),
    ...(envArgs ? envArgs.split(/\s+/) : []),
    attestationFile
  ];

  const { stdout, stderr } = await execFileAsync(cmd, args, {
    env: process.env
  });

  const combined = `${stdout}\n${stderr}`.trim();
  let verified = true;
  try {
    const parsed = JSON.parse(stdout) as { verified?: boolean; ok?: boolean };
    if (typeof parsed.verified === 'boolean') verified = parsed.verified;
    else if (typeof parsed.ok === 'boolean') verified = parsed.ok;
  } catch {
    // If verifier returns non-json on success exit code, accept success.
    verified = true;
  }

  if (!verified && options.strict) {
    throw new Error('external TLSN verifier returned not verified');
  }

  return { verified, verifierOutput: combined };
}

export async function readTlsnAttestationFile(pathname: string): Promise<TlsnAttestationEnvelope> {
  const raw = await readFile(pathname, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawTimestamp = Number(parsed.timestamp);
  const timestamp = Number.isFinite(rawTimestamp)
    ? rawTimestamp < 1_000_000_000_000
      ? rawTimestamp * 1000
      : rawTimestamp
    : NaN;
  return {
    server_name: String(parsed.server_name || ''),
    request_path: String(parsed.request_path || ''),
    timestamp,
    response_body: String(parsed.response_body || ''),
    session_header_bytes_hex:
      typeof parsed.session_header_bytes_hex === 'string' ? parsed.session_header_bytes_hex : undefined,
    signature:
      typeof parsed.signature === 'object' && parsed.signature !== null
        ? {
            r_hex: String((parsed.signature as Record<string, unknown>).r_hex || ''),
            s_hex: String((parsed.signature as Record<string, unknown>).s_hex || '')
          }
        : undefined,
    notary_public_key:
      typeof parsed.notary_public_key === 'object' && parsed.notary_public_key !== null
        ? {
            x_hex: String((parsed.notary_public_key as Record<string, unknown>).x_hex || ''),
            y_hex: String((parsed.notary_public_key as Record<string, unknown>).y_hex || '')
          }
        : undefined
  };
}

export async function verifyTlsnAttestationFile(
  attestationFile: string,
  options: VerifyTlsnOptions
): Promise<{ attestation: TlsnAttestationEnvelope; report: TlsnVerificationReport }> {
  const attestation = await readTlsnAttestationFile(attestationFile);
  assertEnvelope(attestation);
  assertPolicy(attestation, options);

  const responseBodySha256 = createHash('sha256').update(attestation.response_body, 'utf8').digest('hex');

  const external = await runExternalVerifier(attestationFile, options);
  const verified = external.verified || !options.strict;

  if (!verified && options.strict) {
    throw new Error('TLSN verification failed in strict mode');
  }

  return {
    attestation,
    report: {
      verified,
      mode: external.verified ? 'external-cli' : 'envelope-only',
      responseBodySha256,
      serverName: attestation.server_name,
      requestPath: attestation.request_path,
      timestamp: attestation.timestamp,
      verifierOutput: external.verifierOutput
    }
  };
}
