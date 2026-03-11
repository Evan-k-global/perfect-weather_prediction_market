import 'reflect-metadata';
import './env.js';
import { AccountUpdate, Bool, Field, MerkleMap, Mina, Poseidon, PrivateKey, UInt64 } from 'o1js';
import { MarketLeaf, PredictionMarketPlatform } from './contract.js';
import {
  TlsnWeatherAttestation,
  buildWeatherOracleStatementFromAttestation,
  hashUtf8StringPoseidon
} from './oracle-adapter.js';

const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
Mina.setActiveInstance(Local);

const deployer = Local.testAccounts[0].key as PrivateKey;
const creator = Local.testAccounts[1].key as PrivateKey;
const resolver = Local.testAccounts[2].key as PrivateKey;
const zkappKey = PrivateKey.random();
const zkappAddress = zkappKey.toPublicKey();

const marketsMap = new MerkleMap();
const nonceMap = new MerkleMap();

const allowedServerName = 'api.weather.example';
const allowedRequestPath = '/v1/current?lat=40.7829&lon=-73.9654&units=metric';
const sourceHash = hashUtf8StringPoseidon(allowedServerName);
const requestPathHash = hashUtf8StringPoseidon(allowedRequestPath);

console.log('Compiling PredictionMarketPlatform...');
await PredictionMarketPlatform.compile();

const deployTx = await Mina.transaction(deployer.toPublicKey(), async () => {
  AccountUpdate.fundNewAccount(deployer.toPublicKey());
  const zkapp = new PredictionMarketPlatform(zkappAddress);
  zkapp.deploy();
  zkapp.configureOraclePolicy(sourceHash, requestPathHash);
});
await deployTx.prove();
await deployTx.sign([deployer, zkappKey]).send();

const zkapp = new PredictionMarketPlatform(zkappAddress);
const marketKey = Poseidon.hash([Field(1), ...creator.toPublicKey().toFields()]);
const thresholdTenthC = UInt64.from(300);

const initialLeaf = new MarketLeaf({
  configHash: Poseidon.hash([Field(20260701), thresholdTenthC.value, Field(18)]),
  closeSlot: UInt64.from(100),
  expirySlot: UInt64.from(120),
  thresholdValueTenthC: thresholdTenthC,
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
  totalPositionBet: UInt64.from(9000),
  totalYesPositionBet: UInt64.from(6200),
  resolved: Bool(false),
  outcome: Bool(false),
  oracleStatementHash: Field(0)
});

const tradeTx = await Mina.transaction(creator.toPublicKey(), async () => {
  zkapp.placePrivateBet(
    marketKey,
    initialLeaf,
    marketAfterBet,
    marketsMap.getWitness(marketKey),
    Poseidon.hash([Field(55), Field(89)]),
    Poseidon.hash([Field(3), Field(8)])
  );
});
await tradeTx.prove();
await tradeTx.sign([creator]).send();
marketsMap.set(marketKey, marketAfterBet.hash());

const attestation: TlsnWeatherAttestation = {
  server_name: allowedServerName,
  request_path: allowedRequestPath,
  timestamp: Date.now(),
  response_body: JSON.stringify({
    current: {
      temp_c: 31.4
    },
    location: {
      code: 'NYC-CENTRAL-PARK'
    }
  }),
  session_header_bytes_hex: 'deadbeef',
  signature: {
    r_hex: '01',
    s_hex: '02'
  },
  notary_public_key: {
    x_hex: '03',
    y_hex: '04'
  }
};

const oracleNonce = Poseidon.hash([Field(777), marketKey]);
const { statement } = buildWeatherOracleStatementFromAttestation(
  marketKey,
  attestation,
  {
    allowedServerName,
    allowedRequestPath,
    maxAgeMs: 5 * 60 * 1000
  },
  {
    jsonPath: ['current', 'temp_c'],
    thresholdTenthC: BigInt(thresholdTenthC.toString()),
    observedAtSlot: BigInt(110),
    nonce: oracleNonce
  },
  Date.now()
);

const resolvedLeaf = new MarketLeaf({
  configHash: marketAfterBet.configHash,
  closeSlot: marketAfterBet.closeSlot,
  expirySlot: marketAfterBet.expirySlot,
  thresholdValueTenthC: marketAfterBet.thresholdValueTenthC,
  totalPositionBet: marketAfterBet.totalPositionBet,
  totalYesPositionBet: marketAfterBet.totalYesPositionBet,
  resolved: Bool(true),
  outcome: statement.outcome,
  oracleStatementHash: statement.statementDigest
});

const resolveTx = await Mina.transaction(resolver.toPublicKey(), async () => {
  zkapp.resolveWeatherMarket(
    marketKey,
    marketAfterBet,
    resolvedLeaf,
    marketsMap.getWitness(marketKey),
    statement,
    nonceMap.getWitness(oracleNonce)
  );
});
await resolveTx.prove();
await resolveTx.sign([resolver]).send();
marketsMap.set(marketKey, resolvedLeaf.hash());
nonceMap.set(oracleNonce, Field(1));

console.log('Oracle adapter demo complete.');
console.log('Contract:', zkappAddress.toBase58());
console.log('Resolved outcome (yes=1):', statement.outcome.toField().toString());
console.log('Total position bet:', resolvedLeaf.totalPositionBet.toString());
console.log('Total yes position bet:', resolvedLeaf.totalYesPositionBet.toString());
