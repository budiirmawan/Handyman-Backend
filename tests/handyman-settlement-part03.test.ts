import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { baseFixture, crewFixture, initHandymanFixtures }
  from './helpers/handyman-fixtures';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion }
  from '../src/modules/handyman-commercial-agreements';
import { openHandymanCustomerTransaction, composeHandymanChargeLine }
  from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment }
  from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment }
  from '../src/modules/handyman-customer-payment-allocations';
import { refundHandymanCustomerPayment }
  from '../src/modules/handyman-customer-ledger-corrections';
import { deriveHandymanFinancialEntitlements }
  from '../src/modules/handyman-financial-entitlements';
import {
  prepareHandymanSettlement, includeHandymanSettlement,
  reconcileHandymanSettlement, settleHandymanSettlement,
  recordHandymanSettlementCorrection, holdHandymanSettlementDispute,
} from '../src/modules/handyman-settlement';

const DIR = '/tmp/hm14-part03-pg', PORT = 55493;
Object.assign(process.env, { NODE_ENV:'test', LOG_LEVEL:'error',
  DB_HOST:'127.0.0.1', DB_PORT:String(PORT), DB_USER:'postgres',
  DB_PASSWORD:'postgres', DB_NAME:'asentra_test', DB_SSL:'false' });
let pg: EmbeddedPostgres;
let pool: Pool;
let actor: string;
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql,params);
before(async () => {
  await rm(DIR,{recursive:true,force:true}); await mkdir(DIR,{recursive:true});
  pg = new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',
    password:'',persistent:true,authMethod:'trust'});
  await pg.initialise(); await pg.start();
  const admin = pg.getPgClient('postgres','127.0.0.1');
  await admin.connect(); await admin.query('CREATE DATABASE asentra_test');
  await admin.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase(); assert.ok(config);
  pool = await initDatabase(config); await migrateUp(pool);
  actor = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({adminUserId:actor,disciplineId:discipline.id,query:q});
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); }
  finally { await rm(DIR,{recursive:true,force:true}); }
});

async function fixture() {
  const { realm, scope } = await baseFixture();
  const crew = await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({executionScopeId:scope.id,
    providerContextId:crew.providerContext.id,crewId:crew.crew.id},actor);
  const draft = await prepareHandymanCommercialAgreement(actor,{
    clientId:realm.client.id,idempotencyKey:id()});
  const version = draft.version.id;
  await q(`INSERT INTO handyman_bm_fee_rule_definitions
    (id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
    VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),version,id(),actor]);
  await q(`INSERT INTO handyman_bm_fee_term_definitions
    (id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
    VALUES($1,$2,'PERCENTAGE_OF_BASIS','2.5000',$3,$4)`,[id(),version,id(),actor]);
  await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions
    (id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,
      idempotency_key,created_by_user_id)
    VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
  [id(),version,realm.client.id,id(),actor]);
  await activateHandymanCommercialAgreementVersion(actor,{
    versionId:version,effectiveFrom:new Date(Date.now()-60_000).toISOString(),
    idempotencyKey:id()});
  await openHandymanCustomerTransaction({executionScopeId:scope.id,
    idempotencyKey:id()},actor);
  const line = (await q(`SELECT id FROM handyman_quotation_lines
    WHERE quotation_version_id=$1 AND line_type='LABOR'`,
  [scope.approvedQuotationVersionId])).rows[0];
  const charge = await composeHandymanChargeLine({executionScopeId:scope.id,
    quotationLineId:line.id,idempotencyKey:id()},actor);
  const derived = await deriveHandymanFinancialEntitlements(scope.id,actor,id());
  assert.equal(derived.provider.amount,'97.50');
  assert.equal(derived.bmFee.amount,'2.50');
  return { realm,scope,charge,derived };
}
async function fund(scopeId: string, amount: string) {
  const payment = await recordHandymanCustomerPayment({
    executionScopeId:scopeId,amount,channel:'BANK_TRANSFER',
    providerName:'Bank',providerReference:id(),externalReference:id(),
    idempotencyKey:id(),
  },actor);
  await confirmHandymanCustomerPayment({executionScopeId:scopeId,
    paymentId:payment.payment.id,idempotencyKey:id()},actor);
  await allocateHandymanCustomerPayment({executionScopeId:scopeId,
    paymentId:payment.payment.id,
    chargeLineId:(await q(`SELECT id FROM handyman_charge_lines
      WHERE transaction_id=$1`,[payment.payment.transactionId])).rows[0].id,
    amount,idempotencyKey:id()},actor);
  return payment.payment.id;
}
const prepare = (scope: string,key=id()) => prepareHandymanSettlement(scope,actor,key);
const include = (scope: string,key=id()) => includeHandymanSettlement(scope,actor,key);
const reconcile = (scope: string,key=id()) => reconcileHandymanSettlement(scope,actor,key);
const settle = (scope: string,key=id()) => settleHandymanSettlement(scope,actor,key);
const code = (expected: string) => (e: {code?: string;statusCode?:number}) => {
  assert.equal(e.code,expected);assert.equal(e.statusCode,409);return true;
};
const count = async (table: string,unit: string) =>
  (await q(`SELECT count(*)::int AS n FROM ${table} WHERE unit_id=$1`,[unit])).rows[0].n;
async function sourceFingerprint() {
  const result: string[]=[];
  for (const table of [
    'handyman_customer_transactions','handyman_charge_lines',
    'handyman_customer_payments','handyman_payment_allocations',
    'handyman_ledger_corrections','handyman_entitlement_facts',
    'handyman_entitlement_corrections',
  ]) {
    const rows=await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,
      '|' ORDER BY t.id),'')) AS hash FROM ${table} t`);
    result.push(rows.rows[0].hash);
  }
  return result;
}

