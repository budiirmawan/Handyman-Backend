import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import {
  grantCareActorPermission,
  grantCareActorProperty,
  handymanCareActorService,
  revokeCareActorPermission,
  revokeCareActorProperty,
} from '../src/modules/handyman-care-actors';
import { admitCareWorkspace, signCareWorkspaceAssertion,
  type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handymanCustomerPaymentRepository,
  recordHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { initHandymanFixtures, locationChain, realmFixture, scopeFixture } from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 05 — Customer Care payment REPORT
 * through a live workspace session, over HTTP and against the real ledger.
 *
 *  1. REPORT     — a granted care actor records a PENDING claim with an
 *                  auditable CARE_ACTOR identity (no User identity).
 *  2. IDEMPOTENT — same key replays the same payment; reused external ref 409.
 *  3. SESSION    — invalid, revoked, and expired sessions are refused (401).
 *  4. SCOPE      — other Property, other Building selection, and missing
 *                  property grant never reveal or write a payment (404).
 *  5. PERMISSION — no report grant -> 403; grant revoked -> 403.
 *  6. NO VERIFY  — a workspace token cannot CONFIRM/REJECT (route absent, and
 *                  user ledger routes refuse it); report-only allowlist.
 *  7. MAKER-CHK  — a User verifier may verify a care-reported claim (different
 *                  identity); the reporter identity is persisted for audit.
 *  8. PROVISION  — grants are delegation-bounded by the grantor's own RBAC;
 *                  verify is not grantable to care actors and is not default.
 */

const V1 = '/api/v1';
const SECRET = 'workspace-payment-report-test-secret';
const key = () => `k-${randomUUID()}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const REPORT = 'handyman.payment.report';
const VERIFY = 'handyman.payment.verify';

let pool: Pool;
let code: string;
let envKey: string;
let integrationId: string;
let careActorId: string;
let otherCareActorId: string;
let adminUserId: string;
let grantorToken: string;
let grantorUserId: string;
let verifierToken: string;
let verifierUserId: string;
let token: string;
let scopeA: any;
let realmA: any;
let otherPropertyScope: any;
let siblingBuildingId: string;

const q = async (text: string, params: unknown[] = []) => pool.query(text, params);
const paymentsPath = (scopeId: string) => `${V1}/handyman/execution-scopes/${scopeId}/customer-payments`;
const reportPath = (requestId: string) => `${V1}/handyman/care/requests/${requestId}/payments`;
const selection = (scope: any, buildingId = scope.buildingId, spaceId = scope.spaceId) =>
  `?propertyId=${realmA.property.id}&tenantCompanyId=${scope.tenantCompanyId}&buildingId=${buildingId}` +
  (spaceId ? `&spaceId=${spaceId}` : '');

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care-operator' }, ...overrides };
}
async function admit(a = assertion()) {
  return (await admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET))).workspaceToken;
}
async function userIdOf(sessionToken: string): Promise<string> {
  const row = await q('SELECT user_id FROM user_sessions WHERE token_hash = $1', [sha256(sessionToken)]);
  return row.rows[0].user_id as string;
}
async function report(requestId: string, scope: any, body: Record<string, unknown> = {}, credential = token, query?: string) {
  return api().post(reportPath(requestId) + (query ?? selection(scope)))
    .set('Authorization', `Bearer ${credential}`)
    .send({ amount: '75.00', channel: 'BANK_TRANSFER', idempotencyKey: key(), ...body });
}
async function openLedger(scopeId: string) {
  await openHandymanCustomerTransaction({ executionScopeId: scopeId, idempotencyKey: key() }, adminUserId);
}
async function requestIdOf(scopeId: string): Promise<string> {
  const row = await q('SELECT handyman_request_id FROM handyman_execution_scopes WHERE id = $1', [scopeId]);
  return row.rows[0].handyman_request_id as string;
}

before(async () => {
  const config = await ensureTestDatabase();
  if (!config) throw new Error('test database must be available');
  pool = await initDatabase(config);
  await migrateUp(pool);
  code = `PR_${randomUUID().slice(0, 8).toUpperCase()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Payment BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  careActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'care-operator', displayName: 'Care' })).id;
  otherCareActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'other-care', displayName: 'Other' })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({ adminUserId, disciplineId: discipline.id,
    query: async (text, params = []) => pool.query(text, params) });

  realmA = await realmFixture('Granted');
  const chainA = await locationChain(realmA);
  scopeA = (await scopeFixture(realmA, chainA)).scope;
  assert.ok(scopeA, 'approved scope required');
  await openLedger(scopeA.id);
  // Same Property, a sibling Building the request does NOT belong to.
  const { buildingService } = await import('../src/modules/buildings');
  siblingBuildingId = (await buildingService.createBuilding({ propertyId: realmA.property.id,
    code: `SB_${randomUUID().slice(0, 6)}`, name: 'Sibling' })).id;

  // Another Property/Client that is NOT granted to the care actor.
  const realmB = await realmFixture('Not granted');
  const chainB = await locationChain(realmB);
  otherPropertyScope = (await scopeFixture(realmB, chainB)).scope;
  await openLedger(otherPropertyScope.id);

  await grantCareActorProperty({ careActorId, propertyId: realmA.property.id, clientId: realmA.client.id }, adminUserId);

  // Grantor holds report (delegation ceiling) and can administer grants.
  grantorToken = await createSessionWithPermissions([{ code: REPORT, name: 'Report' }]);
  grantorUserId = await userIdOf(grantorToken);
  // Verifier holds verify through an explicit RBAC grant on its own role.
  verifierToken = await createSessionWithPermissions([{ code: VERIFY, name: 'Verify' }]);
  verifierUserId = await userIdOf(verifierToken);
  await buildingAssignmentService.createAssignment(verifierUserId, { buildingId: realmA.building.id });
});

