import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { bindVerifiedTestBm, prepareVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { baseFixture, crewFixture, initHandymanFixtures, locationChain, scopeFixture }
  from './helpers/handyman-fixtures';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion }
  from '../src/modules/handyman-commercial-agreements';
import { bindHandymanBmBuildingCoverage, closeHandymanBmBuildingCoverage,
  resolveHandymanBmBuildingCoverageAt } from '../src/modules/handyman-bm-binding';
import { openHandymanCustomerTransaction, composeHandymanChargeLine }
  from '../src/modules/handyman-customer-transactions';
import { adjustHandymanCustomerLedger }
  from '../src/modules/handyman-customer-ledger-corrections';
import { recordHandymanCustomerPayment }
  from '../src/modules/handyman-customer-payments';
import { deriveHandymanFinancialEntitlements }
  from '../src/modules/handyman-financial-entitlements';
import { readHandymanFinancialClientAt, readHandymanFinancialTransactionAt }
  from '../src/modules/handyman-financial-read';
import { prepareHandymanSettlement } from '../src/modules/handyman-settlement';

const DIR = '/tmp/hm14-part02-pg', PORT = 55492;
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
  DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
let pg: EmbeddedPostgres;
let pool: Pool;
let actor: string;
const id = () => randomUUID();
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
    user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise(); await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect(); await admin.query('CREATE DATABASE asentra_test');
  await admin.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase();
  assert.ok(config);
  pool = await initDatabase(config);
  await migrateUp(pool);
  actor = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: actor, disciplineId: discipline.id, query: q });
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); }
});

type Options = { mode?: 'DEFAULT' | 'REFERENCE';
  term?: boolean; beneficiary?: boolean; charge?: boolean; rate?: string;
  coverage?: boolean; distinctBeneficiary?: boolean };
async function fixture(options: Options = {}) {
  const { realm, scope } = await baseFixture();
  const crew = await crewFixture(realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: scope.id, providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, actor);
  const draft = await prepareHandymanCommercialAgreement(actor, {
    clientId: realm.client.id, idempotencyKey: id(),
  });
  const versionId = draft.version.id;
  await q(`INSERT INTO handyman_bm_fee_rule_definitions
    (id, agreement_version_id, basis, mode, idempotency_key, created_by_user_id)
    VALUES ($1,$2,'LABOR_ONLY',$3,$4,$5)`,
  [id(), versionId, options.mode ?? 'DEFAULT', id(), actor]);
  if (options.term !== false) await q(`INSERT INTO handyman_bm_fee_term_definitions
    (id, agreement_version_id, term_kind, rate_percent, idempotency_key, created_by_user_id)
    VALUES ($1,$2,'PERCENTAGE_OF_BASIS',$3,$4,$5)`,
  [id(), versionId, options.rate ?? '2.5000', id(), actor]);
  if (options.beneficiary !== false) await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions
    (id, agreement_version_id, beneficiary_kind, beneficiary_reference_id,
     idempotency_key, created_by_user_id)
    VALUES ($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
  [id(), versionId, realm.client.id, id(), actor]);
  await activateHandymanCommercialAgreementVersion(actor, {
    versionId, effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    idempotencyKey: id(),
  });
  const bmCoverage = options.coverage !== false && options.mode !== 'REFERENCE' &&
    options.term !== false && (options.beneficiary !== false || options.distinctBeneficiary)
    ? await bindVerifiedTestBm({ actor, clientId: realm.client.id, buildingId: realm.building.id,
        versionId, query: q, distinct: options.distinctBeneficiary })
    : null;
  const opened = await openHandymanCustomerTransaction({
    executionScopeId: scope.id, idempotencyKey: id(),
  }, actor);
  const line = (await q(`SELECT id FROM handyman_quotation_lines
    WHERE quotation_version_id=$1 AND line_type='LABOR'`,
  [scope.approvedQuotationVersionId])).rows[0];
  let chargeId: string | null = null;
  if (options.charge !== false) {
    const charge = await composeHandymanChargeLine({
      executionScopeId: scope.id, quotationLineId: line.id,
      idempotencyKey: id(),
    }, actor);
    chargeId = charge.chargeLine.id;
  }
  return { realm, scope, crew, assignment, opened, chargeId, bmCoverage };
}

/** A different Building, but the SAME Client and commercial version. */
async function siblingFixture(f: Awaited<ReturnType<typeof fixture>>) {
  assert.ok(f.bmCoverage);
  const building = await buildingService.createBuilding({ propertyId: f.realm.property.id,
    code: `SIB_${id().slice(0, 8)}`, name: 'Sibling Building' });
  await buildingAssignmentService.createAssignment(actor, { buildingId: building.id });
  const realm = { ...f.realm, building };
  const scope = (await scopeFixture(realm, await locationChain(realm))).scope;
  const crew = await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({ executionScopeId: scope.id,
    providerContextId: crew.providerContext.id, crewId: crew.crew.id }, actor);
  const bmCoverage = await bindVerifiedTestBm({ actor, clientId: realm.client.id,
    buildingId: building.id, versionId: f.bmCoverage.coverage.agreementVersionId,
    query: q, distinct: true });
  const opened = await openHandymanCustomerTransaction({ executionScopeId: scope.id,
    idempotencyKey: id() }, actor);
  const line = (await q(`SELECT id FROM handyman_quotation_lines
    WHERE quotation_version_id=$1 AND line_type='LABOR'`, [scope.approvedQuotationVersionId])).rows[0];
  await composeHandymanChargeLine({ executionScopeId: scope.id, quotationLineId: line.id,
    idempotencyKey: id() }, actor);
  return { realm, scope, crew, opened, bmCoverage };
}

