import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import {
  closePool,
  initDatabase,
  migrateUp,
  withTransaction,
} from '../src/database';
import {
  assignmentResponseRepository,
  notifyExecutionScopeCrewLeadAssignedPending,
  notifyInspectorAssignedPending,
} from '../src/modules/assignment-responses';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  evaluateDispatchReadiness,
  handymanDispatchRepository,
} from '../src/modules/handyman-dispatch';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import { handymanInspectorAssignmentService } from '../src/modules/handyman-inspector-assignments';
import {
  addHandymanCrewMember,
  handymanProviderContextService,
  handymanWorkCrewService,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestInspectionService,
  handymanServiceRequestService,
  recordHandymanRequestTriage,
} from '../src/modules/handyman-requests';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import {
  checkInHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../src/modules/handyman-work-sessions';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { vendorService } from '../src/modules/vendors';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
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
 * CR-HM-ASSIGNMENT-RESPONSE-01 PART 02B — Crew Lead & Inspector Assignment
 * Response (disposable PostgreSQL integration test suite).
 */

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-part02b-assignment-response-pg';
const DB_PORT = 55581;

let dbHandle: EmbeddedTestDbHandle | null = null;
let pool: Pool | null = null;
let adminId = '';
let adminToken = '';

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function auth(token: string): { Authorization: string } {
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

/**
 * Assigns MOBILE_STAFF_ROLE permissions (`work_order.read`, `tenant_company.read`
 * — explicitly NO `work_order.manage` or `tenant_company.manage`) to an existing
 * user and logs them in.
 */
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
  for (const code of ['work_order.read', 'tenant_company.read']) {
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

describe('CR-HM-ASSIGNMENT-RESPONSE-01 PART 02B — Crew Lead & Inspector Response', () => {
  it('1. Crew Lead assign -> IN_APP notification only to eligible active Crew Lead -> TERIMA by Mobile Worker + Helper without account not required to respond', async () => {
    const realm = await realmFixture('Part02B_1');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    const leadToken = await loginAsMobileWorker(
      crew.leadUser.id,
      crew.leadUser.email,
    );

    // Add 1 login-less Helper (no smartphone/account) and 1 linked Helper with account
    const loginlessHelper = await createLoginlessHelper({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Tanpa HP',
    });
    const linkedHelper = await createLinkedCrewMember({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
      fullName: 'Helper Dengan Akun',
    });
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: loginlessHelper.workerContext.id,
      },
      adminId,
    );
    await addHandymanCrewMember(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: linkedHelper.workerContext.id,
      },
      adminId,
    );

    // Operations assigns Crew to Execution Scope
    const assignRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken))
      .send({
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      });
    assert.equal(assignRes.status, 201, JSON.stringify(assignRes.body));
    const assignmentId = assignRes.body.data.id as string;
    assert.equal(assignRes.body.data.responseStatus, 'PENDING');
    assert.equal(assignRes.body.data.reassignmentRequired, false);

    // IN_APP notification sent ONLY to the active Crew Lead, NOT to the Helper
    const leadInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(leadToken));
    assert.equal(leadInbox.status, 200);
    const leadNotifs = (leadInbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'EXECUTION_SCOPE_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId &&
        n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_PENDING',
    );
    assert.equal(leadNotifs.length, 1);

    const helperInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(linkedHelper.token));
    assert.equal(helperInbox.status, 200);
    const helperNotifs = (helperInbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'EXECUTION_SCOPE_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId,
    );
    assert.equal(helperNotifs.length, 0);

    // Helper with account is FORBIDDEN from responding (403 HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN)
    const helperAttempt = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(linkedHelper.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(helperAttempt.status, 403);
    assert.equal(
      helperAttempt.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN',
    );

    // Mobile Worker Crew Lead (without tenant_company.manage or work_order.manage) responds TERIMA -> 200 OK
    const respondRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({
        responseStatus: 'TERIMA',
        notes: 'Siap menjalankan pekerjaan bersama tim.',
      });
    assert.equal(respondRes.status, 200, JSON.stringify(respondRes.body));
    assert.equal(respondRes.body.data.responseStatus, 'TERIMA');
    assert.equal(respondRes.body.data.respondedByUserId, crew.leadUser.id);
    assert.equal(
      respondRes.body.data.respondedByWorkerId,
      crew.workerContext.id,
    );
    assert.equal(respondRes.body.data.reassignmentRequired, false);
    assert.equal(respondRes.body.data.idempotentReplay, false);

    // Duplicate identical TERIMA is idempotent (idempotentReplay: true)
    const replayRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({
        responseStatus: 'TERIMA',
        notes: 'Siap menjalankan pekerjaan bersama tim.',
      });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.body.data.idempotentReplay, true);

    // Operations receives EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED notification
    const opsInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(adminToken));
    assert.equal(opsInbox.status, 200);
    const acceptedNotifs = (opsInbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'EXECUTION_SCOPE_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId &&
        n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED',
    );
    assert.equal(acceptedNotifs.length, 1);

    // Crew Lead can check in, start work, and confirm login-less Helper attendance (0471)
    const sessionId = await performDispatchArrivalAndCheckIn({
      realm,
      chain,
      scopeId: scope.id,
      assignmentId,
      leadUserId: crew.leadUser.id,
      leadToken,
    });
    const startRes = await startWorkHandymanWorkSession(
      {
        executionScopeId: scope.id,
        idempotencyKey: `start-${randomUUID()}`,
      },
      crew.leadUser.id,
    );
    assert.equal(startRes.session.status, 'IN_PROGRESS');

    const woId = randomUUID();
    await q(
      `INSERT INTO work_orders (
         id, client_id, building_id, work_order_number,
         title, description, work_type, status, created_by_user_id
       ) VALUES (
         $1, $2, $3, $4,
         'Scope Work Order', 'Helper attendance test work order', 'CORRECTIVE', 'OPEN', $5
       )`,
      [woId, realm.client.id, realm.building.id, `WO-P2B-${suffix()}`, adminId],
    );
    const attendanceRes = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${scope.id}/helper-attendance/confirm`,
      )
      .set(auth(leadToken))
      .send({
        workOrderId: woId,
        workSessionId: sessionId,
        confirmations: [
          {
            helperWorkerId: loginlessHelper.workerContext.id,
            attendanceStatus: 'HADIR',
            notes: 'Helper tanpa HP hadir di lokasi',
          },
          {
            helperWorkerId: linkedHelper.workerContext.id,
            attendanceStatus: 'HADIR',
          },
        ],
        idempotencyKey: `conf-${randomUUID()}`,
      });
    assert.equal(attendanceRes.status, 200, JSON.stringify(attendanceRes.body));
    assert.equal(attendanceRes.body.data.summary.confirmedPresentCount, 2);
  });

  it('2. Crew Lead -> TIDAK_BISA requires reason, sets reassignmentRequired = true, notifies Operations, preserves Tenant request, and blocks arrival / CHECK_IN / START', async () => {
    const realm = await realmFixture('Part02B_2');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const requestId = scope.handymanRequestId;
    const crew = await crewFixture(realm);
    const leadToken = await loginAsMobileWorker(
      crew.leadUser.id,
      crew.leadUser.email,
    );

    const assignRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken))
      .send({
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      });
    assert.equal(assignRes.status, 201);
    const assignmentId = assignRes.body.data.id as string;

    // Missing declineReason on TIDAK_BISA -> 400 VALIDATION_ERROR
    const missingReason = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({ responseStatus: 'TIDAK_BISA', declineReason: '   ' });
    assert.equal(missingReason.status, 400);
    assert.equal(missingReason.body.error.code, 'VALIDATION_ERROR');

    // Supplying declineReason on TERIMA -> 400 VALIDATION_ERROR
    const forbiddenReason = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({
        responseStatus: 'TERIMA',
        declineReason: 'Tidak boleh ada alasan saat terima',
      });
    assert.equal(forbiddenReason.status, 400);
    assert.equal(forbiddenReason.body.error.code, 'VALIDATION_ERROR');

    // Valid TIDAK_BISA with reason -> 200 OK
    const declineRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({
        responseStatus: 'TIDAK_BISA',
        declineReason: 'Kendaraan operasional mogok di jalan.',
      });
    assert.equal(declineRes.status, 200, JSON.stringify(declineRes.body));
    assert.equal(declineRes.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(
      declineRes.body.data.declineReason,
      'Kendaraan operasional mogok di jalan.',
    );
    assert.equal(declineRes.body.data.reassignmentRequired, true);

    // Conflicting flip TIDAK_BISA -> TERIMA rejected with 409 HANDYMAN_ASSIGNMENT_RESPONSE_CONFLICT
    const flipRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadToken))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(flipRes.status, 409);
    assert.equal(
      flipRes.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_CONFLICT',
    );

    // Operations receives EXECUTION_SCOPE_ASSIGNMENT_DECLINED notification with declineReason
    const opsInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(adminToken));
    assert.equal(opsInbox.status, 200);
    const declinedNotifs = (opsInbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'EXECUTION_SCOPE_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId &&
        n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
    );
    assert.equal(declinedNotifs.length, 1);
    assert.equal(
      declinedNotifs[0].metadata.declineReason,
      'Kendaraan operasional mogok di jalan.',
    );
    assert.equal(declinedNotifs[0].metadata.reassignmentRequired, true);

    // Tenant request and Execution Scope are NOT cancelled
    const reqRow = await q(
      `SELECT status FROM handyman_service_requests WHERE id = $1`,
      [requestId],
    );
    assert.equal(reqRow.rows[0].status, 'READY_FOR_NEXT_STEP');
    const scopeRow = await q(
      `SELECT status FROM handyman_execution_scopes WHERE id = $1`,
      [scope.id],
    );
    assert.equal(scopeRow.rows[0].status, 'AUTHORIZED');

    // Status visibility & response history expose TIDAK_BISA + reassignmentRequired = true
    const statusVis = await api()
      .get(`${V1}/handyman/execution-scopes/${scope.id}/status-visibility`)
      .set(auth(adminToken));
    assert.equal(statusVis.status, 200);
    assert.equal(
      statusVis.body.data.stages.assignment.responseStatus,
      'TIDAK_BISA',
    );
    assert.equal(
      statusVis.body.data.stages.assignment.reassignmentRequired,
      true,
    );

    // Arrival challenge, CHECK_IN, START, and dispatch readiness are blocked
    await assert.rejects(
      () =>
        createHandymanArrivalChallenge(
          { executionScopeId: scope.id },
          crew.leadUser.id,
        ),
      (err: any) =>
        err?.statusCode === 409 && err?.code === 'HANDYMAN_ASSIGNMENT_DECLINED',
    );

    await assert.rejects(
      () =>
        checkInHandymanWorkSession(
          {
            executionScopeId: scope.id,
            idempotencyKey: `checkin-${randomUUID()}`,
          },
          crew.leadUser.id,
        ),
      (err: any) =>
        err?.statusCode === 409 && err?.code === 'HANDYMAN_ASSIGNMENT_DECLINED',
    );

    await assert.rejects(
      () =>
        startWorkHandymanWorkSession(
          {
            executionScopeId: scope.id,
            idempotencyKey: `start-${randomUUID()}`,
          },
          crew.leadUser.id,
        ),
      (err: any) =>
        err?.statusCode === 409 && err?.code === 'HANDYMAN_ASSIGNMENT_DECLINED',
    );

    const readiness = await evaluateDispatchReadiness(scope.id, adminId);
    assert.equal(readiness.checks.eligibleLead, false);
    assert.ok(
      readiness.failures.some((f) => f.includes('TIDAK_BISA')),
      `Expected TIDAK_BISA failure in ${JSON.stringify(readiness.failures)}`,
    );

    // Mobile field feed excludes declined assignment
    const myJobs = await api()
      .get(`${V1}/handyman/field/my-jobs`)
      .set(auth(leadToken));
    assert.equal(myJobs.status, 200);
    const jobsList = (myJobs.body.data.jobs ??
      myJobs.body.data.items ??
      []) as any[];
    assert.equal(
      jobsList.some((j) => j.executionScopeId === scope.id),
      false,
    );
  });

  it('3. Crew reassignment and dynamic Crew Lead change revoke old Lead authority and issue new assignment / notification atomically', async () => {
    const realm = await realmFixture('Part02B_3');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crewA = await crewFixture(realm);
    const crewB = await crewFixture(realm);
    const leadAToken = await loginAsMobileWorker(
      crewA.leadUser.id,
      crewA.leadUser.email,
    );
    const leadBToken = await loginAsMobileWorker(
      crewB.leadUser.id,
      crewB.leadUser.email,
    );

    // Assign Crew A -> Lead A declines (TIDAK_BISA)
    const assignA = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken))
      .send({
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
      });
    assert.equal(assignA.status, 201);
    const assignmentAId = assignA.body.data.id as string;

    const declineA = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentAId}/respond`,
      )
      .set(auth(leadAToken))
      .send({
        responseStatus: 'TIDAK_BISA',
        declineReason: 'Crew A sedang menangani darurat gedung lain.',
      });
    assert.equal(declineA.status, 200);

    // Operations reassigns to Crew B atomically
    const reassignB = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment/reassign`)
      .set(auth(adminToken))
      .send({
        providerContextId: crewB.providerContext.id,
        crewId: crewB.crew.id,
        expectedVersion: assignA.body.data.version,
        reason: 'Reassign after Crew A declined',
      });
    assert.equal(reassignB.status, 201, JSON.stringify(reassignB.body));
    const assignmentBId = reassignB.body.data.id as string;
    assert.equal(reassignB.body.data.supersedesAssignmentId, assignmentAId);
    assert.equal(reassignB.body.data.responseStatus, 'PENDING');

    // Old assignment A preserves TIDAK_BISA + appends ASSIGNMENT_SUPERSEDED in history
    const historyA = await api()
      .get(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentAId}/response-history`,
      )
      .set(auth(adminToken));
    assert.equal(historyA.status, 200);
    assert.equal(historyA.body.data.status, 'SUPERSEDED');
    assert.equal(historyA.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(historyA.body.data.reassignmentRequired, false);
    assert.deepEqual(
      (historyA.body.data.events as any[]).map((e) => e.eventType),
      [
        'ASSIGNMENT_PENDING_CREATED',
        'ASSIGNMENT_DECLINED',
        'ASSIGNMENT_SUPERSEDED',
      ],
    );

    // Old Lead A cannot respond to superseded assignment A (409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED)
    const lateLeadA = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentAId}/respond`,
      )
      .set(auth(leadAToken))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(lateLeadA.status, 409);
    assert.equal(
      lateLeadA.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED',
    );

    // Now test dynamic Crew Lead change on Crew B BEFORE Lead B responds:
    const newLeadMember = await createLinkedCrewMember({
      realm,
      vendorId: crewB.vendor.id,
      providerContextId: crewB.providerContext.id,
      fullName: 'Lead Baru Crew B',
    });
    await addHandymanCrewMember(
      {
        handymanCrewId: crewB.crew.id,
        handymanWorkerContextId: newLeadMember.workerContext.id,
      },
      adminId,
    );
    await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: crewB.crew.id,
        handymanWorkerContextId: newLeadMember.workerContext.id,
      },
      adminId,
    );

    // Former Lead B is immediately rejected if they try to respond to assignment B (403 HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN)
    const oldLeadBAttempt = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentBId}/respond`,
      )
      .set(auth(leadBToken))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(oldLeadBAttempt.status, 403);
    assert.equal(
      oldLeadBAttempt.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN',
    );

    // Former Lead B is also rejected if they try to check in (403 HANDYMAN_WORK_SESSION_NOT_AUTHORIZED)
    await assert.rejects(
      () =>
        checkInHandymanWorkSession(
          {
            executionScopeId: scope.id,
            idempotencyKey: `checkin-${randomUUID()}`,
          },
          crewB.leadUser.id,
        ),
      (err: any) => err?.statusCode === 403,
    );

    // New Lead of Crew B received EXECUTION_SCOPE_ASSIGNMENT_PENDING notification and can respond TERIMA
    const newLeadInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(newLeadMember.token));
    assert.equal(newLeadInbox.status, 200);
    assert.ok(
      (newLeadInbox.body.data as any[]).some(
        (n) =>
          n.sourceEntityType === 'EXECUTION_SCOPE_ASSIGNMENT' &&
          n.sourceEntityId === assignmentBId &&
          n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_PENDING',
      ),
    );

    const newLeadAccept = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentBId}/respond`,
      )
      .set(auth(newLeadMember.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(newLeadAccept.status, 200);
    assert.equal(newLeadAccept.body.data.responseStatus, 'TERIMA');
    assert.equal(
      newLeadAccept.body.data.respondedByUserId,
      newLeadMember.user.id,
    );
  });

  it('4. Inspector assign -> IN_APP notification -> TIDAK_BISA / TERIMA, reassign & revoke preserve history, and declined or replaced Inspector is blocked from performing visit', async () => {
    const realm = await realmFixture('Part02B_4');
    const inspectorA = await createEligibleInspector(realm, 'Inspector A');
    const inspectorB = await createEligibleInspector(realm, 'Inspector B');
    const { requestId, visitId } =
      await createInspectionRequiredRequestAndVisit(realm, inspectorA.user.id);

    // Operations assigns Inspector A
    const assignA = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set(auth(adminToken))
      .send({ inspectorUserId: inspectorA.user.id });
    assert.equal(assignA.status, 201, JSON.stringify(assignA.body));
    const assignmentAId = assignA.body.data.id as string;
    assert.equal(assignA.body.data.responseStatus, 'PENDING');
    assert.equal(assignA.body.data.reassignmentRequired, false);

    // Inspector A receives INSPECTOR_VISIT_ASSIGNMENT_PENDING IN_APP notification
    const inboxA = await api()
      .get(`${V1}/notifications`)
      .set(auth(inspectorA.token));
    assert.equal(inboxA.status, 200);
    assert.equal(
      (inboxA.body.data as any[]).filter(
        (n) =>
          n.sourceEntityType === 'INSPECTOR_VISIT_ASSIGNMENT' &&
          n.sourceEntityId === assignmentAId &&
          n.sourceEventType === 'INSPECTOR_VISIT_ASSIGNMENT_PENDING',
      ).length,
      1,
    );

    // Inspector B (not assigned) is forbidden from responding to Inspector A's assignment
    const wrongInspector = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentAId}/respond`,
      )
      .set(auth(inspectorB.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(wrongInspector.status, 403);
    assert.equal(
      wrongInspector.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN',
    );

    // Inspector A responds TIDAK_BISA without reason -> 400 VALIDATION_ERROR
    const noReason = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentAId}/respond`,
      )
      .set(auth(inspectorA.token))
      .send({ responseStatus: 'TIDAK_BISA' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, 'VALIDATION_ERROR');

    // Inspector A responds TIDAK_BISA with valid reason -> 200 OK
    const declineA = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentAId}/respond`,
      )
      .set(auth(inspectorA.token))
      .send({
        responseStatus: 'TIDAK_BISA',
        declineReason: 'Sedang inspeksi di jadwal gedung lain yang mundur.',
      });
    assert.equal(declineA.status, 200, JSON.stringify(declineA.body));
    assert.equal(declineA.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(
      declineA.body.data.declineReason,
      'Sedang inspeksi di jadwal gedung lain yang mundur.',
    );
    assert.equal(declineA.body.data.reassignmentRequired, true);

    // Visit Appointment and Service Request are NOT deleted or cancelled
    const visitRow = await q(
      `SELECT id, state FROM handyman_visit_appointments WHERE id = $1`,
      [visitId],
    );
    assert.equal(visitRow.rowCount, 1);
    assert.equal(visitRow.rows[0].state, 'PROPOSED');
    const reqRow = await q(
      `SELECT id, status FROM handyman_service_requests WHERE id = $1`,
      [requestId],
    );
    assert.equal(reqRow.rowCount, 1);
    assert.equal(reqRow.rows[0].status, 'INSPECTION_REQUIRED');

    // Operations sees TIDAK_BISA + declineReason + reassignmentRequired on GET /inspector and notifications
    const currentView = await api()
      .get(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set(auth(adminToken));
    assert.equal(currentView.status, 200);
    assert.equal(currentView.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(
      currentView.body.data.declineReason,
      'Sedang inspeksi di jadwal gedung lain yang mundur.',
    );
    assert.equal(currentView.body.data.reassignmentRequired, true);

    const opsInbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(adminToken));
    assert.equal(
      (opsInbox.body.data as any[]).filter(
        (n) =>
          n.sourceEntityType === 'INSPECTOR_VISIT_ASSIGNMENT' &&
          n.sourceEntityId === assignmentAId &&
          n.sourceEventType === 'INSPECTOR_VISIT_ASSIGNMENT_DECLINED',
      ).length,
      1,
    );

    // Declined Inspector A is blocked from performing the visit (recordHandymanInspection -> 409 HANDYMAN_ASSIGNMENT_DECLINED)
    assert.equal(
      await handymanInspectorAssignmentService.isActiveInspectorForRequest(
        realm.client.id,
        requestId,
        inspectorA.user.id,
      ),
      false,
    );
    await assert.rejects(
      () =>
        handymanServiceRequestInspectionService.recordHandymanInspection(
          {
            handymanRequestId: requestId,
            inspectionResult: 'INSPECTED',
            inspectionNotes: 'Attempt by declined inspector A',
          },
          inspectorA.user.id,
        ),
      (err: any) =>
        err?.statusCode === 409 && err?.code === 'HANDYMAN_ASSIGNMENT_DECLINED',
    );

    // Operations reassigns Visit Appointment to Inspector B
    const reassignB = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector/reassign`)
      .set(auth(adminToken))
      .send({
        inspectorUserId: inspectorB.user.id,
        expectedVersion: assignA.body.data.version,
        reason: 'Reassigned to Inspector B after Inspector A declined',
      });
    assert.equal(reassignB.status, 201, JSON.stringify(reassignB.body));
    const assignmentBId = reassignB.body.data.id as string;
    assert.equal(reassignB.body.data.responseStatus, 'PENDING');

    // Inspector A's response history is preserved with ASSIGNMENT_SUPERSEDED
    const historyA = await api()
      .get(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentAId}/response-history`,
      )
      .set(auth(adminToken));
    assert.equal(historyA.status, 200);
    assert.equal(historyA.body.data.status, 'SUPERSEDED');
    assert.equal(historyA.body.data.responseStatus, 'TIDAK_BISA');
    assert.deepEqual(
      (historyA.body.data.events as any[]).map((e) => e.eventType),
      [
        'ASSIGNMENT_PENDING_CREATED',
        'ASSIGNMENT_DECLINED',
        'ASSIGNMENT_SUPERSEDED',
      ],
    );

    // Replaced Inspector A cannot respond to old assignment (409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED)
    const lateRespondA = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentAId}/respond`,
      )
      .set(auth(inspectorA.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(lateRespondA.status, 409);
    assert.equal(
      lateRespondA.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED',
    );

    // Replaced Inspector A cannot perform the visit (409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED)
    await assert.rejects(
      () =>
        handymanServiceRequestInspectionService.recordHandymanInspection(
          {
            handymanRequestId: requestId,
            inspectionResult: 'INSPECTED',
            inspectionNotes: 'Attempt by superseded inspector A',
          },
          inspectorA.user.id,
        ),
      (err: any) =>
        err?.statusCode === 409 &&
        err?.code === 'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED',
    );

    // Inspector B accepts (TERIMA) and can record the inspection
    const acceptB = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentBId}/respond`,
      )
      .set(auth(inspectorB.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(acceptB.status, 200);
    assert.equal(acceptB.body.data.responseStatus, 'TERIMA');

    const recorded =
      await handymanServiceRequestInspectionService.recordHandymanInspection(
        {
          handymanRequestId: requestId,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Inspection completed by Inspector B.',
        },
        inspectorB.user.id,
      );
    assert.equal(recorded.inspectedByUserId, inspectorB.user.id);

    // Also verify revoke preserves response history and blocks revoked inspector
    const { requestId: req2, visitId: visit2 } =
      await createInspectionRequiredRequestAndVisit(realm, inspectorA.user.id);
    const assign2 = await api()
      .post(`${V1}/handyman/visit-appointments/${visit2}/inspector`)
      .set(auth(adminToken))
      .send({ inspectorUserId: inspectorA.user.id });
    assert.equal(assign2.status, 201);
    const assign2Id = assign2.body.data.id as string;

    const revoke2 = await api()
      .post(`${V1}/handyman/visit-appointments/${visit2}/inspector/revoke`)
      .set(auth(adminToken))
      .send({
        expectedVersion: assign2.body.data.version,
        reason: 'Jadwal inspeksi dijadwalkan ulang oleh tenant.',
      });
    assert.equal(revoke2.status, 200);
    assert.equal(revoke2.body.data.status, 'REVOKED');

    const history2 = await api()
      .get(
        `${V1}/handyman/visit-appointments/${visit2}/inspector-assignments/${assign2Id}/response-history`,
      )
      .set(auth(adminToken));
    assert.equal(history2.status, 200);
    assert.equal(history2.body.data.status, 'REVOKED');
    assert.deepEqual(
      (history2.body.data.events as any[]).map((e) => e.eventType),
      ['ASSIGNMENT_PENDING_CREATED', 'ASSIGNMENT_SUPERSEDED'],
    );

    await assert.rejects(
      () =>
        handymanServiceRequestInspectionService.recordHandymanInspection(
          {
            handymanRequestId: req2,
            inspectionResult: 'INSPECTED',
            inspectionNotes: 'Attempt by revoked inspector',
          },
          inspectorA.user.id,
        ),
      (err: any) =>
        err?.statusCode === 409 &&
        err?.code === 'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED',
    );
  });

  it('5. Late responses after session check-in or inspection completion, cross-building denial, and transaction rollback atomicity', async () => {
    const realmA = await realmFixture('Part02B_5A');
    const realmB = await realmFixture('Part02B_5B');
    const chainA = await locationChain(realmA);
    const { scope } = await scopeFixture(realmA, chainA);
    const crewA = await crewFixture(realmA);
    const leadAToken = await loginAsMobileWorker(
      crewA.leadUser.id,
      crewA.leadUser.email,
    );
    const crossBuildingWorker = await createEligibleInspector(
      realmB,
      'Cross Building Worker',
    );

    // Assign Crew A and check in BEFORE responding
    const assignRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken))
      .send({
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
      });
    assert.equal(assignRes.status, 201);
    const assignmentId = assignRes.body.data.id as string;

    // Cross-Client / Cross-Building actor denied with 403 BUILDING_ACCESS_DENIED
    const crossAttempt = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(crossBuildingWorker.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(crossAttempt.status, 403);
    assert.equal(crossAttempt.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Check in work session while response is still PENDING
    await performDispatchArrivalAndCheckIn({
      realm: realmA,
      chain: chainA,
      scopeId: scope.id,
      assignmentId,
      leadUserId: crewA.leadUser.id,
      leadToken: leadAToken,
    });

    // Late response after work session check-in is rejected with 409 HANDYMAN_ASSIGNMENT_RESPONSE_LATE
    const lateScopeRespond = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`,
      )
      .set(auth(leadAToken))
      .send({
        responseStatus: 'TIDAK_BISA',
        declineReason: 'Terlambat menolak setelah check-in',
      });
    assert.equal(lateScopeRespond.status, 409);
    assert.equal(
      lateScopeRespond.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_LATE',
    );

    // Late response on Inspector Visit after inspection is recorded -> 409 HANDYMAN_ASSIGNMENT_RESPONSE_LATE
    const inspectorA = await createEligibleInspector(realmA, 'Inspector Late');
    const { requestId, visitId } =
      await createInspectionRequiredRequestAndVisit(realmA, inspectorA.user.id);
    const inspAssign = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set(auth(adminToken))
      .send({ inspectorUserId: inspectorA.user.id });
    assert.equal(inspAssign.status, 201);
    const inspAssignmentId = inspAssign.body.data.id as string;

    // Record inspection while response is PENDING
    await handymanServiceRequestInspectionService.recordHandymanInspection(
      {
        handymanRequestId: requestId,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Inspected before explicit respond call.',
      },
      inspectorA.user.id,
    );

    const lateInspRespond = await api()
      .post(
        `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${inspAssignmentId}/respond`,
      )
      .set(auth(inspectorA.token))
      .send({
        responseStatus: 'TIDAK_BISA',
        declineReason: 'Terlambat menolak setelah inspeksi selesai',
      });
    assert.equal(lateInspRespond.status, 409);
    assert.equal(
      lateInspRespond.body.error.code,
      'HANDYMAN_ASSIGNMENT_RESPONSE_LATE',
    );

    // Transaction rollback atomicity: rolled-back response + notification leaves zero rows
    const fakeAssignmentId = randomUUID();
    const beforeNotifs = await q(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [crewA.leadUser.id],
    );
    await assert.rejects(async () => {
      await withTransaction(async (tx) => {
        await assignmentResponseRepository.ensurePendingForAssignment(
          {
            assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
            assignmentId: fakeAssignmentId,
            clientId: realmA.client.id,
            buildingId: realmA.building.id,
            handymanRequestId: scope.handymanRequestId,
            executionScopeId: scope.id,
            assignedByUserId: adminId,
          },
          tx,
        );
        await notifyExecutionScopeCrewLeadAssignedPending(
          {
            clientId: realmA.client.id,
            buildingId: realmA.building.id,
            handymanRequestId: scope.handymanRequestId,
            executionScopeId: scope.id,
            assignmentId: fakeAssignmentId,
            crewId: crewA.crew.id,
            leadUserId: crewA.leadUser.id,
            leadWorkerContextId: crewA.workerContext.id,
          },
          tx,
        );
        await notifyInspectorAssignedPending(
          {
            clientId: realmA.client.id,
            buildingId: realmA.building.id,
            handymanRequestId: requestId,
            visitAppointmentId: visitId,
            assignmentId: fakeAssignmentId,
            inspectorUserId: crewA.leadUser.id,
          },
          tx,
        );
        throw new Error('SIMULATED_PART02B_ROLLBACK');
      });
    }, /SIMULATED_PART02B_ROLLBACK/);

    const afterResp = await q(
      `SELECT COUNT(*)::int AS n FROM handyman_assignment_responses WHERE assignment_id = $1`,
      [fakeAssignmentId],
    );
    assert.equal(afterResp.rows[0].n, 0);
    const afterNotifs = await q(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [crewA.leadUser.id],
    );
    assert.equal(afterNotifs.rows[0].n, beforeNotifs.rows[0].n);
  });
});
