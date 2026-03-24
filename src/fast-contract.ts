import 'reflect-metadata';
import {
  Bool,
  Field,
  MerkleMap,
  MerkleMapWitness,
  Permissions,
  Poseidon,
  Provable,
  PublicKey,
  SmartContract,
  State,
  Struct,
  UInt64,
  method,
  state
} from 'o1js';
import { MarketLeaf, WeatherOracleStatement } from './market-types.js';

const EMPTY_MAP_ROOT = new MerkleMap().getRoot();
const NANOMINA_PER_TMINA = UInt64.from(1_000_000_000);

export class MarketSnapshotEvent extends Struct({
  marketKey: Field,
  configHash: Field,
  closeSlot: UInt64,
  expirySlot: UInt64,
  thresholdValueTenthC: UInt64,
  totalPositionBet: UInt64,
  totalYesPositionBet: UInt64,
  resolved: Bool,
  outcome: Bool,
  oracleStatementHash: Field
}) {}

export class MarketResolvedEvent extends Struct({
  marketKey: Field,
  configHash: Field,
  closeSlot: UInt64,
  expirySlot: UInt64,
  thresholdValueTenthC: UInt64,
  totalPositionBet: UInt64,
  totalYesPositionBet: UInt64,
  outcome: Bool,
  oracleStatementHash: Field,
  resolved: Bool,
  oracleNonce: Field
}) {}

export class ReceiptCommittedEvent extends Struct({
  receiptKey: Field,
  marketKey: Field,
  ownerCommitment: Field,
  receiptCommitment: Field
}) {}

export class ReceiptClaimedEvent extends Struct({
  receiptKey: Field,
  marketKey: Field,
  ownerCommitment: Field,
  amount: UInt64
}) {}

export class FastPredictionMarketPlatform extends SmartContract {
  @state(Field) marketsRoot = State<Field>();
  @state(Field) receiptsRoot = State<Field>();
  @state(Field) claimedReceiptsRoot = State<Field>();
  @state(Field) usedOracleNonceRoot = State<Field>();
  @state(Field) oracleSourceHash = State<Field>();
  @state(Field) oracleRequestPathHash = State<Field>();
  @state(UInt64) marketCount = State<UInt64>();

  events = {
    marketCreated: MarketSnapshotEvent,
    marketUpdated: MarketSnapshotEvent,
    marketResolved: MarketResolvedEvent,
    receiptCommitted: ReceiptCommittedEvent,
    receiptClaimed: ReceiptClaimedEvent
  };

