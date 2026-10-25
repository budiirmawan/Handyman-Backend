import { migration0481HandymanCommercialConsentBridge } from '../src/database/migrations/0481_handyman_commercial_consent_bridge';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { arrangeGuardedQcPass, runGuardedQcCycle } from './helpers/handyman-guarded-bast';
import { bootstrapOwner } from '../src/modules/iam-bootstrap/owner-bootstrap.service';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanCareActorService, grantCareActorProperty, revokeCareActorProperty } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, revokeCareWorkspaceSession, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { issueCareCreateExchange } from '../src/modules/handyman-care-workspace/care-create-exchange.service';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceRequestRepository, recordHandymanRequestTriage, recordHandymanDiagnosis } from '../src/modules/handyman-requests';
import { createHandymanQuotation, addHandymanQuotationLine, issueHandymanQuotationVersion, supersedeHandymanQuotationVersion } from '../src/modules/handyman-quotations';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { prepareHandymanBast, issueHandymanBast, handymanBastRepository, hasVerifiedHandymanBastCustomerAcceptance, toHandymanBastAcceptanceReadContract, verifiedHandymanBastCustomerConsent } from '../src/modules/handyman-bast';
import { getHandymanFinalCloseReadiness } from '../src/modules/handyman-finance-close-api/handyman-final-close.service';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import {
  COMMERCIAL_CONSENT_PURPOSE, COMMERCIAL_CONSENT_METHOD, commercialConsentSecretEnvName,
  signCommercialConsentAssertion, type CommercialConsentAssertion,
} from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';

/** Real disposable DB, real signed workspace + actual commands/QC/bytes.
 * TEST issuer enrollment simulates the missing external BM verifier. It is
 * not shipped seed data or proof that a live human-verification integration exists. */
