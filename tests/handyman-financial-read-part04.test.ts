import { buildingAssignmentService } from '../src/modules/building-assignments';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { userService } from '../src/modules/users';
import { baseFixture, crewFixture, initHandymanFixtures, locationChain, scopeFixture }
  from './helpers/handyman-fixtures';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion }
  from '../src/modules/handyman-commercial-agreements';
import { openHandymanCustomerTransaction, composeHandymanChargeLine }
  from '../src/modules/handyman-customer-transactions';
import {
  recordHandymanCustomerPayment, confirmHandymanCustomerPayment,
} from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment }
  from '../src/modules/handyman-customer-payment-allocations';
import {
  adjustHandymanCustomerLedger, refundHandymanCustomerPayment,
} from '../src/modules/handyman-customer-ledger-corrections';
import { deriveHandymanFinancialEntitlements }
  from '../src/modules/handyman-financial-entitlements';
import {
  prepareHandymanSettlement, includeHandymanSettlement,
  reconcileHandymanSettlement, settleHandymanSettlement,
  recordHandymanSettlementCorrection,
} from '../src/modules/handyman-settlement';
import {
  readHandymanFinancialTransactionAt, readHandymanFinancialClientAt,
  HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION,
  HANDYMAN_FINANCIAL_READ_STATUSES,
} from '../src/modules/handyman-financial-read';

/** Only the PART 04 test. Real, serial, fresh embedded PostgreSQL. */
const DIR='/tmp/hm14-part04-pg',PORT=55494;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',
  DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pg:EmbeddedPostgres;
let pool:Pool;
let actor:string;
// PART 04 maker-checker: confirm/reject by a DIFFERENT identity.
let verifier:string;
const id=()=>randomUUID();
const q=(sql:string,params:unknown[]=[])=>pool.query(sql,params);

before(async()=>{
  await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});
  pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',
    password:'',persistent:true,authMethod:'trust'});
  await pg.initialise();await pg.start();
  const admin=pg.getPgClient('postgres','127.0.0.1');
  await admin.connect();await admin.query('CREATE DATABASE asentra_test');
  await admin.end();
  const {ensureTestDatabase}=await import('./helpers/postgres');
  const config=await ensureTestDatabase();assert.ok(config);
  pool=await initDatabase(config);await migrateUp(pool);
  actor=(await createAdminUser()).userId;
  verifier=(await createAdminUser()).userId;
  const discipline=await handymanDisciplineRepository.findDisciplineByCode(
    undefined,'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({adminUserId:actor,disciplineId:discipline.id,query:q});
});
after(async()=>{
  try{if(pool)await closePool(pool);if(pg)await pg.stop();}
  finally{await rm(DIR,{recursive:true,force:true});}
});