  init() {
    super.init();
    this.marketsRoot.set(EMPTY_MAP_ROOT);
    this.receiptsRoot.set(EMPTY_MAP_ROOT);
    this.claimedReceiptsRoot.set(EMPTY_MAP_ROOT);
    this.usedOracleNonceRoot.set(EMPTY_MAP_ROOT);
    this.oracleSourceHash.set(Field(0));
    this.oracleRequestPathHash.set(Field(0));
    this.marketCount.set(UInt64.from(0));

    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proofOrSignature()
    });
  }

  @method async configureOraclePolicy(sourceHash: Field, requestPathHash: Field) {
    this.requireSignature();
    this.oracleSourceHash.set(sourceHash);
    this.oracleRequestPathHash.set(requestPathHash);
  }

  @method async createMarket(marketKey: Field, market: MarketLeaf, marketWitness: MerkleMapWitness) {
    const marketsRoot = this.marketsRoot.getAndRequireEquals();
    const [rootBefore, witnessKey] = marketWitness.computeRootAndKey(Field(0));
    rootBefore.assertEquals(marketsRoot);
    witnessKey.assertEquals(marketKey);

    market.totalPositionBet.assertEquals(UInt64.from(0));
    market.totalYesPositionBet.assertEquals(UInt64.from(0));
    market.resolved.assertFalse();
    market.outcome.assertFalse();
    market.oracleStatementHash.assertEquals(Field(0));
    market.closeSlot.lessThanOrEqual(market.expirySlot).assertTrue();

    const [rootAfter] = marketWitness.computeRootAndKey(market.hash());
    this.marketsRoot.set(rootAfter);

    const count = this.marketCount.getAndRequireEquals();
    this.marketCount.set(count.add(1));

    this.emitEvent(
      'marketCreated',
      new MarketSnapshotEvent({
        marketKey,
        configHash: market.configHash,
        closeSlot: market.closeSlot,
        expirySlot: market.expirySlot,
        thresholdValueTenthC: market.thresholdValueTenthC,
        totalPositionBet: market.totalPositionBet,
        totalYesPositionBet: market.totalYesPositionBet,
        resolved: market.resolved,
        outcome: market.outcome,
        oracleStatementHash: market.oracleStatementHash
      })
    );
  }

  @method async placeReceiptBet(
    marketKey: Field,
    oldMarket: MarketLeaf,
    newMarket: MarketLeaf,
    marketWitness: MerkleMapWitness,
    receiptKey: Field,
    receiptCommitment: Field,
    receiptWitness: MerkleMapWitness,
    ownerCommitment: Field
  ) {
    const marketsRoot = this.marketsRoot.getAndRequireEquals();
    const [marketRootBefore, marketWitnessKey] = marketWitness.computeRootAndKey(oldMarket.hash());
    marketRootBefore.assertEquals(marketsRoot);
    marketWitnessKey.assertEquals(marketKey);

    const receiptsRoot = this.receiptsRoot.getAndRequireEquals();
    const [receiptRootBefore, receiptWitnessKey] = receiptWitness.computeRootAndKey(Field(0));
    receiptRootBefore.assertEquals(receiptsRoot);
    receiptWitnessKey.assertEquals(receiptKey);

    oldMarket.resolved.assertFalse();
    newMarket.resolved.assertFalse();
    newMarket.outcome.assertFalse();
    newMarket.oracleStatementHash.assertEquals(Field(0));

    oldMarket.configHash.assertEquals(newMarket.configHash);
    oldMarket.closeSlot.assertEquals(newMarket.closeSlot);
    oldMarket.expirySlot.assertEquals(newMarket.expirySlot);
    oldMarket.thresholdValueTenthC.assertEquals(newMarket.thresholdValueTenthC);

    oldMarket.totalPositionBet.lessThanOrEqual(newMarket.totalPositionBet).assertTrue();
    oldMarket.totalYesPositionBet.lessThanOrEqual(newMarket.totalYesPositionBet).assertTrue();
    newMarket.totalYesPositionBet.lessThanOrEqual(newMarket.totalPositionBet).assertTrue();

    const [marketRootAfter] = marketWitness.computeRootAndKey(newMarket.hash());
    const [receiptsRootAfter] = receiptWitness.computeRootAndKey(receiptCommitment);
    this.marketsRoot.set(marketRootAfter);
    this.receiptsRoot.set(receiptsRootAfter);

    this.emitEvent(
      'marketUpdated',
      new MarketSnapshotEvent({
        marketKey,
        configHash: newMarket.configHash,
        closeSlot: newMarket.closeSlot,
        expirySlot: newMarket.expirySlot,
        thresholdValueTenthC: newMarket.thresholdValueTenthC,
        totalPositionBet: newMarket.totalPositionBet,
        totalYesPositionBet: newMarket.totalYesPositionBet,
        resolved: newMarket.resolved,
        outcome: newMarket.outcome,
        oracleStatementHash: newMarket.oracleStatementHash
      })
    );
    this.emitEvent(
      'receiptCommitted',
      new ReceiptCommittedEvent({
        receiptKey,
        marketKey,
        ownerCommitment,
        receiptCommitment
      })
    );
  }

  @method async resolveWeatherMarket(
    marketKey: Field,
    oldMarket: MarketLeaf,
    resolvedMarket: MarketLeaf,
    marketWitness: MerkleMapWitness,
    oracle: WeatherOracleStatement,
    nonceWitness: MerkleMapWitness
  ) {
    const marketsRoot = this.marketsRoot.getAndRequireEquals();
    const [rootBefore, witnessKey] = marketWitness.computeRootAndKey(oldMarket.hash());
    rootBefore.assertEquals(marketsRoot);
    witnessKey.assertEquals(marketKey);
    oldMarket.resolved.assertFalse();
    oldMarket.oracleStatementHash.assertEquals(Field(0));

    const sourceHash = this.oracleSourceHash.getAndRequireEquals();
    const requestPathHash = this.oracleRequestPathHash.getAndRequireEquals();
    oracle.sourceHash.assertEquals(sourceHash);
    oracle.requestPathHash.assertEquals(requestPathHash);

    oldMarket.closeSlot.lessThanOrEqual(oracle.observedAtSlot).assertTrue();
    oracle.observedAtSlot.lessThanOrEqual(oldMarket.expirySlot).assertTrue();
    oracle.thresholdValueTenthC.assertEquals(oldMarket.thresholdValueTenthC);

    const computedOutcome = oracle.observedValueTenthC.greaterThan(oracle.thresholdValueTenthC);
    computedOutcome.assertEquals(oracle.outcome);

    const expectedStatementDigest = Poseidon.hash([
      marketKey,
      oracle.sourceHash,
      oracle.requestPathHash,
      oracle.observedAtSlot.value,
      oracle.observedValueTenthC.value,
      oracle.thresholdValueTenthC.value,
      oracle.outcome.toField(),
      oracle.nonce
    ]);
    oracle.statementDigest.assertEquals(expectedStatementDigest);

    const nonceRoot = this.usedOracleNonceRoot.getAndRequireEquals();
    const [nonceRootBefore, nonceKey] = nonceWitness.computeRootAndKey(Field(0));
    nonceRootBefore.assertEquals(nonceRoot);
    nonceKey.assertEquals(oracle.nonce);
    const [nonceRootAfter] = nonceWitness.computeRootAndKey(Field(1));
    this.usedOracleNonceRoot.set(nonceRootAfter);

    resolvedMarket.configHash.assertEquals(oldMarket.configHash);
    resolvedMarket.closeSlot.assertEquals(oldMarket.closeSlot);
    resolvedMarket.expirySlot.assertEquals(oldMarket.expirySlot);
    resolvedMarket.thresholdValueTenthC.assertEquals(oldMarket.thresholdValueTenthC);
    resolvedMarket.totalPositionBet.assertEquals(oldMarket.totalPositionBet);
    resolvedMarket.totalYesPositionBet.assertEquals(oldMarket.totalYesPositionBet);
    resolvedMarket.resolved.assertTrue();
    resolvedMarket.outcome.assertEquals(oracle.outcome);
    resolvedMarket.oracleStatementHash.assertEquals(oracle.statementDigest);

    const [rootAfter] = marketWitness.computeRootAndKey(resolvedMarket.hash());
    this.marketsRoot.set(rootAfter);

    this.emitEvent(
      'marketResolved',
      new MarketResolvedEvent({
        marketKey,
        configHash: resolvedMarket.configHash,
        closeSlot: resolvedMarket.closeSlot,
        expirySlot: resolvedMarket.expirySlot,
        thresholdValueTenthC: resolvedMarket.thresholdValueTenthC,
        totalPositionBet: resolvedMarket.totalPositionBet,
        totalYesPositionBet: resolvedMarket.totalYesPositionBet,
        outcome: resolvedMarket.outcome,
        oracleStatementHash: resolvedMarket.oracleStatementHash,
        resolved: resolvedMarket.resolved,
        oracleNonce: oracle.nonce
      })
    );
  }

  @method async claimReceiptPayout(
    marketKey: Field,
    resolvedMarket: MarketLeaf,
    marketWitness: MerkleMapWitness,
    receiptKey: Field,
    receiptCommitment: Field,
    receiptWitness: MerkleMapWitness,
    claimedReceiptWitness: MerkleMapWitness,
    claimant: PublicKey,
    addTotalBet: UInt64,
    addYesBet: UInt64,
    ownerCommitment: Field,
    saltHash: Field
  ) {
    const marketsRoot = this.marketsRoot.getAndRequireEquals();
    const [marketRootBefore, marketWitnessKey] = marketWitness.computeRootAndKey(resolvedMarket.hash());
    marketRootBefore.assertEquals(marketsRoot);
    marketWitnessKey.assertEquals(marketKey);
    resolvedMarket.resolved.assertTrue();

    const receiptsRoot = this.receiptsRoot.getAndRequireEquals();
    const [receiptRootBefore, receiptWitnessKey] = receiptWitness.computeRootAndKey(receiptCommitment);
    receiptRootBefore.assertEquals(receiptsRoot);
    receiptWitnessKey.assertEquals(receiptKey);

    const claimedReceiptsRoot = this.claimedReceiptsRoot.getAndRequireEquals();
    const [claimedBefore, claimedWitnessKey] = claimedReceiptWitness.computeRootAndKey(Field(0));
    claimedBefore.assertEquals(claimedReceiptsRoot);
    claimedWitnessKey.assertEquals(receiptKey);

    ownerCommitment.assertEquals(Poseidon.hash(claimant.toFields()));
    addYesBet.lessThanOrEqual(addTotalBet).assertTrue();
    const sideOver = addYesBet.equals(addTotalBet);
    const sideUnder = addYesBet.equals(UInt64.from(0));
    sideOver.or(sideUnder).assertTrue();

    const expectedReceiptCommitment = Poseidon.hash([
      marketKey,
      addTotalBet.value,
      addYesBet.value,
      ownerCommitment,
      saltHash
    ]);
    expectedReceiptCommitment.assertEquals(receiptCommitment);

    sideOver.assertEquals(resolvedMarket.outcome);

    resolvedMarket.totalPositionBet.greaterThan(UInt64.from(0)).assertTrue();
    const winningPool = Provable.if(
      sideOver,
      UInt64,
      resolvedMarket.totalYesPositionBet,
      resolvedMarket.totalPositionBet.sub(resolvedMarket.totalYesPositionBet)
    );
    winningPool.greaterThan(UInt64.from(0)).assertTrue();

    // Market leaves track stake/pot in whole tMINA units; sends must use nanomina.
    const payoutTmina = resolvedMarket.totalPositionBet.mul(addTotalBet).div(winningPool);
    payoutTmina.greaterThan(UInt64.from(0)).assertTrue();
    const payoutNanomina = payoutTmina.mul(NANOMINA_PER_TMINA);

    const [claimedAfter] = claimedReceiptWitness.computeRootAndKey(Field(1));
    this.claimedReceiptsRoot.set(claimedAfter);
    this.send({ to: claimant, amount: payoutNanomina });

    this.emitEvent(
      'receiptClaimed',
      new ReceiptClaimedEvent({
        receiptKey,
        marketKey,
        ownerCommitment,
        amount: payoutNanomina
      })
    );
  }
}
