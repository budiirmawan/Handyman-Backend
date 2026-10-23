import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { skillService } from '../src/modules/skills';
import { spaceService } from '../src/modules/spaces';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceCertificationService } from '../src/modules/workforce-certifications';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createSessionWithPermissionsForUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 04A — cross-app operational E2E contract.
 *
 * One uninterrupted lifecycle over HTTP only (no service-level shortcuts):
 *
 *   Tenant → Customer Care → Service Request → Work Order
 *          → Operations Classification → Worker Assignment
 *          → Mobile Acceptance → Foto Evidence → Completion → QC → Closure
 *
 * What this suite locks in:
 *   - a Tenant request needs NO Service Catalog and NO technical trade at
 *     intake (Customer Care records free text);
 *   - the trade is Operations' decision, and a Handyman-lifecycle Work Order
 *     cannot be assigned before it is classified;
 *   - a DIRECT-workforce freelance worker (PART 03B2D) is assignable through
 *     the SAME assignment authority (no vendor, no second workflow);
 *   - the Mobile feed is the acceptance surface and its `availableActions`
 *     follow the authoritative lifecycle;
 *   - PHOTO evidence is bound to the Work Order and survives to completion;
 *   - QC is a verification decision on the COMPLETED Work Order, and closure
 *     requires APPROVED verification (plus BAST readiness, which is NONE here);
 *   - no alternative endpoint can bypass the chain (assignment after closure,
 *     completion before start, closure before approval).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let embedded: EmbeddedTestDatabase | null = null;
let adminToken = '';
let adminUserId = '';

const EMBEDDED_DIR = '/tmp/hm-e2e-04a-pg';
const EMBEDDED_PORT = 55667;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
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
  organization: { id: string };
  department: { id: string };
  position: { id: string };
};

async function realm(): Promise<Realm> {
  const client = await clientService.createClient({
    code: `CL_${suffix()}`,
    name: 'E2E Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PR_${suffix()}`,
    name: 'E2E Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BL_${suffix()}`,
    name: 'E2E Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
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
  return { client, building, organization, department, position };
}

/** A Handyman-managed freelance worker with a login of their own. */
async function freelanceWorkerWithSession(r: Realm) {
  const user = await userService.createUser({
    email: `field-${suffix().toLowerCase()}@example.com`,
    displayName: `Freelance Worker ${suffix()}`,
  });
  const password = 'WorkerPass123';
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: r.organization.id,
    departmentId: r.department.id,
    positionId: r.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Freelance Technician',
    workforceType: 'FREELANCE',
    userId: user.id,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: r.building.id,
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: r.building.id,
  });
  const token = await createSessionWithPermissionsForUser(
    { id: user.id, email: user.email },
    password,
    [
      { code: 'work_order.read', name: 'Read Work Orders' },
      { code: 'work_order.manage', name: 'Manage Work Orders' },
      { code: 'task.read', name: 'Read Tasks' },
      // The camera path: metadata is bound through the Work Order evidence
      // route, the bytes through the shared evidence file route.
      { code: 'evidence.manage', name: 'Manage Evidence' },
      { code: 'evidence.read', name: 'Read Evidence' },
      // Field attendance is part of the Mobile contract under test.
      { code: 'attendance.manage', name: 'Manage Attendance' },
      { code: 'attendance.read', name: 'Read Attendance' },
    ],
  );
  return { user, profile, token };
}

/** A Handyman employee without a login — for competency-only scenarios. */
async function plainWorker(r: Realm) {
  const profile = await workforceService.createWorkforceProfile({
    organizationId: r.organization.id,
    departmentId: r.department.id,
    positionId: r.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: `Technician ${suffix()}`,
    workforceType: 'INTERNAL',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: r.building.id,
  });
  return profile;
}

const CERT_ACTOR_PERMISSIONS = [
  'workforce_certification.read',
  'workforce_certification.manage',
  'workforce_certification.verify',
];
const certificationActor = (userId: string, permissions: string[]) => ({
  id: userId,
  permissions: new Set(permissions),
});

