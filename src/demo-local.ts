import 'reflect-metadata';
import './env.js';
import { AccountUpdate, Bool, Field, MerkleMap, Mina, Poseidon, PrivateKey, UInt64 } from 'o1js';
import { MarketLeaf, PredictionMarketPlatform, WeatherOracleStatement } from './contract.js';

const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
Mina.setActiveInstance(Local);

const deployer = Local.testAccounts[0].key as PrivateKey;
const creator = Local.testAccounts[1].key as PrivateKey;
const zkappKey = PrivateKey.random();
const zkappAddress = zkappKey.toPublicKey();

const marketsMap = new MerkleMap();
const nonceMap = new MerkleMap();

const sourceHash = Poseidon.hash([Field(101)]);
const requestPathHash = Poseidon.hash([Field(2026), Field(7001)]);

console.log('Compiling PredictionMarketPlatform...');
await PredictionMarketPlatform.compile();

console.log('Deploying local contract...');
const deployTx = await Mina.transaction(deployer.toPublicKey(), async () => {
  AccountUpdate.fundNewAccount(deployer.toPublicKey());
  const zkapp = new PredictionMarketPlatform(zkappAddress);
  zkapp.deploy();
  zkapp.configureOraclePolicy(sourceHash, requestPathHash);
});
await deployTx.prove();
await deployTx.sign([deployer, zkappKey]).send();

const zkapp = new PredictionMarketPlatform(zkappAddress);
const marketKey = Poseidon.hash(creator.toPublicKey().toFields().concat([Field(1)]));

const initialLeaf = new MarketLeaf({
  configHash: Poseidon.hash([Field(999), Field(1)]),
  closeSlot: UInt64.from(100),
  expirySlot: UInt64.from(120),
  thresholdValueTenthC: UInt64.from(300),
  totalPositionBet: UInt64.from(0),
  totalYesPositionBet: UInt64.from(0),
  resolved: Bool(false),
  outcome: Bool(false),
  oracleStatementHash: Field(0)
});

const createTx = await Mina.transaction(creator.toPublicKey(), async () => {
  zkapp.createMarket(marketKey, initialLeaf, marketsMap.getWitness(marketKey));
});
await createTx.prove();
await createTx.sign([creator]).send();
marketsMap.set(marketKey, initialLeaf.hash());

const marketAfterBet = new MarketLeaf({
  configHash: initialLeaf.configHash,
  closeSlot: initialLeaf.closeSlot,
  expirySlot: initialLeaf.expirySlot,
  thresholdValueTenthC: initialLeaf.thresholdValueTenthC,
  totalPositionBet: UInt64.from(3000),
  totalYesPositionBet: UInt64.from(1800),
  resolved: Bool(false),
  outcome: Bool(false),
  oracleStatementHash: Field(0)
});

const betTx = await Mina.transaction(creator.toPublicKey(), async () => {
  zkapp.placePrivateBet(
    marketKey,
    initialLeaf,
    marketAfterBet,
    marketsMap.getWitness(marketKey),
    Poseidon.hash([Field(333), Field(777)]),
    Poseidon.hash([Field(12), Field(34)])
  );
});
await betTx.prove();
await betTx.sign([creator]).send();
marketsMap.set(marketKey, marketAfterBet.hash());

const oracleNonce = Poseidon.hash([Field(42), marketKey]);
const oracleOutcome = Bool(true);
const statementDigest = Poseidon.hash([
  marketKey,
  sourceHash,
  requestPathHash,
  Field(110),
  Field(314),
  Field(300),
  oracleOutcome.toField(),
  oracleNonce
]);

const oracle = new WeatherOracleStatement({
  sourceHash,
  requestPathHash,
  observedAtSlot: UInt64.from(110),
  observedValueTenthC: UInt64.from(314),
  thresholdValueTenthC: UInt64.from(300),
  outcome: oracleOutcome,
  nonce: oracleNonce,
  statementDigest
});

const resolvedLeaf = new MarketLeaf({
  configHash: marketAfterBet.configHash,
  closeSlot: marketAfterBet.closeSlot,
  expirySlot: marketAfterBet.expirySlot,
  thresholdValueTenthC: marketAfterBet.thresholdValueTenthC,
  totalPositionBet: marketAfterBet.totalPositionBet,
  totalYesPositionBet: marketAfterBet.totalYesPositionBet,
  resolved: Bool(true),
  outcome: oracleOutcome,
  oracleStatementHash: statementDigest
});

const resolveTx = await Mina.transaction(creator.toPublicKey(), async () => {
  zkapp.resolveWeatherMarket(
    marketKey,
    marketAfterBet,
    resolvedLeaf,
    marketsMap.getWitness(marketKey),
    oracle,
    nonceMap.getWitness(oracleNonce)
  );
});
await resolveTx.prove();
await resolveTx.sign([creator]).send();
marketsMap.set(marketKey, resolvedLeaf.hash());
nonceMap.set(oracleNonce, Field(1));

const marketCount = zkapp.marketCount.get();
const marketsRoot = zkapp.marketsRoot.get();
console.log('Local demo complete.');
console.log('Contract:', zkappAddress.toBase58());
console.log('Market count:', marketCount.toString());
console.log('Markets root:', marketsRoot.toString());
