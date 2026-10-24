import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanCrewMember,
  handymanProviderContextService,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestService,
  recordHandymanRequestTriage,
} from '../src/modules/handyman-requests';
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
import { vendorService } from '../src/modules/vendors';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
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
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — Assignment Acknowledgment.
 *
 * Focused integration certification for the capabilities confirmed missing by
 * the PART 01 audit (see
 * docs/handyman/CR-HM-FIELD-OPS-ACK-01_PART01_ASSIGNMENT_ACKNOWLEDGMENT.md):
 *   1. assignmentId in the AUTHORIZED My Jobs feed;
 *   2. concurrent-device idempotency (one key → one assignment, distinct
 *      device keys converge on one decision + one audit event);
 *   3. explicit acknowledgment / audit trail on the Handyman lanes;
 *   4. reassignment + appointment-window expiry guards;
 *   5. tenant / crew scope and negative RBAC.
 *
 * Reuses the existing assignment authorities untouched. The PR #58
 * notification producer is not modified and is asserted only through its
 * existing deduplicated IN_APP output. No arrival challenge is exercised.
 */
const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-field-ops-ack-part01-pg';
const DB_PORT = 55585;

let dbHandle: EmbeddedTestDatabase | null = null;
let pool: Pool | null = null;
let adminId = '';
let adminToken = '';

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}
function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!pool) throw new Error('Pool not initialized');
  return (await pool.query(text, params)).rows as T[];
}

before(async () => {
  await rm(DB_DIR, { recursive: true, force: true });
  dbHandle = await startEmbeddedTestDatabase({ dir: DB_DIR, port: DB_PORT });
  resetAppConfigCache();
  const config = await ensureTestDatabase();
  if (!config) throw new Error('Embedded PostgreSQL test database failed to initialize');
  pool = await initDatabase(config);
  await migrateUp(pool);

  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
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

/** Mobile worker session: read permissions only, never a manage permission. */
async function loginAsMobileWorker(userId: string, email: string): Promise<string> {
  const password = `Pass#${suffix()}Aa1`;
  await credentialService.createInitialCredential({ userId, password });
  const role = await roleService.createRole({
    code: `MOB_ACK_${suffix()}`,
    name: `Mobile Ack Worker ${suffix()}`,
  });
  for (const code of ['work_order.read', 'tenant_company.read']) {
    let perm = await permissionRepository.findByCode(code);
    if (!perm) perm = await permissionService.createPermission({ code, name: code });
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
  const res = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.sessionToken as string;
}

/** A linked, login-capable Crew Helper who is NOT the Crew Lead. */
async function createLinkedCrewMember(input: {
  realm: Awaited<ReturnType<typeof realmFixture>>;
  vendorId: string;
  providerContextId: string;
}) {
  const s = suffix();
  const user = await userService.createUser({
    email: `helper-${s.toLowerCase()}@example.com`,
    displayName: `Helper ${s}`,
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: input.realm.building.id,
  });
  const token = await loginAsMobileWorker(user.id, user.email);
  const profile = await workforceService.createWorkforceProfile({
    organizationId: input.realm.organization.id,
    departmentId: input.realm.department.id,
    positionId: input.realm.position.id,
    employeeCode: `HLP_${s}`,
    fullName: `Helper ${s}`,
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
    vendorPersonnelCode: `VPH_${s}`,
  });
  const workerContext = await handymanWorkerContextService.createHandymanWorkerContext(
    {
      handymanProviderContextId: input.providerContextId,
      workforceProfileId: profile.id,
    },
    adminId,
  );
  return { user, token, workerContext };
}

/** An eligible inspector with its own login session and building scope. */
async function createEligibleInspector(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const s = suffix();
  const user = await userService.createUser({
    email: `insp-${s.toLowerCase()}@example.com`,
    displayName: `Inspector ${s}`,
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
  const providerContext = await handymanProviderContextService.createHandymanProviderContext(
    { vendorId: vendor.id },
    adminId,
  );
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `INSP_${s}`,
    fullName: `Inspector ${s}`,
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
  await handymanWorkerContextService.createHandymanWorkerContext(
    {
      handymanProviderContextId: providerContext.id,
      workforceProfileId: profile.id,
    },
    adminId,
  );
  return { user, token };
}

/**
 * Creates an INSPECTION_REQUIRED request + INSPECTION visit. `window` lets the
 * suite build a live future slot or an already-elapsed slot; the appointment
 * trigger keeps the slot immutable afterwards, so the fact is created once.
 */
async function createInspectionVisit(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  inspectorUserId: string,
  window: 'FUTURE' | 'EXPIRED' = 'FUTURE',
): Promise<{ requestId: string; visitId: string }> {
  const s = suffix();
  const chain = await locationChain(realm);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: realm.client.id, tenantCode: `TNT_${s}`, tenantName: `Tenant ${s}` },
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
      picName: 'Tenant Requester',
      email: `requester-${s.toLowerCase()}@tenant.example.com`,
      userId: linkedUser.id,
    },
    adminId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: realm.building.id, spaceId: chain.space.id },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: realm.building.id },
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
    { clientId: realm.client.id, code: `HM_${s}`, name: `Service ${s}`, category: 'FM_HINT_TEXT' },
    adminId,
  );
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    { channelAttributionId: attribution.id, serviceCatalogId: service.id },
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
  const startOffset = window === 'EXPIRED' ? "-3 hours" : "1 hour";
  const endOffset = window === 'EXPIRED' ? "-2 hours" : "2 hours";
  const visitRes = await q<{ id: string }>(
    `INSERT INTO handyman_visit_appointments (
       id, client_id, handyman_request_id, tenant_company_id, building_id,
       kind, resource_type, resource_id, start_at, end_at, timezone,
       state, created_by_user_id, tenant_choice_evidence_ref
     ) VALUES (
       $1, $2, $3, $4, $5,
       'INSPECTION', 'INSPECTOR_USER', $6,
       NOW() + INTERVAL '${startOffset}', NOW() + INTERVAL '${endOffset}', 'Asia/Jakarta',
       'PROPOSED', $7, 'seed-choice'
     ) RETURNING id`,
    [randomUUID(), realm.client.id, request.id, company.id, realm.building.id,
      inspectorUserId, adminId],
  );
  return { requestId: request.id, visitId: visitRes[0].id };
}

