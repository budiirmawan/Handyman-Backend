import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, migrations } from '../src/database';
import { createAdminUser } from './helpers/access';
import {
  activateHandymanCommercialAgreementVersion, prepareHandymanCommercialAgreement,
  supersedeHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import {
  prepareHandymanBmFeeBeneficiary, prepareHandymanBmFeeRule, prepareHandymanBmFeeTerm,
} from '../src/modules/handyman-bm-fee-rules';
import {
  bindHandymanBmBuildingCoverage, cancelHandymanBmBuildingCoverage,
  closeHandymanBmBuildingCoverage, registerHandymanBmLegalCounterparty,
  resolveHandymanBmBuildingCoverageAt, verifyHandymanBmLegalCounterparty,
} from '../src/modules/handyman-bm-binding';

const DIR = '/tmp/hm-bm-binding-pg', PORT = 55519;
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error', DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT), DB_USER: 'postgres', DB_PASSWORD: 'postgres',
  DB_NAME: 'asentra_test', DB_SSL: 'false' });
let pg: EmbeddedPostgres;
let pool: Pool;
let actor: string;
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const iso = (ms: number) => new Date(ms).toISOString();
const code = (expected: string) => (e: { code?: string }) => { assert.equal(e.code, expected); return true; };

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres',
    password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise(); await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect(); await admin.query('CREATE DATABASE asentra_test'); await admin.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase(); assert.ok(config);
  pool = await initDatabase(config); await migrateUp(pool);
  actor = (await createAdminUser()).userId;
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); }
});

async function fixture() {
  const clientId = id(), propertyId = id(), buildings = [id(), id(), id(), id()];
  await q('INSERT INTO clients (id,code,name) VALUES ($1,$2,$3)', [clientId, id(), 'Client']);
  await q('INSERT INTO properties (id,client_id,code,name) VALUES ($1,$2,$3,$4)', [propertyId, clientId, id(), 'Property']);
  for (const buildingId of buildings) await q('INSERT INTO buildings (id,property_id,code,name) VALUES ($1,$2,$3,$4)',
    [buildingId, propertyId, id(), 'Building']);
  const draft = await prepareHandymanCommercialAgreement(actor, { clientId, idempotencyKey: id() });
  const configured = await configure(draft.version.id, clientId);
  await activateHandymanCommercialAgreementVersion(actor, { versionId: draft.version.id,
    effectiveFrom: iso(Date.now() - 60_000), idempotencyKey: id() });
  return { clientId, buildings, agreementId: draft.agreement.id, versionId: draft.version.id, ...configured };
}
async function configure(versionId: string, clientId: string) {
  const rule = await prepareHandymanBmFeeRule(actor, { agreementVersionId: versionId,
    basis: 'LABOR_ONLY', mode: 'DEFAULT', idempotencyKey: id() });
  const term = await prepareHandymanBmFeeTerm(actor, { agreementVersionId: versionId,
    termKind: 'PERCENTAGE_OF_BASIS', ratePercent: '2.5', idempotencyKey: id() });
  const beneficiary = await prepareHandymanBmFeeBeneficiary(actor, { agreementVersionId: versionId,
    beneficiaryKind: 'CLIENT_ORGANIZATION', beneficiaryReferenceId: clientId, idempotencyKey: id() });
  return { rule: rule.rule, term: term.term, beneficiary: beneficiary.beneficiary };
}
async function legalParty(clientId: string, representsClientOrganization = false) {
  const input = { clientId, legalName: 'PT Verified Management', registrationNumber: id(),
    representsClientOrganization, idempotencyKey: id() };
  const registered = await registerHandymanBmLegalCounterparty(actor, input);
  const proof = await verifyHandymanBmLegalCounterparty(actor, { clientId,
    counterpartyId: registered.counterparty.id, evidenceReference: `evidence/${id()}` });
  return { ...registered, ...proof, input };
}
function binding(f: Awaited<ReturnType<typeof fixture>>, buildingId: string,
  counterpartyId: string, effectiveFrom: string, effectiveTo: string | null = null) {
  return { clientId: f.clientId, buildingId, agreementVersionId: f.versionId,
    counterpartyId, beneficiaryKind: 'BM_LEGAL_COUNTERPARTY' as const,
    effectiveFrom, effectiveTo, idempotencyKey: id() };
}