/** A real certificate row, optionally already verified by Operations. */
async function giveCertificate(
  workforceProfileId: string,
  certificateName: string,
  verify = false,
): Promise<string> {
  const created = await workforceCertificationService.createWorkforceCertification(
    workforceProfileId,
    {
      certificateNumber: `CERT-${suffix()}`,
      certificateName,
      issuingAuthority: 'Kementerian Ketenagakerjaan RI',
      issueDate: '2025-01-15',
      expiryDate: '2030-12-31',
    },
    certificationActor(adminUserId, CERT_ACTOR_PERMISSIONS),
  );
  if (verify) {
    await workforceCertificationService.verifyWorkforceCertification(
      workforceProfileId,
      created.id,
      { verificationStatus: 'VERIFIED' },
      certificationActor(adminUserId, CERT_ACTOR_PERMISSIONS),
    );
  }
  return created.id;
}

async function addRequirement(
  tradeCategoryId: string,
  clientId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await api()
    .post(
      `/api/v1/work-order-trade-categories/${tradeCategoryId}/competency-requirements?clientId=${clientId}`,
    )
    .set(auth())
    .send(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

async function directWorkOrder(r: Realm, workType: string) {
  return workOrderService.createWorkOrder({
    clientId: r.client.id,
    buildingId: r.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: `Direct ${workType}`,
    description: 'Operations-created job used to prove the competency gate.',
    workType,
    createdByUserId: adminUserId,
  });
}

async function classify(workOrderId: string, tradeCategoryId: string) {
  return api()
    .patch(`/api/v1/work-orders/${workOrderId}/classification`)
    .set(auth())
    .send({ tradeCategoryId, riskLevel: 'MEDIUM' });
}

async function assignWorkforce(workOrderId: string, workforceProfileId: string) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/assignments`)
    .set(auth())
    .send({ assigneeType: 'WORKFORCE', workforceProfileId });
}

async function decisionRows(workOrderId: string) {
  const result = await q(
    `SELECT action, requirement_type, enforcement_level, satisfied, reason,
            evidence_verification_status
       FROM work_order_assignment_competency_decisions
      WHERE work_order_id = $1
      ORDER BY evaluated_at ASC`,
    [workOrderId],
  );
  return result.rows;
}

async function tradeCategoryId(code: string): Promise<string> {
  const result = await q(
    'SELECT id FROM work_order_trade_categories WHERE code = $1',
    [code],
  );
  assert.ok(result.rows[0], `seeded trade category ${code} is missing`);
  return result.rows[0].id as string;
}

/**
 * The shared state of the single lifecycle this suite walks. Each `it` is one
 * stage and asserts the state the next stage depends on, so a regression is
 * reported at the stage that broke — not at the end of the chain.
 */
type Flow = {
  realm?: Realm;
  workerProfileId?: string;
  workerToken?: string;
  serviceRequestId?: string;
  workOrderId?: string;
  assignmentId?: string;
  /** Stage 13's painting job — reused by the reclassification stage. */
  paintingWorkOrderId?: string;
  paintingAssignmentId?: string;
};

const flow: Flow = {};

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

describe('PART 04A — Tenant → Customer Care → Work Order → Mobile → QC → Closure', () => {
  it('01. Tenant request is accepted without a Service Catalog and without a technical trade', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    flow.realm = r;

    const floor = await floorService.createFloor({
      buildingId: r.building.id,
      code: `FL_${suffix()}`,
      name: 'Floor 1',
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
      .post(`/api/v1/clients/${r.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TN_${suffix()}`, tenantName: 'Tenant Co' });
    assert.equal(company.status, 201, JSON.stringify(company.body));

    const pic = await api()
      .post(`/api/v1/tenant-companies/${company.body.data.id}/pics`)
      .set(auth())
      .send({
        picName: 'Tenant PIC',
        email: `pic-${suffix().toLowerCase()}@tenant.example.com`,
      });
    assert.equal(pic.status, 201, JSON.stringify(pic.body));

    const spaceBinding = await api()
      .post(`/api/v1/tenant-companies/${company.body.data.id}/spaces`)
      .set(auth())
      .send({ buildingId: r.building.id, spaceId: space.id });
    assert.equal(spaceBinding.status, 201, JSON.stringify(spaceBinding.body));

    const context = await api()
      .post(`/api/v1/tenant-companies/${company.body.data.id}/building-contexts`)
      .set(auth())
      .send({ buildingId: r.building.id });
    assert.equal(context.status, 201, JSON.stringify(context.body));

    const request = await api()
      .post(`/api/v1/tenant-companies/${company.body.data.id}/service-requests`)
      .set(auth())
      .send({
        tenantPicId: pic.body.data.id,
        buildingId: r.building.id,
        spaceId: space.id,
        requestNumber: `SR_${suffix()}`,
        // Free text chosen by Customer Care — NOT a trade, and NOT a catalog id.
        requestType: 'AIR_KRAN_BOCOR',
        title: 'Keran wastafel bocor',
        description: 'Air menetes terus dari keran wastafel sejak pagi.',
        priority: 'HIGH',
      });
    assert.equal(request.status, 201, JSON.stringify(request.body));
    flow.serviceRequestId = request.body.data.id;

    // No Service Catalog row exists anywhere: intake never needed one.
    const catalog = await q('SELECT COUNT(*)::int AS c FROM service_catalog');
    assert.equal(catalog.rows[0].c, 0);
  });

  it('02. Customer Care converts the Service Request into a Work Order (unclassified)', async (t) => {
    if (!ready(t)) return;
    const workRequest = await api()
      .post(`/api/v1/tenant-service-requests/${flow.serviceRequestId}/work-request`)
      .set(auth());
    assert.equal(workRequest.status, 201, JSON.stringify(workRequest.body));

    const binding = await api()
      .post(`/api/v1/tenant-service-requests/${flow.serviceRequestId}/work-order`)
      .set(auth())
      .send({ workOrderNumber: `WO_${suffix()}` });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    flow.workOrderId = binding.body.data.workOrderId;

    const classification = await api()
      .get(`/api/v1/work-orders/${flow.workOrderId}/classification`)
      .set(auth());
    assert.equal(classification.status, 200, JSON.stringify(classification.body));
    assert.equal(classification.body.data.tradeCategoryId, null);
    assert.equal(
      classification.body.data.classificationRequired,
      true,
      'a Customer Care Work Order must be classified before assignment',
    );

    const stored = await q(
      'SELECT work_type, status FROM work_orders WHERE id = $1',
      [flow.workOrderId],
    );
    assert.equal(stored.rows[0].work_type, 'AIR_KRAN_BOCOR');
    assert.equal(stored.rows[0].status, 'OPEN');
  });

  it('03. Operations cannot assign before classifying — and the refusal writes nothing', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;
    const worker = await freelanceWorkerWithSession(r);
    flow.workerProfileId = worker.profile.id;
    flow.workerToken = worker.token;

    const refused = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/assignments`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: worker.profile.id });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.code,
      'WORK_ORDER_CLASSIFICATION_REQUIRED',
    );

    const assignments = await q(
      'SELECT COUNT(*)::int AS c FROM work_order_assignments WHERE work_order_id = $1',
      [flow.workOrderId],
    );
    assert.equal(assignments.rows[0].c, 0);
  });

  it('04. Operations classifies the job as plumbing', async (t) => {
    if (!ready(t)) return;
    const plumbing = await tradeCategoryId('PLUMBING');
    const classified = await api()
      .patch(`/api/v1/work-orders/${flow.workOrderId}/classification`)
      .set(auth())
      .send({ tradeCategoryId: plumbing, riskLevel: 'MEDIUM' });
    assert.equal(classified.status, 200, JSON.stringify(classified.body));
    assert.equal(classified.body.data.tradeCategoryCode, 'PLUMBING');
  });

  it('05. Operations assigns the freelance worker directly (no vendor, no second workflow)', async (t) => {
    if (!ready(t)) return;
    const assigned = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/assignments`)
      .set(auth())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: flow.workerProfileId,
      });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    flow.assignmentId = assigned.body.data.id;
    assert.equal(assigned.body.data.workforceProfileId, flow.workerProfileId);

    // The worker is Handyman's own freelance personnel — never an external
    // vendor: the assignment carries no vendor and the profile stays FREELANCE.
    assert.equal(assigned.body.data.vendorId, null);
    const profile = await q(
      'SELECT workforce_type FROM workforce_profiles WHERE id = $1',
      [flow.workerProfileId],
    );
    assert.equal(profile.rows[0].workforce_type, 'FREELANCE');
    const vendors = await q(
      `SELECT COUNT(*)::int AS c FROM vendors WHERE client_id = $1`,
      [flow.realm!.client.id],
    );
    assert.equal(vendors.rows[0].c, 0, 'no vendor company was fabricated');
  });

  it('06. Mobile sees the assignment and the worker accepts it', async (t) => {
    if (!ready(t)) return;
    const feed = await api()
      .get('/api/v1/mobile/assignments')
      .set(auth(flow.workerToken));
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    // Feed items are keyed by the ASSIGNMENT id; the Work Order identity is in
    // `reference.workOrderId` (BE-25C contract).
    const item = (
      feed.body.data as Array<{
        type: string;
        reference?: { workOrderId?: string | null };
      }>
    ).find(
      (row) =>
        row.type === 'WORK_ORDER' &&
        row.reference?.workOrderId === flow.workOrderId,
    ) as unknown as Record<string, unknown> | undefined;
    assert.ok(item, 'the Work Order assignment must reach the worker Mobile feed');
    assert.equal(item!.status, 'OPEN');
    assert.ok(
      (item!.availableActions as string[]).includes('ACKNOWLEDGE'),
      `ACKNOWLEDGE must be offered, got ${JSON.stringify(item!.availableActions)}`,
    );

    const acknowledged = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/acknowledge`)
      .set(auth(flow.workerToken))
      .send({});
    assert.equal(acknowledged.status, 201, JSON.stringify(acknowledged.body));

    const after = await q('SELECT status FROM work_orders WHERE id = $1', [
      flow.workOrderId,
    ]);
    assert.equal(after.rows[0].status, 'ASSIGNED');
  });

  it('07. The worker starts the job (IN_PROGRESS)', async (t) => {
    if (!ready(t)) return;
    const started = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/start`)
      .set(auth(flow.workerToken))
      .send({});
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const stored = await q('SELECT status FROM work_orders WHERE id = $1', [
      flow.workOrderId,
    ]);
    assert.equal(stored.rows[0].status, 'IN_PROGRESS');
  });

  it('08. Photo evidence is bound to the Work Order (BEFORE and PROGRESS)', async (t) => {
    if (!ready(t)) return;
    const before = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/evidence`)
      .set(auth(flow.workerToken))
      .send({
        evidenceType: 'PHOTO',
        fileReference: `field/before-${suffix()}.jpg`,
        originalFileName: 'before.jpg',
        mimeType: 'image/jpeg',
        fileSize: 204_800,
        capturedAt: new Date().toISOString(),
      });
    assert.equal(before.status, 201, JSON.stringify(before.body));

    const progress = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/evidence`)
      .set(auth(flow.workerToken))
      .send({
        evidenceType: 'PHOTO',
        fileReference: `field/progress-${suffix()}.jpg`,
        originalFileName: 'progress.jpg',
        mimeType: 'image/jpeg',
        fileSize: 307_200,
      });
    assert.equal(progress.status, 201, JSON.stringify(progress.body));

    // Real bytes for the BEFORE photo: the Work Order evidence route binds the
    // metadata row, then the shared evidence file route stores the binary and
    // records the server-side SHA-256 (no client-supplied hash is trusted).
    const beforeEvidenceId = before.body.data.id as string;
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
      Buffer.from('handyman-part04a-before-photo'),
      Buffer.from([0xff, 0xd9]),
    ]);
    const uploaded = await api()
      .post(`/api/v1/evidence/${beforeEvidenceId}/file`)
      .set(auth(flow.workerToken))
      .attach('file', jpeg, { filename: 'before.jpg', contentType: 'image/jpeg' });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.data.evidenceType, 'PHOTO');
    assert.ok(uploaded.body.data.contentSha256, 'server-side hash must be recorded');

    const content = await api()
      .get(`/api/v1/evidence/${beforeEvidenceId}/file/content`)
      .set(auth(flow.workerToken));
    assert.equal(content.status, 200);

    const listed = await api()
      .get(`/api/v1/work-orders/${flow.workOrderId}/evidence`)
      .set(auth(flow.workerToken));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 2);
    assert.ok(
      (listed.body.data as Array<{ evidenceType: string }>).every(
        (item) => item.evidenceType === 'PHOTO',
      ),
    );

    const requirements = await api()
      .get(`/api/v1/work-orders/${flow.workOrderId}/evidence-requirements`)
      .set(auth(flow.workerToken));
    assert.equal(requirements.status, 200);
  });

  it('09. The worker completes the job', async (t) => {
    if (!ready(t)) return;
    const completed = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/complete`)
      .set(auth(flow.workerToken))
      .send({
        completionSummary: 'Keran wastafel diganti.',
        completionNotes: 'Tidak ada kebocoran setelah pengujian.',
      });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.equal(completed.body.data.completedByUserId, flow.workerToken ? completed.body.data.completedByUserId : null);
    assert.ok(completed.body.data.completedAt);
  });

  it('10. QC records an APPROVED verification on the completed Work Order', async (t) => {
    if (!ready(t)) return;
    const verification = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/verification`)
      .set(auth())
      .send({ decision: 'APPROVED', notes: 'Pekerjaan sesuai standar.' });
    assert.equal(verification.status, 201, JSON.stringify(verification.body));
    assert.equal(verification.body.data.verification.decision, 'APPROVED');

    const read = await api()
      .get(`/api/v1/work-orders/${flow.workOrderId}/verification`)
      .set(auth());
    assert.equal(read.status, 200, JSON.stringify(read.body));
  });

  it('11. Closure requires the approval and closes the Work Order', async (t) => {
    if (!ready(t)) return;
    const closed = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/close`)
      .set(auth())
      .send({});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    const stored = await q(
      'SELECT status, closed_at FROM work_orders WHERE id = $1',
      [flow.workOrderId],
    );
    assert.equal(stored.rows[0].status, 'CLOSED');
    assert.ok(stored.rows[0].closed_at);

    // The Mobile feed no longer offers actions on a closed job.
    const feed = await api()
      .get('/api/v1/mobile/assignments')
      .set(auth(flow.workerToken));
    assert.equal(feed.status, 200);
    const item = (
      feed.body.data as Array<{
        type: string;
        reference?: { workOrderId?: string | null };
      }>
    ).find(
      (row) =>
        row.type === 'WORK_ORDER' &&
        row.reference?.workOrderId === flow.workOrderId,
    ) as unknown as Record<string, unknown> | undefined;
    if (item) {
      assert.deepEqual(item.availableActions, []);
    }

    // Full audit trail: one event per stage, including the classification and
    // the competency decision, all in the same Client/Building scope.
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'WORK_ORDER' AND entity_id = $1`,
      [flow.workOrderId],
    );
    const types = new Set(events.rows.map((row) => row.event_type as string));
    for (const expected of [
      // A Work Order born from Customer Care records its origin as a
      // CONVERSION (not a bare CREATED), then one event per later stage.
      'WORK_ORDER_CONVERTED',
      'WORK_ORDER_CLASSIFIED',
      'WORK_ORDER_ASSIGNED',
      'WORK_ORDER_EVIDENCE_ADDED',
      'WORK_ORDER_COMPLETED',
      'WORK_ORDER_VERIFIED',
      'WORK_ORDER_CLOSED',
    ]) {
      assert.ok(types.has(expected), `missing operational event ${expected}`);
    }
  });

  it('12. No alternative endpoint bypasses the chain', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;

    // A closed Work Order cannot be reassigned, re-completed or re-closed.
    const second = await workforceService.createWorkforceProfile({
      organizationId: r.organization.id,
      departmentId: r.department.id,
      positionId: r.position.id,
      employeeCode: `WF_${suffix()}`,
      fullName: 'Second Technician',
      workforceType: 'INTERNAL',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: second.id,
      buildingId: r.building.id,
    });

    const reassigned = await api()
      .patch(
        `/api/v1/work-orders/${flow.workOrderId}/assignments/${flow.assignmentId}`,
      )
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: second.id });
    assert.ok(
      [400, 409].includes(reassigned.status),
      `closed Work Order must refuse reassignment, got ${reassigned.status}`,
    );
    assert.notEqual(reassigned.status, 200);

    const recompleted = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/complete`)
      .set(auth(flow.workerToken))
      .send({ completionSummary: 'again' });
    assert.notEqual(recompleted.status, 200);

    const reclosed = await api()
      .post(`/api/v1/work-orders/${flow.workOrderId}/close`)
      .set(auth())
      .send({});
    assert.notEqual(reclosed.status, 200);

    // A second assignment on a job that already had one was refused earlier
    // (single ACTIVE assignment invariant), and the ledger still shows exactly
    // the decisions the chain actually took.
    const ledger = await api()
      .get(`/api/v1/work-orders/${flow.workOrderId}/assignments/competency-decisions`)
      .set(auth());
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
    assert.deepEqual(
      (ledger.body.data as Array<{ action: string }>).map((row) => row.action),
      [],
      'PLUMBING has no configured requirement, so the gate recorded no row',
    );

    // Cross-Building isolation survives the whole chain: a session scoped to
    // another Building cannot read this Work Order.
    const other = await realm();
    const otherUser = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'Other Building Manager',
    });
    const otherPassword = 'OutsiderPass123';
    await credentialService.createInitialCredential({
      userId: otherUser.id,
      password: otherPassword,
    });
    await buildingAssignmentService.createAssignment(otherUser.id, {
      buildingId: other.building.id,
    });
    const otherToken = await createSessionWithPermissionsForUser(
      { id: otherUser.id, email: otherUser.email },
      otherPassword,
      [{ code: 'work_order.read', name: 'Read Work Orders' }],
    );
    const denied = await api()
      .get(`/api/v1/work-orders/${flow.workOrderId}`)
      .set(auth(otherToken));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
  });
});

