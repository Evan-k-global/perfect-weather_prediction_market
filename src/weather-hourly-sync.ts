import './env.js';
import {
  NWS_94027_DIGITAL_URL,
  NWS_94027_REQUEST_PATH,
  NWS_94027_SERVER_NAME,
  NWS_94027_STRICT_URL,
  buildSevenDayHighProbabilities,
  currentLocalDate,
  fetchNws94027Snapshot,
  nowLocalHour,
  saveWeatherSnapshot,
  snapshotFromTlsnAttestation
} from './weather-service.js';
import { existsSync } from 'node:fs';
import { loadContestState, maybeAutoSettleContest, saveContestState } from './weather-contest.js';
import { verifyTlsnAttestationFile } from './tlsn-verifier.js';

export async function runWeatherSync(): Promise<void> {
  const thresholdF = Number.parseFloat(process.env.WEATHER_THRESHOLD_F || '68');
  const strict = process.env.WEATHER_REQUIRE_TLSN === '1';
  const envAttestationPath = process.env.WEATHER_TLSN_ATTESTATION_FILE;
  const defaultAttestationPath = './data/weather-attestation.json';
  const attestationPath = envAttestationPath || defaultAttestationPath;
  const maxAgeMs = Number.parseInt(process.env.WEATHER_TLSN_MAX_AGE_MS || '3600000', 10);
  const shouldUseTlsn = strict || Boolean(envAttestationPath) || existsSync(defaultAttestationPath);

  let snapshot;
  let verificationMode = 'insecure-direct-fetch';

  if (shouldUseTlsn) {
    const { attestation, report } = await verifyTlsnAttestationFile(attestationPath, {
      allowedServerName: NWS_94027_SERVER_NAME,
      allowedRequestPath: NWS_94027_REQUEST_PATH,
      maxAgeMs,
      maxFutureSkewMs: 0,
      strict,
      nowMs: Date.now()
    });
    snapshot = snapshotFromTlsnAttestation(attestation, report, NWS_94027_STRICT_URL);
    verificationMode = report.mode;
  } else {
    snapshot = await fetchNws94027Snapshot(NWS_94027_STRICT_URL);
  }

  await saveWeatherSnapshot(snapshot);

  let contest = await loadContestState(currentLocalDate(), 15);
  contest = maybeAutoSettleContest(contest, snapshot, nowLocalHour(), Date.now());
  await saveContestState(contest);

  const probs = buildSevenDayHighProbabilities(snapshot.dailyHighsF, thresholdF);

  console.log('Weather sync complete.');
  console.log('Source:', snapshot.sourceUrl || NWS_94027_DIGITAL_URL);
  console.log('Local date:', snapshot.localDate);
  console.log('Verified:', snapshot.verified ? 'yes' : 'no');
  console.log('Verification mode:', verificationMode);
  console.log('Next24h high F:', snapshot.next24hHighF);
  console.log('7-day probability points:', probs.length);
  console.log('Contest settled:', contest.settled ? 'yes' : 'no');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runWeatherSync().catch((error: unknown) => {
    console.error('[weather-hourly-sync] failed:', error);
    process.exit(1);
  });
}