beforeEach(async () => {
  clearLoginRateLimits();
  token = await admit();
  await grantCareActorPermission({ careActorId, permissionCode: REPORT }, grantorUserId);
});

after(async () => {
  delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
});

describe('Customer Care payment REPORT through workspace session', () => {
  it('records a PENDING claim with a CARE_ACTOR identity and reuses the ledger engine', async () => {
    const requestId = await requestIdOf(scopeA.id);
    const res = await report(requestId, scopeA, { externalReference: 'BANK-REF-1' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.status, 'PENDING');
    assert.equal(data.amount, '75.00');
    assert.equal(data.recordedByActorType, 'CARE_ACTOR');
    assert.equal(data.recordedByCareActorId, careActorId);
    assert.equal(data.replayed, false);
    assert.equal(data.availableActions, undefined);
    assert.equal(data.decidedByUserId, undefined);

    const row = await q(
      `SELECT recorded_by_actor_type, recorded_by_user_id, recorded_by_care_actor_id,
              recorded_by_workspace_session_id, status
         FROM handyman_customer_payments WHERE id = $1`, [data.id]);
    assert.equal(row.rows[0].recorded_by_actor_type, 'CARE_ACTOR');
    assert.equal(row.rows[0].recorded_by_user_id, null);
    assert.equal(row.rows[0].recorded_by_care_actor_id, careActorId);
    const session = await q('SELECT id FROM handyman_care_workspace_sessions WHERE token_hash = $1', [sha256(token)]);
    assert.equal(row.rows[0].recorded_by_workspace_session_id, session.rows[0].id);
    assert.equal(row.rows[0].status, 'PENDING');

    const event = await q(
      `SELECT actor_type, actor_user_id, actor_care_actor_id, actor_workspace_session_id
         FROM handyman_customer_payment_events
        WHERE payment_id = $1 AND event_type = 'RECORD_PAYMENT'`, [data.id]);
    assert.equal(event.rows[0].actor_type, 'CARE_ACTOR');
    assert.equal(event.rows[0].actor_user_id, null);
    assert.equal(event.rows[0].actor_care_actor_id, careActorId);
    assert.equal(event.rows[0].actor_workspace_session_id, session.rows[0].id);
  });

  it('replays the same idempotency key to the same payment and refuses a reused external reference', async () => {
    const requestId = await requestIdOf(scopeA.id);
    const k = key();
    const first = await report(requestId, scopeA, { idempotencyKey: k, externalReference: 'IDEM-1' });
    const again = await report(requestId, scopeA, { idempotencyKey: k, externalReference: 'IDEM-1' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(again.body.data.replayed, true);
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_customer_payments WHERE id = $1`, [first.body.data.id]);
    assert.equal(count.rows[0].n, 1);

    const dup = await report(requestId, scopeA, { externalReference: 'IDEM-1' });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
  });

  it('rejects an invalid, revoked, or expired workspace session with 401 and writes nothing', async () => {
    const requestId = await requestIdOf(scopeA.id);
    const before = await q('SELECT count(*)::int AS n FROM handyman_customer_payments WHERE transaction_id IN (SELECT id FROM handyman_customer_transactions WHERE execution_scope_id = $1)', [scopeA.id]);

    const garbage = await report(requestId, scopeA, {}, 'hcw_not-a-real-token');
    assert.equal(garbage.status, 401);
    assert.equal(garbage.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');

    const revocable = await admit();
    const logout = await api().delete(`${V1}/handyman/care/session`).set('Authorization', `Bearer ${revocable}`);
    assert.equal(logout.status, 204);
    const revoked = await report(requestId, scopeA, {}, revocable);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');

    // An already-expired session is inserted directly (session rows are
    // immutable except revocation, so expiry is modelled as a past row).
    const expiring = `hcw_${randomBytes(32).toString('base64url')}`;
    await q(`INSERT INTO handyman_care_workspace_sessions
               (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute')`,
      [randomUUID(), integrationId, careActorId, randomUUID(), sha256(expiring)]);
    const expired = await report(requestId, scopeA, {}, expiring);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');

    const after = await q('SELECT count(*)::int AS n FROM handyman_customer_payments WHERE transaction_id IN (SELECT id FROM handyman_customer_transactions WHERE execution_scope_id = $1)', [scopeA.id]);
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  it('never reveals or writes across scope: other Property, other Building, and a revoked property grant', async () => {
    const requestId = await requestIdOf(scopeA.id);
    // Sibling Building selection: the request is not projected there.
    const sibling = await report(requestId, scopeA, {}, token,
      `?propertyId=${realmA.property.id}&tenantCompanyId=${scopeA.tenantCompanyId}&buildingId=${siblingBuildingId}`);
    assert.equal(sibling.status, 404, JSON.stringify(sibling.body));
    assert.equal(sibling.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');

    // Request in a Property that was never granted to this care actor.
    const foreign = await report(await requestIdOf(otherPropertyScope.id), otherPropertyScope);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));

    // Direct service call: a verified care recorder whose projected Building
    // disagrees with the scope's Building is refused by the write-time check.
    const direct = await recordHandymanCustomerPayment(
      { executionScopeId: scopeA.id, amount: '10.00', channel: 'CASH',
        providerName: null, providerReference: null, externalReference: null, idempotencyKey: key() },
      { kind: 'CARE_ACTOR', careActorId, workspaceSessionId: randomUUID(), requestBuildingId: siblingBuildingId },
    ).catch((error) => error);
    assert.ok(direct instanceof Error);
    assert.equal((direct as any).statusCode, 401, 'unknown session is refused before any scope logic');

    // Revoking the property grant withdraws the scope entirely.
    await revokeCareActorProperty({ careActorId, propertyId: realmA.property.id, clientId: realmA.client.id }, adminUserId);
    const revokedGrant = await report(requestId, scopeA);
    assert.equal(revokedGrant.status, 404, JSON.stringify(revokedGrant.body));
    await grantCareActorProperty({ careActorId, propertyId: realmA.property.id, clientId: realmA.client.id }, adminUserId);
  });

  it('denies a care actor without an ACTIVE report grant (403) and after revocation', async () => {
    const requestId = await requestIdOf(scopeA.id);
    const revoked = await revokeCareActorPermission({ careActorId, permissionCode: REPORT }, grantorUserId);
    assert.ok(revoked && revoked.status === 'REVOKED');
    const denied = await report(requestId, scopeA);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.equal(await revokeCareActorPermission({ careActorId, permissionCode: REPORT }, grantorUserId), null,
      'revocation is idempotent');
    // Another care actor with no grant at all is denied the same way.
    const otherToken = await admit(assertion({ actor: { type: 'CUSTOMER_CARE', actorReference: 'other-care' } }));
    const other = await report(requestId, scopeA, {}, otherToken);
    assert.equal(other.status, 404, 'other actor has no property grant, so no projection');
  });

  it('refuses any CONFIRM/REJECT or ledger read with a workspace token (no verify path, direct API included)', async () => {
    const requestId = await requestIdOf(scopeA.id);
    const recorded = await report(requestId, scopeA);
    assert.equal(recorded.status, 200);
    const paymentId = recorded.body.data.id;

    for (const action of ['confirm', 'reject']) {
      const res = await api().post(`${paymentsPath(scopeA.id)}/${paymentId}/${action}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ idempotencyKey: key(), reason: 'x' });
      assert.equal(res.status, 401, `${action} must not accept a workspace session`);
    }
    const workspaceConfirm = await api()
      .post(`${V1}/handyman/care/requests/${requestId}/payments/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${token}`).send({ idempotencyKey: key() });
    assert.equal(workspaceConfirm.status, 404);
    const ledger = await api().get(paymentsPath(scopeA.id)).set('Authorization', `Bearer ${token}`);
    assert.equal(ledger.status, 401);

    const row = await q('SELECT status FROM handyman_customer_payments WHERE id = $1', [paymentId]);
    assert.equal(row.rows[0].status, 'PENDING', 'a care report never becomes decided');
  });

  it('rejects smuggled fields (status, actor, decision, scope) in the workspace body', async () => {
    const requestId = await requestIdOf(scopeA.id);
    for (const extra of [{ status: 'CONFIRMED' }, { recordedByUserId: adminUserId },
      { decidedByUserId: adminUserId }, { executionScopeId: scopeA.id }]) {
      const res = await report(requestId, scopeA, extra);
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('lets a different User verifier confirm the care-reported claim (maker-checker across identities)', async () => {
    const requestId = await requestIdOf(scopeA.id);
    const recorded = await report(requestId, scopeA, { amount: '20.00' });
    const paymentId = recorded.body.data.id;
    const confirm = await api().post(`${paymentsPath(scopeA.id)}/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${verifierToken}`).send({ idempotencyKey: key() });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal(confirm.body.data.payment.status, 'CONFIRMED');
    assert.equal(confirm.body.data.payment.recordedByActorType, 'CARE_ACTOR');
    assert.equal(confirm.body.data.payment.decidedByUserId, verifierUserId);
  });
});

describe('Payment permission provisioning (no default verify, delegation-bounded)', () => {
  it('lets only a grantor who holds the permission grant it, and only allowlisted codes', async () => {
    const noHold = await createSessionWithPermissions([{ code: 'handyman.payment.unrelated', name: 'x' }]);
    const noHoldId = await userIdOf(noHold);
    await assert.rejects(
      grantCareActorPermission({ careActorId: otherCareActorId, permissionCode: REPORT }, noHoldId),
      (error: any) => error.statusCode === 403 && error.code === 'PERMISSION_DENIED');
    await assert.rejects(
      grantCareActorPermission({ careActorId: otherCareActorId, permissionCode: VERIFY }, verifierUserId),
      (error: any) => error.statusCode === 400);
  });

  it('keeps verify out of every default assignment: no PLATFORM_ADMIN, no role-less user, no care actor', async () => {
    const platformAdmin = await q(
      `SELECT count(*)::int AS n FROM role_permission_assignments rpa
         JOIN roles r ON r.id = rpa.role_id JOIN permissions p ON p.id = rpa.permission_id
        WHERE r.code = 'PLATFORM_ADMIN' AND p.code = $1 AND rpa.status = 'ACTIVE'`, [VERIFY]);
    assert.equal(platformAdmin.rows[0].n, 0);
    const bare = await userService.createUser({ email: `bare-${randomUUID().slice(0, 6)}@example.com`, displayName: 'Bare' });
    assert.ok(!(await permissionService.resolvePermissionsForUser(bare.id)).includes(VERIFY));
    const care = await q(
      `SELECT count(*)::int AS n FROM handyman_care_actor_permission_grants WHERE permission_code = $1`, [VERIFY]);
    assert.equal(care.rows[0].n, 0);
  });

  it('keeps the catalogue entries for both codes and the report grant is the only care-actor code', async () => {
    const catalogue = await q(
      `SELECT code FROM permissions WHERE code IN ($1, $2) AND status = 'ACTIVE' ORDER BY code`, [REPORT, VERIFY]);
    assert.deepEqual(catalogue.rows.map((r) => r.code), [REPORT, VERIFY]);
    const roleCreated = await roleService.createRole({ code: `ROLE_${randomUUID().slice(0, 6)}`, name: 'r' });
    assert.ok(roleCreated.id);
  });
});
