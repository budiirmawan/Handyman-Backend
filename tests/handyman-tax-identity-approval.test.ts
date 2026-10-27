import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, migrations } from '../src/database';
import { seedFoundationAccess, UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { registerHandymanBmLegalCounterparty, verifyHandymanBmLegalCounterparty } from '../src/modules/handyman-bm-binding';
import {
  captureHandymanTaxIdentity, closeHandymanTaxIdentity, decideHandymanTaxIdentityApproval,
  listHandymanTaxIdentityApprovalHistory, requireApprovedHandymanTaxIdentityAt, resolveHandymanTaxIdentityAt,
  submitHandymanTaxIdentityForApproval, type CaptureHandymanTaxIdentityInput,
  type HandymanTaxIdentityOwner, type HandymanTaxIdentityView, type TaxIdentityApprovalCommand,
  type TaxIdentityApprovalEvent,
} from '../src/modules/handyman-tax-identity';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/hm-tax-approval-pg', PORT = 55532;
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error', DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT), DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
let pg: EmbeddedPostgres;
let pool: Pool;
let admin: string;
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const iso = (ms: number) => new Date(ms).toISOString();
const code = (expected: string) => (e: { code?: string }) => { assert.equal(e.code, expected); return true; };

before(async () => {
  await rm(DIR, { recursive: true, force: true }); await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise(); await pg.start();
  const system = pg.getPgClient('postgres', '127.0.0.1');
  await system.connect(); await system.query('CREATE DATABASE asentra_test'); await system.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase(); assert.ok(config);
  pool = await initDatabase(config); await migrateUp(pool);
  admin = (await createAdminUser()).userId;
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); }
});

