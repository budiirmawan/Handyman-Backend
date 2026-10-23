import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { skillService } from '../src/modules/skills';
import { spaceService } from '../src/modules/spaces';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceCertificationService } from '../src/modules/workforce-certifications';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createSessionWithPermissionsForUser } from './helpers/access';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BACKEND-RELEASE-INTEGRATION-01 PART 01 — merged-release focused E2E.
 *
 * This suite exists ONLY because three release lines were integrated into one
 * artifact. It does not re-test what the per-feature suites already prove; it
 * proves the SEAMS between them:
 *
 *   - the competency gate (PR #55) and the assignment-response lifecycle
 *     (PR #56) decide inside ONE transaction, on ONE work-order assignment;
 *   - a refused competency gate leaves no assignment, no PENDING response and
 *     no notification behind (no half-written state);
 *   - TERIMA / TIDAK_BISA, reassignment and IN_APP notifications still work on
 *     a competency-gated assignment;
 *   - a DIRECT freelance worker needs no vendor company (PR #55 03B2D);
 *   - a permission revocation (IAM) applies to the NEXT request.
 */

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-release-integration-e2e-pg';
const DB_PORT = 55691;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let embedded: EmbeddedTestDatabase | null = null;
let adminToken = '';
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const ISSUE_DATE = '2024-02-01T00:00:00.000Z';
const FUTURE_DATE = '2099-12-31T00:00:00.000Z';

const CERT_ACTOR_PERMISSIONS = [
  'workforce_certification.read',
  'workforce_certification.manage',
  'workforce_certification.verify',
];
const certificationActor = (userId: string) => ({
  id: userId,
  permissions: new Set(CERT_ACTOR_PERMISSIONS),
});

before(async () => {
  embedded = await startEmbeddedTestDatabase({ dir: DB_DIR, port: DB_PORT });
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (embedded) await embedded.stop();
  } finally {
    pool = null;
    database = null;
    embedded = null;
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Realm = {
  client: { id: string };
  building: { id: string };
  otherBuilding: { id: string };
  organization: { id: string };
  department: { id: string };
  position: { id: string };
};

async function realm(): Promise<Realm> {
  const client = await clientService.createClient({
    code: `CL_${suffix()}`,
    name: 'Release Integration Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PR_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BL_${suffix()}`,
    name: 'Building A',
  });
  const otherBuilding = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BL_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: otherBuilding.id,
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `OR_${suffix()}`,
    name: 'Handyman Operations',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DP_${suffix()}`,
    name: 'Field Operations',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `PS_${suffix()}`,
    name: 'Technician',
  });
  return { client, building, otherBuilding, organization, department, position };
}

async function worker(
  r: Realm,
  workforceType: 'INTERNAL' | 'CONTRACT' | 'FREELANCE' = 'INTERNAL',
) {
  const profile = await workforceService.createWorkforceProfile({
    organizationId: r.organization.id,
    departmentId: r.department.id,
    positionId: r.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: `Worker ${suffix()}`,
    workforceType,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: r.building.id,
  });
  return profile;
}

/**
 * A worker WITH a login. `respond` authorizes the CALLER against the ACTIVE
 * assignment's `workforce_profiles.user_id`, so the response path needs the
 * worker's own session, not an administrator's.
 */
async function workerWithSession(r: Realm, certificateName?: string) {
  const password = 'WorkerPass123';
  const user = await userService.createUser({
    email: `field-${suffix().toLowerCase()}@example.com`,
    displayName: `Field Worker ${suffix()}`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: r.organization.id,
    departmentId: r.department.id,
    positionId: r.position.id,
    userId: user.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Field Worker',
    workforceType: 'FREELANCE',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: r.building.id,
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: r.building.id,
  });
  if (certificateName !== undefined) {
    await giveCertificate(profile.id, certificateName, true);
  }
  const token = await createSessionWithPermissionsForUser(
    { id: user.id, email: user.email },
    password,
    [
      { code: 'work_order.read', name: 'Read Work Orders' },
      { code: 'work_order.manage', name: 'Manage Work Orders' },
    ],
  );
  return { user, profile, token };
}

/** A Handyman-lifecycle Work Order: Customer Care origin, no trade picked. */
async function customerCareWorkOrder(r: Realm): Promise<string> {
  const floor = await floorService.createFloor({
    buildingId: r.building.id,
    code: `FL_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AR_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Tenant Unit',
  });

  const company = await api()
    .post(`${V1}/clients/${r.client.id}/tenant-companies`)
    .set(auth())
    .send({ tenantCode: `TN_${suffix()}`, tenantName: 'Tenant Co' });
  assert.equal(company.status, 201, JSON.stringify(company.body));

  const pic = await api()
    .post(`${V1}/tenant-companies/${company.body.data.id}/pics`)
    .set(auth())
    .send({
      picName: 'Tenant PIC',
      email: `pic-${suffix().toLowerCase()}@tenant.example.com`,
    });
  assert.equal(pic.status, 201, JSON.stringify(pic.body));

  const spaceBinding = await api()
    .post(`${V1}/tenant-companies/${company.body.data.id}/spaces`)
    .set(auth())
    .send({ buildingId: r.building.id, spaceId: space.id });
  assert.equal(spaceBinding.status, 201, JSON.stringify(spaceBinding.body));

  const context = await api()
    .post(`${V1}/tenant-companies/${company.body.data.id}/building-contexts`)
    .set(auth())
    .send({ buildingId: r.building.id });
  assert.equal(context.status, 201, JSON.stringify(context.body));

  const request = await api()
    .post(`${V1}/tenant-companies/${company.body.data.id}/service-requests`)
    .set(auth())
    .send({
      tenantPicId: pic.body.data.id,
      buildingId: r.building.id,
      spaceId: space.id,
      requestNumber: `SR_${suffix()}`,
      requestType: 'KERAN_BOCOR',
      title: 'Wastafel bocor di kamar mandi',
      description: 'Air menetes dari pipa bawah wastafel sejak pagi.',
      priority: 'HIGH',
    });
  assert.equal(request.status, 201, JSON.stringify(request.body));

  const workRequest = await api()
    .post(`${V1}/tenant-service-requests/${request.body.data.id}/work-request`)
    .set(auth());
  assert.equal(workRequest.status, 201, JSON.stringify(workRequest.body));

  const workOrder = await api()
    .post(`${V1}/tenant-service-requests/${request.body.data.id}/work-order`)
    .set(auth())
    .send({ workOrderNumber: `WO_${suffix()}` });
  assert.equal(workOrder.status, 201, JSON.stringify(workOrder.body));
  return workOrder.body.data.workOrderId as string;
}

async function tradeCategoryId(code: string): Promise<string> {
  const row = await q('SELECT id FROM work_order_trade_categories WHERE code = $1', [
    code,
  ]);
  assert.ok(row.rows[0], `seeded trade category ${code} is missing`);
  return row.rows[0].id as string;
}

const classify = (workOrderId: string, body: Record<string, unknown>) =>
  api().patch(`${V1}/work-orders/${workOrderId}/classification`).set(auth()).send(body);

const assign = (workOrderId: string, body: Record<string, unknown>) =>
  api().post(`${V1}/work-orders/${workOrderId}/assignments`).set(auth()).send(body);

const respond = (
  workOrderId: string,
  assignmentId: string,
  body: Record<string, unknown>,
  token = adminToken,
) =>
  api()
    .post(`${V1}/work-orders/${workOrderId}/assignments/${assignmentId}/respond`)
    .set(auth(token))
    .send(body);

/** A MANDATORY certification requirement on the PLUMBING trade. */
async function requirePlumbingCertificate(clientId: string, categoryId: string) {
  const created = await api()
    .post(
      `${V1}/work-order-trade-categories/${categoryId}/competency-requirements?clientId=${clientId}`,
    )
    .set(auth())
    .send({
      requirementType: 'CERTIFICATION',
      certificateName: 'Sertifikat Plumbing',
      enforcementLevel: 'MANDATORY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

async function giveCertificate(
  workforceProfileId: string,
  certificateName: string,
  verify: boolean,
): Promise<string> {
  const created = await workforceCertificationService.createWorkforceCertification(
    workforceProfileId,
    {
      certificateNumber: `CERT-${suffix()}`,
      certificateName,
      issuingAuthority: 'Kementerian Ketenagakerjaan RI',
      issueDate: ISSUE_DATE,
      expiryDate: FUTURE_DATE,
    },
    certificationActor(adminUserId),
  );
  if (verify) {
    await workforceCertificationService.verifyWorkforceCertification(
      workforceProfileId,
      created.id,
      { verificationStatus: 'VERIFIED' },
      certificationActor(adminUserId),
    );
  }
  return created.id;
}

async function assignmentsOf(workOrderId: string) {
  const res = await q(
    'SELECT id, status FROM work_order_assignments WHERE work_order_id = $1',
    [workOrderId],
  );
  return res.rows as Array<{ id: string; status: string }>;
}

async function responseRowsOf(assignmentIds: string[]) {
  if (assignmentIds.length === 0) return [] as Array<{ id: string }>;
  const res = await q(
    'SELECT id FROM handyman_assignment_responses WHERE assignment_id = ANY($1::uuid[])',
    [assignmentIds],
  );
  return res.rows as Array<{ id: string }>;
}

async function notificationsFor(workOrderId: string) {
  const res = await q(
    `SELECT id, source_entity_type, source_event_type, channel
       FROM notifications
      WHERE navigation_target_id = $1 OR source_entity_id = $1`,
    [workOrderId],
  );
  return res.rows as Array<{
    id: string;
    source_entity_type: string;
    source_event_type: string;
    channel: string;
  }>;
}

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

describe('release integration — competency gate × assignment response', () => {
  it('S1. an unclassified Customer Care Work Order is refused and leaves NO assignment, response or notification', async () => {
    if (!pool) return;
    const r = await realm();
    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);

    const refused = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'WORK_ORDER_CLASSIFICATION_REQUIRED');

    const assignments = await assignmentsOf(woId);
    assert.equal(assignments.length, 0, 'no assignment row may be written');
    assert.equal((await responseRowsOf(assignments.map((a) => a.id))).length, 0);
    assert.equal((await notificationsFor(woId)).length, 0);
  });

  it('S2. a MANDATORY competency gap refuses atomically (no assignment, no PENDING response, no IN_APP notice)', async () => {
    if (!pool) return;
    const r = await realm();
    const unqualified = await worker(r);
    const woId = await customerCareWorkOrder(r);
    const plumbing = await tradeCategoryId('PLUMBING');
    await requirePlumbingCertificate(r.client.id, plumbing);

    const classified = await classify(woId, { tradeCategoryId: plumbing });
    assert.equal(classified.status, 200, JSON.stringify(classified.body));

    const refused = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: unqualified.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED');

    // The whole transaction rolled back: the gate runs BEFORE the response row
    // and the notification are created.
    const assignments = await assignmentsOf(woId);
    assert.equal(assignments.length, 0);
    assert.equal((await responseRowsOf(assignments.map((a) => a.id))).length, 0);
    assert.equal((await notificationsFor(woId)).length, 0);

    const ledger = await q(
      'SELECT id FROM work_order_assignment_competency_decisions WHERE work_order_id = $1',
      [woId],
    );
    assert.equal(ledger.rowCount, 0, 'a refused assignment writes no decision');
  });

  it('S3. a qualified worker is assigned AND receives PENDING + competency in the SAME response', async () => {
    if (!pool) return;
    const r = await realm();
    const qualified = await worker(r);
    await giveCertificate(qualified.id, 'Sertifikat Plumbing', true);
    const woId = await customerCareWorkOrder(r);
    const plumbing = await tradeCategoryId('PLUMBING');
    await requirePlumbingCertificate(r.client.id, plumbing);
    await classify(woId, { tradeCategoryId: plumbing });

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: qualified.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    // Both release lines describe the SAME assignment in ONE payload.
    assert.equal(assigned.body.data.responseStatus, 'PENDING');
    assert.equal(assigned.body.data.reassignmentRequired, false);
    assert.equal(assigned.body.data.competency.satisfied, true);
    assert.equal(assigned.body.data.competency.rule, 'ALL');
    assert.equal(assigned.body.data.competency.mandatoryRequirementCount, 1);

    // ... and both persisted facts exist for that one assignment id.
    const assignmentId = assigned.body.data.id as string;
    const responses = await responseRowsOf([assignmentId]);
    assert.equal(responses.length, 1);
    const ledger = await q(
      `SELECT action FROM work_order_assignment_competency_decisions
        WHERE assignment_id = $1`,
      [assignmentId],
    );
    assert.equal(ledger.rowCount, 1);
    assert.equal(ledger.rows[0].action, 'ASSIGNED');
  });

  it('S4. TERIMA on a competency-gated assignment acknowledges without duplicating the gate', async () => {
    if (!pool) return;
    const r = await realm();
    const qualified = await workerWithSession(r, 'Sertifikat Plumbing');
    const woId = await customerCareWorkOrder(r);
    const plumbing = await tradeCategoryId('PLUMBING');
    await requirePlumbingCertificate(r.client.id, plumbing);
    await classify(woId, { tradeCategoryId: plumbing });

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: qualified.profile.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const assignmentId = assigned.body.data.id as string;

    const accepted = await respond(
      woId,
      assignmentId,
      { decision: 'TERIMA' },
      qualified.token,
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.responseStatus, 'TERIMA');
    assert.equal(accepted.body.data.reassignmentRequired, false);

    // Idempotent replay of the same decision.
    const replay = await respond(
      woId,
      assignmentId,
      { decision: 'TERIMA' },
      qualified.token,
    );
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.responseStatus, 'TERIMA');

    // A contradictory transition is a 409, never a silent overwrite.
    const contradictory = await respond(
      woId,
      assignmentId,
      {
        decision: 'TIDAK_BISA',
        declineReason: 'Sudah menerima pekerjaan lain',
      },
      qualified.token,
    );
    assert.equal(contradictory.status, 409, JSON.stringify(contradictory.body));

    // The competency decision ledger still holds exactly ONE decision.
    const ledger = await q(
      'SELECT id FROM work_order_assignment_competency_decisions WHERE assignment_id = $1',
      [assignmentId],
    );
    assert.equal(ledger.rowCount, 1);
  });

  it('S5. TIDAK_BISA requires a reason, does not cancel the Work Order, and forces reassignment', async () => {
    if (!pool) return;
    const r = await realm();
    const workerA = await workerWithSession(r);
    const woId = await customerCareWorkOrder(r);
    const general = await tradeCategoryId('GENERAL_REPAIR');
    await classify(woId, { tradeCategoryId: general });

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: workerA.profile.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const assignmentId = assigned.body.data.id as string;

    const missingReason = await respond(
      woId,
      assignmentId,
      { decision: 'TIDAK_BISA' },
      workerA.token,
    );
    assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));

    const declined = await respond(
      woId,
      assignmentId,
      {
        decision: 'TIDAK_BISA',
        declineReason: 'Tidak memiliki alat kerja yang dibutuhkan',
      },
      workerA.token,
    );
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.data.responseStatus, 'TIDAK_BISA');
    assert.equal(declined.body.data.reassignmentRequired, true);

    // The Tenant request / Work Order is never cancelled by a decline.
    const wo = await q('SELECT status FROM work_orders WHERE id = $1', [woId]);
    assert.notEqual(wo.rows[0].status, 'CANCELLED');

    // The decline is announced to Operations as IN_APP.
    const notices = await notificationsFor(woId);
    assert.ok(
      notices.some(
        (n) =>
          n.source_event_type === 'WORK_ORDER_ASSIGNMENT_DECLINED' &&
          n.channel === 'IN_APP',
      ),
      `expected an IN_APP decline notice, got ${JSON.stringify(notices)}`,
    );
  });

  it('S6. reassignment after a decline evaluates the gate again and issues a fresh PENDING response', async () => {
    if (!pool) return;
    const r = await realm();
    const workerA = await worker(r);
    const workerB = await workerWithSession(r, 'Sertifikat Plumbing');
    const woId = await customerCareWorkOrder(r);
    const plumbing = await tradeCategoryId('PLUMBING');
    await requirePlumbingCertificate(r.client.id, plumbing);
    await classify(woId, { tradeCategoryId: plumbing });

    const first = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: workerA.id,
    });
    // workerA has no certificate -> refused, so seed the ACTIVE assignment via
    // the qualified worker and then reassign to prove the second gate run.
    assert.equal(first.status, 409, JSON.stringify(first.body));

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: workerB.profile.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const firstId = assigned.body.data.id as string;

    const declined = await respond(
      woId,
      firstId,
      {
        decision: 'TIDAK_BISA',
        declineReason: 'Bertabrakan dengan jadwal lain',
      },
      workerB.token,
    );
    assert.equal(declined.status, 200, JSON.stringify(declined.body));

    // Reassigning to the SAME unqualified worker must be refused atomically and
    // must leave the declined assignment untouched.
    const refusedReassign = await api()
      .patch(`${V1}/work-orders/${woId}/assignments/${firstId}`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: workerA.id });
    assert.equal(refusedReassign.status, 409, JSON.stringify(refusedReassign.body));
    assert.equal(
      refusedReassign.body.error.code,
      'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
    );
    const stillActive = await q(
      `SELECT status FROM work_order_assignments WHERE id = $1`,
      [firstId],
    );
    assert.equal(stillActive.rows[0].status, 'ACTIVE');

    // Reassigning back to the qualified worker supersedes and re-decides.
    const reassigned = await api()
      .patch(`${V1}/work-orders/${woId}/assignments/${firstId}`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: workerB.profile.id });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
    assert.equal(reassigned.body.data.responseStatus, 'PENDING');
    assert.equal(reassigned.body.data.competency.satisfied, true);

    const actions = await q(
      `SELECT action FROM work_order_assignment_competency_decisions
        WHERE work_order_id = $1 ORDER BY evaluated_at ASC`,
      [woId],
    );
    assert.deepEqual(
      actions.rows.map((row) => row.action),
      ['ASSIGNED', 'REASSIGNED'],
    );
  });

  it('S7. a DIRECT freelance worker needs no vendor company', async () => {
    if (!pool) return;
    const r = await realm();
    const freelance = await worker(r, 'FREELANCE');
    const woId = await customerCareWorkOrder(r);
    const general = await tradeCategoryId('GENERAL_REPAIR');
    await classify(woId, { tradeCategoryId: general });

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: freelance.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.vendorId, null);

    const type = await q(
      'SELECT workforce_type FROM workforce_profiles WHERE id = $1',
      [freelance.id],
    );
    assert.equal(type.rows[0].workforce_type, 'FREELANCE');
  });

  it('S8. a revoked permission applies to the NEXT request (401/403/RBAC)', async () => {
    if (!pool) return;
    const r = await realm();
    const woId = await customerCareWorkOrder(r);
    const general = await tradeCategoryId('GENERAL_REPAIR');

    const email = `revoke-${suffix().toLowerCase()}@example.com`;
    const password = 'RevokePass123';
    const user = await userService.createUser({ email, displayName: 'Revocable Ops' });
    await credentialService.createInitialCredential({ userId: user.id, password });
    await buildingAssignmentService.createAssignment(user.id, {
      buildingId: r.building.id,
    });

    const role = await roleService.createRole({
      code: `REVOKE_${suffix()}`,
      name: 'Revocable Operations',
    });
    const readPermission = await permissionRepository.findByCode('work_order.read');
    const managePermission = await permissionRepository.findByCode('work_order.manage');
    assert.ok(readPermission && managePermission);
    await permissionService.assignPermissionToRole(role.id, readPermission.id);
    await permissionService.assignPermissionToRole(role.id, managePermission.id);
    await roleService.assignRoleToUser(user.id, role.id);

    const login = await api().post(`${V1}/auth/login`).send({ email, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = login.body.data.sessionToken as string;

    // Before revocation the holder may classify.
    const allowed = await api()
      .patch(`${V1}/work-orders/${woId}/classification`)
      .set(auth(token))
      .send({ tradeCategoryId: general });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

    // Revoke the WRITE permission; the very next request must already fail.
    await permissionService.revokePermissionFromRole(role.id, managePermission.id);

    const denied = await api()
      .patch(`${V1}/work-orders/${woId}/classification`)
      .set(auth(token))
      .send({ tradeCategoryId: general });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    // The remaining grant still works: revocation is per grant, not a logout.
    const stillReads = await api()
      .get(`${V1}/work-orders/${woId}/assignments`)
      .set(auth(token));
    assert.equal(stillReads.status, 200, JSON.stringify(stillReads.body));

    // No credential was touched by the revocation.
    const credential = await q(
      'SELECT password_hash FROM user_credentials WHERE user_id = $1',
      [user.id],
    );
    assert.equal(credential.rowCount, 1);

    // And an unauthenticated call is still 401.
    const anonymous = await api().get(`${V1}/work-orders/${woId}/assignments`);
    assert.equal(anonymous.status, 401);
  });

  it('S9. Building and Client isolation hold for the merged assignment routes', async () => {
    if (!pool) return;
    const r = await realm();
    const outsiderUser = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    await credentialService.createInitialCredential({
      userId: outsiderUser.id,
      password: 'OutsiderPass123',
    });
    // Deliberately NO Building assignment for this user.
    const outsider = await createSessionWithPermissionsForUser(
      { id: outsiderUser.id, email: outsiderUser.email },
      'OutsiderPass123',
      [
        { code: 'work_order.read', name: 'Read Work Orders' },
        { code: 'work_order.manage', name: 'Manage Work Orders' },
      ],
    );

    const woId = await customerCareWorkOrder(r);

    // A caller with the permissions but WITHOUT a Building assignment: 403.
    const denied = await api()
      .get(`${V1}/work-orders/${woId}/assignments`)
      .set(auth(outsider));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
  });
});
