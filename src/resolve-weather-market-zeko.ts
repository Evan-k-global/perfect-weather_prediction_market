import 'reflect-metadata';
import './env.js';
import { Bool, Field, Mina, Poseidon, PrivateKey, fetchAccount } from 'o1js';
import { readFile } from 'node:fs/promises';
import { MarketLeaf, PredictionMarketPlatform } from './contract.js';
import {
  TlsnWeatherAttestation,
  buildWeatherOracleStatementFromAttestation
} from './oracle-adapter.js';
import { verifyTlsnAttestationFile } from './tlsn-verifier.js';
import {
  DEFAULT_STATE_FILE,
  buildMarketsMerkleMap,
  buildNonceMerkleMap,
  deserializeMarketLeaf,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf
} from './state-store.js';
import { assertLocalMarketsRootMatchesChain } from './chain-state.js';
import { withTxRetry } from './tx-retry.js';

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

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

async function readAttestation(pathname: string): Promise<TlsnWeatherAttestation> {
  const raw = await readFile(pathname, 'utf8');
  const candidate = JSON.parse(raw) as Record<string, unknown>;
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
  const args = process.argv.slice(2);
  const marketKey = Field(parseArgValue(args, 'market-key'));
  const attestationPath = parseArgValue(args, 'attestation');
  const allowedServerName = parseArgValue(args, 'allowed-server');
  const allowedRequestPath = parseArgValue(args, 'allowed-path');
  const maxAgeMs = Number.parseInt(parseArgValue(args, 'max-age-ms'), 10);
  const observedAtSlotArg = parseOptionalArgValue(args, 'observed-at-slot');
  const providedNonce = parseOptionalArgValue(args, 'nonce');
  const stateFile = parseOptionalArgValue(args, 'state-file') || DEFAULT_STATE_FILE;

  const graphql = process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const networkId = process.env.ZEKO_NETWORK_ID || 'testnet';
  const txFee = process.env.TX_FEE || '200000000';
  const resolver = PrivateKey.fromBase58(readEnv('DEPLOYER_PRIVATE_KEY'));
  const zkappAddress = PrivateKey.fromBase58(readEnv('ZKAPP_PRIVATE_KEY')).toPublicKey();

  const tlsnStrict = process.env.TLSN_STRICT !== '0';
  const { attestation: verifiedAttestation, report } = await verifyTlsnAttestationFile(attestationPath, {
    allowedServerName,
    allowedRequestPath,
    maxAgeMs,
    maxFutureSkewMs: 0,
    strict: tlsnStrict,
    nowMs: Date.now()
  });
  const attestation: TlsnWeatherAttestation = {
    ...verifiedAttestation
  };
  const nonce = providedNonce
    ? Field(providedNonce)
    : Poseidon.hash([marketKey, Field(attestation.timestamp)]);

  const network = Mina.Network({
    networkId: networkId as never,
    mina: graphql,
    archive: graphql
  });
  Mina.setActiveInstance(network);

  const resolverAccount = await fetchAccount({ publicKey: resolver.toPublicKey() });
  if (resolverAccount.error) throw new Error(`Missing resolver account: ${resolverAccount.error.statusText || 'unknown'}`);

  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  if (zkappAccount.error) throw new Error('zkApp account not found. Deploy first.');

  const state = await loadOperatorState(stateFile);
  await assertLocalMarketsRootMatchesChain(zkappAddress, state);
  const existing = state.markets[marketKey.toString()];
  if (!existing) throw new Error(`market ${marketKey.toString()} missing in ${stateFile}`);
  const oldLeaf = deserializeMarketLeaf(existing);
  if (oldLeaf.resolved.toBoolean()) throw new Error('market already resolved');
  const observedAtSlot = observedAtSlotArg
    ? BigInt(observedAtSlotArg)
    : BigInt(oldLeaf.expirySlot.toString());
  const closeSlot = BigInt(oldLeaf.closeSlot.toString());
  const expirySlot = BigInt(oldLeaf.expirySlot.toString());
  if (observedAtSlot < closeSlot || observedAtSlot > expirySlot) {
    throw new Error(
      `observed-at-slot must be within market window [${closeSlot}, ${expirySlot}], got ${observedAtSlot}`
    );
  }
  const meta = state.marketMeta?.[marketKey.toString()];
  if (meta) {
    if (!meta.settlementSource.includes(allowedServerName)) {
      throw new Error('allowed server does not match market settlement source');
    }
    if (!meta.settlementSource.includes(attestation.server_name)) {
      throw new Error('attestation server does not match market settlement source');
    }
  }

  const marketsMap = buildMarketsMerkleMap(state);
  const nonceMap = buildNonceMerkleMap(state);
  if (state.usedNonces[nonce.toString()] === '1') throw new Error('oracle nonce already used');

  const { statement } = buildWeatherOracleStatementFromAttestation(
    marketKey,
    attestation,
    {
      allowedServerName,
      allowedRequestPath,
      maxAgeMs
    },
    {
      jsonPath: ['current', 'temp_c'],
      thresholdTenthC: BigInt(oldLeaf.thresholdValueTenthC.toString()),
      observedAtSlot,
      nonce
    },
    Date.now()
  );

  const resolvedLeaf = new MarketLeaf({
    configHash: oldLeaf.configHash,
    closeSlot: oldLeaf.closeSlot,
    expirySlot: oldLeaf.expirySlot,
    thresholdValueTenthC: oldLeaf.thresholdValueTenthC,
    totalPositionBet: oldLeaf.totalPositionBet,
    totalYesPositionBet: oldLeaf.totalYesPositionBet,
    resolved: Bool(true),
    outcome: statement.outcome,
    oracleStatementHash: statement.statementDigest
  });

  await PredictionMarketPlatform.compile();
  const zkapp = new PredictionMarketPlatform(zkappAddress);

  await withTxRetry(
    async () => {
      const tx = await Mina.transaction({ sender: resolver.toPublicKey(), fee: txFee }, async () => {
        zkapp.resolveWeatherMarket(
          marketKey,
          oldLeaf,
          resolvedLeaf,
          marketsMap.getWitness(marketKey),
          statement,
          nonceMap.getWitness(nonce)
        );
      });
      await tx.prove();
      await tx.sign([resolver]).send();
    },
    { label: 'resolve-weather:zeko' }
  );

  state.markets[marketKey.toString()] = serializeMarketLeaf(resolvedLeaf);
  state.usedNonces[nonce.toString()] = '1';
  await saveOperatorState(stateFile, state);

  console.log('Market resolved.');
  console.log('Market key:', marketKey.toString());
  console.log('Outcome (yes=1):', statement.outcome.toField().toString());
  console.log('Statement digest:', statement.statementDigest.toString());
  console.log('TLSN verified:', report.verified ? 'yes' : 'no');
  console.log('TLSN mode:', report.mode);
  console.log('State file:', stateFile);
}

main().catch((error: unknown) => {
  console.error('[resolve-weather-market-zeko] failed:', error);
  process.exit(1);
});
