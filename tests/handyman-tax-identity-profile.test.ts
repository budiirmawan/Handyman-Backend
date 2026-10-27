import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, migrations } from '../src/database';
import { stableJson } from '../src/shared/stable-json';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { registerHandymanBmLegalCounterparty, verifyHandymanBmLegalCounterparty } from '../src/modules/handyman-bm-binding';
import {
  captureHandymanTaxIdentity, closeHandymanTaxIdentity, listHandymanTaxIdentityHistory,
  requireApprovedHandymanTaxIdentityAt, resolveHandymanTaxIdentityAt, type CaptureHandymanTaxIdentityInput, type HandymanTaxIdentityOwner,
} from '../src/modules/handyman-tax-identity';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/hm-tax-identity-pg', PORT = 55531;
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error', DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT), DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
let pg: EmbeddedPostgres;
let pool: Pool;
let actor: string;
const id = () => randomUUID();
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values);
const iso = (ms: number) => new Date(ms).toISOString();
const code = (expected: string) => (err: { code?: string }) => { assert.equal(err.code, expected); return true; };

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '',
    persistent: true, authMethod: 'trust' });
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

const issuerContent = (clientId: string, legalName: string, expectedVersion: number | null) => ({
  clientId, expectedVersion, legalName, displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1',
  businessAddress: null, city: 'Jakarta', province: 'Jakarta', postalCode: '10110',
  email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
  website: null, taxId: null, businessRegistrationId: null, logoReference: null,
});
async function fixture() {
  const clientId = id(), propertyId = id(), buildingId = id();
  const legalName = `PT Provider ${id().slice(0, 8)}`;
  await q('INSERT INTO clients (id,code,name) VALUES ($1,$2,$3)', [clientId, id(), legalName]);
  await q('INSERT INTO properties (id,client_id,code,name) VALUES ($1,$2,$3,$4)', [propertyId, clientId, id(), 'Property']);
  await q('INSERT INTO buildings (id,property_id,code,name) VALUES ($1,$2,$3,$4)', [buildingId, propertyId, id(), 'Building']);
  await buildingAssignmentService.createAssignment(actor, { buildingId });
  const issuer = await updateHandymanDocumentIssuerProfile(issuerContent(clientId, legalName, null), actor);
  return { clientId, buildingId, legalName, issuer, owner: { kind: 'HANDYMAN_ISSUER', clientId } as const };
}
async function party(clientId: string, verified = true) {
  const legalName = `PT BM ${id().slice(0, 8)}`;
  const registered = await registerHandymanBmLegalCounterparty(actor, { clientId, legalName,
    registrationNumber: id(), representsClientOrganization: false, idempotencyKey: id() });
  const proof = verified ? await verifyHandymanBmLegalCounterparty(actor, { clientId,
    counterpartyId: registered.counterparty.id, evidenceReference: `registration/${id()}` }) : null;
  const owner: HandymanTaxIdentityOwner = { kind: 'BM_BENEFICIARY', clientId, counterpartyId: registered.counterparty.id };
  return { owner, legalName, counterparty: registered.counterparty, verification: proof?.verification ?? null };
}
function inputFor(target: { owner: HandymanTaxIdentityOwner; legalName: string; verification?: { verifiedAt: Date } | null },
  overrides: Partial<CaptureHandymanTaxIdentityInput> = {}): CaptureHandymanTaxIdentityInput {
  return { owner: target.owner, legalName: target.legalName, taxpayerKind: 'LEGAL_ENTITY', individualResidency: null,
    identifier: { kind: 'NPWP_15', value: '01.234.567.8-901.000' }, pkpStatus: 'PKP',
    effectiveFrom: target.verification ? target.verification.verifiedAt.toISOString() : iso(Date.now() + 2000),
    effectiveTo: null, evidenceSource: 'FINANCE_CAPTURE', evidenceReference: `case/${id()}`,
    expectedVersion: null, idempotencyKey: id(), ...overrides };
}
async function scopedUser(buildingId: string, permissions: string[]) {
  const user = await userService.createUser({ email: `${id()}@tax-identity.test`, displayName: 'Scoped identity actor' });
  const role = await roleService.createRole({ code: `TAX_${id()}`, name: 'Scoped identity role' });
  for (const permission of permissions) {
    const record = await permissionRepository.findByCode(permission); assert.ok(record);
    await permissionService.assignPermissionToRole(role.id, record.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

async function rawBm(tx: Pick<PoolClient, 'query'>, target: Awaited<ReturnType<typeof party>>, options: {
  version?: number; from?: string; to?: string | null; clientId?: string; proofId?: string;
  kind?: string | null; value?: string | null; taxpayerKind?: string; residency?: string | null; pkp?: string; approval?: string;
} = {}) {
  assert.ok(target.verification);
  const profileId = id();
  const result = await tx.query(`INSERT INTO handyman_tax_identity_profiles
    (id,client_id,owner_kind,owner_id,counterparty_id,verification_id,version,legal_name,
     taxpayer_kind,individual_residency,identifier_kind,identifier_value,pkp_status,approval_status,effective_from,declared_effective_to,
     evidence_source,evidence_reference,idempotency_key,created_by_user_id,created_at)
    VALUES($1,$2,'BM_BENEFICIARY',$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'TEST','case/raw',$15,$16,'2000-01-01')
    RETURNING *`, [profileId, options.clientId ?? target.counterparty.clientId, target.counterparty.id,
    options.proofId ?? target.verification.id, options.version ?? 1, target.legalName,
    options.taxpayerKind ?? 'LEGAL_ENTITY', options.residency ?? null, options.kind === undefined ? 'NPWP_15' : options.kind,
    options.value === undefined ? '012345678901000' : options.value, options.pkp ?? 'PKP', options.approval ?? 'UNAPPROVED',
    options.from ?? target.verification.verifiedAt.toISOString(), options.to ?? null, id(), actor]);
  return result.rows[0];
}

async function waitForBlock(waiterPid: number, blockerPid: number) {
  for (let i = 0; i < 100; i++) {
    const row = (await q('SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked', [waiterPid, blockerPid])).rows[0];
    if (row.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected the concurrent identity writer to wait on the exact owner.');
}

describe('CR-HM-TAX-INDONESIA-01 PART 01A identity and PKP assertions', () => {
  it('registers additive 0495, reuses existing issuer and BM, and preserves their prior facts', async () => {
    assert.deepEqual(migrations.slice(-10).map(m => m.id), [
      '0490_create_handyman_document_issuer_profiles', '0491_create_handyman_document_issuer_bank_accounts',
      '0492_create_handyman_document_issuer_settings', '0493_handyman_bm_beneficiary_building_coverage',
      '0494_handyman_distinct_bm_entitlements', '0495_handyman_tax_identity_profiles',
      '0496_handyman_tax_identity_approval', '0497_handyman_tax_rule_governance', '0498_handyman_request_buyer_bindings', '0499_handyman_customer_tax_classifications',
    ]);
    const f = await fixture(), bm = await party(f.clientId);
    const issuerBefore = (await q('SELECT to_jsonb(x) AS row FROM handyman_document_issuer_profiles x WHERE id=$1', [f.issuer.id])).rows[0];
    const partyBefore = (await q('SELECT to_jsonb(x) AS row FROM handyman_bm_legal_counterparties x WHERE id=$1', [bm.counterparty.id])).rows[0];
    const issuerInput = inputFor(f, { issuerProfileId: f.issuer.id,
      effectiveFrom: iso(new Date(f.issuer.effectiveFrom).getTime() + 1) });
    const issuer = await captureHandymanTaxIdentity(actor, issuerInput);
    const beneficiary = await captureHandymanTaxIdentity(actor, inputFor(bm));
    assert.equal(issuer.identity.snapshot.ownerId, f.clientId);
    assert.equal(issuer.identity.snapshot.issuerProfileId, f.issuer.id);
    assert.equal(beneficiary.identity.snapshot.ownerId, bm.counterparty.id);
    assert.equal(beneficiary.identity.snapshot.verificationId, bm.verification!.id);
    assert.equal(beneficiary.identity.snapshot.identifierValue, '012345678901000');
    assert.deepEqual((await q('SELECT to_jsonb(x) AS row FROM handyman_document_issuer_profiles x WHERE id=$1', [f.issuer.id])).rows[0], issuerBefore);
    assert.deepEqual((await q('SELECT to_jsonb(x) AS row FROM handyman_bm_legal_counterparties x WHERE id=$1', [bm.counterparty.id])).rows[0], partyBefore);
    assert.equal((await captureHandymanTaxIdentity(actor, issuerInput)).replayed, true);
    await assert.rejects(captureHandymanTaxIdentity(actor, { ...issuerInput, pkpStatus: 'NON_PKP' }), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
  });

  it('validates distinct 15-digit, 16-digit and individual NIK types without claiming registration', async () => {
    const f = await fixture();
    const a = await party(f.clientId), b = await party(f.clientId), c = await party(f.clientId), d = await party(f.clientId);
    const nonresident = await party(f.clientId), unknownResidency = await party(f.clientId);
    const fifteen = await captureHandymanTaxIdentity(actor, inputFor(a));
    assert.equal(fifteen.identity.snapshot.identifierKind, 'NPWP_15');
    const sixteen = await captureHandymanTaxIdentity(actor, inputFor(b, {
      identifier: { kind: 'NPWP_16', value: '0123456789012345' }, pkpStatus: 'NON_PKP' }));
    assert.equal(sixteen.identity.snapshot.identifierValue, '0123456789012345');
    const nik = await captureHandymanTaxIdentity(actor, inputFor(c, { taxpayerKind: 'INDIVIDUAL', individualResidency: 'RESIDENT',
      identifier: { kind: 'NIK_NPWP_16', value: '3171000012345678' }, pkpStatus: 'NON_PKP' }));
    assert.equal(nik.identity.snapshot.identifierKind, 'NIK_NPWP_16');
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(actor, c.owner,
      nik.identity.snapshot.effectiveFrom), code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    const nonresidentResult = await captureHandymanTaxIdentity(actor, inputFor(nonresident, {
      taxpayerKind: 'INDIVIDUAL', individualResidency: 'NON_RESIDENT',
      identifier: { kind: 'NPWP_16', value: '0123456789012345' } }));
    assert.equal(nonresidentResult.identity.snapshot.individualResidency, 'NON_RESIDENT');
    const unknownResidencyResult = await captureHandymanTaxIdentity(actor, inputFor(unknownResidency, {
      taxpayerKind: 'INDIVIDUAL', individualResidency: 'UNKNOWN' }));
    assert.equal(unknownResidencyResult.identity.taxUse.reason, 'INDIVIDUAL_RESIDENCY_UNKNOWN');
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(actor, unknownResidency.owner,
      unknownResidencyResult.identity.snapshot.effectiveFrom), code('HANDYMAN_TAX_IDENTITY_UNKNOWN'));
    const unknown = await captureHandymanTaxIdentity(actor, inputFor(d, {
      taxpayerKind: 'UNKNOWN', identifier: null, pkpStatus: 'UNKNOWN' }));
    assert.equal(unknown.identity.taxUse.reason, 'TAXPAYER_KIND_UNKNOWN');
    for (const result of [fifteen, sixteen, nik, nonresidentResult, unknownResidencyResult, unknown]) {
      assert.equal(result.identity.snapshot.approvalStatus, 'UNAPPROVED');
      assert.equal(result.identity.taxUse.allowed, false);
    }

    const bad = await party(f.clientId);
    const base = inputFor(bad);
    const invalids = [
      { identifier: { kind: 'NIK_NPWP_16', value: '3171000012345678' } }, // entity cannot be NIK
      { taxpayerKind: 'INDIVIDUAL', individualResidency: 'NON_RESIDENT',
        identifier: { kind: 'NIK_NPWP_16', value: '3171000012345678' } },
      { taxpayerKind: 'INDIVIDUAL', individualResidency: 'RESIDENT',
        identifier: { kind: 'NPWP_16', value: '0123456789012345' } },
      { taxpayerKind: 'INDIVIDUAL', individualResidency: null },
      { taxpayerKind: 'LEGAL_ENTITY', individualResidency: 'RESIDENT' },
      { identifier: { kind: 'NPWP_15', value: '0123456789012345' } },
      { identifier: { kind: 'NPWP_16', value: '012345678901234X' } },
      { identifier: { kind: 'NPWP_16', value: '0000000000000000' } },
      { identifier: { kind: 'NPWP_15', value: '01/234/567/8/901/000' } },
      { identifier: null, pkpStatus: 'PKP' },
      { taxpayerKind: 'UNKNOWN', pkpStatus: 'PKP' },
      { pkpStatus: 'UNSPECIFIED' },
      { approvalStatus: 'APPROVED' },
      { evidenceReference: '' },
      { effectiveFrom: '2026-02-30T00:00:00Z' },
      { effectiveFrom: '2026-01-01T00:00:00' },
      { effectiveFrom: '2026-01-01T00:00:00.1234Z' },
    ];
    for (const patch of invalids) {
      await assert.rejects(captureHandymanTaxIdentity(actor, { ...base, ...patch } as CaptureHandymanTaxIdentityInput),
        code('HANDYMAN_TAX_IDENTITY_INVALID'));
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_profiles WHERE owner_id=$1', [bad.counterparty.id])).rows[0].n, 0);
    await assert.rejects(rawBm(pool, bad, { kind: null, value: '012345678901000' }), /hm_tax_profile_identifier_check/);
    await assert.rejects(rawBm(pool, bad, { kind: 'NIK_NPWP_16', value: '3171000012345678' }), /hm_tax_profile_identifier_check/);
    await assert.rejects(rawBm(pool, bad, { taxpayerKind: 'INDIVIDUAL', residency: 'NON_RESIDENT',
      kind: 'NIK_NPWP_16', value: '3171000012345678' }), /hm_tax_profile_identifier_check/);
    await assert.rejects(rawBm(pool, bad, { taxpayerKind: 'INDIVIDUAL', residency: 'RESIDENT',
      kind: 'NPWP_16', value: '0123456789012345' }), /hm_tax_profile_identifier_check/);
    await assert.rejects(rawBm(pool, bad, { taxpayerKind: 'INDIVIDUAL' }), /hm_tax_profile_classification_check/);
    await assert.rejects(rawBm(pool, bad, { approval: 'APPROVED' }), /approval_status_check/);
  });

  it('separates verified beneficiaries and clients with no fallback or forged anchors', async () => {
    const a = await fixture(), b = await fixture();
    const aa = await party(a.clientId), ab = await party(a.clientId), bb = await party(b.clientId);
    const pending = await party(a.clientId, false);
    await assert.rejects(captureHandymanTaxIdentity(actor, inputFor(pending)), code('HANDYMAN_TAX_IDENTITY_UNVERIFIED'));
    await assert.rejects(captureHandymanTaxIdentity(actor, inputFor(aa, {
      effectiveFrom: iso(aa.verification!.verifiedAt.getTime() - 1) })), code('HANDYMAN_TAX_IDENTITY_UNVERIFIED'));
    const aResult = await captureHandymanTaxIdentity(actor, inputFor(aa));
    const bResult = await captureHandymanTaxIdentity(actor, inputFor(ab));
    assert.notEqual(aResult.identity.snapshot.id, bResult.identity.snapshot.id);
    await assert.rejects(closeHandymanTaxIdentity(actor, { owner: ab.owner, profileId: aResult.identity.snapshot.id,
      effectiveTo: iso(Date.now() + 60_000), reason: 'Wrong beneficiary' }), code('HANDYMAN_TAX_IDENTITY_NOT_FOUND'));
    assert.equal((await resolveHandymanTaxIdentityAt(actor, aa.owner, aa.verification!.verifiedAt.toISOString())).snapshot.id,
      aResult.identity.snapshot.id);
    assert.equal((await resolveHandymanTaxIdentityAt(actor, ab.owner, ab.verification!.verifiedAt.toISOString())).snapshot.id,
      bResult.identity.snapshot.id);
    const forged: HandymanTaxIdentityOwner = { kind: 'BM_BENEFICIARY', clientId: a.clientId, counterpartyId: bb.counterparty.id };
    await assert.rejects(captureHandymanTaxIdentity(actor, inputFor(bb, { owner: forged })), code('HANDYMAN_TAX_IDENTITY_NOT_FOUND'));
    await assert.rejects(resolveHandymanTaxIdentityAt(actor, forged, iso(Date.now() + 10_000)), code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    await assert.rejects(captureHandymanTaxIdentity(actor, inputFor(a, { issuerProfileId: b.issuer.id })), code('HANDYMAN_TAX_IDENTITY_NOT_FOUND'));
    await assert.rejects(q(`INSERT INTO handyman_tax_identity_profiles
      (id,client_id,owner_kind,owner_id,issuer_profile_id,version,legal_name,taxpayer_kind,
       identifier_kind,identifier_value,pkp_status,effective_from,evidence_source,evidence_reference,idempotency_key,created_by_user_id)
      VALUES($1,$2,'HANDYMAN_ISSUER',$2,$3,1,$4,'LEGAL_ENTITY','NPWP_15','012345678901000','PKP',$5,'TEST','case',$6,$7)`,
    [id(), a.clientId, b.issuer.id, a.legalName, iso(Date.now() + 1000), id(), actor]), /exact issuer profile/);
    await assert.rejects(rawBm(pool, bb, { clientId: a.clientId }), /exact verified BM beneficiary/);
    await assert.rejects(rawBm(pool, bb, { proofId: aa.verification!.id }), /exact verified BM beneficiary/);
  });

  it('resolves immutable snapshots across prospective closure and half-open version boundaries', async () => {
    const f = await fixture(), bm = await party(f.clientId);
    const start = bm.verification!.verifiedAt.getTime(), boundary = Date.now() + 60_000, end = boundary + 60_000;
    const firstInput = inputFor(bm, { taxpayerKind: 'INDIVIDUAL', individualResidency: 'RESIDENT', identifier: null, pkpStatus: 'UNKNOWN' });
    const first = await captureHandymanTaxIdentity(actor, firstInput);
    const old = await resolveHandymanTaxIdentityAt(actor, bm.owner, iso(start));
    assert.equal(old.taxUse.reason, 'PKP_STATUS_UNKNOWN');
    assert.equal(old.digest, createHash('sha256').update(stableJson(old.snapshot), 'utf8').digest('hex'));
    assert.ok(Object.isFrozen(old) && Object.isFrozen(old.snapshot) && Object.isFrozen(old.effectiveWindow));
    const closure = { owner: bm.owner, profileId: old.snapshot.id, effectiveTo: iso(boundary), reason: 'New evidence' };
    const closed = await closeHandymanTaxIdentity(actor, closure);
    assert.equal(closed.identity.digest, old.digest);
    assert.equal(closed.identity.snapshot.declaredEffectiveTo, null);
    assert.equal(closed.identity.effectiveWindow.identityWindowTo, iso(boundary));
    assert.equal((await closeHandymanTaxIdentity(actor, closure)).replayed, true);
    await assert.rejects(closeHandymanTaxIdentity(actor, { ...closure, reason: 'Rewritten' }), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    const second = await captureHandymanTaxIdentity(actor, inputFor(bm, {
      taxpayerKind: 'INDIVIDUAL', individualResidency: 'RESIDENT', identifier: { kind: 'NIK_NPWP_16', value: '3171000012345678' },
      pkpStatus: 'NON_PKP', effectiveFrom: iso(boundary), effectiveTo: iso(end), expectedVersion: 1 }));
    assert.equal(second.identity.snapshot.version, 2);
    assert.equal((await resolveHandymanTaxIdentityAt(actor, bm.owner, iso(boundary - 1))).digest, old.digest);
    assert.equal((await resolveHandymanTaxIdentityAt(actor, bm.owner, iso(boundary))).digest, second.identity.digest);
    const latestPage = await listHandymanTaxIdentityHistory(actor, bm.owner, { limit: 1 });
    assert.equal(latestPage.identities[0].snapshot.version, 2);
    assert.equal(latestPage.nextBeforeVersion, 2);
    const olderPage = await listHandymanTaxIdentityHistory(actor, bm.owner, { limit: 1, beforeVersion: 2 });
    assert.equal(olderPage.identities[0].digest, old.digest);
    assert.equal(olderPage.identities[0].effectiveWindow.closure?.kind, 'CLOSED');
    assert.equal(olderPage.nextBeforeVersion, null);
    assert.ok(Object.isFrozen(olderPage.identities));
    await assert.rejects(listHandymanTaxIdentityHistory(actor, bm.owner, { limit: 101 }), code('HANDYMAN_TAX_IDENTITY_INVALID'));
    await assert.rejects(resolveHandymanTaxIdentityAt(actor, bm.owner, iso(start - 1)), code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    await assert.rejects(resolveHandymanTaxIdentityAt(actor, bm.owner, iso(end)), code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    await assert.rejects(q('UPDATE handyman_tax_identity_profiles SET pkp_status=$2 WHERE id=$1', [old.snapshot.id, 'PKP']), /immutable history/);
    await assert.rejects(q('DELETE FROM handyman_tax_identity_profiles WHERE id=$1', [old.snapshot.id]), /immutable history/);
    await assert.rejects(q('UPDATE handyman_tax_identity_closures SET reason=$2 WHERE profile_id=$1', [old.snapshot.id, 'changed']), /immutable history/);
    await assert.rejects(q('DELETE FROM handyman_tax_identity_closures WHERE profile_id=$1', [old.snapshot.id]), /immutable history/);
    await assert.rejects(q('UPDATE handyman_tax_identity_windows SET effective_to=$2 WHERE profile_id=$1', [old.snapshot.id, iso(boundary + 1)]), /immutable closure/);
    await assert.rejects(q('DELETE FROM handyman_tax_identity_windows WHERE profile_id=$1', [old.snapshot.id]), /cannot be deleted/);
    assert.equal((await captureHandymanTaxIdentity(actor, firstInput)).identity.digest, old.digest);
    await assert.rejects(captureHandymanTaxIdentity(actor, inputFor(bm, { expectedVersion: 2,
      effectiveFrom: iso(boundary + 1), effectiveTo: iso(end + 10) })), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
  });

  it('cancels only future assertions without erasing history or retaining an overlapping window', async () => {
    const f = await fixture(), bm = await party(f.clientId);
    const start = iso(Date.now() + 120_000);
    const original = inputFor(bm, { effectiveFrom: start });
    const scheduled = await captureHandymanTaxIdentity(actor, original);
    const cancel = { owner: bm.owner, profileId: scheduled.identity.snapshot.id,
      effectiveTo: start, reason: 'Incorrect future assertion' };
    const cancelled = await closeHandymanTaxIdentity(actor, cancel);
    assert.equal(cancelled.identity.effectiveWindow.closure?.kind, 'CANCELLED_BEFORE_START');
    assert.equal(cancelled.identity.digest, scheduled.identity.digest);
    assert.equal((await closeHandymanTaxIdentity(actor, cancel)).replayed, true);
    await assert.rejects(resolveHandymanTaxIdentityAt(actor, bm.owner, start), code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    const replacement = await captureHandymanTaxIdentity(actor, inputFor(bm, { effectiveFrom: start, expectedVersion: 1 }));
    assert.equal((await resolveHandymanTaxIdentityAt(actor, bm.owner, start)).snapshot.id, replacement.identity.snapshot.id);
    const history = await listHandymanTaxIdentityHistory(actor, bm.owner);
    assert.deepEqual(history.identities.map(item => item.snapshot.id), [replacement.identity.snapshot.id, scheduled.identity.snapshot.id]);
    assert.equal(history.identities[1].effectiveWindow.closure?.kind, 'CANCELLED_BEFORE_START');
    assert.equal(history.identities[1].digest, scheduled.identity.digest);
    const past = await party(f.clientId), active = await captureHandymanTaxIdentity(actor, inputFor(past));
    await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(closeHandymanTaxIdentity(actor, { owner: past.owner, profileId: active.identity.snapshot.id,
      effectiveTo: active.identity.snapshot.effectiveFrom, reason: 'Too late' }), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
  });

  it('does not project an old issuer anchor past its own supersession', async () => {
    const f = await fixture();
    const start = new Date(f.issuer.effectiveFrom).getTime() + 1;
    const first = await captureHandymanTaxIdentity(actor, inputFor(f, { issuerProfileId: f.issuer.id, effectiveFrom: iso(start) }));
    const later = await updateHandymanDocumentIssuerProfile({ ...issuerContent(f.clientId, f.legalName, 1), city: 'Bogor' }, actor);
    const stored = (await q('SELECT superseded_at FROM handyman_document_issuer_profiles WHERE id=$1', [f.issuer.id])).rows[0];
    const afterSupersession = stored.superseded_at.getTime() + 1;
    const before = await resolveHandymanTaxIdentityAt(actor, f.owner, iso(start));
    assert.equal(before.digest, first.identity.digest);
    assert.ok(before.effectiveWindow.issuerProfileSupersededAt);
    await assert.rejects(resolveHandymanTaxIdentityAt(actor, f.owner, iso(afterSupersession)), code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    const boundary = Date.now() + 60_000;
    await assert.rejects(captureHandymanTaxIdentity(actor, inputFor(f, { issuerProfileId: later.id,
      effectiveFrom: iso(boundary), expectedVersion: 1 })), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    await closeHandymanTaxIdentity(actor, { owner: f.owner, profileId: first.identity.snapshot.id,
      effectiveTo: iso(boundary), reason: 'New issuer version' });
    const second = await captureHandymanTaxIdentity(actor, inputFor(f, { issuerProfileId: later.id,
      effectiveFrom: iso(boundary), expectedVersion: 1 }));
    assert.equal((await resolveHandymanTaxIdentityAt(actor, f.owner, iso(boundary))).snapshot.id, second.identity.snapshot.id);
  });

  it('requires explicit Finance permission and Client reach, and never approves UNKNOWN or a claimed PKP', async () => {
    const f = await fixture(), other = await fixture(), bm = await party(f.clientId);
    const writer = await scopedUser(f.buildingId, ['handyman.finance.manage']);
    const reader = await scopedUser(f.buildingId, ['handyman.finance.read']);
    const commercial = await scopedUser(f.buildingId, ['handyman.commercial.manage']);
    const outsider = await scopedUser(other.buildingId, ['handyman.finance.manage', 'handyman.finance.read']);
    const input = inputFor(bm);
    await assert.rejects(captureHandymanTaxIdentity(commercial, input), code('PERMISSION_DENIED'));
    await assert.rejects(captureHandymanTaxIdentity(reader, input), code('PERMISSION_DENIED'));
    await assert.rejects(captureHandymanTaxIdentity(outsider, input), code('BUILDING_ACCESS_DENIED'));
    const captured = await captureHandymanTaxIdentity(writer, input);
    assert.equal(captured.identity.taxUse.reason, 'APPROVAL_REQUIRED');
    await assert.rejects(resolveHandymanTaxIdentityAt(writer, bm.owner, input.effectiveFrom), code('PERMISSION_DENIED'));
    await assert.rejects(resolveHandymanTaxIdentityAt(commercial, bm.owner, input.effectiveFrom), code('PERMISSION_DENIED'));
    await assert.rejects(resolveHandymanTaxIdentityAt(outsider, bm.owner, input.effectiveFrom), code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(listHandymanTaxIdentityHistory(commercial, bm.owner), code('PERMISSION_DENIED'));
    await assert.rejects(listHandymanTaxIdentityHistory(outsider, bm.owner), code('BUILDING_ACCESS_DENIED'));
    assert.equal((await listHandymanTaxIdentityHistory(reader, bm.owner)).identities[0].snapshot.id, captured.identity.snapshot.id);
    assert.equal((await resolveHandymanTaxIdentityAt(reader, bm.owner, input.effectiveFrom)).snapshot.pkpStatus, 'PKP');
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(reader, bm.owner, input.effectiveFrom),
      code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    await assert.rejects(q("UPDATE handyman_tax_identity_profiles SET approval_status='APPROVED' WHERE id=$1", [captured.identity.snapshot.id]), /immutable history/);
    const unknownBm = await party(f.clientId);
    const unknownInput = inputFor(unknownBm, { taxpayerKind: 'UNKNOWN', pkpStatus: 'UNKNOWN', identifier: null });
    await captureHandymanTaxIdentity(writer, unknownInput);
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(reader, unknownBm.owner, unknownInput.effectiveFrom),
      code('HANDYMAN_TAX_IDENTITY_UNKNOWN'));
  });

  it('serializes competing versions and same-key replays without overlapping identities', async () => {
    const f = await fixture(), bm = await party(f.clientId), sameKey = await party(f.clientId);
    const a = inputFor(bm), b = inputFor(bm, { identifier: { kind: 'NPWP_16', value: '0123456789012345' } });
    const race = await Promise.allSettled([captureHandymanTaxIdentity(actor, a), captureHandymanTaxIdentity(actor, b)]);
    assert.equal(race.filter(x => x.status === 'fulfilled').length, 1);
    const loser = race.find(x => x.status === 'rejected') as PromiseRejectedResult;
    assert.equal(loser.reason.code, 'HANDYMAN_TAX_IDENTITY_CONFLICT');
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_profiles WHERE owner_id=$1', [bm.counterparty.id])).rows[0].n, 1);
    const replayInput = inputFor(sameKey);
    const replay = await Promise.all([captureHandymanTaxIdentity(actor, replayInput), captureHandymanTaxIdentity(actor, replayInput)]);
    assert.deepEqual(replay.map(x => x.replayed).sort(), [false, true]);
    assert.equal(replay[0].identity.digest, replay[1].identity.digest);
    assert.equal(replay[0].identity.snapshot.id, replay[1].identity.snapshot.id);

    const other = await fixture(), one = await party(f.clientId), two = await party(other.clientId), sharedKey = id();
    const crossScope = await Promise.allSettled([
      captureHandymanTaxIdentity(actor, inputFor(one, { idempotencyKey: sharedKey })),
      captureHandymanTaxIdentity(actor, inputFor(two, { idempotencyKey: sharedKey })),
    ]);
    assert.equal(crossScope.filter(x => x.status === 'fulfilled').length, 1);
    const crossLoser = crossScope.find(x => x.status === 'rejected') as PromiseRejectedResult;
    assert.equal(crossLoser.reason.code, 'HANDYMAN_TAX_IDENTITY_CONFLICT');
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_profiles WHERE idempotency_key=$1', [sharedKey])).rows[0].n, 1);
  });

  it('enforces direct-SQL and repeatable-read race protection, timestamps and prospective closure', async () => {
    const f = await fixture(), bm = await party(f.clientId);
    const first = await pool.connect(), second = await pool.connect();
    try {
      await first.query('BEGIN'); await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await second.query('SELECT count(*) FROM handyman_tax_identity_profiles'); // fix the old snapshot
      const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const inserted = await rawBm(first, bm);
      const pending = rawBm(second, bm).then(() => null, err => err);
      await waitForBlock(secondPid, firstPid);
      await first.query('COMMIT');
      const loser = await pending;
      assert.ok(loser); assert.ok(['23505', '40001', '23P01'].includes(loser.code), `${loser.code}: ${loser.message}`);
      await second.query('ROLLBACK');
      assert.ok(inserted.created_at.getTime() > Date.now() - 10_000, 'database must override a forged creation time');
      await assert.rejects(rawBm(pool, bm, { version: 2 }), /hm_tax_identity_window_no_overlap/);
      const count = await q('SELECT count(*)::int AS n FROM handyman_tax_identity_profiles WHERE owner_id=$1', [bm.counterparty.id]);
      assert.equal(count.rows[0].n, 1);
      await assert.rejects(q(`INSERT INTO handyman_tax_identity_closures
        (id,profile_id,effective_to,reason,created_by_user_id) VALUES($1,$2,$3,'backdated',$4)`,
      [id(), inserted.id, iso(Date.now() - 5000), actor]), /closed prospectively/);
      const boundary = iso(Date.now() + 60_000);
      const closure = await q(`INSERT INTO handyman_tax_identity_closures
        (id,profile_id,effective_to,reason,created_by_user_id,created_at)
        VALUES($1,$2,$3,'end',$4,'2000-01-01') RETURNING *`, [id(), inserted.id, boundary, actor]);
      assert.ok(closure.rows[0].created_at.getTime() > Date.now() - 10_000);
      await assert.rejects(q('UPDATE handyman_tax_identity_windows SET effective_to=NULL WHERE profile_id=$1', [inserted.id]), /immutable closure/);
      await assert.rejects(q(`INSERT INTO handyman_tax_identity_closures
        (id,profile_id,effective_to,reason,created_by_user_id) VALUES($1,$2,$3,'second',$4)`,
      [id(), inserted.id, iso(Date.now() + 30_000), actor]), /duplicate key|shortened once/);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined); await second.query('ROLLBACK').catch(() => undefined);
      first.release(); second.release();
    }
  });

  it('refuses destructive rollback once tax identity history exists', async () => {
    assert.equal(await migrateDown(pool),'0499_handyman_customer_tax_classifications');
    assert.equal(await migrateDown(pool), '0498_handyman_request_buyer_bindings');
    assert.equal(await migrateDown(pool), '0497_handyman_tax_rule_governance');
    assert.equal(await migrateDown(pool), '0496_handyman_tax_identity_approval');
    await assert.rejects(migrateDown(pool), /Refusing to remove populated tax identity history/);
    assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id='0495_handyman_tax_identity_profiles'")).rows[0].n, 1);
    assert.deepEqual(await migrateUp(pool), ['0496_handyman_tax_identity_approval', '0497_handyman_tax_rule_governance', '0498_handyman_request_buyer_bindings', '0499_handyman_customer_tax_classifications']);
  });
});
