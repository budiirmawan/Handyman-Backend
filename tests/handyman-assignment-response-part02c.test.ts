/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 — PART 02C: Cross-App Projection & E2E.
 *
 * End-to-end disposable PostgreSQL integration tests verifying:
 *   A. Mobile projections (`GET /mobile/assignments`, `GET /handyman/field/my-jobs`,
 *      `GET /handyman/field/my-inspections`, `GET /handyman/field/work-orders/:executionScopeId`,
 *      `GET /handyman/field/requests/:handymanRequestId`) with authoritative
 *      `responseStatus`, `reassignmentRequired`, `availableActions`, and
 *      unconfused `item.id` (`assignmentId`) vs `reference.workOrderId`.
 *   B. Operations projections (`GET /handyman/operations/queue`,
 *      `GET /handyman/requests/:id/status-visibility`,
 *      `GET /handyman/execution-scopes/:id/status-visibility`,
 *      assignment detail & `response-history` across active and superseded rows).
 *   C. Notification integration & `GET /notifications/:id/navigation-target`
 *      for both Mobile assignees and Operations recipients, plus deduplication.
 *   D. Edge-case authority: Crew Lead change (`designateHandymanCrewLead`)
 *      after `TERIMA` and after `TIDAK_BISA` (rotating to a new assignment version
 *      without overwriting immutable prior Lead decisions), session revocation,
 *      concurrency (`FOR UPDATE`), cross-Client/Building isolation, and
 *      migration `0472` CHECK constraints.
 *   E. Full E2E flows across Standard Work Order, Execution Scope Crew Lead +
 *      login-less Helper attendance, and Inspector Visit.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanDispatchRepository } from '../src/modules/handyman-dispatch';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import {
  addHandymanCrewMember,
  handymanProviderContextService,
  handymanWorkCrewService,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestService,
  recordHandymanRequestTriage,
} from '../src/modules/handyman-requests';
import {
  MOBILE_STAFF_ROLE,
  OPERATIONS_ROLE,
} from '../src/modules/iam-bootstrap/iam-canonical-roles';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
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

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-part02c-assignment-response-pg';
const DB_PORT = 55583;

let dbHandle: EmbeddedTestDbHandle | null = null;
let pool: Pool | null = null;
let adminId = '';
let adminToken = '';

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function auth(token = adminToken): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('Pool not initialized');
  return pool.query(text, params);
}

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
  adminToken = admin.token;

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

async function createScopedPersona(
  buildingId: string,
  permissionCodes: readonly string[],
): Promise<{ userId: string; token: string }> {
  const perms = permissionCodes.map((code) => ({
    code,
    name: `Perm ${code}`,
  }));
  const token = await createSessionWithPermissions(perms);
  const me = await api().get(`${V1}/auth/me`).set(auth(token));
  assert.equal(me.status, 200);
  const userId = me.body.data.user.id as string;
  await buildingAssignmentService.createAssignment(userId, { buildingId });
  return { userId, token };
}

async function loginAsMobileWorker(
  userId: string,
  email: string,
): Promise<string> {
  const password = `Pass#${suffix()}Aa1`;
  await credentialService.createInitialCredential({ userId, password });

  const role = await roleService.createRole({
    code: `MOB_STAFF_${suffix()}`,
    name: `Mobile Staff ${suffix()}`,
  });
  for (const code of ['work_order.read', 'tenant_company.read', 'task.read']) {
    let perm = await permissionRepository.findByCode(code);
    if (!perm) {
      perm = await permissionService.createPermission({
        code,
        name: code,
      });
    }
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  await roleService.assignRoleToUser(userId, role.id);

  const res = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.sessionToken as string;
}

async function createLoginlessHelper(input: {
  realm: Awaited<ReturnType<typeof realmFixture>>;
  vendorId: string;
  providerContextId: string;
  fullName: string;
}) {
  const s = suffix();
  const profile = await workforceService.createWorkforceProfile({
    organizationId: input.realm.organization.id,
    departmentId: input.realm.department.id,
    positionId: input.realm.position.id,
    employeeCode: `HLP_${s}`,
    fullName: input.fullName,
    workforceType: 'EXTERNAL',
    // Explicitly NO userId -> login-less Helper without smartphone / account
  });
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: input.realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: input.vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VPH_${s}`,
  });
  const workerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: input.providerContextId,
        workforceProfileId: profile.id,
      },
      adminId,
    );
  return { profile, workerContext };
}

async function createLinkedCrewMember(input: {
  realm: Awaited<ReturnType<typeof realmFixture>>;
  vendorId: string;
  providerContextId: string;
  fullName: string;
}) {
  const s = suffix();
  const user = await userService.createUser({
    email: `member-${s.toLowerCase()}@example.com`,
    displayName: input.fullName,
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: input.realm.building.id,
  });
  const token = await loginAsMobileWorker(user.id, user.email);
  const profile = await workforceService.createWorkforceProfile({
    organizationId: input.realm.organization.id,
    departmentId: input.realm.department.id,
    positionId: input.realm.position.id,
    employeeCode: `MBR_${s}`,
    fullName: input.fullName,
    workforceType: 'EXTERNAL',
    userId: user.id,
  });
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: input.realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: input.vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VPM_${s}`,
  });
  const workerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: input.providerContextId,
        workforceProfileId: profile.id,
      },
      adminId,
    );
  return { user, token, profile, workerContext };
}

async function createEligibleInspector(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  label = 'Inspector',
) {
  const s = suffix();
  const user = await userService.createUser({
    email: `insp-${s.toLowerCase()}@example.com`,
    displayName: `${label} ${s}`,
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: realm.building.id,
  });
  const token = await loginAsMobileWorker(user.id, user.email);
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `VI_${s}`,
    vendorName: `Inspector Vendor ${s}`,
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
    employeeCode: `INSP_${s}`,
    fullName: `${label} ${s}`,
    workforceType: 'EXTERNAL',
    userId: user.id,
  });
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VPI_${s}`,
  });
  const workerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminId,
    );
  return { user, token, vendor, providerContext, profile, workerContext };
}

async function createInspectionRequiredRequestAndVisit(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  inspectorUserId: string,
) {
  const s = suffix();
  const chain = await locationChain(realm);
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${s}`,
      tenantName: `Tenant Company ${s}`,
    },
    adminId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${s.toLowerCase()}@example.com`,
    displayName: `Customer ${s}`,
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `Tenant Requester ${s}`,
      email: `requester-${s.toLowerCase()}@tenant.example.com`,
      userId: linkedUser.id,
    },
    adminId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
      spaceId: chain.space.id,
    },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
    },
    adminId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM_${s}`,
      name: `Handyman Service ${s}`,
      category: 'FM_HINT_TEXT',
    },
    adminId,
  );
  const request =
    await handymanServiceRequestService.createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
      },
      adminId,
    );
  await recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Requires on-site inspection visit.',
    },
    adminId,
  );
  const visitRes = await q(
    `INSERT INTO handyman_visit_appointments (
       id, client_id, handyman_request_id, tenant_company_id, building_id,
       kind, resource_type, resource_id, start_at, end_at, timezone,
       state, created_by_user_id, tenant_choice_evidence_ref
     )
     VALUES (
       $1, $2, $3, $4, $5,
       'INSPECTION', 'INSPECTOR_USER', $6,
       NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 'Asia/Jakarta',
       'PROPOSED', $7, 'seed-choice'
     )
     RETURNING id`,
    [
      randomUUID(),
      realm.client.id,
      request.id,
      company.id,
      realm.building.id,
      inspectorUserId,
      adminId,
    ],
  );
  return {
    requestId: request.id,
    visitId: visitRes.rows[0].id as string,
    chain,
  };
}

const REF_COORDS = { latitude: -6.2, longitude: 106.816666 };

