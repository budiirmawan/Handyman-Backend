import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import {
  grantCareActorPermission,
  grantCareActorProperty,
  handymanCareActorService,
  hasActiveCareActorPermission,
} from '../src/modules/handyman-care-actors';
import { admitCareWorkspace, signCareWorkspaceAssertion,
  type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { initHandymanFixtures, locationChain, realmFixture, scopeFixture } from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 06 — administrative provisioning of
 * `handyman.payment.report` for a Customer Care actor, plus the USER/CARE_ACTOR
 * exclusive identity constraints on payment and payment-event rows.
 */

let pool: Pool;
let code: string;
let envKey: string;
let careActorId: string;
let integrationId: string;
let adminUserId: string;
let realm: any;
let scope: any;
let adminToken: string;     // permission.manage + report + building access (authorised administrator)
let readerToken: string;    // permission.read only, with building access
let manageNoScopeToken: string; // permission.manage + report, NO building access
let manageNoHoldToken: string;  // permission.manage only (cannot delegate report), building access
let verifyUserToken: string;    // holds verify only (must never be grantable to a care actor)
let token: string;          // workspace token for the care actor

const SECRET = 'admin-provisioning-test-secret';
const V1 = '/api/v1';
const REPORT = 'handyman.payment.report';
const VERIFY = 'handyman.payment.verify';
const MANAGE = 'permission.manage';
const READ = 'permission.read';
const key = () => `k-${randomUUID()}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const q = async (text: string, params: unknown[] = []) => pool.query(text, params);
const grantsPath = (id = careActorId) => `${V1}/handyman/care-actors/${id}/permissions`;
const reportPath = (requestId: string) => `${V1}/handyman/care/requests/${requestId}/payments`;
const selection = (s: any) =>
  `?propertyId=${realm.property.id}&tenantCompanyId=${s.tenantCompanyId}&buildingId=${s.buildingId}` +
  (s.spaceId ? `&spaceId=${s.spaceId}` : '');

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'provision-operator' }, ...overrides };
}
async function admit(): Promise<string> {
  const a = assertion();
  return (await admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET))).workspaceToken;
}
async function userIdOf(sessionToken: string): Promise<string> {
  const row = await q('SELECT user_id FROM user_sessions WHERE token_hash = $1', [sha256(sessionToken)]);
  return row.rows[0].user_id as string;
}
async function requestIdOf(scopeId: string): Promise<string> {
  const row = await q('SELECT handyman_request_id FROM handyman_execution_scopes WHERE id = $1', [scopeId]);
  return row.rows[0].handyman_request_id as string;
}
async function reportAsCare(workspaceToken: string) {
  return api().post(reportPath(await requestIdOf(scope.id)) + selection(scope))
    .set('Authorization', `Bearer ${workspaceToken}`)
    .send({ amount: '75.00', channel: 'BANK_TRANSFER', idempotencyKey: key() });
}
async function eventCount(eventType: string, entityId?: string): Promise<number> {
  const r = await q(
    `SELECT count(*)::int AS n FROM operational_events
      WHERE event_type = $1 AND ($2::text IS NULL OR entity_id::text = $2)`,
    [eventType, entityId ?? null]);
  return r.rows[0].n as number;
}

before(async () => {
  const config = await ensureTestDatabase();
  if (!config) throw new Error('test database must be available');
  pool = await initDatabase(config);
  await migrateUp(pool);
  code = `AP_${randomUUID().slice(0, 8).toUpperCase()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Provision BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  careActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'provision-operator', displayName: 'Care' })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({ adminUserId, disciplineId: discipline.id,
    query: async (text, params = []) => pool.query(text, params) });

  realm = await realmFixture('Provision');
  const chain = await locationChain(realm);
  scope = (await scopeFixture(realm, chain)).scope;
  assert.ok(scope, 'approved scope required');
  await openHandymanCustomerTransaction({ executionScopeId: scope.id, idempotencyKey: key() }, adminUserId);
  // Care actor is granted the property (admin path already certified in PART 02).
  await grantCareActorProperty({ careActorId, propertyId: realm.property.id, clientId: realm.client.id }, adminUserId);

  adminToken = await createSessionWithPermissions([{ code: MANAGE, name: 'Manage' }, { code: REPORT, name: 'Report' }]);
  await buildingAssignmentService.createAssignment(await userIdOf(adminToken), { buildingId: realm.building.id });
  readerToken = await createSessionWithPermissions([{ code: READ, name: 'Read' }]);
  await buildingAssignmentService.createAssignment(await userIdOf(readerToken), { buildingId: realm.building.id });
  manageNoScopeToken = await createSessionWithPermissions([{ code: MANAGE, name: 'Manage' }, { code: REPORT, name: 'Report' }]);
  manageNoHoldToken = await createSessionWithPermissions([{ code: MANAGE, name: 'Manage' }]);
  await buildingAssignmentService.createAssignment(await userIdOf(manageNoHoldToken), { buildingId: realm.building.id });
  verifyUserToken = await createSessionWithPermissions([{ code: VERIFY, name: 'Verify' }]);
  await buildingAssignmentService.createAssignment(await userIdOf(verifyUserToken), { buildingId: realm.building.id });
});