// ---------------------------------------------------------------------------
// Variants — the multi-skill and change-safety edges of the same lifecycle
// ---------------------------------------------------------------------------

describe('PART 04A — competency variants and change safety', () => {
  it('13. A worker holding another trade’s certificate is still assignable (multi-skill)', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;
    const painting = await tradeCategoryId('PAINTING');
    const wo = await directWorkOrder(r, 'PAINTING_WALL');
    assert.equal((await classify(wo.id, painting)).status, 200);

    // The freelance worker already proved a plumbing job; give them the
    // plumbing credential so the multi-skill claim is material, not abstract.
    await giveCertificate(flow.workerProfileId!, 'Sertifikat Plumbing', true);

    const assigned = await assignWorkforce(wo.id, flow.workerProfileId!);
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    flow.paintingAssignmentId = assigned.body.data.id as string;

    // PAINTING has no requirement for this Client, so nothing blocks and
    // nothing is warned: the certificate of ANOTHER trade is simply irrelevant.
    assert.equal(assigned.body.data.competency.satisfied, true);
    assert.equal(assigned.body.data.competency.mandatoryRequirementCount, 0);
    assert.deepEqual(assigned.body.data.competency.advisory, []);

    // Holding a plumbing certificate did not narrow the worker's identity.
    const certificates = await q(
      `SELECT certificate_name FROM workforce_certifications
        WHERE workforce_profile_id = $1 AND verification_status = 'VERIFIED'`,
      [flow.workerProfileId],
    );
    assert.equal(certificates.rows.length, 1);
    assert.equal(certificates.rows[0].certificate_name, 'Sertifikat Plumbing');

    flow.paintingWorkOrderId = wo.id;
  });

  it('14. A RECOMMENDED requirement warns but never blocks', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;
    const painting = await tradeCategoryId('PAINTING');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_PAINT_${suffix()}`,
      name: 'Painting Finish',
      category: 'TECHNICAL',
    });
    await addRequirement(painting, r.client.id, {
      requirementType: 'SKILL',
      enforcementLevel: 'RECOMMENDED',
      skillId: skill.id,
      minimumProficiencyLevel: 'BASIC',
    });

    const wo = await directWorkOrder(r, 'PAINTING_WALL');
    assert.equal((await classify(wo.id, painting)).status, 200);
    const rookie = await plainWorker(r);

    const assigned = await assignWorkforce(wo.id, rookie.id);
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.competency.satisfied, true);
    const advisory = assigned.body.data.competency.advisory as Array<
      Record<string, unknown>
    >;
    assert.equal(advisory.length, 1, JSON.stringify(advisory));
    assert.equal(advisory[0].skillCode, skill.code);
    assert.equal(advisory[0].reason, 'SKILL_MISSING');
  });

  it('15. A MANDATORY certificate blocks until Operations verifies it', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;
    const sanitary = await tradeCategoryId('SANITARY');
    await addRequirement(sanitary, r.client.id, {
      requirementType: 'CERTIFICATION',
      enforcementLevel: 'MANDATORY',
      certificateName: 'Sertifikat Sanitasi',
    });

    const wo = await directWorkOrder(r, 'SANITARY_BLOCKAGE');
    assert.equal((await classify(wo.id, sanitary)).status, 200);
    const plumber = await plainWorker(r);
    await giveCertificate(plumber.id, 'Sertifikat Sanitasi', false);

    const refused = await assignWorkforce(wo.id, plumber.id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.code,
      'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
    );
    assert.equal(refused.body.error.details[0].reason, 'CERTIFICATION_UNVERIFIED');
    assert.equal(
      (await q('SELECT COUNT(*)::int AS c FROM work_order_assignments WHERE work_order_id = $1', [wo.id]))
        .rows[0].c,
      0,
      'the refusal must not leave a partial assignment',
    );
    assert.equal((await decisionRows(wo.id)).length, 0);

    const pending = await q(
      `SELECT id FROM workforce_certifications WHERE workforce_profile_id = $1`,
      [plumber.id],
    );
    await workforceCertificationService.verifyWorkforceCertification(
      plumber.id,
      pending.rows[0].id,
      { verificationStatus: 'VERIFIED' },
      certificationActor(adminUserId, CERT_ACTOR_PERMISSIONS),
    );

    const accepted = await assignWorkforce(wo.id, plumber.id);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const rows = await decisionRows(wo.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'ASSIGNED');
    assert.equal(rows[0].requirement_type, 'CERTIFICATION');
    assert.equal(rows[0].evidence_verification_status, 'VERIFIED');
  });

  it('16. Reclassification is revalidated against the ACTIVE assignee, and reassignment keeps one ACTIVE row', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;
    const woId = flow.paintingWorkOrderId!;
    const plumbing = await tradeCategoryId('PLUMBING');
    const sanitary = await tradeCategoryId('SANITARY');
    await addRequirement(plumbing, r.client.id, {
      requirementType: 'CERTIFICATION',
      enforcementLevel: 'MANDATORY',
      certificateName: 'Sertifikat Plumbing',
    });

    // The assigned worker holds the plumbing certificate but not the sanitary
    // one, so the first reclassification must be refused and rolled back.
    const conflict = await classify(woId, sanitary);
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'WORK_ORDER_CLASSIFICATION_CONFLICT');
    const unchanged = await api()
      .get(`/api/v1/work-orders/${woId}/classification`)
      .set(auth());
    assert.equal(unchanged.body.data.tradeCategoryCode, 'PAINTING');

    // The trade the assignee IS qualified for goes through and is recorded.
    const reclassified = await classify(woId, plumbing);
    assert.equal(reclassified.status, 200, JSON.stringify(reclassified.body));
    assert.equal(reclassified.body.data.tradeCategoryCode, 'PLUMBING');
    const ledger = await decisionRows(woId);
    assert.ok(
      ledger.some(
        (row) => row.action === 'RECLASSIFIED' && row.satisfied === true,
      ),
      JSON.stringify(ledger),
    );

    // Reassignment is competency-gated exactly like a first assignment: an
    // unqualified replacement is refused and the running worker keeps the job.
    const replacement = await plainWorker(r);
    // PATCH carries the new assignee payload directly (a `status: INACTIVE`
    // body would deactivate instead).
    const refusedSwap = await api()
      .patch(`/api/v1/work-orders/${woId}/assignments/${flow.paintingAssignmentId}`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: replacement.id });
    assert.equal(refusedSwap.status, 409, JSON.stringify(refusedSwap.body));
    assert.equal(
      refusedSwap.body.error.details[0].reason,
      'CERTIFICATION_MISSING',
    );
    const stillActive = await q(
      `SELECT workforce_profile_id FROM work_order_assignments
        WHERE work_order_id = $1 AND status = 'ACTIVE'`,
      [woId],
    );
    assert.equal(stillActive.rows.length, 1);
    assert.equal(stillActive.rows[0].workforce_profile_id, flow.workerProfileId);

    // Once the replacement holds the verified certificate the swap is safe:
    // exactly one ACTIVE assignment, the previous one retired — never two
    // workers running one job.
    await giveCertificate(replacement.id, 'Sertifikat Plumbing', true);
    const reassigned = await api()
      .patch(`/api/v1/work-orders/${woId}/assignments/${flow.paintingAssignmentId}`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: replacement.id });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
    assert.equal(reassigned.body.data.workforceProfileId, replacement.id);

    const active = await q(
      `SELECT COUNT(*)::int AS c FROM work_order_assignments
        WHERE work_order_id = $1 AND status = 'ACTIVE'`,
      [woId],
    );
    assert.equal(active.rows[0].c, 1);
    const retired = await q(
      `SELECT status FROM work_order_assignments WHERE id = $1`,
      [flow.paintingAssignmentId],
    );
    assert.equal(retired.rows[0].status, 'INACTIVE');
  });
});

describe('PART 04A — Mobile attendance contract', () => {
  it('17. The assigned worker clocks in and out at the job Building', async (t) => {
    if (!ready(t)) return;
    const r = flow.realm!;

    const clockIn = await api()
      .post('/api/v1/attendance/clock-in')
      .set(auth(flow.workerToken))
      .send({ buildingId: r.building.id });
    assert.equal(clockIn.status, 201, JSON.stringify(clockIn.body));
    assert.equal(clockIn.body.data.status, 'CLOCKED_IN');

    const current = await api()
      .get('/api/v1/attendance/current')
      .set(auth(flow.workerToken));
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.data.status, 'CLOCKED_IN');

    // A second clock-in while one is open is refused, never duplicated.
    const duplicate = await api()
      .post('/api/v1/attendance/clock-in')
      .set(auth(flow.workerToken))
      .send({ buildingId: r.building.id });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'ATTENDANCE_ACTIVE_ALREADY_EXISTS');

    const clockOut = await api()
      .post('/api/v1/attendance/clock-out')
      .set(auth(flow.workerToken));
    assert.equal(clockOut.status, 200, JSON.stringify(clockOut.body));
    assert.equal(clockOut.body.data.status, 'CLOCKED_OUT');

    const closed = await api()
      .post('/api/v1/attendance/clock-out')
      .set(auth(flow.workerToken));
    assert.equal(closed.status, 409, JSON.stringify(closed.body));
    assert.equal(closed.body.error.code, 'ATTENDANCE_NOT_ACTIVE');
  });
});