// Direct inserts exercise database guards independently of the service.
const rawDistinctSql = `INSERT INTO handyman_entitlement_facts
  (id,client_id,transaction_id,execution_scope_id,currency,ledger_posted_at,
   ledger_contract_version,entitlement_kind,fact_state,basis_kind,charged_net,labor_net,
   material_net,adjusted_transaction_scope,amount,agreement_id,agreement_version_id,
   agreement_version_number,agreement_effective_from,agreement_effective_to,bm_rule_id,
   bm_term_id,bm_term_rate_percent,bm_beneficiary_kind,bm_counterparty_id,bm_building_id,
   bm_coverage_id,bm_verification_id,bm_coverage_effective_from,bm_coverage_effective_to,
   idempotency_key,derived_by_user_id)
  SELECT $1,t.client_id,t.id,t.execution_scope_id,t.currency,date_trunc('milliseconds',t.created_at),
    'CR-HM-13-PART-06','BM_FEE','EARNED','LABOR_ONLY',100,100,0,0,2.5,
    a.id,v.id,v.version_number,v.effective_from,v.effective_to,r.id,term.id,term.rate_percent,
    'BM_LEGAL_COUNTERPARTY',c.counterparty_id,c.building_id,c.id,c.verification_id,
    c.effective_from,c.effective_to,$2,$3
  FROM handyman_customer_transactions t
  JOIN handyman_execution_scopes s ON s.id=t.execution_scope_id
  JOIN handyman_bm_building_coverages c ON c.client_id=t.client_id AND c.building_id=s.building_id
  JOIN handyman_commercial_agreement_versions v ON v.id=c.agreement_version_id
  JOIN handyman_commercial_agreements a ON a.id=v.agreement_id
  JOIN handyman_bm_fee_rule_definitions r ON r.agreement_version_id=v.id
  JOIN handyman_bm_fee_term_definitions term ON term.agreement_version_id=v.id
  WHERE t.execution_scope_id=$4`;