beforeEach(async () => {
  clearLoginRateLimits();
  token = await admit();
  // Grants are history (ACTIVE -> REVOKED only). Reset the fixture's ACTIVE grant directly.
  await q(`UPDATE handyman_care_actor_permission_grants
              SET status = 'REVOKED', revoked_by_user_id = $2, revoked_at = NOW()
            WHERE care_actor_id = $1 AND status = 'ACTIVE'`, [careActorId, adminUserId]);
});

after(async () => {
  delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
});

describe('Care actor permission administration: RBAC, delegation, scope, audit', () => {
  it('requires authentication on every administrative route (401, no write)', async () => {
    const list = await api().get(grantsPath());
    const grant = await api().post(grantsPath()).send({ permissionCode: REPORT });
    const revoke = await api().delete(`${grantsPath()}/${REPORT}`);
    assert.equal(list.status, 401);
    assert.equal(grant.status, 401);
    assert.equal(revoke.status, 401);
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), false);
  });

  it('grants REPORT through the admin route with audit, and an identical replay writes nothing new', async () => {
    const first = await api().post(grantsPath()).set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionCode: REPORT });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.created, true);
    assert.equal(first.body.data.grant.status, 'ACTIVE');
    assert.equal(first.body.data.grant.permissionCode, REPORT);
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), true);
    const granted = await eventCount('HANDYMAN_CARE_ACTOR_PERMISSION_GRANTED', first.body.data.grant.id);
    assert.equal(granted, 1, 'exactly one audit event for the effective grant');
    const actorOfEvent = await q(
      `SELECT actor_user_id, client_id FROM operational_events
        WHERE event_type = 'HANDYMAN_CARE_ACTOR_PERMISSION_GRANTED' AND entity_id = $1`,
      [first.body.data.grant.id]);
    assert.equal(actorOfEvent.rows[0].actor_user_id, await userIdOf(adminToken));
    assert.equal(actorOfEvent.rows[0].client_id, realm.client.id);

    const replay = await api().post(grantsPath()).set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionCode: REPORT });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.created, false);
    assert.equal(replay.body.data.grant.id, first.body.data.grant.id);
    assert.equal(await eventCount('HANDYMAN_CARE_ACTOR_PERMISSION_GRANTED', first.body.data.grant.id), 1);
  });

  it('lets the granted care actor report a payment through its workspace session (runtime proof)', async () => {
    await grantCareActorPermission({ careActorId, permissionCode: REPORT }, await userIdOf(adminToken));
    const res = await reportAsCare(token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await q(
      `SELECT recorded_by_actor_type FROM handyman_customer_payments WHERE id = $1`, [res.body.data.id]);
    assert.equal(row.rows[0].recorded_by_actor_type, 'CARE_ACTOR');
  });

  it('lists grants with ACTIVE and REVOKED history to a permission.read reader only', async () => {
    await grantCareActorPermission({ careActorId, permissionCode: REPORT }, await userIdOf(adminToken));
    const ok = await api().get(grantsPath()).set('Authorization', `Bearer ${readerToken}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.data.grants.some((g: any) => g.permissionCode === REPORT && g.status === 'ACTIVE'));
    const denied = await api().get(grantsPath()).set('Authorization', `Bearer ${manageNoScopeToken}`);
    assert.equal(denied.status, 403, 'no permission.read and no building access');
  });

  it('denies a grantor without permission.manage (403, read-only RBAC) and writes nothing', async () => {
    const res = await api().post(grantsPath()).set('Authorization', `Bearer ${readerToken}`)
      .send({ permissionCode: REPORT });
    assert.equal(res.status, 403);
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), false);
  });

  it('denies delegation of REPORT by a grantor who does not hold it (403 PERMISSION_DENIED)', async () => {
    const res = await api().post(grantsPath()).set('Authorization', `Bearer ${manageNoHoldToken}`)
      .send({ permissionCode: REPORT });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), false);
  });

  it('denies a grantor with permission.manage and the code but no building access to the granted property', async () => {
    const res = await api().post(grantsPath()).set('Authorization', `Bearer ${manageNoScopeToken}`)
      .send({ permissionCode: REPORT });
    assert.equal(res.status, 403);
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), false, 'no grant written');
  });

  it('refuses VERIFY for any care actor at the API and the service (structural allowlist, 400)', async () => {
    const res = await api().post(grantsPath()).set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionCode: VERIFY });
    assert.equal(res.status, 400);
    const verifyHolder = await userIdOf(verifyUserToken);
    await assert.rejects(
      grantCareActorPermission({ careActorId, permissionCode: VERIFY }, verifyHolder),
      (error: any) => error.statusCode === 400);
    assert.equal(await hasActiveCareActorPermission(careActorId, VERIFY), false);
  });

  it('rejects unknown body fields and query parameters on grant (400)', async () => {
    const extra = await api().post(grantsPath()).set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionCode: REPORT, careActorId: randomUUID() });
    assert.equal(extra.status, 400);
    const query = await api().post(`${grantsPath()}?x=1`).set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionCode: REPORT });
    assert.equal(query.status, 400);
  });

  it('revokes through the admin route with audit; the workspace report is then denied; repeat revoke is 404', async () => {
    await api().post(grantsPath()).set('Authorization', `Bearer ${adminToken}`).send({ permissionCode: REPORT });
    const revoked = await api().delete(`${grantsPath()}/${REPORT}`).set('Authorization', `Bearer ${adminToken}`);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.grant.status, 'REVOKED');
    assert.equal(revoked.body.data.grant.revokedByUserId, await userIdOf(adminToken));
    assert.equal(await eventCount('HANDYMAN_CARE_ACTOR_PERMISSION_REVOKED', revoked.body.data.grant.id), 1);
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), false);

    const denied = await reportAsCare(token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const again = await api().delete(`${grantsPath()}/${REPORT}`).set('Authorization', `Bearer ${adminToken}`);
    assert.equal(again.status, 404);
    assert.equal(await eventCount('HANDYMAN_CARE_ACTOR_PERMISSION_REVOKED', revoked.body.data.grant.id), 1,
      'a non-effective revoke writes no audit event');
  });

  it('refuses revoke by a grantor without building access and keeps the grant ACTIVE', async () => {
    await api().post(grantsPath()).set('Authorization', `Bearer ${adminToken}`).send({ permissionCode: REPORT });
    const res = await api().delete(`${grantsPath()}/${REPORT}`).set('Authorization', `Bearer ${manageNoScopeToken}`);
    assert.equal(res.status, 403);
    assert.equal(await hasActiveCareActorPermission(careActorId, REPORT), true);
  });

  it('grants nothing automatically: a new care actor has no REPORT or VERIFY grant', async () => {
    const other = await handymanCareActorService.createCareActor({
      integrationId,
      actorReference: `fresh-${randomUUID().slice(0, 6)}`, displayName: 'Fresh' });
    const n = await q(`SELECT count(*)::int AS n FROM handyman_care_actor_permission_grants WHERE care_actor_id = $1`, [other.id]);
    assert.equal(n.rows[0].n, 0);
  });
});

describe('USER / CARE_ACTOR exclusive identity at the database', () => {
  async function withRollback(fn: (c: PoolClient) => Promise<void>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('rejects a payment-event row that is CARE_ACTOR with a non-RECORD_PAYMENT event type', async () => {
    await grantCareActorPermission({ careActorId, permissionCode: REPORT }, await userIdOf(adminToken));
    const recorded = await reportAsCare(token);
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    const source = await q(
      `SELECT id FROM handyman_customer_payment_events
        WHERE event_type = 'RECORD_PAYMENT' AND actor_type = 'CARE_ACTOR' AND payment_id = $1`,
      [recorded.body.data.id]);
    assert.equal(source.rowCount, 1, 'CARE_ACTOR RECORD_PAYMENT event exists for the claim');
    await withRollback(async (c) => {
      await c.query(`CREATE TEMP TABLE ev_copy (LIKE handyman_customer_payment_events INCLUDING DEFAULTS) ON COMMIT DROP`);
      await c.query(`INSERT INTO ev_copy SELECT * FROM handyman_customer_payment_events WHERE id = $1`, [source.rows[0].id]);
      await c.query(`UPDATE ev_copy SET id = gen_random_uuid(), event_type = 'CONFIRM_PAYMENT'`);
      await assert.rejects(
        c.query(`INSERT INTO handyman_customer_payment_events SELECT * FROM ev_copy`),
        (error: any) => error.code === '23514' &&
          error.constraint === 'handyman_customer_payment_events_care_event_check');
    });
  });

  it('keeps the payment recorder identity exclusive (CHECK names the constraint)', async () => {
    const check = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'handyman_customer_payments_recorder_identity_check'`);
    assert.equal(check.rowCount, 1);
    const eventCheck = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'handyman_customer_payment_events_actor_identity_check'`);
    assert.equal(eventCheck.rowCount, 1);
  });

  it('keeps the grant table free of VERIFY at the schema level (CHECK allowlist)', async () => {
    await assert.rejects(
      q(`INSERT INTO handyman_care_actor_permission_grants
           (id, care_actor_id, permission_code, status, granted_by_user_id)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', $3)`, [careActorId, VERIFY, adminUserId]),
      (error: any) => error.code === '23514');
  });
});
