import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
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

/** PART 01 only: raw SQL tests of the fact store, NOT a derivation writer. */
const DIR = '/tmp/hm14-part01-pg';
const PORT = 55491;
Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'error', DB_NAME: 'asentra_test',
  DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
  DB_PASSWORD: 'postgres', DB_SSL: 'false',
});
let pg: EmbeddedPostgres;
let pool: Pool;
let actor: string;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const id = () => randomUUID();

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
    user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise();
  await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query('CREATE DATABASE asentra_test');
  await admin.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase();
  assert.ok(config, 'embedded PostgreSQL must be available');
  pool = await initDatabase(config);
  await migrateUp(pool);
  actor = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: actor, disciplineId: discipline.id, query: q });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

async function fixture() {
  const { realm, scope } = await baseFixture();
  const crew = await crewFixture(realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: scope.id, providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, actor);
  const txId = id();
  await q(`INSERT INTO handyman_customer_transactions
     (id, client_id, execution_scope_id, quotation_version_id, currency, created_by_user_id)
     SELECT $1, client_id, id, approved_quotation_version_id, 'IDR', $2
       FROM handyman_execution_scopes WHERE id = $3`, [txId, actor, scope.id]);
  const tx = (await q('SELECT created_at FROM handyman_customer_transactions WHERE id=$1',
    [txId])).rows[0];
  return { realm, scope, crew, assignment, txId, postedAt: tx.created_at };
}

function providerFact(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    id: id(), client: f.realm.client.id, tx: f.txId, scope: f.scope.id,
    posted: f.postedAt, key: id(), assignment: f.assignment.id,
    provider: f.crew.providerContext.id, crew: f.crew.crew.id,
    lead: f.crew.workerContext.id, leadUser: f.crew.leadUser.id,
  };
}

async function insertProvider(f: ReturnType<typeof providerFact>,
  over: Partial<typeof f> & { kind?: string; state?: string; basis?: string;
    currency?: string; contract?: string; amount?: string; net?: string } = {}) {
  const x = { ...f, ...over };
  return q(`INSERT INTO handyman_entitlement_facts
    (id, client_id, transaction_id, execution_scope_id, currency,
     ledger_posted_at, ledger_contract_version, entitlement_kind, fact_state,
     basis_kind, charged_net, labor_net, material_net, adjusted_transaction_scope,
     amount, assignment_id, provider_context_id, crew_id, lead_worker_id,
     lead_user_id, idempotency_key, derived_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20,$21,$22) RETURNING id`,
  [x.id, x.client, x.tx, x.scope, over.currency ?? 'IDR', x.posted,
    over.contract ?? 'CR-HM-13-PART-06', over.kind ?? 'PROVIDER',
    over.state ?? 'EARNED', over.basis ?? 'TRANSACTION_NET_CHARGED',
    over.net ?? '100.00', '80.00', '20.00', '0.00', over.amount ?? '70.00',
    x.assignment, x.provider, x.crew, x.lead, x.leadUser, x.key, actor]);
}