function insertRawDistinct(executor: Pool | PoolClient, scopeId: string) {
  return executor.query(rawDistinctSql, [id(), id(), actor, scopeId]);
}
const cloneColumns = [
  'client_id','transaction_id','execution_scope_id','currency','ledger_posted_at',
  'ledger_contract_version','entitlement_kind','fact_state','basis_kind','charged_net',
  'labor_net','material_net','adjusted_transaction_scope','amount','agreement_id',
  'agreement_version_id','agreement_version_number','agreement_effective_from','agreement_effective_to',
  'bm_rule_id','bm_term_id','bm_term_rate_percent','bm_beneficiary_id','bm_beneficiary_reference_id',
  'bm_beneficiary_kind','bm_counterparty_id','bm_building_id','bm_coverage_id','bm_verification_id',
  'bm_coverage_effective_from','bm_coverage_effective_to','derived_by_user_id',
] as const;
async function cloneDistinct(factId: string, overrides: Partial<Record<(typeof cloneColumns)[number], unknown>> = {}) {
  const params: unknown[] = [id(), id(), factId];
  const values = cloneColumns.map(column => {
    if (!(column in overrides)) return `e.${column}`;
    params.push(overrides[column]); return `$${params.length}`;
  });
  return q(`INSERT INTO handyman_entitlement_facts (id,idempotency_key,${cloneColumns.join(',')})
    SELECT $1,$2,${values.join(',')} FROM handyman_entitlement_facts e WHERE e.id=$3`, params);
}
async function rawUnit(scopeId: string) {
  const unit = id();
  await q(`INSERT INTO handyman_settlement_units
    (id,client_id,transaction_id,execution_scope_id,currency,idempotency_key,actor_user_id)
    SELECT $1,client_id,id,execution_scope_id,currency,$2,$3
      FROM handyman_customer_transactions WHERE execution_scope_id=$4`, [unit,id(),actor,scopeId]);
  return unit;
}
function rawPayable(executor: Pool | PoolClient, unitId: string) {
  return executor.query(`INSERT INTO handyman_settlement_events
    (id,unit_id,state,idempotency_key,actor_user_id) VALUES($1,$2,'PAYABLE',$3,$4)`,
  [id(),unitId,id(),actor]);
}
async function waitForLock(waiter: number, blocker: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await q('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker]);
    if (result.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Concurrent writer did not wait on the shared transaction lock.');
}
const derive = (scopeId: string, key: string = id()) =>
  deriveHandymanFinancialEntitlements(scopeId, actor, key);
const count = async (scopeId: string) => (await q(`SELECT count(*)::int AS n
  FROM handyman_entitlement_facts WHERE execution_scope_id=$1`, [scopeId])).rows[0].n;
const hasCode = (code: string) => (e: { code?: string; statusCode?: number }) => {
  assert.equal(e.code, code);
  assert.equal(e.statusCode, 409);
  return true;
};

describe('CR-HM-14 PART 02 governed entitlement derivation', () => {
  it('blocks inferred Client claims, including raw SQL, when Building coverage is absent or belongs to a distinct BM', async () => {
    for (const options of [{ coverage: false }, { distinctBeneficiary: true }]) {
      const f = await fixture(options);
      if (options.distinctBeneficiary) await derive(f.scope.id);
      else await assert.rejects(derive(f.scope.id), hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
      const expectedCount = options.distinctBeneficiary ? 2 : 0;
      assert.equal(await count(f.scope.id), expectedCount);
      // A direct SQL writer cannot bypass the same Building/payee guard.
      await assert.rejects(q(`INSERT INTO handyman_entitlement_facts
        (id,client_id,transaction_id,execution_scope_id,currency,ledger_posted_at,
         ledger_contract_version,entitlement_kind,fact_state,basis_kind,charged_net,labor_net,
         material_net,adjusted_transaction_scope,amount,agreement_id,agreement_version_id,
         agreement_version_number,agreement_effective_from,agreement_effective_to,bm_rule_id,
         bm_term_id,bm_term_rate_percent,bm_beneficiary_id,bm_beneficiary_reference_id,
         idempotency_key,derived_by_user_id)
        SELECT $1,t.client_id,t.id,t.execution_scope_id,t.currency,date_trunc('milliseconds',t.created_at),
          'CR-HM-13-PART-06','BM_FEE','EARNED','LABOR_ONLY',100,100,0,0,2.5,
          a.id,v.id,v.version_number,v.effective_from,v.effective_to,r.id,x.id,x.rate_percent,
          b.id,t.client_id,$2,$3
        FROM handyman_customer_transactions t
        JOIN handyman_commercial_agreements a ON a.client_id=t.client_id
        JOIN handyman_commercial_agreement_versions v ON v.agreement_id=a.id AND v.status='ACTIVE'
        JOIN handyman_bm_fee_rule_definitions r ON r.agreement_version_id=v.id
        JOIN handyman_bm_fee_term_definitions x ON x.agreement_version_id=v.id
        JOIN handyman_bm_fee_beneficiary_definitions b ON b.agreement_version_id=v.id
        WHERE t.execution_scope_id=$4`, [id(), id(), actor, f.scope.id]), /Exact verified Client-beneficiary Building coverage/);
      assert.equal(await count(f.scope.id), expectedCount);
    }
  });
  it('posts both immutable facts atomically, exact version/assignment and same-key replay', async () => {
    const f = await fixture();
    const key = id();
    const first = await derive(f.scope.id, key);
    assert.equal(first.provider.amount, '97.50');
    assert.equal(first.bmFee.amount, '2.50');
    assert.equal(first.provider.replayed, false);
    assert.equal(await count(f.scope.id), 2);
    const rows = (await q(`SELECT * FROM handyman_entitlement_facts
      WHERE execution_scope_id=$1 ORDER BY entitlement_kind`, [f.scope.id])).rows;
    assert.equal(rows[0].bm_beneficiary_reference_id, f.realm.client.id);
    assert.equal(rows[0].agreement_version_id !== null, true);
    assert.equal(rows[0].bm_term_rate_percent, '2.5000');
    assert.equal(rows[1].assignment_id, f.assignment.id);
    assert.equal(rows[1].lead_worker_id, f.crew.workerContext.id);
    assert.equal(rows[1].charged_net, '100.00');
    assert.equal(rows[1].labor_net, '100.00');
    const replay = await derive(f.scope.id, key);
    assert.equal(replay.provider.id, first.provider.id);
    assert.equal(replay.bmFee.id, first.bmFee.id);
    assert.equal(replay.bmFee.replayed, true);
    await assert.rejects(derive(f.scope.id), hasCode('HANDYMAN_ENTITLEMENT_CONFLICT'));
    assert.equal(await count(f.scope.id), 2);
  });

  it('refuses missing posted charge, PENDING intake, REFERENCE and absent term without partial facts', async () => {
    const noCharge = await fixture({ charge: false });
    await assert.rejects(derive(noCharge.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_LEDGER_NOT_AUTHORITATIVE'));
    assert.equal(await count(noCharge.scope.id), 0);
    const pending = await fixture();
    await recordHandymanCustomerPayment({ executionScopeId: pending.scope.id,
      amount: '5.00', channel: 'BANK_TRANSFER', providerName: 'Bank',
      providerReference: id(), externalReference: id(), idempotencyKey: id(),
    }, actor);
    await assert.rejects(derive(pending.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_LEDGER_NOT_AUTHORITATIVE'));
    const reference = await fixture({ mode: 'REFERENCE' });
    await assert.rejects(derive(reference.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
    const unconfigured = await fixture({ term: false });
    await assert.rejects(derive(unconfigured.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
    const noBeneficiary = await fixture({ beneficiary: false });
    await assert.rejects(derive(noBeneficiary.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
    const ambiguous = await fixture();
    await adjustHandymanCustomerLedger({ executionScopeId: ambiguous.scope.id,
      amount: '5.00', reason: 'Transaction-wide adjustment',
      idempotencyKey: id(),
    }, actor);
    await assert.rejects(derive(ambiguous.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
    assert.equal(await count(reference.scope.id), 0);
    assert.equal(await count(unconfigured.scope.id), 0);
    assert.equal(await count(noBeneficiary.scope.id), 0);
    assert.equal(await count(ambiguous.scope.id), 0);
  });

  it('uses correction-netted LABOR (integer arithmetic) and refuses ambiguous attribution', async () => {
    const f = await fixture({ rate: '2.5001' });
    await adjustHandymanCustomerLedger({ executionScopeId: f.scope.id,
      chargeLineId: f.chargeId!, amount: '20.00',
      reason: 'Labor correction', idempotencyKey: id(),
    }, actor);
    const result = await derive(f.scope.id);
    assert.equal(result.bmFee.amount, '2.00');
    assert.equal(result.provider.amount, '78.00');
    const rows = (await q(`SELECT charged_net, labor_net FROM handyman_entitlement_facts
       WHERE execution_scope_id=$1`, [f.scope.id])).rows;
    assert.deepEqual(rows.map(r => [r.charged_net, r.labor_net]),
      [['80.00', '80.00'], ['80.00', '80.00']]);
    const cause = await adjustHandymanCustomerLedger({ executionScopeId: f.scope.id,
      chargeLineId: f.chargeId!, amount: '20.00',
      reason: 'Later labor correction', idempotencyKey: id(),
    }, actor);
    const correctionKey = id();
    const revised = await derive(f.scope.id, correctionKey);
    assert.equal(revised.provider.amount, '58.50');
    assert.equal(revised.bmFee.amount, '1.50');
    assert.equal(await count(f.scope.id), 2);
    const corrections = (await q(`SELECT c.ledger_correction_id, c.fact_kind, c.amount
       FROM handyman_entitlement_corrections c
       JOIN handyman_entitlement_facts e ON e.id=c.entitlement_id
       WHERE e.execution_scope_id=$1 ORDER BY c.amount`, [f.scope.id])).rows;
    assert.equal(corrections.length, 2);
    assert.ok(corrections.every(c => c.ledger_correction_id === cause.correction.id));
    assert.deepEqual(corrections.map(c => c.amount), ['0.50', '19.50']);
    const replay = await derive(f.scope.id, correctionKey);
    assert.equal(replay.provider.replayed, true);
    assert.equal((await q(`SELECT count(*)::int AS n FROM handyman_entitlement_corrections
      WHERE ledger_correction_id=$1`, [cause.correction.id])).rows[0].n, 2);
    const correctionId = (await q(`SELECT id FROM handyman_entitlement_corrections
      WHERE ledger_correction_id=$1 LIMIT 1`, [cause.correction.id])).rows[0].id;
    await assert.rejects(q(`UPDATE handyman_entitlement_corrections SET amount=1
      WHERE id=$1`, [correctionId]), /append-only/);
    await assert.rejects(q(`DELETE FROM handyman_entitlement_corrections
      WHERE id=$1`, [correctionId]), /append-only/);
    await assert.rejects(q(`INSERT INTO handyman_entitlement_corrections
      (id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
      SELECT $1,entitlement_id,ledger_correction_id,fact_kind,amount,$2,actor_user_id
      FROM handyman_entitlement_corrections WHERE id=$3`,
    [id(), id(), correctionId]), /unique/i);
    const multi = await fixture();
    await q(`INSERT INTO handyman_work_sessions
      (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
       lead_user_id, status, checked_in_at) VALUES
      ($1,$2,$3,$4,$5,$6,'CHECKED_IN',NOW())`,
    [id(), multi.realm.client.id, multi.scope.id, multi.assignment.id,
      multi.crew.workerContext.id, multi.crew.leadUser.id]);
    // The session's own lead now disagrees with the active assignment.
    // An alternate lead worker is valid FK but cannot authorize a split.
    // Existing session cannot be edited: use a second historical assignment
    // with a different provider to exercise the conflict gate instead.
    const otherCrew = await crewFixture(multi.realm);
    await q(`INSERT INTO handyman_execution_scope_assignments
       (id, client_id, execution_scope_id, handyman_provider_context_id,
        handyman_crew_id, status, assigned_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'SUPERSEDED',$6)`,
    [id(), multi.realm.client.id, multi.scope.id,
      otherCrew.providerContext.id, otherCrew.crew.id, actor]);
    await assert.rejects(derive(multi.scope.id),
      hasCode('HANDYMAN_ENTITLEMENT_ATTRIBUTION_UNRESOLVED'));
    assert.equal(await count(multi.scope.id), 0);
  });
});

describe('CR-HM-BM-COMMISSION-01 PART 01C distinct BM earned binding', () => {
  it('records exact verified provenance without a legacy beneficiary and replays concurrent same-key commands', async () => {
    const f = await fixture({ distinctBeneficiary: true, beneficiary: false });
    assert.ok(f.bmCoverage);
    const key = id();
    const results = await Promise.all([derive(f.scope.id, key), derive(f.scope.id, key)]);
    assert.equal(results[0].bmFee.id, results[1].bmFee.id);
    assert.deepEqual(results.map(x => x.bmFee.replayed).sort(), [false, true]);
    assert.equal(results[0].provider.amount, '97.50');
    assert.equal(results[0].bmFee.amount, '2.50');
    assert.equal(await count(f.scope.id), 2);
    const fact = (await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1', [results[0].bmFee.id])).rows[0];
    assert.equal(fact.bm_beneficiary_kind, 'BM_LEGAL_COUNTERPARTY');
    assert.equal(fact.bm_beneficiary_id, null);
    assert.equal(fact.bm_beneficiary_reference_id, null);
    assert.equal(fact.bm_counterparty_id, f.bmCoverage.counterparty.id);
    assert.equal(fact.bm_verification_id, f.bmCoverage.verification.id);
    assert.equal(fact.bm_building_id, f.realm.building.id);
    assert.equal(fact.bm_coverage_id, f.bmCoverage.coverage.id);
    assert.equal(fact.agreement_version_id, f.bmCoverage.coverage.agreementVersionId);
    assert.equal(fact.bm_coverage_effective_from.toISOString(), f.bmCoverage.coverage.effectiveFrom.toISOString());
    assert.equal(fact.bm_coverage_effective_to, null);
    const guards = await q(`SELECT guard_kind FROM handyman_bm_entitlement_guards
      WHERE transaction_id=$1 OR entitlement_id=$2`, [fact.transaction_id, fact.id]);
    assert.deepEqual(guards.rows.map(row => row.guard_kind).sort(), ['DISTINCT', 'DISTINCT']);
    await assert.rejects(q('DELETE FROM handyman_bm_entitlement_guards WHERE entitlement_id=$1', [fact.id]), /immutable/);
    await assert.rejects(q("UPDATE handyman_bm_entitlement_guards SET guard_kind='FISCAL' WHERE entitlement_id=$1", [fact.id]), /immutable/);
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_bm_fee_beneficiary_definitions WHERE agreement_version_id=$1',
      [fact.agreement_version_id])).rows[0].n, 0);
    const read = await readHandymanFinancialTransactionAt(f.scope.id, actor);
    const bm = read.entitlements.find(x => x.entitlementKind === 'BM_FEE')!.bmFee!;
    assert.equal(bm.beneficiaryKind, 'BM_LEGAL_COUNTERPARTY');
    if (bm.beneficiaryKind !== 'BM_LEGAL_COUNTERPARTY') assert.fail('Distinct BM discriminant missing.');
    assert.equal(bm.beneficiaryId, null); assert.equal(bm.beneficiaryReferenceId, null);
    assert.equal(bm.counterpartyId, f.bmCoverage.counterparty.id);
    assert.equal(bm.verificationId, f.bmCoverage.verification.id);
    assert.equal(bm.buildingId, f.realm.building.id);
    assert.equal(bm.coverageId, f.bmCoverage.coverage.id);
    assert.equal(bm.coverageEffectiveFrom, fact.bm_coverage_effective_from.toISOString());
    assert.equal(bm.coverageEffectiveTo, null);
    assert.equal(read.status, 'EARNED');
    await assert.rejects(derive(f.scope.id), hasCode('HANDYMAN_ENTITLEMENT_CONFLICT'));
  });

  it('isolates sibling Buildings and Clients, and rejects substitution, falsified provenance and duplicate facts in SQL', async () => {
    const a = await fixture({ distinctBeneficiary: true, beneficiary: false });
    assert.ok(a.bmCoverage);
    const b = await siblingFixture(a);
    const foreign = await fixture({ distinctBeneficiary: true, beneficiary: false });
    assert.ok(foreign.bmCoverage);
    const first = await derive(a.scope.id), second = await derive(b.scope.id);
    assert.notEqual(a.bmCoverage.counterparty.id, b.bmCoverage.counterparty.id);
    const aFact = (await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1', [first.bmFee.id])).rows[0];
    const bFact = (await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1', [second.bmFee.id])).rows[0];
    assert.equal(aFact.client_id, bFact.client_id);
    assert.equal(aFact.agreement_version_id, bFact.agreement_version_id);
    assert.notEqual(aFact.bm_building_id, bFact.bm_building_id);
    assert.notEqual(aFact.bm_counterparty_id, bFact.bm_counterparty_id);

    const forbidden = (e: { code?: string; statusCode?: number }) => {
      assert.equal(e.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');
      assert.equal(e.statusCode, 403); return true;
    };
    assert.equal((await readHandymanFinancialTransactionAt(a.scope.id, a.crew.leadUser.id)).status, 'EARNED');
    await assert.rejects(readHandymanFinancialTransactionAt(b.scope.id, a.crew.leadUser.id), forbidden);
    await assert.rejects(deriveHandymanFinancialEntitlements(b.scope.id, a.crew.leadUser.id, id()), forbidden);
    await assert.rejects(readHandymanFinancialTransactionAt(a.scope.id, foreign.crew.leadUser.id), forbidden);
    await assert.rejects(readHandymanFinancialClientAt(a.realm.client.id, foreign.crew.leadUser.id), forbidden);
    const clientRead = await readHandymanFinancialClientAt(a.realm.client.id, a.crew.leadUser.id);
    assert.deepEqual(clientRead.transactions.map(x => x.transaction.transactionId), [a.opened.transaction.id]);

    for (const overrides of [
      { bm_counterparty_id: bFact.bm_counterparty_id, bm_verification_id: bFact.bm_verification_id },
      { bm_building_id: bFact.bm_building_id, bm_coverage_id: bFact.bm_coverage_id,
        bm_counterparty_id: bFact.bm_counterparty_id, bm_verification_id: bFact.bm_verification_id },
      { bm_coverage_id: bFact.bm_coverage_id },
      { agreement_version_id: foreign.bmCoverage.coverage.agreementVersionId },
      { client_id: foreign.realm.client.id },
      { bm_coverage_effective_from: new Date(aFact.bm_coverage_effective_from.getTime() + 1) },
    ]) {
      await assert.rejects(cloneDistinct(first.bmFee.id, overrides),
        (e: { code?: string }) => { assert.equal(e.code, '23514'); return true; });
    }
    await assert.rejects(cloneDistinct(first.bmFee.id, { bm_beneficiary_id: id() }),
      (e: { code?: string }) => { assert.equal(e.code, '23514'); return true; });
    await assert.rejects(cloneDistinct(first.bmFee.id),
      (e: { code?: string }) => { assert.equal(e.code, '23505'); return true; });
    await assert.rejects(q('UPDATE handyman_entitlement_facts SET bm_counterparty_id=$2 WHERE id=$1',
      [first.bmFee.id, bFact.bm_counterparty_id]), /append-only/);
    await assert.rejects(q('DELETE FROM handyman_entitlement_facts WHERE id=$1', [first.bmFee.id]), /append-only/);
    assert.equal(await count(a.scope.id), 2);
  });

  it('requires effective coverage at the ledger instant, with no fallback or partial provider fact', async () => {
    const f = await fixture({ coverage: false, distinctBeneficiary: true, beneficiary: false });
    await assert.rejects(derive(f.scope.id), hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
    const prepared = await prepareVerifiedTestBm(actor, f.realm.client.id, true);
    const agreement = (await q(`SELECT v.id FROM handyman_commercial_agreement_versions v
      JOIN handyman_commercial_agreements a ON a.id=v.agreement_id WHERE a.client_id=$1 AND v.status='ACTIVE'`,
    [f.realm.client.id])).rows[0];
    await bindHandymanBmBuildingCoverage(actor, { clientId: f.realm.client.id, buildingId: f.realm.building.id,
      agreementVersionId: agreement.id, counterpartyId: prepared.counterparty.id,
      beneficiaryKind: 'BM_LEGAL_COUNTERPARTY', effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: id() });
    await assert.rejects(derive(f.scope.id), hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE'));
    await assert.rejects(insertRawDistinct(pool, f.scope.id), /Exact verified distinct BM Client\/Building\/version coverage/);
    assert.equal(await count(f.scope.id), 0);
  });

  it('replays and corrects the original beneficiary after prospective closure, replacement and version supersession', async () => {
    const f = await fixture({ distinctBeneficiary: true, beneficiary: false });
    assert.ok(f.bmCoverage);
    const key = id(), initial = await derive(f.scope.id, key);
    const before = (await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1', [initial.bmFee.id])).rows[0];
    const replacementParty = await prepareVerifiedTestBm(actor, f.realm.client.id, true);
    const replacement = await prepareHandymanCommercialAgreement(actor, { clientId: f.realm.client.id, idempotencyKey: id() });
    await q(`INSERT INTO handyman_bm_fee_rule_definitions
      (id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
      VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`, [id(),replacement.version.id,id(),actor]);
    await q(`INSERT INTO handyman_bm_fee_term_definitions
      (id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
      VALUES($1,$2,'PERCENTAGE_OF_BASIS','3.0000',$3,$4)`, [id(),replacement.version.id,id(),actor]);
    const boundary = new Date(Date.now() + 120_000).toISOString();
    await closeHandymanBmBuildingCoverage(actor, { clientId: f.realm.client.id, coverageId: f.bmCoverage.coverage.id,
      effectiveTo: boundary, reason: 'Prospective replacement' });
    await supersedeHandymanCommercialAgreementVersion(actor, { versionId: before.agreement_version_id,
      replacementVersionId: replacement.version.id, effectiveFrom: boundary, idempotencyKey: id() });
    await bindHandymanBmBuildingCoverage(actor, { clientId: f.realm.client.id, buildingId: f.realm.building.id,
      agreementVersionId: replacement.version.id, counterpartyId: replacementParty.counterparty.id,
      beneficiaryKind: 'BM_LEGAL_COUNTERPARTY', effectiveFrom: boundary, idempotencyKey: id() });
    assert.equal((await resolveHandymanBmBuildingCoverageAt(f.realm.client.id, f.realm.building.id, boundary)).counterpartyId,
      replacementParty.counterparty.id);
    const replay = await derive(f.scope.id, key);
    assert.equal(replay.bmFee.id, initial.bmFee.id); assert.equal(replay.bmFee.replayed, true);
    const adjustment = await adjustHandymanCustomerLedger({ executionScopeId: f.scope.id,
      chargeLineId: f.chargeId!, amount: '20.00', reason: 'Later labor adjustment', idempotencyKey: id() }, actor);
    const corrected = await derive(f.scope.id, id());
    assert.equal(corrected.bmFee.id, initial.bmFee.id); assert.equal(corrected.bmFee.amount, '2.00');
    assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1', [initial.bmFee.id])).rows[0], before);
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_entitlement_corrections WHERE ledger_correction_id=$1',
      [adjustment.correction.id])).rows[0].n, 2);
    const published = (await readHandymanFinancialTransactionAt(f.scope.id, actor))
      .entitlements.find(x => x.entitlementKind === 'BM_FEE')!.bmFee!;
    assert.equal(published.beneficiaryKind, 'BM_LEGAL_COUNTERPARTY');
    if (published.beneficiaryKind !== 'BM_LEGAL_COUNTERPARTY') assert.fail();
    assert.equal(published.counterpartyId, f.bmCoverage.counterparty.id);
    assert.equal(published.coverageEffectiveTo, null);
    assert.equal(published.effectiveTo, null);
  });

  it('fails closed for distinct settlement and unbound fiscal associations, including direct SQL', async () => {
    const f = await fixture({ distinctBeneficiary: true, beneficiary: false });
    const fact = await derive(f.scope.id);
    await assert.rejects(prepareHandymanSettlement(f.scope.id, actor, id()),
      hasCode('HANDYMAN_SETTLEMENT_NOT_AUTHORITATIVE'));
    const unit = await rawUnit(f.scope.id);
    for (const state of ['PAYABLE', 'INCLUDED_IN_SETTLEMENT', 'SETTLED']) {
      await assert.rejects(q(`INSERT INTO handyman_settlement_events
        (id,unit_id,state,idempotency_key,actor_user_id) VALUES($1,$2,$3,$4,$5)`,
      [id(),unit,state,id(),actor]), /Distinct BM settlement is not supported/);
    }
    for (const entitlement of [fact.provider.id, fact.bmFee.id]) {
      await assert.rejects(q(`INSERT INTO handyman_settlement_inclusions
        (id,unit_id,entitlement_id,amount,idempotency_key,actor_user_id) VALUES($1,$2,$3,1,$4,$5)`,
      [id(),unit,entitlement,id(),actor]), /Distinct BM settlement is not supported/);
    }
    await assert.rejects(q(`INSERT INTO handyman_bm_fee_fiscal_bases
      (entitlement_id,tenant_profile_id,bm_profile_id,basis_ex_vat) VALUES($1,$2,$3,1)`,
    [fact.bmFee.id,id(),id()]), /Distinct BM fiscal binding is not supported/);
    await assert.rejects(q(`INSERT INTO handyman_fiscal_documents (id,entitlement_id) VALUES($1,$2)`,
      [id(),fact.bmFee.id]), /Distinct BM fiscal binding is not supported/);
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_settlement_events WHERE unit_id=$1', [unit])).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_settlement_inclusions WHERE unit_id=$1', [unit])).rows[0].n, 0);
  });

  it('refuses tax-configured distinct earnings instead of applying an agreement-only BM profile', async () => {
    const f = await fixture({ distinctBeneficiary: true, beneficiary: false });
    // Simulate a profile configured in DRAFT before quotation approval.
    await q('ALTER TABLE handyman_financial_tax_profiles DISABLE TRIGGER handyman_tax_profile_draft_guard');
    try {
      await q(`INSERT INTO handyman_financial_tax_profiles
        (id,quotation_version_id,facts,created_by_user_id) VALUES($1,$2,'{}'::jsonb,$3)`,
      [id(),f.scope.approvedQuotationVersionId,actor]);
    } finally {
      await q('ALTER TABLE handyman_financial_tax_profiles ENABLE TRIGGER handyman_tax_profile_draft_guard');
    }
    await assert.rejects(derive(f.scope.id), (e: { code?: string; statusCode?: number; message?: string }) => {
      hasCode('HANDYMAN_ENTITLEMENT_BM_NOT_AUTHORITATIVE')(e);
      assert.match(e.message ?? '', /future beneficiary-bound fiscal contract/); return true;
    });
    await assert.rejects(insertRawDistinct(pool, f.scope.id), /Distinct BM fiscal binding is not supported/);
    assert.equal(await count(f.scope.id), 0);
  });

  it('serializes concurrent direct settlement and distinct earning in both commit orders and isolation levels', async () => {
    for (const isolation of ['READ COMMITTED', 'REPEATABLE READ'] as const) {
      for (const settlementFirst of [true, false]) {
        const f = await fixture({ distinctBeneficiary: true, beneficiary: false });
        const unit = await rawUnit(f.scope.id);
        const first = await pool.connect(), second = await pool.connect();
        try {
          await first.query('BEGIN'); await second.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          if (settlementFirst) await rawPayable(first, unit);
          else await insertRawDistinct(first, f.scope.id);
          const pending = (settlementFirst ? insertRawDistinct(second, f.scope.id) : rawPayable(second, unit))
            .then(() => null, (error: Error) => error);
          await waitForLock(secondPid, firstPid);
          await first.query('COMMIT');
          const error = await pending;
          assert.ok(error);
          if ((error as Error & { code?: string }).code !== '40001') {
            assert.match(error.message, settlementFirst
              ? /cannot replace existing settlement history/ : /Distinct BM settlement is not supported/);
          }
          await second.query('ROLLBACK');
          assert.equal((await q('SELECT count(*)::int AS n FROM handyman_settlement_events WHERE unit_id=$1', [unit])).rows[0].n,
            settlementFirst ? 1 : 0);
          assert.equal(await count(f.scope.id), settlementFirst ? 0 : 1);
        } finally {
          await first.query('ROLLBACK').catch(() => undefined);
          await second.query('ROLLBACK').catch(() => undefined);
          first.release(); second.release();
        }
      }
    }
  });

  it('rejects fiscal links that race an uncommitted distinct entitlement', async () => {
    const other = await fixture();
    const draft = await prepareHandymanCommercialAgreement(actor, { clientId: other.realm.client.id, idempotencyKey: id() });
    const profile = id();
    await q(`INSERT INTO handyman_financial_tax_profiles
      (id,agreement_version_id,facts,created_by_user_id) VALUES($1,$2,'{}'::jsonb,$3)`,
    [profile,draft.version.id,actor]);
    for (const isolation of ['READ COMMITTED', 'REPEATABLE READ'] as const) {
      for (const table of ['basis', 'document'] as const) {
        const f = await fixture({ distinctBeneficiary: true, beneficiary: false });
        const first = await pool.connect(), second = await pool.connect();
        try {
          await first.query('BEGIN'); await second.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await insertRawDistinct(first, f.scope.id);
          const fact = (await first.query('SELECT id FROM handyman_entitlement_facts WHERE execution_scope_id=$1',
            [f.scope.id])).rows[0].id;
          const command = table === 'basis'
            ? second.query(`INSERT INTO handyman_bm_fee_fiscal_bases
                (entitlement_id,tenant_profile_id,bm_profile_id,basis_ex_vat) VALUES($1,$2,$2,1)`, [fact,profile])
            : second.query(`INSERT INTO handyman_fiscal_documents
                (id,execution_scope_id,profile_id,side,document_kind,entitlement_id,tax_point_at,document_date,
                 external_reference,issuer_reference,payer_reference,amounts,recorded_by_user_id,idempotency_key)
                VALUES($1,$2,$3,'BM','BM_FEE',$4,NOW(),CURRENT_DATE,$5,$6,$7,'{}'::jsonb,$8,$9)`,
              [id(),f.scope.id,profile,fact,id(),id(),id(),actor,id()]);
          const pending = command.then(() => null, (error: Error) => error);
          await waitForLock(secondPid, firstPid);
          await first.query('COMMIT');
          const error = await pending;
          assert.ok(error);
          if ((error as Error & { code?: string }).code !== '40001') {
            assert.match(error.message, /Distinct BM fiscal binding is not supported/);
          }
          await second.query('ROLLBACK');
          const actualTable = table === 'basis' ? 'handyman_bm_fee_fiscal_bases' : 'handyman_fiscal_documents';
          assert.equal((await q(`SELECT count(*)::int AS n FROM ${actualTable} WHERE entitlement_id=$1`, [fact])).rows[0].n, 0);
        } finally {
          await first.query('ROLLBACK').catch(() => undefined);
          await second.query('ROLLBACK').catch(() => undefined);
          first.release(); second.release();
        }
      }
    }
  });

  it('refuses a destructive 0494 downgrade after distinct facts exist', async () => {
    await assert.rejects(migrateDown(pool), /Refusing to remove populated distinct BM entitlement history/);
    assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id='0494_handyman_distinct_bm_entitlements'")).rows[0].n, 1);
  });
});