async function performDispatchArrivalAndCheckIn(input: {
  realm: Awaited<ReturnType<typeof realmFixture>>;
  chain: Awaited<ReturnType<typeof locationChain>>;
  scopeId: string;
  assignmentId: string;
  leadUserId: string;
  leadToken: string;
}): Promise<string> {
  if (!pool) throw new Error('Pool not initialized');
  const existingRelease = await handymanDispatchRepository.findActiveByScope(
    pool,
    input.scopeId,
  );
  if (!existingRelease) {
    await handymanDispatchRepository.insert(pool, {
      clientId: input.realm.client.id,
      executionScopeId: input.scopeId,
      assignmentId: input.assignmentId,
      appointmentId: null,
      releasedByUserId: adminId,
      readinessSnapshot: { ready: true },
    });
  }

  await saveHandymanBuildingGeospatialPolicy(
    {
      buildingId: input.realm.building.id,
      referenceLatitude: REF_COORDS.latitude,
      referenceLongitude: REF_COORDS.longitude,
      geofenceRadiusMeters: 100,
      maxAccuracyMeters: 40,
      maxLocationAgeSeconds: 900,
    },
    adminId,
  );
  const reg = await createHandymanArrivalLocationIdentifier(
    {
      buildingId: input.realm.building.id,
      floorId: input.chain.floor.id,
      areaId: input.chain.area.id,
      roomId: input.chain.room.id,
      spaceId: input.chain.space.id,
    },
    adminId,
  );
  const challenge = await createHandymanArrivalChallenge(
    { executionScopeId: input.scopeId },
    input.leadUserId,
  );
  const arrival = await evaluateHandymanArrivalVerification(
    {
      executionScopeId: input.scopeId,
      challengeToken: challenge.token,
      qrOpaqueCode: reg.value,
      deviceLocation: {
        latitude: REF_COORDS.latitude,
        longitude: REF_COORDS.longitude,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
    },
    input.leadUserId,
  );
  assert.equal(arrival.status, 'VERIFIED');

  const checkInRes = await api()
    .post(
      `${V1}/handyman/execution-scopes/${input.scopeId}/work-sessions/check-in`,
    )
    .set(auth(input.leadToken))
    .send({ idempotencyKey: `checkin-${randomUUID()}` });
  assert.equal(checkInRes.status, 200, JSON.stringify(checkInRes.body));
  return checkInRes.body.data.session.id as string;
}

describe('CR-HM-ASSIGNMENT-RESPONSE-01 PART 02C — Cross-App Projection & E2E', () => {
  it('1. E2E Standard Work Order: Mobile feed projection, navigation-target for Mobile & Operations, TIDAK_BISA -> reassign -> TERIMA -> execution', async () => {
    const realm = await realmFixture('P02C_WO');
    const opsUser = await createScopedPersona(
      realm.building.id,
      OPERATIONS_ROLE.permissions,
    );
    // Worker 1 holds MOBILE_STAFF_ROLE (work_order.read + task.read, NO work_order.manage)
    const worker1 = await createScopedPersona(
      realm.building.id,
      MOBILE_STAFF_ROLE.permissions,
    );
    const worker1Profile = await workforceService.createWorkforceProfile({
      organizationId: realm.organization.id,
      departmentId: realm.department.id,
      positionId: realm.position.id,
      userId: worker1.userId,
      employeeCode: `W1_${suffix()}`,
      fullName: 'Mobile Worker 1',
      workforceType: 'INTERNAL',
    });
    await assignBuildingToWorkforce({
      workforceProfileId: worker1Profile.id,
      buildingId: realm.building.id,
    });

    // Worker 2 holds MOBILE_STAFF_ROLE + work_order.manage to run BE-08F /start after TERIMA
    const worker2 = await createScopedPersona(realm.building.id, [
      ...MOBILE_STAFF_ROLE.permissions,
      'work_order.manage',
    ]);
    const worker2Profile = await workforceService.createWorkforceProfile({
      organizationId: realm.organization.id,
      departmentId: realm.department.id,
      positionId: realm.position.id,
      userId: worker2.userId,
      employeeCode: `W2_${suffix()}`,
      fullName: 'Mobile Worker 2',
      workforceType: 'INTERNAL',
    });
    await assignBuildingToWorkforce({
      workforceProfileId: worker2Profile.id,
      buildingId: realm.building.id,
    });

    // Operations creates Work Order and assigns Worker 1
    const wo = await workOrderService.createWorkOrder({
      clientId: realm.client.id,
      buildingId: realm.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Perbaikan Pipa Air Lt 3',
      description: 'Kebocoran pipa air bersih',
      workType: 'REPAIR',
      priority: 'HIGH',
      createdByUserId: opsUser.userId,
    });
    const workOrderId = wo.id;

    const assign1Res = await api()
      .post(`${V1}/work-orders/${workOrderId}/assignments`)
      .set(auth(opsUser.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: worker1Profile.id,
      });
    assert.equal(assign1Res.status, 201, JSON.stringify(assign1Res.body));
    const assignment1Id = assign1Res.body.data.id as string;
    assert.notEqual(assignment1Id, workOrderId);

    // A. Mobile projection on GET /mobile/assignments for Worker 1 (without work_order.manage!)
    const feed1Pending = await api()
      .get(`${V1}/mobile/assignments`)
      .set(auth(worker1.token));
    assert.equal(feed1Pending.status, 200);
    const item1 = feed1Pending.body.data.find(
      (i: { id: string }) => i.id === assignment1Id,
    );
    assert.ok(item1, 'Worker 1 should see assignment in /mobile/assignments');
    assert.equal(item1.id, assignment1Id, 'item.id must be assignmentId');
    assert.equal(
      item1.reference.workOrderId,
      workOrderId,
      'reference.workOrderId must be workOrderId',
    );
    assert.notEqual(item1.id, item1.reference.workOrderId);
    assert.equal(item1.assignee.assignmentId, assignment1Id);
    assert.equal(item1.assignee.responseStatus, 'PENDING');
    assert.equal(item1.assignee.reassignmentRequired, false);
    assert.deepEqual(item1.assignee.availableResponseActions, [
      'TERIMA',
      'TIDAK_BISA',
    ]);
    assert.deepEqual(item1.availableActions, ['TERIMA', 'TIDAK_BISA']);

    // C. Notification navigation-target for Worker 1 (PENDING)
    const worker1Notifs = await api()
      .get(`${V1}/notifications`)
      .set(auth(worker1.token));
    assert.equal(worker1Notifs.status, 200);
    const pendingNotif1 = worker1Notifs.body.data.find(
      (n: { sourceEntityId: string; sourceEventType: string }) =>
        n.sourceEntityId === assignment1Id &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_PENDING',
    );
    assert.ok(pendingNotif1);

    const nav1Pending = await api()
      .get(`${V1}/notifications/${pendingNotif1.id}/navigation-target`)
      .set(auth(worker1.token));
    assert.equal(nav1Pending.status, 200, JSON.stringify(nav1Pending.body));
    assert.equal(nav1Pending.body.data.target.destination, 'FIELD_WORK');
    assert.equal(nav1Pending.body.data.target.assignment.id, assignment1Id);
    assert.equal(
      nav1Pending.body.data.target.assignment.reference.workOrderId,
      workOrderId,
    );

    // Worker 1 responds TIDAK_BISA (without work_order.manage!)
    const declineRes = await api()
      .post(
        `${V1}/work-orders/${workOrderId}/assignments/${assignment1Id}/respond`,
      )
      .set(auth(worker1.token))
      .send({
        decision: 'TIDAK_BISA',
        reason: 'Sedang menangani darurat di gedung sebelah',
        idempotencyKey: `wo-decline-${assignment1Id}`,
      });
    assert.equal(declineRes.status, 200, JSON.stringify(declineRes.body));
    assert.equal(declineRes.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(declineRes.body.data.reassignmentRequired, true);

    // Mobile feed after TIDAK_BISA: availableActions is [] (START removed)
    const feed1Declined = await api()
      .get(`${V1}/mobile/assignments`)
      .set(auth(worker1.token));
    const item1AfterDecline = feed1Declined.body.data.find(
      (i: { id: string }) => i.id === assignment1Id,
    );
    assert.ok(item1AfterDecline);
    assert.equal(item1AfterDecline.assignee.responseStatus, 'TIDAK_BISA');
    assert.equal(item1AfterDecline.assignee.reassignmentRequired, true);
    assert.equal(
      item1AfterDecline.assignee.declineReason,
      'Sedang menangani darurat di gedung sebelah',
    );
    assert.deepEqual(item1AfterDecline.availableActions, []);

    // Navigation target for Worker 1 after TIDAK_BISA resolves to null
    const nav1AfterDecline = await api()
      .get(`${V1}/notifications/${pendingNotif1.id}/navigation-target`)
      .set(auth(worker1.token));
    assert.equal(nav1AfterDecline.status, 200);
    assert.equal(nav1AfterDecline.body.data.target, null);

    // Operations receives WORK_ORDER_ASSIGNMENT_DECLINED notification & resolves navigation-target
    const opsNotifs = await api()
      .get(`${V1}/notifications`)
      .set(auth(opsUser.token));
    const opsDeclineNotif = opsNotifs.body.data.find(
      (n: { sourceEntityId: string; sourceEventType: string }) =>
        n.sourceEntityId === assignment1Id &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_DECLINED',
    );
    assert.ok(opsDeclineNotif, 'Operations must receive decline notification');

    const opsNavDeclined = await api()
      .get(`${V1}/notifications/${opsDeclineNotif.id}/navigation-target`)
      .set(auth(opsUser.token));
    assert.equal(
      opsNavDeclined.status,
      200,
      JSON.stringify(opsNavDeclined.body),
    );
    assert.equal(
      opsNavDeclined.body.data.target.destination,
      'OPERATIONS_WORK_ORDER',
    );
    assert.equal(opsNavDeclined.body.data.target.workOrderId, workOrderId);
    assert.equal(opsNavDeclined.body.data.target.assignmentId, assignment1Id);
    assert.equal(opsNavDeclined.body.data.target.responseStatus, 'TIDAK_BISA');
    assert.equal(opsNavDeclined.body.data.target.reassignmentRequired, true);

    // Operations reassigns to Worker 2
    const assign2Res = await api()
      .patch(`${V1}/work-orders/${workOrderId}/assignments/${assignment1Id}`)
      .set(auth(opsUser.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: worker2Profile.id,
      });
    assert.equal(assign2Res.status, 200, JSON.stringify(assign2Res.body));
    const assignment2Id = assign2Res.body.data.id as string;
    assert.equal(assign2Res.body.data.responseStatus, 'PENDING');
    assert.equal(assign2Res.body.data.reassignmentRequired, false);

    // Worker 1 cannot reopen superseded assignment1Id
    const reopenAttempt = await api()
      .post(
        `${V1}/work-orders/${workOrderId}/assignments/${assignment1Id}/respond`,
      )
      .set(auth(worker1.token))
      .send({ decision: 'TERIMA' });
    assert.equal(reopenAttempt.status, 409);
    assert.equal(
      reopenAttempt.body.error.code,
      'WORK_ORDER_ASSIGNMENT_SUPERSEDED',
    );

    // Worker 2 sees PENDING in /mobile/assignments with TERIMA & TIDAK_BISA
    const feed2Pending = await api()
      .get(`${V1}/mobile/assignments`)
      .set(auth(worker2.token));
    const item2Pending = feed2Pending.body.data.find(
      (i: { id: string }) => i.id === assignment2Id,
    );
    assert.ok(item2Pending);
    assert.equal(item2Pending.assignee.responseStatus, 'PENDING');
    assert.ok(item2Pending.availableActions.includes('TERIMA'));
    assert.ok(item2Pending.availableActions.includes('TIDAK_BISA'));
    assert.ok(!item2Pending.availableActions.includes('START'));

    // Worker 2 responds TERIMA
    const accept2Res = await api()
      .post(
        `${V1}/work-orders/${workOrderId}/assignments/${assignment2Id}/respond`,
      )
      .set(auth(worker2.token))
      .send({
        decision: 'TERIMA',
        notes: 'Siap menuju lokasi',
        idempotencyKey: `wo-accept-${assignment2Id}`,
      });
    assert.equal(accept2Res.status, 200, JSON.stringify(accept2Res.body));
    assert.equal(accept2Res.body.data.responseStatus, 'TERIMA');
    const woAfterAccept = await api()
      .get(`${V1}/work-orders/${workOrderId}`)
      .set(auth(opsUser.token));
    assert.equal(woAfterAccept.body.data.status, 'ASSIGNED');

    // Mobile feed for Worker 2 after TERIMA exposes START
    const feed2Accepted = await api()
      .get(`${V1}/mobile/assignments`)
      .set(auth(worker2.token));
    const item2Accepted = feed2Accepted.body.data.find(
      (i: { id: string }) => i.id === assignment2Id,
    );
    assert.ok(item2Accepted);
    assert.equal(item2Accepted.assignee.responseStatus, 'TERIMA');
    assert.equal(item2Accepted.assignee.reassignmentRequired, false);
    assert.ok(item2Accepted.availableActions.includes('START'));
    assert.ok(!item2Accepted.availableActions.includes('TERIMA'));

    // Worker 2 starts the Work Order
    const startRes = await api()
      .post(`${V1}/work-orders/${workOrderId}/start`)
      .set(auth(worker2.token))
      .send({ notes: 'Mulai pengerjaan' });
    assert.equal(startRes.status, 201, JSON.stringify(startRes.body));

    // Operations history preserves both assignment1 (TIDAK_BISA + SUPERSEDED) and assignment2 (TERIMA)
    const histRes = await api()
      .get(`${V1}/work-orders/${workOrderId}/assignments`)
      .set(auth(opsUser.token));
    assert.equal(histRes.status, 200);
    assert.equal(histRes.body.data.length, 2);
    const histA1 = histRes.body.data.find(
      (a: { id: string }) => a.id === assignment1Id,
    );
    const histA2 = histRes.body.data.find(
      (a: { id: string }) => a.id === assignment2Id,
    );
    assert.equal(histA1.status, 'INACTIVE');
    assert.equal(histA1.responseStatus, 'TIDAK_BISA');
    assert.equal(histA1.reassignmentRequired, false);
    assert.equal(histA2.status, 'ACTIVE');
    assert.equal(histA2.responseStatus, 'TERIMA');
  });

  it('2. E2E Execution Scope Crew Lead + Loginless Helper Attendance: Mobile my-jobs/detail, Operations queue/status-visibility, navigation-target, TIDAK_BISA -> reassign -> TERIMA -> check-in & helper attendance', async () => {
    const realm = await realmFixture('P02C_SCOPE');
    const chain = await locationChain(realm);
    const f = await scopeFixture(realm, chain);

    const opsUser = await createScopedPersona(
      realm.building.id,
      OPERATIONS_ROLE.permissions,
    );

    const crewA = await crewFixture(realm);
    const leadAToken = await loginAsMobileWorker(
      crewA.leadUser.id,
      crewA.leadUser.email,
    );
    const helperA = await createLoginlessHelper({
      realm,
      vendorId: crewA.vendor.id,
      providerContextId: crewA.providerContext.id,
      fullName: 'Helper A Tanpa HP',
    });
    assert.equal(helperA.profile.userId, null);
    await addHandymanCrewMember(
      {
        handymanCrewId: crewA.crew.id,
        handymanWorkerContextId: helperA.workerContext.id,
      },
      adminId,
    );

    const crewB = await crewFixture(realm);
    const leadBToken = await loginAsMobileWorker(
      crewB.leadUser.id,
      crewB.leadUser.email,
    );
    const helperB = await createLoginlessHelper({
      realm,
      vendorId: crewB.vendor.id,
      providerContextId: crewB.providerContext.id,
      fullName: 'Helper B Tanpa HP',
    });
    assert.equal(helperB.profile.userId, null);
    await addHandymanCrewMember(
      {
        handymanCrewId: crewB.crew.id,
        handymanWorkerContextId: helperB.workerContext.id,
      },
      adminId,
    );

    // Operations assigns Crew A to Execution Scope
    const assign1Res = await api()
      .post(`${V1}/handyman/execution-scopes/${f.scope.id}/assignment`)
      .set(auth(opsUser.token))
      .send({
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
      });
    assert.equal(assign1Res.status, 201, JSON.stringify(assign1Res.body));
    const assignment1Id = (assign1Res.body.data.assignmentId ??
      assign1Res.body.data.id) as string;

    // A. Mobile projection on GET /handyman/field/my-jobs and GET /handyman/field/work-orders/:executionScopeId
    const myJobsPending = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(leadAToken));
    assert.equal(myJobsPending.status, 200);
    const job1 = myJobsPending.body.data.jobs.find(
      (j: { assignmentId: string }) => j.assignmentId === assignment1Id,
    );
    assert.ok(
      job1,
      'Crew Lead A must see PENDING job in /handyman/field/my-jobs',
    );
    assert.equal(job1.executionScopeId, f.scope.id);
    assert.equal(job1.responseStatus, 'PENDING');
    assert.equal(job1.reassignmentRequired, false);
    assert.deepEqual(job1.availableActions, ['TERIMA', 'TIDAK_BISA']);

    const scopeDetailPending = await api()
      .get(`${V1}/handyman/field/work-orders/${f.scope.id}`)
      .set(auth(leadAToken));
    assert.equal(scopeDetailPending.status, 200);
    assert.equal(
      scopeDetailPending.body.data.assignmentContext.assignmentId,
      assignment1Id,
    );
    assert.equal(
      scopeDetailPending.body.data.assignmentContext.responseStatus,
      'PENDING',
    );
    assert.deepEqual(
      scopeDetailPending.body.data.assignmentContext.availableActions,
      ['TERIMA', 'TIDAK_BISA'],
    );

    // C. Notification navigation-target for Crew Lead A
    const leadANotifs = await api()
      .get(`${V1}/notifications`)
      .set(auth(leadAToken));
    const leadAPendingNotif = leadANotifs.body.data.find(
      (n: { sourceEntityId: string; sourceEventType: string }) =>
        n.sourceEntityId === assignment1Id &&
        n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_PENDING',
    );
    assert.ok(leadAPendingNotif);

    const leadANav = await api()
      .get(`${V1}/notifications/${leadAPendingNotif.id}/navigation-target`)
      .set(auth(leadAToken));
    assert.equal(leadANav.status, 200, JSON.stringify(leadANav.body));
    assert.equal(leadANav.body.data.target.destination, 'FIELD_WORK');
    assert.equal(
      leadANav.body.data.target.assignmentType,
      'EXECUTION_SCOPE_ASSIGNMENT',
    );
    assert.equal(leadANav.body.data.target.assignmentId, assignment1Id);
    assert.equal(leadANav.body.data.target.executionScopeId, f.scope.id);
    assert.deepEqual(leadANav.body.data.target.availableActions, [
      'TERIMA',
      'TIDAK_BISA',
    ]);

    // Crew Lead A responds TIDAK_BISA
    const declineRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment1Id}/respond`,
      )
      .set(auth(leadAToken))
      .send({
        decision: 'TIDAK_BISA',
        reason: 'Peralatan las sedang dalam perbaikan',
        idempotencyKey: `scope-decline-${assignment1Id}`,
      });
    assert.equal(declineRes.status, 200, JSON.stringify(declineRes.body));
    assert.equal(declineRes.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(declineRes.body.data.reassignmentRequired, true);

    // Navigation target for Crew Lead A after TIDAK_BISA resolves to null
    const leadANavAfterDecline = await api()
      .get(`${V1}/notifications/${leadAPendingNotif.id}/navigation-target`)
      .set(auth(leadAToken));
    assert.equal(leadANavAfterDecline.status, 200);
    assert.equal(leadANavAfterDecline.body.data.target, null);

    // B. Operations queue & status-visibility show TIDAK_BISA + reassignmentRequired: true
    const opsQueueDeclined = await api()
      .get(`${V1}/handyman/operations/queue`)
      .set(auth(opsUser.token))
      .query({ clientId: realm.client.id, buildingId: realm.building.id });
    assert.equal(opsQueueDeclined.status, 200);
    const queueItem = opsQueueDeclined.body.data.items.find(
      (i: { handymanRequestId: string }) =>
        i.handymanRequestId === f.scope.handymanRequestId,
    );
    assert.ok(queueItem);
    assert.equal(queueItem.assignment.assignmentId, assignment1Id);
    assert.equal(queueItem.assignment.responseStatus, 'TIDAK_BISA');
    assert.equal(
      queueItem.assignment.declineReason,
      'Peralatan las sedang dalam perbaikan',
    );
    assert.equal(queueItem.assignment.reassignmentRequired, true);

    const scopeVisDeclined = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/status-visibility`)
      .set(auth(opsUser.token));
    assert.equal(scopeVisDeclined.status, 200);
    assert.equal(
      scopeVisDeclined.body.data.stages.assignment.assignmentId,
      assignment1Id,
    );
    assert.equal(
      scopeVisDeclined.body.data.stages.assignment.responseStatus,
      'TIDAK_BISA',
    );
    assert.equal(
      scopeVisDeclined.body.data.stages.assignment.respondedByUserId,
      crewA.leadUser.id,
    );
    assert.equal(
      scopeVisDeclined.body.data.stages.assignment.respondedByWorkerId,
      crewA.workerContext.id,
    );
    assert.equal(
      scopeVisDeclined.body.data.stages.assignment.declineReason,
      'Peralatan las sedang dalam perbaikan',
    );
    assert.equal(
      scopeVisDeclined.body.data.stages.assignment.reassignmentRequired,
      true,
    );

    // Operations notification navigation-target for EXECUTION_SCOPE_ASSIGNMENT_DECLINED
    const opsNotifs = await api()
      .get(`${V1}/notifications`)
      .set(auth(opsUser.token));
    const opsDeclineNotif = opsNotifs.body.data.find(
      (n: { sourceEntityId: string; sourceEventType: string }) =>
        n.sourceEntityId === assignment1Id &&
        n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
    );
    assert.ok(opsDeclineNotif);
    const opsNav = await api()
      .get(`${V1}/notifications/${opsDeclineNotif.id}/navigation-target`)
      .set(auth(opsUser.token));
    assert.equal(opsNav.status, 200, JSON.stringify(opsNav.body));
    assert.equal(
      opsNav.body.data.target.destination,
      'OPERATIONS_EXECUTION_SCOPE',
    );
    assert.equal(opsNav.body.data.target.executionScopeId, f.scope.id);
    assert.equal(opsNav.body.data.target.assignmentId, assignment1Id);
    assert.equal(opsNav.body.data.target.responseStatus, 'TIDAK_BISA');
    assert.equal(opsNav.body.data.target.reassignmentRequired, true);

    // Operations reassigns Execution Scope to Crew B
    const reassignRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignment/reassign`,
      )
      .set(auth(opsUser.token))
      .send({
        providerContextId: crewB.providerContext.id,
        crewId: crewB.crew.id,
        expectedVersion: 1,
        reason: 'Reassign after Crew A declined',
      });
    assert.equal(reassignRes.status, 201, JSON.stringify(reassignRes.body));
    const assignment2Id = (reassignRes.body.data.assignmentId ??
      reassignRes.body.data.id) as string;
    assert.notEqual(assignment2Id, assignment1Id);

    // Operations queue now shows new assignment as PENDING (reassignmentRequired: false)
    const opsQueueReassigned = await api()
      .get(`${V1}/handyman/operations/queue`)
      .set(auth(opsUser.token))
      .query({ clientId: realm.client.id, buildingId: realm.building.id });
    const queueItemAfterReassign = opsQueueReassigned.body.data.items.find(
      (i: { handymanRequestId: string }) =>
        i.handymanRequestId === f.scope.handymanRequestId,
    );
    assert.equal(queueItemAfterReassign.assignment.assignmentId, assignment2Id);
    assert.equal(queueItemAfterReassign.assignment.responseStatus, 'PENDING');
    assert.equal(queueItemAfterReassign.assignment.reassignmentRequired, false);

    // Crew Lead B responds TERIMA
    const acceptBRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment2Id}/respond`,
      )
      .set(auth(leadBToken))
      .send({
        decision: 'TERIMA',
        notes: 'Kru B siap bersama Helper',
        idempotencyKey: `scope-accept-${assignment2Id}`,
      });
    assert.equal(acceptBRes.status, 200, JSON.stringify(acceptBRes.body));
    assert.equal(acceptBRes.body.data.responseStatus, 'TERIMA');

    // Mobile my-jobs for Crew Lead B now exposes ['CREATE_ARRIVAL_CHALLENGE', 'CHECK_IN']
    const myJobsAccepted = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(leadBToken));
    const job2Accepted = myJobsAccepted.body.data.jobs.find(
      (j: { assignmentId: string }) => j.assignmentId === assignment2Id,
    );
    assert.ok(job2Accepted);
    assert.equal(job2Accepted.responseStatus, 'TERIMA');
    assert.deepEqual(job2Accepted.availableActions, [
      'CREATE_ARRIVAL_CHALLENGE',
      'CHECK_IN',
    ]);

    // Crew Lead B performs arrival verification & check-in, then records login-less Helper B attendance
    const workSessionId = await performDispatchArrivalAndCheckIn({
      realm,
      chain,
      scopeId: f.scope.id,
      assignmentId: assignment2Id,
      leadUserId: crewB.leadUser.id,
      leadToken: leadBToken,
    });

    const myJobsCheckedIn = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(leadBToken));
    const job2CheckedIn = myJobsCheckedIn.body.data.jobs.find(
      (j: { assignmentId: string }) => j.assignmentId === assignment2Id,
    );
    assert.deepEqual(job2CheckedIn.availableActions, [
      'START_WORK',
      'CHECK_OUT',
    ]);

    // Record login-less Helper B attendance on the work session (Expense–Helper PART 02 integration)
    const startWorkRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/work-sessions/start-work`,
      )
      .set(auth(leadBToken))
      .send({ idempotencyKey: `start-${randomUUID()}` });
    assert.equal(startWorkRes.status, 200, JSON.stringify(startWorkRes.body));
    const woForAttId = randomUUID();
    await q(
      `INSERT INTO work_orders (
         id, client_id, building_id, work_order_number,
         title, description, work_type, status, created_by_user_id
       ) VALUES (
         $1, $2, $3, $4,
         'Scope Work Order', 'Helper attendance test work order', 'CORRECTIVE', 'OPEN', $5
       )`,
      [
        woForAttId,
        realm.client.id,
        realm.building.id,
        `WO-P2C-${suffix()}`,
        adminId,
      ],
    );
    const helperAttRes = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${f.scope.id}/helper-attendance/confirm`,
      )
      .set(auth(leadBToken))
      .send({
        workOrderId: woForAttId,
        workSessionId,
        confirmations: [
          {
            helperWorkerId: helperB.workerContext.id,
            attendanceStatus: 'HADIR',
            notes: 'Helper hadir penuh tanpa akun login',
          },
        ],
        idempotencyKey: `conf-${randomUUID()}`,
      });
    assert.equal(helperAttRes.status, 200, JSON.stringify(helperAttRes.body));
    assert.equal(
      helperAttRes.body.data.summary.confirmedPresentCount,
      1,
    );
  });

  it('3. E2E Inspector Visit: Mobile my-inspections & request detail, Operations queue & status-visibility, navigation-target, TIDAK_BISA -> reassign -> TERIMA -> record inspection', async () => {
    const realm = await realmFixture('P02C_INSP');

    const opsUser = await createScopedPersona(
      realm.building.id,
      OPERATIONS_ROLE.permissions,
    );
    const inspector1 = await createEligibleInspector(realm, 'Inspector One');
    const inspector2 = await createEligibleInspector(realm, 'Inspector Two');

    const { requestId, visitId } = await createInspectionRequiredRequestAndVisit(
      realm,
      inspector1.user.id,
    );

    // Operations assigns Inspector 1
    const assign1Res = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set(auth(opsUser.token))
      .send({
        inspectorUserId: inspector1.user.id,
      });
    assert.equal(assign1Res.status, 201, JSON.stringify(assign1Res.body));
    const inspAssign1Id = (assign1Res.body.data.assignmentId ??
      assign1Res.body.data.id) as string;

    // A. Mobile projection on GET /handyman/field/my-jobs (inspections array) & GET /handyman/field/requests/:handymanRequestId
    const myInspPending = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(inspector1.token));
    assert.equal(myInspPending.status, 200);
    const inspItem1 = myInspPending.body.data.inspections.find(
      (i: { assignmentId: string }) => i.assignmentId === inspAssign1Id,
    );
    assert.ok(inspItem1);
    assert.equal(inspItem1.visitAppointmentId, visitId);
    assert.equal(inspItem1.responseStatus, 'PENDING');
    assert.equal(inspItem1.reassignmentRequired, false);
    assert.deepEqual(inspItem1.availableActions, ['TERIMA', 'TIDAK_BISA']);

    const reqDetailPending = await api()
      .get(`${V1}/handyman/field/requests/${requestId}`)
      .set(auth(inspector1.token));
    assert.equal(reqDetailPending.status, 200);
    assert.equal(
      reqDetailPending.body.data.inspectorAssignmentContext.assignmentId,
      inspAssign1Id,
    );
    assert.equal(
      reqDetailPending.body.data.inspectorAssignmentContext.responseStatus,
      'PENDING',
    );
    assert.deepEqual(
      reqDetailPending.body.data.inspectorAssignmentContext.availableActions,
      ['TERIMA', 'TIDAK_BISA'],
    );

    // C. Notification navigation-target for Inspector 1
    const insp1Notifs = await api()
      .get(`${V1}/notifications`)
      .set(auth(inspector1.token));
    const insp1PendingNotif = insp1Notifs.body.data.find(
      (n: { sourceEntityId: string; sourceEventType: string }) =>
        n.sourceEntityId === inspAssign1Id &&
        n.sourceEventType === 'INSPECTOR_VISIT_ASSIGNMENT_PENDING',
    );
    assert.ok(insp1PendingNotif);

    const insp1Nav = await api()
      .get(`${V1}/notifications/${insp1PendingNotif.id}/navigation-target`)
      .set(auth(inspector1.token));
    assert.equal(insp1Nav.status, 200, JSON.stringify(insp1Nav.body));
    assert.equal(insp1Nav.body.data.target.destination, 'FIELD_WORK');
    assert.equal(
      insp1Nav.body.data.target.assignmentType,
      'INSPECTOR_VISIT_ASSIGNMENT',
    );
    assert.equal(insp1Nav.body.data.target.assignmentId, inspAssign1Id);
    assert.equal(insp1Nav.body.data.target.visitAppointmentId, visitId);
    assert.deepEqual(insp1Nav.body.data.target.availableActions, [
      'TERIMA',
      'TIDAK_BISA',
    ]);

    // Inspector 1 responds TIDAK_BISA
    const decline1Res = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${inspAssign1Id}/respond`,
      )
      .set(auth(inspector1.token))
      .send({
        decision: 'TIDAK_BISA',
        reason: 'Jadwal bentrok dengan inspeksi gedung lain',
        idempotencyKey: `insp-decline-${inspAssign1Id}`,
      });
    assert.equal(decline1Res.status, 200, JSON.stringify(decline1Res.body));
    assert.equal(decline1Res.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(decline1Res.body.data.reassignmentRequired, true);

    // B. Operations queue & status-visibility expose inspectorAssignment TIDAK_BISA + reassignmentRequired: true
    const statusVisDeclined = await api()
      .get(`${V1}/handyman/requests/${requestId}/status-visibility`)
      .set(auth(opsUser.token));
    assert.equal(statusVisDeclined.status, 200);
    assert.equal(
      statusVisDeclined.body.data.stages.inspectorAssignment.assignmentId,
      inspAssign1Id,
    );
    assert.equal(
      statusVisDeclined.body.data.stages.inspectorAssignment.responseStatus,
      'TIDAK_BISA',
    );
    assert.equal(
      statusVisDeclined.body.data.stages.inspectorAssignment.declineReason,
      'Jadwal bentrok dengan inspeksi gedung lain',
    );
    assert.equal(
      statusVisDeclined.body.data.stages.inspectorAssignment
        .reassignmentRequired,
      true,
    );

    // Operations notification navigation-target for INSPECTOR_VISIT_ASSIGNMENT_DECLINED
    const opsNotifs = await api()
      .get(`${V1}/notifications`)
      .set(auth(opsUser.token));
    const opsInspDeclineNotif = opsNotifs.body.data.find(
      (n: { sourceEntityId: string; sourceEventType: string }) =>
        n.sourceEntityId === inspAssign1Id &&
        n.sourceEventType === 'INSPECTOR_VISIT_ASSIGNMENT_DECLINED',
    );
    assert.ok(opsInspDeclineNotif);
    const opsInspNav = await api()
      .get(`${V1}/notifications/${opsInspDeclineNotif.id}/navigation-target`)
      .set(auth(opsUser.token));
    assert.equal(opsInspNav.status, 200, JSON.stringify(opsInspNav.body));
    assert.equal(
      opsInspNav.body.data.target.destination,
      'OPERATIONS_INSPECTOR_VISIT',
    );
    assert.equal(opsInspNav.body.data.target.visitAppointmentId, visitId);
    assert.equal(opsInspNav.body.data.target.assignmentId, inspAssign1Id);
    assert.equal(opsInspNav.body.data.target.responseStatus, 'TIDAK_BISA');
    assert.equal(opsInspNav.body.data.target.reassignmentRequired, true);

    // Operations reassigns to Inspector 2
    const reassignRes = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector/reassign`)
      .set(auth(opsUser.token))
      .send({
        inspectorUserId: inspector2.user.id,
        expectedVersion: 1,
        reason: 'Reassign after Inspector 1 declined',
      });
    assert.equal(reassignRes.status, 201, JSON.stringify(reassignRes.body));
    const inspAssign2Id = (reassignRes.body.data.assignmentId ??
      reassignRes.body.data.id) as string;

    // Inspector 2 responds TERIMA
    const accept2Res = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${inspAssign2Id}/respond`,
      )
      .set(auth(inspector2.token))
      .send({
        decision: 'TERIMA',
        notes: 'Siap melakukan inspeksi',
        idempotencyKey: `insp-accept-${inspAssign2Id}`,
      });
    assert.equal(accept2Res.status, 200, JSON.stringify(accept2Res.body));

    // Mobile my-jobs (inspections array) for Inspector 2 shows TERIMA and availableActions: ['RECORD_OUTCOME']
    const myInspAccepted = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(inspector2.token));
    const inspItem2 = myInspAccepted.body.data.inspections.find(
      (i: { assignmentId: string }) => i.assignmentId === inspAssign2Id,
    );
    assert.ok(inspItem2);
    assert.equal(inspItem2.responseStatus, 'TERIMA');
    assert.deepEqual(inspItem2.availableActions, ['RECORD_OUTCOME']);

    // Operations status-visibility now shows inspectorAssignment.responseStatus === 'TERIMA'
    const statusVisAccepted = await api()
      .get(`${V1}/handyman/requests/${requestId}/status-visibility`)
      .set(auth(opsUser.token));
    assert.equal(
      statusVisAccepted.body.data.stages.inspectorAssignment.assignmentId,
      inspAssign2Id,
    );
    assert.equal(
      statusVisAccepted.body.data.stages.inspectorAssignment.responseStatus,
      'TERIMA',
    );
    assert.equal(
      statusVisAccepted.body.data.stages.inspectorAssignment
        .reassignmentRequired,
      false,
    );
  });

  it('4. Edge-Case Authority: Crew Lead change after TERIMA and after TIDAK_BISA rotates assignment version without overwriting prior Lead immutable decision', async () => {
    const realm = await realmFixture('P02C_LEAD_SWAP');
    const chain = await locationChain(realm);
    const f = await scopeFixture(realm, chain);

    const opsUser = await createScopedPersona(
      realm.building.id,
      OPERATIONS_ROLE.permissions,
    );
    const crew = await crewFixture(realm);
    const lead1Token = await loginAsMobileWorker(
      crew.leadUser.id,
      crew.leadUser.email,
    );
    const lead2 = await createLinkedCrewMember({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Lead 2 Replacement',
    });
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: lead2.workerContext.id,
      },
      adminId,
    );

    // Assign Crew (Lead 1 is current Lead)
    const assignRes = await api()
      .post(`${V1}/handyman/execution-scopes/${f.scope.id}/assignment`)
      .set(auth(opsUser.token))
      .send({
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      });
    assert.equal(assignRes.status, 201);
    const assignment1Id = (assignRes.body.data.assignmentId ??
      assignRes.body.data.id) as string;

    // Lead 1 responds TERIMA on assignment1Id
    const accept1Res = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment1Id}/respond`,
      )
      .set(auth(lead1Token))
      .send({
        decision: 'TERIMA',
        notes: 'Lead 1 menerima tugas',
        idempotencyKey: `lead1-accept-${assignment1Id}`,
      });
    assert.equal(accept1Res.status, 200);

    // Now Operations changes the Crew Lead to Lead 2 BEFORE work session check-in!
    await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: lead2.workerContext.id,
      },
      adminId,
    );

    // Verify assignment1Id was SUPERSEDED (preserving Lead 1's immutable TERIMA decision)
    // and a new ACTIVE assignment2Id was created in PENDING state for Lead 2!
    const currentAssignAfterSwap1 = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/assignment`)
      .set(auth(opsUser.token));
    assert.equal(currentAssignAfterSwap1.status, 200);
    const assignment2Id = currentAssignAfterSwap1.body.data
      .assignmentId as string;
    assert.notEqual(
      assignment2Id,
      assignment1Id,
      'Crew Lead change after TERIMA must rotate to a new assignmentId so Lead 1 immutable decision is never overwritten',
    );
    assert.equal(
      currentAssignAfterSwap1.body.data.supersedesAssignmentId,
      assignment1Id,
    );
    assert.equal(currentAssignAfterSwap1.body.data.leadUserId, lead2.user.id);

    // Lead 2 cannot check in because assignment1Id's dispatch release was superseded when Crew Lead rotated!
    const prematureCheckInNoDispatch = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/work-sessions/check-in`,
      )
      .set(auth(lead2.token))
      .send({ idempotencyKey: `premature-${randomUUID()}` });
    assert.equal(prematureCheckInNoDispatch.status, 409);
    assert.equal(
      prematureCheckInNoDispatch.body.error.code,
      'HANDYMAN_WORK_SESSION_DISPATCH_NOT_RELEASED',
    );

    // Mobile my-jobs for Lead 2 on assignment2Id shows PENDING and availableActions: ['TERIMA', 'TIDAK_BISA'] (CHECK_IN not yet available)
    const lead2MyJobsPending = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(lead2.token));
    assert.equal(lead2MyJobsPending.status, 200);
    const lead2JobItem = lead2MyJobsPending.body.data.jobs.find(
      (j: { assignmentId: string }) => j.assignmentId === assignment2Id,
    );
    assert.ok(lead2JobItem);
    assert.equal(lead2JobItem.responseStatus, 'PENDING');
    assert.deepEqual(lead2JobItem.availableActions, ['TERIMA', 'TIDAK_BISA']);

    // Lead 1 cannot respond to superseded assignment1Id or active assignment2Id
    const lead1Reopen = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment1Id}/respond`,
      )
      .set(auth(lead1Token))
      .send({ decision: 'TIDAK_BISA', reason: 'Attempt to flip superseded' });
    assert.equal(lead1Reopen.status, 409);
    assert.equal(
      lead1Reopen.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED',
    );

    // Now Lead 2 responds TIDAK_BISA on assignment2Id
    const decline2Res = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment2Id}/respond`,
      )
      .set(auth(lead2.token))
      .send({
        decision: 'TIDAK_BISA',
        reason: 'Lead 2 sakit mendadak',
        idempotencyKey: `lead2-decline-${assignment2Id}`,
      });
    assert.equal(decline2Res.status, 200);
    assert.equal(decline2Res.body.data.responseStatus, 'TIDAK_BISA');

    // Now Operations designates Lead 1 back on the same crew AFTER Lead 2's TIDAK_BISA!
    await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: crew.workerContext.id,
      },
      adminId,
    );

    const currentAssignAfterSwap2 = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/assignment`)
      .set(auth(opsUser.token));
    assert.equal(currentAssignAfterSwap2.status, 200);
    const assignment3Id = currentAssignAfterSwap2.body.data
      .assignmentId as string;
    assert.notEqual(assignment3Id, assignment2Id);
    assert.equal(
      currentAssignAfterSwap2.body.data.supersedesAssignmentId,
      assignment2Id,
    );

    // Verify response-history preserves all 3 assignments and all immutable decisions!
    const hist1Res = await api()
      .get(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment1Id}/response-history`,
      )
      .set(auth(opsUser.token));
    assert.equal(hist1Res.status, 200, JSON.stringify(hist1Res.body));
    const a1 = hist1Res.body.data;
    assert.equal(a1.assignmentId, assignment1Id);
    assert.equal(a1.status, 'SUPERSEDED');
    assert.equal(a1.responseStatus, 'TERIMA');
    assert.equal(a1.respondedByUserId, crew.leadUser.id);
    assert.deepEqual(
      (a1.events as { eventType: string }[]).map((e) => e.eventType),
      [
        'ASSIGNMENT_PENDING_CREATED',
        'ASSIGNMENT_ACCEPTED',
        'ASSIGNMENT_SUPERSEDED',
      ],
    );

    const hist2Res = await api()
      .get(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment2Id}/response-history`,
      )
      .set(auth(opsUser.token));
    assert.equal(hist2Res.status, 200, JSON.stringify(hist2Res.body));
    const a2 = hist2Res.body.data;
    assert.equal(a2.assignmentId, assignment2Id);
    assert.equal(a2.status, 'SUPERSEDED');
    assert.equal(a2.responseStatus, 'TIDAK_BISA');
    assert.equal(a2.respondedByUserId, lead2.user.id);
    assert.equal(a2.declineReason, 'Lead 2 sakit mendadak');
    assert.deepEqual(
      (a2.events as { eventType: string }[]).map((e) => e.eventType),
      [
        'ASSIGNMENT_PENDING_CREATED',
        'ASSIGNMENT_DECLINED',
        'ASSIGNMENT_SUPERSEDED',
      ],
    );

    const hist3Res = await api()
      .get(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignment3Id}/response-history`,
      )
      .set(auth(opsUser.token));
    assert.equal(hist3Res.status, 200, JSON.stringify(hist3Res.body));
    const a3 = hist3Res.body.data;
    assert.equal(a3.assignmentId, assignment3Id);
    assert.equal(a3.status, 'ACTIVE');
    assert.equal(a3.responseStatus, 'PENDING');
    assert.equal(a3.reassignmentRequired, false);
    assert.deepEqual(
      (a3.events as { eventType: string }[]).map((e) => e.eventType),
      ['ASSIGNMENT_PENDING_CREATED'],
    );
  });

  it('5. Edge-Case Authority: Concurrency (simultaneous TERIMA vs TIDAK_BISA), session revocation, and migration 0472 CHECK constraints', async () => {
    const realm = await realmFixture('P02C_CONCURRENCY');
    const chain = await locationChain(realm);
    const f = await scopeFixture(realm, chain);

    const opsUser = await createScopedPersona(
      realm.building.id,
      OPERATIONS_ROLE.permissions,
    );
    const crew = await crewFixture(realm);
    const leadToken = await loginAsMobileWorker(
      crew.leadUser.id,
      crew.leadUser.email,
    );

    const assignRes = await api()
      .post(`${V1}/handyman/execution-scopes/${f.scope.id}/assignment`)
      .set(auth(opsUser.token))
      .send({
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      });
    assert.equal(assignRes.status, 201);
    const assignmentId = (assignRes.body.data.assignmentId ??
      assignRes.body.data.id) as string;

    // Negative: Cross-Client/Building isolation — Operations user from another Building is denied
    const foreignRealm = await realmFixture('P02C_FOREIGN');
    const foreignOps = await createScopedPersona(
      foreignRealm.building.id,
      OPERATIONS_ROLE.permissions,
    );
    const foreignQueueRes = await api()
      .get(`${V1}/handyman/operations/queue`)
      .set(auth(foreignOps.token))
      .query({ clientId: realm.client.id, buildingId: realm.building.id });
    assert.equal(foreignQueueRes.status, 403);
    assert.equal(foreignQueueRes.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Negative: Worker permissions — Mobile Worker without tenant_company.manage cannot reassign
    const forbiddenReassign = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignment/reassign`,
      )
      .set(auth(leadToken))
      .send({
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
        expectedVersion: 1,
        reason: 'Worker attempting ops reassign',
      });
    assert.equal(forbiddenReassign.status, 403);
    assert.equal(forbiddenReassign.body.error.code, 'PERMISSION_DENIED');

    // Negative: Invalid TIDAK_BISA without reason rolls back and keeps PENDING with 1 event
    const invalidDecline = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({
        decision: 'TIDAK_BISA',
        reason: '   ',
      });
    assert.equal(invalidDecline.status, 400);
    const eventsAfterInvalid = await q(
      `SELECT event_type FROM handyman_assignment_response_events WHERE assignment_id = $1`,
      [assignmentId],
    );
    assert.equal(eventsAfterInvalid.rowCount, 1);

    // Fire simultaneous TERIMA and TIDAK_BISA requests on the same assignmentId
    const [r1, r2] = await Promise.all([
      api()
        .post(
          `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignmentId}/respond`,
        )
        .set(auth(leadToken))
        .send({
          decision: 'TERIMA',
          notes: 'Concurrent accept',
          idempotencyKey: `conc-accept-${assignmentId}`,
        }),
      api()
        .post(
          `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignmentId}/respond`,
        )
        .set(auth(leadToken))
        .send({
          decision: 'TIDAK_BISA',
          reason: 'Concurrent decline',
          idempotencyKey: `conc-decline-${assignmentId}`,
        }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(
      statuses,
      [200, 409],
      `Expected one 200 winner and one 409 conflict, got ${r1.status} and ${r2.status}`,
    );

    // Duplicate event idempotency: re-sending the winning decision is idempotent (200 idempotentReplay: true, no extra event row)
    const winnerDecision = r1.status === 200 ? 'TERIMA' : 'TIDAK_BISA';
    const replayWinner = await api()
      .post(
        `${V1}/handyman/execution-scopes/${f.scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send(
        winnerDecision === 'TERIMA'
          ? { decision: 'TERIMA', notes: 'Concurrent accept' }
          : { decision: 'TIDAK_BISA', reason: 'Concurrent decline' },
      );
    assert.equal(replayWinner.status, 200);
    assert.equal(replayWinner.body.data.idempotentReplay, true);
    const eventsAfterReplay = await q(
      `SELECT event_type FROM handyman_assignment_response_events WHERE assignment_id = $1`,
      [assignmentId],
    );
    assert.equal(eventsAfterReplay.rowCount, 2);

    // Verify 0472 CHECK constraint on handyman_assignment_response_events rejects invalid event_type
    const respRow = await q(
      `SELECT id FROM handyman_assignment_responses WHERE assignment_id = $1`,
      [assignmentId],
    );
    await assert.rejects(
      () =>
        q(
          `INSERT INTO handyman_assignment_response_events (
             id, response_id, client_id, building_id, assignment_target_type,
             assignment_id, handyman_request_id, execution_scope_id,
             event_type, previous_status, new_status, actor_user_id, idempotency_key
           )
           VALUES ($1, $2, $3, $4, 'EXECUTION_SCOPE_ASSIGNMENT', $5, $6, $7, 'INVALID_EVENT_TYPE', 'PENDING', 'TERIMA', $8, $9)`,
          [
            randomUUID(),
            respRow.rows[0].id,
            realm.client.id,
            realm.building.id,
            assignmentId,
            f.scope.handymanRequestId,
            f.scope.id,
            crew.leadUser.id,
            `bad-evt-${randomUUID()}`,
          ],
        ),
      /hm_assign_resp_evt_type_check/,
    );

    // Session revocation immediately blocks field feed and response endpoints with 401
    await q(
      `UPDATE user_sessions SET status = 'REVOKED', revoked_at = NOW() WHERE user_id = $1`,
      [crew.leadUser.id],
    );
    const revokedFeedRes = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(leadToken));
    assert.equal(revokedFeedRes.status, 401);
  });

  it('6. Migration 0472 in-place ledger upgrade safety & cross-PR (PR #55 DIRECT/FREELANCE + 0468 + 0470-0472) compatibility', async () => {
    const countBefore = await q(
      `SELECT COUNT(*)::int AS cnt FROM handyman_assignment_responses`,
    );
    const eventsBefore = await q(
      `SELECT COUNT(*)::int AS cnt FROM handyman_assignment_response_events`,
    );
    assert.ok((countBefore.rows[0].cnt as number) > 0);
    assert.ok((eventsBefore.rows[0].cnt as number) > 0);

    // Simulate a database that had previously executed PART 02A's 0472 (where notifications_navigation_target_check only had WORK_ORDER_FIELD_WORK)
    await q(`
      UPDATE notifications
         SET navigation_target_type = NULL,
             navigation_target_id = NULL
       WHERE navigation_target_type IN ('EXECUTION_SCOPE_FIELD_WORK', 'INSPECTOR_VISIT_FIELD_WORK');
      ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_navigation_target_check;
      ALTER TABLE notifications ADD CONSTRAINT notifications_navigation_target_check CHECK (
        (navigation_target_type IS NULL AND navigation_target_id IS NULL)
        OR (navigation_target_type IN ('WORK_ORDER_FIELD_WORK') AND navigation_target_id IS NOT NULL)
      );
    `);

    // Running migrateUp on a ledger where 0472_handyman_assignment_responses is already applied upgrades the constraint in-place without losing any response rows
    const applied = await migrateUp(pool!);
    assert.deepEqual(applied, []);

    const defRes = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'notifications_navigation_target_check'`,
    );
    assert.match(defRes.rows[0].def as string, /EXECUTION_SCOPE_FIELD_WORK/);
    assert.match(defRes.rows[0].def as string, /INSPECTOR_VISIT_FIELD_WORK/);

    const countAfter = await q(
      `SELECT COUNT(*)::int AS cnt FROM handyman_assignment_responses`,
    );
    const eventsAfter = await q(
      `SELECT COUNT(*)::int AS cnt FROM handyman_assignment_response_events`,
    );
    assert.equal(countAfter.rows[0].cnt, countBefore.rows[0].cnt);
    assert.equal(eventsAfter.rows[0].cnt, eventsBefore.rows[0].cnt);

    // Subsequent migrateUp is a true no-op
    assert.deepEqual(await migrateUp(pool!), []);

    // Simulate PR #55 (0466 DIRECT provider context & FREELANCE workforce_type) + IAM Revocation (0468) DDL coexistence on PostgreSQL 18
    await q(`
      ALTER TABLE handyman_provider_contexts
        ADD COLUMN IF NOT EXISTS provider_type TEXT NOT NULL DEFAULT 'VENDOR';
      ALTER TABLE handyman_provider_contexts
        DROP CONSTRAINT IF EXISTS handyman_provider_contexts_type_check;
      ALTER TABLE handyman_provider_contexts
        ADD CONSTRAINT handyman_provider_contexts_type_check
          CHECK (provider_type IN ('VENDOR', 'DIRECT'));
      ALTER TABLE handyman_provider_contexts
        ALTER COLUMN vendor_id DROP NOT NULL;
      ALTER TABLE handyman_provider_contexts
        DROP CONSTRAINT IF EXISTS handyman_provider_contexts_identity_check;
      ALTER TABLE handyman_provider_contexts
        ADD CONSTRAINT handyman_provider_contexts_identity_check
          CHECK (
            (provider_type = 'VENDOR' AND vendor_id IS NOT NULL)
            OR (provider_type = 'DIRECT' AND vendor_id IS NULL)
          );
      CREATE UNIQUE INDEX IF NOT EXISTS handyman_provider_contexts_direct_client_unique
        ON handyman_provider_contexts (client_id)
        WHERE provider_type = 'DIRECT';
      ALTER TABLE workforce_profiles
        DROP CONSTRAINT IF EXISTS workforce_profiles_workforce_type_check;
      ALTER TABLE workforce_profiles
        ADD CONSTRAINT workforce_profiles_workforce_type_check
          CHECK (
            workforce_type IN (
              'INTERNAL', 'OUTSOURCED', 'CONTRACT', 'EXTERNAL', 'FREELANCE'
            )
          );
    `);

    const realm = await realmFixture('P02C_DIRECT');
    const directContextId = randomUUID();
    await q(
      `INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, provider_type, status, created_by_user_id)
       VALUES ($1, $2, NULL, 'DIRECT', 'ACTIVE', $3)`,
      [directContextId, realm.client.id, adminId],
    );
    const freelanceHelperProfileId = randomUUID();
    await q(
      `INSERT INTO workforce_profiles (
         id, organization_id, department_id, position_id, user_id,
         employee_code, full_name, workforce_type, status
       )
       VALUES ($1, $2, $3, $4, NULL, $5, 'Freelance Direct Helper', 'FREELANCE', 'ACTIVE')`,
      [
        freelanceHelperProfileId,
        realm.organization.id,
        realm.department.id,
        realm.position.id,
        `FRL_${suffix()}`,
      ],
    );
    const directWorkerCtxId = randomUUID();
    await q(
      `INSERT INTO handyman_worker_contexts (
         id, client_id, workforce_profile_id, handyman_provider_context_id, status, created_by_user_id
       )
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
      [
        directWorkerCtxId,
        realm.client.id,
        freelanceHelperProfileId,
        directContextId,
        adminId,
      ],
    );
    const verifyDirect = await q(
      `SELECT pc.provider_type, pc.vendor_id, wp.workforce_type
         FROM handyman_worker_contexts wc
         JOIN handyman_provider_contexts pc ON pc.id = wc.handyman_provider_context_id
         JOIN workforce_profiles wp ON wp.id = wc.workforce_profile_id
        WHERE wc.id = $1`,
      [directWorkerCtxId],
    );
    assert.equal(verifyDirect.rows[0].provider_type, 'DIRECT');
    assert.equal(verifyDirect.rows[0].vendor_id, null);
    assert.equal(verifyDirect.rows[0].workforce_type, 'FREELANCE');
  });
});