describe('CR-HM-14 PART 01 entitlement fact foundation', () => {
  it('has only an EARNED fact, single-use key and one claim per transaction/kind; append-only', async () => {
    const f = await fixture();
    const fact = providerFact(f);
    await insertProvider(fact);
    const same = (await q('SELECT id FROM handyman_entitlement_facts WHERE idempotency_key=$1',
      [fact.key])).rows[0];
    assert.equal(same.id, fact.id); // Future replay returns this row, never inserts again.
    await assert.rejects(insertProvider({ ...fact, id: id() }), /unique/i);
    await assert.rejects(insertProvider({ ...fact, id: id(), key: id() }), /unique/i);
    const second = providerFact(await fixture());
    await assert.rejects(insertProvider({ ...second, key: fact.key }), /unique/i);
    await assert.rejects(q('UPDATE handyman_entitlement_facts SET amount=1 WHERE id=$1',
      [fact.id]), /append-only/);
    await assert.rejects(q('DELETE FROM handyman_entitlement_facts WHERE id=$1',
      [fact.id]), /append-only/);
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_entitlement_facts WHERE transaction_id=$1',
      [f.txId])).rows[0].n, 1);
  });

  it('rejects invalid kind/state/basis, money, currency and crossed ledger/provider anchors', async () => {
    const f = await fixture();
    const fact = providerFact(f);
    for (const over of [
      { kind: 'OTHER' }, { state: 'PAYABLE' }, { basis: 'MATERIAL' },
      { amount: '-1.00' }, { amount: '101.00' }, { currency: 'USD' },
      { contract: 'CR-HM-13-PART-05' }, { scope: id() },
      { provider: id() }, { posted: new Date(0) }, { key: '   ' },
    ]) {
      await assert.rejects(insertProvider(fact, over), undefined,
        JSON.stringify(over));
    }
    await insertProvider(fact);
  });

  it('requires exact CR-HM-12 PART 06 rule/term/beneficiary anchors (DEFAULT only)', async () => {
    const f = await fixture();
    const draft = await prepareHandymanCommercialAgreement(actor, {
      clientId: f.realm.client.id, idempotencyKey: id(),
    });
    const versionId = draft.version.id;
    const rule = id(), term = id(), beneficiary = id();
    await q(`INSERT INTO handyman_bm_fee_rule_definitions
      (id, agreement_version_id, basis, mode, idempotency_key, created_by_user_id)
      VALUES ($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`, [rule, versionId, id(), actor]);
    await q(`INSERT INTO handyman_bm_fee_term_definitions
      (id, agreement_version_id, term_kind, rate_percent, idempotency_key, created_by_user_id)
      VALUES ($1,$2,'PERCENTAGE_OF_BASIS',2.5000,$3,$4)`, [term, versionId, id(), actor]);
    await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions
      (id, agreement_version_id, beneficiary_kind, beneficiary_reference_id,
       idempotency_key, created_by_user_id)
      VALUES ($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
    [beneficiary, versionId, f.realm.client.id, id(), actor]);
    await activateHandymanCommercialAgreementVersion(actor, {
      versionId, effectiveFrom: new Date(f.postedAt.getTime() - 60_000).toISOString(),
      idempotencyKey: id(),
    });
    const v = (await q(`SELECT v.agreement_id, v.version_number, v.effective_from, v.effective_to
      FROM handyman_commercial_agreement_versions v WHERE v.id=$1`, [versionId])).rows[0];
    const bm = { id: id(), key: id(), rule, term, beneficiary, rate: '2.5000',
      client: f.realm.client.id, agreement: v.agreement_id, version: versionId,
      number: v.version_number, from: v.effective_from, to: v.effective_to };
    const insertBm = (over: Partial<typeof bm> = {}, target = f) => {
      const x = { ...bm, ...over };
      return q(`INSERT INTO handyman_entitlement_facts
        (id, client_id, transaction_id, execution_scope_id, currency,
         ledger_posted_at, ledger_contract_version, entitlement_kind, fact_state,
         basis_kind, charged_net, labor_net, material_net, adjusted_transaction_scope,
         amount, agreement_id, agreement_version_id, agreement_version_number,
         agreement_effective_from, agreement_effective_to, bm_rule_id, bm_term_id,
         bm_term_rate_percent, bm_beneficiary_id, bm_beneficiary_reference_id,
         idempotency_key, derived_by_user_id)
         VALUES ($1,$2,$3,$4,'IDR',$5,'CR-HM-13-PART-06','BM_FEE','EARNED',
                 'LABOR_ONLY',100,80,20,0,2,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [x.id, x.client, target.txId, target.scope.id, target.postedAt, x.agreement, x.version,
        x.number, x.from, x.to, x.rule, x.term, x.rate, x.beneficiary,
        x.client, x.key, actor]);
    };
    await assert.rejects(insertBm({ rate: '3.0000' }), /binding mismatch/);
    await assert.rejects(insertBm({ beneficiary: id() }), /binding mismatch/);
    await assert.rejects(insertBm({ rule: id() }), /binding mismatch/);
    await assert.rejects(insertBm({ agreement: id() }), /binding mismatch/);
    await assert.rejects(insertBm({ number: 99 }), /binding mismatch/);
    await assert.rejects(insertBm({ id: id(), key: id(), rate: '2.5000',
      client: id() }), undefined);
    await insertBm();
    await assert.rejects(insertBm({ id: id(), key: id() }), /unique/i);
    await insertProvider(providerFact(f)); // Both closed kinds may coexist.

    // A fully configured but REFERENCE-only CR-HM-12 version is not
    // authoritative even though all three prerequisite rows exist.
    const other = await fixture();
    const refDraft = await prepareHandymanCommercialAgreement(actor, {
      clientId: other.realm.client.id, idempotencyKey: id(),
    });
    const refVersion = refDraft.version.id;
    const refRule = id(), refTerm = id(), refBeneficiary = id();
    await q(`INSERT INTO handyman_bm_fee_rule_definitions
      (id, agreement_version_id, basis, mode, idempotency_key, created_by_user_id)
      VALUES ($1,$2,'LABOR_ONLY','REFERENCE',$3,$4)`, [refRule, refVersion, id(), actor]);
    await q(`INSERT INTO handyman_bm_fee_term_definitions
      (id, agreement_version_id, term_kind, rate_percent, idempotency_key, created_by_user_id)
      VALUES ($1,$2,'PERCENTAGE_OF_BASIS',2.5000,$3,$4)`,
    [refTerm, refVersion, id(), actor]);
    await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions
      (id, agreement_version_id, beneficiary_kind, beneficiary_reference_id,
       idempotency_key, created_by_user_id)
      VALUES ($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
    [refBeneficiary, refVersion, other.realm.client.id, id(), actor]);
    await activateHandymanCommercialAgreementVersion(actor, {
      versionId: refVersion,
      effectiveFrom: new Date(other.postedAt.getTime() - 60_000).toISOString(),
      idempotencyKey: id(),
    });
    const rv = (await q(`SELECT agreement_id, version_number, effective_from, effective_to
      FROM handyman_commercial_agreement_versions WHERE id=$1`, [refVersion])).rows[0];
    await assert.rejects(insertBm({ id: id(), key: id(), rule: refRule,
      term: refTerm, beneficiary: refBeneficiary,
      client: other.realm.client.id, agreement: rv.agreement_id,
      version: refVersion, number: rv.version_number,
      from: rv.effective_from, to: rv.effective_to }, other), /binding mismatch/);
  });
});