describe('CR-HM-BM-COMMISSION-01 PART 01B beneficiary and Building binding', () => {
  it('keeps 0490–0492 and legacy beneficiary rows unchanged; identity must be explicitly verified', async () => {
    assert.deepEqual(migrations.slice(-9).map(m => m.id), [
      '0490_create_handyman_document_issuer_profiles', '0491_create_handyman_document_issuer_bank_accounts',
      '0492_create_handyman_document_issuer_settings', '0493_handyman_bm_beneficiary_building_coverage',
      '0494_handyman_distinct_bm_entitlements', '0495_handyman_tax_identity_profiles',
      '0496_handyman_tax_identity_approval', '0497_handyman_tax_rule_governance', '0498_handyman_request_buyer_bindings',
    ]);
    const f = await fixture();
    const input = { clientId: f.clientId, legalName: 'PT Pending', registrationNumber: id(),
      representsClientOrganization: false, idempotencyKey: id() };
    const pending = await registerHandymanBmLegalCounterparty(actor, input);
    for (const bad of ['2026-02-30T00:00:00Z', '2026-01-01T00:00:00', 'not-a-date']) {
      await assert.rejects(resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[0], bad),
        code('HANDYMAN_BM_BINDING_INVALID'));
    }
    assert.equal((await registerHandymanBmLegalCounterparty(actor, input)).replayed, true);
    await assert.rejects(registerHandymanBmLegalCounterparty(actor, { ...input, legalName: 'Different' }),
      code('HANDYMAN_BM_BINDING_CONFLICT'));
    await assert.rejects(bindHandymanBmBuildingCoverage(actor, binding(f, f.buildings[0], pending.counterparty.id, iso(Date.now() + 1000))),
      code('HANDYMAN_BM_BINDING_UNVERIFIED'));
    await assert.rejects(q(`INSERT INTO handyman_bm_building_coverages
      (id,client_id,building_id,agreement_version_id,counterparty_id,verification_id,
       beneficiary_kind,effective_from,idempotency_key,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,'BM_LEGAL_COUNTERPARTY',$7,$8,$9)`,
    [id(), f.clientId, f.buildings[0], f.versionId, pending.counterparty.id, id(), iso(Date.now() + 1000), id(), actor]),
    /verified counterparty/);
    const proofInput = { clientId: f.clientId, counterpartyId: pending.counterparty.id, evidenceReference: 'evidence/reviewed-registration' };
    const proof = await verifyHandymanBmLegalCounterparty(actor, proofInput);
    assert.equal((await verifyHandymanBmLegalCounterparty(actor, proofInput)).replayed, true);
    await assert.rejects(verifyHandymanBmLegalCounterparty(actor, { ...proofInput, evidenceReference: 'different' }),
      code('HANDYMAN_BM_BINDING_CONFLICT'));
    await assert.rejects(bindHandymanBmBuildingCoverage(actor,
      binding(f, f.buildings[0], pending.counterparty.id, iso(proof.verification.verifiedAt.getTime() - 1))),
      code('HANDYMAN_BM_BINDING_UNVERIFIED'));
    await assert.rejects(q('UPDATE handyman_bm_legal_counterparties SET legal_name=$2 WHERE id=$1', [pending.counterparty.id, 'Rewritten']), /immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_counterparty_verifications WHERE id=$1', [proof.verification.id]), /immutable/);
    const fresh = await registerHandymanBmLegalCounterparty(actor, { ...input,
      legalName: 'Another legal party', registrationNumber: id(), idempotencyKey: id() });
    const stamped = await q(`INSERT INTO handyman_bm_counterparty_verifications
      (id,counterparty_id,evidence_reference,verified_by_user_id,verified_at)
      VALUES ($1,$2,'test/evidence',$3,'2000-01-01T00:00:00Z') RETURNING verified_at`,
    [id(), fresh.counterparty.id, actor]);
    assert.ok(stamped.rows[0].verified_at.getTime() > Date.now() - 10_000);
    const legacy = (await q('SELECT beneficiary_kind,beneficiary_reference_id FROM handyman_bm_fee_beneficiary_definitions WHERE id=$1', [f.beneficiary.id])).rows[0];
    assert.deepEqual(legacy, { beneficiary_kind: 'CLIENT_ORGANIZATION', beneficiary_reference_id: f.clientId });
  });

  it('resolves separate verified BMs for explicit Buildings and exact versions, with half-open boundaries and no fallback', async () => {
    const f = await fixture(), a = await legalParty(f.clientId), b = await legalParty(f.clientId);
    const start = Date.now() + 60_000, middle = start + 60_000, end = middle + 60_000;
    const firstInput = binding(f, f.buildings[0], a.counterparty.id, iso(start), iso(middle));
    const first = await bindHandymanBmBuildingCoverage(actor, firstInput);
    assert.equal((await bindHandymanBmBuildingCoverage(actor, firstInput)).replayed, true);
    await bindHandymanBmBuildingCoverage(actor, binding(f, f.buildings[0], b.counterparty.id, iso(middle), iso(end)));
    await bindHandymanBmBuildingCoverage(actor, binding(f, f.buildings[1], b.counterparty.id, iso(start), iso(end)));
    const old = await resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[0], iso(start));
    const next = await resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[0], iso(middle));
    assert.equal(old.counterpartyId, a.counterparty.id);
    assert.equal(next.counterpartyId, b.counterparty.id);
    assert.equal(old.beneficiaryKind, 'BM_LEGAL_COUNTERPARTY');
    assert.equal(old.beneficiaryDefinitionId, null);
    assert.equal(old.agreementId, f.agreementId);
    assert.equal(old.agreementVersionId, f.versionId);
    assert.equal(old.ruleId, f.rule.id); assert.equal(old.termId, f.term.id);
    assert.equal(old.id, first.coverage.id);
    assert.equal((await resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[1], iso(start))).counterpartyId, b.counterparty.id);
    for (const [building, at] of [[f.buildings[0], iso(start - 1)], [f.buildings[0], iso(end)], [f.buildings[2], iso(start)]]) {
      await assert.rejects(resolveHandymanBmBuildingCoverageAt(f.clientId, building, at), code('HANDYMAN_BM_BINDING_NOT_EFFECTIVE'));
    }
    await assert.rejects(bindHandymanBmBuildingCoverage(actor,
      binding(f, f.buildings[0], b.counterparty.id, iso(start + 1), iso(middle + 1))), code('HANDYMAN_BM_BINDING_CONFLICT'));
    await assert.rejects(q('UPDATE handyman_bm_building_coverages SET counterparty_id=$2 WHERE id=$1', [first.coverage.id, b.counterparty.id]), /immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_building_coverages WHERE id=$1', [first.coverage.id]), /history-preserving/);
  });

  it('rejects crossed Client, Building, beneficiary/version and unconfigured agreement, including raw SQL', async () => {
    const f = await fixture(), other = await fixture();
    const legal = await legalParty(f.clientId), clientParty = await legalParty(f.clientId, true);
    const start = iso(Date.now() + 60_000);
    await assert.rejects(bindHandymanBmBuildingCoverage(actor,
      binding(f, other.buildings[0], legal.counterparty.id, start)), code('HANDYMAN_BM_BINDING_CONFLICT'));
    await assert.rejects(resolveHandymanBmBuildingCoverageAt(other.clientId, f.buildings[0], start), code('HANDYMAN_BM_BINDING_NOT_EFFECTIVE'));
    await assert.rejects(bindHandymanBmBuildingCoverage(actor, {
      ...binding(f, f.buildings[0], legal.counterparty.id, start), beneficiaryKind: 'CLIENT_ORGANIZATION',
      beneficiaryDefinitionId: f.beneficiary.id,
    }), code('HANDYMAN_BM_BINDING_CONFLICT'));
    await assert.rejects(bindHandymanBmBuildingCoverage(actor, {
      ...binding(f, f.buildings[0], clientParty.counterparty.id, start), beneficiaryKind: 'CLIENT_ORGANIZATION',
      beneficiaryDefinitionId: other.beneficiary.id,
    }), code('HANDYMAN_BM_BINDING_CONFLICT'));
    const legacy = await bindHandymanBmBuildingCoverage(actor, {
      ...binding(f, f.buildings[0], clientParty.counterparty.id, start), beneficiaryKind: 'CLIENT_ORGANIZATION',
      beneficiaryDefinitionId: f.beneficiary.id,
    });
    const resolved = await resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[0], start);
    assert.equal(resolved.id, legacy.coverage.id); assert.equal(resolved.representedClientId, f.clientId);
    assert.equal(resolved.beneficiaryDefinitionId, f.beneficiary.id);
    await assert.rejects(q(`INSERT INTO handyman_bm_building_coverages
      (id,client_id,building_id,agreement_version_id,counterparty_id,verification_id,
       beneficiary_kind,effective_from,idempotency_key,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,'BM_LEGAL_COUNTERPARTY',$7,$8,$9)`,
    [id(), f.clientId, other.buildings[1], f.versionId, legal.counterparty.id, legal.verification.id, start, id(), actor]), /exact Client, Building/);
    const draft = await prepareHandymanCommercialAgreement(actor, { clientId: f.clientId, idempotencyKey: id() });
    await assert.rejects(bindHandymanBmBuildingCoverage(actor,
      { ...binding(f, f.buildings[1], legal.counterparty.id, start), agreementVersionId: draft.version.id }),
    code('HANDYMAN_BM_BINDING_CONFLICT'));
  });

  it('serializes overlapping concurrent assignments and rejects both service and SQL conflicts', async () => {
    const f = await fixture(), a = await legalParty(f.clientId), b = await legalParty(f.clientId);
    const start = iso(Date.now() + 60_000);
    const retryInput = binding(f, f.buildings[1], a.counterparty.id, start);
    const retries = await Promise.all([
      bindHandymanBmBuildingCoverage(actor, retryInput),
      bindHandymanBmBuildingCoverage(actor, retryInput),
    ]);
    assert.equal(retries[0].coverage.id, retries[1].coverage.id);
    assert.deepEqual(retries.map(x => x.replayed).sort(), [false, true]);
    const inputs = [binding(f, f.buildings[0], a.counterparty.id, start),
      binding(f, f.buildings[0], b.counterparty.id, start)];
    const results = await Promise.allSettled(inputs.map(x => bindHandymanBmBuildingCoverage(actor, x)));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    const failure = results.find(x => x.status === 'rejected');
    assert.equal((failure as PromiseRejectedResult).reason.code, 'HANDYMAN_BM_BINDING_CONFLICT');
    await assert.rejects(q(`INSERT INTO handyman_bm_building_coverages
      (id,client_id,building_id,agreement_version_id,counterparty_id,verification_id,
       beneficiary_kind,effective_from,idempotency_key,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,'BM_LEGAL_COUNTERPARTY',$7,$8,$9)`,
    [id(), f.clientId, f.buildings[0], f.versionId, a.counterparty.id, a.verification.id, start, id(), actor]),
    (err: { code: string }) => err.code === '23P01');
  });

  it('requires prospective closure before version supersession; preserves history and supports future cancellation', async () => {
    const f = await fixture(), a = await legalParty(f.clientId), b = await legalParty(f.clientId);
    const start = a.verification.verifiedAt.toISOString(), boundary = iso(Date.now() + 120_000);
    const activeInput = binding(f, f.buildings[0], a.counterparty.id, start);
    const first = await bindHandymanBmBuildingCoverage(actor, activeInput);
    const draft = await prepareHandymanCommercialAgreement(actor, { clientId: f.clientId, idempotencyKey: id() });
    const nextConfig = await configure(draft.version.id, f.clientId);
    const supersede = { versionId: f.versionId, replacementVersionId: draft.version.id,
      effectiveFrom: boundary, idempotencyKey: id() };
    await assert.rejects(supersedeHandymanCommercialAgreementVersion(actor, supersede),
      code('HANDYMAN_BM_BINDING_CONFLICT'));
    await assert.rejects(closeHandymanBmBuildingCoverage(actor, { clientId: f.clientId,
      coverageId: first.coverage.id, effectiveTo: iso(Date.now() - 1000), reason: 'no retroactive rewrite' }),
    code('HANDYMAN_BM_BINDING_CONFLICT'));
    const close = { clientId: f.clientId, coverageId: first.coverage.id, effectiveTo: boundary, reason: 'Version superseded' };
    await closeHandymanBmBuildingCoverage(actor, close);
    assert.equal((await closeHandymanBmBuildingCoverage(actor, close)).replayed, true);
    assert.equal((await bindHandymanBmBuildingCoverage(actor, activeInput)).replayed, true);
    await supersedeHandymanCommercialAgreementVersion(actor, supersede);
    const second = await bindHandymanBmBuildingCoverage(actor, { ...binding(f, f.buildings[0], b.counterparty.id, boundary),
      agreementVersionId: draft.version.id });
    const earlier = await resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[0], iso(new Date(boundary).getTime() - 1));
    const later = await resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[0], boundary);
    assert.equal(earlier.counterpartyId, a.counterparty.id); assert.equal(earlier.agreementVersionId, f.versionId);
    assert.equal(later.counterpartyId, b.counterparty.id); assert.equal(later.agreementVersionId, draft.version.id);
    assert.equal(later.ruleId, nextConfig.rule.id); assert.equal(later.termId, nextConfig.term.id);
    assert.equal(later.id, second.coverage.id);
    const future = await bindHandymanBmBuildingCoverage(actor, { ...binding(f, f.buildings[1], b.counterparty.id, boundary),
      agreementVersionId: draft.version.id });
    const cancel = { clientId: f.clientId, coverageId: future.coverage.id, reason: 'Not contracted' };
    await cancelHandymanBmBuildingCoverage(actor, cancel);
    assert.equal((await cancelHandymanBmBuildingCoverage(actor, cancel)).replayed, true);
    await assert.rejects(resolveHandymanBmBuildingCoverageAt(f.clientId, f.buildings[1], boundary), code('HANDYMAN_BM_BINDING_NOT_EFFECTIVE'));
    await bindHandymanBmBuildingCoverage(actor, { ...binding(f, f.buildings[1], b.counterparty.id, boundary), agreementVersionId: draft.version.id });
  });

  it('refuses a destructive downgrade when legal identity or coverage history exists', async () => {
    assert.equal(await migrateDown(pool), '0498_handyman_request_buyer_bindings');
    assert.equal(await migrateDown(pool), '0497_handyman_tax_rule_governance');
    assert.equal(await migrateDown(pool), '0496_handyman_tax_identity_approval');
    assert.equal(await migrateDown(pool), '0495_handyman_tax_identity_profiles');
    assert.equal(await migrateDown(pool), '0494_handyman_distinct_bm_entitlements');
    await assert.rejects(migrateDown(pool), /Refusing to remove populated BM legal identity\/coverage history/);
    assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id='0493_handyman_bm_beneficiary_building_coverage'")).rows[0].n, 1);
    assert.deepEqual(await migrateUp(pool), ['0494_handyman_distinct_bm_entitlements',
      '0495_handyman_tax_identity_profiles', '0496_handyman_tax_identity_approval', '0497_handyman_tax_rule_governance', '0498_handyman_request_buyer_bindings']);
  });
});
