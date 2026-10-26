import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import type { Response } from 'supertest';
import { closePool, getPool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { credentialService, sessionService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
import {
  acceptHandymanBast, computeHandymanBastCustomerConsentDigest, handymanBastRepository,
  hasVerifiedHandymanBastCustomerAcceptance, issueHandymanBast, prepareHandymanBast,
  serializeHandymanBastCustomerConsent, toHandymanBastAcceptanceReadContract,
  voidHandymanBast,
} from '../src/modules/handyman-bast';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanEvidenceFile, createHandymanEvidenceRecord, finalizeHandymanEvidenceRecord,
  openHandymanQcRun,
} from '../src/modules/handyman-evidence-qc';
import {
  executeHandymanManagerFinalClose, getHandymanFinalCloseReadiness,
} from '../src/modules/handyman-finance-close-api/handyman-final-close.service';
import { bootstrapOwner } from '../src/modules/iam-bootstrap/owner-bootstrap.service';
import { OWNER_ROLE_CODE } from '../src/modules/iam-bootstrap/iam-canonical-roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleRepository, roleService } from '../src/modules/roles';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import {
  approveHandymanServiceWarrantyClaim, openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import { proposeHandymanServiceWarrantyRework } from '../src/modules/handyman-service-warranty-reworks';
import { proposeHandymanChargeableAdditionalWork } from '../src/modules/handyman-chargeable-additional-works';
import { tenantPicRepository } from '../src/modules/tenant-pics';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { handymanCustomerConsentInput, handymanCustomerForScope } from './helpers/handyman-customer-consent';
import { baseFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { arrangeGuardedBast, runGuardedQcCycle } from './helpers/handyman-guarded-bast';
import { api } from './helpers/http';

/** PART 04 only: real migrated disposable PostgreSQL, real local sessions,
 * genuine versioned Supervisor QC + stored bytes. SQL is used only for
 * observation, explicit legacy/invalid prestates and rollback injection.
 * No external database, deployed service, skipped test or full-suite glob.
 */
type Actor = { userId: string; token: string };
let pool: Pool;
let pg: EmbeddedPostgres;
let dir: string;
let admin: Actor;
let operations: Actor;
let care: Actor;
let manager: Actor;
let owner: Actor;
const key = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const post = (who: Actor, url: string, body: object) => api().post(`/api/v1/handyman/${url}`)
  .set('Authorization', `Bearer ${who.token}`).send(body);
const decide = (who: Actor, bastId: string, action: string, body: object) =>
  post(who, `bast/${bastId}/${action}`, body);
const relink = (picId: string, userId: string) => api().patch(`/api/v1/tenant-pics/${picId}`)
  .set('Authorization', `Bearer ${admin.token}`).send({ userId });

async function grant(userId: string, codes: string[]) {
  const role = await roleService.createRole({ code: `P04_${key().slice(0, 8).toUpperCase()}`, name: 'Explicit test grant' });
  for (const code of codes) {
    const permission = await permissionRepository.findByCode(code);
    assert.ok(permission);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}
async function canonicalStaff(code: string): Promise<Actor> {
  const token = await createPlainSession();
  const { userId } = await sessionService.resolveSessionContext(token);
  const role = await roleRepository.findByCode(code);
  assert.ok(role);
  await roleService.assignRoleToUser(userId, role.id);
  // Not a default-role change: even an explicit generic manage grant must
  // not turn Operations/Care/Manager into this request's customer.
  await grant(userId, ['tenant_company.manage', 'tenant_company.read']);
  return { token, userId };
}
async function newCustomerActor(): Promise<Actor> {
  const token = await createSessionWithPermissions([
    { code: 'tenant_company.manage', name: 'Manage tenant' },
    { code: 'tenant_company.read', name: 'Read tenant' },
  ]);
  return { token, userId: (await sessionService.resolveSessionContext(token)).userId };
}
async function loginCustomer(scopeId: string): Promise<Actor> {
  const customer = await handymanCustomerForScope(scopeId);
  const password = `P04-${key()}-Aa1`;
  await credentialService.createInitialCredential({ userId: customer.id, password });
  const response = await api().post('/api/v1/auth/login').send({ email: customer.email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { userId: customer.id, token: response.body.data.sessionToken };
}
async function fixture(until: 'DRAFT' | 'ISSUED' | 'ACCEPTED' = 'ISSUED') {
  const f = await arrangeGuardedBast({ adminUserId: admin.userId, q, until });
  const customer = await loginCustomer(f.scope.id);
  const replacement = await newCustomerActor();
  for (const who of [operations, care, manager, owner, replacement]) {
    await buildingAssignmentService.createAssignment(who.userId, { buildingId: f.scope.buildingId });
  }
  return { ...f, customer, replacement };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Complete rows, not just counts: all handyman_* tables AND the actual
// tenant_invoice* families, evidence_submissions and FM work_orders. The
// Handyman Work Order is the execution scope; neither money nor FM may change.
let observedTables: string[];
async function state() {
  if (!observedTables) observedTables = (await q(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND (table_name LIKE 'handyman_%' OR table_name LIKE 'tenant_invoice%'
        OR table_name IN ('operational_events', 'evidence_submissions', 'work_orders'))
    ORDER BY table_name`)).rows.map((r) => r.table_name);
  const result: Record<string, unknown[]> = {};
  for (const table of observedTables) result[table] = (await q(`SELECT * FROM ${table} snapshot_row ORDER BY to_jsonb(snapshot_row)::text`)).rows;
  return result;
}
async function denied(request: () => PromiseLike<Response>, status: number, code: string) {
  const before = await state();
  const response = await request();
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  assert.deepEqual(await state(), before, 'zero BAST/Work Order/QC/invoice/payment/ledger/warranty/close/history changes');
  return response;
}
async function acceptBody(f: Fixture, evidenceRecordId: string | null = null) {
  const consent = await handymanCustomerConsentInput(f.bastId, f.customer.userId, { evidenceRecordId });
  return { idempotencyKey: key(), signatureDigest: consent.signatureDigest, evidenceRecordId };
}
async function consentAttachment(f: Fixture, options: { finalized?: boolean; empty?: boolean; forgedDigest?: boolean } = {}) {
  const { record } = await createHandymanEvidenceRecord({
    executionScopeId: f.scope.id, stage: 'AFTER', idempotencyKey: key(),
  }, f.crew.leadUser.id);
  const storageKey = evidenceStorageKey(key());
  const bytes = Buffer.from(`Consent attachment ${key()}`);
  await createEvidenceStorage().put(storageKey, { buffer: bytes, mimeType: 'application/pdf' });
  if (!options.empty) await addHandymanEvidenceFile({
    evidenceRecordId: record.id, mediaKind: 'DOCUMENT', storageKey,
    contentType: 'application/pdf', byteSize: bytes.byteLength,
    sha256Digest: options.forgedDigest ? 'a'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
    idempotencyKey: key(),
  }, f.crew.leadUser.id);
  if (options.finalized !== false) await finalizeHandymanEvidenceRecord({
    evidenceRecordId: record.id, idempotencyKey: key(),
  }, f.crew.leadUser.id);
  return { record, storageKey, bytes };
}
async function history(f: Fixture) {
  const bast = await handymanBastRepository.findBastById(pool, f.bastId);
  assert.ok(bast);
  return {
    bast, events: await handymanBastRepository.listEventsByBastId(pool, bast.id),
    signOffs: await handymanBastRepository.listSignOffsByBastId(pool, bast.id),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function enteredBeforeResponse(entered: Promise<void>, pending: Promise<Response>) {
  await Promise.race([entered, pending.then((r) => { throw new Error(`Expected transaction barrier, got ${r.status}: ${JSON.stringify(r.body)}`); })]);
}
async function waitForBlockedQuery(fragment: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await q(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE $1) AS blocked`,
    [`%${fragment}%`]);
    if (result.rows[0].blocked) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`No observed PostgreSQL lock wait for ${fragment}`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-bast-consent-p04-'));
  process.env.EVIDENCE_STORAGE_DIR = join(dir, 'evidence');
  resetAppConfigCache();
  const port = 55287;
  pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'password', persistent: false });
  await pg.initialise();
  await pg.start();
  pool = await initDatabase({ host: '127.0.0.1', port, name: 'postgres', user: 'postgres', password: 'password',
    ssl: false, poolMin: 1, poolMax: 16 });
  await migrateUp(pool);
  await bootstrapOwner({ email: 'part04-owner@example.com', displayName: 'PART04 Owner', password: 'Part04OwnerPass123' });
  admin = await createAdminUser();
  operations = await canonicalStaff('OPERATIONS');
  care = await canonicalStaff('CUSTOMER_CARE');
  manager = await canonicalStaff('MANAGER');
  owner = await canonicalStaff(OWNER_ROLE_CODE);
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin.userId, disciplineId: discipline.id, query: q });
});
after(async () => {
  try { if (pool) await closePool(pool); }
  finally {
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.EVIDENCE_STORAGE_DIR;
    resetAppConfigCache();
  }
});

describe('PART 04 personal customer BAST consent', () => {
  it('pins independent V1 UTF-8 array serialization, SHA-256, nulls and stable file order', async () => {
    const f = await fixture();
    const { manifest } = await handymanCustomerConsentInput(f.bastId, f.customer.userId);
    const vector = JSON.stringify([
      'HM-BAST-CUSTOMER-CONSENT-SHA256-V1', f.bastId, f.scope.id, f.scope.approvedQuotationVersionId, f.scope.clientId,
      f.scope.handymanRequestId, f.scope.tenantCompanyId, f.scope.tenantPicId, f.scope.buildingId,
      `BAST/${f.bastId}/v2`, 2, manifest.issueEventId, manifest.issuedAt, f.qcRunId,
      f.customer.userId, 'ACCEPT', null, null,
    ]);
    assert.equal(serializeHandymanBastCustomerConsent(manifest), vector);
    assert.equal(computeHandymanBastCustomerConsentDigest(manifest), createHash('sha256').update(vector, 'utf8').digest('hex'));
    const files = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
      .map((id) => ({ id, mediaKind: 'DOCUMENT', contentType: 'application/pdf', byteSize: 12, sha256Digest: 'a'.repeat(64) }));
    manifest.evidence = { recordId: key(), finalizeEventId: key(), files };
    const first = computeHandymanBastCustomerConsentDigest(manifest);
    manifest.evidence.files.reverse();
    assert.equal(computeHandymanBastCustomerConsentDigest(manifest), first);
    manifest.decision = 'REJECT'; manifest.rejectReason = ' Perbaikan belum selesai ✓ '.trim();
    assert.notEqual(computeHandymanBastCustomerConsentDigest(manifest), first);
  });

  it('provider prepare/issue + quote approval + Supervisor QC do not become customer acceptance', async () => {
    const f = await fixture();
    const h = await history(f);
    assert.equal(h.bast.status, 'ISSUED');
    assert.deepEqual(h.events.map((e) => e.eventType), ['PREPARE', 'ISSUE']);
    assert.equal(h.signOffs.length, 0);
    assert.equal(h.bast.acceptedAt, null);
    assert.equal(toHandymanBastAcceptanceReadContract(h.bast, h.events, h.signOffs).customerAccepted, false);
    assert.equal(await hasVerifiedHandymanBastCustomerAcceptance(pool, f.bastId), false);
    await assert.rejects(startHandymanServiceWarranty({ executionScopeId: f.scope.id, idempotencyKey: key() }, admin.userId),
      (e: any) => e.code === 'HANDYMAN_SERVICE_WARRANTY_NOT_ELIGIBLE');
  });

  it('personal PIC accepts exact issued v2; immutable actor/time/roots/digest qualify reads, warranty and only the BAST close gate', async () => {
    const f = await fixture();
    const before = await getHandymanFinalCloseReadiness(f.scope.id, admin.userId);
    assert.equal(before.gates.bastAccepted, false);
    const body = await acceptBody(f);
    const accepted = await decide(f.customer, f.bastId, 'accept', body);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const data = accepted.body.data;
    assert.equal(data.acceptance.customerAccepted, true);
    assert.equal(data.acceptance.signOffComplete, true);
    assert.equal(data.acceptance.warrantyStartEligible, true);
    assert.equal(data.acceptance.artifactRef, `BAST/${f.bastId}/v3`);
    assert.equal(data.event.actorUserId, f.customer.userId);
    const h = await history(f);
    const event = h.events.find((e) => e.eventType === 'ACCEPT')!;
    const receipt: any = event.metadata!.customerConsent;
    assert.equal(receipt.method, 'AUTHENTICATED_REQUEST_PIC');
    assert.equal(receipt.manifest.issuedArtifactRef, `BAST/${f.bastId}/v2`);
    assert.equal(receipt.manifest.tenantPicId, f.scope.tenantPicId);
    assert.equal(receipt.manifest.handymanRequestId, f.scope.handymanRequestId);
    assert.equal(receipt.manifest.tenantCompanyId, f.scope.tenantCompanyId);
    assert.equal(receipt.manifest.buildingId, f.scope.buildingId);
    assert.equal(receipt.manifest.actorUserId, f.customer.userId);
    assert.equal(receipt.sha256Digest, body.signatureDigest);
    assert.equal(event.occurredAt.toISOString(), h.bast.acceptedAt!.toISOString());
    assert.equal(h.signOffs[0]!.createdAt.toISOString(), event.occurredAt.toISOString());
    const after = await getHandymanFinalCloseReadiness(f.scope.id, admin.userId);
    assert.equal(after.gates.bastAccepted, true);
    assert.equal(after.eligibleForFinalClose, false, 'consent is not invoice, payment or Manager final close');
    assert.ok(after.blockers.some((b) => ['LEDGER_TRANSACTION_NOT_OPEN', 'FINAL_INVOICE_NOT_FINALIZED'].includes(b.code)));
    const untouched = await state();
    await assert.rejects(executeHandymanManagerFinalClose({ executionScopeId: f.scope.id, reason: 'No payment bypass', idempotencyKey: key() }, admin.userId));
    assert.deepEqual(await state(), untouched);
    const warranty = await startHandymanServiceWarranty({ executionScopeId: f.scope.id, idempotencyKey: key() }, admin.userId);
    assert.equal(warranty.warranty.bastId, f.bastId);
    assert.equal(new Date(warranty.warranty.startsAt).toISOString(), h.bast.acceptedAt!.toISOString());
  });

  it('personal PIC rejects explicitly without a client digest; backend records the canonical rejection proof', async () => {
    const f = await fixture();
    const rejected = await decide(f.customer, f.bastId, 'reject', { idempotencyKey: key(), rejectReason: 'Repair remains incomplete' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.bast.status, 'REJECTED');
    assert.equal(rejected.body.data.acceptance.customerAccepted, false);
    assert.match(rejected.body.data.signOff.signatureDigest, /^[a-f0-9]{64}$/);
    assert.equal(rejected.body.data.event.actorUserId, f.customer.userId);
    const expected = await handymanCustomerConsentInput(f.bastId, f.customer.userId, {
      decision: 'REJECT', rejectReason: 'Repair remains incomplete',
    });
    assert.equal(rejected.body.data.signOff.signatureDigest, expected.signatureDigest);
    await assert.rejects(prepareHandymanBast(admin.userId, { executionScopeId: f.scope.id, idempotencyKey: key() }),
      (e: any) => e.code === 'HANDYMAN_BAST_QC_NOT_READY');
  });

  for (const decision of ['ACCEPT', 'REJECT'] as const) {
    it(`/sign-off is the same personal customer ${decision} decision, never provider signing`, async () => {
      const f = await fixture();
      const consent = await handymanCustomerConsentInput(f.bastId, f.customer.userId, { decision });
      const response = await decide(f.customer, f.bastId, 'sign-off', { decision, idempotencyKey: key(), signatureDigest: consent.signatureDigest });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.event.actorUserId, f.customer.userId);
      assert.equal(response.body.data.bast.status, decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED');
    });
  }

  for (const role of ['Operations', 'Care', 'Manager', 'Owner', 'admin', 'current Lead'] as const) {
    it(`${role} with exact Building and generic manage cannot ACCEPT, REJECT or use /sign-off as the customer`, async () => {
      const f = await fixture();
      let who = ({ Operations: operations, Care: care, Manager: manager, Owner: owner, admin } as any)[role] as Actor;
      if (role === 'current Lead') {
        await grant(f.crew.leadUser.id, ['tenant_company.manage']);
        who = { userId: f.crew.leadUser.id, token: '' };
        const password = `Lead-${key()}-Aa1`;
        await credentialService.createInitialCredential({ userId: who.userId, password });
        const login = await api().post('/api/v1/auth/login').send({ email: f.crew.leadUser.email, password });
        assert.equal(login.status, 200);
        who.token = login.body.data.sessionToken;
      }
      const digest = (await handymanCustomerConsentInput(f.bastId, who.userId)).signatureDigest;
      for (const action of ['accept', 'reject', 'sign-off']) await denied(async () => decide(who, f.bastId, action, {
        idempotencyKey: key(), signatureDigest: digest, ...(action === 'sign-off' ? { decision: 'ACCEPT' } : {}),
      }), 403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    });
  }

  it('requires a real authenticated session, not a digest or body signer', async () => {
    const f = await fixture();
    await denied(async () => api().post(`/api/v1/handyman/bast/${f.bastId}/accept`).send(await acceptBody(f)),
      401, 'AUTHENTICATION_REQUIRED');
  });

  it('denies a foreign customer even after explicit access to the target Building', async () => {
    const f = await fixture();
    const foreign = await baseFixture();
    const who = await handymanCustomerForScope(foreign.scope.id);
    await grant(who.id, ['tenant_company.manage']);
    const foreignActor = await loginCustomer(foreign.scope.id);
    await buildingAssignmentService.createAssignment(who.id, { buildingId: f.scope.buildingId });
    await denied(async () => decide(foreignActor, f.bastId, 'accept', await acceptBody(f)),
      403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
  });

  it('denies a current PIC without the exact Building, despite generic manage and correct digest', async () => {
    const f = await fixture();
    await q(`UPDATE user_building_assignments SET status = 'INACTIVE' WHERE user_id = $1 AND building_id = $2`,
      [f.customer.userId, f.scope.buildingId]);
    await denied(async () => decide(f.customer, f.bastId, 'accept', await acceptBody(f)), 403, 'BUILDING_ACCESS_DENIED');
  });

  for (const root of ['PIC', 'Company', 'occupancy', 'account'] as const) {
    it(`does not bypass inactive/expired ${root} authority`, async () => {
      const f = await fixture();
      const body = await acceptBody(f);
      if (root === 'PIC') await q(`UPDATE tenant_pics SET status = 'INACTIVE' WHERE id = $1`, [f.scope.tenantPicId]);
      if (root === 'Company') await q(`UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1`, [f.scope.tenantCompanyId]);
      if (root === 'occupancy') await q(`UPDATE tenant_space_relationships SET effective_until = NOW() - INTERVAL '1 hour' WHERE tenant_company_id = $1`, [f.scope.tenantCompanyId]);
      if (root === 'account') await q(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [f.customer.userId]);
      const before = await state();
      await assert.rejects(acceptHandymanBast(f.customer.userId, { ...body, bastId: f.bastId }),
        (e: any) => e.code === 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
      assert.deepEqual(await state(), before);
    });
  }

  it('denies arbitrary and merely well-formed SHA-256 digests from the real customer', async () => {
    const f = await fixture();
    for (const signatureDigest of ['provider-says-customer-signed', '0'.repeat(64)]) {
      await denied(async () => decide(f.customer, f.bastId, 'accept', { idempotencyKey: key(), signatureDigest }),
        400, 'HANDYMAN_BAST_VALIDATION');
    }
  });

  it('rejects signer/customer/scope/delegate/metadata body claims rather than adopting them', async () => {
    const f = await fixture();
    const body = await acceptBody(f);
    for (const field of ['actorUserId', 'signerUserId', 'customerUserId', 'tenantCompanyId', 'tenantPicId',
      'buildingId', 'executionScopeId', 'bastId', 'version', 'delegateId', 'metadata']) {
      await denied(async () => decide(f.customer, f.bastId, 'accept', { ...body, [field]: key() }), 400, 'VALIDATION_ERROR');
    }
  });

  it('binds every document/root/actor/decision/evidence input, not just digest syntax', async () => {
    const f = await fixture();
    const { manifest } = await handymanCustomerConsentInput(f.bastId, f.customer.userId);
    const changes = [
      { bastId: key() }, { executionScopeId: key() }, { approvedQuotationVersionId: key() }, { clientId: key() }, { handymanRequestId: key() },
      { tenantCompanyId: key() }, { tenantPicId: key() }, { buildingId: key() },
      { issuedArtifactRef: `BAST/${f.bastId}/v3`, issuedArtifactVersion: 3 },
      { issueEventId: key() }, { issuedAt: new Date(0).toISOString() }, { qcRunId: key() },
      { actorUserId: admin.userId }, { decision: 'REJECT' }, { rejectReason: 'Changed intent' },
      { evidence: { recordId: key(), finalizeEventId: key(), files: [] } },
    ];
    for (const change of changes) {
      const signatureDigest = computeHandymanBastCustomerConsentDigest({ ...manifest, ...change } as any);
      await denied(async () => decide(f.customer, f.bastId, 'accept', { idempotencyKey: key(), signatureDigest }),
        400, 'HANDYMAN_BAST_VALIDATION');
    }
  });

  it('binds a finalized same-scope attachment and verifies real stored bytes before accepting', async () => {
    const f = await fixture();
    const attachment = await consentAttachment(f);
    const body = await acceptBody(f, attachment.record.id);
    const response = await decide(f.customer, f.bastId, 'accept', body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt: any = (await history(f)).events.find((e) => e.eventType === 'ACCEPT')!.metadata!.customerConsent;
    assert.equal(receipt.manifest.evidence.recordId, attachment.record.id);
    assert.equal(receipt.manifest.evidence.files.length, 1);
    assert.equal(receipt.manifest.evidence.files[0].sha256Digest, createHash('sha256').update(attachment.bytes).digest('hex'));
    // Replay is the original fact, not a fresh byte/QC attestation.
    const before = await state();
    await createEvidenceStorage().remove(attachment.storageKey);
    const replay = await decide(f.customer, f.bastId, 'accept', body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.deepEqual(await state(), before);
  });

  for (const mode of ['unfinalized', 'empty', 'missing bytes', 'tampered bytes', 'forged file digest', 'foreign scope'] as const) {
    it(`fails closed for ${mode} consent evidence without partial mutation`, async () => {
      const f = await fixture();
      const target = mode === 'foreign scope' ? await fixture() : f;
      const attachment = await consentAttachment(target, {
        finalized: mode !== 'unfinalized', empty: mode === 'empty', forgedDigest: mode === 'forged file digest',
      });
      let body = { idempotencyKey: key(), signatureDigest: '0'.repeat(64), evidenceRecordId: attachment.record.id };
      if (!['unfinalized', 'empty', 'foreign scope'].includes(mode)) body = await acceptBody(f, attachment.record.id);
      if (mode === 'missing bytes') await createEvidenceStorage().remove(attachment.storageKey);
      if (mode === 'tampered bytes') await createEvidenceStorage().put(attachment.storageKey, { buffer: Buffer.from('corrupted'), mimeType: 'application/pdf' });
      await denied(async () => decide(f.customer, f.bastId, 'accept', body), 400, 'HANDYMAN_BAST_VALIDATION');
    });
  }

  it('cannot accept/reject an unissued document', async () => {
    const f = await fixture('DRAFT');
    for (const action of ['accept', 'reject']) await denied(async () => decide(f.customer, f.bastId, action,
      { idempotencyKey: key(), signatureDigest: '0'.repeat(64) }), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
  });

  it('fails closed when an issued-looking legacy head has no immutable ISSUE manifest', async () => {
    const f = await fixture('DRAFT');
    await handymanBastRepository.updateBastStatus(pool, f.bastId, 'ISSUED', 'DRAFT');
    const response = await denied(async () => decide(f.customer, f.bastId, 'accept', {
      idempotencyKey: key(), signatureDigest: '0'.repeat(64),
    }), 400, 'HANDYMAN_BAST_VALIDATION');
    assert.match(response.body.error.message, /immutable issued BAST manifest is unavailable/);
  });

  it('cannot use a void/stale issued digest on a replacement BAST', async () => {
    const f = await fixture();
    const stale = await acceptBody(f);
    await voidHandymanBast(admin.userId, { bastId: f.bastId, idempotencyKey: key(), voidReason: 'Replace document' });
    const next = await prepareHandymanBast(admin.userId, { executionScopeId: f.scope.id, idempotencyKey: key() });
    await issueHandymanBast(admin.userId, { bastId: next.bast.id, idempotencyKey: key() });
    await denied(async () => decide(f.customer, f.bastId, 'accept', stale), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
    await denied(async () => decide(f.customer, next.bast.id, 'accept', stale), 400, 'HANDYMAN_BAST_VALIDATION');
    const fresh = await handymanCustomerConsentInput(next.bast.id, f.customer.userId);
    const response = await decide(f.customer, next.bast.id, 'accept', { idempotencyKey: key(), signatureDigest: fresh.signatureDigest });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });

  for (const qc of ['OPEN', 'FAILED', 'newer PASS'] as const) {
    it(`does not accept against ${qc} latest QC instead of this issued BAST's guarded PASS`, async () => {
      const f = await fixture();
      const body = await acceptBody(f);
      if (qc === 'OPEN') await openHandymanQcRun({ executionScopeId: f.scope.id, checklistIdentity: 'HANDYMAN_FINAL@v1', idempotencyKey: key() }, f.supervisorUserId);
      else await runGuardedQcCycle({
        clientId: f.scope.clientId, tenantCompanyId: f.scope.tenantCompanyId, buildingId: f.scope.buildingId,
        handymanRequestId: f.scope.handymanRequestId, executionScopeId: f.scope.id,
        adminUserId: admin.userId, supervisorUserId: f.supervisorUserId, uploaderUserId: f.crew.leadUser.id, q,
        item: qc === 'FAILED' ? 'DEFECT' : 'PASS',
      });
      await denied(async () => decide(f.customer, f.bastId, 'accept', body), 409, 'HANDYMAN_BAST_QC_NOT_READY');
      if (qc !== 'newer PASS') {
        const rejected = await decide(f.customer, f.bastId, 'reject', { idempotencyKey: key(), rejectReason: 'QC unresolved' });
        assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      }
    });
  }

  it('same actor/key/payload replays the original receipt; new keys or changed intent cannot duplicate it', async () => {
    const f = await fixture();
    const body = await acceptBody(f);
    const first = await decide(f.customer, f.bastId, 'accept', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const before = await state();
    const replay = await decide(f.customer, f.bastId, 'sign-off', { ...body, decision: 'ACCEPT' });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.event.id, first.body.data.event.id);
    assert.equal(replay.body.data.signOff.id, first.body.data.signOff.id);
    assert.deepEqual(await state(), before);
    await denied(async () => decide(f.customer, f.bastId, 'accept', { ...body, signatureDigest: '0'.repeat(64) }), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
    await denied(async () => decide(f.customer, f.bastId, 'accept', { ...body, idempotencyKey: key() }), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
    await denied(async () => decide(f.customer, f.bastId, 'reject', { idempotencyKey: body.idempotencyKey }), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
  });

  it('same rejection key cannot rewrite the reason, decision or evidence', async () => {
    const f = await fixture();
    const body = { idempotencyKey: key(), rejectReason: 'Original reason' };
    const first = await decide(f.customer, f.bastId, 'reject', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const replay = await decide(f.customer, f.bastId, 'reject', { ...body, rejectReason: ' Original reason ' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    await denied(async () => decide(f.customer, f.bastId, 'reject', { ...body, rejectReason: 'Different reason' }), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
    await denied(async () => decide(f.customer, f.bastId, 'reject', { ...body, evidenceRecordId: key() }), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
  });

  for (const mode of ['duplicate ACCEPT', 'ACCEPT versus REJECT'] as const) {
    it(`serializes concurrent ${mode} into one immutable decision`, async () => {
      const f = await fixture();
      const body = await acceptBody(f);
      const second = mode === 'duplicate ACCEPT' ? decide(f.customer, f.bastId, 'accept', body)
        : decide(f.customer, f.bastId, 'reject', { idempotencyKey: key(), rejectReason: 'Not complete' });
      const results = await Promise.all([decide(f.customer, f.bastId, 'accept', body), second]);
      assert.deepEqual(results.map((r) => r.status).sort(), mode === 'duplicate ACCEPT' ? [200, 200] : [200, 409]);
      if (mode === 'duplicate ACCEPT') assert.deepEqual(results.map((r) => r.body.data.replayed).sort(), [false, true]);
      const h = await history(f);
      assert.equal(h.events.filter((e) => ['ACCEPT', 'REJECT'].includes(e.eventType)).length, 1);
      assert.equal(h.signOffs.length, 1);
      assert.equal((await q(`SELECT status FROM handyman_execution_scopes WHERE id = $1`, [f.scope.id])).rows[0].status, 'AUTHORIZED');
    });
  }

  it('customer consent and provider VOID serialize without a scope/BAST lock inversion', async () => {
    const f = await fixture();
    const body = await acceptBody(f);
    await grant(f.crew.leadUser.id, ['handyman.bast.manage']);
    const password = `Void-${key()}-Aa1`;
    await credentialService.createInitialCredential({ userId: f.crew.leadUser.id, password });
    const login = await api().post('/api/v1/auth/login').send({ email: f.crew.leadUser.email, password });
    assert.equal(login.status, 200);
    const worker: Actor = { userId: f.crew.leadUser.id, token: login.body.data.sessionToken };
    const results = await Promise.all([
      decide(f.customer, f.bastId, 'accept', body),
      post(worker, `field/bast/${f.bastId}/void`, { idempotencyKey: key(), expectedVersion: 2, reason: 'Provider withdraws issued document' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const h = await history(f);
    assert.ok(['ACCEPTED', 'VOID'].includes(h.bast.status));
    assert.equal(h.signOffs.length, h.bast.status === 'ACCEPTED' ? 1 : 0);
    assert.equal(h.events.filter((e) => ['ACCEPT', 'VOID'].includes(e.eventType)).length, 1);
  });

  it('keeps all consent/authority/QC reads on the transaction when only one pool slot is available', { timeout: 30_000 }, async () => {
    const f = await fixture();
    const body = await acceptBody(f);
    const reserved: PoolClient[] = [];
    let pending: Promise<Response> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let i = 1; i < (pool.options.max ?? 10); i++) reserved.push(await pool.connect());
      pending = decide(f.customer, f.bastId, 'accept', body).then((r) => r);
      const response = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Consent attempted a nested pool checkout')), 10_000);
      })]);
      assert.equal(response.status, 200, JSON.stringify(response.body));
    } finally {
      if (timer) clearTimeout(timer);
      for (const client of reserved) client.release();
      if (pending) await pending;
    }
  });

  it('consent wins a relink race: observed PIC row lock, original actor remains immutable; replacement cannot adopt replay', { timeout: 30_000 }, async (t) => {
    const f = await fixture();
    const body = await acceptBody(f);
    const entered = deferred(); const release = deferred();
    const original = handymanBastRepository.insertSignOff;
    const mocked = t.mock.method(handymanBastRepository, 'insertSignOff', async (...args: Parameters<typeof original>) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    let consent: Promise<Response> | undefined; let changed: Promise<Response> | undefined;
    try {
      consent = decide(f.customer, f.bastId, 'accept', body).then((r) => r);
      await enteredBeforeResponse(entered.promise, consent);
      changed = relink(f.scope.tenantPicId, f.replacement.userId).then((r) => r);
      await waitForBlockedQuery('FROM tenant_pics WHERE id = $1 FOR UPDATE');
      release.resolve();
      const [accepted, linked] = await Promise.all([consent, changed]);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      const h = await history(f);
      assert.equal(h.events.find((e) => e.eventType === 'ACCEPT')!.actorUserId, f.customer.userId);
      assert.equal(toHandymanBastAcceptanceReadContract(h.bast, h.events, h.signOffs).customerAccepted, true, 'later relink does not erase historical consent');
      await denied(async () => decide(f.customer, f.bastId, 'accept', body), 403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
      await denied(async () => decide(f.replacement, f.bastId, 'accept', body), 409, 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
    } finally { release.resolve(); await Promise.allSettled([consent, changed].filter(Boolean)); mocked.mock.restore(); }
  });

  it('relink wins a consent race: observed authority share-lock wait; old personal session cannot sign after commit', { timeout: 30_000 }, async (t) => {
    const f = await fixture();
    const body = await acceptBody(f);
    const entered = deferred(); const release = deferred();
    const original = tenantPicRepository.update;
    const mocked = t.mock.method(tenantPicRepository, 'update', async (...args: Parameters<typeof original>) => {
      const result = await original(...args); entered.resolve(); await release.promise; return result;
    });
    let consent: Promise<Response> | undefined; let changed: Promise<Response> | undefined;
    const before = await state();
    try {
      changed = relink(f.scope.tenantPicId, f.replacement.userId).then((r) => r);
      await enteredBeforeResponse(entered.promise, changed);
      consent = decide(f.customer, f.bastId, 'accept', body).then((r) => r);
      await waitForBlockedQuery('FROM handyman_service_requests r');
      release.resolve();
      const [linked, deniedConsent] = await Promise.all([changed, consent]);
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(deniedConsent.status, 403, JSON.stringify(deniedConsent.body));
      assert.equal(deniedConsent.body.error.code, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
      const after = await state();
      delete before.operational_events; delete after.operational_events; // only legitimate relink audit changes
      assert.deepEqual(after, before);
      const h = await history(f);
      assert.equal(h.bast.status, 'ISSUED'); assert.equal(h.signOffs.length, 0);
    } finally { release.resolve(); await Promise.allSettled([consent, changed].filter(Boolean)); mocked.mock.restore(); }
  });

  for (const failedTable of ['handyman_bast_events', 'handyman_bast_sign_offs']) {
    it(`rolls back head/history and all downstream state if ${failedTable} insertion fails`, async () => {
      const f = await fixture();
      const body = await acceptBody(f);
      await q(`CREATE FUNCTION part04_fail_consent() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'PART04 consent persistence rollback probe'; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER part04_fail_consent BEFORE INSERT ON ${failedTable}
        FOR EACH ROW EXECUTE FUNCTION part04_fail_consent()`);
      try { await denied(async () => decide(f.customer, f.bastId, 'accept', body), 500, 'INTERNAL_SERVER_ERROR'); }
      finally { await q(`DROP TRIGGER part04_fail_consent ON ${failedTable}; DROP FUNCTION part04_fail_consent()`); }
    });
  }

  it('database forbids rewriting/deleting recorded consent, signature and provenance', async () => {
    const f = await fixture('ACCEPTED');
    const h = await history(f);
    const event = h.events.find((e) => e.eventType === 'ACCEPT')!;
    const before = await state();
    for (const sql of [
      `UPDATE handyman_bast_events SET actor_user_id = '${admin.userId}' WHERE id = '${event.id}'`,
      `UPDATE handyman_bast_events SET metadata = '{}' WHERE id = '${event.id}'`,
      `DELETE FROM handyman_bast_events WHERE id = '${event.id}'`,
      `UPDATE handyman_bast_sign_offs SET signature_digest = 'forged' WHERE event_id = '${event.id}'`,
      `DELETE FROM handyman_bast_sign_offs WHERE event_id = '${event.id}'`,
    ]) await assert.rejects(q(sql));
    assert.deepEqual(await state(), before);
  });

  it('preserves legacy staff/digest-only accepted history but never certifies it for read/warranty/final-close', async () => {
    const f = await fixture();
    const customerDigest = (await acceptBody(f)).signatureDigest;
    await withTransaction(async (tx) => {
      await handymanBastRepository.updateBastStatus(tx, f.bastId, 'ACCEPTED', 'ISSUED');
      const event = await handymanBastRepository.insertEvent(tx, {
        clientId: f.scope.clientId, bastId: f.bastId, executionScopeId: f.scope.id,
        eventType: 'ACCEPT', actorUserId: admin.userId, idempotencyKey: key(), // pre-PART04 staff assertion
      });
      await handymanBastRepository.insertSignOff(tx, {
        clientId: f.scope.clientId, bastId: f.bastId, executionScopeId: f.scope.id, eventId: event.id,
        decision: 'ACCEPT', signatureDigest: customerDigest, evidenceRecordId: null, rejectReason: null,
      });
    });
    const h = await history(f);
    const read = toHandymanBastAcceptanceReadContract(h.bast, h.events, h.signOffs);
    assert.equal(read.status, 'ACCEPTED'); assert.ok(read.acceptedAt);
    assert.equal(read.customerAccepted, false); assert.equal(read.signOffComplete, false);
    assert.equal(read.warrantyStartEligible, false);
    assert.equal(await hasVerifiedHandymanBastCustomerAcceptance(pool, f.bastId), false);
    const before = await state();
    const readiness = await getHandymanFinalCloseReadiness(f.scope.id, admin.userId);
    assert.equal(readiness.gates.bastAccepted, false);
    assert.ok(readiness.blockers.some((b) => b.code === 'BAST_SIGN_OFF_MISSING'));
    await assert.rejects(startHandymanServiceWarranty({ executionScopeId: f.scope.id, idempotencyKey: key() }, admin.userId),
      (e: any) => e.code === 'HANDYMAN_SERVICE_WARRANTY_NOT_ELIGIBLE');
    assert.deepEqual(await state(), before);
  });
});

async function warrantyClaimFixture() {
  const f = await fixture('ACCEPTED');
  const { warranty } = await startHandymanServiceWarranty({ executionScopeId: f.scope.id, idempotencyKey: key() }, admin.userId);
  const { record } = await createHandymanEvidenceRecord({ executionScopeId: f.scope.id, stage: 'DEFECT', idempotencyKey: key() }, f.crew.leadUser.id);
  const opened = await openHandymanServiceWarrantyClaim(admin.userId, { warrantyId: warranty.id, evidenceRecordId: record.id, idempotencyKey: key() });
  await submitHandymanServiceWarrantyClaim(admin.userId, { claimId: opened.claim.id, idempotencyKey: key() });
  const approved = await approveHandymanServiceWarrantyClaim(admin.userId, { claimId: opened.claim.id, decisionNote: 'Confirmed defect', idempotencyKey: key() });
  return { ...f, warranty, claim: approved.claim };
}

describe('PART 04 related personal customer decisions retain existing engines', () => {
  it('only current personal PIC authorizes free rework, without handing provider staff the consent', async () => {
    const f = await warrantyClaimFixture();
    const proposed = await proposeHandymanServiceWarrantyRework(f.crew.leadUser.id, { claimId: f.claim.id, idempotencyKey: key() });
    const url = `service-warranty-reworks/${proposed.rework.id}/authorize`;
    for (const who of [operations, care, manager, admin]) await denied(async () => post(who, url, { idempotencyKey: key() }),
      403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    const body = { idempotencyKey: key() };
    const accepted = await post(f.customer, url, body);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.rework.authorizedByUserId, f.customer.userId);
    assert.equal(accepted.body.data.rework.status, 'REWORK_AUTHORIZED');
    const replay = await post(f.customer, url, body);
    assert.equal(replay.status, 200); assert.equal(replay.body.data.replayed, true);
    const changed = await relink(f.scope.tenantPicId, f.replacement.userId);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    await denied(async () => post(f.replacement, url, body), 409, 'HANDYMAN_SERVICE_WARRANTY_REWORK_CONFLICT');
  });

  for (const action of ['accept', 'reject'] as const) {
    it(`only current personal PIC may ${action} chargeable work; payment trigger remains atomic and decision-specific`, async () => {
      const f = await warrantyClaimFixture();
      const proposed = await proposeHandymanChargeableAdditionalWork(f.crew.leadUser.id, { claimId: f.claim.id, idempotencyKey: key() });
      const url = `chargeable-additional-works/${proposed.work.id}/${action}`;
      for (const who of [operations, care, manager, admin]) await denied(async () => post(who, url, { idempotencyKey: key() }),
        403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
      const body = { idempotencyKey: key() };
      const decided = await post(f.customer, url, body);
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      const events = (await q(`SELECT * FROM handyman_chargeable_additional_work_events WHERE work_id = $1 ORDER BY created_at, id`, [proposed.work.id])).rows;
      assert.equal(events.filter((e) => e.event_type === action.toUpperCase()).length, 1);
      assert.equal(events.filter((e) => e.event_type === 'PAYMENT_TRIGGER').length, action === 'accept' ? 1 : 0);
      for (const event of events.filter((e) => e.event_type !== 'PROPOSE')) assert.equal(event.actor_user_id, f.customer.userId);
      const replay = await post(f.customer, url, body);
      assert.equal(replay.status, 200); assert.equal(replay.body.data.replayed, true);
      assert.equal((await q(`SELECT count(*)::int AS n FROM handyman_chargeable_additional_work_events WHERE work_id = $1`, [proposed.work.id])).rows[0].n, events.length);
      const changed = await relink(f.scope.tenantPicId, f.replacement.userId);
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      await denied(async () => post(f.replacement, url, body), 409, 'HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_CONFLICT');
    });
  }
});
