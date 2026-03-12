import { Field, Poseidon, UInt64 } from 'o1js';
import { WeatherOracleStatement } from './contract.js';

export interface TlsnWeatherAttestation {
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
}

export interface WeatherAttestationPolicy {
  allowedServerName: string;
  allowedRequestPath: string;
  maxAgeMs: number;
  maxFutureSkewMs?: number;
  requireTlsnEnvelope?: boolean;
}

export interface WeatherObservationSelection {
  jsonPath: string[];
  thresholdTenthC: bigint;
  observedAtSlot: bigint;
  nonce: Field;
  marketDateIso?: string;
}

export function hashUtf8StringPoseidon(value: string): Field {
  const bytes = Buffer.from(value, 'utf8');
  const fields = [...bytes].map((byte) => Field(byte));
  return Poseidon.hash(fields.length === 0 ? [Field(0)] : fields);
}

function toFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return value;
}

function toObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isEvenHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function assertTlsnEnvelope(attestation: TlsnWeatherAttestation): void {
  if (!attestation.session_header_bytes_hex || !isEvenHex(attestation.session_header_bytes_hex)) {
    throw new Error('session_header_bytes_hex missing or invalid');
  }
  if (!attestation.signature?.r_hex || !isEvenHex(attestation.signature.r_hex)) {
    throw new Error('signature.r_hex missing or invalid');
  }
  if (!attestation.signature?.s_hex || !isEvenHex(attestation.signature.s_hex)) {
    throw new Error('signature.s_hex missing or invalid');
  }
  if (!attestation.notary_public_key?.x_hex || !isEvenHex(attestation.notary_public_key.x_hex)) {
    throw new Error('notary_public_key.x_hex missing or invalid');
  }
  if (!attestation.notary_public_key?.y_hex || !isEvenHex(attestation.notary_public_key.y_hex)) {
    throw new Error('notary_public_key.y_hex missing or invalid');
  }
}

function readPath(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      throw new Error(`response path ${path.join('.')} not found`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function assertAttestationPolicy(
  attestation: TlsnWeatherAttestation,
  policy: WeatherAttestationPolicy,
  nowMs: number
): void {
  if (attestation.server_name !== policy.allowedServerName) {
    throw new Error(`server_name mismatch: got ${attestation.server_name}`);
  }
  if (attestation.request_path !== policy.allowedRequestPath) {
    throw new Error(`request_path mismatch: got ${attestation.request_path}`);
  }

  const ageMs = nowMs - attestation.timestamp;
  const maxFutureSkewMs = policy.maxFutureSkewMs ?? 0;
  if (ageMs < -maxFutureSkewMs) {
    throw new Error('attestation timestamp is in the future');
  }
  if (ageMs > policy.maxAgeMs) {
    throw new Error(`attestation is stale: ageMs=${ageMs}`);
  }
  if (policy.requireTlsnEnvelope ?? true) {
    assertTlsnEnvelope(attestation);
  }
}

export function extractObservedTempTenthC(
  attestation: TlsnWeatherAttestation,
  jsonPath: string[],
  marketDateIso?: string
): UInt64 {
  const responseJson = toObject(JSON.parse(attestation.response_body), 'response_body');
  let tempF: number | null = null;

  if (marketDateIso) {
    const properties = toObject(responseJson.properties, 'response_body.properties');
    const periods = properties.periods;
    if (!Array.isArray(periods)) {
      throw new Error('response_body.properties.periods must be an array');
    }
    const matches = periods.filter((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const period = value as Record<string, unknown>;
      const startTime = typeof period.startTime === 'string' ? period.startTime : '';
      const temperature = period.temperature;
      const isDaytime = period.isDaytime;
      if (!startTime || typeof temperature !== 'number' || !Number.isFinite(temperature)) return false;
      if (typeof isDaytime === 'boolean' && !isDaytime) return false;
      const day = startTime.slice(0, 10);
      return day === marketDateIso;
    }) as Array<Record<string, unknown>>;
    if (matches.length === 0) {
      throw new Error(`forecast period for market date ${marketDateIso} not found`);
    }
    tempF = Math.max(...matches.map((period) => Number(period.temperature)));
  } else {
    const raw = readPath(responseJson, jsonPath);
    tempF = toFiniteNumber(raw, `response_body.${jsonPath.join('.')}`);
  }

  const tempC = ((tempF - 32) * 5) / 9;
  const tenthC = Math.round(tempC * 10);
  // Bound weather feed values to a sane operational range.
  if (tenthC < 0 || tenthC > 800) {
    throw new Error('observed temperature must be in [0, 80.0C] for this v1 weather template');
  }
  return UInt64.from(tenthC);
}

export function buildWeatherOracleStatementFromAttestation(
  marketKey: Field,
  attestation: TlsnWeatherAttestation,
  policy: WeatherAttestationPolicy,
  selection: WeatherObservationSelection,
  nowMs: number
): {
  statement: WeatherOracleStatement;
  sourceHash: Field;
  requestPathHash: Field;
} {
  assertAttestationPolicy(attestation, policy, nowMs);
  const observedValueTenthC = extractObservedTempTenthC(
    attestation,
    selection.jsonPath,
    selection.marketDateIso
  );
  const thresholdValueTenthC = UInt64.from(selection.thresholdTenthC);
  const outcome = observedValueTenthC.greaterThan(thresholdValueTenthC);

  const sourceHash = hashUtf8StringPoseidon(attestation.server_name);
  const requestPathHash = hashUtf8StringPoseidon(attestation.request_path);
  const observedAtSlot = UInt64.from(selection.observedAtSlot);

  const statementDigest = Poseidon.hash([
    marketKey,
    sourceHash,
    requestPathHash,
    observedAtSlot.value,
    observedValueTenthC.value,
    thresholdValueTenthC.value,
    outcome.toField(),
    selection.nonce
  ]);

  return {
    sourceHash,
    requestPathHash,
    statement: new WeatherOracleStatement({
      sourceHash,
      requestPathHash,
      observedAtSlot,
      observedValueTenthC,
      thresholdValueTenthC,
      outcome,
      nonce: selection.nonce,
      statementDigest
    })
  };
}