async function fixture(){
  const {realm,scope}=await baseFixture();
  // PART 04: the separate verifier holds the scope Building (exact-Building wall).
  await buildingAssignmentService.createAssignment(verifier,{buildingId:realm.building.id});
  const crew=await crewFixture(realm);
  const assignment=await assignHandymanExecutionScopeCrew({
    executionScopeId:scope.id,providerContextId:crew.providerContext.id,
    crewId:crew.crew.id,
  },actor);
  const draft=await prepareHandymanCommercialAgreement(actor,{
    clientId:realm.client.id,idempotencyKey:id()});
  const version=draft.version.id;
  await q(`INSERT INTO handyman_bm_fee_rule_definitions
    (id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
    VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),version,id(),actor]);
  await q(`INSERT INTO handyman_bm_fee_term_definitions
    (id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
    VALUES($1,$2,'PERCENTAGE_OF_BASIS','2.5000',$3,$4)`,
  [id(),version,id(),actor]);
  await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions
    (id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,
     idempotency_key,created_by_user_id)
    VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
  [id(),version,realm.client.id,id(),actor]);
  await activateHandymanCommercialAgreementVersion(actor,{
    versionId:version,effectiveFrom:new Date(Date.now()-60_000).toISOString(),
    idempotencyKey:id()});
  const opened=await openHandymanCustomerTransaction({
    executionScopeId:scope.id,idempotencyKey:id()},actor);
  const line=(await q(`SELECT id FROM handyman_quotation_lines
    WHERE quotation_version_id=$1 AND line_type='LABOR'`,
  [scope.approvedQuotationVersionId])).rows[0];
  const charge=await composeHandymanChargeLine({executionScopeId:scope.id,
    quotationLineId:line.id,idempotencyKey:id()},actor);
  await deriveHandymanFinancialEntitlements(scope.id,actor,id());
  return {realm,scope,crew,assignment,opened,charge};
}
async function fund(scopeId:string,chargeId:string,amount:string){
  const payment=await recordHandymanCustomerPayment({
    executionScopeId:scopeId,amount,channel:'BANK_TRANSFER',
    providerName:'Bank',providerReference:id(),externalReference:id(),
    idempotencyKey:id(),
  },actor);
  await confirmHandymanCustomerPayment({executionScopeId:scopeId,
    paymentId:payment.payment.id,idempotencyKey:id()},verifier);
  await allocateHandymanCustomerPayment({executionScopeId:scopeId,
    paymentId:payment.payment.id,chargeLineId:chargeId,
    amount,idempotencyKey:id()},actor);
  return payment.payment.id;
}
const read=(scope:string)=>readHandymanFinancialTransactionAt(scope,actor);
const code=(expected:string,status:number)=>(err:{code?:string;statusCode?:number})=>{
  assert.equal(err.code,expected);assert.equal(err.statusCode,status);return true;
};
const TABLES=[
  'handyman_customer_transactions','handyman_charge_lines',
  'handyman_customer_payments','handyman_payment_allocations',
  'handyman_ledger_corrections','handyman_entitlement_facts',
  'handyman_entitlement_corrections','handyman_settlement_units',
  'handyman_settlement_events','handyman_settlement_inclusions',
  'handyman_settlement_reconciliations','handyman_settlement_exceptions',
  'handyman_settlement_command_keys',
];
async function fingerprint(){
  const result:Record<string,string>={};
  for(const table of TABLES){
    const r=await q(`SELECT count(*)::int AS n,
       md5(COALESCE(string_agg(to_jsonb(t)::text,'|'
         ORDER BY to_jsonb(t)::text),'')) AS hash
       FROM ${table} t`);
    result[table]=`${r.rows[0].n}:${r.rows[0].hash}`;
  }
  return result;
}

/** Tests are serial in this suite. Reused solely for the client window. */
let established:Awaited<ReturnType<typeof fixture>>;

describe('CR-HM-14 PART 04 financial read contract / firewall',()=>{
  it('publishes exact anchors, immutable corrections, recorded terminal history and variance',async()=>{
    const f=await fixture();established=f;
    const earned=await read(f.scope.id);
    assert.equal(earned.contractVersion,HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION);
    assert.equal(earned.ledgerContractVersion,'CR-HM-13-PART-06');
    assert.equal(earned.readOnly,true);
    assert.equal(earned.status,'EARNED');
    assert.equal(earned.settlement,null);
    assert.equal(earned.entitlements.length,2);
    const provider=earned.entitlements.find(x=>x.entitlementKind==='PROVIDER')!;
    const bm=earned.entitlements.find(x=>x.entitlementKind==='BM_FEE')!;
    assert.equal(provider.provider?.assignmentId,f.assignment.id);
    assert.equal(provider.provider?.leadWorkerId,f.crew.workerContext.id);
    assert.equal(provider.amount,'97.50');
    assert.equal(bm.bmFee?.agreementVersionId!==null,true);
    assert.equal(bm.bmFee?.ratePercent,'2.5000');
    assert.equal(bm.bmFee?.beneficiaryReferenceId,f.realm.client.id);
    assert.equal(bm.basisKind,'LABOR_ONLY');
    assert.equal(bm.amount,'2.50');
    assert.equal('idempotencyKey' in bm,false);

    const adjustment=await adjustHandymanCustomerLedger({
      executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Labor correction',idempotencyKey:id(),
    },actor);
    await deriveHandymanFinancialEntitlements(f.scope.id,actor,id());
    const corrected=await read(f.scope.id);
    assert.equal(corrected.netBasis.chargedNet,'80.00');
    assert.equal(corrected.netBasis.laborNet,'80.00');
    assert.equal(corrected.entitlements.find(x=>x.entitlementKind==='PROVIDER')?.amount,
      '97.50','original earning must never be rewritten');
    assert.equal(corrected.entitlements.find(x=>x.entitlementKind==='PROVIDER')
      ?.corrections[0]?.amount,'19.50');
    assert.ok(corrected.entitlements.every(x=>x.corrections[0]?.ledgerCorrectionId===
      adjustment.correction.id));
    const paymentId=await fund(f.scope.id,f.charge.chargeLine.id,'80.00');
    const prep=await prepareHandymanSettlement(f.scope.id,actor,id());
    await includeHandymanSettlement(f.scope.id,actor,id());
    const matched=await reconcileHandymanSettlement(f.scope.id,actor,id());
    assert.equal(matched.outcome,'MATCHED');
    await settleHandymanSettlement(f.scope.id,actor,id());
    const settled=await read(f.scope.id);
    assert.equal(settled.status,'SETTLED');
    assert.equal(settled.settlement?.unitId,prep.unitId);
    assert.equal(settled.settlement?.recordedState,'SETTLED');
    assert.deepEqual(settled.settlement?.events.map(x=>x.state),
      ['PAYABLE','INCLUDED_IN_SETTLEMENT','SETTLED']);
    assert.deepEqual(settled.settlement?.inclusions.map(x=>x.amount).sort(),
      ['2.00','78.00']);
    assert.equal(settled.settlement?.latestReconciliation?.outcome,'MATCHED');
    assert.equal(settled.settlement?.latestReconciliation?.ledgerChargedNet,'80.00');
    assert.equal(settled.netBasis.applied,'80.00');
    assert.equal(settled.netBasis.netReceived,'80.00');

    const refund=await refundHandymanCustomerPayment({
      executionScopeId:f.scope.id,paymentId,amount:'10.00',
      reason:'Post-close correction',idempotencyKey:id(),
    },actor);
    await recordHandymanSettlementCorrection(f.scope.id,actor,
      refund.correction.id,id());
    await reconcileHandymanSettlement(f.scope.id,actor,id());
    const after=await read(f.scope.id);
    assert.equal(after.status,'EXCEPTION_RECORDED');
    assert.equal(after.settlement?.recordedState,'SETTLED',
      'late exception must never reopen the terminal state');
    assert.equal(after.netBasis.netReceived,'70.00');
    assert.equal(after.settlement?.latestReconciliation?.outcome,'VARIANCE');
    assert.equal(after.settlement?.latestReconciliation?.varianceCause,'OPEN_EXCEPTION');
    assert.deepEqual(after.settlement?.reconciliations.map(x=>x.outcome),
      ['MATCHED','VARIANCE']);
    assert.equal(after.settlement?.exceptions[0]?.ledgerCorrectionId,
      refund.correction.id);
    assert.equal(after.settlement?.exceptions[0]?.amount,'10.00');
  });

  it('excludes non-authoritative ledgers from client windows and retains bounded denial',async()=>{
    const f=established;
    const pendingScope=(await scopeFixture(f.realm,await locationChain(f.realm))).scope;
    await openHandymanCustomerTransaction({
      executionScopeId:pendingScope.id,idempotencyKey:id()},actor);
    const line=(await q(`SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id=$1 AND line_type='LABOR'`,
    [pendingScope.approvedQuotationVersionId])).rows[0];
    await composeHandymanChargeLine({executionScopeId:pendingScope.id,
      quotationLineId:line.id,idempotencyKey:id()},actor);
    await recordHandymanCustomerPayment({
      executionScopeId:pendingScope.id,amount:'10.00',channel:'BANK_TRANSFER',
      providerName:'Bank',providerReference:id(),externalReference:id(),
      idempotencyKey:id(),
    },actor);
    const pending=await read(pendingScope.id);
    assert.equal(pending.status,'LEDGER_NOT_AUTHORITATIVE');
    assert.deepEqual(pending.authority.deniedBy,['PROVISIONAL_PAYMENTS_PENDING']);
    assert.deepEqual(pending.entitlements,[]);
    const emptyScope=(await scopeFixture(f.realm,await locationChain(f.realm))).scope;
    await openHandymanCustomerTransaction({executionScopeId:emptyScope.id,
      idempotencyKey:id()},actor);
    const empty=await read(emptyScope.id);
    assert.equal(empty.status,'LEDGER_NOT_AUTHORITATIVE');
    assert.deepEqual(empty.authority.deniedBy,['NO_POSTED_CHARGE_FACTS']);
    const foreign=await fixture();
    const from=new Date(Date.now()-300_000).toISOString();
    const to=new Date(Date.now()+300_000).toISOString();
    const client=await readHandymanFinancialClientAt(f.realm.client.id,actor,
      {from,to,limit:500});
    assert.equal(client.readOnly,true);
    assert.equal(client.authority.authoritativeForEntitlement,false);
    assert.deepEqual(client.excludedTransactionIds.sort(),
      [pending.transaction.transactionId,empty.transaction.transactionId].sort());
    assert.deepEqual(client.transactions.map(x=>x.transaction.transactionId),
      [f.opened.transaction.id]);
    assert.equal(client.transactions[0].netBasis.netReceived,'70.00');
    assert.ok(!client.transactions.some(x=>
      x.transaction.clientId===foreign.realm.client.id));
    const outsider=await userService.createUser({
      email:`finance-out-${id().slice(0,8)}@example.com`,displayName:'Outsider',
    });
    await assert.rejects(readHandymanFinancialClientAt(f.realm.client.id,
      outsider.id),code('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED',403));
    await assert.rejects(readHandymanFinancialTransactionAt(f.scope.id,
      outsider.id),code('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED',403));
    await assert.rejects(readHandymanFinancialClientAt(f.realm.client.id,actor,
      {limit:501}),code('HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION',400));
    await assert.rejects(readHandymanFinancialClientAt(f.realm.client.id,actor,
      {from:'not-a-date'}),code('HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION',400));
    await assert.rejects(readHandymanFinancialClientAt(id(),actor),
      code('HANDYMAN_CUSTOMER_TRANSACTION_NOT_FOUND',404));
  });

  it('has only SELECT reads, no cross-plane imports or HTTP, and changes no financial table',async()=>{
    const module='src/modules/handyman-financial-read';
    assert.deepEqual(readdirSync(module).sort(),[
      'handyman-financial-read.repository.ts',
      'handyman-financial-read.service.ts',
      'handyman-financial-read.types.ts','index.ts',
    ]);
    const barrel=readFileSync(`${module}/index.ts`,'utf8');
    assert.deepEqual(barrel.match(/readHandymanFinancial\w+At/g),[
      'readHandymanFinancialTransactionAt','readHandymanFinancialClientAt']);
    assert.doesNotMatch(barrel,/repository|deriveHandymanFinancial|prepareHandymanSettlement/);
    const source=readdirSync(module).filter(f=>f.endsWith('.ts'))
      .map(f=>readFileSync(`${module}/${f}`,'utf8')).join('\n');
    const active=source.replace(/\/\*[\s\S]*?\*\//g,'')
      .split('\n').filter(s=>!s.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(active,/\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE TABLE|DROP TABLE|ALTER TABLE|FOR UPDATE)\b/i);
    assert.doesNotMatch(active,/\b(?:withTransaction|PoolClient|express|router|controller|openapi|supertest)\b/i);
    assert.doesNotMatch(active,/\b(?:saas_|platform_|module_entitlements|feature_entitlement_configurations|subscriptions|fm_financial|payment_gateway|bank_account|disburse)\b/i);
    const repository=readFileSync(`${module}/handyman-financial-read.repository.ts`,'utf8');
    assert.equal((repository.match(/getPool\(\)\.query/g)??[]).length,1);
    assert.equal((repository.match(/\bSELECT\b/g)??[]).length>0,true);
    assert.doesNotMatch(repository,/FROM handyman_customer_|JOIN handyman_customer_|FROM handyman_ledger_/);
    const ledgerRepository=readFileSync(
      'src/modules/handyman-customer-ledger-read/handyman-ledger-read.repository.ts',
      'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
    assert.doesNotMatch(ledgerRepository,
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|FOR UPDATE)\b/i);
    assert.match(source,/readHandymanLedgerTransactionAt/);
    assert.match(source,/readHandymanLedgerClientBasisAt/);
    const fks=await q(`SELECT con.conname, ref.relname AS referent
      FROM pg_constraint con
      JOIN pg_class owner ON owner.oid=con.conrelid
      JOIN pg_class ref ON ref.oid=con.confrelid
      WHERE con.contype='f' AND owner.relname=ANY($1::text[])`,[[
      'handyman_entitlement_facts','handyman_entitlement_corrections',
      'handyman_settlement_units','handyman_settlement_events',
      'handyman_settlement_inclusions','handyman_settlement_reconciliations',
      'handyman_settlement_exceptions','handyman_settlement_command_keys',
    ]]);
    assert.ok(fks.rows.length>0);
    assert.ok(fks.rows.every(r=>!/(?:^saas_|^platform_|^module_entitlements$|^subscriptions$|^feature_entitlement_configurations$|^fm_)/.test(r.referent)));
    assert.ok(HANDYMAN_FINANCIAL_READ_STATUSES.includes('RECONCILIATION_VARIANCE'));
    const before=await fingerprint();
    const first=await read(established.scope.id);
    const again=await read(established.scope.id);
    assert.deepEqual(again,first);
    const many=await readHandymanFinancialClientAt(established.realm.client.id,actor);
    assert.equal(many.transactions.length,1);
    assert.deepEqual(await fingerprint(),before,
      'all posted financial, entitlement, ledger and reconciliation facts remain byte-identical');
  });
});