describe('CR-HM-FIELD-OPS-ACK-01 PART 01 — assignment acknowledgment', () => {
  it('1. authorized My Jobs feed returns the exact assignmentId (never a scope locator)', async () => {
    const realm = await realmFixture('Ack1');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    const leadToken = await loginAsMobileWorker(crew.leadUser.id, crew.leadUser.email);
    const helper = await createLinkedCrewMember({
      realm,
      vendorId: crew.vendor.id,
      providerContextId: crew.providerContext.id,
    });
    await addHandymanCrewMember(
      { handymanCrewId: crew.crew.id, handymanWorkerContextId: helper.workerContext.id },
      adminId,
    );

    const assigned = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken))
      .send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const assignmentId = assigned.body.data.id as string;

    const mine = await api().get(`${V1}/handyman/field/my-jobs`).set(auth(leadToken));
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const job = (mine.body.data.jobs as any[]).find((j) => j.executionScopeId === scope.id);
    assert.ok(job, 'assigned job must be visible to the current Crew Lead');
    assert.equal(job.assignmentId, assignmentId);
    assert.equal(job.assignmentTargetType, 'EXECUTION_SCOPE_ASSIGNMENT');
    assert.notEqual(job.assignmentId, job.executionScopeId);
    assert.equal(job.responseStatus, 'PENDING');
    assert.deepEqual(job.availableActions, ['TERIMA', 'TIDAK_BISA']);

    // Helper (same crew, same building, valid mobile session) is NOT the
    // authorized assignee: the feed stays empty and respond stays 403.
    const helperFeed = await api().get(`${V1}/handyman/field/my-jobs`).set(auth(helper.token));
    assert.equal(helperFeed.status, 200);
    assert.deepEqual((helperFeed.body.data.jobs as any[])
      .filter((j) => j.executionScopeId === scope.id), []);
    const helperRespond = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`)
      .set(auth(helper.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(helperRespond.status, 403);
    assert.equal(helperRespond.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN');

    // Operations (management permission) still cannot impersonate the worker.
    const opsRespond = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`)
      .set(auth(adminToken))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(opsRespond.status, 403);
    assert.equal(opsRespond.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN');
  });

  it('2. concurrent devices converge on ONE decision, ONE event and ONE audit row', async () => {
    const realm = await realmFixture('Ack2');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    const leadToken = await loginAsMobileWorker(crew.leadUser.id, crew.leadUser.email);
    const assigned = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken))
      .send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    assert.equal(assigned.status, 201);
    const assignmentId = assigned.body.data.id as string;

    // Two devices, two different keys, one identical decision — both succeed;
    // only the first is a mutation, the second is an idempotent replay.
    const [deviceA, deviceB] = await Promise.all([
      api()
        .post(`${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`)
        .set(auth(leadToken))
        .set('Idempotency-Key', `device-a-${suffix()}`)
        .send({ responseStatus: 'TERIMA', notes: 'Siap.' }),
      api()
        .post(`${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/respond`)
        .set(auth(leadToken))
        .set('Idempotency-Key', `device-b-${suffix()}`)
        .send({ responseStatus: 'TERIMA', notes: 'Siap.' }),
    ]);
    assert.equal(deviceA.status, 200, JSON.stringify(deviceA.body));
    assert.equal(deviceB.status, 200, JSON.stringify(deviceB.body));
    assert.equal(
      [deviceA.body.data.idempotentReplay, deviceB.body.data.idempotentReplay]
        .filter(Boolean).length,
      1,
      'exactly one device performs the mutation',
    );
    assert.equal(deviceA.body.data.acknowledgedAt !== null ||
      deviceB.body.data.acknowledgedAt !== null, true);

    const acceptedEvents = await q(
      `SELECT id FROM handyman_assignment_response_events
        WHERE assignment_id = $1 AND event_type = 'ASSIGNMENT_ACCEPTED'`,
      [assignmentId],
    );
    assert.equal(acceptedEvents.length, 1);
    const auditRows = await q(
      `SELECT id, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_ASSIGNMENT_RESPONSE'
          AND entity_id = $1 AND event_type = 'HANDYMAN_ASSIGNMENT_ACKNOWLEDGED'`,
      [assignmentId],
    );
    assert.equal(auditRows.length, 1, 'exactly one explicit acknowledgment audit row');
    assert.equal((auditRows[0].metadata as any).assignmentTargetType, 'EXECUTION_SCOPE_ASSIGNMENT');

    // The PR #58 producer still emits exactly one deduplicated acceptance.
    const opsInbox = await api().get(`${V1}/notifications`).set(auth(adminToken));
    assert.equal(opsInbox.status, 200);
    assert.equal((opsInbox.body.data as any[]).filter((n) =>
      n.sourceEntityType === 'EXECUTION_SCOPE_ASSIGNMENT' &&
      n.sourceEntityId === assignmentId &&
      n.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED').length, 1);

    // History projection exposes the explicit acknowledgment + audit trail.
    const history = await api()
      .get(`${V1}/handyman/execution-scopes/${scope.id}/assignments/${assignmentId}/response-history`)
      .set(auth(leadToken));
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.acknowledgedByUserId, crew.leadUser.id);
    assert.equal(history.body.data.acknowledgedAt !== null, true);
    assert.ok((history.body.data.events as any[]).some((e) => e.eventType === 'ASSIGNMENT_ACCEPTED'));
  });

  it('3. one device key can finalize ONE assignment only (post-reassignment guard)', async () => {
    const realm = await realmFixture('Ack3');
    const chain = await locationChain(realm);
    const first = await scopeFixture(realm, chain);
    const secondChain = await locationChain(realm);
    const second = await scopeFixture(realm, secondChain);
    const crew = await crewFixture(realm);
    const leadToken = await loginAsMobileWorker(crew.leadUser.id, crew.leadUser.email);
    const key = `offline-device-${suffix()}`;

    const assign1 = await api()
      .post(`${V1}/handyman/execution-scopes/${first.scope.id}/assignment`)
      .set(auth(adminToken))
      .send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    assert.equal(assign1.status, 201);
    const assignment1 = assign1.body.data.id as string;
    const ok = await api()
      .post(`${V1}/handyman/execution-scopes/${first.scope.id}/assignments/${assignment1}/respond`)
      .set(auth(leadToken))
      .set('Idempotency-Key', key)
      .send({ responseStatus: 'TIDAK_BISA', declineReason: 'Material belum tersedia.' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const assign2 = await api()
      .post(`${V1}/handyman/execution-scopes/${second.scope.id}/assignment`)
      .set(auth(adminToken))
      .send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    assert.equal(assign2.status, 201);
    const assignment2 = assign2.body.data.id as string;

    // An offline device replaying the SAME key against the NEW assignment
    // must not acknowledge/decline on behalf of the replacement assignment.
    const replay = await api()
      .post(`${V1}/handyman/execution-scopes/${second.scope.id}/assignments/${assignment2}/respond`)
      .set(auth(leadToken))
      .set('Idempotency-Key', key)
      .send({ responseStatus: 'TERIMA' });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_IDEMPOTENCY_CONFLICT');
    const stillPending = await q<{ response_status: string }>(
      `SELECT response_status FROM handyman_assignment_responses WHERE assignment_id = $1`,
      [assignment2],
    );
    assert.equal(stillPending[0].response_status, 'PENDING');

    // A fresh device key still works — the guard is key-scoped, not a lockout.
    const fresh = await api()
      .post(`${V1}/handyman/execution-scopes/${second.scope.id}/assignments/${assignment2}/respond`)
      .set(auth(leadToken))
      .set('Idempotency-Key', `fresh-device-${suffix()}`)
      .send({ responseStatus: 'TERIMA' });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.data.idempotentReplay, false);
  });

  it('4. expired visit window blocks a response; reassignment remains an Operations remedy', async () => {
    const realm = await realmFixture('Ack4');
    const inspectorA = await createEligibleInspector(realm);
    const inspectorB = await createEligibleInspector(realm);
    const { visitId } = await createInspectionVisit(
      realm,
      inspectorA.user.id,
      'EXPIRED',
    );

    const assignA = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set(auth(adminToken))
      .send({ inspectorUserId: inspectorA.user.id });
    assert.equal(assignA.status, 201, JSON.stringify(assignA.body));
    const assignmentA = assignA.body.data.id as string;
    const version = assignA.body.data.version as number;

    const expired = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentA}/respond`)
      .set(auth(inspectorA.token))
      .set('Idempotency-Key', `expired-device-${suffix()}`)
      .send({ responseStatus: 'TERIMA' });
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED');
    const untouched = await q<{ response_status: string }>(
      `SELECT response_status FROM handyman_assignment_responses WHERE assignment_id = $1`,
      [assignmentA],
    );
    assert.equal(untouched[0].response_status, 'PENDING');

    // Operations may still reassign an unacknowledged expired assignment, but
    // the replacement worker is bound by the SAME authoritative window.
    const reassign = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector/reassign`)
      .set(auth(adminToken))
      .send({
        inspectorUserId: inspectorB.user.id,
        expectedVersion: version,
        reason: 'Inspector A did not acknowledge before the visit window elapsed.',
      });
    assert.equal(reassign.status, 201, JSON.stringify(reassign.body));
    const assignmentB = reassign.body.data.id as string;
    const alsoExpired = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentB}/respond`)
      .set(auth(inspectorB.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(alsoExpired.status, 409);
    assert.equal(alsoExpired.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED');
    const replaced = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentA}/respond`)
      .set(auth(inspectorA.token))
      .send({ responseStatus: 'TERIMA' });
    assert.equal(replaced.status, 409);
    assert.equal(replaced.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED');
  });

  it('5. future visit: negative RBAC + tenant/crew scope, then explicit acknowledgment', async () => {
    const realm = await realmFixture('Ack5');
    const otherRealm = await realmFixture('Ack5Other');
    const inspectorA = await createEligibleInspector(realm);
    const inspectorB = await createEligibleInspector(realm);
    const outsider = await createEligibleInspector(otherRealm);
    const { visitId } = await createInspectionVisit(realm, inspectorA.user.id, 'FUTURE');

    const assignA = await api()
      .post(`${V1}/handyman/visit-appointments/${visitId}/inspector`)
      .set(auth(adminToken))
      .send({ inspectorUserId: inspectorA.user.id });
    assert.equal(assignA.status, 201, JSON.stringify(assignA.body));
    const assignmentId = assignA.body.data.id as string;

    const feed = await api().get(`${V1}/handyman/field/my-jobs`).set(auth(inspectorA.token));
    assert.equal(feed.status, 200);
    const item = (feed.body.data.inspections as any[])
      .find((i) => i.visitAppointmentId === visitId);
    assert.ok(item);
    assert.equal(item.assignmentId, assignmentId);
    assert.equal(item.assignmentTargetType, 'INSPECTOR_VISIT_ASSIGNMENT');
    assert.notEqual(item.assignmentId, item.visitAppointmentId);

    const otherFeed = await api().get(`${V1}/handyman/field/my-jobs`).set(auth(inspectorB.token));
    assert.equal(otherFeed.status, 200);
    assert.deepEqual((otherFeed.body.data.inspections as any[])
      .filter((i) => i.visitAppointmentId === visitId), []);

    const respondPath = `${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentId}/respond`;
    const wrongInspector = await api().post(respondPath)
      .set(auth(inspectorB.token)).send({ responseStatus: 'TERIMA' });
    assert.equal(wrongInspector.status, 403);
    assert.equal(wrongInspector.body.error.code, 'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN');

    const crossTenant = await api().post(respondPath)
      .set(auth(outsider.token)).send({ responseStatus: 'TERIMA' });
    assert.equal(crossTenant.status, 403);
    assert.equal(crossTenant.body.error.code, 'BUILDING_ACCESS_DENIED');

    const tooLongKey = await api().post(respondPath)
      .set(auth(inspectorA.token)).set('Idempotency-Key', 'k')
      .send({ responseStatus: 'TERIMA' });
    assert.equal(tooLongKey.status, 400);
    assert.equal(tooLongKey.body.error.code, 'VALIDATION_ERROR');

    const accepted = await api().post(respondPath)
      .set(auth(inspectorA.token))
      .set('Idempotency-Key', `inspector-device-${suffix()}`)
      .send({ responseStatus: 'TERIMA', notes: 'Saya terima kunjungan ini.' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.acknowledgedAt !== null, true);

    const history = await api()
      .get(`${V1}/handyman/visit-appointments/${visitId}/inspector-assignments/${assignmentId}/response-history`)
      .set(auth(inspectorA.token));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.acknowledgedByUserId, inspectorA.user.id);
    assert.ok((history.body.data.events as any[]).some((e) => e.eventType === 'ASSIGNMENT_ACCEPTED'));
    const audit = await q(
      `SELECT id FROM operational_events
        WHERE entity_type = 'HANDYMAN_ASSIGNMENT_RESPONSE'
          AND entity_id = $1 AND event_type = 'HANDYMAN_ASSIGNMENT_ACKNOWLEDGED'`,
      [assignmentId],
    );
    assert.equal(audit.length, 1);
  });
});
