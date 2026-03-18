import 'reflect-metadata';
import { Bool, Field, Poseidon, Struct, UInt64 } from 'o1js';

export class MarketLeaf extends Struct({
  configHash: Field,
  closeSlot: UInt64,
  expirySlot: UInt64,
  thresholdValueTenthC: UInt64,
  totalPositionBet: UInt64,
  totalYesPositionBet: UInt64,
  resolved: Bool,
  outcome: Bool,
  oracleStatementHash: Field
}) {
  hash(): Field {
    return Poseidon.hash([
      this.configHash,
      this.closeSlot.value,
      this.expirySlot.value,
      this.thresholdValueTenthC.value,
      this.totalPositionBet.value,
      this.totalYesPositionBet.value,
      this.resolved.toField(),
      this.outcome.toField(),
      this.oracleStatementHash
    ]);
  }
}

export class WeatherOracleStatement extends Struct({
  sourceHash: Field,
  requestPathHash: Field,
  observedAtSlot: UInt64,
  observedValueTenthC: UInt64,
  thresholdValueTenthC: UInt64,
  outcome: Bool,
  nonce: Field,
  statementDigest: Field
}) {}
