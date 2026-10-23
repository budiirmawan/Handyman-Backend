import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { vendorService } from '../src/modules/vendors';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workOrderService } from '../src/modules/work-orders';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDbHandle,
} from './helpers/embedded-test-db';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-FIELD-ASSIGNMENT-RESPONSE-01 — PART 01 Focused HTTP E2E Test Suite.
 *
 * Proves on disposable PostgreSQL:
 *  1. Exact-recipient IN_APP notification on assign & reassign (zero spam to
 *     unassigned workers or sibling-Building actors).
 *  2. Reuse of ACKNOWLEDGE as TERIMA without a second acceptance lifecycle.
 *  3. TIDAK_BISA decline with mandatory reason + server timestamp across
 *     Crew Leads, permanent/contract/freelance Work Order workers, and
 *     Inspection Visit Inspectors.
 *  4. Operations visibility (PENDING / ACCEPTED / DECLINED / SUPERSEDED +
 *     reason + immutable history) & targeted IN_APP notification to Operations.
 *  5. Declining NEVER cancels the Tenant Request or Tenant Work Order; task
 *     returns to requiring Operations reassignment.
 *  6. Reassignment revokes old worker authority and notifies new worker.
 *  7. Fail-closed guards: duplicate response (409), late/expired response (409),
 *     superseded assignment response (409), cross-Client & sibling-Building (403).
 *  8. Configurable Client/Building response deadline policy with strict
 *     prohibition on auto-reassignment (`autoReassignEnabled: false`).
 *  9. Conditional PUSH outbound delivery queueing when `mobile_push_tokens` is
 *     ACTIVE alongside authoritative IN_APP notification.
 */

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-part01-assignment-response-pg';
const DB_PORT = 55573;

let dbHandle: EmbeddedTestDbHandle | null = null;
let pool: Pool | null = null;
let adminId = '';

before(async () => {
  await rm(DB_DIR, { recursive: true, force: true });
  dbHandle = await startEmbeddedTestDatabase({ dir: DB_DIR, port: DB_PORT });
  resetAppConfigCache();
  const config = await ensureTestDatabase();
  if (!config) {
    throw new Error('Embedded PostgreSQL test database failed to initialize');
  }
  pool = await initDatabase(config);
  await migrateUp(pool);

  const admin = await createAdminUser();
  adminId = admin.userId;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) {
    throw new Error('GENERAL_HANDYMAN discipline seed missing');
  }

  initHandymanFixtures({
    adminUserId: adminId,
    disciplineId: discipline.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('Pool not initialized');
      return pool.query(text, params);
    },
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (dbHandle) await dbHandle.stop();
  } finally {
    await rm(DB_DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

async function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('Pool not initialized');
  return pool.query(text, params);
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function loginExistingUser(
  userId: string,
  email: string,
): Promise<string> {
  const password = `Pass#${randomUUID().slice(0, 8)}Aa1`;
  await credentialService.createInitialCredential({ userId, password });
  const res = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.sessionToken as string;
}

async function createPersonaUser(
  label: string,
  permissionCodes: string[],
  buildingIds: string[],
): Promise<{ userId: string; email: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const user = await userService.createUser({
    email,
    displayName: `Actor ${label}`,
  });

  if (permissionCodes.length > 0) {
    const role = await roleService.createRole({
      code: `ROLE_${label.toUpperCase()}_${randomUUID().slice(0, 6)}`,
      name: `Role ${label}`,
    });

    for (const code of permissionCodes) {
      const perm = await permissionService
        .createPermission({ code, name: `Scoped ${code}` })
        .catch(async () => permissionRepository.findByCode(code));
      assert.ok(perm, `Expected permission ${code} to exist`);
      await permissionService.assignPermissionToRole(role.id, perm.id);
    }

    await roleService.assignRoleToUser(user.id, role.id);
  }

  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }

  const token = await loginExistingUser(user.id, email);
  return { userId: user.id, email, token };
}

async function createWorkforceActor(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  workforceType: 'INTERNAL' | 'CONTRACT' | 'OUTSOURCED' | 'EXTERNAL',
  label: string,
) {
  const actor = await createPersonaUser(
    label,
    ['work_order.read', 'work_order.manage', 'notification.read'],
    [realm.building.id],
  );
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `WF_${label.toUpperCase()}_${suffix()}`,
    fullName: `${label} (${workforceType})`,
    workforceType,
    userId: actor.userId,
  });
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
  });
  return { ...actor, profile };
}

