export { FastPredictionMarketPlatform } from './fast-contract.js';
export {
  type TlsnWeatherAttestation,
  type WeatherAttestationPolicy,
  type WeatherObservationSelection,
  assertAttestationPolicy,
  buildWeatherOracleStatementFromAttestation,
  extractObservedTempTenthC,
  hashUtf8StringPoseidon
} from './oracle-adapter.js';
export {
  assertLocalMarketsRootMatchesChain,
  assertLocalReceiptsRootMatchesChain,
  getLocalMarketsRoot,
  getLocalReceiptsRoot,
  getOnChainMarketsRoot,
  getOnChainReceiptsRoot
} from './fast-chain-state.js';
export {
  DEFAULT_STATE_FILE,
  buildMarketsMerkleMap,
  buildNonceMerkleMap,
  buildReceiptsMerkleMap,
  deserializeMarketLeaf,
  loadOperatorState,
  saveOperatorState,
  serializeMarketLeaf,
  type OperatorStateFile,
  type StoredMarketLeaf,
  type StoredMarketMeta,
  type StoredReceiptMeta
} from './state-store.js';