describe('CR-HM-14 PART 03 settlement and internal reconciliation', () => {
  it('funded full claim: PAYABLE → INCLUDED → exact reconciliation → terminal SETTLED, replay-safe',async () => {
    const f = await fixture();
    await assert.rejects(prepare(f.scope.id),code('HANDYMAN_SETTLEMENT_NOT_FUNDED'));
    await fund(f.scope.id,'100.00');
    const sourcesBefore=await sourceFingerprint();
    const prepKey=id(),incKey=id(),recKey=id(),setKey=id();
    const p=await prepare(f.scope.id,prepKey);
    assert.equal(p.state,'PAYABLE');
    assert.equal((await prepare(f.scope.id,prepKey)).unitId,p.unitId);
    await assert.rejects(include(f.scope.id,prepKey),
      code('HANDYMAN_SETTLEMENT_CONFLICT'));
    await assert.rejects(q(`INSERT INTO handyman_settlement_events
      (id,unit_id,state,idempotency_key,actor_user_id)
      VALUES($1,$2,'INCLUDED_IN_SETTLEMENT',$3,$4)`,
    [id(),p.unitId,id(),actor]),/requires PAYABLE and two facts/);
    const i=await include(f.scope.id,incKey);
    assert.equal(i.state,'INCLUDED_IN_SETTLEMENT');
    assert.equal((await include(f.scope.id,incKey)).replayed,true);
    assert.equal(await count('handyman_settlement_inclusions',p.unitId),2);
    const r=await reconcile(f.scope.id,recKey);
    assert.equal(r.outcome,'MATCHED');
    assert.equal(r.variance,'0.00');
    assert.equal((await reconcile(f.scope.id,recKey)).id,r.id);
    const s=await settle(f.scope.id,setKey);
    assert.equal(s.state,'SETTLED');
    assert.equal((await settle(f.scope.id,setKey)).replayed,true);
    await assert.rejects(settle(f.scope.id),code('HANDYMAN_SETTLEMENT_CONFLICT'));
    await assert.rejects(include(f.scope.id),code('HANDYMAN_SETTLEMENT_CONFLICT'));
    await assert.rejects(q('DELETE FROM handyman_settlement_events WHERE unit_id=$1',
      [p.unitId]),/append-only/);
    await assert.rejects(q(`UPDATE handyman_settlement_inclusions SET amount=1
      WHERE unit_id=$1`,[p.unitId]),/append-only/);
    const states=(await q(`SELECT state FROM handyman_settlement_events
      WHERE unit_id=$1 ORDER BY occurred_at`,[p.unitId])).rows.map(x=>x.state);
    assert.deepEqual(states,['PAYABLE','INCLUDED_IN_SETTLEMENT','SETTLED']);
    assert.deepEqual(await sourceFingerprint(),sourcesBefore,
      'settlement must not write to ledger or re-derive entitlement facts');
  });

  it('no over-settlement from partial payment; forward refund creates variance, not a silent clamp',async () => {
    const f=await fixture();
    await fund(f.scope.id,'40.00');
    await assert.rejects(prepare(f.scope.id),code('HANDYMAN_SETTLEMENT_NOT_FUNDED'));
    const payment=await fund(f.scope.id,'60.00');
    const p=await prepare(f.scope.id); await include(f.scope.id);
    const matched=await reconcile(f.scope.id);
    assert.equal(matched.outcome,'MATCHED');
    const refund=await refundHandymanCustomerPayment({
      executionScopeId:f.scope.id,paymentId:payment,amount:'10.00',
      reason:'Customer refund',idempotencyKey:id(),
    },actor);
    await assert.rejects(settle(f.scope.id),code('HANDYMAN_SETTLEMENT_NOT_FUNDED'));
    const recorded=await recordHandymanSettlementCorrection(f.scope.id,actor,
      refund.correction.id,id());
    assert.equal(recorded.kind,'ADJUSTED');
    await assert.rejects(recordHandymanSettlementCorrection(f.scope.id,actor,
      refund.correction.id,id()),code('HANDYMAN_SETTLEMENT_CONFLICT'));
    const mismatch=await reconcile(f.scope.id);
    assert.equal(mismatch.outcome,'VARIANCE');
    assert.equal(mismatch.cause,'OPEN_EXCEPTION');
    assert.equal(mismatch.variance,'10.00');
    await assert.rejects(settle(f.scope.id),code('HANDYMAN_SETTLEMENT_VARIANCE'));
    assert.equal(await count('handyman_settlement_reconciliations',p.unitId),2);
    assert.equal(await count('handyman_settlement_inclusions',p.unitId),2);
  });

  it('dispute holds an unsettled unit; later correction after SETTLED is a new fact, not a transition',async () => {
    const held=await fixture(); await fund(held.scope.id,'100.00');
    const unit=await prepare(held.scope.id);
    const disputeKey=id();
    const dispute=await holdHandymanSettlementDispute(held.scope.id,actor,disputeKey);
    assert.equal(dispute.kind,'DISPUTED');
    assert.equal((await holdHandymanSettlementDispute(held.scope.id,actor,disputeKey)).id,
      dispute.id);
    await assert.rejects(include(held.scope.id),code('HANDYMAN_SETTLEMENT_VARIANCE'));
    assert.equal(await count('handyman_settlement_exceptions',unit.unitId),1);
    const f=await fixture();
    const payment=await fund(f.scope.id,'100.00');
    const prepared=await prepare(f.scope.id);
    await include(f.scope.id); await reconcile(f.scope.id);
    await settle(f.scope.id);
    const refund=await refundHandymanCustomerPayment({
      executionScopeId:f.scope.id,paymentId:payment,amount:'5.00',
      reason:'Post-close correction',idempotencyKey:id(),
    },actor);
    const x=await recordHandymanSettlementCorrection(f.scope.id,actor,
      refund.correction.id,id());
    assert.equal(x.kind,'ADJUSTED');
    const result=await reconcile(f.scope.id);
    assert.equal(result.outcome,'VARIANCE');
    assert.equal(await count('handyman_settlement_events',prepared.unitId),3);
    assert.equal(await count('handyman_settlement_exceptions',prepared.unitId),1);
    await assert.rejects(settle(f.scope.id),code('HANDYMAN_SETTLEMENT_CONFLICT'));
  });
});
