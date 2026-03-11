import { Bool, Field, Poseidon, Struct, UInt64 } from 'o1js';

// These types are a contract-upgrade scaffold for future per-date payout support.

export class DateKeyedMarketRef extends Struct({
  baseConfigHash: Field,
  localDateField: Field,
  marketKey: Field
}) {}

export class PositionCommitmentLeaf extends Struct({
  marketKey: Field,
  sideOver: Bool,
  stake: UInt64,
  ownerCommitment: Field,
  salt: Field
}) {
  hash(): Field {
    return Poseidon.hash([
      this.marketKey,
      this.sideOver.toField(),
      this.stake.value,
      this.ownerCommitment,
      this.salt
    ]);
  }
}

export class ClaimNullifierLeaf extends Struct({
  nullifier: Field,
  spent: Bool
}) {
  hash(): Field {
    return Poseidon.hash([this.nullifier, this.spent.toField()]);
  }
}

export class PayoutClaimPublicInput extends Struct({
  marketKey: Field,
  resolvedOutcomeOver: Bool,
  totalPositionBet: UInt64,
  totalYesPositionBet: UInt64,
  claimantSideOver: Bool,
  claimantStake: UInt64,
  claimantNullifier: Field
}) {}

export function deriveDateKeyedMarketKey(baseConfigHash: Field, localDateField: Field): Field {
  return Poseidon.hash([baseConfigHash, localDateField]);
}