let db: EmbeddedTestDatabase, pool: Pool, storage: string, admin: { userId: string; token: string };
let disciplineId: string, code: string, integrationId: string, actorId: string, otherActorId: string, token: string, otherToken: string;
const HANDOFF_KEY = 'test-bm-care-workspace-signing-key-not-consent';
const CONSENT_KEY = 'test-independent-verified-customer-consent-key';
const key = () => randomUUID();
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const path = (requestId: string) => `/api/v1/handyman/care/requests/${requestId}`;
const post = (requestId: string, suffix: string, body: unknown, credential = token, signature?: string) => {
  const req = api().post(path(requestId) + suffix).set('Authorization', `Bearer ${credential}`);
  if (signature) req.set('x-handyman-commercial-consent-signature', signature);
  return req.send(body as any);
};
async function admit(reference: string) {
  const a: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: key(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: reference } };
  return (await admitCareWorkspace(a, signCareWorkspaceAssertion(a, HANDOFF_KEY))).workspaceToken;
}
before(async () => {
  db = await startEmbeddedTestDatabase({ dir: `/tmp/hm-commercial-bridge-${key()}`, port: 55289 });
  storage = mkdtempSync(join(tmpdir(), 'hm-commercial-bytes-'));
  process.env.EVIDENCE_STORAGE_DIR = storage; resetAppConfigCache();
  pool = await initDatabase({ host: '127.0.0.1', port: 55289, name: 'asentra_test', user: 'postgres', password: '', ssl: false, poolMin: 1, poolMax: 16 });
  await migrateUp(pool);
  await bootstrapOwner({ email: 'bridge-owner@example.com', displayName: 'Bridge test Owner', password: 'BridgeOwnerPass123' });
  admin = await createAdminUser();
  disciplineId = (await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'))!.id;
  initHandymanFixtures({ adminUserId: admin.userId, disciplineId, query: q });
  code = `BRIDGE_${key().slice(0, 8).toUpperCase()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'TEST BM customer verifier' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  actorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'care', displayName: 'Care recorder' })).id;
  otherActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'other', displayName: 'Other recorder' })).id;
  process.env[handoffIntegrationSecretEnvName(code)] = HANDOFF_KEY;
  token = await admit('care'); otherToken = await admit('other');
});
after(async () => {
  await closePool(pool); await db?.stop();
  if (storage) rmSync(storage, { recursive: true, force: true });
  if (code) { delete process.env[handoffIntegrationSecretEnvName(code)]; delete process.env[commercialConsentSecretEnvName(code)]; }
});
async function enroll(enabled = true) {
  await q('UPDATE handyman_handoff_integrations SET commercial_consent_contract_ref=$2 WHERE id=$1',
    [integrationId, enabled ? 'TEST-ONLY: BM independently verifies the real customer for each exact commercial decision' : null]);
  if (enabled) process.env[commercialConsentSecretEnvName(code)] = CONSENT_KEY;
  else delete process.env[commercialConsentSecretEnvName(code)];
}
async function fixture(contact = false, validityMs = 3600000) {
  const realm = await realmFixture('Bridge'), chain = await locationChain(realm);
  const company = await tenantCompanyService.createTenantCompany({ clientId: realm.client.id, tenantCode: `T_${key().slice(0, 8).toUpperCase()}`, tenantName: 'Accountless tenant' }, admin.userId);
  const pic = contact ? await tenantPicService.createTenantPic({ tenantCompanyId: company.id, picName: 'Contact without login' }, admin.userId) : null;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: company.id, buildingId: realm.building.id, spaceId: chain.space.id }, admin.userId);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: company.id, buildingId: realm.building.id }, admin.userId);
  for (const careActorId of [actorId, otherActorId]) await grantCareActorProperty({ careActorId, propertyId: realm.property.id, clientId: realm.client.id }, admin.userId);
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id, code: `HM_${key().slice(0, 8).toUpperCase()}`, name: 'Existing catalog repair', category: 'HANDYMAN' }, admin.userId);
  // Reuse the existing signed, accountless Care handoff end-to-end.
  const exchange = await issueCareCreateExchange(token, realm.property.id, { tenantCompanyId: company.id, buildingId: realm.building.id, spaceId: chain.space.id }, {});
  let request;
  if (!contact) {
    const created = await api().post('/api/v1/handyman/requests/care').send({ exchangeToken: exchange.exchangeToken, serviceCatalogId: service.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    request = await handymanServiceRequestRepository.findById(pool, created.body.data.id);
  } else {
    // Workspace create deliberately does not choose a PIC. Use the existing
    // signed handoff claim for a legitimate designated, unbound contact.
    // Existing attribution preserves a designated contact-only PIC. The
    // null-PIC fixture above separately exercises real signed Care intake.
    const { createChannelAttribution } = await import('../src/modules/handyman-channel-attributions');
    const { createHandymanServiceRequest } = await import('../src/modules/handyman-requests');
    const attribution = await createChannelAttribution({ tenantCompanyId: company.id, tenantPicId: pic!.id,
      buildingId: realm.building.id, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `test:${key()}`,
      actorType: 'CUSTOMER_CARE', careActorId: actorId, actorReference: 'care' });
    request = await createHandymanServiceRequest({ channelAttributionId: attribution.id, serviceCatalogId: service.id }, admin.userId);
  }
  assert.ok(request);
  await recordHandymanRequestTriage({ handymanRequestId: request.id, triageDisposition: 'DIAGNOSIS', triageNote: 'Direct to existing diagnosis' }, admin.userId);
  await recordHandymanDiagnosis({ handymanRequestId: request.id, disciplineId, diagnosis: 'Existing engine diagnosis' }, admin.userId);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin.userId);
  const version = quote.versions[0];
  const uom = key();
  await q('INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,\'Hour\',\'h\',\'TIME\')', [uom, realm.client.id, `H_${key().slice(0,8).toUpperCase()}`]);
  await addHandymanQuotationLine(version.id, { lineType: 'LABOR', description: 'Repair', quantity: 1, uomId: uom, currency: 'IDR', finalQuotedUnitAmount: 100 }, admin.userId);
  await issueHandymanQuotationVersion(version.id, { validUntil: new Date(Date.now() + validityMs).toISOString() }, admin.userId);
  return { realm, chain, company, pic, request, version, quote };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function target(f: F, kind: 'QUOTATION_VERSION' | 'BAST' = 'QUOTATION_VERSION', targetId = f.version.id) {
  const response = await api().get(path(f.request.id) + `/commercial-targets/${kind}/${targetId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.target as { type: 'QUOTATION_VERSION' | 'BAST'; id: string; digest: string };
}
async function submission(f: F, decision: 'ACCEPT' | 'REJECT' = 'ACCEPT', kind: 'QUOTATION_VERSION' | 'BAST' = 'QUOTATION_VERSION', targetId = f.version.id) {
  const contact = await post(f.request.id, '/communications', { purpose: kind === 'BAST' ? 'BAST_CONFIRMATION_RECEIVED' : 'QUOTATION_RESPONSE_RECEIVED',
    reportedContactName: 'Customer reported to Care', channel: 'MESSAGING', channelReference: 'test-message-reference',
    statement: `Customer response ${decision}`, reportedStatement: decision === 'ACCEPT' ? 'CONFIRM' : 'REJECT', idempotencyKey: key() });
  assert.equal(contact.status, 201, JSON.stringify(contact.body));
  assert.equal(contact.body.data.verification_state, 'PENDING_VERIFICATION');
  assert.equal(contact.body.data.recorded_by_user_id, null);
  assert.equal(contact.body.data.recorded_by_care_actor_id, actorId);
  const t = await target(f, kind, targetId);
  const a: CommercialConsentAssertion = { iss: code, aud: 'handyman-backend', purpose: COMMERCIAL_CONSENT_PURPOSE,
    method: COMMERCIAL_CONSENT_METHOD, jti: key(), iat: new Date(Date.now() - 1000).toISOString(), exp: new Date(Date.now() + 240000).toISOString(),
    careActorId: actorId, clientId: f.request.clientId, handymanRequestId: f.request.id, tenantCompanyId: f.company.id,
    tenantPicId: f.pic?.id ?? null, buildingId: f.request.buildingId, spaceId: f.request.spaceId,
    communicationId: contact.body.data.id, customerReference: 'TEST independently authenticated customer reference',
    verificationReference: `TEST external verifier receipt:${key()}`, targetType: kind, targetId, targetDigest: t.digest,
    decision, rejectReason: kind === 'BAST' && decision === 'REJECT' ? 'Work needs correction' : null };
  const suffix = `/${kind === 'BAST' ? 'bast' : 'quotation-versions'}/${targetId}/decision`;
  const body = { decision, idempotencyKey: key(), consentAssertion: a, ...(kind === 'BAST' ? { rejectReason: a.rejectReason } : {}) };
  return { a, body, suffix, send: (credential = token, assertion = a, signature = signCommercialConsentAssertion(assertion, CONSENT_KEY)) =>
    post(f.request.id, suffix, { ...body, consentAssertion: assertion }, credential, signature) };
}
async function businessState() {
  const tables = ['handyman_commercial_consent_receipts','handyman_quotation_decisions','handyman_quotation_versions','handyman_execution_scopes',
    'handyman_bast_documents','handyman_bast_events','handyman_bast_sign_offs','operational_events','handyman_customer_payments','handyman_work_sessions','tenant_invoices'];
  return Object.fromEntries(await Promise.all(tables.map(async t => [t, (await q(`SELECT * FROM ${t} row ORDER BY to_jsonb(row)::text`)).rows])));
}
async function denied(work: () => PromiseLike<any>, status: number, code?: string) {
  const before = await businessState(), response = await work();
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.error.code, code, JSON.stringify(response.body));
  assert.deepEqual(await businessState(), before, 'failures leave receipts, decisions, scope, BAST, money and history unchanged');
  return response;
}
async function issuedBast() {
  const f = await fixture(); const consent = await submission(f);
  const approved = await consent.send(); assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const scope = approved.body.data.executionScope;
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({ executionScopeId: scope.id, providerContextId: crew.providerContext.id, crewId: crew.crew.id }, admin.userId);
  await arrangeGuardedQcPass({ realm: f.realm, buildingId: f.realm.building.id, scope, crew, assignment, adminUserId: admin.userId, q });
  const prepared = await prepareHandymanBast(admin.userId, { executionScopeId: scope.id, idempotencyKey: key() });
  await issueHandymanBast(admin.userId, { bastId: prepared.bast.id, idempotencyKey: key() });
  return { ...f, scope, crew, bastId: prepared.bast.id };
}

async function waitForLock(fragment: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const observed = await q(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE $1) AS waiting`, [`%${fragment}%`]);
    if (observed.rows[0].waiting) return;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.fail(`No observed transaction lock wait for ${fragment}`);
}

describe('commercial decision bridge PART01 (TEST enrolled verifier, default live BLOCKED)', () => {
  it('fails closed for missing enrollment, missing/different-purpose key and Care-only statements', async () => {
    await enroll(false); const f = await fixture(), s = await submission(f);
    await denied(() => s.send(), 503, 'HANDYMAN_COMMERCIAL_CONSENT_INTEGRATION_BLOCKED');
    await enroll(); delete process.env[commercialConsentSecretEnvName(code)];
    await denied(() => s.send(), 503, 'HANDYMAN_COMMERCIAL_CONSENT_INTEGRATION_BLOCKED');
    process.env[commercialConsentSecretEnvName(code)] = HANDOFF_KEY;
    await denied(() => s.send(), 503, 'HANDYMAN_COMMERCIAL_CONSENT_INTEGRATION_BLOCKED');
    await enroll();
    await denied(() => post(f.request.id, s.suffix, { decision: 'ACCEPT', idempotencyKey: key() }), 403, 'HANDYMAN_COMMERCIAL_CONSENT_INVALID');
    await denied(() => s.send(token, s.a, signCommercialConsentAssertion(s.a, HANDOFF_KEY)), 403);
    await denied(() => post(f.request.id, s.suffix, { ...s.body, verified: true }), 400);
  });
  it('approves accountless null-PIC requests atomically; Care is recorder, never the customer User', async () => {
    await enroll(); const f = await fixture(), s = await submission(f);
    const users = (await q('SELECT id FROM users ORDER BY id')).rows;
    const [a, b] = await Promise.all([s.send(), s.send()]);
    for (const r of [a,b]) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(a.body.data, b.body.data);
    assert.equal(a.body.data.tenantPicId, null); assert.equal(a.body.data.decidedByUserId, null);
    assert.equal(a.body.data.decidedByCareActorId, actorId);
    assert.equal(a.body.data.executionScope.createdByUserId, null);
    assert.equal(a.body.data.executionScope.createdByCareActorId, actorId);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_commercial_consent_receipts WHERE target_id=$1', [f.version.id])).rows[0].n, 1);
    assert.deepEqual((await q('SELECT id FROM users ORDER BY id')).rows, users, 'no account provisioning');
    await denied(() => s.send(otherToken), 403);
    await denied(() => post(f.request.id, s.suffix, { ...s.body, idempotencyKey: key() }, token, signCommercialConsentAssertion(s.a, CONSENT_KEY)), 409);
    await assert.rejects(q('UPDATE handyman_commercial_consent_receipts SET target_id=$1 WHERE id=$2', [key(), a.body.data.commercialConsentId]), /immutable/);
    await assert.rejects(q('UPDATE handyman_care_communications SET statement=\'forged\' WHERE id=$1', [s.a.communicationId]), /immutable/);
  });
  it('supports an existing contact-only PIC without requiring or inventing a linked account; REJECT creates no scope', async () => {
    const f = await fixture(true), s = await submission(f, 'REJECT');
    const response = await s.send(); assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.decision, 'REJECT'); assert.equal(response.body.data.executionScope, null);
    assert.equal(response.body.data.tenantPicId, f.pic!.id);
    assert.equal((await q('SELECT user_id FROM tenant_pics WHERE id=$1', [f.pic!.id])).rows[0].user_id, null);
  });
  it('refuses altered/foreign claims, changed decisions, untrusted channels and a different real Care actor', async () => {
    const f = await fixture(), s = await submission(f);
    for (const change of [{ careActorId: otherActorId }, { clientId: key() }, { handymanRequestId: key() },
      { tenantCompanyId: key() }, { tenantPicId: key() }, { buildingId: key() }, { spaceId: key() },
      { targetId: key() }, { targetDigest: 'b'.repeat(64) }, { targetType: 'BAST' }, { decision: 'REJECT' },
      { verificationReference: '' }, { method: 'CARE_SAID_YES' }]) {
      const a = { ...s.a, ...change } as CommercialConsentAssertion;
      await denied(() => s.send(token, a), 403, 'HANDYMAN_COMMERCIAL_CONSENT_INVALID');
    }
    await denied(() => s.send(token, { ...s.a, customerReference: 'edited' }, signCommercialConsentAssertion(s.a, CONSENT_KEY)), 403);
    await denied(() => s.send(admin.token), 401, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    await denied(() => post(f.request.id, s.suffix, { ...s.body, actorUserId: admin.userId }, token, signCommercialConsentAssertion(s.a, CONSENT_KEY)), 400);
    await denied(() => post(key(), s.suffix, s.body, token, signCommercialConsentAssertion(s.a, CONSENT_KEY)), 404);
  });
  it('rejects stale/future/overlong consent and a mismatched communication; no evidence auto-promotion', async () => {
    const f = await fixture(), s = await submission(f);
    for (const change of [{ exp: new Date(Date.now() - 1).toISOString() }, { iat: new Date(Date.now() + 60000).toISOString() },
      { iat: new Date(Date.now() - 301000).toISOString() }, { communicationId: key() }]) {
      await denied(() => s.send(token, { ...s.a, ...change }), 403);
    }
    await q("UPDATE handyman_care_communications SET reported_statement='REJECT' WHERE id=$1", [s.a.communicationId]);
    await denied(() => s.send(), 403);
    assert.equal((await q('SELECT verification_state FROM handyman_care_communications WHERE id=$1', [s.a.communicationId])).rows[0].verification_state, 'PENDING_VERIFICATION');
  });
  it('racing opposite quotation decisions commit one decision/receipt/scope only; loser rolls back', async () => {
    const f = await fixture(), yes = await submission(f), no = await submission(f, 'REJECT');
    const responses = await Promise.all([yes.send(), no.send()]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200,409]);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_commercial_consent_receipts WHERE target_id=$1', [f.version.id])).rows[0].n, 1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_decisions WHERE quotation_version_id=$1', [f.version.id])).rows[0].n, 1);
  });
  it('rolls back consent + approval + scope + audit on scope insertion failure; same proof can retry', async () => {
    const f = await fixture(), s = await submission(f);
    await q(`CREATE FUNCTION bridge_test_fail_scope() RETURNS trigger AS $$ BEGIN IF NEW.handyman_request_id='${f.request.id}'::uuid THEN
      RAISE EXCEPTION 'bridge rollback injection'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER bridge_test_fail_scope BEFORE INSERT ON handyman_execution_scopes FOR EACH ROW EXECUTE FUNCTION bridge_test_fail_scope();`);
    try { await denied(() => s.send(), 500); }
    finally { await q('DROP TRIGGER bridge_test_fail_scope ON handyman_execution_scopes; DROP FUNCTION bridge_test_fail_scope()'); }
    const retry = await s.send(); assert.equal(retry.status, 200, JSON.stringify(retry.body));
  });
  it('keeps expiry/supersede eligibility and current scope/occupancy/grant guards, including on replay', async () => {
    const f = await fixture(), s = await submission(f);
    await revokeCareActorProperty({ careActorId: actorId, propertyId: f.realm.property.id, clientId: f.realm.client.id }, admin.userId);
    await denied(() => s.send(), 404);
    const g = await fixture(), gs = await submission(g);
    await q("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE tenant_company_id=$1 AND space_id=$2", [g.company.id, g.chain.space.id]);
    await denied(() => gs.send(), 404);
    const h = await fixture(false, 2000), hs = await submission(h);
    const deadline = (await q('SELECT valid_until FROM handyman_quotation_versions WHERE id=$1', [h.version.id])).rows[0].valid_until.getTime();
    await new Promise(done => setTimeout(done, Math.max(0, deadline - Date.now() + 20)));
    await denied(() => hs.send(), 400, 'HANDYMAN_QUOTATION_INVALID_TRANSITION');
  });
  it('does not accept request-owned attachments as customer intent, even for authenticated Care', async () => {
    const f = await fixture(); const evidenceId = key();
    await q(`INSERT INTO evidence_submissions(id,client_id,execution_type,execution_id,evidence_type,file_reference,
      original_file_name,mime_type,file_size,submitted_by_user_id) VALUES($1,$2,'HANDYMAN_REQUEST',$3,'DOCUMENT',
      'test/attachment','customer.pdf','application/pdf',12,$4)`, [evidenceId, f.request.clientId, f.request.id, admin.userId]);
    const comm = await post(f.request.id, '/communications', { purpose: 'QUOTATION_RESPONSE_RECEIVED',
      reportedContactName: 'Reported customer', channel: 'PHONE', statement: 'Care reports approval',
      reportedStatement: 'CONFIRM', idempotencyKey: key(), evidenceIds: [evidenceId] });
    assert.equal(comm.status, 201, JSON.stringify(comm.body));
    await denied(() => post(f.request.id, `/quotation-versions/${f.version.id}/decision`, {
      decision: 'ACCEPT', idempotencyKey: key(), consentAssertion: { communicationId: comm.body.data.id,
        evidenceIds: [evidenceId], verified: true } }), 403, 'HANDYMAN_COMMERCIAL_CONSENT_INVALID');
    assert.equal(comm.body.data.verification_state, 'PENDING_VERIFICATION');
  });
  it('one nonce/communication cannot authorize another version or request; superseded versions stay closed', async () => {
    const f = await fixture(), fs = await submission(f);
    assert.equal((await fs.send()).status, 200);
    const g = await fixture(), gs = await submission(g);
    await denied(() => gs.send(token, { ...gs.a, jti: fs.a.jti }), 409, 'HANDYMAN_COMMERCIAL_CONSENT_CONFLICT');
    await denied(() => fs.send(token, { ...fs.a, jti: key() }), 409, 'HANDYMAN_COMMERCIAL_CONSENT_CONFLICT');
    await denied(() => post(g.request.id, fs.suffix, fs.body, token, signCommercialConsentAssertion(fs.a, CONSENT_KEY)), 404);
    await supersedeHandymanQuotationVersion(g.version.id, admin.userId);
    await denied(() => gs.send(), 400, 'HANDYMAN_QUOTATION_INVALID_TRANSITION');
  });
  it('a credential revoked while waiting for the version lock is rechecked and cannot decide', async () => {
    const f = await fixture(), s = await submission(f), credential = await admit('care');
    const holder = await pool.connect(); let pending: Promise<any> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM handyman_quotation_versions WHERE id=$1 FOR UPDATE', [f.version.id]);
      pending = s.send(credential).then(r => r);
      await waitForLock('handyman_quotation_versions');
      await revokeCareWorkspaceSession(credential);
      await holder.query('COMMIT');
      await denied(() => pending!, 401, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    } finally { await holder.query('ROLLBACK'); holder.release(); await pending?.catch(() => undefined); }
    const revoked = await admit('care'); await revokeCareWorkspaceSession(revoked);
    await denied(() => s.send(revoked), 401, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
  });
  it('a signed consent expiring during the communication-row lock wait cannot mint a receipt', async () => {
    const f = await fixture(), s = await submission(f);
    const a = { ...s.a, exp: new Date(Date.now() + 2000).toISOString() };
    const holder = await pool.connect(); let pending: Promise<any> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM handyman_care_communications WHERE id=$1 FOR UPDATE', [a.communicationId]);
      pending = s.send(token, a).then(r => r);
      await waitForLock('handyman_care_communications');
      await new Promise(done => setTimeout(done, Math.max(0, Date.parse(a.exp) - Date.now() + 20)));
      await holder.query('COMMIT');
      await denied(() => pending!, 403, 'HANDYMAN_COMMERCIAL_CONSENT_INVALID');
    } finally { await holder.query('ROLLBACK'); holder.release(); await pending?.catch(() => undefined); }
  });
  it('natural occupancy expiry during a communication wait cannot commit a still-fresh proof', async () => {
    const f = await fixture(), s = await submission(f);
    const deadline = (await q(`UPDATE tenant_building_contexts SET effective_until=clock_timestamp()+interval '2 seconds'
      WHERE tenant_company_id=$1 AND building_id=$2 RETURNING effective_until`, [f.company.id, f.request.buildingId])).rows[0].effective_until.getTime();
    const holder = await pool.connect(); let pending: Promise<any> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM handyman_care_communications WHERE id=$1 FOR UPDATE', [s.a.communicationId]);
      pending = s.send().then(r => r);
      await waitForLock('handyman_care_communications');
      await new Promise(done => setTimeout(done, Math.max(0, deadline - Date.now() + 20)));
      await holder.query('COMMIT');
      await denied(() => pending!, 404, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
      assert.equal(Number((await q('SELECT count(*) n FROM handyman_commercial_consent_receipts WHERE handyman_request_id=$1', [f.request.id])).rows[0].n), 0);
    } finally { await holder.query('ROLLBACK'); holder.release(); await pending?.catch(() => undefined); }
  });
  it('accepts exact issued BAST with independent customer proof; qualifies warranty and only the BAST close gate', async () => {
    const f = await issuedBast(), s = await submission(f, 'ACCEPT', 'BAST', f.bastId);
    const before = await getHandymanFinalCloseReadiness(f.scope.id, admin.userId); assert.equal(before.gates.bastAccepted, false);
    const [a,b] = await Promise.all([s.send(), s.send()]);
    for (const r of [a,b]) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(a.body.data.event.id, b.body.data.event.id);
    assert.equal(a.body.data.event.actorUserId, null); assert.equal(a.body.data.event.actorCareActorId, actorId);
    assert.equal(a.body.data.acceptance.customerAccepted, true);
    assert.equal(a.body.data.acceptance.approvedSignOff.recordedByCareActorId, actorId);
    const bast = (await handymanBastRepository.findBastById(pool, f.bastId))!;
    const events = await handymanBastRepository.listEventsByBastId(pool, bast.id), signOffs = await handymanBastRepository.listSignOffsByBastId(pool, bast.id);
    assert.equal(toHandymanBastAcceptanceReadContract(bast, events, signOffs).customerAccepted, true);
    assert.equal(await hasVerifiedHandymanBastCustomerAcceptance(pool, bast.id), true);
    const acceptance = events.find(e => e.eventType === 'ACCEPT')!;
    assert.ok(verifiedHandymanBastCustomerConsent(bast, acceptance, signOffs[0]));
    assert.equal(verifiedHandymanBastCustomerConsent(bast, { ...acceptance, commercialConsentId: key() }, signOffs[0]), null);
    const after = await getHandymanFinalCloseReadiness(f.scope.id, admin.userId);
    assert.equal(after.gates.bastAccepted, true); assert.equal(after.eligibleForFinalClose, false);
    assert.ok(after.blockers.length > 0, 'unmet Finance/other gates remain blocking');
    await startHandymanServiceWarranty({ executionScopeId: f.scope.id, idempotencyKey: key() }, admin.userId);
    await denied(() => s.send(otherToken), 403);
    const expired = JSON.parse(JSON.stringify(s.a));
    // Historical receipt is not transferred or re-verified with different intent.
    expired.verificationReference = 'replacement-proof';
    await denied(() => s.send(token, expired), 409);
    await revokeCareActorProperty({ careActorId: actorId, propertyId: f.realm.property.id, clientId: f.realm.client.id }, admin.userId);
    await denied(() => s.send(), 404);
    assert.equal(await hasVerifiedHandymanBastCustomerAcceptance(pool, bast.id), true, 'revocation does not rewrite history');
  });
  it('records Care-assisted BAST rejection without creating customer acceptance', async () => {
    const f = await issuedBast(), s = await submission(f, 'REJECT', 'BAST', f.bastId);
    const response = await s.send(); assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.bast.status, 'REJECTED');
    assert.equal(response.body.data.signOff.rejectReason, 'Work needs correction');
    assert.equal(await hasVerifiedHandymanBastCustomerAcceptance(pool, f.bastId), false);
    const replay = await s.send(); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.data.replayed, true);
  });
  it('rolls back BAST status/event/consent when sign-off fails; races opposite decisions without duplicate authority', async () => {
    const f = await issuedBast(), yes = await submission(f, 'ACCEPT', 'BAST', f.bastId);
    await q(`CREATE FUNCTION bridge_test_fail_signoff() RETURNS trigger AS $$ BEGIN IF NEW.bast_id='${f.bastId}'::uuid THEN
      RAISE EXCEPTION 'bridge sign-off rollback injection'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER bridge_test_fail_signoff BEFORE INSERT ON handyman_bast_sign_offs FOR EACH ROW EXECUTE FUNCTION bridge_test_fail_signoff();`);
    try { await denied(() => yes.send(), 500); }
    finally { await q('DROP TRIGGER bridge_test_fail_signoff ON handyman_bast_sign_offs; DROP FUNCTION bridge_test_fail_signoff()'); }
    const no = await submission(f, 'REJECT', 'BAST', f.bastId);
    const results = await Promise.all([yes.send(), no.send()]);
    assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_commercial_consent_receipts WHERE target_id=$1', [f.bastId])).rows[0].n, 1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bast_sign_offs WHERE bast_id=$1', [f.bastId])).rows[0].n, 1);
  });
  it('refuses schema downgrade that would erase real Care recorder/verified consent provenance', async () => {
    const before = await businessState();
    await assert.rejects(withTransaction(tx => migration0481HandymanCommercialConsentBridge.down(tx)), /Cannot downgrade/);
    assert.deepEqual(await businessState(), before);
  });
  it('does not bypass a newer Supervisor QC run for BAST acceptance; rolls back the verified receipt', async () => {
    const f = await issuedBast(), s = await submission(f, 'ACCEPT', 'BAST', f.bastId);
    const supervisor = (await q('SELECT e.actor_user_id FROM handyman_qc_run_events e JOIN handyman_qc_runs r ON r.id=e.run_id WHERE r.execution_scope_id=$1 AND e.event_type=\'FINISH\' ORDER BY e.created_at DESC LIMIT 1', [f.scope.id])).rows[0].actor_user_id;
    await runGuardedQcCycle({ clientId: f.scope.clientId, tenantCompanyId: f.company.id, buildingId: f.request.buildingId,
      handymanRequestId: f.request.id, executionScopeId: f.scope.id, adminUserId: admin.userId, supervisorUserId: supervisor, uploaderUserId: f.crew.leadUser.id, q });
    await denied(() => s.send(), 409, 'HANDYMAN_BAST_QC_NOT_READY');
  });
});
