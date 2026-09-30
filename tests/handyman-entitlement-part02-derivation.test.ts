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
import { adjustHandymanCustomerLedger }
  from '../src/modules/handyman-customer-ledger-corrections';
import { recordHandymanCustomerPayment }
  from '../src/modules/handyman-customer-payments';
import { deriveHandymanFinancialEntitlements }
  from '../src/modules/handyman-financial-entitlements';

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
  term?: boolean; beneficiary?: boolean; charge?: boolean; rate?: string };
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
  return { realm, scope, crew, assignment, opened, chargeId };
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