async function createInspectorActor(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  label: string,
) {
  const actor = await createPersonaUser(
    label,
    ['notification.read'],
    [realm.building.id],
  );
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `VI_${suffix()}`,
    vendorName: `Inspector Vendor ${label}`,
  });
  const providerContext =
    await handymanProviderContextService.createHandymanProviderContext(
      { vendorId: vendor.id },
      adminId,
    );
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `INSP_${suffix()}`,
    fullName: `Inspector ${label}`,
    workforceType: 'EXTERNAL',
    userId: actor.userId,
  });
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `IVP_${suffix()}`,
  });
  const workerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminId,
    );
  return { ...actor, vendor, providerContext, profile, workerContext };
}

describe('CR-HM-FIELD-ASSIGNMENT-RESPONSE-01 — PART 01 HTTP E2E', () => {
  it('1. Execution Scope Crew Lead E2E: deadline policy -> assign -> IN_APP notification -> TIDAK_BISA decline (Tenant uncancelled, Operations notified) -> reassign -> new Lead notified -> TERIMA acknowledge + negative guards', async () => {
    const realm = await realmFixture();
    const siblingBuilding = await buildingService.createBuilding({
      propertyId: realm.property.id,
      code: `SIB_${suffix()}`,
      name: 'Sibling Building',
    });
    const otherRealm = await realmFixture();

    const chain = await locationChain(realm);
    const seeded = await scopeFixture(realm, chain);

    const opsDispatcher = await createPersonaUser(
      'ops-dispatch',
      ['tenant_company.read', 'tenant_company.manage', 'notification.read'],
      [realm.building.id],
    );
    const opsManager = await createPersonaUser(
      'ops-manager',
      ['tenant_company.read', 'tenant_company.manage', 'notification.read'],
      [realm.building.id],
    );
    const siblingOps = await createPersonaUser(
      'sibling-ops',
      ['tenant_company.read', 'tenant_company.manage'],
      [siblingBuilding.id],
    );
    const crossClientOps = await createPersonaUser(
      'other-client-ops',
      ['tenant_company.read', 'tenant_company.manage'],
      [otherRealm.building.id],
    );

    const crew1 = await crewFixture(realm);
    const crew2 = await crewFixture(realm);
    const crew3 = await crewFixture(realm);

    const lead1Token = await loginExistingUser(
      crew1.leadUser.id,
      crew1.leadUser.email,
    );
    const lead2Token = await loginExistingUser(
      crew2.leadUser.id,
      crew2.leadUser.email,
    );
    const lead3Token = await loginExistingUser(
      crew3.leadUser.id,
      crew3.leadUser.email,
    );

    // Grant notification.read to Crew Leads so we can verify via HTTP GET /notifications too
    const notifPerm =
      (await permissionRepository.findByCode('notification.read')) ??
      (await permissionService.createPermission({
        code: 'notification.read',
        name: 'Read notifications',
      }));
    const workerRole = await roleService.createRole({
      code: `ROLE_NOTIF_${suffix()}`,
      name: 'Notif Reader',
    });
    await permissionService.assignPermissionToRole(workerRole.id, notifPerm.id);
    for (const uid of [crew1.leadUser.id, crew2.leadUser.id, crew3.leadUser.id]) {
      await roleService.assignRoleToUser(uid, workerRole.id);
    }

    // 1A. Configure response deadline policy; autoReassignEnabled=true is strictly forbidden
    const badAuto = await api()
      .put(`${V1}/handyman/operations/response-deadline-policy`)
      .set('Authorization', `Bearer ${opsDispatcher.token}`)
      .send({
        clientId: realm.client.id,
        buildingId: realm.building.id,
        deadlineMinutes: 45,
        autoReassignEnabled: true,
      });
    assert.equal(badAuto.status, 400);
    assert.equal(
      badAuto.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_DEADLINE_INVALID',
    );

    const putPolicy = await api()
      .put(`${V1}/handyman/operations/response-deadline-policy`)
      .set('Authorization', `Bearer ${opsDispatcher.token}`)
      .send({
        clientId: realm.client.id,
        buildingId: realm.building.id,
        deadlineMinutes: 45,
      });
    assert.equal(putPolicy.status, 200, JSON.stringify(putPolicy.body));
    assert.equal(putPolicy.body.data.deadlineMinutes, 45);
    assert.equal(putPolicy.body.data.source, 'BUILDING_POLICY');
    assert.equal(putPolicy.body.data.autoReassignEnabled, false);

    // 1B. Assign crew1 -> ONLY lead1 gets IN_APP notification; lead2 & lead3 get 0
    const assign1 = await api()
      .post(`${V1}/handyman/execution-scopes/${seeded.scope.id}/assignment`)
      .set('Authorization', `Bearer ${opsDispatcher.token}`)
      .send({
        providerContextId: crew1.providerContext.id,
        crewId: crew1.crew.id,
      });
    assert.equal(assign1.status, 201, JSON.stringify(assign1.body));
    const assignment1Id = assign1.body.data.id as string;

    const lead1Notifs = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${lead1Token}`);
    assert.equal(lead1Notifs.status, 200);
    assert.equal(lead1Notifs.body.data.length, 1);
    assert.equal(lead1Notifs.body.data[0].type, 'HANDYMAN_ASSIGNMENT_ISSUED');
    assert.equal(lead1Notifs.body.data[0].sourceEntityId, assignment1Id);

    const lead2NotifsBefore = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${lead2Token}`);
    assert.equal(lead2NotifsBefore.body.data.length, 0);

    // Mobile field feed immediately exposes pendingAssignments for lead1
    const lead1Feed = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set('Authorization', `Bearer ${lead1Token}`);
    assert.equal(lead1Feed.status, 200);
    assert.equal(lead1Feed.body.data.pendingAssignments.length, 1);
    assert.equal(
      lead1Feed.body.data.pendingAssignments[0].assignmentId,
      assignment1Id,
    );
    assert.deepEqual(
      lead1Feed.body.data.pendingAssignments[0].availableResponseActions,
      ['ACKNOWLEDGE', 'DECLINE'],
    );

    // Operations sees PENDING response
    const opsVisPending = await api()
      .get(
        `${V1}/handyman/execution-scopes/${seeded.scope.id}/worker-response`,
      )
      .set('Authorization', `Bearer ${opsDispatcher.token}`);
    assert.equal(opsVisPending.status, 200);
    assert.equal(opsVisPending.body.data.currentResponse.responseStatus, 'PENDING');
    assert.equal(opsVisPending.body.data.currentResponse.deadlineMinutes, 45);
    assert.equal(opsVisPending.body.data.requiresReassignment, false);

    // Cross-Building & Cross-Client access rejected with 403 BUILDING_ACCESS_DENIED
    for (const forbiddenToken of [siblingOps.token, crossClientOps.token]) {
      const deniedRead = await api()
        .get(
          `${V1}/handyman/execution-scopes/${seeded.scope.id}/worker-response`,
        )
        .set('Authorization', `Bearer ${forbiddenToken}`);
      assert.equal(deniedRead.status, 403);
      assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

      const deniedAck = await api()
        .post(
          `${V1}/handyman/field/execution-scopes/${seeded.scope.id}/acknowledge`,
        )
        .set('Authorization', `Bearer ${forbiddenToken}`)
        .send({});
      assert.equal(deniedAck.status, 403);
      assert.equal(deniedAck.body.error.code, 'BUILDING_ACCESS_DENIED');
    }

    // Unassigned Crew Lead in same Building rejected with 403 HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN
    const unassignedTry = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${seeded.scope.id}/acknowledge`,
      )
      .set('Authorization', `Bearer ${lead3Token}`)
      .send({});
    assert.equal(unassignedTry.status, 403);
    assert.equal(
      unassignedTry.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN',
    );

    // 1C. Decline without reason -> 400 HANDYMAN_ASSIGNMENT_DECLINE_REASON_REQUIRED
    const missingReason = await api()
      .post(`${V1}/handyman/field/execution-scopes/${seeded.scope.id}/decline`)
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({ reason: '   ' });
    assert.equal(missingReason.status, 400);
    assert.equal(
      missingReason.body.error.code,
      'HANDYMAN_ASSIGNMENT_DECLINE_REASON_REQUIRED',
    );

    // Smuggled timestamp rejected -> 400 VALIDATION_ERROR
    const smuggledTime = await api()
      .post(`${V1}/handyman/field/execution-scopes/${seeded.scope.id}/decline`)
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({
        reason: 'Valid reason',
        respondedAt: '2020-01-01T00:00:00.000Z',
      });
    assert.equal(smuggledTime.status, 400);
    assert.equal(smuggledTime.body.error.code, 'VALIDATION_ERROR');

    // 1D. Lead 1 declines (TIDAK_BISA) with mandatory reason
    const declineRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${seeded.scope.id}/decline`)
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({
        reason: 'Mesin bor beton rusak dan sedang diservis',
        notes: 'Mohon alihkan ke kru cadangan',
      });
    assert.equal(declineRes.status, 200, JSON.stringify(declineRes.body));
    assert.equal(declineRes.body.data.responseStatus, 'DECLINED');
    assert.equal(declineRes.body.data.responseCode, 'TIDAK_BISA');
    assert.equal(
      declineRes.body.data.declineReason,
      'Mesin bor beton rusak dan sedang diservis',
    );
    assert.ok(declineRes.body.data.respondedAt);

    // Tenant Service Request & Execution Scope MUST NOT BE CANCELLED!
    const reqState = await q(
      `SELECT r.status AS req_status, es.status AS scope_status
         FROM handyman_execution_scopes es
         JOIN handyman_service_requests r ON r.id = es.handyman_request_id
        WHERE es.id = $1`,
      [seeded.scope.id],
    );
    assert.notEqual(reqState.rows[0].req_status, 'CANCELLED');
    assert.equal(reqState.rows[0].scope_status, 'AUTHORIZED');

    // Duplicate decline or subsequent acknowledge by Lead 1 -> 409 HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE
    const dupDecline = await api()
      .post(`${V1}/handyman/field/execution-scopes/${seeded.scope.id}/decline`)
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({ reason: 'Ulang lagi' });
    assert.equal(dupDecline.status, 409);
    assert.equal(
      dupDecline.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE',
    );

    const dupAckAfterDecline = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${seeded.scope.id}/acknowledge`,
      )
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({});
    assert.equal(dupAckAfterDecline.status, 409);
    assert.equal(
      dupAckAfterDecline.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE',
    );

    // Operations (both dispatcher & building Operations manager) received IN_APP decline alert;
    // unassigned field worker lead2 did NOT!
    for (const opsTok of [opsDispatcher.token, opsManager.token]) {
      const opsNotifs = await api()
        .get(`${V1}/notifications`)
        .set('Authorization', `Bearer ${opsTok}`);
      assert.equal(opsNotifs.status, 200);
      assert.ok(
        opsNotifs.body.data.some(
          (n: { type: string; sourceEntityId: string }) =>
            n.type ===
              'HANDYMAN_ASSIGNMENT_DECLINED_OPERATIONS_ACTION_REQUIRED' &&
            n.sourceEntityId === assignment1Id,
        ),
      );
    }
    const lead2StillZero = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${lead2Token}`);
    assert.equal(lead2StillZero.body.data.length, 0);

    // Operations sees DECLINED + reason + requiresReassignment=true + history
    const opsVisDeclined = await api()
      .get(
        `${V1}/handyman/execution-scopes/${seeded.scope.id}/worker-response`,
      )
      .set('Authorization', `Bearer ${opsManager.token}`);
    assert.equal(opsVisDeclined.status, 200);
    assert.equal(opsVisDeclined.body.data.currentResponse, null);
    assert.equal(opsVisDeclined.body.data.latestResponse.responseStatus, 'DECLINED');
    assert.equal(
      opsVisDeclined.body.data.latestResponse.declineReason,
      'Mesin bor beton rusak dan sedang diservis',
    );
    assert.equal(opsVisDeclined.body.data.requiresReassignment, true);
    assert.equal(
      opsVisDeclined.body.data.reassignmentReasonCode,
      'WORKER_DECLINED_TIDAK_BISA',
    );
    assert.equal(opsVisDeclined.body.data.tenantWorkOrderCancelled, false);

    // SLA/Status visibility also surfaces declined state & requiresReassignment
    const statusVis = await api()
      .get(`${V1}/handyman/execution-scopes/${seeded.scope.id}/status-visibility`)
      .set('Authorization', `Bearer ${opsManager.token}`);
    assert.equal(statusVis.status, 200);
    assert.equal(statusVis.body.data.stages.assignment.responseStatus, 'DECLINED');
    assert.equal(statusVis.body.data.stages.assignment.requiresReassignment, true);

    // 1E. Operations reassigns to crew2 (lead2) via /assignment/reassign
    const reassignRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${seeded.scope.id}/assignment/reassign`,
      )
      .set('Authorization', `Bearer ${opsDispatcher.token}`)
      .send({
        providerContextId: crew2.providerContext.id,
        crewId: crew2.crew.id,
        expectedVersion: 1,
        reason: 'Reassigned after Crew 1 TIDAK_BISA equipment issue',
      });
    assert.equal(reassignRes.status, 201, JSON.stringify(reassignRes.body));
    const assignment2Id = reassignRes.body.data.id as string;
    assert.equal(reassignRes.body.data.supersedesAssignmentId, assignment1Id);

    // Lead 2 receives IN_APP notification; Lead 1 still has only original 1 notification
    const lead2NotifsAfter = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${lead2Token}`);
    assert.equal(lead2NotifsAfter.body.data.length, 1);
    assert.equal(
      lead2NotifsAfter.body.data[0].sourceEntityId,
      assignment2Id,
    );
    const lead1NotifsAfter = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${lead1Token}`);
    assert.equal(lead1NotifsAfter.body.data.length, 1);

    // Former Lead 1 attempting to respond after reassignment -> 409 HANDYMAN_ASSIGNMENT_SUPERSEDED
    const oldLeadTryNoId = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${seeded.scope.id}/acknowledge`,
      )
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({});
    assert.equal(oldLeadTryNoId.status, 409);
    assert.equal(
      oldLeadTryNoId.body.error.code,
      'HANDYMAN_ASSIGNMENT_SUPERSEDED',
    );

    const oldLeadTryWithOldId = await api()
      .post(`${V1}/handyman/field/execution-scopes/${seeded.scope.id}/decline`)
      .set('Authorization', `Bearer ${lead1Token}`)
      .send({ assignmentId: assignment1Id, reason: 'Sudah diganti' });
    assert.equal(oldLeadTryWithOldId.status, 409);
    assert.equal(
      oldLeadTryWithOldId.body.error.code,
      'HANDYMAN_ASSIGNMENT_SUPERSEDED',
    );

    // 1F. Lead 2 accepts (TERIMA) via acknowledge
    const ack2 = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${seeded.scope.id}/acknowledge`,
      )
      .set('Authorization', `Bearer ${lead2Token}`)
      .send({ notes: 'Siap kerjakan sesuai jadwal' });
    assert.equal(ack2.status, 200, JSON.stringify(ack2.body));
    assert.equal(ack2.body.data.responseStatus, 'ACCEPTED');
    assert.equal(ack2.body.data.responseCode, 'TERIMA');
    assert.ok(ack2.body.data.respondedAt);
    assert.deepEqual(ack2.body.data.availableResponseActions, []);

    // Duplicate acknowledge or post-acceptance decline -> 409 HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE
    const dupAck2 = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${seeded.scope.id}/acknowledge`,
      )
      .set('Authorization', `Bearer ${lead2Token}`)
      .send({});
    assert.equal(dupAck2.status, 409);
    assert.equal(
      dupAck2.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE',
    );

    // Operations sees ACCEPTED current response + preserved historical DECLINED response + full immutable event trail
    const opsVisAccepted = await api()
      .get(
        `${V1}/handyman/execution-scopes/${seeded.scope.id}/worker-response`,
      )
      .set('Authorization', `Bearer ${opsManager.token}`);
    assert.equal(opsVisAccepted.status, 200);
    assert.equal(
      opsVisAccepted.body.data.currentResponse.responseStatus,
      'ACCEPTED',
    );
    assert.equal(opsVisAccepted.body.data.responses.length, 2);
    assert.deepEqual(
      opsVisAccepted.body.data.responses.map(
        (r: { responseStatus: string }) => r.responseStatus,
      ),
      ['ACCEPTED', 'DECLINED'],
    );
    assert.deepEqual(
      opsVisAccepted.body.data.history.map(
        (e: { eventType: string }) => e.eventType,
      ),
      [
        'ASSIGNMENT_ISSUED',
        'DECLINED_TIDAK_BISA',
        'ASSIGNMENT_SUPERSEDED',
        'ASSIGNMENT_ISSUED',
        'ACKNOWLEDGED_TERIMA',
      ],
    );
  });

  it('2. Direct / FM Work Order across Permanent (INTERNAL), Contract (CONTRACT), and Freelance (EXTERNAL) workers: ACKNOWLEDGE reused as TERIMA, TIDAK_BISA keeps Work Order OPEN, and conditional PUSH delivery queued', async () => {
    const realm = await realmFixture();
    const ops = await createPersonaUser(
      'wo-ops',
      ['work_order.read', 'work_order.manage', 'notification.read'],
      [realm.building.id],
    );

    const permanentWorker = await createWorkforceActor(
      realm,
      'INTERNAL',
      'perm-worker',
    );
    const contractWorker = await createWorkforceActor(
      realm,
      'CONTRACT',
      'contract-worker',
    );
    const freelanceWorker = await createWorkforceActor(
      realm,
      'EXTERNAL',
      'freelance-worker',
    );
    const bystanderWorker = await createWorkforceActor(
      realm,
      'OUTSOURCED',
      'bystander-worker',
    );

    // Register an ACTIVE mobile push token for freelanceWorker to verify conditional PUSH queueing
    await q(
      `INSERT INTO mobile_push_tokens (
         id, user_id, device_id, platform, push_token, status, last_seen_at
       ) VALUES ($1, $2, $3, 'ANDROID', $4, 'ACTIVE', NOW())`,
      [
        randomUUID(),
        freelanceWorker.userId,
        `dev-${randomUUID().slice(0, 8)}`,
        `fcm-token-${randomUUID()}`,
      ],
    );

    const wo = await workOrderService.createWorkOrder({
      clientId: realm.client.id,
      buildingId: realm.building.id,
      workOrderNumber: `WO-HM-${suffix()}`,
      title: 'Perbaikan Engsel Pintu Lobby Utama',
      description: 'Engsel pintu kaca kendor',
      workType: 'CORRECTIVE',
      priority: 'HIGH',
      createdByUserId: ops.userId,
    });

    // 2A. Assign Permanent worker -> receives IN_APP notification with WORK_ORDER_FIELD_WORK navigationTarget
    const assignPerm = await api()
      .post(`${V1}/work-orders/${wo.id}/assignments`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: permanentWorker.profile.id,
      });
    assert.equal(assignPerm.status, 201, JSON.stringify(assignPerm.body));
    const permAssignId = assignPerm.body.data.id as string;

    const permNotifs = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${permanentWorker.token}`);
    assert.equal(permNotifs.status, 200);
    assert.equal(permNotifs.body.data.length, 1);
    assert.deepEqual(permNotifs.body.data[0].navigationTarget, {
      type: 'WORK_ORDER_FIELD_WORK',
      id: wo.id,
    });

    // Bystander worker got 0 notifications
    const bystanderNotifs = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${bystanderWorker.token}`);
    assert.equal(bystanderNotifs.body.data.length, 0);

    // 2B. Permanent worker declines (TIDAK_BISA) -> Work Order stays OPEN (NOT CANCELLED), Operations notified
    const permDecline = await api()
      .post(`${V1}/work-orders/${wo.id}/decline`)
      .set('Authorization', `Bearer ${permanentWorker.token}`)
      .send({ reason: 'Sedang menangani kebocoran ruang pompa basement' });
    assert.equal(permDecline.status, 200, JSON.stringify(permDecline.body));
    assert.equal(permDecline.body.data.responseStatus, 'DECLINED');
    assert.equal(permDecline.body.data.responseCode, 'TIDAK_BISA');

    const woAfterDecline = await workOrderService.getWorkOrderById(wo.id);
    assert.equal(woAfterDecline.status, 'OPEN');
    assert.notEqual(woAfterDecline.status, 'CANCELLED');

    const opsNotifsAfterPerm = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${ops.token}`);
    assert.ok(
      opsNotifsAfterPerm.body.data.some(
        (n: { type: string; sourceEntityId: string }) =>
          n.type ===
            'WORK_ORDER_ASSIGNMENT_DECLINED_OPERATIONS_ACTION_REQUIRED' &&
          n.sourceEntityId === permAssignId,
      ),
    );

    // 2C. Operations reassigns to Contract worker -> Contract worker notified; Permanent worker superseded (409)
    const reassignContract = await api()
      .patch(`${V1}/work-orders/${wo.id}/assignments/${permAssignId}`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: contractWorker.profile.id,
      });
    assert.equal(reassignContract.status, 200);
    const contractAssignId = reassignContract.body.data.id as string;

    const permLateAck = await api()
      .post(`${V1}/work-orders/${wo.id}/acknowledge`)
      .set('Authorization', `Bearer ${permanentWorker.token}`)
      .send({});
    assert.equal(permLateAck.status, 409);
    assert.equal(permLateAck.body.error.code, 'HANDYMAN_ASSIGNMENT_SUPERSEDED');

    // Contract worker gets replaced by Freelance worker BEFORE responding -> Contract worker's PENDING becomes SUPERSEDED
    const reassignFreelance = await api()
      .patch(`${V1}/work-orders/${wo.id}/assignments/${contractAssignId}`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: freelanceWorker.profile.id,
      });
    assert.equal(reassignFreelance.status, 200);
    const freelanceAssignId = reassignFreelance.body.data.id as string;

    // Contract worker trying to respond after replacement -> 409 HANDYMAN_ASSIGNMENT_SUPERSEDED
    const contractSupersededDecline = await api()
      .post(`${V1}/work-orders/${wo.id}/decline`)
      .set('Authorization', `Bearer ${contractWorker.token}`)
      .send({ reason: 'Terlambat lihat aplikasi' });
    assert.equal(contractSupersededDecline.status, 409);
    assert.equal(
      contractSupersededDecline.body.error.code,
      'HANDYMAN_ASSIGNMENT_SUPERSEDED',
    );

    // Verify Freelance worker received BOTH IN_APP notification AND conditional PUSH outbound delivery intent
    const freelanceNotifs = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${freelanceWorker.token}`);
    assert.equal(freelanceNotifs.body.data.length, 1);

    const pushRow = await q(
      `SELECT channel, status
         FROM notification_outbound_deliveries
        WHERE recipient_user_id = $1
          AND source_entity_id = $2`,
      [freelanceWorker.userId, freelanceAssignId],
    );
    assert.equal(pushRow.rows.length, 1);
    assert.equal(pushRow.rows[0].channel, 'PUSH');
    assert.equal(pushRow.rows[0].status, 'PENDING');

    // 2D. Freelance worker reuses POST /work-orders/:id/acknowledge as TERIMA!
    const freelanceAck = await api()
      .post(`${V1}/work-orders/${wo.id}/acknowledge`)
      .set('Authorization', `Bearer ${freelanceWorker.token}`)
      .send({ notes: 'Siap menuju lokasi sekarang' });
    assert.equal(freelanceAck.status, 201, JSON.stringify(freelanceAck.body));
    assert.equal(freelanceAck.body.data.actionType, 'ACKNOWLEDGED');

    // Duplicate /acknowledge or /decline on same assignment -> 409 HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE
    const freelanceDupAck = await api()
      .post(`${V1}/work-orders/${wo.id}/acknowledge`)
      .set('Authorization', `Bearer ${freelanceWorker.token}`)
      .send({});
    assert.equal(freelanceDupAck.status, 409);
    assert.equal(
      freelanceDupAck.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE',
    );

    const freelanceDeclineAfterAck = await api()
      .post(`${V1}/work-orders/${wo.id}/decline`)
      .set('Authorization', `Bearer ${freelanceWorker.token}`)
      .send({ reason: 'Berubah pikiran' });
    assert.equal(freelanceDeclineAfterAck.status, 409);
    assert.equal(
      freelanceDeclineAfterAck.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE',
    );

    // Operations visibility shows ACCEPTED, SUPERSEDED, and DECLINED across all 3 workers!
    const woVis = await api()
      .get(`${V1}/work-orders/${wo.id}/worker-response`)
      .set('Authorization', `Bearer ${ops.token}`);
    assert.equal(woVis.status, 200);
    assert.equal(woVis.body.data.targetLifecycleStatus, 'ASSIGNED');
    assert.equal(woVis.body.data.currentResponse.assignmentId, freelanceAssignId);
    assert.equal(woVis.body.data.currentResponse.responseStatus, 'ACCEPTED');
    assert.equal(woVis.body.data.currentResponse.responseCode, 'TERIMA');
    assert.deepEqual(
      woVis.body.data.responses.map(
        (r: { responseStatus: string }) => r.responseStatus,
      ),
      ['ACCEPTED', 'SUPERSEDED', 'DECLINED'],
    );
  });

  it('3. Inspection Visit Inspector E2E + Late/Expired Response Guard (no auto-reassignment) + DB immutability trigger', async () => {
    const realm = await realmFixture();
    const chain = await locationChain(realm);
    const seeded = await scopeFixture(realm, chain);

    const ops = await createPersonaUser(
      'insp-ops',
      ['tenant_company.read', 'tenant_company.manage', 'notification.read'],
      [realm.building.id],
    );
    const inspector1 = await createInspectorActor(realm, 'insp-one');
    const inspector2 = await createInspectorActor(realm, 'insp-two');
    const inspector3 = await createInspectorActor(realm, 'insp-three');

    // Create PROPOSED INSPECTION visit appointment on seeded.request.id
    const visitInsert = await q(
      `INSERT INTO handyman_visit_appointments (
         id, client_id, handyman_request_id, tenant_company_id, building_id,
         kind, resource_type, resource_id, start_at, end_at, timezone,
         state, created_by_user_id, tenant_choice_evidence_ref
       )
       SELECT $1, r.client_id, r.id, r.tenant_company_id, r.building_id,
         'INSPECTION', 'INSPECTOR_USER', $2, NOW() + INTERVAL '2 hours',
         NOW() + INTERVAL '3 hours', COALESCE(b.timezone, 'UTC'),
         'PROPOSED', $3, 'seed-choice'
         FROM handyman_service_requests r
         JOIN buildings b ON b.id = r.building_id
        WHERE r.id = $4
       RETURNING id`,
      [randomUUID(), inspector1.userId, ops.userId, seeded.scope.handymanRequestId],
    );
    const visitId = visitInsert.rows[0].id as string;

    // 3A. Assign inspector1 -> notified; inspector1 declines -> Operations notified -> reassign inspector2 -> accepts
    const assignInsp1 = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({ inspectorUserId: inspector1.userId });
    assert.equal(assignInsp1.status, 201, JSON.stringify(assignInsp1.body));

    const insp1Notifs = await api()
      .get(`${V1}/notifications`)
      .set('Authorization', `Bearer ${inspector1.token}`);
    assert.equal(insp1Notifs.body.data.length, 1);
    assert.equal(
      insp1Notifs.body.data[0].type,
      'HANDYMAN_INSPECTOR_ASSIGNMENT_ISSUED',
    );

    const insp1Decline = await api()
      .post(`${V1}/handyman/field/visit-appointments/${visitId}/decline`)
      .set('Authorization', `Bearer ${inspector1.token}`)
      .send({ reason: 'Sedang inspeksi unit lain di lantai 22' });
    assert.equal(insp1Decline.status, 200);
    assert.equal(insp1Decline.body.data.responseStatus, 'DECLINED');
    assert.equal(insp1Decline.body.data.responseCode, 'TIDAK_BISA');

    // Visit remains PROPOSED (not CANCELLED)
    const visitState = await q(
      `SELECT state FROM handyman_visit_appointments WHERE id = $1`,
      [visitId],
    );
    assert.equal(visitState.rows[0].state, 'PROPOSED');

    const reassignInsp2 = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector/reassign`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({
        inspectorUserId: inspector2.userId,
        expectedVersion: 1,
        reason: 'Reassign after Inspector 1 TIDAK_BISA',
      });
    assert.equal(reassignInsp2.status, 201, JSON.stringify(reassignInsp2.body));
    const insp2AssignmentId = reassignInsp2.body.data.id as string;

    // 3B. Simulate expired response deadline on inspector2 -> NO auto-reassignment; late response rejected 409!
    await q(
      `UPDATE handyman_assignment_responses
          SET response_deadline_at = NOW() - INTERVAL '5 minutes'
        WHERE assignment_id = $1`,
      [insp2AssignmentId],
    );

    const lateAck = await api()
      .post(`${V1}/handyman/field/visit-appointments/${visitId}/acknowledge`)
      .set('Authorization', `Bearer ${inspector2.token}`)
      .send({});
    assert.equal(lateAck.status, 409);
    assert.equal(
      lateAck.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED',
    );

    const lateDecline = await api()
      .post(`${V1}/handyman/field/visit-appointments/${visitId}/decline`)
      .set('Authorization', `Bearer ${inspector2.token}`)
      .send({ reason: 'Terlambat merespons' });
    assert.equal(lateDecline.status, 409);
    assert.equal(
      lateDecline.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED',
    );

    // Operations visibility proves NO auto-reassignment occurred; flags RESPONSE_DEADLINE_EXCEEDED
    const overdueVis = await api()
      .get(`${V1}/handyman/visit-appointments/${visitId}/worker-response`)
      .set('Authorization', `Bearer ${ops.token}`);
    assert.equal(overdueVis.status, 200);
    assert.equal(overdueVis.body.data.currentResponse.assignmentId, insp2AssignmentId);
    assert.equal(overdueVis.body.data.currentResponse.responseStatus, 'PENDING');
    assert.equal(overdueVis.body.data.currentResponse.isResponseOverdue, true);
    assert.equal(overdueVis.body.data.requiresReassignment, true);
    assert.equal(
      overdueVis.body.data.reassignmentReasonCode,
      'RESPONSE_DEADLINE_EXCEEDED',
    );

    // Operations explicitly reassigns to inspector3 -> inspector3 accepts (TERIMA)
    const reassignInsp3 = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector/reassign`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({
        inspectorUserId: inspector3.userId,
        expectedVersion: 1,
        reason: 'Explicit Operations reassignment after deadline exceeded',
      });
    assert.equal(reassignInsp3.status, 201);

    const insp3Ack = await api()
      .post(`${V1}/handyman/field/visit-appointments/${visitId}/acknowledge`)
      .set('Authorization', `Bearer ${inspector3.token}`)
      .send({ responseCode: 'TERIMA', notes: 'Siap inspeksi' });
    assert.equal(insp3Ack.status, 200);
    assert.equal(insp3Ack.body.data.responseStatus, 'ACCEPTED');

    // 3C. Prove DB immutability trigger on handyman_assignment_response_events
    await assert.rejects(
      () =>
        q(
          `DELETE FROM handyman_assignment_response_events
            WHERE visit_appointment_id = $1`,
          [visitId],
        ),
      /immutable and append-only/i,
    );
  });
});
