import './env.js';
import { Field, Poseidon } from 'o1js';
import { readFile } from 'node:fs/promises';
import {
  TlsnWeatherAttestation,
  buildWeatherOracleStatementFromAttestation
} from './oracle-adapter.js';

type CliArgs = {
  attestationPath: string;
  marketKey: Field;
  allowedServerName: string;
  allowedRequestPath: string;
  maxAgeMs: number;
  thresholdTenthC: bigint;
  observedAtSlot: bigint;
  nonce: Field;
};

function parseArgValue(args: string[], name: string): string {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);

  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];

  throw new Error(`Missing required argument --${name}`);
}

function parseArgs(argv: string[]): CliArgs {
  return {
    attestationPath: parseArgValue(argv, 'attestation'),
    marketKey: Field(parseArgValue(argv, 'market-key')),
    allowedServerName: parseArgValue(argv, 'allowed-server'),
    allowedRequestPath: parseArgValue(argv, 'allowed-path'),
    maxAgeMs: Number.parseInt(parseArgValue(argv, 'max-age-ms'), 10),
    thresholdTenthC: BigInt(parseArgValue(argv, 'threshold-tenth-c')),
    observedAtSlot: BigInt(parseArgValue(argv, 'observed-at-slot')),
    nonce: Field(parseArgValue(argv, 'nonce'))
  };
}

function readAttestationJson(text: string): TlsnWeatherAttestation {
  const candidate = JSON.parse(text) as Record<string, unknown>;
  if (typeof candidate.server_name !== 'string') throw new Error('attestation.server_name required');
  if (typeof candidate.request_path !== 'string') throw new Error('attestation.request_path required');
  if (typeof candidate.timestamp !== 'number') throw new Error('attestation.timestamp required');
  if (typeof candidate.response_body !== 'string') throw new Error('attestation.response_body required');
  return {
    server_name: candidate.server_name,
    request_path: candidate.request_path,
    timestamp: candidate.timestamp,
    response_body: candidate.response_body,
    session_header_bytes_hex:
      typeof candidate.session_header_bytes_hex === 'string' ? candidate.session_header_bytes_hex : undefined,
    signature:
      typeof candidate.signature === 'object' && candidate.signature !== null
        ? {
            r_hex: String((candidate.signature as Record<string, unknown>).r_hex || ''),
            s_hex: String((candidate.signature as Record<string, unknown>).s_hex || '')
          }
        : undefined,
    notary_public_key:
      typeof candidate.notary_public_key === 'object' && candidate.notary_public_key !== null
        ? {
            x_hex: String((candidate.notary_public_key as Record<string, unknown>).x_hex || ''),
            y_hex: String((candidate.notary_public_key as Record<string, unknown>).y_hex || '')
          }
        : undefined
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const attestationRaw = await readFile(args.attestationPath, 'utf8');
  const attestation = readAttestationJson(attestationRaw);

  const { statement, sourceHash, requestPathHash } = buildWeatherOracleStatementFromAttestation(
    args.marketKey,
    attestation,
    {
      allowedServerName: args.allowedServerName,
      allowedRequestPath: args.allowedRequestPath,
      maxAgeMs: args.maxAgeMs
    },
    {
      jsonPath: ['current', 'temp_c'],
      thresholdTenthC: args.thresholdTenthC,
      observedAtSlot: args.observedAtSlot,
      nonce: args.nonce
    },
    Date.now()
  );

  const output = {
    marketKey: args.marketKey.toString(),
    sourceHash: sourceHash.toString(),
    requestPathHash: requestPathHash.toString(),
    statement: {
      observedAtSlot: statement.observedAtSlot.toString(),
      observedValueTenthC: statement.observedValueTenthC.toString(),
      thresholdValueTenthC: statement.thresholdValueTenthC.toString(),
      outcome: statement.outcome.toField().toString(),
      nonce: statement.nonce.toString(),
      statementDigest: statement.statementDigest.toString()
    }
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error: unknown) => {
  console.error('[resolve-from-attestation] failed:', error);
  process.exit(1);
});

export function makeDeterministicNonce(marketKey: Field, timestampMs: number): Field {
  return Poseidon.hash([marketKey, Field(timestampMs)]);
}