const issuerContent = (clientId: string, legalName: string, expectedVersion: number | null) => ({
  clientId, expectedVersion, legalName, displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1',
  businessAddress: null, city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test',
  phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000', website: null, taxId: null,
  businessRegistrationId: null, logoReference: null,
});
async function scopedUser(buildingId: string, codes: string[]) {
  const user = await userService.createUser({ email: `${id()}@approval.test`, displayName: 'Tax Finance actor' });
  const role = await roleService.createRole({ code: `TAXAPP_${id()}`, name: 'Explicit tax role' });
  for (const permission of codes) {
    const record = await permissionRepository.findByCode(permission); assert.ok(record);
    await permissionService.assignPermissionToRole(role.id, record.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}
async function fixture() {
  const clientId = id(), propertyId = id(), buildingId = id(), legalName = `PT Provider ${id().slice(0, 8)}`;
  await q('INSERT INTO clients (id,code,name) VALUES ($1,$2,$3)', [clientId, id(), legalName]);
  await q('INSERT INTO properties (id,client_id,code,name) VALUES ($1,$2,$3,$4)', [propertyId, clientId, id(), 'Property']);
  await q('INSERT INTO buildings (id,property_id,code,name) VALUES ($1,$2,$3,$4)', [buildingId, propertyId, id(), 'Building']);
  await buildingAssignmentService.createAssignment(admin, { buildingId });
  const issuer = await updateHandymanDocumentIssuerProfile(issuerContent(clientId, legalName, null), admin);
  const maker = await scopedUser(buildingId, ['handyman.finance.manage', 'handyman.finance.read']);
  const checker = await scopedUser(buildingId, ['handyman.finance.read', 'handyman.tax_identity.approve']);
  return { clientId, buildingId, legalName, issuer, maker, checker,
    owner: { kind: 'HANDYMAN_ISSUER', clientId } as const };
}
async function bm(clientId: string, name = `PT BM ${id().slice(0, 8)}`) {
  const party = await registerHandymanBmLegalCounterparty(admin, { clientId, legalName: name,
    registrationNumber: id(), representsClientOrganization: false, idempotencyKey: id() });
  const proof = await verifyHandymanBmLegalCounterparty(admin, { clientId, counterpartyId: party.counterparty.id,
    evidenceReference: `registration/${id()}` });
  return { legalName: name, counterparty: party.counterparty, verification: proof.verification,
    owner: { kind: 'BM_BENEFICIARY', clientId, counterpartyId: party.counterparty.id } as const };
}
function captureInput(target: { owner: HandymanTaxIdentityOwner; legalName: string; verification?: { verifiedAt: Date } },
  extra: Partial<CaptureHandymanTaxIdentityInput> = {}): CaptureHandymanTaxIdentityInput {
  return { owner: target.owner, legalName: target.legalName, taxpayerKind: 'LEGAL_ENTITY', individualResidency: null,
    identifier: { kind: 'NPWP_15', value: '01.234.567.8-901.000' }, pkpStatus: 'PKP',
    effectiveFrom: target.verification ? target.verification.verifiedAt.toISOString() : iso(Date.now() + 1000),
    effectiveTo: null, evidenceSource: 'MANUAL_REVIEW', evidenceReference: `profile/${id()}`,
    expectedVersion: null, idempotencyKey: id(), ...extra };
}
function command(target: HandymanTaxIdentityOwner, view: HandymanTaxIdentityView): TaxIdentityApprovalCommand {
  return { owner: target, profileId: view.snapshot.id, profileVersion: view.snapshot.version,
    profileDigest: view.digest, evidenceSource: 'FINANCE_CASE', evidenceReference: `review/${id()}` };
}
function decision(input: TaxIdentityApprovalCommand, submission: TaxIdentityApprovalEvent, result: 'APPROVE' | 'REJECT') {
  return { ...input, submissionId: submission.id, decision: result,
    evidenceSource: 'CHECKER_EVIDENCE', evidenceReference: `decision/${id()}` };
}
async function capture(maker: string, target: Awaited<ReturnType<typeof bm>>,
  extra: Partial<CaptureHandymanTaxIdentityInput> = {}) {
  return (await captureHandymanTaxIdentity(maker, captureInput(target, extra))).identity;
}
async function waitForBlock(waiterPid: number, blockerPid: number) {
  for (let i = 0; i < 100; i++) {
    if ((await q('SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked', [waiterPid, blockerPid])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected a concurrent approval to wait on the exact owner.');
}
async function rawEvent(tx: Pick<PoolClient, 'query'>, input: TaxIdentityApprovalCommand, actor: string,
  type: 'SUBMIT' | 'APPROVE' | 'REJECT', submissionId: string | null = null, options: {
    clientId?: string; ownerId?: string; version?: number; digest?: string;
  } = {}) {
  const ownerId = input.owner.kind === 'HANDYMAN_ISSUER' ? input.owner.clientId : input.owner.counterpartyId;
  return (await tx.query(`INSERT INTO handyman_tax_identity_approval_events
    (id,profile_id,client_id,owner_kind,owner_id,profile_version,profile_digest,event_type,submission_id,
     actor_user_id,evidence_source,evidence_reference,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TEST','decision/raw','2000-01-01') RETURNING *`,
  [id(), input.profileId, options.clientId ?? input.owner.clientId, input.owner.kind, options.ownerId ?? ownerId,
    options.version ?? input.profileVersion, options.digest ?? input.profileDigest, type, submissionId, actor])).rows[0];
}
async function rawNextBm(tx: PoolClient, target: Awaited<ReturnType<typeof bm>>, maker: string, from: string) {
  return (await tx.query(`INSERT INTO handyman_tax_identity_profiles
    (id,client_id,owner_kind,owner_id,counterparty_id,verification_id,version,legal_name,taxpayer_kind,
     individual_residency,identifier_kind,identifier_value,pkp_status,effective_from,declared_effective_to,
     evidence_source,evidence_reference,idempotency_key,created_by_user_id)
    VALUES($1,$2,'BM_BENEFICIARY',$3,$3,$4,2,$5,'LEGAL_ENTITY',NULL,'NPWP_15','012345678901000','PKP',$6,NULL,
     'TEST','profile/new',$7,$8) RETURNING id`,
  [id(), target.counterparty.clientId, target.counterparty.id, target.verification.id, target.legalName, from, id(), maker])).rows[0];
}

describe('CR-HM-TAX-INDONESIA-01 PART 01B Finance approval', () => {
  it('registers a dedicated checker capability but grants it to no role, even after seeding', async () => {
    assert.equal(migrations.at(-1)?.id, '0496_handyman_tax_identity_approval');
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.tax_identity.approve'));
    const checkGrants = async () => (await q(`SELECT count(*)::int AS n FROM role_permission_assignments rpa
      JOIN permissions p ON p.id=rpa.permission_id WHERE p.code='handyman.tax_identity.approve' AND rpa.status='ACTIVE'`)).rows[0].n;
    assert.equal(await checkGrants(), 0);
    const tx = await pool.connect();
    try { await tx.query('BEGIN'); await seedFoundationAccess(tx); await tx.query('COMMIT'); }
    finally { tx.release(); }
    assert.equal(await checkGrants(), 0);
    assert.ok(await permissionRepository.findByCode('handyman.tax_identity.approve'));
  });

  it('upgrades existing 0495 history without rewriting it and backfills the latest head', async () => {
    assert.equal(await migrateDown(pool), '0496_handyman_tax_identity_approval');
    const f = await fixture(), party = await bm(f.clientId), first = await capture(f.maker, party);
    const boundary = iso(Date.now() + 60_000);
    await closeHandymanTaxIdentity(f.maker, { owner: party.owner, profileId: first.snapshot.id,
      effectiveTo: boundary, reason: 'Existing pre-upgrade history' });
    const second = await capture(f.maker, party, { effectiveFrom: boundary, expectedVersion: 1 });
    const before = (await q('SELECT * FROM handyman_tax_identity_profiles WHERE owner_id=$1 ORDER BY version', [party.counterparty.id])).rows;
    assert.deepEqual(await migrateUp(pool), ['0496_handyman_tax_identity_approval']);
    assert.deepEqual((await q('SELECT * FROM handyman_tax_identity_profiles WHERE owner_id=$1 ORDER BY version', [party.counterparty.id])).rows, before);
    const head = (await q('SELECT latest_profile_id, latest_version FROM handyman_tax_identity_heads WHERE owner_id=$1', [party.counterparty.id])).rows[0];
    assert.equal(head.latest_profile_id, second.snapshot.id); assert.equal(head.latest_version, 2);
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, command(party.owner, first)), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    const input = command(party.owner, second), submitted = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const approved = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'APPROVE'));
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, boundary)).approval.decision.id, approved.id);
  });

  it('submits and approves one exact immutable payload, never retroactively', async () => {
    const f = await fixture(), party = await bm(f.clientId), identity = await capture(f.maker, party);
    const input = command(party.owner, identity);
    assert.equal((await q('SELECT hm_tax_identity_payload_digest($1) AS digest', [identity.snapshot.id])).rows[0].digest, identity.digest);
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, identity.snapshot.effectiveFrom),
      code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    const started = Date.now();
    const submitted = await submitHandymanTaxIdentityForApproval(f.maker, input);
    assert.equal(submitted.eventType, 'SUBMIT'); assert.equal(submitted.profileDigest, identity.digest);
    assert.ok(new Date(submitted.occurredAt).getTime() >= started);
    assert.equal(submitted.actorUserId, f.maker); assert.equal(submitted.reviewFrom, identity.snapshot.effectiveFrom);
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, input), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    const approved = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'APPROVE'));
    assert.equal(approved.eventType, 'APPROVE'); assert.equal(approved.actorUserId, f.checker);
    assert.equal(approved.submissionId, submitted.id); assert.equal(approved.profileVersion, identity.snapshot.version);
    assert.ok(approved.approvedFrom); assert.ok(new Date(approved.approvedFrom!).getTime() >= new Date(approved.occurredAt).getTime());
    const before = iso(new Date(approved.approvedFrom!).getTime() - 1);
    assert.ok(new Date(before).getTime() >= new Date(identity.snapshot.effectiveFrom).getTime());
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, before), code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    const at = iso(new Date(approved.approvedFrom!).getTime() + 1);
    const resolved = await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, at);
    assert.equal(resolved.taxUse.allowed, true); assert.equal(resolved.digest, identity.digest);
    assert.equal(resolved.snapshot.approvalStatus, 'UNAPPROVED'); // original 0495 assertion is never rewritten
    assert.equal(resolved.approval.submission.id, submitted.id); assert.equal(resolved.approval.decision.id, approved.id);
    assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.approval) && Object.isFrozen(resolved.approval.decision));
    assert.equal((await resolveHandymanTaxIdentityAt(f.checker, party.owner, at)).taxUse.allowed, false);
    const history = await listHandymanTaxIdentityApprovalHistory(f.checker, party.owner, identity.snapshot.id);
    assert.deepEqual(history.map(x => x.eventType), ['SUBMIT', 'APPROVE']);
    assert.equal(history[0].evidenceReference, input.evidenceReference); assert.equal(history[1].evidenceSource, 'CHECKER_EVIDENCE');
    await assert.rejects(decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'REJECT')),
      code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
  });

  it('keeps checker authority separate, forbids maker/author self-decisions, and enforces Client access', async () => {
    const f = await fixture(), other = await fixture(), party = await bm(f.clientId);
    const both = await scopedUser(f.buildingId, ['handyman.finance.manage', 'handyman.finance.read', 'handyman.tax_identity.approve']);
    const commercial = await scopedUser(f.buildingId, ['handyman.commercial.manage']);
    const reader = await scopedUser(f.buildingId, ['handyman.finance.read']);
    const checkerOnly = await scopedUser(f.buildingId, ['handyman.tax_identity.approve']);
    const outsider = await scopedUser(other.buildingId, ['handyman.finance.manage', 'handyman.finance.read', 'handyman.tax_identity.approve']);
    const identity = await capture(both, party), input = command(party.owner, identity);
    await assert.rejects(submitHandymanTaxIdentityForApproval(commercial, input), code('PERMISSION_DENIED'));
    await assert.rejects(submitHandymanTaxIdentityForApproval(outsider, input), code('BUILDING_ACCESS_DENIED'));
    const submitted = await submitHandymanTaxIdentityForApproval(both, input);
    await assert.rejects(decideHandymanTaxIdentityApproval(both, decision(input, submitted, 'APPROVE')),
      code('HANDYMAN_TAX_IDENTITY_APPROVAL_FORBIDDEN'));
    await assert.rejects(decideHandymanTaxIdentityApproval(both, decision(input, submitted, 'REJECT')),
      code('HANDYMAN_TAX_IDENTITY_APPROVAL_FORBIDDEN'));
    await assert.rejects(decideHandymanTaxIdentityApproval(reader, decision(input, submitted, 'APPROVE')), code('PERMISSION_DENIED'));
    await assert.rejects(decideHandymanTaxIdentityApproval(checkerOnly, decision(input, submitted, 'APPROVE')), code('PERMISSION_DENIED'));
    await assert.rejects(decideHandymanTaxIdentityApproval(outsider, decision(input, submitted, 'APPROVE')), code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(rawEvent(pool, input, both, 'APPROVE', submitted.id), /maker or author cannot check/);
    await assert.rejects(rawEvent(pool, input, reader, 'APPROVE', submitted.id), /checker authority/);

    const another = await bm(f.clientId), authored = await capture(both, another), anotherInput = command(another.owner, authored);
    const submittedByOther = await submitHandymanTaxIdentityForApproval(f.maker, anotherInput);
    await assert.rejects(decideHandymanTaxIdentityApproval(both, decision(anotherInput, submittedByOther, 'APPROVE')),
      code('HANDYMAN_TAX_IDENTITY_APPROVAL_FORBIDDEN'));
    const inactive = await scopedUser(f.buildingId, ['handyman.finance.read', 'handyman.tax_identity.approve']);
    await q("UPDATE users SET status='SUSPENDED' WHERE id=$1", [inactive]);
    await assert.rejects(decideHandymanTaxIdentityApproval(inactive, decision(input, submitted, 'APPROVE')), code('PERMISSION_DENIED'));
    const approved = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'APPROVE'));
    assert.equal(approved.eventType, 'APPROVE');
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(outsider, party.owner, approved.approvedFrom!), code('BUILDING_ACCESS_DENIED'));
  });

  it('approves only the exact current issuer and preserves pre-supersession history', async () => {
    const f = await fixture();
    const asserted = (await captureHandymanTaxIdentity(f.maker, captureInput(f, { issuerProfileId: f.issuer.id,
      effectiveFrom: iso(new Date(f.issuer.effectiveFrom).getTime() + 1) }))).identity;
    const input = command(f.owner, asserted), submitted = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const approved = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'APPROVE'));
    await new Promise(resolve => setTimeout(resolve, 5));
    await updateHandymanDocumentIssuerProfile({ ...issuerContent(f.clientId, f.legalName, 1), city: 'Bogor' }, admin);
    const supersededAt = (await q('SELECT superseded_at FROM handyman_document_issuer_profiles WHERE id=$1', [f.issuer.id])).rows[0].superseded_at as Date;
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, f.owner, approved.approvedFrom!)).digest, asserted.digest);
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, f.owner, iso(supersededAt.getTime())),
      code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, f.owner, iso(supersededAt.getTime() + 1)),
      code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));

    const next = await fixture();
    const pending = (await captureHandymanTaxIdentity(next.maker, captureInput(next, { issuerProfileId: next.issuer.id,
      effectiveFrom: iso(new Date(next.issuer.effectiveFrom).getTime() + 1) }))).identity;
    const pendingInput = command(next.owner, pending), s = await submitHandymanTaxIdentityForApproval(next.maker, pendingInput);
    await updateHandymanDocumentIssuerProfile({ ...issuerContent(next.clientId, next.legalName, 1), city: 'Bandung' }, admin);
    await assert.rejects(decideHandymanTaxIdentityApproval(next.checker, decision(pendingInput, s, 'APPROVE')),
      code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    assert.equal((await decideHandymanTaxIdentityApproval(next.checker, decision(pendingInput, s, 'REJECT'))).eventType, 'REJECT');
  });

  it('rejects unknown classifications, incomplete evidence, digest tampering and crossed owner/version', async () => {
    const f = await fixture(), other = await fixture(), one = await bm(f.clientId), two = await bm(f.clientId), foreign = await bm(other.clientId);
    const unknownIdentity = await capture(f.maker, one, { pkpStatus: 'UNKNOWN', identifier: null });
    const unknownInput = command(one.owner, unknownIdentity);
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, unknownInput), code('HANDYMAN_TAX_IDENTITY_UNKNOWN'));
    await assert.rejects(rawEvent(pool, unknownInput, f.maker, 'SUBMIT'), /classification and evidence must be complete/);
    const unknownType = await bm(f.clientId), typeIdentity = await capture(f.maker, unknownType,
      { taxpayerKind: 'UNKNOWN', pkpStatus: 'UNKNOWN', identifier: null });
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, command(unknownType.owner, typeIdentity)),
      code('HANDYMAN_TAX_IDENTITY_UNKNOWN'));
    const unknownResidence = await bm(f.clientId), residenceIdentity = await capture(f.maker, unknownResidence,
      { taxpayerKind: 'INDIVIDUAL', individualResidency: 'UNKNOWN' });
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, command(unknownResidence.owner, residenceIdentity)),
      code('HANDYMAN_TAX_IDENTITY_UNKNOWN'));
    const identity = await capture(f.maker, two), input = command(two.owner, identity);
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, { ...input, profileDigest: '0'.repeat(64) }), code('HANDYMAN_TAX_IDENTITY_INTEGRITY_ERROR'));
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, { ...input, profileVersion: 999 }), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, { ...input, evidenceReference: '' }), code('HANDYMAN_TAX_IDENTITY_INVALID'));
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, { ...input, owner: one.owner }), code('HANDYMAN_TAX_IDENTITY_NOT_FOUND'));
    await assert.rejects(rawEvent(pool, input, f.maker, 'SUBMIT', null, { digest: '0'.repeat(64) }), /digest does not match/);
    await assert.rejects(rawEvent(pool, input, f.maker, 'SUBMIT', null, { clientId: other.clientId }), /exact Client, owner, profile and version/);
    await assert.rejects(rawEvent(pool, input, f.maker, 'SUBMIT', null, { ownerId: foreign.counterparty.id }), /exact Client, owner, profile and version/);
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_approval_events WHERE profile_id=$1', [identity.snapshot.id])).rows[0].n, 0);
  });

  it('records one immutable REJECT, including its evidence, and never treats it as approval', async () => {
    const f = await fixture(), party = await bm(f.clientId), identity = await capture(f.maker, party), input = command(party.owner, identity);
    const submit = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const rejected = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submit, 'REJECT'));
    assert.equal(rejected.eventType, 'REJECT'); assert.equal(rejected.approvedFrom, null);
    assert.equal(rejected.profileDigest, identity.digest); assert.ok(rejected.evidenceReference);
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, iso(Date.now() + 5000)),
      code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    await assert.rejects(decideHandymanTaxIdentityApproval(f.checker, decision(input, submit, 'APPROVE')), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    await assert.rejects(q('UPDATE handyman_tax_identity_approval_events SET evidence_reference=$2 WHERE id=$1', [rejected.id, 'rewritten']), /immutable history/);
    await assert.rejects(q('DELETE FROM handyman_tax_identity_approval_events WHERE id=$1', [submit.id]), /immutable history/);
    await assert.rejects(q('DELETE FROM handyman_tax_identity_heads WHERE owner_id=$1', [party.counterparty.id]), /protected/);
    await assert.rejects(q('UPDATE handyman_tax_identity_heads SET latest_version=latest_version WHERE owner_id=$1', [party.counterparty.id]),
      /advances one immutable version at a time/);
    assert.deepEqual((await listHandymanTaxIdentityApprovalHistory(f.checker, party.owner, identity.snapshot.id)).map(x => x.eventType),
      ['SUBMIT', 'REJECT']);
  });

  it('retains prior approvals after closure, and a new version needs its own approval', async () => {
    const f = await fixture(), party = await bm(f.clientId), first = await capture(f.maker, party), one = command(party.owner, first);
    const s1 = await submitHandymanTaxIdentityForApproval(f.maker, one);
    const a1 = await decideHandymanTaxIdentityApproval(f.checker, decision(one, s1, 'APPROVE'));
    const historyBefore = (await q('SELECT * FROM handyman_tax_identity_approval_events WHERE profile_id=$1 ORDER BY occurred_at', [first.snapshot.id])).rows;
    const boundary = Date.now() + 60_000;
    await closeHandymanTaxIdentity(f.maker, { owner: party.owner, profileId: first.snapshot.id,
      effectiveTo: iso(boundary), reason: 'Replace with verified version' });
    const second = await capture(f.maker, party, { effectiveFrom: iso(boundary), expectedVersion: 1 });
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, iso(boundary)), code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    const two = command(party.owner, second), s2 = await submitHandymanTaxIdentityForApproval(f.maker, two);
    const a2 = await decideHandymanTaxIdentityApproval(f.checker, decision(two, s2, 'APPROVE'));
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, iso(boundary - 1))).digest, first.digest);
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, iso(boundary))).digest, second.digest);
    assert.equal(a1.approvedTo, null); assert.equal(a2.approvedFrom, iso(boundary));
    assert.deepEqual((await q('SELECT * FROM handyman_tax_identity_approval_events WHERE profile_id=$1 ORDER BY occurred_at', [first.snapshot.id])).rows, historyBefore);
  });

  it('refuses stale, cancelled, expired, or post-submission changed windows and permits a safe rejection', async () => {
    const f = await fixture(), party = await bm(f.clientId), first = await capture(f.maker, party), input = command(party.owner, first);
    const submission = await submitHandymanTaxIdentityForApproval(f.maker, input), boundary = Date.now() + 60_000;
    await closeHandymanTaxIdentity(f.maker, { owner: party.owner, profileId: first.snapshot.id, effectiveTo: iso(boundary), reason: 'Changed period' });
    await assert.rejects(decideHandymanTaxIdentityApproval(f.checker, decision(input, submission, 'APPROVE')), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    const second = await capture(f.maker, party, { effectiveFrom: iso(boundary), expectedVersion: 1 });
    await assert.rejects(decideHandymanTaxIdentityApproval(f.checker, decision(input, submission, 'APPROVE')), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    assert.equal((await decideHandymanTaxIdentityApproval(f.checker, decision(input, submission, 'REJECT'))).eventType, 'REJECT');
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, command(party.owner, first)), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    assert.equal(second.snapshot.version, 2);

    const cancelledParty = await bm(f.clientId), start = iso(Date.now() + 120_000);
    const cancelled = await capture(f.maker, cancelledParty, { effectiveFrom: start });
    await closeHandymanTaxIdentity(f.maker, { owner: cancelledParty.owner, profileId: cancelled.snapshot.id, effectiveTo: start, reason: 'Cancelled' });
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, command(cancelledParty.owner, cancelled)), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    const expiringParty = await bm(f.clientId), end = Date.now() + 100;
    const expiring = await capture(f.maker, expiringParty, { effectiveTo: iso(end) });
    await new Promise(resolve => setTimeout(resolve, 140));
    await assert.rejects(submitHandymanTaxIdentityForApproval(f.maker, command(expiringParty.owner, expiring)), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    const lateParty = await bm(f.clientId), lateEnd = Date.now() + 2000;
    const late = await capture(f.maker, lateParty, { effectiveTo: iso(lateEnd) }), lateInput = command(lateParty.owner, late);
    const lateSubmission = await submitHandymanTaxIdentityForApproval(f.maker, lateInput);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, lateEnd - Date.now()) + 10));
    await assert.rejects(decideHandymanTaxIdentityApproval(f.checker, decision(lateInput, lateSubmission, 'APPROVE')),
      code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    assert.equal((await decideHandymanTaxIdentityApproval(f.checker, decision(lateInput, lateSubmission, 'REJECT'))).eventType, 'REJECT');
  });

  it('cancels a future approved identity without allowing resolution in its former window', async () => {
    const f = await fixture(), party = await bm(f.clientId), start = iso(Date.now() + 120_000);
    const first = await capture(f.maker, party, { effectiveFrom: start }), input = command(party.owner, first);
    const submitted = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const approved = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'APPROVE'));
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, start)).digest, first.digest);
    await closeHandymanTaxIdentity(f.maker, { owner: party.owner, profileId: first.snapshot.id,
      effectiveTo: start, reason: 'Incorrect planned identity' });
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, start), code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
    assert.equal((await listHandymanTaxIdentityApprovalHistory(f.checker, party.owner, first.snapshot.id))[1].id, approved.id);
    const replacement = await capture(f.maker, party, { effectiveFrom: start, expectedVersion: 1 });
    await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, start), code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    const replacementInput = command(party.owner, replacement), s2 = await submitHandymanTaxIdentityForApproval(f.maker, replacementInput);
    await decideHandymanTaxIdentityApproval(f.checker, decision(replacementInput, s2, 'APPROVE'));
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, start)).digest, replacement.digest);
  });

  it('matches V1 SHA-256 for Unicode and escapes, and detects profile or decision tampering', async () => {
    const f = await fixture(), party = await bm(f.clientId, `PT Café "Bali" \\ ${id().slice(0, 8)}`);
    const identity = await capture(f.maker, party, { evidenceSource: 'Bukti café \\ dokumen', evidenceReference: `case/"é"/${id()}` });
    const sqlDigest = (await q('SELECT hm_tax_identity_payload_digest($1) AS digest', [identity.snapshot.id])).rows[0].digest;
    assert.equal(sqlDigest, identity.digest);
    const input = command(party.owner, identity), submitted = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const approved = await decideHandymanTaxIdentityApproval(f.checker, decision(input, submitted, 'APPROVE'));
    const at = iso(new Date(approved.approvedFrom!).getTime() + 1);
    await q('ALTER TABLE handyman_tax_identity_profiles DISABLE TRIGGER hm_tax_profile_no_mutation');
    try {
      await q("UPDATE handyman_tax_identity_profiles SET evidence_reference='tampered' WHERE id=$1", [identity.snapshot.id]);
      await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, at), code('HANDYMAN_TAX_IDENTITY_INTEGRITY_ERROR'));
      await q('UPDATE handyman_tax_identity_profiles SET evidence_reference=$2 WHERE id=$1', [identity.snapshot.id, identity.snapshot.evidenceReference]);
    } finally { await q('ALTER TABLE handyman_tax_identity_profiles ENABLE TRIGGER hm_tax_profile_no_mutation'); }
    await q('ALTER TABLE handyman_tax_identity_approval_events DISABLE TRIGGER hm_tax_approval_no_mutation');
    try {
      await q('UPDATE handyman_tax_identity_approval_events SET profile_digest=$2 WHERE id=$1', [approved.id, '0'.repeat(64)]);
      await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, at), code('HANDYMAN_TAX_IDENTITY_INTEGRITY_ERROR'));
      await q('UPDATE handyman_tax_identity_approval_events SET profile_digest=$2 WHERE id=$1', [approved.id, identity.digest]);
    } finally { await q('ALTER TABLE handyman_tax_identity_approval_events ENABLE TRIGGER hm_tax_approval_no_mutation'); }
    await q('ALTER TABLE handyman_bm_legal_counterparties DISABLE TRIGGER hm_bm_party_no_mutation');
    try {
      await q("UPDATE handyman_bm_legal_counterparties SET legal_name='tampered' WHERE id=$1", [party.counterparty.id]);
      await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, at), code('HANDYMAN_TAX_IDENTITY_INTEGRITY_ERROR'));
      await q('UPDATE handyman_bm_legal_counterparties SET legal_name=$2 WHERE id=$1', [party.counterparty.id, party.legalName]);
    } finally { await q('ALTER TABLE handyman_bm_legal_counterparties ENABLE TRIGGER hm_bm_party_no_mutation'); }
    await q('ALTER TABLE handyman_tax_identity_windows DISABLE TRIGGER hm_tax_window_projection_guard');
    try {
      await q('UPDATE handyman_tax_identity_windows SET effective_to=$2 WHERE profile_id=$1',
        [identity.snapshot.id, iso(Date.now() + 60_000)]);
      await assert.rejects(rawEvent(pool, input, f.maker, 'SUBMIT'), /immutable effective-window projection/);
      await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, at), code('HANDYMAN_TAX_IDENTITY_INTEGRITY_ERROR'));
      await q('UPDATE handyman_tax_identity_windows SET effective_to=NULL WHERE profile_id=$1', [identity.snapshot.id]);
    } finally { await q('ALTER TABLE handyman_tax_identity_windows ENABLE TRIGGER hm_tax_window_projection_guard'); }
    assert.equal((await requireApprovedHandymanTaxIdentityAt(f.checker, party.owner, at)).digest, identity.digest);
  });

  it('refuses conflicting approved periods even if a window projection is corrupted', async () => {
    const f = await fixture(), party = await bm(f.clientId), first = await capture(f.maker, party);
    const one = command(party.owner, first), s1 = await submitHandymanTaxIdentityForApproval(f.maker, one);
    await decideHandymanTaxIdentityApproval(f.checker, decision(one, s1, 'APPROVE'));
    const boundary = Date.now() + 60_000;
    await closeHandymanTaxIdentity(f.maker, { owner: party.owner, profileId: first.snapshot.id,
      effectiveTo: iso(boundary), reason: 'Switch' });
    const second = await capture(f.maker, party, { effectiveFrom: iso(boundary), expectedVersion: 1 });
    const two = command(party.owner, second), tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      // Test-only corruption: bypass the 0495 GiST constraint and protected projection.
      await tx.query('ALTER TABLE handyman_tax_identity_windows DROP CONSTRAINT hm_tax_identity_window_no_overlap');
      await tx.query('ALTER TABLE handyman_tax_identity_windows DISABLE TRIGGER hm_tax_window_projection_guard');
      await tx.query('UPDATE handyman_tax_identity_windows SET effective_to=$2 WHERE profile_id=$1',
        [first.snapshot.id, iso(boundary + 1000)]);
      const submit = await rawEvent(tx, two, f.maker, 'SUBMIT');
      await assert.rejects(rawEvent(tx, two, f.checker, 'APPROVE', submit.id), /Overlapping approved tax identity periods/);
      await tx.query('ROLLBACK');
    } finally { await tx.query('ROLLBACK').catch(() => undefined); tx.release(); }
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_approval_events WHERE profile_id=$1', [second.snapshot.id])).rows[0].n, 0);
    assert.equal((await q("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='hm_tax_identity_window_no_overlap'")).rows[0].n, 1);
  });

  it('serializes simultaneous submissions and competing approve/reject decisions', async () => {
    const f = await fixture(), party = await bm(f.clientId), identity = await capture(f.maker, party), input = command(party.owner, identity);
    const submits = await Promise.allSettled([submitHandymanTaxIdentityForApproval(f.maker, input), submitHandymanTaxIdentityForApproval(f.maker, input)]);
    assert.equal(submits.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((submits.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code, 'HANDYMAN_TAX_IDENTITY_CONFLICT');
    const submission = (submits.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<TaxIdentityApprovalEvent>).value;
    const otherChecker = await scopedUser(f.buildingId, ['handyman.finance.read', 'handyman.tax_identity.approve']);
    const decisions = await Promise.allSettled([
      decideHandymanTaxIdentityApproval(f.checker, decision(input, submission, 'APPROVE')),
      decideHandymanTaxIdentityApproval(otherChecker, decision(input, submission, 'REJECT')),
    ]);
    assert.equal(decisions.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((decisions.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code, 'HANDYMAN_TAX_IDENTITY_CONFLICT');
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_approval_events WHERE profile_id=$1', [identity.snapshot.id])).rows[0].n, 2);
  });

  it('prevents duplicate SQL decisions when a REPEATABLE READ snapshot misses the winner', async () => {
    const f = await fixture(), party = await bm(f.clientId), identity = await capture(f.maker, party), input = command(party.owner, identity);
    const submission = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const otherChecker = await scopedUser(f.buildingId, ['handyman.finance.read', 'handyman.tax_identity.approve']);
    const winner = await pool.connect(), loser = await pool.connect();
    try {
      await loser.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await loser.query('SELECT count(*) FROM handyman_tax_identity_approval_events');
      await winner.query('BEGIN');
      const winnerPid = (await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const loserPid = (await loser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const approved = await rawEvent(winner, input, f.checker, 'APPROVE', submission.id);
      const pending = rawEvent(loser, input, otherChecker, 'REJECT', submission.id).then(() => null, err => err);
      await waitForBlock(loserPid, winnerPid); await winner.query('COMMIT');
      const error = await pending;
      assert.ok(error); assert.ok(['23505', '40001'].includes(error.code), `${error.code}: ${error.message}`);
      await loser.query('ROLLBACK');
      assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_approval_events WHERE submission_id=$1', [submission.id])).rows[0].n, 1);
      assert.ok(approved.occurred_at.getTime() > Date.now() - 10_000, 'database overrides forged event time');
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined); await loser.query('ROLLBACK').catch(() => undefined);
      winner.release(); loser.release();
    }
  });

  it('prevents stale approval under a REPEATABLE READ race with a newer profile', async () => {
    const f = await fixture(), party = await bm(f.clientId), first = await capture(f.maker, party), input = command(party.owner, first);
    const boundary = iso(Date.now() + 60_000);
    await closeHandymanTaxIdentity(f.maker, { owner: party.owner, profileId: first.snapshot.id, effectiveTo: boundary, reason: 'New version' });
    const submission = await submitHandymanTaxIdentityForApproval(f.maker, input);
    const writer = await pool.connect(), reviewer = await pool.connect();
    try {
      await reviewer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await reviewer.query('SELECT * FROM handyman_tax_identity_heads WHERE owner_id=$1', [party.counterparty.id]);
      await writer.query('BEGIN');
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const reviewerPid = (await reviewer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await rawNextBm(writer, party, f.maker, boundary);
      const pending = rawEvent(reviewer, input, f.checker, 'APPROVE', submission.id).then(() => null, err => err);
      await waitForBlock(reviewerPid, writerPid); await writer.query('COMMIT');
      const loser = await pending;
      assert.ok(loser); assert.ok(['40001', '23514'].includes(loser.code), `${loser.code}: ${loser.message}`);
      await reviewer.query('ROLLBACK');
      assert.equal((await q("SELECT count(*)::int AS n FROM handyman_tax_identity_approval_events WHERE profile_id=$1 AND event_type='APPROVE'", [first.snapshot.id])).rows[0].n, 0);
      await assert.rejects(decideHandymanTaxIdentityApproval(f.checker, decision(input, submission, 'APPROVE')), code('HANDYMAN_TAX_IDENTITY_CONFLICT'));
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined); await reviewer.query('ROLLBACK').catch(() => undefined);
      writer.release(); reviewer.release();
    }
  });

  it('refuses a destructive rollback of approval history', async () => {
    await assert.rejects(migrateDown(pool), /Refusing to remove populated tax identity approval history/);
    assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id='0496_handyman_tax_identity_approval'")).rows[0].n, 1);
  });
});
